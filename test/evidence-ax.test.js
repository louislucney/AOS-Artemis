import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { collectEvidenceAx } from "../dist/figma/evidence-ax.js";

test("evidence AX: 提取失败步骤文本并用 secret 脱敏", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aos-evidence-ax-"));
  try {
    fs.writeFileSync(
      path.join(dir, "run.json"),
      JSON.stringify({
        steps: [
          {
            step: 1,
            action: "text",
            screen: "Login password=hunter2",
            texts: [{ text: "Email: user@example.com" }, { text: "password=hunter2" }]
          }
        ]
      })
    );
    const ax = collectEvidenceAx(dir, [
      { alias: "password", value: "hunter2", kind: "password" },
      { alias: "email", value: "user@example.com", kind: "account" }
    ]);
    assert.ok(ax);
    assert.equal(ax.includes("hunter2"), false);
    assert.equal(ax.includes("user@example.com"), false);
    assert.equal(ax.includes("***"), true);
    assert.equal(JSON.parse(ax).schemaVersion, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("evidence AX: 关闭开关或无 AX 时返回 null", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aos-evidence-ax-"));
  try {
    fs.writeFileSync(path.join(dir, "run.json"), JSON.stringify({ steps: [] }));
    assert.equal(collectEvidenceAx(dir, [], { AOS_RUNNER_EVIDENCE_AX: "0" }), null);
    assert.equal(collectEvidenceAx(dir, [], {}), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
