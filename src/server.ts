import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

import { loadProject } from "./config/loader.js";
import { ensureArtemisDeps, resolveDepsSource } from "./artemis/bootstrap.js";
import { createProjectStore } from "./db/index.js";
import { startBridge, stopBridge } from "./figma/bridge.js";
import { figmaTools, handleFigmaTool, isFigmaTool } from "./figma/registry.js";
import { syncFigmaTokenEnv } from "./figma/token.js";
import { Runtime, sweepStaleChild } from "./runtime.js";
import { compareDesignAndDevice, type CompareArgs } from "./tools/composite.js";
import { aosConfigure, type ConfigureArgs } from "./tools/configure.js";
import {
  aosStatus,
  aosTasks,
  llmList,
  llmSwitch,
  type AosTasksArgs,
  type LlmSwitchArgs
} from "./tools/llm.js";
import { AOS_MCP_VERSION, errorMessage, log } from "./util.js";

interface NativeToolDefinition {
  name: string;
  description: string;
  schema: z.ZodTypeAny;
  handler: (
    runtime: Runtime,
    args: Record<string, unknown>
  ) => Promise<CallToolResult> | CallToolResult;
}

const NATIVE_TOOLS: NativeToolDefinition[] = [
  {
    name: "llm_list",
    description:
      "识别当前项目的全部 LLM 条目（.env 导入 / PostgreSQL / 高级配置）+ 当前激活项；key 只返回 masked 预览。",
    schema: z.object({}),
    handler: (runtime) => llmList(runtime)
  },
  {
    name: "llm_switch",
    description:
      "切换项目激活的 LLM 条目。模型变更对下一个 mobile_run_task 生效；key/base_url 变更会重启 artemis 网关子进程（运行中任务不受影响）。",
    schema: z.object({
      name: z.string().min(1).describe("要激活的条目名（见 llm_list）"),
      force: z.boolean().optional().describe("跳过运行中任务守卫并强制重启网关子进程，默认 false")
    }),
    handler: (runtime, args) => llmSwitch(runtime, args as unknown as LlmSwitchArgs)
  },
  {
    name: "aos_configure",
    description:
      "为当前项目配置 LLM（OpenAI 兼容：model + baseUrl + apiKey）：写入 PostgreSQL 与项目 .env，并可选设为 active。用于 setup_required 引导场景。",
    schema: z.object({
      model: z.string().min(1).describe("模型名，如 deepseek-flash"),
      baseUrl: z.string().min(1).describe("OpenAI 兼容端点，如 https://api.deepseek.com/v1"),
      apiKey: z.string().min(1).describe("该项目的 LLM key（费用支付方）"),
      name: z.string().optional().describe("条目名（默认取 model）"),
      makeActive: z.boolean().optional().describe("配置后立即设为 active，默认 true"),
      writeEnv: z.boolean().optional().describe("是否回写项目 .env，默认 true"),
      force: z.boolean().optional().describe("激活时跳过运行中任务守卫，默认 false"),
      figmaToken: z.string().optional().describe("可选的 Figma token（写入项目 .env / 存储）")
    }),
    handler: (runtime, args) => aosConfigure(runtime, args as unknown as ConfigureArgs)
  },
  {
    name: "aos_status",
    description:
      "AOS MCP 运行状态：项目注册信息、存储（PostgreSQL/降级内存）、active LLM、artemis 子进程（pid/重启数/stderr 尾部）、Figma 桥/就绪性、setup 状态。",
    schema: z.object({}),
    handler: (runtime) => aosStatus(runtime)
  },
  {
    name: "aos_tasks",
    description:
      "任务/调用统计：列出本项目的 mobile_run_task 记录（trace/状态/模型/耗时），可选先与 artemis 同步完成态。",
    schema: z.object({
      limit: z.number().int().positive().max(100).optional().describe("返回条数，默认 20"),
      sync: z.boolean().optional().describe("是否先同步任务完成态，默认 true")
    }),
    handler: (runtime, args) => aosTasks(runtime, args as unknown as AosTasksArgs)
  },
  {
    name: "compare_design_and_device",
    description:
      "组合工具：拉取 Figma 节点的渲染图（PNG@2x，REST）与当前真机截图，一并返回两张图片，供多模态模型比对布局/间距/颜色/文案。",
    schema: z.object({
      figmaUrl: z.string().min(1).describe("Figma URL（建议带 ?node-id=）"),
      nodeId: z.string().optional().describe("覆盖 URL 中的 node-id"),
      deviceSerial: z.string().optional().describe("目标设备 serial（默认自动选择）")
    }),
    handler: (runtime, args) => compareDesignAndDevice(runtime, args as unknown as CompareArgs)
  }
];

function errorResult(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

function stripSchemaMeta(schema: unknown): unknown {
  if (schema && typeof schema === "object") {
    const { $schema: _ignored, ...rest } = schema as Record<string, unknown>;
    return rest;
  }
  return schema;
}

function extractTraceId(result: CallToolResult): string | null {
  const structured = (result as { structuredContent?: unknown }).structuredContent;
  const candidates: unknown[] = [structured];
  for (const item of result.content ?? []) {
    if (item.type === "text") {
      try {
        candidates.push(JSON.parse(item.text));
      } catch {
        const match = /trace[_ -]?id["'\s:=]+([0-9a-fA-F-]{8,})/.exec(item.text);
        if (match) return match[1]!;
      }
    }
  }
  for (const candidate of candidates) {
    if (candidate && typeof candidate === "object") {
      const value = (candidate as { trace_id?: unknown }).trace_id;
      if (typeof value === "string" && value.length > 0) return value;
    }
  }
  return null;
}

/** Build a fully wired MCP Server for one project runtime (stdio or HTTP). */
export function createServerForRuntime(runtime: Runtime | null, initError: string | null): Server {
  const server = new Server(
    { name: "aos-mcp", version: AOS_MCP_VERSION },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools: Array<{ name: string; description: string; inputSchema: unknown }> = NATIVE_TOOLS.map(
      (tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: stripSchemaMeta(
          zodToJsonSchema(tool.schema, { target: "jsonSchema7", $refStrategy: "none" })
        )
      })
    );

    if (runtime) {
      try {
        const proxied = await runtime.proxy.listTools();
        for (const tool of proxied) {
          // Passthrough: artemis schemas are forwarded verbatim (no zod mirroring).
          tools.push({
            name: tool.name,
            description: tool.description ?? "",
            inputSchema: tool.inputSchema
          });
        }
      } catch (error) {
        log(`mobile 工具不可用（artemis 子进程未就绪）: ${errorMessage(error)}`);
      }
    }

    // Figma tools (vendored design-context-bridge surface, zod-validated).
    for (const tool of figmaTools()) {
      tools.push({
        name: tool.name,
        description: tool.description,
        inputSchema: stripSchemaMeta(
          zodToJsonSchema(tool.schema, { target: "jsonSchema7", $refStrategy: "none" })
        )
      });
    }
    return { tools };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const native = NATIVE_TOOLS.find((tool) => tool.name === name);

    if (native) {
      if (!runtime) {
        return errorResult(`AOS 项目初始化失败：${initError ?? "未知错误"}\nRun: aos-mcp doctor`);
      }
      const parsed = native.schema.safeParse(args ?? {});
      if (!parsed.success) {
        return errorResult(`参数校验失败: ${parsed.error.message}`);
      }
      return await native.handler(runtime, parsed.data as Record<string, unknown>);
    }

    // Figma tools work independent of the artemis runtime (plugin mode needs
    // only the bridge; REST mode needs FIGMA_ACCESS_TOKEN, synced at startup).
    if (isFigmaTool(name)) {
      try {
        return await handleFigmaTool(name, (args ?? {}) as Record<string, unknown>);
      } catch (error) {
        return errorResult(`Figma 工具 "${name}" 执行失败: ${errorMessage(error)}`);
      }
    }

    if (!runtime) {
      return errorResult(`AOS 项目初始化失败：${initError ?? "未知错误"}\nRun: aos-mcp doctor`);
    }

    // setup_required gate: mobile_run_task needs a project LLM; other mobile tools pass.
    if (name === "mobile_run_task") {
      const setup = await runtime.setupInfo();
      if (setup.required) {
        return errorResult(JSON.stringify({ ok: false, setup_required: true, ...setup }, null, 2));
      }
    }

    try {
      const result = await runtime.proxy.callTool(name, (args ?? {}) as Record<string, unknown>);
      if (name === "mobile_run_task" && result.isError !== true) {
        const traceId = extractTraceId(result);
        const taskArgs = (args ?? {}) as Record<string, unknown>;
        void runtime.recordTaskSubmission({
          traceId: traceId ?? "unknown",
          model: typeof taskArgs.model === "string" ? taskArgs.model : null,
          profile: typeof taskArgs.model === "string" ? taskArgs.model : null,
          taskDesc: typeof taskArgs.task_desc === "string" ? taskArgs.task_desc : null
        });
      }
      return result;
    } catch (error) {
      return errorResult(`工具 "${name}" 执行失败: ${errorMessage(error)}`);
    }
  });

  return server;
}

export async function runServer(): Promise<void> {
  let runtime: Runtime | null = null;
  let initError: string | null = null;

  try {
    const project = loadProject();
    // First-run/update bootstrap: installs or refreshes artemis deps when the
    // venv is missing, unmanaged, or stale against uv.lock (no-op when ready).
    const deps = await ensureArtemisDeps({
      repoDir: project.config.artemis.repo,
      source: resolveDepsSource(project.config),
      log
    });
    if (deps.status !== "ready") {
      log(`依赖状态: ${deps.status} — ${deps.message.split("\n")[0]}`);
    }
    const { store, degraded, reason } = await createProjectStore();
    runtime = new Runtime(project, { store, storeNote: reason });
    await runtime.initialize();
    if (degraded && reason) log(reason);
    log(
      `项目已注册: ${project.rootDir}` +
        (runtime.activeEntryCached()
          ? `，active LLM: ${runtime.activeEntryCached()!.name}`
          : "，未配置 LLM（setup_required）")
    );
  } catch (error) {
    initError = errorMessage(error);
    log(`初始化失败: ${initError}`);
  }

  if (runtime) {
    try {
      const swept = await sweepStaleChild(runtime);
      if (swept) log(swept);
    } catch (error) {
      log(`孤儿清理检查失败: ${errorMessage(error)}`);
    }
    try {
      const figmaToken = await runtime.figmaTokenInfo();
      syncFigmaTokenEnv(figmaToken.value);
    } catch (error) {
      log(`Figma token 同步失败: ${errorMessage(error)}`);
    }
  }

  try {
    const bridge = await startBridge();
    log(bridge.message || `Figma bridge: ${bridge.status}`);
  } catch (error) {
    log(`Figma 桥启动失败: ${errorMessage(error)}`);
  }

  const server = createServerForRuntime(runtime, initError);

  let shuttingDown = false;
  const shutdown = async (code: number): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      await runtime?.proxy.dispose();
    } catch {
      /* best effort */
    }
    try {
      await runtime?.store.close();
    } catch {
      /* best effort */
    }
    try {
      await stopBridge();
    } catch {
      /* best effort */
    }
    process.exit(code);
  };

  const transport = new StdioServerTransport();
  await server.connect(transport);
  server.onclose = () => {
    void shutdown(0);
  };
  process.once("SIGTERM", () => void shutdown(0));
  process.once("SIGINT", () => void shutdown(0));
  process.on("exit", () => {
    runtime?.proxy.disposeSync();
  });
  process.stdin.on("end", () => void shutdown(0));

  log(`aos-mcp ${AOS_MCP_VERSION} 已启动（stdio）`);
}
