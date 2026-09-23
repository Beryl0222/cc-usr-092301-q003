import assert from "node:assert/strict";
import test from "node:test";
import { DomainError } from "../src/errors.js";
import { KINDS } from "../src/events.js";
import { PATIENT_LABELS } from "../src/projections.js";
import { sampleAnswer, setup } from "./helpers.js";

test("完整流程：提交→材料→答案，接诊者看到最新资料，患者看到机器标签", () => {
  const { service, patient, draft } = setup();
  const { submission_id, triage } = service.createSubmission(draft, patient);
  assert.equal(triage.level, "ROUTINE");

  const materialId = service.uploadMaterial(submission_id, { type: "report", name: "血常规", content: "血常规报告内容" }, patient);
  const answerId = service.attachAiAnswer(submission_id, { ...sampleAnswer, material_refs: [materialId] }, patient);

  const view = service.clinicianView(submission_id);
  assert.equal(view.materials.length, 1);
  assert.deepEqual(view.materials[0].referenced_by, [answerId]);
  assert.equal(view.answers.length, 1);

  const pv = service.patientView(submission_id);
  assert.equal(pv.answers[0].machine_generated, true);
  assert.equal(pv.answers[0].patient_label, PATIENT_LABELS.MACHINE_ONLY);
});

test("危险信号：胸痛提交立即返回线下处置引导，且不作诊断", () => {
  const { service, patient, draft } = setup();
  const { submission_id, triage } = service.createSubmission(
    { ...draft, questions: [{ text: "突发胸痛半小时，怎么办" }] },
    patient,
  );
  assert.equal(triage.level, "EMERGENCY");
  assert.equal(triage.directive.action, "SEEK_EMERGENCY_CARE");
  assert.ok(triage.directive.notice.includes("不构成医疗诊断"));
  assert.ok(!("diagnosis" in triage.directive));
  const kinds = service.history(submission_id).map((e) => e.kind);
  assert.ok(kinds.includes(KINDS.RED_FLAG_RAISED));
  assert.ok(kinds.includes(KINDS.TRIAGE_DIRECTIVE_ISSUED));
});

test("重复上传：相同内容归并为同一份材料", () => {
  const { service, patient, draft } = setup();
  const { submission_id } = service.createSubmission(draft, patient);
  const first = service.uploadMaterial(submission_id, { type: "image", content: "同一张化验单照片" }, patient);
  const second = service.uploadMaterial(submission_id, { type: "image", content: "同一张化验单照片" }, patient);
  assert.equal(first, second);

  const view = service.clinicianView(submission_id);
  assert.equal(view.materials.length, 1);
  assert.equal(view.materials[0].duplicate_uploads, 1);
  assert.ok(service.history(submission_id).some((e) => e.kind === KINDS.MATERIAL_DUPLICATE));
});

test("同一材料可被多个答案引用", () => {
  const { service, patient, draft } = setup();
  const { submission_id } = service.createSubmission(draft, patient);
  const materialId = service.uploadMaterial(submission_id, { type: "report", content: "影像报告" }, patient);
  const a1 = service.attachAiAnswer(submission_id, { ...sampleAnswer, material_refs: [materialId] }, patient);
  const a2 = service.attachAiAnswer(
    submission_id,
    { ...sampleAnswer, tool: { name: "另一助手", version: "2.0" }, material_refs: [materialId] },
    patient,
  );
  const view = service.clinicianView(submission_id);
  assert.deepEqual(view.materials[0].referenced_by.sort(), [a1, a2].sort());
});

test("引用不存在或已撤回的材料会被拒绝", () => {
  const { service, patient, draft } = setup();
  const { submission_id } = service.createSubmission(draft, patient);
  assert.throws(
    () => service.attachAiAnswer(submission_id, { ...sampleAnswer, material_refs: ["mat-9999"] }, patient),
    (err) => err instanceof DomainError && err.code === "VALIDATION",
  );
  const materialId = service.uploadMaterial(submission_id, { type: "image", content: "照片" }, patient);
  service.withdraw(submission_id, `material:${materialId}`, patient);
  assert.throws(
    () => service.attachAiAnswer(submission_id, { ...sampleAnswer, material_refs: [materialId] }, patient),
    (err) => err instanceof DomainError && err.code === "VALIDATION",
  );
});

test("答案缺少溯源信息被拒绝", () => {
  const { service, patient, draft } = setup();
  const { submission_id } = service.createSubmission(draft, patient);
  const noVersion = { ...sampleAnswer, tool: { name: "某助手" } };
  assert.throws(
    () => service.attachAiAnswer(submission_id, noVersion, patient),
    (err) => err instanceof DomainError && err.message.includes("版本"),
  );
});

test("医生处置必须留解释；引用/质疑/驳回后患者看到对应标签", () => {
  const { service, patient, doctor, draft } = setup();
  const { submission_id } = service.createSubmission(draft, patient);
  const a1 = service.attachAiAnswer(submission_id, sampleAnswer, patient);
  const a2 = service.attachAiAnswer(submission_id, { ...sampleAnswer, answer_text: "另一条建议" }, patient);
  const a3 = service.attachAiAnswer(submission_id, { ...sampleAnswer, answer_text: "第三条建议" }, patient);

  assert.throws(
    () => service.reviewAnswer(submission_id, { answer_id: a1, action: "CITE", rationale: "" }, doctor),
    (err) => err instanceof DomainError && err.message.includes("解释"),
  );
  assert.throws(
    () => service.reviewAnswer(submission_id, { answer_id: a1, action: "CITE", rationale: "x" }, patient),
    (err) => err instanceof DomainError && err.code === "FORBIDDEN",
  );

  service.reviewAnswer(submission_id, { answer_id: a1, action: "CITE", rationale: "与查体一致，采纳" }, doctor);
  service.reviewAnswer(submission_id, { answer_id: a2, action: "CHALLENGE", rationale: "依据不足，待核实" }, doctor);
  service.reviewAnswer(submission_id, { answer_id: a3, action: "REJECT", rationale: "与病史矛盾" }, doctor);

  const labels = service.patientView(submission_id).answers.map((a) => a.patient_label);
  assert.deepEqual(labels, [PATIENT_LABELS.CITED, PATIENT_LABELS.CHALLENGED, PATIENT_LABELS.REJECTED]);
});

test("检查与治疗决定单独签署并保留解释，变更以新决定取代", () => {
  const { service, patient, doctor, draft } = setup();
  const { submission_id } = service.createSubmission(draft, patient);

  assert.throws(
    () => service.signDecision(submission_id, { kind: "EXAM", items: ["头颅CT"], rationale: "" }, doctor),
    (err) => err instanceof DomainError && err.message.includes("解释"),
  );

  const d1 = service.signDecision(
    submission_id,
    { kind: "EXAM", items: ["头颅CT"], rationale: "排除器质性病变" },
    doctor,
  );
  const d2 = service.signDecision(
    submission_id,
    { kind: "EXAM", items: ["头颅MRI"], rationale: "CT预约等待过久，改MRI", supersedes: d1 },
    doctor,
  );

  const decisions = service.clinicianView(submission_id).decisions;
  assert.equal(decisions.length, 2);
  const old = decisions.find((d) => d.decision_id === d1);
  assert.equal(old.superseded_by, d2);
  assert.equal(decisions.find((d) => d.decision_id === d2).signed_by, doctor.id);
  assert.equal(service.history(submission_id).filter((e) => e.kind === KINDS.DECISION_SIGNED).length, 2);
});

test("预约改期：接诊者看到最新时间，历史仍可复核", () => {
  const { service, patient, draft } = setup();
  const { submission_id } = service.createSubmission(draft, patient);
  const appt = service.scheduleAppointment(submission_id, { scheduled_at: "2026-10-08T10:00:00+08:00", clinic: "神经内科" }, patient);
  service.rescheduleAppointment(
    submission_id,
    { appointment_id: appt, new_scheduled_at: "2026-10-09T14:00:00+08:00", reason: "患者临时出差" },
    patient,
  );

  const view = service.clinicianView(submission_id);
  assert.equal(view.appointments[0].scheduled_at, "2026-10-09T14:00:00+08:00");
  assert.equal(view.appointments[0].reschedules, 1);
  const kinds = service.history(submission_id).map((e) => e.kind);
  assert.ok(kinds.includes(KINDS.APPOINTMENT_SCHEDULED));
  assert.ok(kinds.includes(KINDS.APPOINTMENT_RESCHEDULED));
});

test("跨机构转诊：资料包为最新快照，不含已撤回内容", () => {
  const { service, patient, doctor, draft } = setup();
  const { submission_id } = service.createSubmission(draft, patient);
  const keep = service.uploadMaterial(submission_id, { type: "report", content: "保留的报告" }, patient);
  const drop = service.uploadMaterial(submission_id, { type: "image", content: "要撤回的照片" }, patient);
  const answerId = service.attachAiAnswer(submission_id, { ...sampleAnswer, material_refs: [keep] }, patient);
  service.reviewAnswer(submission_id, { answer_id: answerId, action: "CITE", rationale: "采纳" }, doctor);
  service.signDecision(submission_id, { kind: "EXAM", items: ["头颅CT"], rationale: "排除器质性病变" }, doctor);
  service.withdraw(submission_id, `material:${drop}`, patient);

  const { bundle } = service.issueReferral(submission_id, { to_institution: "市第一医院" }, doctor);
  assert.deepEqual(
    bundle.snapshot.materials.map((m) => m.material_id),
    [keep],
  );
  assert.equal(bundle.snapshot.answers.length, 1);
  assert.equal(bundle.snapshot.decisions.length, 1);
  assert.ok(bundle.provenance_notice.includes("机器生成"));

  // 接收方可凭 source_version 核对资料新旧；转诊事件本身也留痕
  const hist = service.history(submission_id);
  assert.equal(bundle.source_version, hist[hist.length - 1].version - 1);
});

test("事件版本连续，历史完整可复核", () => {
  const { service, patient, doctor, draft } = setup();
  const { submission_id } = service.createSubmission(draft, patient);
  const answerId = service.attachAiAnswer(submission_id, sampleAnswer, patient);
  service.reviewAnswer(submission_id, { answer_id: answerId, action: "REJECT", rationale: "与病史矛盾" }, doctor);
  const versions = service.history(submission_id).map((e) => e.version);
  assert.deepEqual(versions, versions.map((_, i) => i + 1));
});
