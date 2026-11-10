import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { CONFIG_FILENAME, resolveProject } from "./config/loader.js";
import { scanProjectEnv } from "./projects/scan.js";
import { resolveArtemisPython } from "./artemis/assembly.js";
import { ensureArtemisDeps, depsStatus, resolveDepsSource } from "./artemis/bootstrap.js";
import { penEnvFrom, penCliStatus } from "./pen/cli.js";
import { ensurePenCli, penNodeTooOld } from "./pen/install.js";
import { fetchCenterLlm } from "./llm/center.js";
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

const ENV_TEMPLATE = `# mobile-testing MCP — 项目级凭证（服务首次启用时扫描导入；也可由 aos_configure 工具自动写入）
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

# Jira Cloud（可选；jira_* 工具与 jira CLI 需要）
# 站点仅接受 https://*.atlassian.net；token 在 id.atlassian.com 生成（一年有效期）
JIRA_BASE_URL=https://your-site.atlassian.net
JIRA_EMAIL=
JIRA_API_TOKEN=

# 说明：MOBILE_TESTING_DATABASE_URL 属于服务级配置，由 MCP 客户端配置的 env 注入，
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
  console.log("  2) Run: mobile-testing-mcp doctor");
  console.log("  3) 在 MCP 客户端中挂载本服务（node <service>/dist/index.js，env 注入 AOS_PROJECT_DIR 与 MOBILE_TESTING_DATABASE_URL）");
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
  let runnerMode =
    (process.env.AOS_LLM_FROM_CENTER ?? "").trim() === "1" ||
    (process.env.AOS_RUNNER_MODE ?? "").trim() === "1";

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

  // 1.5 本机身份与环境（只读本机，不依赖 PG / 项目定位）
  try {
    const { resolveHostIdentity } = await import("./host/identity.js");
    const { detectHostEnvironment } = await import("./host/env.js");
    const identity = await resolveHostIdentity({ env: process.env });
    const hostEnv = await detectHostEnvironment({ projectRoot: process.cwd() });
    const tools = Object.entries(hostEnv.tools)
      .filter(([, tool]) => tool.present)
      .map(([name, tool]) => `${name}${tool.version ? ` ${tool.version}` : ""}`);
    lines.push({
      icon: "OK",
      title: `host identity: ${identity.id} · ${identity.kind} · ${identity.osPlatform} · ${identity.arch}`,
      details: [
        `hostname: ${identity.hostname}`,
        `os version: ${identity.osVersion}`,
        `node ${hostEnv.node} · aos ${hostEnv.aos}`,
        tools.length > 0 ? `tools: ${tools.join(", ")}` : "tools: 无可用设备工具"
      ]
    });
  } catch (error) {
    degraded = true;
    lines.push({
      icon: "WARN",
      title: "本机身份/环境采集失败",
      details: [errorMessage(error)]
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
    runnerMode =
      runnerMode ||
      (project.dotenvValues.AOS_LLM_FROM_CENTER ?? "").trim() === "1" ||
      (project.dotenvValues.AOS_RUNNER_MODE ?? "").trim() === "1";
    const scan = scanProjectEnv(project.resolver);
    const centerEnv = { ...project.dotenvValues, ...process.env };
    const centerUrlRaw = (centerEnv.MOBILE_TESTING_RUNNER_CONTROL_URL ?? "").trim();
    if (centerUrlRaw !== "") {
      const { checkCenterHealth } = await import("./runner/control/health.js");
      const health = await checkCenterHealth({ baseUrl: centerUrlRaw });
      if (health.ok) {
        lines.push({
          icon: "OK",
          title: `中心连通（${health.service ?? "center"}${health.version ? ` ${health.version}` : ""}）`,
          details: [health.url]
        });
      } else {
        if (runnerMode) blocked = true;
        else degraded = true;
        lines.push({
          icon: runnerMode ? "FAIL" : "WARN",
          title: "中心不可达",
          details: [
            health.url,
            health.error ?? "",
            "检查 MOBILE_TESTING_RUNNER_CONTROL_URL（不要用 127.0.0.1）、两台机器同网段/VPN、中心以 --host 0.0.0.0 启动并放行端口。"
          ].filter((line) => line !== "")
        });
      }
    }
    const centerEnabled = (centerEnv.AOS_LLM_FROM_CENTER ?? "").trim() === "1";
    const centerLlm = centerEnabled
      ? await fetchCenterLlm({ env: centerEnv })
      : null;
    if (centerLlm?.entry) {
      lines.push({
        icon: "OK",
        title: `LLM 由中心提供（${centerLlm.entry.name} · ${centerLlm.entry.model}）`,
        details: [
          `base_url: ${centerLlm.entry.baseUrl ?? "（provider 默认）"}`,
          "api_key: ****（中心持有，runner 不落盘）"
        ]
      });
    } else if (centerEnabled && centerLlm?.error) {
      degraded = true;
      lines.push({
        icon: "WARN",
        title: "中心 LLM 不可用",
        details: [
          centerLlm.error,
          "将回退本机 .env；检查 MOBILE_TESTING_RUNNER_CONTROL_URL / MOBILE_TESTING_RUNNER_JOB_TOKEN 与中心 active LLM。"
        ]
      });
    }
    if (centerLlm?.entry) {
      // 中心已提供 active LLM，不要求本机 .env。
    } else if (scan.llm?.complete) {
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

    // 远程设备宿主（ADR-0011）：仅声明时探活，探针短超时、best-effort。
    const { probeAdbSocket, probeAppiumStatus, resolveAndroidAdbSocket, resolveIosHost } = await import(
      "./device/device-hosts.js"
    );
    const iosHost = resolveIosHost(project.config, project.resolver);
    if (iosHost.appiumUrl) {
      const probe = await probeAppiumStatus(iosHost.appiumUrl);
      const signing = [
        iosHost.wdaBundleId ? `wdaBundleId=${iosHost.wdaBundleId}` : null,
        iosHost.xcodeOrgId ? `xcodeOrgId=${iosHost.xcodeOrgId}` : null,
        iosHost.xcodeSigningId ? `xcodeSigningId=${iosHost.xcodeSigningId}` : null
      ].filter((entry): entry is string => entry !== null);
      if (probe.ok) {
        lines.push({
          icon: "OK",
          title: `iOS 设备宿主可达（${iosHost.appiumUrl}，来源 ${iosHost.source ?? "config"}）`,
          details: [
            probe.detail,
            signing.length > 0 ? `签名覆盖：${signing.join(" / ")}` : "签名：未声明（沿用宿主机默认）"
          ]
        });
      } else {
        degraded = true;
        lines.push({
          icon: "WARN",
          title: `iOS 设备宿主不可达（${iosHost.appiumUrl}）`,
          details: [
            probe.detail,
            "Guidance: 确认宿主机已在跑 Appium（appium --port 4723）且 LAN/VPN 可达；跨网建议 SSH 隧道：ssh -L 4723:127.0.0.1:4723 <宿主>，AOS_APPIUM_URL 指向 http://127.0.0.1:4723。"
          ]
        });
      }
    }
    const androidHost = resolveAndroidAdbSocket(project.config, project.resolver);
    if (androidHost) {
      const probe = await probeAdbSocket(androidHost.socket);
      if (probe.ok) {
        lines.push({
          icon: "OK",
          title: `Android 设备宿主 adb 可达（${androidHost.socket}，来源 ${androidHost.source}）`,
          details: [probe.detail]
        });
      } else {
        degraded = true;
        lines.push({
          icon: "WARN",
          title: `Android 设备宿主不可达（${androidHost.socket}）`,
          details: [
            probe.detail,
            "Guidance: 在宿主机运行 adb -a nodaemon server（adb server 暴露风险，仅限可信网络）；或 SSH 隧道：ssh -L 5037:127.0.0.1:5037 <宿主> 并把 ADB_SERVER_SOCKET 指向 tcp:127.0.0.1:5037。"
          ]
        });
      }
    }

    const { detectAppium } = await import("./ios/appium/detect.js");
    const iosAppium = await detectAppium({ env: { ...project.dotenvValues, ...process.env } });
    if (iosAppium.appium.found && iosAppium.xcuitest.installed) {
      lines.push({
        icon: "OK",
        title: `Appium ${iosAppium.appium.version ?? "(版本未知)"} / xcuitest ${iosAppium.xcuitest.version ?? "(版本未知)"}（iOS 真机后端）`,
        details: iosAppium.guidance
      });
    } else {
      degraded = true;
      lines.push({
        icon: "WARN",
        title: "iOS 真机后端未就绪（可选：仅影响真机 UDID 的 WDA 路径）",
        details: iosAppium.guidance
      });
    }

    const penEnv = penEnvFrom(project.dotenvValues, process.env);
    if ((penEnv.AOS_PEN_SKIP ?? "").trim() === "1") {
      lines.push({
        icon: "OK",
        title: "pen CLI 检查已跳过（AOS_PEN_SKIP=1，仅移动执行）"
      });
    } else {
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
        const status = await penCliStatus(undefined, {
          cliPath: pen.path ?? undefined,
          env: penEnv
        });
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
  }

  // 3. PostgreSQL
  const dbUrl = env.MOBILE_TESTING_DATABASE_URL?.trim();
  if (!dbUrl) {
    if (runnerMode) {
      lines.push({
        icon: "OK",
        title: "Runner 模式：使用中心 HTTP 控制面",
        details: [
          "不需要 MOBILE_TESTING_DATABASE_URL；中心地址由 MOBILE_TESTING_RUNNER_CONTROL_URL 提供。"
        ]
      });
    } else {
      lines.push({
        icon: "OK",
        title: "未配置 MOBILE_TESTING_DATABASE_URL：使用项目文件台账（.artemis/ledger，随项目持久）",
        details: ["可选：配置连接串以集中跨进程/跨项目查询。"]
      });
    }
  } else {
    const { store, kind: dbKind, reason } = await createProjectStore();
    if (dbKind === "postgres") {
      lines.push({ icon: "OK", title: "PostgreSQL 连接正常" });
      try {
        await store.close();
      } catch {
        /* ignore */
      }
    } else {
      degraded = true;
      lines.push({
        icon: "WARN",
        title: dbKind === "file" ? "PostgreSQL 已配置但不可用：当前使用项目文件台账" : (reason ?? "PostgreSQL 不可用"),
        details: reason === null || dbKind !== "file" ? [] : [reason]
      });
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
        const versionProbe = spawnSync(python, ["--version"], {
          cwd: repo,
          encoding: "utf-8",
          timeout: 15_000
        });
        const versionText = `${versionProbe.stdout ?? ""}${versionProbe.stderr ?? ""}`.trim();
        if (versionText !== "") {
          lines.push({
            icon: versionText.includes("3.12") ? "OK" : "WARN",
            title: `Python 版本: ${versionText}`,
            ...(versionText.includes("3.12")
              ? {}
              : { details: ["Artemis 依赖按 Python 3.12 打包；请用 3.12 重建 venv。"] })
          });
        }
        const depsState = depsStatus(repo);
        const depsSource = resolveDepsSource(project.config);
        const probeModule = (moduleName: string) =>
          spawnSync(python, ["-c", `import ${moduleName}; print('ok')`], {
            cwd: repo,
            encoding: "utf-8",
            timeout: 60_000
          });
        const artemisProbe = probeModule("artemis");
        const mcpProbe = probeModule("mcp_server");
        const probeOk = (probe: ReturnType<typeof probeModule>): boolean =>
          probe.status === 0 &&
          typeof probe.stdout === "string" &&
          probe.stdout.includes("ok");
        const probeDetail = (label: string, probe: ReturnType<typeof probeModule>): string => {
          if (probeOk(probe)) return `${label}: ok`;
          const parts = [`${label}: FAIL`];
          if (probe.error) parts.push(probe.error.message);
          if (probe.signal) parts.push(`signal ${probe.signal}`);
          const stderr = (probe.stderr ?? "").trim().split("\n").slice(-5).join(" | ");
          if (stderr !== "") parts.push(stderr);
          const stdout = (probe.stdout ?? "").trim().split("\n").slice(-3).join(" | ");
          if (stdout !== "") parts.push(`stdout: ${stdout}`);
          return parts.join(" · ");
        };
        if (probeOk(artemisProbe) && probeOk(mcpProbe)) {
          lines.push({ icon: "OK", title: "artemis / mcp_server 模块可导入" });
        } else {
          blocked = true;
          const details = [
            `Run: cd ${repo} && uv sync`,
            probeDetail("artemis", artemisProbe),
            probeDetail("mcp_server", mcpProbe)
          ];
          if (depsState.status === "ready") {
            details.push(
              `离线包：删除 ${path.join(repo, ".venv")} 后重跑 setup-offline.cmd（或 runner.cmd），不要只跑 doctor。`
            );
          }
          lines.push({
            icon: "FAIL",
            title: "artemis 模块导入失败（venv 未就绪？）",
            details
          });
        }

        if (depsState.status === "ready") {
          const lockProbe = spawnSync(
            python,
            [
              "-c",
              "import json; from artemis.runtime.device_lock import DeviceExecutionLock as L; print(json.dumps({k: v.pid for k, v in L.get_active_owners().items()}))"
            ],
            { cwd: repo, encoding: "utf-8", timeout: 15_000 }
          );
          if (lockProbe.status === 0) {
            try {
              const owners = JSON.parse((lockProbe.stdout ?? "").trim()) as Record<string, unknown>;
              const active = Object.entries(owners).filter(([, pid]) => typeof pid === "number");
              if (active.length > 0) {
                degraded = true;
                lines.push({
                  icon: "WARN",
                  title: `Artemis 设备锁仍被占用：${active.map(([device, pid]) => `${device}=pid ${pid}`).join("、")}`,
                  details: [
                    "旧 runner 子进程可能未退出；新任务会排队到超时。确认后终止：",
                    "Get-CimInstance Win32_Process -Filter \"Name='python.exe'\" | Where-Object { $_.CommandLine -match 'mcp_server|aos-artemis-runner' } | Select-Object ProcessId, CommandLine"
                  ]
                });
              }
            } catch {
              /* 非 JSON 输出：不阻断 doctor */
            }
          }
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
