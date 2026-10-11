import type { AosConfig } from "../config/types.js";
import type { StateStore } from "../state.js";
import { isProcessAlive, processCmdline, terminateProcess } from "../util.js";
import {
  buildBareChildSpec,
  buildChildEnvForEntry,
  buildChildSpecForEntry,
  resolveArtemisPython,
  type ChildSpec,
  type EntryLike,
  type ResolvedPython
} from "./assembly.js";
import type { ArtemisProxyLike } from "./proxy.js";
import { resultPayload } from "./task-result.js";

/** 子进程生命周期模块（DESIGN §13.88）：child spec/指纹、spawn 记账（state.child）、
 * 任务数探测与孤儿清理集中一处；Runtime 通过它组装默认代理。 */
export interface ChildSupervisorDeps {
  config: AosConfig;
  rootDir: string;
  baseEnv: NodeJS.ProcessEnv;
  state: StateStore;
  activeEntry: () => EntryLike | null;
  proxy: () => ArtemisProxyLike;
}

export class ChildSupervisor {
  constructor(private readonly deps: ChildSupervisorDeps) {}

  fingerprintForEntry(entry: EntryLike): string {
    return buildChildEnvForEntry({
      config: this.deps.config,
      rootDir: this.deps.rootDir,
      entry,
      baseEnv: this.deps.baseEnv
    }).fingerprint;
  }

  /** 无 LLM 条目时回退 bare spec，保证只读工具可用（mobile_run_task 在上游门禁）。 */
  spec(): ChildSpec {
    const args = {
      config: this.deps.config,
      rootDir: this.deps.rootDir,
      baseEnv: this.deps.baseEnv
    };
    const entry = this.deps.activeEntry();
    return entry ? buildChildSpecForEntry({ ...args, entry }) : buildBareChildSpec(args);
  }

  recordSpawned(info: { pid: number | null; fingerprint: string }): void {
    const state = this.deps.state.read();
    this.deps.state.write({
      ...state,
      child: {
        ownerPid: process.pid,
        pid: info.pid ?? undefined,
        fingerprint: info.fingerprint,
        startedAt: new Date().toISOString()
      }
    });
  }

  clearChild(): void {
    const state = this.deps.state.read();
    delete state.child;
    this.deps.state.write(state);
  }

  async taskCounts(): Promise<{ active: number; queued: number } | null> {
    try {
      const result = await this.deps.proxy().callTool("mobile_diagnose", {});
      const payload = resultPayload(result);
      if (!payload) return null;
      const tasks = (payload as { tasks?: unknown }).tasks;
      if (!tasks || typeof tasks !== "object") return null;
      const active = (tasks as { active?: unknown }).active;
      const queued = (tasks as { queued?: unknown }).queued;
      return {
        active: Array.isArray(active) ? active.length : 0,
        queued: Array.isArray(queued) ? queued.length : 0
      };
    } catch {
      return null;
    }
  }

  artemisPython(): ResolvedPython {
    return resolveArtemisPython(this.deps.config.artemis);
  }

  /** Kill a recorded mcp_server child left behind by a dead aos-mcp instance. */
  async sweep(): Promise<string | null> {
    const state = this.deps.state.read();
    const child = state.child;
    if (!child?.pid) return null;

    const ownerAlive =
      typeof child.ownerPid === "number" &&
      child.ownerPid !== process.pid &&
      isProcessAlive(child.ownerPid);
    if (ownerAlive) return null;

    if (!isProcessAlive(child.pid)) {
      this.clearChild();
      return null;
    }

    const cmdline = processCmdline(child.pid);
    if (!cmdline || !/-m\s+mcp_server/.test(cmdline)) return null;

    await terminateProcess(child.pid, 2000);
    this.clearChild();
    return `已清理孤儿 artemis mcp_server 进程（pid=${child.pid}，owner ${child.ownerPid ?? "未知"} 已退出）`;
  }
}
