import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { checkFigma, checkLlm, checkPen } from "../dist/workflow/setup.js";

function stubRuntime({ dotenv = {}, entry = null } = {}) {
  const state = { activeCalls: 0 };
  return {
    project: { dotenvValues: dotenv },
    state,
    async activeEntry() {
      state.activeCalls += 1;
      return entry;
    }
  };
}

function stubExec(result) {
  const calls = [];
  const exec = async (command, args, options = {}) => {
    calls.push({ command, args, options });
    return typeof result === "function" ? result(command, args, options) : result;
  };
  return { exec, calls };
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

const LLM_ENTRY = {
  name: "deepseek",
  model: "deepseek-chat",
  baseUrl: "https://api.deepseek.com/v1",
  apiKey: "sk-test-key"
};

test("checkFigma: 项目 .env 有 token → null", async () => {
  await withFigmaToken(undefined, async () => {
    const runtime = stubRuntime({ dotenv: { FIGMA_ACCESS_TOKEN: "figd_dotenv" } });
    assert.equal(checkFigma(runtime), null);
  });
});

test("checkFigma: 进程 env 有 token → null", async () => {
  await withFigmaToken("figd_process", async () => {
    const runtime = stubRuntime();
    assert.equal(checkFigma(runtime), null);
  });
});

test("checkFigma: 缺 token → 结构化 need（missing/howTo 逐字）", async () => {
  await withFigmaToken(undefined, async () => {
    const runtime = stubRuntime();
    assert.deepEqual(checkFigma(runtime), {
      target: "figma",
      missing: ["FIGMA_ACCESS_TOKEN"],
      howTo: ["aos_configure(figmaToken=…) 或写项目 .env"]
    });
  });
});

test("checkPen: PEN_CLI_KEY（项目 .env）短路 → null 且不跑子进程", async () => {
  const { exec, calls } = stubExec(() => {
    throw new Error("exec 不应被调用");
  });
  const runtime = stubRuntime({ dotenv: { PEN_CLI_KEY: "pen-dotenv-key" } });
  const need = await checkPen(runtime, { exec, env: { AOS_PEN_CLI_PATH: "/opt/missing-pen" } });
  assert.equal(need, null);
  assert.equal(calls.length, 0);
});

test("checkPen: PEN_CLI_KEY（进程 env）短路 → null 且不跑子进程", async () => {
  const { exec, calls } = stubExec(() => {
    throw new Error("exec 不应被调用");
  });
  const runtime = stubRuntime();
  const need = await checkPen(runtime, {
    exec,
    env: { PEN_CLI_KEY: "pen-process-key", AOS_PEN_CLI_PATH: "/opt/missing-pen" }
  });
  assert.equal(need, null);
  assert.equal(calls.length, 0);
});

test("checkPen: CLI 缺失（ENOENT）→ need（安装指引），不自动安装、不写盘", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aos-workflow-setup-"));
  const { exec, calls } = stubExec({ code: null, stdout: "", stderr: "", error: "spawn pen ENOENT" });
  const runtime = stubRuntime();
  const need = await checkPen(runtime, { exec, env: { AOS_PEN_CLI_DIR: dir }, penTimeoutMs: 1234 });

  assert.ok(need);
  assert.equal(need.target, "pen");
  assert.ok(need.missing.some((line) => line.includes("pen CLI")));
  const howTo = need.howTo.join("\n");
  assert.ok(howTo.includes("~/.aos/pen-cli"), "自动托管安装说明");
  assert.ok(howTo.includes("AOS_PEN_CLI_PATH"));
  assert.ok(howTo.includes("AOS_PEN_NO_INSTALL=1"));
  assert.ok(howTo.includes("预装"));
  assert.ok((need.note ?? "").includes("ENOENT"));

  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "pen");
  assert.deepEqual(calls[0].args, ["status"]);
  assert.equal(calls[0].options.timeoutMs, 1234);
  assert.deepEqual(fs.readdirSync(dir), [], "CLI 缺失不得触发自动安装/写盘");
});

test("checkPen: pen status 退出 0 且 Active → null", async () => {
  const { exec, calls } = stubExec({
    code: 0,
    stdout: "\nEmail       dev@example.com\nWorkspace   Personal (dev)\n● Active\n",
    stderr: ""
  });
  const runtime = stubRuntime();
  const need = await checkPen(runtime, { exec, env: { AOS_PEN_CLI_PATH: "/opt/pen" } });
  assert.equal(need, null);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "/opt/pen");
  assert.deepEqual(calls[0].args, ["status"]);
});

test("checkPen: pen status 退出 0 但 Not logged in → need（登录指引）", async () => {
  const { exec } = stubExec({
    code: 0,
    stdout: 'Not logged in. Please run "pen login" to continue.\n',
    stderr: ""
  });
  const runtime = stubRuntime();
  const need = await checkPen(runtime, { exec, env: { AOS_PEN_CLI_PATH: "/opt/pen" } });

  assert.ok(need);
  assert.equal(need.target, "pen");
  assert.ok(need.missing.some((line) => line.includes("登录")));
  const howTo = need.howTo.join("\n");
  assert.ok(howTo.includes("pen login"));
  assert.ok(howTo.includes("PEN_CLI_KEY"));
  assert.ok((need.note ?? "").includes("Not logged in"));
});

test("checkPen: pen status 非零退出 → need（登录指引）", async () => {
  const { exec } = stubExec({ code: 1, stdout: "", stderr: "boom" });
  const runtime = stubRuntime();
  const need = await checkPen(runtime, { exec, env: { AOS_PEN_CLI_PATH: "/opt/pen" } });

  assert.ok(need);
  assert.ok(need.missing.some((line) => line.includes("登录")));
  assert.ok((need.note ?? "").includes("退出码 1"));
});

test("checkPen: pen status 超时 → need（登录/重试指引）", async () => {
  const { exec, calls } = stubExec({ code: null, stdout: "", stderr: "", error: "timeout" });
  const runtime = stubRuntime();
  const need = await checkPen(runtime, { exec, env: { AOS_PEN_CLI_PATH: "/opt/pen" }, penTimeoutMs: 50 });

  assert.ok(need);
  assert.ok(need.missing.some((line) => line.includes("登录")));
  const howTo = need.howTo.join("\n");
  assert.ok(howTo.includes("pen login"));
  assert.ok((need.note ?? "").includes("超时"));
  assert.equal(calls[0].options.timeoutMs, 50);
});

test("checkLlm: 无 active 条目 → need（aos_configure/.env 指引），不调用 chat", async () => {
  let chats = 0;
  const runtime = stubRuntime({ entry: null });
  const need = await checkLlm(runtime, {
    chat: async () => {
      chats += 1;
      return "pong";
    }
  });

  assert.ok(need);
  assert.equal(need.target, "llm");
  assert.ok(need.missing.some((line) => line.includes("model")));
  const howTo = need.howTo.join("\n");
  assert.ok(howTo.includes("aos_configure"));
  assert.ok(howTo.includes("AOS_LLM_MODEL"));
  assert.ok(howTo.includes("AOS_LLM_API_KEY"));
  assert.ok(howTo.includes("AOS_LLM_BASE_URL"));
  assert.equal(chats, 0);
});

test("checkLlm: active 条目不完整 → need（不 ping）", async () => {
  let chats = 0;
  const runtime = stubRuntime({
    entry: { name: "half", model: "m", baseUrl: "https://x.example/v1", apiKey: null }
  });
  const need = await checkLlm(runtime, {
    chat: async () => {
      chats += 1;
      return "pong";
    }
  });

  assert.ok(need);
  assert.ok(need.missing.some((line) => line.includes("api_key")));
  assert.equal(chats, 0);
});

test("checkLlm: ping 成功 → null；每次调用重新 ping（不缓存）", async () => {
  const messages = [];
  const signals = [];
  const runtime = stubRuntime({ entry: LLM_ENTRY });
  const chat = async (list, signal) => {
    messages.push(list);
    signals.push(signal);
    return "pong";
  };

  assert.equal(await checkLlm(runtime, { chat }), null);
  assert.deepEqual(messages[0], [{ role: "user", content: "ping" }]);
  assert.ok(signals[0] instanceof AbortSignal);
  assert.equal(await checkLlm(runtime, { chat }), null);
  assert.equal(messages.length, 2, "ping 结果不得缓存");
  assert.equal(runtime.state.activeCalls, 2);
});

test("checkLlm: ping 抛错 → need（核对 key/model/base_url 与代理指引）", async () => {
  const runtime = stubRuntime({ entry: LLM_ENTRY });
  const need = await checkLlm(runtime, {
    chat: async () => {
      throw new Error("socket hang up");
    }
  });

  assert.ok(need);
  assert.ok(need.missing.some((line) => line.includes("ping")));
  const howTo = need.howTo.join("\n");
  assert.ok(howTo.includes("model"));
  assert.ok(howTo.includes("base_url"));
  assert.ok(howTo.includes("api_key"));
  assert.ok(howTo.includes("代理"));
  assert.ok((need.note ?? "").includes("socket hang up"));
});

test("checkLlm: ping 超时（AbortSignal.timeout）→ need", async () => {
  const captured = {};
  const runtime = stubRuntime({ entry: LLM_ENTRY });
  const pending = checkLlm(runtime, {
    llmTimeoutMs: 30,
    chat: (messages, signal) =>
      new Promise((_resolve, reject) => {
        captured.signal = signal;
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      })
  });
  await new Promise((resolve) => setTimeout(resolve, 80));
  const need = await pending;

  assert.ok(need);
  assert.equal(captured.signal.aborted, true);
  assert.ok((need.note ?? "").toLowerCase().includes("timeout"));
});

test("checkLlm: ping 成功/失败都记录 model、耗时与结果（不落 key）", async () => {
  const runtime = stubRuntime({ entry: LLM_ENTRY });
  const logs = [];
  assert.equal(
    await checkLlm(runtime, { chat: async () => "pong", log: (line) => logs.push(line) }),
    null
  );
  assert.equal(logs.length, 1);
  assert.match(logs[0], /LLM ping 通过/);
  assert.ok(logs[0].includes("model=deepseek-chat"));
  assert.match(logs[0], /ms=\d+/);
  assert.ok(!logs[0].includes("sk-test-key"));

  logs.length = 0;
  const need = await checkLlm(runtime, {
    chat: async () => {
      throw new Error("socket hang up");
    },
    log: (line) => logs.push(line)
  });
  assert.ok(need);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /LLM ping 失败/);
  assert.ok(logs[0].includes("model=deepseek-chat"));
  assert.match(logs[0], /ms=\d+/);
  assert.ok(logs[0].includes("socket hang up"));
  assert.ok(!logs[0].includes("sk-test-key"));
});

test("前置检查：全桩注入时不触网、不写盘", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aos-workflow-setup-"));
  const fetchCalls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    fetchCalls.push(String(url));
    throw new Error("测试禁网");
  };
  try {
    await withFigmaToken(undefined, async () => {
      const runtime = stubRuntime({ entry: LLM_ENTRY });
      assert.equal(checkFigma(runtime)?.target ?? null, "figma");
      const penExec = stubExec({ code: 0, stdout: "● Active\n", stderr: "" });
      assert.equal(
        await checkPen(runtime, {
          exec: penExec.exec,
          env: { AOS_PEN_CLI_DIR: dir, AOS_PEN_CLI_PATH: "/opt/pen" },
          penTimeoutMs: 50
        }),
        null
      );
      assert.equal(await checkLlm(runtime, { chat: async () => "pong", llmTimeoutMs: 50 }), null);
    });
    assert.deepEqual(fetchCalls, [], "不得触网");
    assert.deepEqual(fs.readdirSync(dir), [], "不得写盘");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
