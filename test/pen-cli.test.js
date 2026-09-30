import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  detectPenFailure,
  managedPenBinPath,
  penCliStatus,
  penEnvFrom,
  resolvePenCliPath,
  runPenInteractive
} from "../dist/pen/cli.js";
import { penApplyStrings, penApplyTokens } from "../dist/pen/apply.js";
import { penExport } from "../dist/pen/export.js";
import {
  anthropicBaseUrlFor,
  anthropicBridgeFor,
  buildAgentEnv,
  extractAgentResponse,
  penAgent
} from "../dist/pen/agent.js";
import { baseConfig, loadTestRuntime, makeTempProject, parseToolResult, StubProxy } from "./helpers.js";

const PEN_SAMPLE = `{
  "version": "2.19",
  "variables": {
    "color.bg": { "type": "color", "value": "#000000" }
  },
  "children": [
    {
      "id": "screen-home", "type": "frame", "name": "Home", "width": 390, "height": 300,
      "fill": "$color.bg",
      "children": [
        { "id": "title", "type": "text", "name": "Title", "content": "旧标题", "fill": "#000000" }
      ]
    }
  ]
}`;

function applyCommands(doc, commands) {
  for (const line of commands) {
    if (line === "save()" || line === "exit()" || line === "") continue;
    const set = /^SetVariables\((.*)\)$/.exec(line);
    if (set) {
      const variables = JSON.parse(set[1]);
      doc.variables = { ...(doc.variables ?? {}), ...variables };
      continue;
    }
    const update = /^Update\((.*), \{content: (.*)\}\)$/.exec(line);
    if (update) {
      const id = JSON.parse(update[1]);
      const content = JSON.parse(update[2]);
      const visit = (node) => {
        if (node.id === id && node.type === "text") node.content = content;
        for (const child of node.children ?? []) visit(child);
      };
      for (const child of doc.children ?? []) visit(child);
    }
  }
}

function fakePen({ onInteractive, onAgent } = {}) {
  const calls = [];
  const exec = async (command, args, options = {}) => {
    calls.push({ command, args, input: options.input, env: options.env });
    if (args[0] === "version") return { code: 0, stdout: "pen 0.3.9\n", stderr: "" };
    if (args.includes("--prompt")) {
      if (onAgent) return onAgent({ args, env: options.env });
      const input = args.includes("--in") ? args[args.indexOf("--in") + 1] : null;
      const output = args[args.indexOf("--out") + 1];
      const doc = input ? JSON.parse(fs.readFileSync(input, "utf-8")) : { version: "2.19", children: [] };
      doc.children.push({ id: "agent-node", type: "rectangle", name: "Agent", width: 10, height: 10 });
      fs.writeFileSync(output, JSON.stringify(doc, null, 2));
      return {
        code: 0,
        stdout: "✅ Agent completed\n--- Agent Response ---\nDone: added Agent.\n----------------------\n",
        stderr: ""
      };
    }
    if (args[0] === "status") {
      return { code: 0, stdout: "\nEmail       dev@example.com\nWorkspace   Personal (dev)\n● Active\n", stderr: "" };
    }
    if (args[0] === "interactive") {
      const input = args[args.indexOf("-i") + 1];
      const output = args[args.indexOf("-o") + 1];
      const commands = (options.input ?? "").split("\n").filter(Boolean);
      if (onInteractive) onInteractive({ input, output, commands });
      else {
        const doc = JSON.parse(fs.readFileSync(input, "utf-8"));
        applyCommands(doc, commands);
        fs.writeFileSync(output, JSON.stringify(doc, null, 2));
      }
      return { code: 0, stdout: `Saved ${output}\n`, stderr: "" };
    }
    if (args.includes("--export")) {
      const output = args[args.indexOf("--export") + 1];
      fs.writeFileSync(output, Buffer.from("89626e67", "hex"));
      return { code: 0, stdout: `Export saved to: ${output}\n`, stderr: "" };
    }
    return { code: 1, stdout: "", stderr: `unexpected args: ${args.join(" ")}` };
  };
  return { exec, calls };
}

function makePenProject({ pen = PEN_SAMPLE, extraFiles = {} } = {}) {
  const dir = makeTempProject({ config: baseConfig() });
  const designDir = path.join(dir, ".artemis", "design");
  fs.mkdirSync(designDir, { recursive: true });
  fs.writeFileSync(path.join(designDir, "demo.pen"), pen, "utf-8");
  for (const [relative, content] of Object.entries(extraFiles)) {
    const absolute = path.join(dir, relative);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, content, "utf-8");
  }
  return dir;
}

function tokensFile() {
  return `${JSON.stringify(
    {
      color: {
        bg: {
          $type: "color",
          $value: "#FFFFFFFF",
          $extensions: { aos: { modes: { default: "#FFFFFFFF", "Mode=Dark": "#111111FF" }, usageCount: 2, samples: [] } }
        },
        "brand-primary": {
          $type: "color",
          $value: "{color.bg}",
          $extensions: { aos: { modes: { default: "{color.bg}" }, aliasOf: "color.bg", usageCount: 1, samples: [] } }
        }
      }
    },
    null,
    2
  )}\n`;
}

function stringsFile() {
  return `${JSON.stringify(
    {
      version: 1,
      sourceLocale: "zh",
      entries: [
        {
          key: "home.title",
          nodeId: "title",
          screen: "Home",
          layer: "Title",
          sourceText: "欢迎回来",
          canonicalText: "欢迎回来",
          sourceFingerprint: "sha256:x",
          placeholders: [],
          lifecycle: "active"
        },
        {
          key: "home.ghost",
          nodeId: "missing",
          screen: "Home",
          layer: "Ghost",
          sourceText: "不存在",
          canonicalText: "不存在",
          sourceFingerprint: "sha256:y",
          placeholders: [],
          lifecycle: "unused"
        }
      ]
    },
    null,
    2
  )}\n`;
}

const ensureReady = async () => ({ ok: true, source: "path", path: "pen", installed: false });

test("pen cli: 路径解析、status 解析与失败分类", async () => {
  assert.deepEqual(resolvePenCliPath({}, "darwin", { exists: () => false }), { path: "pen", source: "path" });
  assert.deepEqual(resolvePenCliPath({ AOS_PEN_CLI_PATH: "/opt/pen" }, "darwin"), { path: "/opt/pen", source: "env" });
  assert.deepEqual(resolvePenCliPath({}, "win32", { exists: () => false }), { path: "pen.cmd", source: "path" });
  const managedDir = path.resolve("/opt/managed");
  const managed = managedPenBinPath(managedDir, "darwin");
  assert.deepEqual(
    resolvePenCliPath({ AOS_PEN_CLI_DIR: "/opt/managed" }, "darwin", { exists: (candidate) => candidate === managed }),
    { path: managed, source: "managed" }
  );

  assert.deepEqual(penEnvFrom({ PEN_CLI_KEY: "dotenv-key" }, { PEN_CLI_KEY: "process-key" }), {
    PEN_CLI_KEY: "process-key"
  });
  assert.deepEqual(penEnvFrom({ PEN_CLI_KEY: "dotenv-key", ANTHROPIC_API_KEY: "a" }, {}), {
    PEN_CLI_KEY: "dotenv-key",
    ANTHROPIC_API_KEY: "a"
  });
  assert.deepEqual(penEnvFrom({}, {}, { PEN_AGENT_API_KEY: "derived" }), { PEN_AGENT_API_KEY: "derived" });
  assert.ok(!("AOS_LLM_API_KEY" in penEnvFrom({ AOS_LLM_API_KEY: "secret" }, {})));

  const { exec } = fakePen();
  const status = await penCliStatus(exec);
  assert.equal(status.installed, true);
  assert.equal(status.version, "0.3.9");
  assert.equal(status.authenticated, true);
  assert.equal(status.email, "dev@example.com");
  assert.equal(status.workspace, "Personal (dev)");

  const missing = await penCliStatus(async () => ({ code: null, stdout: "", stderr: "", error: "spawn pen ENOENT" }));
  assert.equal(missing.installed, false);
  assert.match(missing.error, /ENOENT/);
  assert.match(detectPenFailure({ code: null, stdout: "", stderr: "", error: "spawn pen ENOENT" }, ""), /未找到 pen CLI/);

  const loggedOut = await penCliStatus(async (command, args) =>
    args[0] === "version"
      ? { code: 0, stdout: "pen 0.3.9", stderr: "" }
      : { code: 1, stdout: "Not logged in. Run pen login.", stderr: "" }
  );
  assert.equal(loggedOut.authenticated, false);
  assert.match(detectPenFailure({ code: 1, stdout: "Not logged in", stderr: "" }, "Not logged in"), /凭证/);
  assert.match(
    detectPenFailure({ code: 0, stdout: "[ERROR] Failed to execute", stderr: "" }, "[ERROR] Failed to execute"),
    /操作失败/
  );
  assert.match(detectPenFailure({ code: null, stdout: "", stderr: "", error: "timeout" }, ""), /超时/);

  const captured = [];
  await runPenInteractive({
    input: "/tmp/in.pen",
    output: "/tmp/out.pen",
    commands: ["get_app_state()"],
    cliPath: "pen",
    exec: async (command, args, options) => {
      captured.push({ command, args, input: options.input });
      return { code: 0, stdout: "", stderr: "" };
    }
  });
  assert.equal(captured[0].command, "pen");
  assert.deepEqual(captured[0].args, ["interactive", "-i", "/tmp/in.pen", "-o", "/tmp/out.pen"]);
  assert.equal(captured[0].input, "get_app_state()\nsave()\nexit()\n");
});

test("pen_export: dryRun 与导出落盘", async () => {
  const dir = makePenProject();
  const { runtime } = await loadTestRuntime(dir, { proxy: new StubProxy() });
  const { exec, calls } = fakePen();

  const preview = parseToolResult(await penExport(runtime, { dryRun: true }, { exec }));
  assert.equal(preview.dryRun, true);
  assert.deepEqual(preview.command.slice(0, 2), ["pen", "--in"]);
  assert.equal(calls.length, 0);

  const payload = parseToolResult(await penExport(runtime, { format: "png", scale: 2 }, { exec, ensure: ensureReady }));
  assert.equal(payload.ok, true);
  assert.equal(payload.output, path.join(".artemis", "design", "pen", "demo.png"));
  assert.equal(payload.bytes, 4);
  assert.ok(fs.existsSync(path.join(dir, ".artemis", "design", "pen", "demo.png")));
  assert.deepEqual(calls[0].args.slice(0, 4), ["--in", path.join(dir, ".artemis", "design", "demo.pen"), "--export", path.join(dir, ".artemis", "design", "pen", "demo.png")]);

  const failing = fakePen({ onInteractive: undefined });
  failing.exec = async () => ({ code: 1, stdout: "", stderr: "not authenticated" });
  const failed = await penExport(runtime, { out: "render.png" }, { exec: failing.exec, ensure: ensureReady });
  assert.equal(failed.isError, true);
  assert.match(parseToolResult(failed).error, /未登录/);
  assert.ok(!fs.existsSync(path.join(dir, "render.png")));
});

test("pen_apply_tokens: 原位写回 modes/别名、校验失败不动原文件、dryRun", async () => {
  const dir = makePenProject({ extraFiles: { ".artemis/design/tokens.json": tokensFile() } });
  const { runtime } = await loadTestRuntime(dir, { proxy: new StubProxy() });
  const penPath = path.join(dir, ".artemis", "design", "demo.pen");
  const { exec } = fakePen();

  const preview = parseToolResult(await penApplyTokens(runtime, { dryRun: true }, { exec }));
  assert.equal(preview.dryRun, true);
  assert.equal(preview.variables, 1);
  assert.deepEqual(preview.tokenNames, ["color.bg"]);
  assert.deepEqual(preview.skippedAliases, ["color.brand-primary"]);
  assert.match(preview.command, /SetVariables/);

  const payload = parseToolResult(await penApplyTokens(runtime, {}, { exec, ensure: ensureReady }));
  assert.equal(payload.ok, true, JSON.stringify(payload));
  assert.equal(payload.inPlace, true);
  assert.equal(payload.variables, 1);

  const doc = JSON.parse(fs.readFileSync(penPath, "utf-8"));
  assert.deepEqual(doc.variables["color.bg"].value, [
    { value: "#FFFFFFFF" },
    { value: "#111111FF", theme: { Mode: "Dark" } }
  ]);
  assert.ok(!fs.readdirSync(path.join(dir, ".artemis", "design")).some((name) => name.includes(".tmp")));

  fs.writeFileSync(penPath, PEN_SAMPLE, "utf-8");
  const rollback = fakePen({
    onInteractive: ({ input, output }) => fs.copyFileSync(input, output)
  });
  const before = fs.readFileSync(penPath, "utf-8");
  const failed = await penApplyTokens(runtime, {}, { exec: rollback.exec, ensure: ensureReady });
  assert.equal(failed.isError, true);
  assert.match(parseToolResult(failed).error, /校验失败/);
  assert.equal(fs.readFileSync(penPath, "utf-8"), before);
  assert.ok(!fs.readdirSync(path.join(dir, ".artemis", "design")).some((name) => name.includes(".tmp")));

  const missing = await penApplyTokens(runtime, { tokensPath: "nope.json" }, { exec });
  assert.equal(missing.isError, true);
});

test("pen_apply_strings: 写回、notFound、校验失败不动原文件", async () => {
  const dir = makePenProject({ extraFiles: { ".artemis/design/strings.json": stringsFile() } });
  const { runtime } = await loadTestRuntime(dir, { proxy: new StubProxy() });
  const penPath = path.join(dir, ".artemis", "design", "demo.pen");
  const { exec } = fakePen();

  const preview = parseToolResult(await penApplyStrings(runtime, { dryRun: true }, { exec }));
  assert.equal(preview.dryRun, true);
  assert.equal(preview.entries, 1);
  assert.deepEqual(preview.notFound, ["home.ghost"]);
  assert.equal(preview.commandCount, 1);

  const payload = parseToolResult(await penApplyStrings(runtime, {}, { exec, ensure: ensureReady }));
  assert.equal(payload.ok, true, JSON.stringify(payload));
  assert.equal(payload.inPlace, true);
  const doc = JSON.parse(fs.readFileSync(penPath, "utf-8"));
  assert.equal(doc.children[0].children[0].content, "欢迎回来");

  fs.writeFileSync(penPath, PEN_SAMPLE, "utf-8");
  const rollback = fakePen({
    onInteractive: ({ input, output }) => fs.copyFileSync(input, output)
  });
  const before = fs.readFileSync(penPath, "utf-8");
  const failed = await penApplyStrings(runtime, {}, { exec: rollback.exec, ensure: ensureReady });
  assert.equal(failed.isError, true);
  assert.match(parseToolResult(failed).error, /校验失败/);
  assert.equal(fs.readFileSync(penPath, "utf-8"), before);
});

test("pen_agent: 复用 active LLM key、DeepSeek 端点映射、原位更新与失败清理", async () => {
  const dir = makeTempProject({
    config: baseConfig(),
    dotenv:
      "AOS_LLM_API_KEY=sk-test-agent\nAOS_LLM_BASE_URL=https://api.deepseek.com/v1\nAOS_LLM_MODEL=deepseek-flash\nAOS_LLM_NAME=deepseek\nPEN_CLI_KEY=pen-test-key\n"
  });
  const designDir = path.join(dir, ".artemis", "design");
  fs.mkdirSync(designDir, { recursive: true });
  const penPath = path.join(designDir, "demo.pen");
  fs.writeFileSync(penPath, PEN_SAMPLE, "utf-8");
  const { runtime } = await loadTestRuntime(dir, { proxy: new StubProxy() });
  const { exec, calls } = fakePen();
  const ensureCalls = [];
  const ensure = async (options) => {
    ensureCalls.push(options);
    return { ok: true, source: "path", path: "pen", installed: false };
  };

  const preview = parseToolResult(await penAgent(runtime, { prompt: "add a node", dryRun: true }, { exec, ensure }));
  assert.equal(preview.dryRun, true);
  assert.equal(preview.anthropicBaseUrl, "https://api.deepseek.com/anthropic");
  assert.deepEqual(preview.command.slice(0, 1), ["pen"]);
  assert.equal(calls.length, 0);
  assert.equal(ensureCalls.length, 0, "dryRun 不应触发 ensure/安装");

  const payload = parseToolResult(await penAgent(runtime, { prompt: "add a node" }, { exec, ensure }));
  assert.equal(payload.ok, true, JSON.stringify(payload));
  assert.equal(payload.inPlace, true);
  assert.equal(calls[0].env.PEN_AGENT_API_KEY, "sk-test-agent");
  assert.equal(calls[0].env.ANTHROPIC_BASE_URL, "https://api.deepseek.com/anthropic");
  assert.equal(calls[0].env.PEN_CLI_KEY, "pen-test-key");
  assert.equal(ensureCalls[0].env.PEN_CLI_KEY, "pen-test-key");
  assert.equal(payload.agentResponse, "Done: added Agent.");
  assert.ok(!JSON.stringify(payload).includes("sk-test-agent"), "key must not leak into tool output");
  assert.ok(!JSON.stringify(payload).includes("pen-test-key"), "PEN_CLI_KEY 不得泄露");
  const doc = JSON.parse(fs.readFileSync(penPath, "utf-8"));
  assert.ok(doc.children.some((child) => child.name === "Agent"));
  assert.ok(!fs.readdirSync(designDir).some((name) => name.includes(".tmp")));

  fs.writeFileSync(penPath, PEN_SAMPLE, "utf-8");
  const failing = fakePen({
    onAgent: () => ({ code: 1, stdout: "", stderr: "Agent failed: authentication_failed" })
  });
  const failed = await penAgent(runtime, { prompt: "add a node" }, { exec: failing.exec, ensure });
  assert.equal(failed.isError, true);
  assert.match(parseToolResult(failed).error, /凭证/);
  assert.equal(fs.readFileSync(penPath, "utf-8"), PEN_SAMPLE);
  assert.ok(!fs.readdirSync(designDir).some((name) => name.includes(".tmp")));
});

test("pen_agent: 端点映射/响应提取单元；out 新建与无输入报错", async () => {
  assert.equal(anthropicBaseUrlFor("https://api.deepseek.com/v1"), "https://api.deepseek.com/anthropic");
  assert.equal(anthropicBaseUrlFor("https://api.deepseek.com"), "https://api.deepseek.com/anthropic");
  assert.equal(anthropicBaseUrlFor("https://api.deepseek.com/anthropic"), "https://api.deepseek.com/anthropic");
  assert.equal(anthropicBaseUrlFor("https://api.moonshot.cn/v1"), "https://api.moonshot.cn/anthropic");
  assert.equal(anthropicBaseUrlFor("https://api.example.com/v1"), null);
  assert.equal(anthropicBaseUrlFor(null), null);
  assert.equal(extractAgentResponse("x\n--- Agent Response ---\nHi\n----------------------\n"), "Hi");
  assert.equal(extractAgentResponse("no marker"), null);

  const dir = makeTempProject({
    config: baseConfig(),
    dotenv: "AOS_LLM_API_KEY=sk-test-agent\nAOS_LLM_BASE_URL=https://api.deepseek.com/v1\nAOS_LLM_MODEL=deepseek-flash\n"
  });
  fs.mkdirSync(path.join(dir, ".artemis", "design"), { recursive: true });
  const { runtime } = await loadTestRuntime(dir, { proxy: new StubProxy() });
  const { exec } = fakePen();

  const noTarget = await penAgent(runtime, { prompt: "make a page" }, { exec });
  assert.equal(noTarget.isError, true);

  const payload = parseToolResult(await penAgent(runtime, { out: "new.pen", prompt: "make a page" }, { exec, ensure: ensureReady }));
  assert.equal(payload.ok, true, JSON.stringify(payload));
  assert.equal(payload.source, null);
  assert.equal(payload.inPlace, false);
  assert.equal(payload.output, "new.pen");
  assert.ok(fs.existsSync(path.join(dir, "new.pen")));
});

test("pen_agent: provider 桥接表（Kimi/Z.AI/百炼 Bearer + 模型映射；未知 provider 告警）", () => {
  const kimi = buildAgentEnv(
    { apiKey: "k", model: "kimi-k3[1m]", baseUrl: "https://api.moonshot.cn/v1" },
    { prompt: "p" },
    "claude"
  );
  assert.equal(kimi.env.ANTHROPIC_BASE_URL, "https://api.moonshot.cn/anthropic");
  assert.equal(kimi.env.ANTHROPIC_AUTH_TOKEN, "k");
  assert.ok(!("PEN_AGENT_API_KEY" in kimi.env));
  assert.equal(kimi.env.ANTHROPIC_MODEL, "kimi-k3[1m]");
  assert.equal(kimi.env.ANTHROPIC_DEFAULT_HAIKU_MODEL, "kimi-k3[1m]");
  assert.equal(kimi.credential.provider, "moonshot");
  assert.equal(kimi.credential.verified, false);
  assert.equal(kimi.warnings.length, 1);

  const zai = buildAgentEnv(
    { apiKey: "z", model: "glm-4.7", baseUrl: "https://open.bigmodel.cn/api/paas/v4" },
    { prompt: "p" },
    "claude"
  );
  assert.equal(zai.env.ANTHROPIC_BASE_URL, "https://open.bigmodel.cn/api/anthropic");
  assert.equal(zai.env.ANTHROPIC_AUTH_TOKEN, "z");

  const qwen = buildAgentEnv(
    { apiKey: "q", model: "qwen3.7-plus", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1" },
    { prompt: "p" },
    "claude"
  );
  assert.equal(qwen.env.ANTHROPIC_BASE_URL, "https://dashscope.aliyuncs.com/apps/anthropic");
  assert.equal(qwen.env.ANTHROPIC_AUTH_TOKEN, "q");

  const unknown = buildAgentEnv(
    { apiKey: "u", model: "m", baseUrl: "https://api.example.com/v1" },
    { prompt: "p" },
    "claude"
  );
  assert.equal(unknown.env.PEN_AGENT_API_KEY, "u");
  assert.ok(!("ANTHROPIC_BASE_URL" in unknown.env));
  assert.match(unknown.warnings[0], /anthropicBaseUrl/);

  const override = buildAgentEnv(
    { apiKey: "u", model: "m", baseUrl: "https://api.example.com/v1" },
    { prompt: "p", anthropicBaseUrl: "https://proxy.example.com/anthropic" },
    "claude"
  );
  assert.equal(override.env.ANTHROPIC_BASE_URL, "https://proxy.example.com/anthropic");
  assert.equal(override.env.PEN_AGENT_API_KEY, "u");

  const gemini = buildAgentEnv(
    { apiKey: "g", model: "gemini-3.7-flash", baseUrl: "https://api.deepseek.com/v1" },
    { prompt: "p" },
    "gemini"
  );
  assert.equal(gemini.env.PEN_AGENT_API_KEY, "g");
  assert.ok(!("ANTHROPIC_BASE_URL" in gemini.env));

  assert.equal(anthropicBridgeFor("https://api.z.ai/api/paas/v4").anthropicBaseUrl, "https://api.z.ai/api/anthropic");
  assert.equal(anthropicBridgeFor("https://api.example.com/v1"), null);
});
