/** 失败证据 → 接入项目必须先回答的三类问题：可用 API / 页面复用 / 重写。
 * 纯函数、只读：不判定 API 或页面是否真实存在，按证据并列给出核查方向。 */

export type IntegrationCheckCode =
  | "api"
  | "page-reuse"
  | "rewrite"
  | "environment"
  | "app-defect"
  | "case-defect"
  | "triage";

export interface IntegrationCheck {
  code: IntegrationCheckCode;
  message: string;
  caseIds: string[];
  traceIds: string[];
}

export interface IntegrationReadiness {
  needed: boolean;
  checks: IntegrationCheck[];
}

export interface IntegrationFailureInput {
  caseId?: string | null;
  traceId?: string | null;
  domain?: string | null;
  reason?: string | null;
  failedItemTexts?: string[];
  /** `false` 表示该 API 错误未被错误码注册表/断言处理。 */
  apiErrorHandled?: Array<boolean | null | undefined>;
}

export const INTEGRATION_LABELS: Record<IntegrationCheckCode, string> = {
  api: "API／数据",
  "page-reuse": "页面复用",
  rewrite: "需要重写",
  environment: "执行环境",
  "app-defect": "应用缺陷",
  "case-defect": "用例问题",
  triage: "未分类"
};

/** 检查卡的短动作句：一行说清先做什么，详情里再展开完整说明。 */
export const INTEGRATION_ACTIONS: Record<IntegrationCheckCode, string> = {
  api: "先确认可用 API 与 UAT 数据",
  "page-reuse": "对照设计确认页面／入口可复用",
  rewrite: "确认缺失后再新增或重写",
  environment: "先修执行环境，再重跑",
  "app-defect": "先修应用缺陷，再重跑",
  "case-defect": "先改用例／断言",
  triage: "人工核对证据后分类"
};

const INTEGRATION_MESSAGES: Record<IntegrationCheckCode, string> = {
  api:
    "先确认该流程所需数据能否通过现有业务 API 在目标环境准备（接口可用、权限、商品/配置已上架）；不能用真实 API 时先补 API/测试数据，不得用假数据或替代商品继续。",
  "page-reuse":
    "对照设计确认目标页面/入口/控件是否已存在并可复用（含导航路径与关闭/返回控件）；若设计有而应用无，先判定是设计未实现还是流程假设错误。",
  rewrite:
    "若现有页面/API 无法支持该流程，明确需要新增/重写哪个页面或接口，并更新设计/tests；不要继续生成依赖不存在能力的用例。",
  environment:
    "先修复执行环境（bundleId、idb/HID、WDA、设备连接）后重跑；不要把环境失败归因于应用/设计。",
  "app-defect": "先修复应用缺陷/崩溃再重跑；不要用数据或页面临时替代掩盖缺陷。",
  "case-defect": "修正用例/断言后重跑。",
  triage: "失败未分类：先人工核对证据，再决定补 API、复用页面还是重写。"
};

const INTEGRATION_ORDER: IntegrationCheckCode[] = [
  "api",
  "page-reuse",
  "rewrite",
  "environment",
  "app-defect",
  "case-defect",
  "triage"
];

const API_TEXT_RE =
  /api|接口|後端|后端|服务端|加载失败|載入失敗|订单|訂單|购物车|購物車|菜单|菜單|商品|上架|未上架|不存在|无结果|無結果|banner|广告|廣告|资源加载|資源載入|网络|網路|timeout/i;
const BEHAVIOR_TEXT_RE =
  /页面|頁面|入口|控件|按钮|按鈕|关闭|關閉|返回|元素|无法进入|無法進入|不可达|不可達|不存在|未找到|找不到|missing|not found/i;
/** 只匹配真正的执行链路故障；不要把「设备日志已采集」这类附注算作环境失败。 */
const ENVIRONMENT_TEXT_RE =
  /hid|digitizer|idb|bundleid|wda|appium|未安装|未安裝|启动失败|啟動失敗|设备连接|設備連接|设备未授权|設備未授權|设备离线|設備離線|设备不可用|設備不可用|模拟器|模擬器|隧道|tunnel|connection refused|连接失败|連線失敗/i;

export function integrationReadinessFromFailures(
  failures: IntegrationFailureInput[]
): IntegrationReadiness {
  const refs = new Map<IntegrationCheckCode, { caseIds: string[]; traceIds: string[] }>();
  const add = (code: IntegrationCheckCode, failure: IntegrationFailureInput): void => {
    const entry = refs.get(code) ?? { caseIds: [], traceIds: [] };
    const caseId = failure.caseId?.trim() ?? "";
    if (caseId !== "" && !entry.caseIds.includes(caseId)) entry.caseIds.push(caseId);
    const traceId = failure.traceId?.trim() ?? "";
    if (traceId !== "" && !entry.traceIds.includes(traceId)) entry.traceIds.push(traceId);
    refs.set(code, entry);
  };

  for (const failure of failures) {
    const domain = failure.domain ?? "unclassified";
    const text = [failure.reason ?? "", ...(failure.failedItemTexts ?? [])].join(" ");
    const explicitEnvironment = domain === "environment";
    const explicitApi =
      domain === "data-environment" ||
      domain === "api-error" ||
      (failure.apiErrorHandled ?? []).some((handled) => handled === false);
    const explicitBehavior =
      domain === "behavior-or-design" || domain === "design-inference";
    const environment =
      explicitEnvironment ||
      (!explicitApi && !explicitBehavior && ENVIRONMENT_TEXT_RE.test(text));
    const appDefect = domain === "app-defect";
    const api =
      !environment &&
      !appDefect &&
      (explicitApi || API_TEXT_RE.test(text));
    const behavior =
      !environment &&
      !appDefect &&
      (explicitBehavior || BEHAVIOR_TEXT_RE.test(text));

    if (api) add("api", failure);
    if (behavior) {
      add("page-reuse", failure);
      add("rewrite", failure);
    }
    if (environment) add("environment", failure);
    if (appDefect) add("app-defect", failure);
    if (domain === "case-defect") add("case-defect", failure);
    if (!api && !behavior && !environment && !appDefect && domain !== "case-defect") {
      add("triage", failure);
    }
  }

  const checks = INTEGRATION_ORDER.filter((code) => refs.has(code)).map((code) => {
    const entry = refs.get(code)!;
    return {
      code,
      message: INTEGRATION_MESSAGES[code],
      caseIds: entry.caseIds,
      traceIds: entry.traceIds
    };
  });
  return { needed: checks.length > 0, checks };
}
