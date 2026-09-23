import assert from "node:assert/strict";
import test from "node:test";
import { validateAiAnswer, validateSubmissionDraft } from "../src/intake.js";

test("提交必须带患者标识与一次就医目的", () => {
  assert.deepEqual(validateSubmissionDraft({}), ["缺少患者标识 patient_id", "缺少就医目的 visit_purpose"]);
  assert.deepEqual(validateSubmissionDraft({ patient_id: "p-1", visit_purpose: "复查" }), []);
});

test("提交各分段出现即必须是数组", () => {
  const errors = validateSubmissionDraft({
    patient_id: "p-1",
    visit_purpose: "复查",
    questions: "不是数组",
  });
  assert.deepEqual(errors, ["questions 必须是数组"]);
});

test("AI答案必须带来源信息", () => {
  const errors = validateAiAnswer({ answer_text: "建议多喝水" });
  assert.ok(errors.includes("缺少所用工具名称 tool.name"));
  assert.ok(errors.includes("缺少所用工具版本 tool.version"));
  assert.ok(errors.includes("缺少答案生成时间 generated_at"));
  assert.ok(errors.includes("缺少缺失上下文标注 missing_context（无缺失时传空数组）"));
});

test("缺失上下文允许为空数组但字段必须存在", () => {
  const answer = {
    tool: { name: "某助手", version: "1.0" },
    generated_at: "2026-09-22T10:00:00+08:00",
    answer_text: "原文",
    missing_context: [],
  };
  assert.deepEqual(validateAiAnswer(answer), []);
  assert.ok(validateAiAnswer({ ...answer, missing_context: undefined }).length > 0);
});
