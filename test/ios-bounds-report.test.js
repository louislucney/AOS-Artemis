import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("../scripts/ios-bounds-report.mjs", import.meta.url));

function fixture(t, steps) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aos-ios-bounds-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(dir, "run.json"),
    JSON.stringify({ trace_id: "ios-test", steps }),
    "utf8"
  );
  return dir;
}

function run(args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });
}

test("ios-bounds-report：统计有/无 bbox 的文本节点", (t) => {
  const dir = fixture(t, [
    {
      texts: [
        { text: "登录", x: 10, y: 20, width: 30, height: 10 },
        { text: "账号", x: 10, y: 50, width: 0, height: 10 },
        { text: "密码" }
      ]
    },
    { texts: [{ text: "完成", x: 1, y: 2, width: 3, height: 4 }] }
  ]);
  const result = run([dir]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /ios-test: steps=2 texts=4 bounds=2 coverage=50\.0%/);
  assert.match(result.stdout, /缺 bounds: 账号/);
  assert.match(result.stdout, /总计: traces=1 texts=4 bounds=2 coverage=50\.0%/);
});

test("ios-bounds-report：--json 输出结构与无样本 exit 2", (t) => {
  const dir = fixture(t, [{ texts: [{ text: "登录", x: 1, y: 2, width: 3, height: 4 }] }]);
  const result = run(["--json", dir]);
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.summary.coverage, 1);
  assert.equal(payload.traces[0].traceId, "ios-test");

  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "aos-ios-bounds-empty-"));
  t.after(() => fs.rmSync(empty, { recursive: true, force: true }));
  assert.equal(run([empty]).status, 2);
});
