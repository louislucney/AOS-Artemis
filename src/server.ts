import path from "node:path";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

import { loadProject } from "./config/loader.js";
import { configDirAbs } from "./artemis/assembly.js";
import { traceIdOf } from "./artemis/task-result.js";
import { isIosTraceId } from "./ios/trace-store.js";
import { resolveDepsSource } from "./artemis/bootstrap.js";
import { configureLogging, installCrashHandlers } from "./log.js";
import { startBridge } from "./figma/bridge.js";
import { figmaTools, handleFigmaTool, isFigmaTool } from "./figma/registry.js";
import { Runtime } from "./runtime.js";
import { RuntimeHost } from "./runtime-host.js";
import { usageEventInputFrom } from "./usage/capture.js";
import { AOS_MCP_VERSION, errorMessage, log } from "./util.js";
import { NativeToolDefinition } from "./tools/native-tools/types.js";
import { AOS_NATIVE_TOOLS } from "./tools/native-tools/aos.js";
import { DESIGN_NATIVE_TOOLS } from "./tools/native-tools/design.js";
import { FIGMA_NATIVE_TOOLS } from "./tools/native-tools/figma.js";
import { JIRA_NATIVE_TOOLS } from "./tools/native-tools/jira.js";
import { LLM_NATIVE_TOOLS } from "./tools/native-tools/llm.js";
import { PEN_NATIVE_TOOLS } from "./tools/native-tools/pen.js";

const NATIVE_TOOLS: NativeToolDefinition[] = [
  ...LLM_NATIVE_TOOLS,
  ...AOS_NATIVE_TOOLS,
  ...JIRA_NATIVE_TOOLS,
  ...DESIGN_NATIVE_TOOLS,
  ...FIGMA_NATIVE_TOOLS,
  ...PEN_NATIVE_TOOLS
];

function errorResult(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

export function inProcessToolCatalog(): string[] {
  const names = new Set(NATIVE_TOOLS.map((tool) => tool.name));
  for (const tool of figmaTools()) names.add(tool.name);
  return [...names].sort();
}

function resultErrorSummary(result: CallToolResult): string {
  for (const item of result.content ?? []) {
    if (item.type === "text" && typeof item.text === "string") {
      return item.text.replace(/\s+/g, " ").slice(0, 160);
    }
  }
  return "unknown error";
}

function stripSchemaMeta(schema: unknown): unknown {
  if (schema && typeof schema === "object") {
    const { $schema: _ignored, ...rest } = schema as Record<string, unknown>;
    return rest;
  }
  return schema;
}

/** zod→JSON schema 转换结果缓存（NATIVE_TOOLS 为模块级静态表，DESIGN §13.87）。 */
const nativeSchemaCache = new Map<string, unknown>();

function nativeToolSchema(tool: NativeToolDefinition): unknown {
  const cached = nativeSchemaCache.get(tool.name);
  if (cached !== undefined) return cached;
  const converted = stripSchemaMeta(
    zodToJsonSchema(tool.schema, { target: "jsonSchema7", $refStrategy: "none" })
  );
  nativeSchemaCache.set(tool.name, converted);
  return converted;
}

function nativeToolsForList(): Array<{ name: string; description: string; inputSchema: unknown }> {
  return NATIVE_TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: nativeToolSchema(tool)
  }));
}

/** Figma 工具 schema 转换同样缓存（tools 表为静态清查）。 */
const figmaSchemaCache = new Map<string, unknown>();

function figmaToolSchema(name: string, schema: z.ZodTypeAny): unknown {
  const cached = figmaSchemaCache.get(name);
  if (cached !== undefined) return cached;
  const converted = stripSchemaMeta(
    zodToJsonSchema(schema, { target: "jsonSchema7", $refStrategy: "none" })
  );
  figmaSchemaCache.set(name, converted);
  return converted;
}

/** Build a fully wired MCP Server for one project runtime (stdio or HTTP). */
export function createServerForRuntime(runtime: Runtime | null, initError: string | null): Server {
  const server = new Server(
    { name: "aos-mcp", version: AOS_MCP_VERSION },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools: Array<{ name: string; description: string; inputSchema: unknown }> =
      nativeToolsForList();

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
        inputSchema: figmaToolSchema(tool.name, tool.schema)
      });
    }
    return { tools };
  });

  const handleCall = async (request: {
    params: { name: string; arguments?: Record<string, unknown> };
  }): Promise<CallToolResult> => {
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
      // Retired-model gate: never let artemis fail mid-task on model_not_found.
      const preflight = await runtime.ensureActiveModelUsable();
      if (!preflight.ok) {
        return errorResult(JSON.stringify(preflight.payload, null, 2));
      }
      for (const warning of preflight.warnings) log(`mobile_run_task 预检: ${warning}`, "warn");
    }

    try {
      const result = await runtime.proxy.callTool(name, (args ?? {}) as Record<string, unknown>);
      if (name === "mobile_run_task") {
        const taskArgs = (args ?? {}) as Record<string, unknown>;
        // iOS runs record their own task row inside maybeIosRunTask.
        if (!isIosTraceId(traceIdOf(result))) {
          void runtime.recordTaskResult({
            isError: result.isError === true,
            traceId: traceIdOf(result),
            model: typeof taskArgs.model === "string" ? taskArgs.model : null,
            taskDesc: typeof taskArgs.task_desc === "string" ? taskArgs.task_desc : null,
            lockedAppPackage:
              typeof taskArgs.locked_app_package === "string" ? taskArgs.locked_app_package : null
          });
        }
      }
      return result;
    } catch (error) {
      return errorResult(`工具 "${name}" 执行失败: ${errorMessage(error)}`);
    }
  };

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const started = Date.now();
    const name = request.params.name;
    let result: CallToolResult;
    try {
      result = await handleCall(
        request as { params: { name: string; arguments?: Record<string, unknown> } }
      );
    } catch (error) {
      result = errorResult(`工具 "${name}" 执行失败: ${errorMessage(error)}`);
    }
    const durationMs = Date.now() - started;
    let usageId: string | null = null;
    if (runtime && name !== "aos_usage") {
      try {
        const event = await runtime.recordUsage(
          usageEventInputFrom(name, request.params.arguments ?? {}, result, durationMs)
        );
        usageId = event?.id ?? null;
      } catch (error) {
        log(`使用统计记录失败: ${errorMessage(error)}`, "warn");
      }
    }
    const ok = result.isError !== true;
    const detail = ok ? "" : ` error=${resultErrorSummary(result)}`;
    const usage = usageId === null ? "" : ` usage=${usageId}`;
    log(`tool=${name} ok=${ok} ms=${durationMs}${usage}${detail}`, ok ? "info" : "warn");
    return result;
  });

  return server;
}

export async function runServer(): Promise<void> {
  let runtime: Runtime | null = null;
  let initError: string | null = null;
  let host: RuntimeHost | null = null;

  try {
    const project = loadProject();
    // 日志引导 + 依赖检查 + 存储 + Runtime 创建经共享宿主（DESIGN §13.90）。
    host = await RuntimeHost.prepare({
      logDir:
        process.env.AOS_LOG_DIR?.trim() ||
        path.join(configDirAbs(project.config, project.rootDir), "logs"),
      startupLine: `aos-mcp ${AOS_MCP_VERSION} 启动（stdio）项目=${project.rootDir}`,
      deps: {
        repoDir: project.config.artemis.repo,
        source: resolveDepsSource(project.config)
      }
    });
    runtime = await host.createRuntime(project, {
      registerLine: (created) =>
        `项目已注册: ${project.rootDir}` +
        (created.activeEntryCached()
          ? `，active LLM: ${created.activeEntryCached()!.name}`
          : "，未配置 LLM（setup_required）")
    });
  } catch (error) {
    initError = errorMessage(error);
    if (!host) {
      configureLogging({
        logDir:
          process.env.AOS_LOG_DIR?.trim() || path.join(process.cwd(), ".aos-mcp", "logs")
      });
      installCrashHandlers();
    }
    log(`初始化失败: ${initError}`, "error");
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
    await host?.shutdown();
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
