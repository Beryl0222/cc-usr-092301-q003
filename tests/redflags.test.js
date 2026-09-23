import assert from "node:assert/strict";
import test from "node:test";
import { TRIAGE_NOTICE, screenSubmission } from "../src/redflags.js";

const base = { patient_id: "p-1", visit_purpose: "急诊咨询" };

test("胸痛触发紧急引导", () => {
  const r = screenSubmission({ ...base, questions: [{ text: "突发胸痛半小时，含硝酸甘油未缓解" }] });
  assert.equal(r.level, "EMERGENCY");
  assert.equal(r.matched[0].rule_id, "CHEST_PAIN");
  assert.equal(r.directive.action, "SEEK_EMERGENCY_CARE");
});

test("呼吸急促触发紧急引导", () => {
  const r = screenSubmission({ ...base, symptom_timeline: [{ symptom: "喘不上气", course: "十分钟" }] });
  assert.equal(r.level, "EMERGENCY");
  assert.equal(r.matched[0].rule_id, "DYSPNEA");
});

test("意识变化触发紧急引导", () => {
  const r = screenSubmission({ ...base, questions: [{ text: "老人突然叫不醒怎么办" }] });
  assert.equal(r.level, "EMERGENCY");
  assert.equal(r.matched[0].rule_id, "CONSCIOUSNESS_CHANGE");
});

test("引导只指向线下处置，绝不输出诊断", () => {
  const r = screenSubmission({ ...base, questions: [{ text: "胸闷伴气短" }] });
  assert.equal(r.level, "EMERGENCY");
  assert.ok(!("diagnosis" in r));
  assert.ok(!("diagnosis" in r.directive));
  assert.equal(r.directive.notice, TRIAGE_NOTICE);
  assert.ok(r.directive.instructions.some((line) => line.includes("120")));
});

test("既往史中的危险词不当作当前危险信号", () => {
  const r = screenSubmission({
    ...base,
    questions: [{ text: "体检报告怎么看" }],
    medical_history: [{ condition: "三年前曾昏厥，已治愈" }],
  });
  assert.equal(r.level, "ROUTINE");
  assert.equal(r.directive, null);
});

test("普通主诉不触发", () => {
  const r = screenSubmission({ ...base, questions: [{ text: "这个化验单箭头是什么意思" }] });
  assert.equal(r.level, "ROUTINE");
  assert.deepEqual(r.matched, []);
});
