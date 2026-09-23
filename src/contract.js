// 问诊前 AI 意见交接：事件信封与逐类载荷校验。
// 设计原则：
// - 事件只追加、不改写；撤回与驳回也以新事件表达，历史决策始终可复核。
// - AI 答案永远是“机器提示”，确诊与检查治疗只能由单独签署的责任主体事件确认。
// - 校验返回错误字符串数组，空数组表示通过（沿用基线 validate(record) 约定）。

const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

const ENVELOPE_REQUIRED = ["event_id", "kind", "occurred_at", "subject_id", "version"];

// 危险信号清单：出现即必须引导线下急诊，平台不得据此给出诊断。
export const RISK_SIGNALS = [
  "chest_pain", // 胸痛
  "dyspnea", // 呼吸急促
  "altered_consciousness", // 意识变化
  "hemiparesis_or_slurred_speech", // 单侧无力/言语不清
  "major_bleeding", // 大量出血
  "severe_allergic_reaction", // 严重过敏
  "seizure", // 抽搐
  "suicidal_risk", // 自伤风险
];

export const EVENT_KINDS = Object.freeze({
  // 患者（或经核验的家属）按一次就医目的建立提交
  SUBMISSION_CREATED: "SUBMISSION_CREATED",
  // 图片、化验单、报告、截屏等材料入库（content_hash 用于去重）
  MATERIAL_RECEIVED: "MATERIAL_RECEIVED",
  // 记录一条 AI 工具答案原文及其出处、生成时间、版本与自认缺失的上下文
  AI_ANSWER_RECORDED: "AI_ANSWER_RECORDED",
  // 危险信号：立即引导线下处置，载荷不允许携带诊断或处置方案
  RISK_FLAG_RAISED: "RISK_FLAG_RAISED",
  // 患者授权把资料共享给某接诊者/机构
  SHARING_CONSENT_GRANTED: "SHARING_CONSENT_GRANTED",
  // 患者撤回材料：未用于诊疗则停止共享；已形成病历依据则按病历规则留痕
  MATERIAL_WITHDRAWN: "MATERIAL_WITHDRAWN",
  // 家属代传：亲属关系与授权范围须先核验
  PROXY_AUTHORIZATION_VERIFIED: "PROXY_AUTHORIZATION_VERIFIED",
  // 医生对某条机器建议作出引用 / 质疑 / 驳回，并保留理由
  ADVICE_REVIEW_RECORDED: "ADVICE_REVIEW_RECORDED",
  // 最终检查与治疗决定：责任主体单独签署，逐项保留解释
  CLINICAL_PLAN_SIGNED: "CLINICAL_PLAN_SIGNED",
  // 预约改期：资料不动、时间变，接诊者仍看同一份最新资料
  APPOINTMENT_RESCHEDULED: "APPOINTMENT_RESCHEDULED",
  // 跨机构转诊：凭患者授权把指定范围资料转给目标机构
  REFERRAL_CREATED: "REFERRAL_CREATED",
});

const isNonEmptyString = (v) => typeof v === "string" && v.trim().length > 0;
const isIso = (v) => typeof v === "string" && ISO_8601.test(v);
const fail = (errors, path, cond, message) => {
  if (!cond) errors.push(`${path} ${message}`);
};

function requireFields(payload, fields, errors, path = "payload") {
  for (const f of fields) {
    if (payload == null || !(f in payload)) errors.push(`${path}.${f} 缺失`);
  }
}

// 每个 kind 的必填字段与载荷规则。返回错误数组。
const PAYLOAD_RULES = {
  SUBMISSION_CREATED(payload, errors) {
    requireFields(payload, ["submission_id", "purpose", "questions"], errors);
    fail(errors, "payload.purpose", isNonEmptyString(payload?.purpose), "必须说明本次就医目的");
    fail(errors, "payload.questions", Array.isArray(payload?.questions) && payload.questions.length > 0, "至少包含一个问题");
    if (payload?.proxy_authorization_id !== undefined) {
      fail(errors, "payload.proxy_authorization_id", isNonEmptyString(payload.proxy_authorization_id), "家属代传必须引用已核验的授权");
    }
    for (const [i, entry] of (payload?.symptom_timeline ?? []).entries()) {
      fail(errors, `payload.symptom_timeline[${i}].at`, isIso(entry?.at), "必须是带时区的 ISO 时间");
      fail(errors, `payload.symptom_timeline[${i}].description`, isNonEmptyString(entry?.description), "必须描述症状");
    }
    for (const [i, m] of (payload?.measurements ?? []).entries()) {
      fail(errors, `payload.measurements[${i}].type`, isNonEmptyString(m?.type), "必须标明测量项目");
      fail(errors, `payload.measurements[${i}].value`, m?.value !== undefined && m.value !== null, "必须有测量值");
      fail(errors, `payload.measurements[${i}].measured_at`, isIso(m?.measured_at), "必须是带时区的 ISO 时间");
    }
  },

  MATERIAL_RECEIVED(payload, errors) {
    requireFields(payload, ["material_id", "media_type", "content_hash", "received_at"], errors);
    fail(errors, "payload.media_type", ["image", "report", "lab_sheet", "screenshot", "other"].includes(payload?.media_type), "取值非法");
    fail(errors, "payload.content_hash", isNonEmptyString(payload?.content_hash), "用于重复上传识别，缺失");
    fail(errors, "payload.received_at", isIso(payload?.received_at), "必须是带时区的 ISO 时间");
    if (payload?.duplicate_of !== undefined) {
      fail(errors, "payload.duplicate_of", isNonEmptyString(payload.duplicate_of), "重复件必须指向首次入库的 material_id");
    }
  },

  AI_ANSWER_RECORDED(payload, errors) {
    requireFields(
      payload,
      ["answer_id", "tool", "generated_at", "source_hash", "missing_context", "based_on_materials"],
      errors,
    );
    fail(errors, "payload.tool.name", isNonEmptyString(payload?.tool?.name), "必须注明所用 AI 工具");
    if (payload?.tool !== undefined) {
      fail(errors, "payload.tool.version", isNonEmptyString(payload.tool.version) || isNonEmptyString(payload.tool.model_version), "必须注明工具/模型版本");
    }
    fail(errors, "payload.generated_at", isIso(payload?.generated_at), "答案生成时间必须是带时区的 ISO 时间");
    fail(errors, "payload.source_hash", isNonEmptyString(payload?.source_hash), "必须保留答案原文的摘要（原文或其哈希引用）");
    fail(errors, "payload.missing_context", Array.isArray(payload?.missing_context), "必须以数组显式标注缺失上下文（确无补充时给空数组）");
    fail(errors, "payload.based_on_materials", Array.isArray(payload?.based_on_materials), "必须列出答案所依据的材料");
    // 平台不得自行确诊：机器答案不得携带确诊断言或诊断编码。
    fail(errors, "payload.asserts_diagnosis", payload?.asserts_diagnosis !== true, "AI 答案不得作出确诊断言，确诊只能由医生签署事件给出");
    fail(errors, "payload.diagnosis_codes", payload?.diagnosis_codes === undefined, "AI 答案不得携带诊断编码");
    for (const [i, ref] of (payload?.derived_from_prior_answers ?? []).entries()) {
      fail(errors, `payload.derived_from_prior_answers[${i}].generated_at`, isIso(ref?.generated_at), "引用旧答案必须带其生成时间，以暴露答案新旧");
    }
  },

  RISK_FLAG_RAISED(payload, errors) {
    requireFields(payload, ["flag_id", "signals", "instruction", "detected_at"], errors);
    fail(errors, "payload.signals", Array.isArray(payload?.signals) && payload.signals.length > 0, "至少识别一种危险信号");
    for (const s of payload?.signals ?? []) {
      fail(errors, "payload.signals", RISK_SIGNALS.includes(s), `含未知危险信号 ${s}`);
    }
    fail(errors, "payload.instruction", payload?.instruction === "seek_emergency_care_offline", "危险信号必须立即引导线下急诊处置");
    fail(errors, "payload.detected_at", isIso(payload?.detected_at), "必须是带时区的 ISO 时间");
    for (const forbidden of ["diagnosis", "diagnosis_codes", "treatment_plan"]) {
      fail(errors, `payload.${forbidden}`, payload?.[forbidden] === undefined, "危险信号事件不得携带诊断或处置方案");
    }
  },

  SHARING_CONSENT_GRANTED(payload, errors) {
    requireFields(payload, ["consent_id", "recipient", "scope", "granted_at"], errors);
    fail(errors, "payload.recipient.organization_id", isNonEmptyString(payload?.recipient?.organization_id), "必须指定共享对象机构");
    fail(errors, "payload.scope", Array.isArray(payload?.scope) && payload.scope.length > 0, "必须明确共享范围（材料或提交）");
    fail(errors, "payload.granted_at", isIso(payload?.granted_at), "必须是带时区的 ISO 时间");
  },

  MATERIAL_WITHDRAWN(payload, errors) {
    requireFields(payload, ["material_id", "withdrawn_at", "disposition"], errors);
    fail(errors, "payload.withdrawn_at", isIso(payload?.withdrawn_at), "必须是带时区的 ISO 时间");
    fail(
      errors,
      "payload.disposition",
      ["stop_sharing", "retain_as_medical_record"].includes(payload?.disposition),
      "撤回处置只能是 stop_sharing 或 retain_as_medical_record",
    );
    if (payload?.disposition === "retain_as_medical_record") {
      requireFields(payload, ["retention_basis", "retained_by"], errors);
      fail(errors, "payload.retention_basis.plan_id", isNonEmptyString(payload?.retention_basis?.plan_id), "已入病历的撤回必须指明所依据的已签署决定");
      fail(errors, "payload.retention_basis.reason", isNonEmptyString(payload?.retention_basis?.reason), "必须留痕说明为何按病历保留");
      fail(errors, "payload.retained_by", isNonEmptyString(payload?.retained_by), "必须指明留痕责任主体");
    }
  },

  PROXY_AUTHORIZATION_VERIFIED(payload, errors) {
    requireFields(payload, ["authorization_id", "proxy_id", "patient_subject_id", "relationship", "scope", "verified_at"], errors);
    fail(errors, "payload.relationship", isNonEmptyString(payload?.relationship), "必须记录亲属/监护关系");
    fail(errors, "payload.scope", Array.isArray(payload?.scope) && payload.scope.length > 0, "必须记录经核验的授权范围");
    fail(errors, "payload.verified_at", isIso(payload?.verified_at), "必须是带时区的 ISO 时间");
    fail(errors, "payload.verification_method", isNonEmptyString(payload?.verification_method), "必须记录关系核验方式");
    if (payload?.expires_at !== undefined) {
      fail(errors, "payload.expires_at", isIso(payload.expires_at), "必须是带时区的 ISO 时间");
    }
  },

  ADVICE_REVIEW_RECORDED(payload, errors) {
    requireFields(payload, ["review_id", "answer_id", "clinician_id", "action", "rationale", "reviewed_at"], errors);
    fail(errors, "payload.action", ["cite", "challenge", "reject"].includes(payload?.action), "医生动作只能是 cite / challenge / reject");
    fail(errors, "payload.rationale", isNonEmptyString(payload?.rationale), "引用、质疑或驳回都必须保留解释");
    fail(errors, "payload.reviewed_at", isIso(payload?.reviewed_at), "必须是带时区的 ISO 时间");
  },

  CLINICAL_PLAN_SIGNED(payload, errors) {
    requireFields(payload, ["plan_id", "items", "signed_by", "signed_at", "signature_ref"], errors);
    fail(errors, "payload.items", Array.isArray(payload?.items) && payload.items.length > 0, "签署决定至少包含一项检查或治疗");
    for (const [i, item] of (payload?.items ?? []).entries()) {
      fail(errors, `payload.items[${i}].kind`, ["exam", "treatment"].includes(item?.kind), "条目只能是 exam 或 treatment");
      fail(errors, `payload.items[${i}].description`, isNonEmptyString(item?.description), "必须说明检查或治疗内容");
      fail(errors, `payload.items[${i}].rationale`, isNonEmptyString(item?.rationale), "每项检查与治疗都必须保留解释");
    }
    fail(errors, "payload.signed_by", isNonEmptyString(payload?.signed_by), "必须由可追责的医生签署");
    fail(errors, "payload.signature_ref", isNonEmptyString(payload?.signature_ref), "必须单独留存电子签名凭据");
    fail(errors, "payload.signed_at", isIso(payload?.signed_at), "必须是带时区的 ISO 时间");
  },

  APPOINTMENT_RESCHEDULED(payload, errors) {
    requireFields(payload, ["appointment_id", "from_at", "to_at", "changed_at"], errors);
    fail(errors, "payload.from_at", isIso(payload?.from_at), "必须是带时区的 ISO 时间");
    fail(errors, "payload.to_at", isIso(payload?.to_at), "必须是带时区的 ISO 时间");
    fail(errors, "payload.changed_at", isIso(payload?.changed_at), "必须是带时区的 ISO 时间");
    if (isIso(payload?.from_at) && isIso(payload?.to_at)) {
      fail(errors, "payload.to_at", new Date(payload.to_at) > new Date(payload.from_at), "改期时间必须晚于原预约时间");
    }
  },

  REFERRAL_CREATED(payload, errors) {
    requireFields(payload, ["referral_id", "from_organization_id", "to_organization_id", "consent_id", "scope", "created_at"], errors);
    fail(errors, "payload.from_organization_id", isNonEmptyString(payload?.from_organization_id), "缺失");
    fail(errors, "payload.to_organization_id", isNonEmptyString(payload?.to_organization_id), "缺失");
    if (payload?.from_organization_id && payload?.to_organization_id) {
      fail(errors, "payload.to_organization_id", payload.to_organization_id !== payload.from_organization_id, "转诊目标机构必须不同于原机构");
    }
    fail(errors, "payload.consent_id", isNonEmptyString(payload?.consent_id), "跨机构共享必须引用患者授权");
    fail(errors, "payload.scope", Array.isArray(payload?.scope) && payload.scope.length > 0, "必须限定转诊携带的资料范围");
    fail(errors, "payload.created_at", isIso(payload?.created_at), "必须是带时区的 ISO 时间");
  },
};

// 校验单条事件信封及其载荷。
export function validate(record) {
  const errors = [];
  if (record === null || typeof record !== "object") return ["记录必须是对象"];

  for (const name of ENVELOPE_REQUIRED) {
    if (!(name in record)) errors.push(`${name} 缺失`);
  }
  if (errors.length) return errors;

  fail(errors, "event_id", isNonEmptyString(record.event_id), "必须是非空字符串");
  fail(errors, "subject_id", isNonEmptyString(record.subject_id), "必须是非空字符串");
  fail(errors, "occurred_at", isIso(record.occurred_at), "必须是带时区的 ISO 8601 时间");
  fail(errors, "version", Number.isInteger(record.version) && record.version >= 1, "必须是不小于 1 的整数（信封 schema 版本）");
  fail(errors, "kind", Object.values(EVENT_KINDS).includes(record.kind), `不是受支持的事件类型：${record.kind}`);
  if (!Object.values(EVENT_KINDS).includes(record.kind)) return errors;

  fail(errors, "payload", record.payload !== null && typeof record.payload === "object", "必须携带载荷对象");
  if (record.payload && typeof record.payload === "object") {
    PAYLOAD_RULES[record.kind](record.payload, errors);
  }
  return errors;
}

// 跨事件不变量：引用完整性、去重、撤回前提、授权时序、转诊授权。
export function validateStream(events) {
  const errors = [];
  const seenEventIds = new Set();
  const materials = new Map(); // material_id -> { event, hash, canonical }
  const hashToFirst = new Map(); // subject|hash -> material_id
  const answers = new Map(); // answer_id -> event
  const plans = new Map(); // plan_id -> event
  const consents = new Set();
  const authorizations = new Map(); // authorization_id -> event

  events.forEach((e, idx) => {
    const at = (where) => `events[${idx}](${e?.kind ?? "?"}) ${where}`;
    for (const err of validate(e)) errors.push(at(err));

    if (!e || !e.event_id) return errors;
    if (seenEventIds.has(e.event_id)) errors.push(at("event_id 在流中重复"));
    seenEventIds.add(e.event_id);

    const p = e.payload ?? {};
    switch (e.kind) {
      case EVENT_KINDS.MATERIAL_RECEIVED: {
        materials.set(p.material_id, e);
        const key = `${e.subject_id}|${p.content_hash}`;
        if (hashToFirst.has(key)) {
          if (p.duplicate_of !== hashToFirst.get(key)) {
            errors.push(at("重复上传必须以 duplicate_of 指向首次入库材料 " + hashToFirst.get(key)));
          }
        } else {
          if (p.duplicate_of) errors.push(at("内容首次出现却声明为重复件"));
          hashToFirst.set(key, p.material_id);
        }
        break;
      }
      case EVENT_KINDS.AI_ANSWER_RECORDED:
        answers.set(p.answer_id, e);
        for (const mid of p.based_on_materials ?? []) {
          if (!materials.has(mid)) errors.push(at(`引用了不存在的材料 ${mid}`));
        }
        break;
      case EVENT_KINDS.SHARING_CONSENT_GRANTED:
        consents.add(p.consent_id);
        break;
      case EVENT_KINDS.PROXY_AUTHORIZATION_VERIFIED:
        authorizations.set(p.authorization_id, e);
        break;
      case EVENT_KINDS.SUBMISSION_CREATED:
        if (p.proxy_authorization_id) {
          const auth = authorizations.get(p.proxy_authorization_id);
          if (!auth) {
            errors.push(at("代传提交引用了不存在或未核验的授权"));
          } else {
            if (auth.payload.patient_subject_id !== e.subject_id) errors.push(at("授权患者与提交主体不一致"));
            if (new Date(auth.payload.verified_at) > new Date(e.occurred_at)) errors.push(at("授权核验时间晚于提交时间"));
            if (auth.payload.expires_at && new Date(auth.payload.expires_at) < new Date(e.occurred_at)) {
              errors.push(at("授权在提交时已过期"));
            }
            if (!auth.payload.scope.includes("submit")) errors.push(at("授权范围不含 submit，不能代为提交"));
          }
        }
        break;
      case EVENT_KINDS.ADVICE_REVIEW_RECORDED: {
        const ans = answers.get(p.answer_id);
        if (!ans) errors.push(at(`审阅引用了不存在的 AI 答案 ${p.answer_id}`));
        else if (new Date(ans.payload.generated_at) > new Date(p.reviewed_at)) errors.push(at("审阅时间早于答案生成时间"));
        break;
      }
      case EVENT_KINDS.CLINICAL_PLAN_SIGNED:
        plans.set(p.plan_id, e);
        for (const ref of p.based_on ?? []) {
          if (ref.type === "answer" && !answers.has(ref.id)) errors.push(at(`签署依据引用了不存在的答案 ${ref.id}`));
          if (ref.type === "material" && !materials.has(ref.id)) errors.push(at(`签署依据引用了不存在的材料 ${ref.id}`));
        }
        break;
      case EVENT_KINDS.MATERIAL_WITHDRAWN: {
        const usedBy = [...plans.values()].some(
          (pl) => pl.subject_id === e.subject_id && (pl.payload.based_on ?? []).some((r) => r.type === "material" && r.id === p.material_id),
        );
        if (p.disposition === "stop_sharing" && usedBy) {
          errors.push(at("材料已成为已签署诊疗决定的依据，不能停止共享，应按病历留痕保留"));
        }
        if (p.disposition === "retain_as_medical_record") {
          const basis = plans.get(p.retention_basis?.plan_id);
          if (!basis) errors.push(at("留痕依据指向不存在的已签署决定"));
          else if (!(basis.payload.based_on ?? []).some((r) => r.type === "material" && r.id === p.material_id)) {
            errors.push(at("留痕依据的签署决定并未使用该材料"));
          }
        }
        break;
      }
      case EVENT_KINDS.REFERRAL_CREATED:
        if (!consents.has(p.consent_id)) errors.push(at("转诊引用了不存在的患者共享授权"));
        break;
      default:
        break;
    }
  });

  return errors;
}
