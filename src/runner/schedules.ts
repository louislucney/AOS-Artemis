import type { ProjectStore } from "../db/types.js";
import { latestFeatureRefs, type ResolvedTaskRef } from "../tasks/feature-refs.js";
import { errorMessage } from "../util.js";

export interface FireSchedulesOptions {
  store: ProjectStore;
  rootPath: string;
  now?: () => number;
  io?: { log: (line: string) => void; errorLog: (line: string) => void };
}

/** 检查到期调度：CAS 赢窗口 → 实时解析最新份 → 建回归任务；返回新建任务数。
 * best-effort：任何异常仅告警，不抛出；CAS 败（他 runner 已领）静默跳过。 */
export async function fireDueSchedules(options: FireSchedulesOptions): Promise<number> {
  const nowMs = (options.now ?? (() => Date.now()))();
  const io = options.io ?? {
    log: (line: string): void => console.log(line),
    errorLog: (line: string): void => console.error(line)
  };
  let fired = 0;
  try {
    const schedules = await options.store.listSchedules(options.rootPath);
    const due = schedules.filter(
      (schedule) =>
        schedule.enabled &&
        (schedule.lastFiredAt === null ||
          Date.parse(schedule.lastFiredAt) <= nowMs - schedule.everyMinutes * 60_000)
    );
    if (due.length === 0) return 0;

    let sets: Awaited<ReturnType<ProjectStore["listCaseSets"]>>;
    try {
      sets = await options.store.listCaseSets(options.rootPath, 50);
    } catch (error) {
      io.errorLog(`[schedule] 用例集读取失败（本轮不触发、不消费窗口）：${errorMessage(error)}`);
      return 0;
    }
    const latest = latestFeatureRefs(sets);

    for (const schedule of due) {
      const firedAt = new Date(nowMs).toISOString();
      const cutoff = new Date(nowMs - schedule.everyMinutes * 60_000).toISOString();
      const won = await options.store.claimScheduleWindow({
        rootPath: options.rootPath,
        scheduleId: schedule.id,
        firedAt,
        cutoff
      });
      if (!won) continue;

      const refs: ResolvedTaskRef[] = [];
      const missing: string[] = [];
      for (const key of schedule.featureKeys) {
        const hit = latest.get(key);
        if (hit) refs.push(hit);
        else missing.push(key);
      }

      if (refs.length === 0) {
        io.errorLog(
          `[schedule] ${schedule.name}：引用份均不可用（${missing.join(",")}），跳过本次`
        );
        await safeUpdateNote(options, schedule.id, "引用份均不可用", io);
        continue;
      }

      try {
        const task = await options.store.createRegressionTask({
          rootPath: options.rootPath,
          refs: refs.map((ref) => ({ caseSetId: ref.caseSetId, featureKey: ref.featureKey })),
          platforms: [...schedule.platforms],
          baseline: schedule.baseline,
          createdBy: `schedule:${schedule.name}`
        });
        fired += 1;
        io.log(`[schedule] 触发 ${schedule.name} → 任务 ${task.id}`);
        await safeUpdateNote(
          options,
          schedule.id,
          missing.length > 0 ? `缺 ${missing.join(",")}` : null,
          io
        );
        if (missing.length > 0) {
          io.errorLog(
            `[schedule] ${schedule.name}：部分引用缺失（${missing.join(",")}），已用可解析子集建任务`
          );
        }
      } catch (error) {
        io.errorLog(`[schedule] ${schedule.name} 触发失败：${errorMessage(error)}`);
        await safeUpdateNote(options, schedule.id, `触发失败：${errorMessage(error)}`, io);
      }
    }
    return fired;
  } catch (error) {
    io.errorLog(`[schedule] 调度检查失败：${errorMessage(error)}`);
    return fired;
  }
}

async function safeUpdateNote(
  options: FireSchedulesOptions,
  scheduleId: string,
  note: string | null,
  io: { errorLog: (line: string) => void }
): Promise<void> {
  try {
    await options.store.updateSchedule(options.rootPath, scheduleId, { lastNote: note });
  } catch (error) {
    io.errorLog(`[schedule] lastNote 写入失败：${errorMessage(error)}`);
  }
}
