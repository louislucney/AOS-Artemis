import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { staticReadiness } from "../dist/workflow/readiness.js";

const LLM_ENTRY = {
  name: "deepseek",
  model: "deepseek-chat",
  baseUrl: "https://api.deepseek.com/v1",
  apiKey: "sk-test-123456"
};

function stubRuntime({ dotenv = {}, entry = LLM_ENTRY, jira } = {}) {
  return {
    project: { dotenvValues: dotenv },
    async activeEntry() {
      if (entry === "throw") throw new Error("pg down");
      return entry;
    },
    jiraConfig: () =>
      jira ?? {
        configured: true,
        missing: [],
        siteUrl: "https://x.atlassian.net",
        email: "qa@example.com",
        apiToken: "t"
      }
  };
}

async function withFigmaToken(value, fn) {
  const previous = process.env.FIGMA_ACCESS_TOKEN;
  if (value === undefined) delete process.env.FIGMA_ACCESS_TOKEN;
  else process.env.FIGMA_ACCESS_TOKEN = value;
  try {
    await fn();
  } finally {
    if (previous === undefined) delete process.env.FIGMA_ACCESS_TOKEN;
    else process.env.FIGMA_ACCESS_TOKEN = previous;
  }
}

test("figma：项目 .env token → ready；进程 env token → ready；缺 → missing 逐字", async () => {
  const withDotenv = await staticReadiness(
    stubRuntime({ dotenv: { FIGMA_ACCESS_TOKEN: "figd_dotenv" } }),
    { env: {} }
  );
  assert.deepEqual(withDotenv.figma, {
    ready: true,
    missing: [],
    detail: "FIGMA_ACCESS_TOKEN 已配置（未复核）",
    verified: false
  });

  await withFigmaToken("figd_process", async () => {
    const viaEnv = await staticReadiness(stubRuntime(), { env: {} });
    assert.equal(viaEnv.figma.ready, true);
  });

  await withFigmaToken(undefined, async () => {
    const missing = await staticReadiness(stubRuntime(), { env: {} });
    assert.deepEqual(missing.figma, {
      ready: false,
      missing: ["FIGMA_ACCESS_TOKEN"],
      detail: "缺 FIGMA_ACCESS_TOKEN",
      verified: false
    });
  });
});

test("pen：key／env 路径／托管／PATH 兜底 四态", async () => {
  const viaKey = await staticReadiness(stubRuntime({ dotenv: { PEN_CLI_KEY: "k" } }), { env: {} });
  assert.deepEqual(viaKey.pen, {
    ready: true,
    detail: "PEN_CLI_KEY 已配置（登录状态未复核）",
    verified: false
  });

  const viaEnvPath = await staticReadiness(stubRuntime(), { env: { AOS_PEN_CLI_PATH: "/opt/pen" } });
  assert.equal(viaEnvPath.pen.ready, true);
  assert.equal(viaEnvPath.pen.detail.includes("/opt/pen"), true);
  assert.equal(viaEnvPath.pen.detail.includes("登录状态未复核"), true);

  const managedDir = path.join(os.tmpdir(), `aos-pen-managed-${process.pid}`);
  const managed = await staticReadiness(stubRuntime(), {
    env: { AOS_PEN_CLI_DIR: managedDir },
    exists: () => true
  });
  assert.equal(managed.pen.ready, true);
  assert.equal(managed.pen.detail.includes("托管安装："), true);
  assert.equal(managed.pen.detail.includes(managedDir), true);

  const fallback = await staticReadiness(stubRuntime(), { env: {}, exists: () => false });
  assert.deepEqual(fallback.pen, {
    ready: false,
    detail:
      "未检测到 pen 配置（PATH 兜底未复核；howTo：pen login / 项目 .env 写 PEN_CLI_KEY / AOS_PEN_CLI_PATH；首次调用可自动托管安装）",
    verified: false
  });
});

test("jira：configured（email masked）与缺（missing 逐字）", async () => {
  const ready = await staticReadiness(stubRuntime(), { env: {} });
  assert.deepEqual(ready.jira, {
    ready: true,
    missing: [],
    site: "https://x.atlassian.net",
    email: "****.com",
    detail: "站点 https://x.atlassian.net（凭证未复核）",
    verified: false
  });

  const missing = await staticReadiness(
    stubRuntime({
      jira: {
        configured: false,
        missing: ["JIRA_BASE_URL", "JIRA_API_TOKEN"],
        siteUrl: null,
        email: null,
        apiToken: null
      }
    }),
    { env: {} }
  );
  assert.deepEqual(missing.jira, {
    ready: false,
    missing: ["JIRA_BASE_URL", "JIRA_API_TOKEN"],
    site: null,
    email: null,
    detail: "缺 JIRA_BASE_URL / JIRA_API_TOKEN",
    verified: false
  });
});

test("llm：完整条目（key masked）／缺 key／未配置／activeEntry 抛错降级", async () => {
  const ready = await staticReadiness(stubRuntime(), { env: {} });
  assert.deepEqual(ready.llm, {
    ready: true,
    missing: [],
    name: "deepseek",
    model: "deepseek-chat",
    baseUrl: "https://api.deepseek.com/v1",
    key: "****3456",
    detail: "条目「deepseek」（未复核）",
    verified: false
  });
  assert.deepEqual(ready.degraded, []);

  const incomplete = await staticReadiness(stubRuntime({ entry: { ...LLM_ENTRY, apiKey: null } }), {
    env: {}
  });
  assert.deepEqual(incomplete.llm, {
    ready: false,
    missing: ["api_key"],
    name: "deepseek",
    model: "deepseek-chat",
    baseUrl: "https://api.deepseek.com/v1",
    key: null,
    detail: "条目「deepseek」缺 api_key（未复核）",
    verified: false
  });

  const none = await staticReadiness(stubRuntime({ entry: null }), { env: {} });
  assert.deepEqual(none.llm, {
    ready: false,
    missing: ["model", "base_url", "api_key"],
    name: null,
    model: null,
    baseUrl: null,
    key: null,
    detail: "未配置（aos_configure / 项目 .env）",
    verified: false
  });

  const degraded = await staticReadiness(stubRuntime({ entry: "throw" }), { env: {} });
  assert.equal(degraded.llm.ready, false);
  assert.deepEqual(degraded.llm.missing, []);
  assert.equal(degraded.llm.detail.includes("LLM 条目读取降级"), true);
  assert.equal(degraded.llm.detail.includes("pg down"), true);
  assert.deepEqual(degraded.degraded, ["LLM 条目读取降级：pg down"]);
});

test("全部 verified:false；禁网（fetch 不被调用）", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("测试禁网");
  };
  try {
    const report = await staticReadiness(stubRuntime(), { env: {} });
    for (const section of [report.figma, report.pen, report.jira, report.llm]) {
      assert.equal(section.verified, false);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});
