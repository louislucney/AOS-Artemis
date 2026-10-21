import fs from "node:fs";

import { CENTER_DATABASE_ENV, openCenterStore, resolveHostReference } from "./center/store.js";
import type { HostRecord, ProjectRecord, ProjectStore } from "./db/types.js";
import { resolveHostIdentity } from "./host/identity.js";
import { logWarn } from "./log.js";
import { errorMessage } from "./util.js";

export interface HostCommandIo {
  log: (line: string) => void;
  errorLog: (line: string) => void;
}

export interface HostCommandDeps {
  env?: NodeJS.ProcessEnv;
  /** 注入的中心存储（测试）；缺省按 `MOBILE_TESTING_DATABASE_URL` 打开 PG 并负责关闭。 */
  store?: ProjectStore;
}

interface ParsedFlags {
  positional: string[];
  get: (key: string) => string | null;
  bool: (key: string) => boolean;
  has: (key: string) => boolean;
}

function parseFlags(argv: string[]): ParsedFlags {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    if (eq >= 0) {
      flags.set(arg.slice(2, eq), arg.slice(eq + 1));
      continue;
    }
    const key = arg.slice(2);
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags.set(key, next);
      index += 1;
    } else {
      flags.set(key, true);
    }
  }
  return {
    positional,
    get: (key) => {
      const value = flags.get(key);
      return typeof value === "string" ? value : null;
    },
    bool: (key) => {
      const value = flags.get(key);
      return value !== undefined && value !== "false";
    },
    has: (key) => flags.has(key)
  };
}

export function printHostUsage(log: (line: string) => void): void {
  log(`mobile-testing-mcp host <list|show|register|adopt-legacy> [options]

中心主机登记（只连 PostgreSQL，不读本机 .artemis；需 MOBILE_TESTING_DATABASE_URL）：
  host list [--json]                         列出已登记主机
  host show <id|hostname> [--json]           查看主机（hostname 重名时报错列 id）
  host register <id|hostname> [--label <名>] [--owner <人>] [--expected-os <os>]
                [--expected-hostname <名>]   登记标签/负责人/期望环境（hostname 须唯一）
  host adopt-legacy --local [--dry-run|--apply]
                                             把本机存在路径的 legacy（未绑定主机）项目认领到本机
  host adopt-legacy --host <id|hostname> --path <rootPath> [--dry-run|--apply] [--allow-unknown-host]
                                             显式把某个 legacy 项目认领到指定主机
  缺省 dry-run；--apply 才写库并记审计。--allow-unknown-host 允许写入尚未接入的主机 id（先迁移后接入）。`);
}

const HOST_ACTIONS = new Set(["list", "show", "register", "adopt-legacy"]);
const ADOPT_USAGE =
  "用法: host adopt-legacy --local [--dry-run|--apply] 或 host adopt-legacy --host <id|hostname> --path <rootPath> [--dry-run|--apply] [--allow-unknown-host]";

/** 子命令必填参数/冲突在开库前判定（`host bogus`/缺参不应先报 PG 错误）。 */
function hostInvocationError(action: string, flags: ParsedFlags): string | null {
  if (action === "show") {
    return flags.positional[1] ?? flags.get("id")
      ? null
      : "用法: host show <id|hostname> [--json]";
  }
  if (action === "register") {
    return flags.positional[1] ?? flags.get("id")
      ? null
      : "用法: host register <id|hostname> [--label <名>] [--owner <人>] [--expected-os <os>] [--expected-hostname <名>]";
  }
  if (action !== "adopt-legacy") return null;
  if (flags.bool("apply") && flags.bool("dry-run")) return "--apply 与 --dry-run 不能同时使用";
  const hostArg = flags.get("host");
  const pathArg = flags.get("path");
  if (flags.bool("local")) {
    return hostArg !== null || pathArg !== null ? "--local 与 --host/--path 不能同时使用" : null;
  }
  if (hostArg === null || hostArg.trim() === "" || pathArg === null || pathArg.trim() === "") {
    return ADOPT_USAGE;
  }
  return null;
}

export async function runHostCommand(
  argv: string[],
  io: HostCommandIo,
  deps: HostCommandDeps = {}
): Promise<number> {
  const flags = parseFlags(argv);
  const action = flags.positional[0];
  const env = deps.env ?? process.env;
  if (!action || action === "help" || action === "--help" || action === "-h") {
    printHostUsage(io.log);
    return action ? 0 : 2;
  }
  if (!HOST_ACTIONS.has(action)) {
    io.errorLog(`未知 host 子命令 "${action}"`);
    printHostUsage(io.errorLog);
    return 2;
  }
  const invocationError = hostInvocationError(action, flags);
  if (invocationError !== null) {
    io.errorLog(invocationError);
    return 2;
  }
  let store = deps.store ?? null;
  if (store === null) {
    try {
      store = await openCenterStore(env);
    } catch (error) {
      io.errorLog(
        `${errorMessage(error)}（host 命令只支持中心 PG；请在客户端配置或环境变量中设置 ${CENTER_DATABASE_ENV}）`
      );
      return 2;
    }
  }
  try {
    if (action === "list") return await hostList(store, flags, io);
    if (action === "show") return await hostShow(store, flags, io);
    if (action === "register") return await hostRegister(store, flags, io);
    return await hostAdoptLegacy(store, flags, io, env);
  } catch (error) {
    io.errorLog(`host ${action} 失败：${errorMessage(error)}`);
    return 2;
  } finally {
    if (deps.store === undefined && store !== null) {
      try {
        await store.close();
      } catch {
        /* best effort */
      }
    }
  }
}

async function hostList(
  store: ProjectStore,
  flags: ParsedFlags,
  io: HostCommandIo
): Promise<number> {
  const hosts = await store.listHosts();
  if (flags.bool("json")) {
    io.log(JSON.stringify({ ok: true, hosts }, null, 2));
    return 0;
  }
  if (hosts.length === 0) {
    io.log("暂无主机登记（客户端接入后自动登记）");
    return 0;
  }
  for (const host of hosts) {
    io.log(describeHostLine(host));
  }
  return 0;
}

async function hostShow(
  store: ProjectStore,
  flags: ParsedFlags,
  io: HostCommandIo
): Promise<number> {
  const reference = flags.positional[1] ?? flags.get("id");
  if (!reference) {
    io.errorLog("用法: host show <id|hostname> [--json]");
    return 2;
  }
  const host = await lookupHost(store, reference, io);
  if (host === null) return 2;
  if (flags.bool("json")) {
    io.log(JSON.stringify({ ok: true, host }, null, 2));
    return 0;
  }
  io.log(`主机 ${host.id}`);
  io.log(`  hostname: ${host.hostname}${host.label ? ` · ${host.label}` : ""}`);
  io.log(`  平台: ${host.osPlatform}${host.osVersion ? ` ${host.osVersion}` : ""} · ${host.arch ?? "-"}`);
  io.log(`  能力: ${host.capabilities.length > 0 ? host.capabilities.join(",") : "无"}`);
  io.log(`  负责人: ${host.owner ?? "-"} · 期望 OS: ${host.expectedOs ?? "-"} · 期望 hostname: ${host.expectedHostname ?? "-"}`);
  io.log(
    `  登记: ${host.registeredAt ?? "未登记"}${host.registeredBy ? `（${host.registeredBy}）` : ""}`
  );
  io.log(`  最近活跃: ${host.lastSeenAt} · 队列${host.queuePaused ? "已暂停" : "正常"}`);
  return 0;
}

async function hostRegister(
  store: ProjectStore,
  flags: ParsedFlags,
  io: HostCommandIo
): Promise<number> {
  const reference = flags.positional[1] ?? flags.get("id") ?? "";
  const host = await lookupHost(store, reference, io);
  if (host === null) return 2;
  const registeredBy = flags.get("registered-by") ?? "cli";
  const record = await store.updateHostRegistration({
    id: host.id,
    label: flags.has("label") ? flags.get("label") : undefined,
    owner: flags.has("owner") ? flags.get("owner") : undefined,
    expectedOs: flags.has("expected-os") ? flags.get("expected-os") : undefined,
    expectedHostname: flags.has("expected-hostname") ? flags.get("expected-hostname") : undefined,
    registeredBy
  });
  if (record === null) {
    io.errorLog(`未知主机 ${reference}（先用 host list 查看已登记主机）`);
    return 2;
  }
  if (flags.bool("json")) {
    io.log(JSON.stringify({ ok: true, host: record }, null, 2));
    return 0;
  }
  io.log(`已登记主机 ${record.id}（${record.hostname}）`);
  io.log(
    `  label: ${record.label ?? "-"} · owner: ${record.owner ?? "-"} · expectedOs: ${record.expectedOs ?? "-"} · expectedHostname: ${record.expectedHostname ?? "-"}`
  );
  return 0;
}

async function hostAdoptLegacy(
  store: ProjectStore,
  flags: ParsedFlags,
  io: HostCommandIo,
  env: NodeJS.ProcessEnv
): Promise<number> {
  const apply = flags.bool("apply");
  const hostArg = flags.get("host");
  const pathArg = flags.get("path");
  if (flags.bool("local")) {
    const hostId = await localHostId(env);
    return await adoptLocalProjects(store, hostId, apply, flags, io);
  }
  if (hostArg === null || pathArg === null) {
    io.errorLog(ADOPT_USAGE);
    return 2;
  }
  const lookup = await resolveHostReference(store, hostArg);
  let hostId: string;
  if (lookup.ok) {
    hostId = lookup.host.id;
  } else if (lookup.reason === "ambiguous") {
    io.errorLog(
      `主机名不唯一：${hostArg}（${lookup.candidates.map((host) => host.id).join("、")}）；请改用主机 id`
    );
    return 2;
  } else if (flags.bool("allow-unknown-host")) {
    // 逃逸口：先把历史项目挂到尚未接入的机器（按操作员给定的 id 原样写入），接入后自动接上。
    hostId = hostArg.trim();
  } else {
    io.errorLog(
      `未知主机 ${hostArg}（用 host list 查看已登记主机；确认要先把项目迁到尚未接入的主机时加 --allow-unknown-host）`
    );
    return 2;
  }
  return await adoptOneProject(store, hostId, pathArg, apply, flags, io);
}

async function adoptLocalProjects(
  store: ProjectStore,
  hostId: string,
  apply: boolean,
  flags: ParsedFlags,
  io: HostCommandIo
): Promise<number> {
  const candidates = (await store.listProjects()).filter(
    (project) => project.hostId === null && fs.existsSync(project.rootPath)
  );
  if (flags.bool("json") && !apply) {
    io.log(
      JSON.stringify({ ok: true, hostId, dryRun: true, candidates: candidates.map(adoptionView) }, null, 2)
    );
    return 0;
  }
  if (apply) {
    const adopted: Array<ReturnType<typeof adoptionView> & { adopted: boolean }> = [];
    const jsonMode = flags.bool("json");
    for (const project of candidates) {
      const changed = await adoptLegacyProject(store, project, hostId);
      adopted.push({ ...adoptionView(project), hostId, adopted: changed });
      if (!jsonMode) {
        io.log(
          changed
            ? `已认领 ${project.rootPath} → ${hostId}`
            : `跳过 ${project.rootPath}（目标主机已有同路径项目）`
        );
      }
    }
    if (jsonMode) {
      io.log(JSON.stringify({ ok: true, hostId, dryRun: false, adopted }, null, 2));
      return 0;
    }
    if (candidates.length === 0) {
      io.log("无待认领的 legacy 项目（本机路径均不存在或已绑定）");
      return 0;
    }
    io.log(`完成：认领 ${adopted.filter((entry) => entry.adopted).length}/${candidates.length} 个 legacy 项目到主机 ${hostId}`);
    return 0;
  }
  if (candidates.length === 0) {
    io.log("无待认领的 legacy 项目（本机路径均不存在或已绑定）");
    return 0;
  }
  io.log(`将认领 ${candidates.length} 个 legacy 项目到主机 ${hostId}（dry-run；加 --apply 执行）`);
  for (const project of candidates) {
    io.log(`- ${project.rootPath}（${project.name}）`);
  }
  return 0;
}

async function adoptOneProject(
  store: ProjectStore,
  hostId: string,
  rootPath: string,
  apply: boolean,
  flags: ParsedFlags,
  io: HostCommandIo
): Promise<number> {
  const project = (await store.listProjects()).find(
    (entry) => entry.hostId === null && entry.rootPath === rootPath
  );
  if (!project) {
    io.errorLog(`未找到待认领的 legacy 项目：${rootPath}（可能已绑定主机或未登记）`);
    return 2;
  }
  if (!apply) {
    if (flags.bool("json")) {
      io.log(JSON.stringify({ ok: true, hostId, dryRun: true, candidates: [adoptionView(project)] }, null, 2));
    } else {
      io.log(`将认领 ${project.rootPath} → ${hostId}（项目 ${project.name}；dry-run，加 --apply 执行）`);
    }
    return 0;
  }
  const changed = await adoptLegacyProject(store, project, hostId);
  if (!changed) {
    io.errorLog(`认领失败：主机 ${hostId} 已有同路径项目 ${rootPath}`);
    return 2;
  }
  if (flags.bool("json")) {
    io.log(
      JSON.stringify(
        { ok: true, hostId, dryRun: false, adopted: [{ ...adoptionView(project), hostId }] },
        null,
        2
      )
    );
    return 0;
  }
  io.log(`已认领 ${project.rootPath} → ${hostId}`);
  return 0;
}

async function adoptLegacyProject(
  store: ProjectStore,
  project: ProjectRecord,
  hostId: string
): Promise<boolean> {
  const changed = await store.adoptProjectHost({ projectId: project.id, hostId });
  if (changed) {
    try {
      await store.recordAudit(project.rootPath, {
        domain: "host",
        action: "adopt-legacy",
        result: "ok",
        summary: `legacy 项目认领到主机 ${hostId}`,
        refs: { hostId, projectId: project.id }
      });
    } catch (error) {
      logWarn(`host adopt-legacy 审计写入失败（认领已生效）：${errorMessage(error)}`);
    }
  }
  return changed;
}

async function localHostId(env: NodeJS.ProcessEnv): Promise<string> {
  const explicit = (env.AOS_HOST_ID ?? "").trim();
  if (explicit !== "") return explicit;
  const identity = await resolveHostIdentity({ env });
  return identity.id;
}

async function lookupHost(
  store: ProjectStore,
  reference: string,
  io: HostCommandIo
): Promise<HostRecord | null> {
  const lookup = await resolveHostReference(store, reference);
  if (lookup.ok) return lookup.host;
  if (lookup.reason === "not-found") {
    io.errorLog(`未知主机 ${reference}（用 host list 查看已登记主机）`);
    return null;
  }
  io.errorLog(
    `主机名不唯一：${reference}（${lookup.candidates.map((host) => host.id).join("、")}）；请改用主机 id`
  );
  return null;
}

function adoptionView(project: ProjectRecord): Pick<
  ProjectRecord,
  "id" | "hostId" | "rootPath" | "name" | "lastSeenAt"
> {
  return {
    id: project.id,
    hostId: project.hostId,
    rootPath: project.rootPath,
    name: project.name,
    lastSeenAt: project.lastSeenAt
  };
}

function describeHostLine(host: HostRecord): string {
  const bits = [
    host.id,
    host.hostname,
    host.label ?? "-",
    host.osPlatform,
    host.owner ?? "-",
    host.queuePaused ? "paused" : "active",
    host.lastSeenAt
  ];
  return bits.join(" · ");
}
