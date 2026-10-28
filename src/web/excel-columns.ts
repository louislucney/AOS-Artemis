import { createHash } from "node:crypto";

export const CANONICAL_FIELDS = [
  "caseId",
  "name",
  "steps",
  "expected",
  "preconditions",
  "module",
  "priority",
  "testData",
  "testId"
] as const;

export type CanonicalField = (typeof CANONICAL_FIELDS)[number];

export type ExcelColumnMap = Partial<Record<CanonicalField, string>>;

/** 解析用例的最小列集合：没有编号无法去重/回写，没有步骤无法执行。 */
export const REQUIRED_CANONICAL_FIELDS: readonly CanonicalField[] = ["caseId", "steps"];

export const CANONICAL_FIELD_LABELS: Record<CanonicalField, string> = {
  caseId: "用例编号",
  name: "用例名",
  steps: "步骤",
  expected: "预期",
  preconditions: "前置条件",
  module: "模块",
  priority: "优先级",
  testData: "测试数据",
  testId: "测试编号"
};

/** 表头别名（与 `src/workflow/excel-import.ts` 共用）：同一字段的任意一种写法都能识别。 */
export const COLUMN_ALIASES: Record<CanonicalField, readonly string[]> = {
  caseId: ["用例编号", "展示编号", "用例id", "用例编码", "caseid", "displayid", "编号"],
  name: ["用例名", "用例名称", "测试用例名称", "标题", "case", "casename", "name", "title"],
  steps: ["步骤", "操作步骤", "测试步骤", "测试过程", "steps", "step", "操作"],
  expected: ["预期", "预期结果", "期望结果", "期望", "expected", "expectation", "result"],
  preconditions: ["前置", "前置条件", "前置假设", "preconditions", "precondition"],
  module: ["模块", "功能", "功能模块", "所属模块", "module", "feature"],
  priority: ["优先级", "优先", "priority", "prio"],
  testData: ["测试数据", "testdata", "data"],
  testId: ["测试编号", "测试id", "测试用例id", "用例设计id", "testid"]
};

/** 表头归一：NFKC + 去首尾空白 + 小写 + 去空白/下划线/连字符（`用例 编号`、`case_id` 等价）。 */
export function normalizeExcelHeader(value: string): string {
  return value
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "");
}

/** 按别名表自动建议映射：每个字段取第一个尚未被占用的匹配表头；匹配不到则留空。 */
export function suggestExcelMapping(headers: string[]): ExcelColumnMap {
  const normalized = headers.map(normalizeExcelHeader);
  const used = new Set<number>();
  const mapping: ExcelColumnMap = {};
  for (const field of CANONICAL_FIELDS) {
    const aliases = COLUMN_ALIASES[field].map(normalizeExcelHeader);
    for (let index = 0; index < headers.length; index += 1) {
      const key = normalized[index]!;
      if (used.has(index) || key === "" || !aliases.includes(key)) continue;
      mapping[field] = headers[index]!;
      used.add(index);
      break;
    }
  }
  return mapping;
}

/**
 * 语义指纹：工作表名 + 映射到的规范字段集合（排序）。
 * 故意不含列顺序与表头文本，列换序或个别表头写法不同不会让已保存的映射失效。
 */
export function semanticFingerprint(sheetName: string, headers: string[]): string {
  const mapping = suggestExcelMapping(headers);
  const fields = CANONICAL_FIELDS.filter((field) => mapping[field] !== undefined).sort();
  return createHash("sha256")
    .update(JSON.stringify({ sheet: sheetName.trim(), fields }))
    .digest("hex");
}
