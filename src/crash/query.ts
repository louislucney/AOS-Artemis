import type { CrashSignal } from "../artemis/failure-taxonomy.js";
import type { Runtime } from "../runtime.js";

/** 崩溃签名查询（suite case-runner 与 run-report 共用；列表失败降级为空）。 */
export function crashesForTrace(runtime: Runtime, traceId: string): CrashSignal[] {
  try {
    return runtime.crashStore
      .list({ limit: 100 })
      .records.filter((record) => record.traceIds.includes(traceId))
      .map((record) => ({
        id: record.id,
        kind: record.kind,
        package: record.package,
        exceptionClass: record.exceptionClass
      }));
  } catch {
    return [];
  }
}
