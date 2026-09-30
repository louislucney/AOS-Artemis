import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { CONFIG_FILENAME, resolveProject } from "./config/loader.js";
import { scanProjectEnv } from "./projects/scan.js";
import { resolveArtemisPython } from "./artemis/assembly.js";
import { ensureArtemisDeps, depsStatus, resolveDepsSource } from "./artemis/bootstrap.js";
import { penEnvFrom, penCliStatus } from "./pen/cli.js";
import { ensurePenCli, penNodeTooOld } from "./pen/install.js";
import { createProjectStore } from "./db/index.js";
import { errorMessage } from "./util.js";

const CONFIG_TEMPLATE = `{
  // 【可选高级层】aos.config.jsonc —— 不配置也能工作：
  // 项目 LLM 由 .env（AOS_LLM_*）或 aos_configure 工具创建，并持久化到 PostgreSQL。
  // 本文件用于：多档案精细控制 / nodeOverrides / 固定设备等。
  // 详见 DESIGN.md §4。

  "llm": {
    "profiles": {
      "deepseek": {
        "provider": "custom",
        "model": "deepseek-flash",
        "baseUrlEnv": "OPENAI_BASE_URL",
        "apiKeyEnv": "DEEPSEEK_API_KEY",
        "fallback": { "provider": "custom", "model": "deepseek-flash" },
        "nodeOverrides": {
          "object_detector": { "provider": "custom", "model": "deepseek-flash" },
          "hopper": { "provider": "custom", "model": "deepseek-flash" }
        }
      }
    }
  },

  "artemis": {
    // 留空 = 使用服务安装目录旁的 ./artemis（容器内默认）
    "repo": "",
    "mode": "standalone",
    "configDir": ".artemis",
    "deviceSerial": null,
    // 可选：artemis 依赖包（scripts/artemis-deps.sh 构建的 tar.gz）地址；
    // venv 缺失时首次运行自动下载并离线安装（也可用 env AOS_ARTEMIS_DEPS_URL）。
    "depsUrl": "",
    "depsSha256": ""
  }
}
`;

const ENV_TEMPLATE = `# AOS MCP — 项目级凭证（服务首次启用时扫描导入；也可由 aos_configure 工具自动写入）
# 注意：本文件不要提交到 git。

# LLM：OpenAI 兼容三元组（参考 DeepSeek 用法）
AOS_LLM_NAME=
AOS_LLM_MODEL=deepseek-flash
AOS_LLM_BASE_URL=https://api.deepseek.com/v1
AOS_LLM_API_KEY=

# 兼容旧名（优先级低于 AOS_LLM_*；如项目已有以下变量可直接沿用）
# DEEPSEEK_API_KEY=
# OPENAI_API_KEY=
# OPENAI_BASE_URL=

# Figma（可选；仅 REST 模式工具需要）
FIGMA_ACCESS_TOKEN=

# 说明：AOS_DATABASE_URL 属于服务级配置，由 MCP 客户端配置的 env 注入，
# 不要写进项目 .env（详见 README / DESIGN.md §4.5）。
`;

export function runInit(argv: string[]): void {
  const force = argv.includes("--force");
  const cwd = process.cwd();
  const written: string[] = [];

  const configPath = path.join(cwd, CONFIG_FILENAME);
  if (fs.existsSync(configPath) && !force) {
    console.log(`✓ ${CONFIG_FILENAME} 已存在（可选文件；使用 --force 覆盖）`);
  } else {
    fs.writeFileSync(configPath, CONFIG_TEMPLATE, "utf-8");
    written.push(CONFIG_FILENAME);
  }

  const envExamplePath = path.join(cwd, ".env.example");
  if (!fs.existsSync(envExamplePath)) {
    fs.writeFileSync(envExamplePath, ENV_TEMPLATE, "utf-8");
    written.push(".env.example");
  }

  for (const file of written) console.log(`已写入 ${file}`);

  console.log("");
  console.log("下一步：");
  console.log("  1) cp .env.example .env 并填入 AOS_LLM_MODEL / AOS_LLM_BASE_URL / AOS_LLM_API_KEY（Figma token 可选）");
  console.log("  2) Run: aos-mcp doctor");
  console.log("  3) 在 MCP 客户端中挂载本服务（node <service>/dist/index.js，env 注入 AOS_PROJECT_DIR 与 AOS_DATABASE_URL）");
}

interface DoctorLine {
  icon: "OK" | "WARN" | "FAIL";
  title: string;
  details?: string[];
}

export async function runDoctor(argv: string[] = []): Promise<number> {
  const lines: DoctorLine[] = [];
  let blocked = false;
  let degraded = false;

  const installDeps = argv.includes("--install-deps");

  // 1. Node version
  const nodeMajor = Number(process.version.replace(/^v/, "").split(".")[0]);
  if (Number.isFinite(nodeMajor) && nodeMajor >= 20) {
    lines.push({ icon: "OK", title: `Node ${process.version}` });
  } else {
    blocked = true;
    lines.push({
      icon: "FAIL",
      title: `Node ${process.version} 过低`,
      details: ["需要 Node >= 20。Run: 升级 Node 后重试。"]
    });
  }

  // 2. Project resolution + .env LLM scan
  const env = process.env;
  let rootDir: string | null = null;
  try {
    const resolution = resolveProject();
    rootDir = resolution.rootDir;
    lines.push({
      icon: "OK",
      title: `项目根目录: ${resolution.rootDir}`,
      details: resolution.configPath
        ? [`高级配置: ${resolution.configPath}`]
        : ["未提供 aos.config.jsonc（可选，不影响运行）"]
    });
  } catch (error) {
    blocked = true;
    lines.push({ icon: "FAIL", title: "项目定位失败", details: [errorMessage(error)] });
  }

  // 2.5 Optional: install artemis deps from the configured bundle (first run).
  if (installDeps && rootDir) {
    const { loadProject } = await import("./config/loader.js");
    const project = loadProject();
    const source = resolveDepsSource(project.config);
    const repoDir = project.config.artemis.repo;
    const result = await ensureArtemisDeps({
      repoDir,
      source,
      log: (line) => console.log(`    ${line}`)
    });
    const icon = result.status === "failed" ? "FAIL" : result.status === "skipped" ? "WARN" : "OK";
    lines.push({ icon, title: `依赖安装: ${result.status}`, details: result.message.split("\n") });
    if (result.status === "failed") blocked = true;
  }

  if (rootDir) {
    const { loadProject } = await import("./config/loader.js");
    const project = loadProject();
    const scan = scanProjectEnv(project.resolver);
    if (scan.llm?.complete) {
      lines.push({
        icon: "OK",
        title: `LLM 三元组就绪（model=${scan.llm.model}${scan.llm.modelVar ? ` via ${scan.llm.modelVar}` : ""}）`,
        details: [
          `base_url: ${scan.llm.baseUrl} (${scan.llm.baseUrlVar})`,
          `api_key: **** via ${scan.llm.apiKeyVar}`
        ]
      });
    } else if (scan.llm) {
      degraded = true;
      lines.push({
        icon: "WARN",
        title: "LLM 配置不完整（setup_required）",
        details: [
          `缺失: ${scan.llm.missing.join(" / ")}`,
          "Guidance: 调用 aos_configure 工具（服务启动后），或手动编辑项目 .env。"
        ]
      });
    } else {
      degraded = true;
      lines.push({
        icon: "WARN",
        title: "项目 .env 未提供 LLM（setup_required）",
        details: [
          "Guidance: 为项目配置 AOS_LLM_MODEL / AOS_LLM_BASE_URL / AOS_LLM_API_KEY（或 DEEPSEEK_API_KEY 等旧名）；",
          "也可在服务启动后调用 aos_configure 工具补全。"
        ]
      });
    }
    if (scan.figmaToken) {
      lines.push({ icon: "OK", title: `Figma token 已配置（${scan.figmaTokenVar}）` });
    } else {
      lines.push({
        icon: "WARN",
        title: "Figma token 未配置（可选）",
        details: ["仅影响 Figma REST 模式；调用 REST 工具时会提示提供。"]
      });
    }

    const penEnv = penEnvFrom(project.dotenvValues, process.env);
    const pen = await ensurePenCli({
      env: penEnv,
      allowInstall: installDeps,
      log: (line) => console.log(`    ${line}`)
    });
    if (!pen.ok) {
      degraded = true;
      lines.push({
        icon: "WARN",
        title: "pen CLI 未就绪（可选：pen_export / pen_apply_tokens / pen_apply_strings / pen_agent）",
        details: [
          pen.error ?? "未安装",
          ...(penNodeTooOld() ? [`当前 Node ${process.versions.node} 低于 pen CLI 要求的 22.19。`] : []),
          installDeps
            ? "自动安装未成功：可手动 npm install -g @pen.dev/cli，或设置 AOS_PEN_CLI_PATH。"
            : "Run: node dist/cli.js doctor --install-deps（首次调用 pen CLI 工具时也会自动安装）",
          "登录：pen login，或在项目 .env 设置 PEN_CLI_KEY（pen.dev 组织 Developer Keys）。"
        ]
      });
    } else {
      const status = await penCliStatus(undefined, { cliPath: pen.path ?? undefined, env: penEnv });
      if (status.installed && status.authenticated) {
        lines.push({
          icon: "OK",
          title: `pen CLI ${status.version ?? ""}（${status.email ?? "已登录"}）`
        });
      } else {
        degraded = true;
        lines.push({
          icon: "WARN",
          title: "pen CLI 已安装但未登录（可选）",
          details: ["Run: pen login，或在项目 .env 设置 PEN_CLI_KEY（pen.dev 组织 Developer Keys）。"]
        });
      }
    }
  }

  // 3. PostgreSQL
  const dbUrl = env.AOS_DATABASE_URL?.trim();
  if (!dbUrl) {
    degraded = true;
    lines.push({
      icon: "WARN",
      title: "未配置 AOS_DATABASE_URL（降级为会话内存存储）",
      details: ["Guidance: 在 MCP 客户端配置的 env 中提供 PostgreSQL 连接串。"]
    });
  } else {
    const { store, degraded: dbDegraded, reason } = await createProjectStore();
    if (!dbDegraded) {
      lines.push({ icon: "OK", title: "PostgreSQL 连接正常" });
      try {
        await store.close();
      } catch {
        /* ignore */
      }
    } else {
      degraded = true;
      lines.push({ icon: "WARN", title: reason ?? "PostgreSQL 不可用" });
    }
  }

  // 4. Artemis repo + python
  if (rootDir) {
    const { loadProject } = await import("./config/loader.js");
    const project = loadProject();
    const repo = project.config.artemis.repo;
    if (fs.existsSync(repo)) {
      lines.push({ icon: "OK", title: `artemis 仓库: ${repo}` });
      const { python, hint } = resolveArtemisPython(project.config.artemis);
      if (python) {
        lines.push({ icon: "OK", title: `Python 解释器: ${python}` });
        const probe = spawnSync(python, ["-c", "import artemis, mcp_server; print('ok')"], {
          cwd: repo,
          encoding: "utf-8",
          timeout: 60_000
        });
        if (probe.status === 0 && typeof probe.stdout === "string" && probe.stdout.includes("ok")) {
          lines.push({ icon: "OK", title: "artemis / mcp_server 模块可导入" });
        } else {
          blocked = true;
          const tail = (probe.stderr ?? "").trim().split("\n").slice(-3).join("\n");
          lines.push({
            icon: "FAIL",
            title: "artemis 模块导入失败（venv 未就绪？）",
            details: [`Run: cd ${repo} && uv sync`, tail].filter(Boolean)
          });
        }

        const depsState = depsStatus(repo);
        const depsSource = resolveDepsSource(project.config);
        if (depsState.status === "ready") {
          lines.push({
            icon: "OK",
            title: `依赖已就绪（lock ${depsState.lockSha256?.slice(0, 8) ?? "?"}）`
          });
        } else if (depsState.status === "stale") {
          degraded = true;
          lines.push({
            icon: "WARN",
            title: "依赖已过期（uv.lock 已变化）",
            details: depsSource
              ? ["Run: node dist/cli.js doctor --install-deps（serve 首次运行也会自动更新）"]
              : [`Run: cd ${repo} && uv sync`]
          });
        } else if (depsState.status === "unmanaged") {
          lines.push({
            icon: "WARN",
            title: "依赖 venv 未托管（无校验标记）",
            details: ["serve / doctor --install-deps 首次运行会自动校验并纳入托管。"]
          });
        }
      } else {
        blocked = true;
        const depsSource = resolveDepsSource(project.config);
        lines.push({
          icon: "FAIL",
          title: "未找到 artemis 虚拟环境",
          details: depsSource
            ? [
                `已配置依赖包: ${depsSource.url}`,
                "Run: node dist/cli.js doctor --install-deps（serve 首次运行也会自动安装）"
              ]
            : [
                hint ?? "Run: uv sync",
                "或在 aos.config.jsonc 配置 artemis.depsUrl（/ env AOS_ARTEMIS_DEPS_URL）后：node dist/cli.js doctor --install-deps"
              ]
        });
      }
    } else {
      blocked = true;
      lines.push({ icon: "FAIL", title: `artemis 仓库路径不存在: ${repo}` });
    }
  }

  // 5. ADB devices (informational)
  const adb = spawnSync("adb", ["devices"], { encoding: "utf-8", timeout: 10_000 });
  if (adb.error || adb.status !== 0) {
    lines.push({
      icon: "WARN",
      title: "adb 不可用",
      details: ["run `adb devices` 失败：确认 Android Platform Tools 已安装且在 PATH。"]
    });
  } else {
    const devices = (adb.stdout ?? "")
      .split("\n")
      .filter((line) => /\tdevice\b/.test(line))
      .map((line) => line.split("\t")[0]!.trim());
    if (devices.length > 0) {
      lines.push({ icon: "OK", title: `已连接设备: ${devices.join(", ")}` });
    } else {
      degraded = true;
      lines.push({
        icon: "WARN",
        title: "没有已授权的 Android 设备",
        details: ["Guidance: 连接设备并开启 USB 调试（或启动模拟器）。"]
      });
    }
  }

  for (const line of lines) {
    const icon = line.icon === "OK" ? "✓" : line.icon === "WARN" ? "!" : "✗";
    console.log(`${icon} ${line.title}`);
    for (const detail of line.details ?? []) {
      console.log(`    ${detail}`);
    }
  }

  const verdict = blocked ? "blocked" : degraded ? "degraded" : "ready";
  console.log("");
  console.log(`verdict: ${verdict}`);
  return blocked ? 2 : degraded ? 1 : 0;
}
