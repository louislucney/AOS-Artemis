const APP_INSTALLED = "应用已安装且可正常启动";

interface ScreenRule {
  test: RegExp;
  assumption: (screen: string) => string;
}

const SCREEN_RULES: ScreenRule[] = [
  {
    test: /登录|登陆|log\s?in|sign\s?in/i,
    assumption: (screen) => `「${screen}」需要有效账号可完成登录`
  },
  {
    test: /我的|个人中心|profile|account/i,
    assumption: (screen) => `「${screen}」需要已登录账号`
  },
  {
    test: /列表|list|feed|消息|订单|商品|购物车|cart|results?/i,
    assumption: (screen) => `「${screen}」需要已有可操作数据（列表非空）`
  }
];

export interface PreconditionOptions {
  entryFallback?: boolean;
}

/** Deterministic data/launch assumptions for one generated case: app installed,
 * entry screen reachable, plus screen-name heuristics (login / list data). */
export function deriveCasePreconditions(
  screens: string[],
  options: PreconditionOptions = {}
): string[] {
  const assumptions: string[] = [APP_INSTALLED];
  const entry = screens[0];
  if (entry) {
    assumptions.push(`开始前应用停留在「${entry}」页`);
    if (options.entryFallback) assumptions.push(`入口屏未声明：起始页按「${entry}」推断`);
  }
  for (const screen of screens) {
    for (const rule of SCREEN_RULES) {
      if (rule.test.test(screen)) assumptions.push(rule.assumption(screen));
    }
  }
  return [...new Set(assumptions)];
}
