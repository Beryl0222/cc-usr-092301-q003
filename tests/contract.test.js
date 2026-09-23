import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import { EVENT_KINDS, validate, validateStream } from "../src/contract.js";

const loadJson = (path) => readFile(new URL(path, import.meta.url)).then((b) => JSON.parse(b));

// 构造一份时间有序、相互引用完整的事件流（含一个测试内补充的材料）。
async function coherentStream() {
  const dir = new URL("../fixtures/events/", import.meta.url);
  const files = (await readdir(dir)).filter((f) => f !== "proxy-authorization-verified.json");
  const events = await Promise.all(files.map((f) => loadJson(`../fixtures/events/${f}`)));
  const standaloneMaterial = {
    event_id: "evt-mat-0009",
    kind: EVENT_KINDS.MATERIAL_RECEIVED,
    occurred_at: "2026-09-21T09:55:00+08:00",
    subject_id: "patient-0427",
    version: 1,
    payload: {
      material_id: "mat-0921-09",
      media_type: "screenshot",
      content_hash: "sha256:77aa01",
      received_at: "2026-09-21T09:55:00+08:00",
    },
  };
  return [...events, standaloneMaterial].sort((a, b) => a.occurred_at.localeCompare(b.occurred_at));
}

test("基线样例符合约定", async () => {
  const data = await loadJson("../fixtures/event.json");
  assert.deepEqual(validate(data), []);
});

test("每类事件样例单独校验通过", async () => {
  const dir = new URL("../fixtures/events/", import.meta.url);
  const files = await readdir(dir);
  for (const f of files) {
    const e = await loadJson(`../fixtures/events/${f}`);
    assert.deepEqual(validate(e), [], `${e.event_id} 校验失败：${validate(e).join("；")}`);
  }
});

test("时间有序的完整事件流跨事件校验通过", async () => {
  const events = await coherentStream();
  assert.deepEqual(validateStream(events), []);
});

test("信封缺字段被拒绝", () => {
  assert.ok(validate({ kind: "X" }).length > 0);
  assert.ok(validate({ event_id: "a", kind: "X", occurred_at: "2026-09-20T08:00:00+08:00", subject_id: "s", version: 1, payload: {} }).some((m) => m.includes("事件类型")));
});

test("occurred_at 必须带时区，朴素本地时间被拒绝", () => {
  const e = { event_id: "x", kind: EVENT_KINDS.RISK_FLAG_RAISED, occurred_at: "2026-09-20T08:00:00", subject_id: "s", version: 1, payload: {} };
  assert.ok(validate(e).some((m) => m.includes("ISO 8601")));
});

test("AI 答案缺少工具版本、生成时间或缺失上下文标注被拒绝", async () => {
  const base = await loadJson("../fixtures/events/ai-answer-recorded.json");
  for (const mutate of [
    (e) => delete e.payload.generated_at,
    (e) => delete e.payload.tool.model_version,
    (e) => delete e.payload.missing_context,
  ]) {
    const e = structuredClone(base);
    mutate(e);
    assert.ok(validate(e).length > 0);
  }
});

test("AI 答案不得确诊或携带诊断编码", async () => {
  const e = structuredClone(await loadJson("../fixtures/events/ai-answer-recorded.json"));
  e.payload.asserts_diagnosis = true;
  assert.ok(validate(e).some((m) => m.includes("确诊")));
  e.payload.asserts_diagnosis = false;
  e.payload.diagnosis_codes = ["I20.9"];
  assert.ok(validate(e).some((m) => m.includes("诊断编码")));
});

test("危险信号必须引导线下急诊且不得夹带诊断或处置", async () => {
  const e = structuredClone(await loadJson("../fixtures/events/risk-flag-raised.json"));
  e.payload.instruction = "rest_and_observe";
  assert.ok(validate(e).some((m) => m.includes("线下急诊")));
  e.payload.instruction = "seek_emergency_care_offline";
  e.payload.diagnosis = "疑似心梗";
  assert.ok(validate(e).some((m) => m.includes("诊断")));
});

test("撤回：已入病历却停止共享、或留痕缺依据，均被拒绝", async () => {
  const events = await coherentStream();
  const badStop = structuredClone(events.find((e) => e.kind === EVENT_KINDS.MATERIAL_WITHDRAWN && e.payload.disposition === "retain_as_medical_record"));
  badStop.event_id = "evt-wd-bad-1";
  badStop.payload.disposition = "stop_sharing";
  assert.ok(validateStream([...events, badStop]).some((m) => m.includes("已成为已签署诊疗决定的依据")));

  const e = structuredClone(badStop);
  e.payload.disposition = "retain_as_medical_record";
  delete e.payload.retention_basis;
  assert.ok(validate(e).some((m) => m.includes("retention_basis")));
});

test("留痕依据指向未使用该材料的签署决定被拒绝", async () => {
  const events = await coherentStream();
  const e = structuredClone(events.find((x) => x.kind === EVENT_KINDS.MATERIAL_WITHDRAWN && x.payload.disposition === "retain_as_medical_record"));
  e.event_id = "evt-wd-bad-2";
  e.payload.material_id = "mat-0921-09"; // plan-0922-01 并未使用它
  assert.ok(validateStream([...events, e]).some((m) => m.includes("并未使用该材料")));
});

test("家属代传：授权不存在、过期或范围不含 submit 被拒绝", async () => {
  const events = await coherentStream();
  const auth = structuredClone(await loadJson("../fixtures/events/proxy-authorization-verified.json"));
  const submission = structuredClone(await loadJson("../fixtures/events/submission-created.json"));
  submission.event_id = "evt-sub-proxy";
  submission.payload.proxy_authorization_id = auth.payload.authorization_id;

  assert.ok(validateStream([...events, submission]).some((m) => m.includes("不存在或未核验")));

  const expired = structuredClone(auth);
  expired.payload.expires_at = "2026-09-01T00:00:00+08:00";
  assert.ok(validateStream([...events, expired, submission]).some((m) => m.includes("已过期")));

  const scoped = structuredClone(auth);
  scoped.payload.scope = ["upload_material"];
  assert.ok(validateStream([...events, scoped, submission]).some((m) => m.includes("不含 submit")));

  assert.deepEqual(validateStream([...events, auth, submission]).filter((m) => m.includes("代传")), []);
});

test("重复上传必须指向首次入库材料", async () => {
  const events = await coherentStream();
  const dup = structuredClone(events.find((e) => e.payload.duplicate_of === "mat-0922-01"));
  dup.payload.duplicate_of = "mat-wrong";
  assert.ok(validateStream([...events, dup]).some((m) => m.includes("duplicate_of")));
});

test("AI 答案引用不存在材料、审阅先于答案生成被拒绝", async () => {
  const events = await coherentStream();
  const answer = structuredClone(events.find((e) => e.kind === EVENT_KINDS.AI_ANSWER_RECORDED));
  answer.event_id = "evt-ai-bad";
  answer.payload.based_on_materials = ["mat-nope"];
  assert.ok(validateStream([...events, answer]).some((m) => m.includes("不存在的材料")));

  const review = structuredClone(events.find((e) => e.kind === EVENT_KINDS.ADVICE_REVIEW_RECORDED));
  review.event_id = "evt-rev-bad";
  review.payload.reviewed_at = "2000-01-01T00:00:00+08:00";
  assert.ok(validateStream([...events, review]).some((m) => m.includes("早于答案生成时间")));
});

test("签署决定缺签名凭据或条目缺解释被拒绝", async () => {
  const e = structuredClone(await loadJson("../fixtures/events/clinical-plan-signed.json"));
  delete e.payload.signature_ref;
  assert.ok(validate(e).some((m) => m.includes("签名")));
  delete e.payload.signature_ref;
  delete e.payload.items[0].rationale;
  assert.ok(validate(e).some((m) => m.includes("解释")));
});

test("改期时间不得早于原预约，转诊须跨机构且有授权", async () => {
  const appt = structuredClone(await loadJson("../fixtures/events/appointment-rescheduled.json"));
  appt.payload.to_at = "2026-09-01T09:30:00+08:00";
  assert.ok(validate(appt).some((m) => m.includes("晚于原预约")));

  const referral = structuredClone(await loadJson("../fixtures/events/referral-created.json"));
  referral.payload.to_organization_id = "hospital-a";
  assert.ok(validate(referral).some((m) => m.includes("不同于原机构")));

  const events = await coherentStream();
  const noConsent = structuredClone(referral);
  noConsent.payload.to_organization_id = "hospital-b";
  noConsent.payload.consent_id = "consent-missing";
  assert.ok(validateStream([...events, noConsent]).some((m) => m.includes("共享授权")));
});
