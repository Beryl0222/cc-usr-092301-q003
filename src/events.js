// 平台事件种类。所有事件沿用基线信封：event_id / kind / occurred_at / subject_id / version，
// 另带 actor（操作者）与 payload（业务内容）。事件只追加、不修改，历史决策因此可复核。
export const KINDS = Object.freeze({
  SUBMISSION_CREATED: "SUBMISSION_CREATED", // 按一次就医目的建立的提交
  MATERIAL_UPLOADED: "MATERIAL_UPLOADED", // 图片/报告等材料上传
  MATERIAL_DUPLICATE: "MATERIAL_DUPLICATE", // 重复上传，归并到已有材料
  AI_ANSWER_ATTACHED: "AI_ANSWER_ATTACHED", // 附带工具、版本、生成时间、原文与缺失上下文的AI答案
  RED_FLAG_RAISED: "RED_FLAG_RAISED", // 命中危险信号
  TRIAGE_DIRECTIVE_ISSUED: "TRIAGE_DIRECTIVE_ISSUED", // 线下处置引导（非诊断）
  PROXY_GRANTED: "PROXY_GRANTED", // 家属代传授权（含关系与范围核验）
  PROXY_REVOKED: "PROXY_REVOKED",
  REVIEW_MARKED: "REVIEW_MARKED", // 医生引用/质疑/驳回某条AI建议，必留解释
  DECISION_SIGNED: "DECISION_SIGNED", // 检查/治疗决定，单独签署并保留解释
  ITEM_SEALED: "ITEM_SEALED", // 内容已成为病历依据，按医疗记录规则留痕
  WITHDRAWAL_APPLIED: "WITHDRAWAL_APPLIED", // 撤回生效，停止共享
  WITHDRAWAL_DENIED: "WITHDRAWAL_DENIED", // 撤回被拒（已留痕），尝试本身也记录在案
  APPOINTMENT_SCHEDULED: "APPOINTMENT_SCHEDULED",
  APPOINTMENT_RESCHEDULED: "APPOINTMENT_RESCHEDULED",
  REFERRAL_ISSUED: "REFERRAL_ISSUED", // 跨机构转诊，附最新资料包
});

export const ROLES = Object.freeze({
  PATIENT: "patient",
  PROXY: "proxy",
  CLINICIAN: "clinician",
  SYSTEM: "system",
});

export const REVIEW_ACTIONS = Object.freeze({
  CITE: "CITE", // 引用：采纳为诊疗依据
  CHALLENGE: "CHALLENGE", // 质疑：存疑，需进一步核实
  REJECT: "REJECT", // 驳回：不采纳
});

export const DECISION_KINDS = Object.freeze({
  EXAM: "EXAM", // 检查决定
  TREATMENT: "TREATMENT", // 治疗决定
});

// 可撤回/可留痕对象的统一键："material:<id>" 或 "answer:<id>"
export const itemKey = (kind, id) => `${kind}:${id}`;
