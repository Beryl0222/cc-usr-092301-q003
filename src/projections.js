import { KINDS, REVIEW_ACTIONS } from "./events.js";
import { TRIAGE_NOTICE } from "./redflags.js";

// 患者侧标签：把"机器提示"和"有责任主体确认过"明确分开。
export const PATIENT_LABELS = Object.freeze({
  MACHINE_ONLY: "机器生成，尚未经医务人员确认",
  CITED: "已由接诊医生引用确认",
  CHALLENGED: "接诊医生对其提出质疑",
  REJECTED: "接诊医生已驳回",
});

function emptyState() {
  return {
    submission: null,
    triage: { level: "ROUTINE", matched: [], directive: null },
    materials: new Map(), // material_id -> 材料（ACTIVE / WITHDRAWN）
    answers: new Map(), // answer_id -> AI答案（含医生处置）
    decisions: new Map(), // decision_id -> 已签署决定（含被取代链）
    proxies: new Map(), // proxy_id -> 授权（含 revoked 标记）
    appointments: new Map(), // appointment_id -> 最新预约状态
    referrals: [], // 已发出的转诊包
    withdrawals: [], // 撤回尝试（含被拒的），全部留痕
    seals: new Map(), // itemKey -> { at, reason }，已成为病历依据
    version: 0,
  };
}

export function reduce(state, event) {
  const p = event.payload ?? {};
  switch (event.kind) {
    case KINDS.SUBMISSION_CREATED:
      state.submission = { ...p.submission, created_at: event.occurred_at };
      break;
    case KINDS.RED_FLAG_RAISED:
      state.triage = { ...state.triage, level: "EMERGENCY", matched: p.matched };
      break;
    case KINDS.TRIAGE_DIRECTIVE_ISSUED:
      state.triage = { ...state.triage, directive: p.directive };
      break;
    case KINDS.MATERIAL_UPLOADED:
      state.materials.set(p.material_id, {
        material_id: p.material_id,
        type: p.type,
        name: p.name ?? null,
        hash: p.hash,
        status: "ACTIVE",
        duplicate_uploads: 0,
        uploaded_by: event.actor.id,
        uploaded_at: event.occurred_at,
      });
      break;
    case KINDS.MATERIAL_DUPLICATE: {
      const origin = state.materials.get(p.duplicate_of);
      if (origin) origin.duplicate_uploads += 1;
      break;
    }
    case KINDS.AI_ANSWER_ATTACHED:
      state.answers.set(p.answer_id, {
        answer_id: p.answer_id,
        tool: p.tool,
        generated_at: p.generated_at,
        answer_text: p.answer_text,
        input_summary: p.input_summary ?? null,
        missing_context: p.missing_context,
        material_refs: p.material_refs ?? [],
        status: "ACTIVE",
        review: null,
        attached_by: event.actor.id,
        attached_at: event.occurred_at,
      });
      break;
    case KINDS.REVIEW_MARKED: {
      const answer = state.answers.get(p.answer_id);
      if (answer) {
        answer.review = { action: p.action, rationale: p.rationale, by: event.actor.id, at: event.occurred_at };
      }
      break;
    }
    case KINDS.DECISION_SIGNED:
      if (p.decision.supersedes) {
        const old = state.decisions.get(p.decision.supersedes);
        if (old) old.superseded_by = p.decision.decision_id;
      }
      state.decisions.set(p.decision.decision_id, { ...p.decision, superseded_by: null });
      break;
    case KINDS.ITEM_SEALED:
      state.seals.set(p.item, { at: event.occurred_at, reason: p.reason });
      break;
    case KINDS.WITHDRAWAL_APPLIED: {
      state.withdrawals.push({ item: p.item, applied: true, at: event.occurred_at });
      const [kind, id] = p.item.split(":");
      const target = kind === "material" ? state.materials.get(id) : state.answers.get(id);
      if (target) target.status = "WITHDRAWN";
      break;
    }
    case KINDS.WITHDRAWAL_DENIED:
      state.withdrawals.push({ item: p.item, applied: false, reason: p.reason, at: event.occurred_at });
      break;
    case KINDS.PROXY_GRANTED:
      state.proxies.set(p.grant.proxy_id, { ...p.grant, revoked: false });
      break;
    case KINDS.PROXY_REVOKED: {
      const grant = state.proxies.get(p.proxy_id);
      if (grant) grant.revoked = true;
      break;
    }
    case KINDS.APPOINTMENT_SCHEDULED:
      state.appointments.set(p.appointment_id, {
        appointment_id: p.appointment_id,
        scheduled_at: p.scheduled_at,
        clinic: p.clinic ?? null,
        reschedules: 0,
        last_reason: null,
      });
      break;
    case KINDS.APPOINTMENT_RESCHEDULED: {
      const appt = state.appointments.get(p.appointment_id);
      if (appt) {
        appt.scheduled_at = p.new_scheduled_at;
        appt.reschedules += 1;
        appt.last_reason = p.reason ?? null;
      }
      break;
    }
    case KINDS.REFERRAL_ISSUED:
      state.referrals.push({
        referral_id: p.referral_id,
        to_institution: p.to_institution,
        bundle: p.bundle,
        issued_at: event.occurred_at,
      });
      break;
    default:
      break;
  }
  state.version = event.version;
  return state;
}

// 从事件流折叠出某个 subject 的最新状态。
export function project(events) {
  return events.reduce(reduce, emptyState());
}

function withReferencedBy(state, material) {
  const referenced_by = [...state.answers.values()]
    .filter((a) => a.status !== "WITHDRAWN" && a.material_refs.includes(material.material_id))
    .map((a) => a.answer_id);
  return { ...material, referenced_by };
}

function answerLabel(answer) {
  if (!answer.review) return PATIENT_LABELS.MACHINE_ONLY;
  switch (answer.review.action) {
    case REVIEW_ACTIONS.CITE:
      return PATIENT_LABELS.CITED;
    case REVIEW_ACTIONS.CHALLENGE:
      return PATIENT_LABELS.CHALLENGED;
    case REVIEW_ACTIONS.REJECT:
      return PATIENT_LABELS.REJECTED;
    default:
      return PATIENT_LABELS.MACHINE_ONLY;
  }
}

// 接诊者视图：最新有效资料。已撤回的条目不再共享（停止共享），
// 但原始事件仍在历史流中，供按医疗记录规则复核。
export function clinicianView(state) {
  return {
    submission: state.submission,
    triage: state.triage,
    materials: [...state.materials.values()]
      .filter((m) => m.status !== "WITHDRAWN")
      .map((m) => withReferencedBy(state, m)),
    answers: [...state.answers.values()].filter((a) => a.status !== "WITHDRAWN"),
    decisions: [...state.decisions.values()],
    appointments: [...state.appointments.values()],
    seals: [...state.seals.keys()],
  };
}

// 患者视图：每条AI答案都带"机器生成"标记和确认状态标签。
export function patientView(state) {
  const base = clinicianView(state);
  return {
    ...base,
    notice: TRIAGE_NOTICE,
    answers: base.answers.map((a) => ({ ...a, machine_generated: true, patient_label: answerLabel(a) })),
    decisions: base.decisions.map((d) => ({ ...d, signed: true })),
  };
}

// 转诊资料包：签发时刻的最新视图快照。source_version 供接收方判断资料新旧；
// 已撤回内容不进入包内；溯源说明随包同行。
export function buildReferralBundle(state, toInstitution) {
  return {
    to_institution: toInstitution,
    source_version: state.version,
    snapshot: clinicianView(state),
    provenance_notice: "标注为机器生成的内容未经确认；仅“已引用确认”的内容经过医务人员处理。",
  };
}
