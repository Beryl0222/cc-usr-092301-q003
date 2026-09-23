import assert from "node:assert/strict";
import test from "node:test";
import { DomainError } from "../src/errors.js";
import { KINDS } from "../src/events.js";
import { sampleAnswer, setup } from "./helpers.js";

test("未用于诊疗的材料可撤回，撤回后停止共享", () => {
  const { service, patient, draft } = setup();
  const { submission_id } = service.createSubmission(draft, patient);
  const materialId = service.uploadMaterial(submission_id, { type: "image", content: "照片" }, patient);

  const result = service.withdraw(submission_id, `material:${materialId}`, patient);
  assert.equal(result.applied, true);
  assert.equal(service.clinicianView(submission_id).materials.length, 0);
  assert.ok(service.history(submission_id).some((e) => e.kind === KINDS.WITHDRAWAL_APPLIED));
});

test("已被医生引用的材料拒绝撤回并留痕", () => {
  const { service, patient, doctor, draft } = setup();
  const { submission_id } = service.createSubmission(draft, patient);
  const materialId = service.uploadMaterial(submission_id, { type: "report", content: "报告" }, patient);
  const answerId = service.attachAiAnswer(submission_id, { ...sampleAnswer, material_refs: [materialId] }, patient);
  service.reviewAnswer(submission_id, { answer_id: answerId, action: "CITE", rationale: "采纳" }, doctor);

  const result = service.withdraw(submission_id, `material:${materialId}`, patient);
  assert.equal(result.applied, false);
  // 材料仍在接诊者视图中，且拒绝撤回的尝试本身也留痕
  assert.equal(service.clinicianView(submission_id).materials.length, 1);
  const denied = service.history(submission_id).find((e) => e.kind === KINDS.WITHDRAWAL_DENIED);
  assert.ok(denied.payload.reason.includes("留痕"));
});

test("被驳回的答案本身留痕不可撤回，但其材料未被采纳仍可撤回", () => {
  const { service, patient, doctor, draft } = setup();
  const { submission_id } = service.createSubmission(draft, patient);
  const materialId = service.uploadMaterial(submission_id, { type: "report", content: "报告" }, patient);
  const answerId = service.attachAiAnswer(submission_id, { ...sampleAnswer, material_refs: [materialId] }, patient);
  service.reviewAnswer(submission_id, { answer_id: answerId, action: "REJECT", rationale: "与病史矛盾" }, doctor);

  assert.equal(service.withdraw(submission_id, `answer:${answerId}`, patient).applied, false);
  assert.equal(service.withdraw(submission_id, `material:${materialId}`, patient).applied, true);
});

test("被签署决定引用的内容拒绝撤回", () => {
  const { service, patient, doctor, draft } = setup();
  const { submission_id } = service.createSubmission(draft, patient);
  const materialId = service.uploadMaterial(submission_id, { type: "report", content: "报告" }, patient);
  service.signDecision(
    submission_id,
    { kind: "EXAM", items: ["增强CT"], rationale: "进一步确认", refs: [`material:${materialId}`] },
    doctor,
  );
  assert.equal(service.withdraw(submission_id, `material:${materialId}`, patient).applied, false);
});

test("只有患者本人可以撤回", () => {
  const { service, patient, doctor, draft } = setup();
  const { submission_id } = service.createSubmission(draft, patient);
  const materialId = service.uploadMaterial(submission_id, { type: "image", content: "照片" }, patient);
  assert.throws(
    () => service.withdraw(submission_id, `material:${materialId}`, doctor),
    (err) => err instanceof DomainError && err.code === "FORBIDDEN",
  );
});
