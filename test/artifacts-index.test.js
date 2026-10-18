import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { listArtifacts } from "../dist/artifacts/index.js";

async function fixtureRoot() {
  const root = await mkdtemp(join(tmpdir(), "aos-artifacts-"));
  const dirs = [
    ".artemis/design/runs",
    ".artemis/design/case-sets",
    ".artemis/design/reports",
    ".artemis/design/diffs",
    ".artemis/crashes",
    ".artemis/traces/20261018-abc"
  ];
  for (const dir of dirs) await mkdir(join(root, dir), { recursive: true });
  const files = [
    [".artemis/design/runs/20261018_a.json", "2026-10-18T01:00:00.000Z"],
    [".artemis/design/case-sets/20261018_login.json", "2026-10-18T02:00:00.000Z"],
    [".artemis/design/reports/20261018_login_回归.xlsx", "2026-10-18T03:00:00.000Z"],
    [".artemis/design/diffs/20261018_login_diff.png", "2026-10-18T04:00:00.000Z"],
    [".artemis/crashes/20261018_login.crash.json", "2026-10-18T05:00:00.000Z"],
    [".artemis/traces/20261018-abc/steps.json", "2026-10-18T06:00:00.000Z"],
    [".artemis/design/runs/leftover.tmp-abc", "2026-10-18T07:00:00.000Z"]
  ];
  for (const [rel, iso] of files) {
    const abs = join(root, rel);
    await writeFile(abs, "x", "utf8");
    const when = new Date(iso);
    await utimes(abs, when, when);
  }
  return root;
}

test("listArtifacts: 六类浅扫（含 trace 目录）、tmp 跳过、新→旧", async () => {
  const root = await fixtureRoot();
  try {
    const all = await listArtifacts(root);
    assert.deepEqual(
      all.map((record) => record.kind).sort(),
      ["case-set", "crash", "diff", "report", "run", "trace"]
    );
    assert.equal(all.some((record) => record.title.includes(".tmp-")), false);
    const trace = all.find((record) => record.kind === "trace");
    assert.equal(trace.meta?.type, "dir");
    assert.equal(trace.size, 0);
    for (let i = 1; i < all.length; i += 1) {
      assert.ok(all[i - 1].at >= all[i].at, "按 at 新→旧");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("listArtifacts: kind/q/since/limit 过滤", async () => {
  const root = await fixtureRoot();
  try {
    assert.deepEqual(
      (await listArtifacts(root, { kind: "run" })).map((record) => record.kind),
      ["run"]
    );
    const q = await listArtifacts(root, { q: "login" });
    assert.ok(q.length >= 3);
    assert.ok(q.every((record) => record.path.toLowerCase().includes("login")));
    const since = await listArtifacts(root, { since: "2026-10-18T04:00:00.000Z" });
    assert.ok(since.every((record) => record.at >= "2026-10-18T04:00:00.000Z"));
    const limited = await listArtifacts(root, { limit: 2 });
    assert.equal(limited.length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("listArtifacts: 空项目 → []（目录缺失不抛错）", async () => {
  const root = await mkdtemp(join(tmpdir(), "aos-artifacts-empty-"));
  try {
    assert.deepEqual(await listArtifacts(root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
