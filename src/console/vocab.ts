import { escapeHtml } from "../util.js";

/** 机器语汇→用户语汇映射：中文展示＋title 保留原文（可追溯、可复制给 Jira/日报）。 */

const SOURCE_TOKENS: Record<string, string> = {
  "suite-run": "套件运行",
  "suite-task": "回归任务",
  "excel-import": "Excel 导入",
  cli: "CLI",
  panel: "控制台",
  schedule: "定时计划",
  runner: "执行机"
};

const SOURCE_PREFIX: Record<string, string> = {
  figma: "Figma 生成",
  pen: "pen.dev 生成",
  excel: "Excel 导入",
  schedule: "定时计划"
};

function sourceLabelText(raw: string): string {
  const token = SOURCE_TOKENS[raw];
  if (token !== undefined) return token;
  const idx = raw.indexOf(":");
  if (idx > 0) {
    const prefix = SOURCE_PREFIX[raw.slice(0, idx)];
    if (prefix !== undefined) {
      const rest = raw.slice(idx + 1).trim();
      return rest === "" ? prefix : `${prefix}（${rest}）`;
    }
  }
  return raw;
}

/** 来源（用例集 source / 批次 source / 任务 createdBy）：中文＋title 原文。 */
export function sourceHtml(source: string | null | undefined): string {
  if (source === null || source === undefined || source === "") return "—";
  return `<span title="${escapeHtml(source)}">${escapeHtml(sourceLabelText(source))}</span>`;
}

const AUDIT_DOMAINS: Record<string, string> = {
  panel: "控制台操作",
  suite: "回归运行",
  issues: "建单",
  usage: "使用统计",
  verdict: "裁决",
  import: "导入",
  export: "导出",
  schedule: "定时计划",
  runner: "执行机",
  crash: "崩溃取证",
  reconcile: "对账",
  project: "项目"
};

const AUDIT_ACTIONS: Record<string, string> = {
  "action.tasks": "派发回归任务",
  "action.hosts.register": "登记主机",
  "action.release": "释放回队列",
  "action.stop": "停止执行",
  "action.tasks.cancel": "取消任务",
  "action.rerun": "重新派发",
  "action.verdicts": "提交裁决",
  "action.issues": "建单",
  "action.schedules": "计划变更",
  "action.quarantine": "隔离变更",
  "action.export": "导出记录",
  "action.import": "导入用例文档",
  "action.error": "动作异常",
  "run.recorded": "批次登记",
  linked: "回写单号",
  "verdict.saved": "裁决写入",
  "quarantine.add": "加入隔离",
  "quarantine.remove": "移除隔离"
};

function mappedHtml(value: string, map: Record<string, string>): string {
  const label = map[value] ?? value;
  return `<span title="${escapeHtml(value)}">${escapeHtml(label)}</span>`;
}

export function auditDomainHtml(domain: string): string {
  return mappedHtml(domain, AUDIT_DOMAINS);
}

export function auditActionHtml(action: string): string {
  const label = AUDIT_ACTIONS[action];
  if (label !== undefined) return `<span title="${escapeHtml(action)}">${escapeHtml(label)}</span>`;
  if (action.startsWith("action.")) {
    return `<span title="${escapeHtml(action)}">控制台动作（${escapeHtml(action.slice("action.".length))}）</span>`;
  }
  return escapeHtml(action);
}

/** 纯文本动作标签（审计摘要等服务端文案用）。 */
export function auditActionLabel(action: string): string {
  const label = AUDIT_ACTIONS[action];
  if (label !== undefined) return label;
  if (action.startsWith("action.")) return `控制台动作（${action.slice("action.".length)}）`;
  return action;
}

export const AUDIT_DOMAIN_KEYS: Array<{ key: string; label: string }> = Object.entries(
  AUDIT_DOMAINS
).map(([key, label]) => ({ key, label }));

const ARTIFACT_KINDS: Record<string, string> = {
  run: "批次",
  "case-set": "用例集",
  report: "报告",
  diff: "差异",
  crash: "崩溃",
  trace: "轨迹"
};

export function artifactKindLabel(kind: string): string {
  return ARTIFACT_KINDS[kind] ?? kind;
}

const VERDICT_LABELS: Record<string, string> = {
  "case-defect": "案例问题",
  "execution-deviation": "执行偏差",
  "app-defect": "应用缺陷",
  uncertain: "不确定"
};

export function verdictLabel(verdict: string): string {
  return VERDICT_LABELS[verdict] ?? verdict;
}

const FAILURE_DOMAIN_LABELS: Record<string, string> = {
  "app-defect": "应用缺陷",
  "case-defect": "用例缺陷",
  environment: "环境",
  "data-environment": "数据环境",
  "behavior-design": "行为或设计",
  behavior: "行为或设计",
  "design-inference": "设计推断",
  "design-diff": "设计推断",
  unknown: "未分类",
  uncategorized: "未分类"
};

export function failureDomainLabel(domain: string): string {
  return FAILURE_DOMAIN_LABELS[domain] ?? domain;
}

export function failureDomainHtml(domain: string): string {
  return mappedHtml(domain, FAILURE_DOMAIN_LABELS);
}

const CONFIDENCE_LABELS: Record<string, string> = {
  high: "高",
  medium: "中",
  low: "低"
};

export function confidenceLabel(confidence: string): string {
  return CONFIDENCE_LABELS[confidence] ?? confidence;
}

const RUN_STATUS_LABELS: Record<string, string> = {
  passed: "通过",
  failed: "失败",
  skipped: "跳过",
  error: "错误",
  running: "执行中",
  pending: "待执行",
  partial: "部分失败",
  completed: "已完成",
  stopped: "已停止",
  cancelled: "已取消"
};

export function runStatusLabel(status: string): string {
  return RUN_STATUS_LABELS[status] ?? status;
}
