import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { startRunnerArtifactServer } from "../dist/runner/artifact-server.js";
import { makeTempDir } from "./helpers.js";

function makeProject() {
  const projectDir = makeTempDir("aos-runner-art-");
  const artemis = path.join(projectDir, ".artemis");
  fs.mkdirSync(path.join(artemis, "design", "reports"), { recursive: true });
  fs.writeFileSync(path.join(artemis, "design", "reports", "a.xlsx"), "xlsx-bytes");
  fs.writeFileSync(path.join(artemis, "design", "shot.png"), Buffer.from([1, 2, 3]));
  fs.writeFileSync(path.join(artemis, "design", "note.json"), '{"ok":true}');
  fs.writeFileSync(path.join(artemis, "design", "<img onerror>.txt"), "evil");
  fs.writeFileSync(path.join(projectDir, "secret.txt"), "top-secret");
  return { projectDir, artemis };
}

async function withServer(run) {
  const { projectDir, artemis } = makeProject();
  const server = await startRunnerArtifactServer({ projectDir, port: 0 });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    await run(base, projectDir, artemis);
  } finally {
    await server.close();
  }
}

test("artifact server: healthz 200 + project 名", async () => {
  await withServer(async (base, projectDir) => {
    const response = await fetch(`${base}/healthz`);
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.ok, true);
    assert.equal(payload.project, path.basename(projectDir));
  });
});

test("artifact server: 文件内容/类型/nosniff；HEAD 同状态无 body", async () => {
  await withServer(async (base) => {
    const png = await fetch(`${base}/artifact/design/shot.png`);
    assert.equal(png.status, 200);
    assert.equal(png.headers.get("content-type"), "image/png");
    assert.equal(png.headers.get("x-content-type-options"), "nosniff");
    assert.deepEqual([...new Uint8Array(await png.arrayBuffer())], [1, 2, 3]);

    const json = await fetch(`${base}/artifact/design/note.json`);
    assert.equal(json.headers.get("content-type"), "text/plain; charset=utf-8");
    assert.equal(await json.text(), '{"ok":true}');

    const xlsx = await fetch(`${base}/artifact/design/reports/a.xlsx`);
    assert.equal(
      xlsx.headers.get("content-type"),
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );

    const head = await fetch(`${base}/artifact/design/shot.png`, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get("content-length"), "3");
    assert.equal(await head.text(), "", "HEAD 无 body");
  });
});

test("artifact server: 目录浅索引（转义文件名/父目录链接/不递归/截断提示）+ nosniff", async () => {
  await withServer(async (base, _projectDir, artemis) => {
    const many = path.join(artemis, "design", "many");
    fs.mkdirSync(many, { recursive: true });
    for (let index = 0; index < 505; index += 1) {
      fs.writeFileSync(path.join(many, `f-${String(index).padStart(3, "0")}.txt`), "x");
    }

    const index = await fetch(`${base}/artifact/design`);
    assert.equal(index.status, 200);
    assert.equal(index.headers.get("content-type"), "text/html; charset=utf-8");
    assert.equal(index.headers.get("x-content-type-options"), "nosniff");
    const html = await index.text();
    assert.match(html, /&lt;img onerror&gt;\.txt/, "文件名转义");
    assert.doesNotMatch(html, /<img onerror>/);
    assert.match(html, /href="\/artifact\/design\/note\.json"/);
    assert.match(html, /href="\/artifact\/design\/many\/"/, "目录链接带尾斜杠");
    assert.match(html, /href="\/artifact\/"/, "父目录链接");
    assert.doesNotMatch(html, /f-000\.txt/, "浅索引不递归");

    const truncated = await fetch(`${base}/artifact/design/many`);
    const truncatedHtml = await truncated.text();
    assert.match(truncatedHtml, /仅显示前 500 项/);
  });
});

test("artifact server: 穿越与越界拒绝（编码 ../、绝对路径、符号链接外逃、根外文件）", async () => {
  await withServer(async (base, projectDir, artemis) => {
    fs.symlinkSync(path.join(projectDir, "secret.txt"), path.join(artemis, "escape-link"));

    for (const target of [
      "/artifact/%2e%2e/secret.txt",
      "/artifact/%2e%2e/%2e%2e/etc/passwd",
      "/artifact//etc/passwd",
      "/artifact/escape-link"
    ]) {
      const response = await fetch(`${base}${target}`);
      assert.ok(
        response.status === 400 || response.status === 404,
        `${target} → ${response.status}`
      );
      const text = await response.text();
      assert.ok(!text.includes("top-secret"), `${target} 不得读到项目外文件`);
    }

    const normalized = await fetch(`${base}/artifact/../secret.txt`);
    assert.ok(normalized.status === 400 || normalized.status === 404);
  });
});

test("artifact server: 非 GET/HEAD → 405；未知路径 → 404", async () => {
  await withServer(async (base) => {
    const post = await fetch(`${base}/artifact/design/note.json`, { method: "POST" });
    assert.equal(post.status, 405);
    const missing = await fetch(`${base}/artifact/design/nope.bin`);
    assert.equal(missing.status, 404);
    const other = await fetch(`${base}/other`);
    assert.equal(other.status, 404);
  });
});
