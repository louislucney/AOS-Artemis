/** 真实数据硬约束（强限制）：所有测试用例必须声明——数据只能经被测应用的
 * 真实请求链路（界面操作或其后端 API 请求）准备，禁止伪造/写死页面或数据；
 * `figma_generate_tests` 把该条款注入每个 taskDesc，`suite check` 以标记做
 * 硬门禁（缺标记 = 不是受管生成物，禁止进 CI）。 */
export const REAL_DATA_MARKER = "【真实数据】";

export const REAL_DATA_CLAUSE =
  `${REAL_DATA_MARKER}数据必须经被测应用的真实请求链路准备（界面操作或其后端 API 请求），` +
  "禁止伪造/写死页面或数据（禁止 mock、手造页面、跳过真实请求）；" +
  "无法通过真实链路满足数据或进入目标页时，停止并报告 blocked（说明缺失的数据与接口），不得以假数据继续。";

export function hasRealDataPolicy(taskDesc: string | null | undefined): boolean {
  return typeof taskDesc === "string" && taskDesc.includes(REAL_DATA_MARKER);
}
