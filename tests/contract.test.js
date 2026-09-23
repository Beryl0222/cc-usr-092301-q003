import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import { validate } from "../src/contract.js";

test("所有样例符合约定", async () => {
  const dir = new URL("../fixtures/", import.meta.url);
  for (const name of await readdir(dir)) {
    if (!name.endsWith(".json")) continue;
    const data = JSON.parse(await readFile(new URL(name, dir)));
    assert.deepEqual(validate(data), [], `${name} 不符合约定`);
  }
});

test("非法操作者角色被指出", () => {
  const record = {
    event_id: "e-1",
    kind: "REVIEW_MARKED",
    occurred_at: "2026-09-23T09:00:00+08:00",
    subject_id: "sub-1",
    version: 1,
    actor: { id: "x", role: "nobody" },
  };
  assert.deepEqual(validate(record), ["actor.role"]);
});
