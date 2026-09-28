import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { loadProject } from "../dist/config/loader.js";
import { Runtime } from "../dist/runtime.js";

export function makeTempProject({ config, dotenv = "", configFileName = "aos.config.jsonc" } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aos-mcp-test-"));
  if (config !== undefined) {
    const content = typeof config === "string" ? config : JSON.stringify(config, null, 2);
    fs.writeFileSync(path.join(dir, configFileName), content, "utf-8");
  }
  if (dotenv) fs.writeFileSync(path.join(dir, ".env"), dotenv, "utf-8");
  return dir;
}

export function deepMerge(base, patch) {
  if (!patch || typeof patch !== "object") return base;
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      base?.[key] &&
      typeof base[key] === "object"
    ) {
      out[key] = deepMerge(base[key], value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/** Advanced-layer config (optional in v0.3; used to exercise the config entry source). */
export function baseConfig(overrides = {}) {
  const config = {
    llm: {
      profiles: {
        gemini: { provider: "google", model: "gemini-2.5-flash" },
        deepseek: {
          provider: "custom",
          model: "deepseek-chat",
          baseUrl: "https://api.deepseek.com/v1",
          apiKeyEnv: "DEEPSEEK_API_KEY"
        }
      }
    },
    artemis: { repo: "../artemis", mode: "standalone" }
  };
  return deepMerge(config, overrides);
}

export function deepseekWithOverrides() {
  return baseConfig({
    llm: {
      profiles: {
        deepseek: {
          nodeOverrides: {
            object_detector: { provider: "custom", model: "deepseek-chat" },
            hopper: { provider: "custom", model: "deepseek-chat" }
          }
        }
      }
    }
  });
}

export class StubProxy {
  constructor({
    running = false,
    tasks = { active: [], queued: [] },
    diagnoseThrows = false,
    taskStatus = "running"
  } = {}) {
    this.running = running;
    this.tasks = tasks;
    this.diagnoseThrows = diagnoseThrows;
    this.taskStatus = taskStatus;
    this.restartCalls = 0;
    this.disposeCalls = 0;
    this.calls = [];
  }

  isRunning() {
    return this.running;
  }

  async ensureStarted() {
    this.running = true;
  }

  async listTools() {
    return [
      {
        name: "mobile_diagnose",
        description: "fake",
        inputSchema: { type: "object", properties: {} }
      }
    ];
  }

  async callTool(name, args) {
    this.calls.push({ name, args });
    if (name === "mobile_diagnose") {
      if (this.diagnoseThrows) throw new Error("child unavailable");
      return {
        content: [{ type: "text", text: JSON.stringify({ verdict: "ready", tasks: this.tasks }) }]
      };
    }
    if (name === "mobile_manage_task") {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ status: this.taskStatus, trace_id: args?.trace_id })
          }
        ]
      };
    }
    return { content: [{ type: "text", text: JSON.stringify({ echo: name }) }] };
  }

  status() {
    return {
      running: this.running,
      pid: this.running ? 123 : null,
      restarts: 0,
      lastError: null,
      stderrTail: []
    };
  }

  async markForRestart() {
    this.restartCalls += 1;
    this.running = false;
  }

  async dispose() {
    this.disposeCalls += 1;
    this.running = false;
  }

  disposeSync() {
    this.running = false;
  }
}

export async function loadTestRuntime(dir, { proxy, env = {}, store } = {}) {
  const project = loadProject({ cwd: dir, env });
  const runtime = new Runtime(project, { proxy, store });
  await runtime.initialize();
  return { project, runtime };
}

export function parseToolResult(result) {
  return JSON.parse(result.content[0].text);
}
