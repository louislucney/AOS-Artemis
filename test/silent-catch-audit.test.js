import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const SCRIPT = path.join(process.cwd(), "scripts", "audit-silent-catches.mjs");

function run(root, extra = []) {
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT, "--root", root, ...extra], {
      encoding: "utf8"
    });
    return { code: 0, stdout, stderr: "" };
  } catch (error) {
    return {
      code: error.status ?? 1,
      stdout: String(error.stdout ?? ""),
      stderr: String(error.stderr ?? "")
    };
  }
}

test("silent catch audit: 基线内通过，新增超基线失败，更新后恢复", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aos-silent-catch-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const src = path.join(root, "src");
  fs.mkdirSync(src, { recursive: true });
  fs.writeFileSync(
    path.join(src, "a.ts"),
    [
      "async function a() {",
      "  await run().catch(() => undefined);",
      "  try { one(); } catch {}",
      "  try { two(); } catch { /* best effort */ }",
      "  try { three(); } catch { recover(); }",
      "}",
      ""
    ].join("\n")
  );

  const missing = run(root, ["--json"]);
  assert.equal(missing.code, 2, "missing baseline exits 2");

  assert.equal(run(root, ["--update-baseline"]).code, 0);
  const baseline = JSON.parse(
    fs.readFileSync(path.join(root, "scripts", "silent-catch-baseline.json"), "utf8")
  );
  assert.equal(baseline.counts["src/a.ts"], 3);

  const clean = run(root, ["--json"]);
  assert.equal(clean.code, 0);
  assert.equal(JSON.parse(clean.stdout).total, 3);

  fs.writeFileSync(
    path.join(src, "b.ts"),
    "export async function b() { await run().catch(() => undefined); }\n"
  );
  const violation = run(root, ["--json"]);
  assert.equal(violation.code, 1);
  const payload = JSON.parse(violation.stdout);
  assert.equal(payload.ok, false);
  assert.deepEqual(payload.violations, [{ file: "src/b.ts", count: 1, baseline: 0 }]);

  assert.equal(run(root, ["--update-baseline"]).code, 0);
  assert.equal(run(root, ["--json"]).code, 0);
});
