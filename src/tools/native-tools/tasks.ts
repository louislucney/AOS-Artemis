import os from "node:os";

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import type { NativeToolDefinition } from "./types.js";

function jsonResult(payload: unknown, isError = false): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    ...(isError ? { isError: true } : {})
  };
}

function actorFromEnv(): string {
  const raw = (process.env.AOS_ACTOR ?? "").trim();
  if (raw !== "") return raw;
  try {
    return os.userInfo().username;
  } catch {
    return "unknown";
  }
}

function foreignHost(taskHostId: string | null, localHostId: string | null): string | null {
  if (taskHostId === null || taskHostId === localHostId) return null;
  return taskHostId;
}

export const TASK_NATIVE_TOOLS: NativeToolDefinition[] = [
  {
    name: "regression_task_cancel",
    description:
      "取消本机当前项目下的回归任务（作用域＝本机 + 本项目）：pending → cancelled；claimed/running → stopping（等执行机确认）。记录来源 local-mcp、操作人（AOS_ACTOR 或系统用户名）与本机 hostId。定向/认领给其他主机的任务拒绝取消。",
    schema: z.object({
      taskId: z.string().min(1).describe("回归任务 id"),
      note: z.string().max(500).optional().describe("取消备注（可选，≤500 字符）")
    }),
    handler: async (runtime, args) => {
      const taskId = String(args.taskId);
      const note = typeof args.note === "string" ? args.note : undefined;
      const rootPath = runtime.project.rootDir;
      const hostId = runtime.hostIdentity?.id ?? null;
      const task = await runtime.store.getRegressionTask(rootPath, taskId);
      if (!task) {
        return jsonResult({ ok: false, error: `未找到回归任务 ${taskId}` }, true);
      }
      const targetHostId = foreignHost(task.targetHostId, hostId);
      if (targetHostId !== null) {
        return jsonResult(
          {
            ok: false,
            error: `任务 ${taskId} 不属于本机（目标主机 ${targetHostId}），拒绝取消`
          },
          true
        );
      }
      const claimedHostId = foreignHost(task.claimedHostId, hostId);
      if (claimedHostId !== null) {
        return jsonResult(
          {
            ok: false,
            error: `任务 ${taskId} 不属于本机（认领主机 ${claimedHostId}），拒绝取消`
          },
          true
        );
      }
      const actor = actorFromEnv();
      const cancelled = await runtime.store.cancelRegressionTask({
        rootPath,
        taskId,
        source: "local-mcp",
        actor,
        actorHostId: hostId,
        note: note ?? null
      });
      if (!cancelled) {
        return jsonResult({ ok: false, error: `未找到回归任务 ${taskId}` }, true);
      }
      try {
        await runtime.store.recordAudit(rootPath, {
          domain: "task",
          action: "task.cancel",
          result: "ok",
          summary: `任务 ${taskId} 由 ${actor} 在 ${hostId ?? "未绑定主机"} 取消`,
          refs: { taskId, source: "local-mcp", hostId: hostId ?? undefined },
          actor,
          actorHostId: hostId,
          channel: "mcp"
        });
      } catch {
        /* audit is best-effort */
      }
      return jsonResult({ ok: true, task: cancelled });
    }
  }
];
