import { createHash } from "node:crypto";
import { EventStore } from "./store.js";
import { DECISION_KINDS, KINDS, REVIEW_ACTIONS, ROLES, itemKey } from "./events.js";
import { DomainError } from "./errors.js";
import { screenSubmission } from "./redflags.js";
import { validateAiAnswer, validateSubmissionDraft } from "./intake.js";
import { grantCovers, validateProxyGrant } from "./proxy.js";
import {
  buildReferralBundle,
  clinicianView as toClinicianView,
  patientView as toPatientView,
  project,
} from "./projections.js";

const SYSTEM = { id: "system", role: ROLES.SYSTEM };

// 平台核心服务。所有写入都是事件；视图永远从事件流折叠，保证"最新可见、历史可复核"。
export function createService({ store = new EventStore(), now, ids } = {}) {
  const clock = now ?? (() => new Date().toISOString());
  let seq = 0;
  const nextId = ids ?? ((prefix) => `${prefix}-${String(++seq).padStart(4, "0")}`);

  function emit(kind, subjectId, actor, payload) {
    return store.append({
      event_id: nextId("evt"),
      kind,
      occurred_at: clock(),
      subject_id: subjectId,
      version: store.nextVersion(subjectId),
      actor,
      payload,
    });
  }

  const stateOf = (subjectId) => project(store.bySubject(subjectId));
  const patientSubject = (patientId) => `patient:${patientId}`;

  function requireSubmission(submissionId) {
    const state = stateOf(submissionId);
    if (!state.submission) throw new DomainError("NOT_FOUND", `提交不存在：${submissionId}`);
    return state;
  }

  // 患者本人直接放行；家属代传必须持有覆盖该环节的有效授权。
  function assertSubmitter(actor, patientId, section) {
    if (actor.role === ROLES.PATIENT && actor.id === patientId) return;
    if (actor.role === ROLES.PROXY) {
      const grant = stateOf(patientSubject(patientId)).proxies.get(actor.id);
      if (grant && grantCovers(grant, { section, at: clock() })) return;
      throw new DomainError("PROXY_NOT_AUTHORIZED", `家属代传未通过核验：授权关系或范围不覆盖 ${section}`);
    }
    throw new DomainError("FORBIDDEN", "操作者身份不被允许");
  }

  function seal(submissionId, item, reason) {
    if (stateOf(submissionId).seals.has(item)) return;
    emit(KINDS.ITEM_SEALED, submissionId, SYSTEM, { item, reason });
  }

  // --- 家属代传授权：只能由患者本人授予/撤销，授权事件挂在患者主体下 ---
  function grantProxy(patientId, grant, actor) {
    if (!(actor.role === ROLES.PATIENT && actor.id === patientId)) {
      throw new DomainError("FORBIDDEN", "只有患者本人可以授予代传权限");
    }
    const full = { ...grant, patient_id: patientId };
    const errors = validateProxyGrant(full);
    if (errors.length) throw new DomainError("VALIDATION", errors.join("；"));
    emit(KINDS.PROXY_GRANTED, patientSubject(patientId), actor, { grant: full });
    return full.proxy_id;
  }

  function revokeProxy(patientId, proxyId, actor) {
    if (!(actor.role === ROLES.PATIENT && actor.id === patientId)) {
      throw new DomainError("FORBIDDEN", "只有患者本人可以撤销代传权限");
    }
    emit(KINDS.PROXY_REVOKED, patientSubject(patientId), actor, { proxy_id: proxyId });
  }

  // --- 提交：一次就医目的一份提交；命中危险信号立即给出线下处置引导 ---
  function createSubmission(draft, actor, submissionId = nextId("sub")) {
    const errors = validateSubmissionDraft(draft);
    if (errors.length) throw new DomainError("VALIDATION", errors.join("；"));
    assertSubmitter(actor, draft.patient_id, "submission");
    emit(KINDS.SUBMISSION_CREATED, submissionId, actor, {
      submission: { ...draft, submission_id: submissionId },
    });
    const triage = screenSubmission(draft);
    if (triage.level === "EMERGENCY") {
      emit(KINDS.RED_FLAG_RAISED, submissionId, SYSTEM, { matched: triage.matched });
      emit(KINDS.TRIAGE_DIRECTIVE_ISSUED, submissionId, SYSTEM, { directive: triage.directive });
    }
    return { submission_id: submissionId, triage };
  }

  // --- 材料：按内容哈希去重，重复上传归并到已有材料，不产生第二份共享副本 ---
  function uploadMaterial(submissionId, { type, name, content }, actor) {
    const state = requireSubmission(submissionId);
    assertSubmitter(actor, state.submission.patient_id, "material");
    const hash = createHash("sha256").update(content ?? "").digest("hex");
    for (const m of state.materials.values()) {
      if (m.hash === hash && m.status !== "WITHDRAWN") {
        emit(KINDS.MATERIAL_DUPLICATE, submissionId, actor, {
          material_id: m.material_id,
          duplicate_of: m.material_id,
          hash,
        });
        return m.material_id;
      }
    }
    const materialId = nextId("mat");
    emit(KINDS.MATERIAL_UPLOADED, submissionId, actor, { material_id: materialId, type, name, hash });
    return materialId;
  }

  // --- AI答案：必须带来源信息；引用的材料必须存在且未撤回 ---
  function attachAiAnswer(submissionId, answer, actor) {
    const state = requireSubmission(submissionId);
    assertSubmitter(actor, state.submission.patient_id, "answer");
    const errors = validateAiAnswer(answer);
    if (errors.length) throw new DomainError("VALIDATION", errors.join("；"));
    for (const ref of answer.material_refs ?? []) {
      const material = state.materials.get(ref);
      if (!material || material.status === "WITHDRAWN") {
        throw new DomainError("VALIDATION", `引用的材料不存在或已撤回：${ref}`);
      }
    }
    const answerId = nextId("ans");
    emit(KINDS.AI_ANSWER_ATTACHED, submissionId, actor, {
      answer_id: answerId,
      ...answer,
      material_refs: answer.material_refs ?? [],
    });
    return answerId;
  }

  // --- 医生处置：引用/质疑/驳回，必须留解释；处置即进入诊疗记录 ---
  function reviewAnswer(submissionId, { answer_id, action, rationale }, clinician) {
    if (clinician.role !== ROLES.CLINICIAN) {
      throw new DomainError("FORBIDDEN", "只有接诊医生可以处置AI建议");
    }
    const state = requireSubmission(submissionId);
    if (!Object.values(REVIEW_ACTIONS).includes(action)) {
      throw new DomainError("VALIDATION", `未知处置动作：${action}`);
    }
    if (!rationale?.trim()) throw new DomainError("VALIDATION", "处置必须保留解释 rationale");
    const answer = state.answers.get(answer_id);
    if (!answer || answer.status === "WITHDRAWN") {
      throw new DomainError("NOT_FOUND", `答案不存在或已撤回：${answer_id}`);
    }
    emit(KINDS.REVIEW_MARKED, submissionId, clinician, { answer_id, action, rationale });
    seal(submissionId, itemKey("answer", answer_id), "医生处置后进入诊疗记录");
    if (action === REVIEW_ACTIONS.CITE) {
      // 引用答案即采纳其证据基础，所依据的材料一并留痕
      for (const ref of answer.material_refs) {
        seal(submissionId, itemKey("material", ref), "被引用答案所依据的材料");
      }
    }
  }

  // --- 检查/治疗决定：单独签署、保留解释；变更只能以新决定取代旧决定 ---
  function signDecision(submissionId, { kind, items, rationale, refs = [], supersedes = null }, clinician) {
    if (clinician.role !== ROLES.CLINICIAN) {
      throw new DomainError("FORBIDDEN", "只有接诊医生可以签署决定");
    }
    const state = requireSubmission(submissionId);
    if (!Object.values(DECISION_KINDS).includes(kind)) {
      throw new DomainError("VALIDATION", "决定类型必须是 EXAM 或 TREATMENT");
    }
    if (!Array.isArray(items) || items.length === 0) {
      throw new DomainError("VALIDATION", "决定必须包含具体项目 items");
    }
    if (!rationale?.trim()) throw new DomainError("VALIDATION", "决定必须保留解释 rationale");
    if (supersedes && !state.decisions.has(supersedes)) {
      throw new DomainError("NOT_FOUND", `被取代的决定不存在：${supersedes}`);
    }
    for (const item of refs) {
      const [itemKind, id] = item.split(":");
      const known =
        (itemKind === "material" && state.materials.has(id)) || (itemKind === "answer" && state.answers.has(id));
      if (!known) throw new DomainError("NOT_FOUND", `决定引用的对象不存在：${item}`);
    }
    const decision = {
      decision_id: nextId("dec"),
      kind,
      items,
      rationale,
      refs,
      supersedes,
      signed_by: clinician.id,
      signed_at: clock(),
    };
    emit(KINDS.DECISION_SIGNED, submissionId, clinician, { decision });
    for (const item of refs) seal(submissionId, item, "被签署的检查/治疗决定引用");
    return decision.decision_id;
  }

  // --- 撤回：仅限患者本人，且内容尚未用于诊疗；已留痕的按医疗记录规则保留 ---
  function withdraw(submissionId, item, actor) {
    const state = requireSubmission(submissionId);
    if (!(actor.role === ROLES.PATIENT && actor.id === state.submission.patient_id)) {
      throw new DomainError("FORBIDDEN", "只有患者本人可以撤回材料");
    }
    const [kind, id] = item.split(":");
    const entity =
      kind === "material" ? state.materials.get(id) : kind === "answer" ? state.answers.get(id) : null;
    if (!entity) throw new DomainError("NOT_FOUND", `待撤回对象不存在：${item}`);
    if (entity.status === "WITHDRAWN") return { applied: false, reason: "该内容已撤回" };
    if (state.seals.has(item)) {
      emit(KINDS.WITHDRAWAL_DENIED, submissionId, SYSTEM, {
        item,
        reason: "已作为诊疗依据留痕，按医疗记录规则保留",
      });
      return { applied: false, reason: "已作为诊疗依据留痕" };
    }
    emit(KINDS.WITHDRAWAL_APPLIED, submissionId, actor, { item });
    return { applied: true };
  }

  // --- 预约与改期：最新时间生效，历史全部留痕 ---
  function scheduleAppointment(submissionId, { scheduled_at, clinic }, actor) {
    requireSubmission(submissionId);
    if (!scheduled_at) throw new DomainError("VALIDATION", "缺少预约时间 scheduled_at");
    const appointmentId = nextId("appt");
    emit(KINDS.APPOINTMENT_SCHEDULED, submissionId, actor, {
      appointment_id: appointmentId,
      scheduled_at,
      clinic,
    });
    return appointmentId;
  }

  function rescheduleAppointment(submissionId, { appointment_id, new_scheduled_at, reason }, actor) {
    const state = requireSubmission(submissionId);
    if (!state.appointments.has(appointment_id)) {
      throw new DomainError("NOT_FOUND", `预约不存在：${appointment_id}`);
    }
    if (!new_scheduled_at) throw new DomainError("VALIDATION", "缺少新的预约时间 new_scheduled_at");
    emit(KINDS.APPOINTMENT_RESCHEDULED, submissionId, actor, {
      appointment_id,
      new_scheduled_at,
      reason,
    });
  }

  // --- 跨机构转诊：资料包取签发时刻最新视图，已撤回内容不随包共享 ---
  function issueReferral(submissionId, { to_institution }, actor) {
    if (![ROLES.CLINICIAN, ROLES.PATIENT].includes(actor.role)) {
      throw new DomainError("FORBIDDEN", "转诊需由医生或患者发起");
    }
    const state = requireSubmission(submissionId);
    if (!to_institution?.trim()) throw new DomainError("VALIDATION", "缺少目标机构 to_institution");
    const referralId = nextId("ref");
    const bundle = buildReferralBundle(state, to_institution);
    emit(KINDS.REFERRAL_ISSUED, submissionId, actor, {
      referral_id: referralId,
      to_institution,
      bundle,
    });
    return { referral_id: referralId, bundle };
  }

  return {
    grantProxy,
    revokeProxy,
    createSubmission,
    uploadMaterial,
    attachAiAnswer,
    reviewAnswer,
    signDecision,
    withdraw,
    scheduleAppointment,
    rescheduleAppointment,
    issueReferral,
    clinicianView: (id) => toClinicianView(requireSubmission(id)),
    patientView: (id) => toPatientView(requireSubmission(id)),
    history: (id) => store.bySubject(id),
  };
}
