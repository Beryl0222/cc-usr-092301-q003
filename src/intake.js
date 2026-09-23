// 提交草稿与AI答案的入场校验。风格沿用 src/contract.js：返回问题清单，空数组表示通过。

// 一次提交对应一次就医目的；各分段可缺省，但出现就必须是数组。
export function validateSubmissionDraft(draft) {
  const errors = [];
  if (!draft || typeof draft !== "object") return ["提交内容为空或格式不正确"];
  if (!draft.patient_id?.trim?.()) errors.push("缺少患者标识 patient_id");
  if (!draft.visit_purpose?.trim?.()) errors.push("缺少就医目的 visit_purpose");
  for (const key of ["questions", "symptom_timeline", "medical_history", "measurements"]) {
    if (key in draft && !Array.isArray(draft[key])) errors.push(`${key} 必须是数组`);
  }
  return errors;
}

// AI答案必须带来源信息：所用工具及版本、生成时间、答案原文、缺失上下文标注。
// missing_context 允许为空数组，但字段本身必须存在——"没标"和"标了没有"是两回事。
export function validateAiAnswer(answer) {
  const errors = [];
  if (!answer || typeof answer !== "object") return ["AI答案为空或格式不正确"];
  if (!answer.tool?.name?.trim?.()) errors.push("缺少所用工具名称 tool.name");
  if (!answer.tool?.version?.trim?.()) errors.push("缺少所用工具版本 tool.version");
  if (!answer.generated_at) errors.push("缺少答案生成时间 generated_at");
  if (!answer.answer_text?.trim?.()) errors.push("缺少答案原文 answer_text");
  if (!Array.isArray(answer.missing_context)) {
    errors.push("缺少缺失上下文标注 missing_context（无缺失时传空数组）");
  }
  if ("material_refs" in answer && !Array.isArray(answer.material_refs)) {
    errors.push("material_refs 必须是数组");
  }
  return errors;
}
