/**
 * iOS 执行器模块门面（DESIGN §13.77）：对外只暴露工具入口与任务注册表读取；
 * 实现按 seam 拆分在 types / task-registry / script-plan / prompt-history /
 * verifier / failure-logs / trace-persist / run-loop / tool-entry。
 */
export { getIosTask, __resetIosTasks } from "./task-registry.js";
export { maybeIosRunTask, maybeIosManageTask } from "./tool-entry.js";
