import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { makeTempDir } from "./helpers.js";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { MemoryStore } from "../dist/db/memory.js";
import { createAosHttpServer } from "../dist/http-server.js";

process.env.AOS_MODEL_REFRESH_HOURS = "0";
process.env.AOS_USAGE = "1";
process.env.AOS_LEDGER_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "aos-http-ledger-"));

const TOKEN = "aos-http-secret-token-9f8e7d6c";
const basic = (user, pass) => `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;

function withEnv(key, value, fn) {
  const previous = process.env[key];
  process.env[key] = value;
  return fn().finally(() => {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  });
}

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

function makeWorkspace() {
  const workspace = makeTempDir("aos-ws-");
  const projectDir = path.join(workspace, "demo");
  fs.mkdirSync(projectDir);
  fs.writeFileSync(
    path.join(projectDir, ".env"),
    "AOS_LLM_MODEL=deepseek-flash\nAOS_LLM_BASE_URL=https://api.deepseek.com/v1\nAOS_LLM_API_KEY=sk-http-123456\n"
  );
  return workspace;
}

test("http server: per-project routing and MCP over streamable HTTP", async () => {
  const workspace = makeWorkspace();
  const handle = await createAosHttpServer({ port: 0, host: "127.0.0.1", workspaceRoot: workspace });
  try {
    const client = new Client({ name: "http-smoke", version: "0.0.1" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${handle.port}/mcp/demo`))
    );

    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name);
    assert.ok(names.includes("llm_list"), names.join(","));
    assert.ok(names.includes("get_current_selection"));
    assert.ok(names.includes("aos_tasks"));

    const payload = JSON.parse(
      (await client.callTool({ name: "llm_list", arguments: {} })).content[0].text
    );
    assert.equal(payload.activeProfile, "deepseek-flash");
    assert.equal(payload.setupRequired, false);
    await client.close();

    // HTTP transport records usage: the audit line carries usage=<id>.
    const httpLog = fs.readFileSync(
      path.join(workspace, ".mobile-testing-mcp", "logs", "mobile-testing-mcp.log"),
      "utf-8"
    );
    assert.match(httpLog, /tool=llm_list ok=true ms=\d+ usage=[0-9a-f-]{36}/);

    // healthz reports registered projects
    const health = await fetch(`http://127.0.0.1:${handle.port}/healthz`);
    assert.equal(health.status, 200);
    const healthPayload = await health.json();
    assert.ok(healthPayload.projects.includes("demo"));

    // unknown project → 404
    const unknown = await fetch(`http://127.0.0.1:${handle.port}/mcp/nope`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}"
    });
    assert.equal(unknown.status, 404);

    // GET on /mcp/<project> is not supported in stateless mode
    const notAllowed = await fetch(`http://127.0.0.1:${handle.port}/mcp/demo`);
    assert.equal(notAllowed.status, 405);
  } finally {
    await handle.close();
  }
});

test("http server: invalid project names are rejected", async () => {
  const workspace = makeWorkspace();
  const handle = await createAosHttpServer({ port: 0, host: "127.0.0.1", workspaceRoot: workspace });
  try {
    const bad = await fetch(`http://127.0.0.1:${handle.port}/mcp/..%2Fescape`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}"
    });
    assert.equal(bad.status, 400);
  } finally {
    await handle.close();
  }
});

test("http server: usage dashboard over real HTTP", async () => {
  const workspace = makeWorkspace();
  const handle = await createAosHttpServer({ port: 0, host: "127.0.0.1", workspaceRoot: workspace });
  try {
    const client = new Client({ name: "usage-web-smoke", version: "0.0.1" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${handle.port}/mcp/demo`))
    );
    await client.callTool({ name: "llm_list", arguments: {} });
    await client.close();

    const html = await fetch(`http://127.0.0.1:${handle.port}/usage`);
    assert.equal(html.status, 200);
    assert.match(html.headers.get("content-type"), /text\/html/);
    const htmlBody = await html.text();
    assert.match(htmlBody, /概览/);
    assert.match(htmlBody, /工具表/);
    assert.match(htmlBody, /信号面板/);
    assert.match(htmlBody, /事件流水/);
    assert.match(htmlBody, /llm_list/);
    assert.match(htmlBody, /文件台账/);

    const json = await fetch(`http://127.0.0.1:${handle.port}/usage.json`);
    assert.equal(json.status, 200);
    const payload = await json.json();
    assert.equal(payload.ok, true);
    assert.equal(payload.project.name, "demo");
    assert.ok(payload.summary.total >= 1);
    assert.ok(payload.tools.some((row) => row.tool === "llm_list" && row.count >= 1));
    assert.ok(payload.events.items.some((event) => event.tool === "llm_list"));

    const health = await fetch(`http://127.0.0.1:${handle.port}/healthz`);
    assert.equal(health.status, 200);
    const unknown = await fetch(`http://127.0.0.1:${handle.port}/nope`);
    assert.equal(unknown.status, 404);
  } finally {
    await handle.close();
  }
});

test("http server: AOS_USAGE_WEB=0 disables /usage routes only", async () => {
  const previous = process.env.AOS_USAGE_WEB;
  process.env.AOS_USAGE_WEB = "0";
  const workspace = makeWorkspace();
  const handle = await createAosHttpServer({ port: 0, host: "127.0.0.1", workspaceRoot: workspace });
  try {
    assert.equal((await fetch(`http://127.0.0.1:${handle.port}/usage`)).status, 404);
    assert.equal((await fetch(`http://127.0.0.1:${handle.port}/usage.json`)).status, 404);
    assert.equal((await fetch(`http://127.0.0.1:${handle.port}/healthz`)).status, 200);
  } finally {
    await handle.close();
    if (previous === undefined) delete process.env.AOS_USAGE_WEB;
    else process.env.AOS_USAGE_WEB = previous;
  }
});

test("http server: panel dashboard over real HTTP", async () => {
  const workspace = makeWorkspace();
  const handle = await createAosHttpServer({ port: 0, host: "127.0.0.1", workspaceRoot: workspace });
  try {
    const json = await fetch(`http://127.0.0.1:${handle.port}/panel.json`);
    assert.equal(json.status, 200);
    const payload = await json.json();
    assert.equal(payload.ok, true);
    assert.equal(payload.view, "overview");
    assert.ok(payload.projects.some((row) => row.name === "demo"));

    const html = await fetch(`http://127.0.0.1:${handle.port}/panel`);
    assert.equal(html.status, 200);
    assert.match(html.headers.get("content-type"), /text\/html/);
    const body = await html.text();
    assert.match(body, /多项目总览/);
    assert.match(body, /demo/);
    assert.match(body, /data-console="shell"/, "总览套用控制台外壳");
    assert.match(body, /--color-accent/, "CSDC token 就位");

    const project = await fetch(`http://127.0.0.1:${handle.port}/panel?project=demo`);
    assert.equal(project.status, 200);
    const projectBody = await project.text();
    assert.match(projectBody, /接入信息/);
    assert.match(projectBody, /运行时细节/);

    const deepJson = await fetch(`http://127.0.0.1:${handle.port}/panel.json?project=demo`);
    assert.equal(deepJson.status, 200);
    const deepPayload = await deepJson.json();
    assert.equal(deepPayload.deep.store.kind, "file");
    assert.equal(deepPayload.deep.iosProbe, null, "默认不触发 iOS 探测");

    const unknown = await fetch(`http://127.0.0.1:${handle.port}/panel.json?project=nope`);
    assert.equal(unknown.status, 404);

    const health = await fetch(`http://127.0.0.1:${handle.port}/healthz`);
    assert.equal(health.status, 200);
  } finally {
    await handle.close();
  }
});

test("http server: AOS_PANEL_WEB=0 disables /panel routes only", async () => {
  const previous = process.env.AOS_PANEL_WEB;
  process.env.AOS_PANEL_WEB = "0";
  const workspace = makeWorkspace();
  const handle = await createAosHttpServer({ port: 0, host: "127.0.0.1", workspaceRoot: workspace });
  try {
    assert.equal((await fetch(`http://127.0.0.1:${handle.port}/panel`)).status, 404);
    assert.equal((await fetch(`http://127.0.0.1:${handle.port}/panel.json`)).status, 404);
    assert.equal((await fetch(`http://127.0.0.1:${handle.port}/usage`)).status, 200);
    assert.equal((await fetch(`http://127.0.0.1:${handle.port}/healthz`)).status, 200);
  } finally {
    await handle.close();
    if (previous === undefined) delete process.env.AOS_PANEL_WEB;
    else process.env.AOS_PANEL_WEB = previous;
  }
});

test("http server: panel action routes over real HTTP", async () => {
  const workspace = makeWorkspace();
  const handle = await createAosHttpServer({ port: 0, host: "127.0.0.1", workspaceRoot: workspace });
  try {
    const post = (pathname, body) =>
      fetch(`http://127.0.0.1:${handle.port}${pathname}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body
      });

    const missingProject = await post("/panel/api/tasks", JSON.stringify({ refs: [] }));
    assert.equal(missingProject.status, 400, "缺 project → 400");

    const unknownProject = await post(
      "/panel/api/tasks",
      JSON.stringify({ project: "nope", refs: [{ caseSetId: "x", featureKey: "y" }] })
    );
    assert.equal(unknownProject.status, 404, "未知项目 → 404");

    const unknownRef = await post(
      "/panel/api/tasks",
      JSON.stringify({ project: "demo", refs: [{ caseSetId: "x", featureKey: "y" }] })
    );
    assert.equal(unknownRef.status, 400, "未知份 → 400");

    const badJson = await post("/panel/api/tasks", "{oops");
    assert.equal(badJson.status, 400, "非法 JSON → 400");

    const notPost = await fetch(`http://127.0.0.1:${handle.port}/panel/api/tasks`);
    assert.equal(notPost.status, 405, "非 POST → 405");

    const missed = await post(
      "/panel/api/verdicts",
      JSON.stringify({
        project: "demo",
        items: [{ runId: "run-nope", caseId: "case-1" }],
        verdict: "uncertain"
      })
    );
    assert.equal(missed.status, 400, "裁决未命中 → 400");

    assert.equal((await fetch(`http://127.0.0.1:${handle.port}/panel`)).status, 200, "只读面板不受影响");
  } finally {
    await handle.close();
  }
});

test("http server: 任务视图路由（未知 task → 404）", async () => {
  const workspace = makeWorkspace();
  const handle = await createAosHttpServer({ port: 0, host: "127.0.0.1", workspaceRoot: workspace });
  try {
    const missing = await fetch(
      `http://127.0.0.1:${handle.port}/panel?project=demo&task=task-nope`
    );
    assert.equal(missing.status, 404);
    assert.equal((await fetch(`http://127.0.0.1:${handle.port}/panel`)).status, 200);
  } finally {
    await handle.close();
  }
});

test("http server: 归因队列（GET view=review + POST 裁决后队列更新）", async () => {
  const store = new MemoryStore();
  const workspace = makeWorkspace();
  const projectDir = path.join(workspace, "demo");
  await store.upsertProject({ rootPath: projectDir, name: "demo" });
  const run = await store.recordSuiteRun({
    rootPath: projectDir,
    createdAt: "2026-10-14T10:05:00.000Z",
    run: {
      trigger: "cli",
      regressionTaskId: null,
      caseSetId: null,
      featureKey: null,
      featureName: null,
      platform: "android",
      device: "emulator-5554",
      appVersion: null,
      status: "failed",
      startedAt: "2026-10-14T10:00:00.000Z",
      finishedAt: "2026-10-14T10:05:00.000Z",
      total: 1,
      passed: 0,
      failed: 1,
      flaky: 0,
      quarantined: 0,
      failureDomains: { 用例缺陷: 1 },
      gateResult: "fail",
      exitCode: 1,
      manifestPath: null,
      comparison: null
    },
    cases: [
      {
        caseId: "case-1",
        name: "Case 1",
        featureKey: null,
        platform: "android",
        status: "failed",
        traceId: null,
        failureDomain: "用例缺陷",
        failureConfidence: "medium",
        failureReason: "断言未命中",
        durationMs: null,
        quarantined: false,
        flaky: false,
        verdict: null,
        verdictBy: null,
        verdictAt: null,
        verdictNote: null
      }
    ]
  });
  const handle = await createAosHttpServer({
    port: 0,
    host: "127.0.0.1",
    workspaceRoot: workspace,
    store
  });
  try {
    const first = JSON.parse(
      await (await fetch(`http://127.0.0.1:${handle.port}/panel.json?project=demo&view=review`)).text()
    );
    assert.equal(first.view, "review");
    assert.equal(first.items.length, 1);
    assert.equal(first.items[0].verdict, null);

    const html = await fetch(`http://127.0.0.1:${handle.port}/panel?project=demo&view=review`);
    assert.equal(html.status, 200);

    const post = await fetch(`http://127.0.0.1:${handle.port}/panel/api/verdicts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project: "demo",
        items: [{ runId: run.id, caseId: "case-1" }],
        verdict: "case-defect",
        note: "期望值写错"
      })
    });
    assert.equal(post.status, 200);

    const second = JSON.parse(
      await (await fetch(`http://127.0.0.1:${handle.port}/panel.json?project=demo&view=review`)).text()
    );
    assert.equal(second.items[0].verdict, "case-defect", "裁决后队列更新（面板缓存已失效）");
    assert.equal(second.items[0].verdictNote, "期望值写错");
  } finally {
    await handle.close();
  }
});

test("http server: 动作层 body 超限 → 413；AOS_PANEL_ACTIONS=0 → 404", async () => {
  const store = new MemoryStore();
  const workspace = makeWorkspace();
  const handle = await createAosHttpServer({
    port: 0,
    host: "127.0.0.1",
    workspaceRoot: workspace,
    store
  });
  const previous = process.env.AOS_PANEL_ACTIONS;
  try {
    const tooLarge = await fetch(`http://127.0.0.1:${handle.port}/panel/api/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project: "demo", refs: [], pad: "x".repeat(300 * 1024) })
    });
    assert.equal(tooLarge.status, 413);
    assert.match(await tooLarge.text(), /too large/);

    process.env.AOS_PANEL_ACTIONS = "0";
    const disabled = await fetch(`http://127.0.0.1:${handle.port}/panel/api/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project: "demo", refs: [] })
    });
    assert.equal(disabled.status, 404, "动作层可独立关闭");
  } finally {
    if (previous === undefined) delete process.env.AOS_PANEL_ACTIONS;
    else process.env.AOS_PANEL_ACTIONS = previous;
    await handle.close();
  }
});

test("http server: MCP 端点 body >4MB → 413（排空后可继续请求）", async () => {
  const workspace = makeWorkspace();
  const handle = await createAosHttpServer({ port: 0, host: "127.0.0.1", workspaceRoot: workspace });
  try {
    const tooLarge = await fetch(`http://127.0.0.1:${handle.port}/mcp/demo`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pad: "x".repeat(5 * 1024 * 1024) })
    });
    assert.equal(tooLarge.status, 413);
    assert.equal(
      (await fetch(`http://127.0.0.1:${handle.port}/healthz`)).status,
      200,
      "排空后服务可继续使用"
    );
  } finally {
    await handle.close();
  }
});

test("http server: 设 token 后未授权请求被 401 拦截（闸门先于路由）", async () => {
  const workspace = makeWorkspace();
  await withEnv("AOS_HTTP_TOKEN", TOKEN, async () => {
    const handle = await createAosHttpServer({ port: 0, host: "127.0.0.1", workspaceRoot: workspace });
    try {
      const noCreds = [
        "/panel",
        "/panel.json",
        "/usage",
        "/usage.json",
        "/panel/api/tasks",
        "/mcp/demo"
      ];
      for (const p of noCreds) {
        const res = await fetch(`http://127.0.0.1:${handle.port}${p}`, {
          method: p === "/panel/api/tasks" || p === "/mcp/demo" ? "POST" : "GET",
          headers: p === "/panel/api/tasks" || p === "/mcp/demo" ? { "Content-Type": "application/json" } : undefined,
          body: p === "/panel/api/tasks" || p === "/mcp/demo" ? "{}" : undefined
        });
        assert.equal(res.status, 401, `${p} 无凭据应 401`);
        assert.equal(res.headers.get("www-authenticate"), 'Basic realm="mobile-testing-mcp"', p);
      }

      const bearerOk = await fetch(`http://127.0.0.1:${handle.port}/panel`, {
        headers: { Authorization: `Bearer ${TOKEN}` }
      });
      assert.equal(bearerOk.status, 200, "Bearer 应通过");

      const basicOk = await fetch(`http://127.0.0.1:${handle.port}/panel`, {
        headers: { Authorization: basic("alice", TOKEN) }
      });
      assert.equal(basicOk.status, 200, "Basic（密码=token）应通过");

      const wrong = await fetch(`http://127.0.0.1:${handle.port}/panel`, {
        headers: { Authorization: "Bearer wrong-token" }
      });
      assert.equal(wrong.status, 401, "错 token 应 401");
    } finally {
      await handle.close();
    }
  });
});

test("http server: 豁免路由 GET|HEAD / 与 /healthz → 200（HEAD 无体）", async () => {
  const workspace = makeWorkspace();
  await withEnv("AOS_HTTP_TOKEN", TOKEN, async () => {
    const handle = await createAosHttpServer({ port: 0, host: "127.0.0.1", workspaceRoot: workspace });
    try {
      const getRoot = await fetch(`http://127.0.0.1:${handle.port}/`);
      assert.equal(getRoot.status, 200);
      const getHealth = await fetch(`http://127.0.0.1:${handle.port}/healthz`);
      assert.equal(getHealth.status, 200);
      assert.equal((await getHealth.json()).ok, true);

      const headRoot = await fetch(`http://127.0.0.1:${handle.port}/`, { method: "HEAD" });
      assert.equal(headRoot.status, 200);
      assert.equal(await headRoot.text(), "", "HEAD / 无体");
      const headHealth = await fetch(`http://127.0.0.1:${handle.port}/healthz`, { method: "HEAD" });
      assert.equal(headHealth.status, 200);
      assert.equal(await headHealth.text(), "", "HEAD /healthz 无体");
    } finally {
      await handle.close();
    }
  });
});

test("http server: 401-on-HEAD 无体（Content-Length 0）", async () => {
  const workspace = makeWorkspace();
  await withEnv("AOS_HTTP_TOKEN", TOKEN, async () => {
    const handle = await createAosHttpServer({ port: 0, host: "127.0.0.1", workspaceRoot: workspace });
    try {
      const head = await fetch(`http://127.0.0.1:${handle.port}/panel`, { method: "HEAD" });
      assert.equal(head.status, 401);
      assert.equal(head.headers.get("content-length"), "0");
      assert.equal(await head.text(), "", "401-on-HEAD 无体");
    } finally {
      await handle.close();
    }
  });
});

test("http server: 禁用路由与未知路径——无凭据 401、有凭据 404", async () => {
  const workspace = makeWorkspace();
  await withEnv("AOS_HTTP_TOKEN", TOKEN, async () => {
    await withEnv("AOS_PANEL_WEB", "0", async () => {
      await withEnv("AOS_USAGE_WEB", "0", async () => {
        const handle = await createAosHttpServer({ port: 0, host: "127.0.0.1", workspaceRoot: workspace });
        try {
          const auth = { headers: { Authorization: `Bearer ${TOKEN}` } };
          assert.equal((await fetch(`http://127.0.0.1:${handle.port}/panel`)).status, 401, "禁用路由无凭据 401");
          assert.equal((await fetch(`http://127.0.0.1:${handle.port}/panel`, auth)).status, 404, "禁用路由有凭据 404");
          assert.equal((await fetch(`http://127.0.0.1:${handle.port}/usage`)).status, 401);
          assert.equal((await fetch(`http://127.0.0.1:${handle.port}/nope`)).status, 401, "未知路径无凭据 401");
          assert.equal((await fetch(`http://127.0.0.1:${handle.port}/nope`, auth)).status, 404, "未知路径有凭据 404");
        } finally {
          await handle.close();
        }
      });
    });
  });
});

test("http server: 非 loopback 无 token 拒绝启动（无 prepare 副作用）", async () => {
  const workspace = makeWorkspace();
  await withEnv("AOS_HTTP_TOKEN", "", async () => {
    await withEnv("AOS_HTTP_ALLOW_INSECURE", "", async () => {
      let handle = null;
      let threw = false;
      try {
        handle = await createAosHttpServer({ port: 0, host: "0.0.0.0", workspaceRoot: workspace });
      } catch (error) {
        threw = true;
        assert.equal(error.name, "InsecureBindRefusedError");
        assert.match(error.message, /AOS_HTTP_TOKEN/);
        assert.match(error.message, /AOS_HTTP_ALLOW_INSECURE/);
      } finally {
        if (handle) await handle.close();
      }
      assert.equal(threw, true, "非 loopback 无 token 应抛 InsecureBindRefusedError");
      assert.equal(fs.existsSync(path.join(workspace, ".mobile-testing-mcp")), false, "抛错前不产生 prepare 副作用");
    });
  });
});

test("http server: AOS_HTTP_ALLOW_INSECURE=1 放行非 loopback（有醒目 WARN）", async () => {
  const workspace = makeWorkspace();
  const cap = captureStderr();
  try {
    await withEnv("AOS_HTTP_TOKEN", "", async () => {
      await withEnv("AOS_HTTP_ALLOW_INSECURE", "1", async () => {
        const handle = await createAosHttpServer({ port: 0, host: "0.0.0.0", workspaceRoot: workspace });
        try {
          assert.equal((await fetch(`http://127.0.0.1:${handle.port}/healthz`)).status, 200);
        } finally {
          await handle.close();
        }
      });
    });
  } finally {
    cap.restore();
  }
  assert.ok(
    cap.chunks.some((c) => c.includes("WARN") && c.includes("AOS_HTTP_TOKEN")),
    "放行时应输出醒目 WARN"
  );
});

test("http server: 项目 .env 的 AOS_HTTP_TOKEN 不生效（仅 process.env 生效）", async () => {
  const workspace = makeWorkspace();
  const projectEnv = path.join(workspace, "demo", ".env");
  fs.appendFileSync(projectEnv, `AOS_HTTP_TOKEN=${TOKEN}\n`);
  const handle = await createAosHttpServer({ port: 0, host: "127.0.0.1", workspaceRoot: workspace });
  try {
    const res = await fetch(`http://127.0.0.1:${handle.port}/panel`);
    assert.equal(res.status, 200, "项目 .env 的同名变量不应启用认证（应 200 而非 401）");
  } finally {
    await handle.close();
  }
});

test("http server: 启动日志含 masked token、不含明文", async () => {
  const workspace = makeWorkspace();
  await withEnv("AOS_HTTP_TOKEN", TOKEN, async () => {
    const handle = await createAosHttpServer({ port: 0, host: "127.0.0.1", workspaceRoot: workspace });
    try {
      await handle.close();
    } catch {
      /* already closed */
    }
    const logPath = path.join(workspace, ".mobile-testing-mcp", "logs", "mobile-testing-mcp.log");
    const content = fs.readFileSync(logPath, "utf-8");
    assert.match(content, /认证：已启用/);
    assert.match(content, /token=\*{4}7d6c/);
    assert.equal(content.includes(TOKEN), false, "日志不得含明文 token");
  });
});

test("cli: serve --http 非 loopback 无 token → stderr 指引 + exit 2", () => {
  const result = spawnSync(
    process.execPath,
    ["dist/cli.js", "serve", "--http", "--host", "0.0.0.0", "--port", "0"],
    {
      cwd: path.resolve("."),
      encoding: "utf8",
      env: { ...process.env, AOS_HTTP_TOKEN: "", AOS_HTTP_ALLOW_INSECURE: "" },
      timeout: 30000
    }
  );
  assert.equal(result.status, 2, `stderr: ${result.stderr}`);
  assert.match(result.stderr, /AOS_HTTP_TOKEN/);
});
