import type { GeneratedTest } from "./test-gen.js";

const WEB_REPLACEMENTS: Array<[RegExp, string]> = [
  [/打开应用/g, "打开页面"],
  [/上一屏/g, "上一页"],
  [/下一屏/g, "下一页"],
  [/本屏/g, "本页"],
  [/屏幕/g, "页面"]
];

function webify(text: string): string {
  return WEB_REPLACEMENTS.reduce((current, [pattern, replacement]) => current.replace(pattern, replacement), text);
}

/** Web/CMS 用例：去掉 mobile_run_task 任务描述，步骤/前置改用页面措辞。 */
export function rewriteCasesForWeb(cases: GeneratedTest[]): GeneratedTest[] {
  return cases.map((testCase) => ({
    ...testCase,
    taskDesc: "",
    steps: testCase.steps.map(webify),
    prelude: testCase.prelude.map(webify),
    preconditions: testCase.preconditions.map(webify)
  }));
}
