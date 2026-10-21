import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import test from "node:test";

import { newDb } from "pg-mem";

import { PostgresStore } from "../dist/db/postgres.js";
import { artifactUrl } from "../dist/panel/overview.js";
import { startRunnerArtifactServer } from "../dist/runner/artifact-server.js";
import { runSuiteCommand } from "../dist/suite-command.js";
import { baseConfig, loadTestRuntime, makeTempDir, makeTempProject } from "./helpers.js";

const TOKEN = "artifact-token-7d6c";

function captureStderr() {
  const chunks = [];
  const original = process.stderr.write;
  process.stderr.write = (chunk) => {
    chunks.push(Buffer.isBuffer(chunk) ? chunk.toString() : String(chunk));
    return true;
  };
  return {
    chunks,
    restore: () => {
      process.stderr.write = original;
    }
  };
}

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
  const server = await startRunnerArtifactServer({ projectDir, port: 0, env: {} });
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

test("端到端缝：artifactUrl 构建的 URL 打到真实产物服务 → 200（跨任务缝合）", async () => {
  const { projectDir, artemis } = makeProject();
  const server = await startRunnerArtifactServer({ projectDir, port: 0, env: {} });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    const fileUrl = artifactUrl(
      base,
      projectDir,
      path.join(artemis, "design", "reports", "a.xlsx")
    );
    assert.equal(fileUrl, `${base}/artifact/design/reports/a.xlsx`);
    const file = await fetch(fileUrl);
    assert.equal(file.status, 200, "面板拼出的 URL 必须真实可达");
    assert.equal(await file.text(), "xlsx-bytes");

    const dirUrl = artifactUrl(base, projectDir, path.join(artemis, "design"));
    const dirResponse = await fetch(dirUrl);
    assert.equal(dirResponse.status, 200);
    assert.match(await dirResponse.text(), /note\.json/, "目录索引可达");
  } finally {
    await server.close();
  }
});

async function withTokenServer(run) {
  const { projectDir, artemis } = makeProject();
  const server = await startRunnerArtifactServer({
    projectDir,
    port: 0,
    env: { AOS_RUNNER_ARTIFACT_TOKEN: TOKEN }
  });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    await run(base, projectDir, artemis);
  } finally {
    await server.close();
  }
}

test("artifact server: 未设 token → 无凭据照旧 200（既有行为回归）", async () => {
  const { projectDir } = makeProject();
  const server = await startRunnerArtifactServer({ projectDir, port: 0, env: {} });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    const file = await fetch(`${base}/artifact/design/note.json`);
    assert.equal(file.status, 200);
    assert.equal(await file.text(), '{"ok":true}');

    const head = await fetch(`${base}/artifact/design/shot.png`, { method: "HEAD" });
    assert.equal(head.status, 200);

    const health = await fetch(`${base}/healthz`);
    assert.equal(health.status, 200);

    const query = await fetch(`${base}/artifact/design/note.json?t=whatever`);
    assert.equal(query.status, 200, "未设 token 时查询参数不参与判定（照旧）");
  } finally {
    await server.close();
  }
});

test("artifact server: 设 token → 未认证 401＋realm；HEAD 抑制 body", async () => {
  await withTokenServer(async (base) => {
    const response = await fetch(`${base}/artifact/design/note.json`);
    assert.equal(response.status, 401);
    assert.equal(response.headers.get("www-authenticate"), 'Basic realm="aos-artifact"');
    assert.deepEqual(await response.json(), { error: "unauthorized" });

    const head = await fetch(`${base}/artifact/design/note.json`, { method: "HEAD" });
    assert.equal(head.status, 401);
    assert.equal(head.headers.get("www-authenticate"), 'Basic realm="aos-artifact"');
    assert.equal(await head.text(), "", "HEAD 无 body");

    const dir = await fetch(`${base}/artifact/design`);
    assert.equal(dir.status, 401, "目录索引同样受保护");
  });
});

test("artifact server: 设 token → Bearer/Basic（用户名任意/空）/ ?t= 通过；错 token 401", async () => {
  await withTokenServer(async (base) => {
    const bearer = await fetch(`${base}/artifact/design/note.json`, {
      headers: { authorization: `Bearer ${TOKEN}` }
    });
    assert.equal(bearer.status, 200);
    assert.equal(await bearer.text(), '{"ok":true}');

    const basic = await fetch(`${base}/artifact/design/note.json`, {
      headers: { authorization: `Basic ${Buffer.from(`user:${TOKEN}`).toString("base64")}` }
    });
    assert.equal(basic.status, 200);

    const anonymous = await fetch(`${base}/artifact/design/note.json`, {
      headers: { authorization: `Basic ${Buffer.from(`:${TOKEN}`).toString("base64")}` }
    });
    assert.equal(anonymous.status, 200, "Basic 用户名可为空");

    const query = await fetch(`${base}/artifact/design/note.json?t=${TOKEN}`);
    assert.equal(query.status, 200, "?t= 直链可用");

    const wrongBearer = await fetch(`${base}/artifact/design/note.json`, {
      headers: { authorization: "Bearer nope" }
    });
    assert.equal(wrongBearer.status, 401);

    const wrongQuery = await fetch(`${base}/artifact/design/note.json?t=nope`);
    assert.equal(wrongQuery.status, 401);

    const otherScheme = await fetch(`${base}/artifact/design/note.json`, {
      headers: { authorization: `Token ${TOKEN}` }
    });
    assert.equal(otherScheme.status, 401, "仅接受 Bearer/Basic/?t=");
  });
});

test("artifact server: 设 token → 目录索引经 ?t= 携带查询令牌（条目与父链接）", async () => {
  await withTokenServer(async (base) => {
    const index = await fetch(`${base}/artifact/design?t=${encodeURIComponent(TOKEN)}`);
    assert.equal(index.status, 200);
    const html = await index.text();
    assert.match(
      html,
      new RegExp(`href="/artifact/design/note\\.json\\?t=${TOKEN}"`),
      "文件条目携带 ?t="
    );
    assert.match(
      html,
      new RegExp(`href="/artifact/design/reports/\\?t=${TOKEN}"`),
      "目录条目携带 ?t= 且保留尾斜杠"
    );
    assert.match(html, new RegExp(`href="/artifact/\\?t=${TOKEN}"`), "父目录链接携带 ?t=");
  });
});

test("artifact server: 有效 Bearer ＋ 陈旧 ?t= → 索引链接不携带坏令牌（I2）", async () => {
  await withTokenServer(async (base) => {
    const index = await fetch(`${base}/artifact/design?t=stale`, {
      headers: { authorization: `Bearer ${TOKEN}` }
    });
    assert.equal(index.status, 200);
    const html = await index.text();
    assert.doesNotMatch(html, /\?t=/, "Bearer 命中不改变 ?t= 判定：坏值不得进链接");
    assert.match(html, /href="\/artifact\/design\/note\.json"/, "链接回到无查询形态");
  });
});

test("artifact server: Basic 凭据（无 ?t=）→ 索引链接不携带 ?t=", async () => {
  await withTokenServer(async (base) => {
    const index = await fetch(`${base}/artifact/design`, {
      headers: { authorization: `Basic ${Buffer.from(`user:${TOKEN}`).toString("base64")}` }
    });
    assert.equal(index.status, 200);
    const html = await index.text();
    assert.doesNotMatch(html, /\?t=/, "仅 Bearer/Basic 命中时链接不带 ?t=");
    assert.match(html, /href="\/artifact\/design\/reports\/"/);
  });
});

test("artifact server: 未启用 token → 目录索引逐字不含 ?t=（回归）", async () => {
  await withServer(async (base) => {
    const plain = await (await fetch(`${base}/artifact/design`)).text();
    const withQuery = await (await fetch(`${base}/artifact/design?t=whatever`)).text();
    assert.equal(withQuery, plain, "未启用 token 时索引逐字一致");
    assert.doesNotMatch(plain, /\?t=/);
    assert.match(plain, /href="\/artifact\/design\/note\.json"/);
  });
});

test("artifact server: 含保留字符的 token → 索引链接 ?t= 百分号编码", async () => {
  const reserved = "a+b/c";
  const { projectDir } = makeProject();
  const server = await startRunnerArtifactServer({
    projectDir,
    port: 0,
    env: { AOS_RUNNER_ARTIFACT_TOKEN: reserved }
  });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    const index = await fetch(`${base}/artifact/design?t=${encodeURIComponent(reserved)}`);
    assert.equal(index.status, 200);
    const html = await index.text();
    assert.match(html, /href="\/artifact\/design\/note\.json\?t=a%2Bb%2Fc"/, "保留字符须百分号编码");
  } finally {
    await server.close();
  }
});

test("artifact server: 设 token → /healthz 豁免（GET 与 HEAD）；闸门先于路由", async () => {
  await withTokenServer(async (base) => {
    const health = await fetch(`${base}/healthz`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).ok, true);

    const head = await fetch(`${base}/healthz`, { method: "HEAD" });
    assert.equal(head.status, 200, "探活 HEAD 豁免");
    assert.equal(await head.text(), "");

    const unknown = await fetch(`${base}/other`);
    assert.equal(unknown.status, 401, "未认证不泄露路由存在性");

    const unknownAuthed = await fetch(`${base}/other`, {
      headers: { authorization: `Bearer ${TOKEN}` }
    });
    assert.equal(unknownAuthed.status, 404, "认证通过后才进入 404");

    const post = await fetch(`${base}/artifact/design/note.json`, { method: "POST" });
    assert.equal(post.status, 405, "方法闸门不变");
  });
});

test("artifact server: 启动行含认证状态（已启用 masked / 未启用）", async () => {
  const { projectDir } = makeProject();
  const captured = captureStderr();
  try {
    const enabled = await startRunnerArtifactServer({
      projectDir,
      port: 0,
      env: { AOS_RUNNER_ARTIFACT_TOKEN: TOKEN }
    });
    await enabled.close();
    const disabled = await startRunnerArtifactServer({ projectDir, port: 0, env: {} });
    await disabled.close();
  } finally {
    captured.restore();
  }
  const output = captured.chunks.join("");
  assert.match(output, /认证：已启用/);
  assert.match(output, /token=\*{4}7d6c/);
  assert.equal(output.includes(TOKEN), false, "日志不得含明文 token");
  assert.match(output, /认证：未启用/);
});

function androidInventory() {
  return {
    platforms: ["android"],
    devices: [
      { serial: "emulator-5554", name: "", platform: "android", kind: "emulator", state: "device" }
    ],
    tools: { adb: true, idb: false, simctl: false, ideviceId: false, appium: false }
  };
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test("命令层接线: suite runner 以 env AOS_RUNNER_ARTIFACT_TOKEN 启动 → 产物服务要求认证（启动日志 masked）", async () => {
  const mem = newDb();
  const { Pool } = mem.adapters.createPg();
  const store = new PostgresStore(new Pool());
  await store.init();
  const dir = makeTempProject({ config: baseConfig() });
  const { runtime } = await loadTestRuntime(dir, { store });
  await runtime.store.upsertProject({ rootPath: runtime.project.rootDir, name: "p" });
  const artifactDir = path.join(runtime.project.rootDir, ".artemis", "design");
  fs.mkdirSync(artifactDir, { recursive: true });
  fs.writeFileSync(path.join(artifactDir, "note.json"), '{"ok":true}');
  const port = await freePort();

  const logs = [];
  const errors = [];
  const captured = captureStderr();
  let stopped = false;

  const runnerRun = runSuiteCommand(
    ["runner", "--artifact-port", String(port), "--artifact-host", "127.0.0.1", "--poll-ms", "50"],
    {
      buildRuntime: async () => ({ runtime, dispose: async () => {} }),
      log: (line) => logs.push(line),
      errorLog: (line) => errors.push(line),
      env: { AOS_RUNNER_ARTIFACT_TOKEN: TOKEN, AOS_RUNNER_SCHEDULES: "0" },
      runner: {
        collectInventory: async () => androidInventory(),
        executeSuite: async () => 0,
        shouldStop: () => stopped,
        sleep: () => new Promise((resolve) => setTimeout(resolve, 10))
      }
    }
  );

  try {
    const deadline = Date.now() + 5_000;
    let base = null;
    while (Date.now() < deadline) {
      const runners = await store.listRunners(runtime.project.rootDir);
      if (runners.length > 0 && runners[0].artifactBaseUrl) {
        base = runners[0].artifactBaseUrl;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(base, "runner 心跳应广播产物基址");
    assert.match(base, new RegExp(`:${port}$`));

    const unauthenticated = await fetch(`http://127.0.0.1:${port}/artifact/design/note.json`);
    assert.equal(unauthenticated.status, 401, "命令层 env 的 token 必须被产物服务采纳");

    const authorized = await fetch(`http://127.0.0.1:${port}/artifact/design/note.json`, {
      headers: { authorization: `Bearer ${TOKEN}` }
    });
    assert.equal(authorized.status, 200);
  } finally {
    stopped = true;
    await runnerRun;
    captured.restore();
  }

  const output = captured.chunks.join("");
  assert.match(output, /认证：已启用/);
  assert.match(output, /token=\*{4}7d6c/);
  assert.equal(output.includes(TOKEN), false, "启动日志不得含明文 token");
  assert.equal(errors.length, 0, errors.join("\n"));
});
