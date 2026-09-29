import path from "node:path";

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
import { configDirAbs } from "./artemis/assembly.js";
import { ensureArtemisDeps, resolveDepsSource } from "./artemis/bootstrap.js";
import { createProjectStore } from "./db/index.js";
import { configureLogging, installCrashHandlers } from "./log.js";
import { startBridge, stopBridge } from "./figma/bridge.js";
import { figmaTools, handleFigmaTool, isFigmaTool } from "./figma/registry.js";
import {
  figmaExtractFlows,
  figmaGapAnalysis,
  type ExtractFlowsArgs,
  type GapAnalysisArgs
} from "./figma/flows.js";
import { figmaGenerateTests, type GenerateTestsArgs } from "./figma/test-gen.js";
import { figmaImportAssets, type ImportAssetsArgs } from "./figma/import.js";
import { figmaImportStrings, type ImportStringsArgs } from "./figma/import-strings.js";
import { figmaImportTokens, type ImportTokensArgs } from "./figma/import-tokens.js";
import { figmaExportBrief, type ExportBriefArgs } from "./figma/brief.js";
import { syncFigmaTokenEnv } from "./figma/token.js";
import { Runtime, sweepStaleChild } from "./runtime.js";
import { compareDesignAndDevice, type CompareArgs } from "./tools/composite.js";
import { aosConfigure, type ConfigureArgs } from "./tools/configure.js";
import { aosCrashes, type AosCrashesArgs } from "./tools/crash.js";
import {
  aosStatus,
  aosTasks,
  llmList,
  llmModels,
  llmSwitch,
  type AosTasksArgs,
  type LlmModelsArgs,
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

const SYNC_INTERVAL_MS = 30_000;

const NATIVE_TOOLS: NativeToolDefinition[] = [
  {
    name: "llm_list",
    description:
      "识别当前项目的全部 LLM 条目（.env 导入 / PostgreSQL / 高级配置）+ 当前激活项；key 只返回 masked 预览。",
    schema: z.object({}),
    handler: (runtime) => llmList(runtime)
  },
  {
    name: "llm_models",
    description:
      "厂商模型目录：查看/刷新已配置条目的 OpenAI 风格模型列表（GET {baseUrl}/models，缓存到 PostgreSQL；后台每 12h 自动刷新，可用 AOS_MODEL_REFRESH_HOURS 调整）。模型下线时按厂商别名/同族等价自动修复（AOS_LLM_AUTO_REPAIR=0 关闭）；返回 8 家国产厂商预设（DeepSeek/百炼/智谱/Kimi/硅基流动/阶跃/方舟/混元）便于一键配置。",
    schema: z.object({
      action: z.enum(["list", "refresh"]).describe("list 读缓存；refresh 立即请求厂商接口"),
      entry: z.string().optional().describe("只查看/刷新指定条目名（默认全部）")
    }),
    handler: (runtime, args) => llmModels(runtime, args as unknown as LlmModelsArgs)
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
      "为当前项目配置 LLM（OpenAI 兼容）：写入 PostgreSQL 与项目 .env，并可选设为 active。model/baseUrl 可用 vendor 预设（deepseek/qwen/zhipu/moonshot/siliconflow/stepfun/ark/hunyuan）替代：只给 vendor 时自动拉取厂商模型列表并按稳定别名选型。用于 setup_required 引导场景。",
    schema: z.object({
      apiKey: z.string().min(1).describe("该项目的 LLM key（费用支付方）"),
      model: z.string().optional().describe("模型名，如 deepseek-flash；省略时按 vendor 列表自动选择"),
      baseUrl: z.string().optional().describe("OpenAI 兼容端点，如 https://api.deepseek.com/v1；提供 vendor 时默认用预设"),
      vendor: z
        .enum(["deepseek", "qwen", "zhipu", "moonshot", "siliconflow", "stepfun", "ark", "hunyuan"])
        .optional()
        .describe("国产厂商预设（自动填 baseUrl / 选取当前模型）"),
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
    name: "aos_crashes",
    description:
      "崩溃取证：任务终态后自动采集设备 crash buffer 并解析为崩溃签名（包名+根因异常+首个应用帧），按栈签名去重计数；list 列出签名，get 取完整栈/日志摘录，scan 手动扫描（指定 traceId 时强制重扫）。",
    schema: z.object({
      action: z.enum(["list", "get", "scan"]).describe("list 列表 / get 详情 / scan 手动扫描"),
      signature: z.string().optional().describe("get 用的崩溃签名 id（见 list 的 records[].id）"),
      traceId: z.string().optional().describe("scan 时只扫描该 trace（强制重扫）"),
      package: z.string().optional().describe("list 过滤：应用包名（精确匹配）"),
      kind: z.enum(["java", "native", "anr", "unknown"]).optional().describe("list 过滤：崩溃类型"),
      since: z.string().optional().describe("list 过滤：ISO 8601 时间，只返回该时间之后仍出现的签名"),
      limit: z.number().int().positive().max(100).optional().describe("list 返回条数，默认 20")
    }),
    handler: (runtime, args) => aosCrashes(runtime, args as unknown as AosCrashesArgs)
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
  },
  {
    name: "figma_extract_flows",
    description:
      "解析 Figma 文件的原型交互 → 流程图：screens（含建议路由）+ edges（元素/触发器/导航/转场，支持 ON_CLICK/AFTER_TIMEOUT/拖拽/BACK 等连续动作）+ entryScreens；落盘 <项目>/.artemis/design/flows.json。REST 模式需 FIGMA_ACCESS_TOKEN。",
    schema: z.object({
      url: z.string().min(1).describe("Figma 文件 URL（可选带 node-id 限定范围）"),
      nodeId: z.string().optional().describe("可选：只解析该节点子树"),
      save: z.boolean().optional().describe("是否落盘到 .artemis/design/flows.json，默认 true")
    }),
    handler: (runtime, args) => figmaExtractFlows(runtime, args as unknown as ExtractFlowsArgs)
  },
  {
    name: "figma_gap_analysis",
    description:
      "缺口分析：对比 Figma 中应导出的资源（图标/矢量）与色板 vs 项目现有资产与 token 文件，输出缺失清单及建议文件名；扫描规则按项目技术栈自动选择（Flutter/React Native/原生 Android/iOS/Web，可用 assetGlobs/tokenFiles 覆盖）；落盘 <项目>/.artemis/design/gaps.json。",
    schema: z.object({
      url: z.string().min(1).describe("Figma 文件 URL"),
      id: z.string().optional().describe("可选：限定分析节点"),
      assetGlobs: z
        .array(z.string())
        .optional()
        .describe('项目资产匹配模式（默认 ["**/*.svg","**/*.png",…]，忽略 node_modules/dist 等）'),
      tokenFiles: z
        .array(z.string())
        .optional()
        .describe('token 文件匹配模式（默认 ["**/tokens.json","**/theme.css","**/variables.css",…]）'),
      save: z.boolean().optional().describe("是否落盘到 .artemis/design/gaps.json，默认 true")
    }),
    handler: (runtime, args) => figmaGapAnalysis(runtime, args as unknown as GapAnalysisArgs)
  },
  {
    name: "figma_generate_tests",
    description:
      "流程 → 测试用例：读取 .artemis/design/flows.json（或直接给 Figma URL 现场提取），把连续交互线性化为端到端流程，生成可直接传给 mobile_run_task 的自然语言任务描述；落盘 tests.json + tests.md。",
    schema: z.object({
      url: z.string().optional().describe("Figma URL（可选；不传则用 flows.json）"),
      flowsPath: z.string().optional().describe("自定义 flows.json 路径（相对项目根）"),
      maxFlows: z.number().int().positive().max(50).optional().describe("最多生成条数，默认 10"),
      save: z.boolean().optional().describe("是否落盘 tests.json/tests.md，默认 true")
    }),
    handler: (runtime, args) => figmaGenerateTests(runtime, args as unknown as GenerateTestsArgs)
  },
  {
    name: "figma_import_assets",
    description:
      "资源导入：按 gaps.json（或 ids 过滤）从 Figma 导出缺失资源（SVG 内联 / PNG 下载），按项目技术栈命名与首选目录幂等写入（同内容跳过；不同需 overwrite）；支持 dryRun 预览；落盘 .artemis/design/import-report.json。",
    schema: z.object({
      url: z.string().optional().describe("Figma URL（默认取 gaps.json 的 sourceUrl）"),
      gapPath: z.string().optional().describe("自定义 gaps.json 路径（相对项目根）"),
      destDir: z.string().optional().describe("覆盖目标目录（默认按栈档案/建议目录）"),
      ids: z.array(z.string()).optional().describe("只导入指定 Figma 节点 id（缺省=全部缺失项）"),
      format: z.enum(["svg", "png"]).optional().describe("导出格式，默认 svg"),
      overwrite: z.boolean().optional().describe("同名不同内容时是否覆盖，默认 false（跳过）"),
      dryRun: z.boolean().optional().describe("仅预览不写文件，默认 false"),
      save: z.boolean().optional().describe("是否落盘 import-report.json，默认 true")
    }),
    handler: (runtime, args) => figmaImportAssets(runtime, args as unknown as ImportAssetsArgs)
  },
  {
    name: "figma_export_brief",
    description:
      "构建简报：把 Figma 文件综合成编码用事实包（tokens/页面路由/组件与变体/流程概览/资源缺口/按栈编码约定），落盘 build-brief.{json,md}；可选 scaffold 按技术栈生成组件骨架文件（幂等）。",
    schema: z.object({
      url: z.string().min(1).describe("Figma 文件 URL"),
      save: z.boolean().optional().describe("是否落盘 build-brief.{json,md}，默认 true"),
      includeFlows: z.boolean().optional().describe("是否附带交互流程概览，默认 true"),
      includeGaps: z.boolean().optional().describe("是否附带 gaps.json 缺口摘要，默认 true"),
      scaffold: z.boolean().optional().describe("是否生成组件骨架文件，默认 false"),
      maxComponents: z.number().int().positive().max(200).optional().describe("组件清单上限，默认 40"),
      overwrite: z.boolean().optional().describe("scaffold 命名冲突时是否覆盖，默认 false")
    }),
    handler: (runtime, args) => figmaExportBrief(runtime, args as unknown as ExportBriefArgs)
  },
  {
    name: "figma_import_tokens",
    description:
      "颜色 token 导入：REST 读取 Figma 设计系统颜色（含 alpha，canonical #RRGGBBAA）→ 值冻结的语义命名 → .artemis/design/tokens.json（DTCG，modes 预留）+ 按检测栈生成 token 文件（Android colors.xml / Flutter Dart / RN TS / Web CSS）；输出 new/unchanged/unused、裸色扫描与 enforcement。人工命名用 .artemis/design/token-names.json。",
    schema: z.object({
      url: z.string().min(1).describe("Figma 文件 URL"),
      dryRun: z.boolean().optional().describe("仅预览不写文件，默认 false"),
      overwrite: z.boolean().optional().describe("允许覆盖非本工具生成的目标文件，默认 false（skipped_unmanaged）"),
      save: z.boolean().optional().describe("是否落盘 canonical tokens.json，默认 true"),
      enforcement: z.enum(["report", "warn", "block"]).optional().describe("硬编码/unused 问题级别，默认 report")
    }),
    handler: (runtime, args) => figmaImportTokens(runtime, args as unknown as ImportTokensArgs)
  },
  {
    name: "figma_import_strings",
    description:
      "文案 i18n 导入：REST 采集 Figma TEXT 节点 → 语义 key（nodeId 冻结映射，图层改名不改 key）→ .artemis/design/strings.json + 按检测栈写入源语言资源（M6b：Android strings.xml / Flutter arb）；输出复用建议、nodeId 迁移建议、source_changed、unused 与硬编码文案扫描；冲突需人工决策（resolutions.json），enforcement=block 可阻断。",
    schema: z.object({
      url: z.string().min(1).describe("Figma 文件 URL"),
      locale: z.string().optional().describe("source locale（BCP-47，默认沿用 strings.json 或 zh）"),
      dryRun: z.boolean().optional().describe("仅预览不写文件，默认 false"),
      save: z.boolean().optional().describe("是否落盘 strings.json，默认 true"),
      enforcement: z.enum(["report", "warn", "block"]).optional().describe("冲突/硬编码问题级别，默认 report")
    }),
    handler: (runtime, args) => figmaImportStrings(runtime, args as unknown as ImportStringsArgs)
  }
];

function errorResult(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
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
      if (name === "mobile_run_task" && result.isError !== true) {
        const traceId = extractTraceId(result);
        const taskArgs = (args ?? {}) as Record<string, unknown>;
        void runtime.recordTaskSubmission({
          traceId: traceId ?? "unknown",
          model: typeof taskArgs.model === "string" ? taskArgs.model : null,
          profile: typeof taskArgs.model === "string" ? taskArgs.model : null,
          taskDesc: typeof taskArgs.task_desc === "string" ? taskArgs.task_desc : null,
          lockedAppPackage:
            typeof taskArgs.locked_app_package === "string" ? taskArgs.locked_app_package : null
        });
      }
      return result;
    } catch (error) {
      return errorResult(`工具 "${name}" 执行失败: ${errorMessage(error)}`);
    }
  };

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const started = Date.now();
    const result = await handleCall(
      request as { params: { name: string; arguments?: Record<string, unknown> } }
    );
    const ok = result.isError !== true;
    const detail = ok ? "" : ` error=${resultErrorSummary(result)}`;
    log(
      `tool=${request.params.name} ok=${ok} ms=${Date.now() - started}${detail}`,
      ok ? "info" : "warn"
    );
    return result;
  });

  return server;
}

export async function runServer(): Promise<void> {
  let runtime: Runtime | null = null;
  let initError: string | null = null;

  try {
    const project = loadProject();
    // Logging first: bootstrap/bridge/tool-call records must land in the log file.
    const logDir =
      process.env.AOS_LOG_DIR?.trim() ||
      path.join(configDirAbs(project.config, project.rootDir), "logs");
    const logFile = configureLogging({ logDir });
    installCrashHandlers();
    log(`aos-mcp ${AOS_MCP_VERSION} 启动（stdio）项目=${project.rootDir}`);
    if (logFile) log(`日志文件: ${logFile}`);
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
    configureLogging({
      logDir:
        process.env.AOS_LOG_DIR?.trim() || path.join(process.cwd(), ".aos-mcp", "logs")
    });
    installCrashHandlers();
    log(`初始化失败: ${initError}`, "error");
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

  // stdio mirror of the HTTP-mode sync loop: terminal tasks are re-checked so
  // crash forensics fires without waiting for an explicit aos_tasks call.
  const syncTimer = runtime
    ? setInterval(() => {
        void runtime.syncTaskStatuses();
        runtime.maybeRefreshModels();
      }, SYNC_INTERVAL_MS)
    : null;
  syncTimer?.unref?.();
  runtime?.maybeRefreshModels();

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
    if (syncTimer) clearInterval(syncTimer);
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
