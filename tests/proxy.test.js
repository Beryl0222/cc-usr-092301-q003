import assert from "node:assert/strict";
import test from "node:test";
import { DomainError } from "../src/errors.js";
import { sampleAnswer, setup } from "./helpers.js";

const proxy = { id: "f-1", role: "proxy" };

function grant(sections, overrides = {}) {
  return {
    proxy_id: "f-1",
    relationship: "父子",
    scope: { sections },
    verified_by: "社区工作人员甲",
    verification_method: "现场核验户口本",
    valid_from: "2026-09-01T00:00:00+08:00",
    valid_until: "2026-12-31T23:59:59+08:00",
    ...overrides,
  };
}

test("未授权家属不能代传", () => {
  const { service, draft } = setup();
  assert.throws(
    () => service.createSubmission(draft, proxy),
    (err) => err instanceof DomainError && err.code === "PROXY_NOT_AUTHORIZED",
  );
});

test("授权范围内的家属可以代传，范围外被拒绝", () => {
  const { service, patient, draft } = setup();
  service.grantProxy("p-1", grant(["material"]), patient);
  const { submission_id } = service.createSubmission(draft, patient);

  // 范围内：传材料
  const materialId = service.uploadMaterial(submission_id, { type: "image", content: "照片" }, proxy);
  assert.ok(materialId);
  // 范围外：提交答案、代为发起提交
  assert.throws(
    () => service.attachAiAnswer(submission_id, sampleAnswer, proxy),
    (err) => err instanceof DomainError && err.code === "PROXY_NOT_AUTHORIZED",
  );
  assert.throws(
    () => service.createSubmission(draft, proxy),
    (err) => err instanceof DomainError && err.code === "PROXY_NOT_AUTHORIZED",
  );
});

test("覆盖提交环节授权的家属可以代为发起提交", () => {
  const { service, patient, draft } = setup();
  service.grantProxy("p-1", grant(["submission", "material", "answer"]), patient);
  const { submission_id } = service.createSubmission(draft, proxy);
  assert.ok(submission_id);
});

test("过期或已撤销的授权无效", () => {
  const { service, patient, draft } = setup();
  service.grantProxy("p-1", grant(["material"], { proxy_id: "f-2", valid_until: "2026-09-01T00:00:00+08:00" }), patient);
  service.grantProxy("p-1", grant(["material"]), patient);
  const { submission_id } = service.createSubmission(draft, patient);

  assert.throws(
    () => service.uploadMaterial(submission_id, { type: "image", content: "x" }, { id: "f-2", role: "proxy" }),
    (err) => err instanceof DomainError && err.code === "PROXY_NOT_AUTHORIZED",
  );

  service.revokeProxy("p-1", "f-1", patient);
  assert.throws(
    () => service.uploadMaterial(submission_id, { type: "image", content: "y" }, proxy),
    (err) => err instanceof DomainError && err.code === "PROXY_NOT_AUTHORIZED",
  );
});

test("授权必须验证关系与范围", () => {
  const { service, patient } = setup();
  assert.throws(
    () => service.grantProxy("p-1", { proxy_id: "f-1", scope: { sections: ["material"] } }, patient),
    (err) =>
      err instanceof DomainError &&
      err.message.includes("关系") &&
      err.message.includes("核验"),
  );
});

test("只有患者本人可以授予或撤销代传权限", () => {
  const { service, doctor } = setup();
  assert.throws(
    () => service.grantProxy("p-1", grant(["material"]), doctor),
    (err) => err instanceof DomainError && err.code === "FORBIDDEN",
  );
  assert.throws(
    () => service.grantProxy("p-1", grant(["material"]), { id: "p-2", role: "patient" }),
    (err) => err instanceof DomainError && err.code === "FORBIDDEN",
  );
});
