import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  compareSystemDialogs,
  readSystemDialogs,
  writeSystemDialog
} from "../dist/figma/system-dialog-store.js";

test("system dialog parity: 两端内容一致/不一致/缺端", () => {
  const base = { title: "Software Update", message: "New version", buttons: ["Later", "Update"] };
  const same = compareSystemDialogs([
    { platform: "ios", ...base, at: "2026-11-16T00:00:00.000Z" },
    { platform: "android", ...base, at: "2026-11-16T00:00:00.000Z" }
  ]);
  assert.equal(same.comparable, true);
  assert.deepEqual(same.reasons, []);

  const diff = compareSystemDialogs([
    { platform: "ios", ...base, at: "2026-11-16T00:00:00.000Z" },
    { platform: "android", ...base, title: "更新", at: "2026-11-16T00:00:00.000Z" }
  ]);
  assert.equal(diff.comparable, false);
  assert.deepEqual(diff.reasons, ["dialog-content-mismatch"]);

  const missing = compareSystemDialogs([
    { platform: "android", ...base, at: "2026-11-16T00:00:00.000Z" }
  ]);
  assert.equal(missing.comparable, false);
  assert.deepEqual(missing.reasons, ["missing-dialog:ios"]);
});

test("system dialog store: 按平台覆盖写入并可恢复", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aos-system-dialogs-"));
  try {
    writeSystemDialog(dir, "task-1", {
      platform: "ios",
      title: "A",
      message: null,
      buttons: [],
      at: "2026-11-16T00:00:00.000Z"
    });
    writeSystemDialog(dir, "task-1", {
      platform: "android",
      title: "A",
      message: null,
      buttons: [],
      at: "2026-11-16T00:00:00.000Z"
    });
    assert.equal(readSystemDialogs(dir, "task-1").length, 2);
    writeSystemDialog(dir, "task-1", {
      platform: "ios",
      title: "B",
      message: null,
      buttons: [],
      at: "2026-11-16T00:00:00.000Z"
    });
    const rows = readSystemDialogs(dir, "task-1");
    assert.equal(rows.length, 2);
    assert.equal(rows.find((row) => row.platform === "ios")?.title, "B");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
