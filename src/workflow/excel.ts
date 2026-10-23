import fs from "node:fs/promises";
import path from "node:path";

import ExcelJS from "exceljs";

export interface ExecutorRow {
  caseId: string;
  displayId: string;
  humanStepsHash: string;
  taskDesc: string;
  designRefs: string;
}

export interface CaseSheet {
  headers: string[];
  rows: string[][];
  /** 隐藏「执行器」sheet（生成工作簿专有）；普通导入工作簿为空。 */
  executor: Map<string, ExecutorRow>;
}

const MAX_ROWS = 10000;
const MAX_COLUMNS = 200;

function cellText(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== "object") return String(value).trim();
  const record = value as unknown as Record<string, unknown>;
  const rich = record.richText;
  if (Array.isArray(rich)) {
    return rich
      .map((part) => {
        if (part === null || typeof part !== "object") return "";
        const text = (part as { text?: unknown }).text;
        return typeof text === "string" ? text : "";
      })
      .join("")
      .trim();
  }
  if (typeof record.text === "string") return record.text.trim();
  if ("result" in record) return cellText(record.result as ExcelJS.CellValue);
  if (typeof record.error === "string") return record.error.trim();
  return String(value).trim();
}

/** 读取测试用例表（首个工作表）。结构不可靠时显式失败，绝不静默错读。 */
export async function readCaseSheet(filePath: string): Promise<CaseSheet> {
  if (path.extname(filePath).toLowerCase() !== ".xlsx") {
    throw new Error(`无法导入：仅支持 .xlsx 工作簿（请另存为 Excel 2007+ 格式后重试）：${filePath}`);
  }
  const buffer = await fs.readFile(filePath);
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(buffer as unknown as Parameters<typeof workbook.xlsx.load>[0]);
  } catch (error) {
    throw new Error(`无法读取工作簿（文件损坏或不是有效的 .xlsx）：${filePath}`, { cause: error });
  }
  const sheet = workbook.worksheets[0];
  if (!sheet) throw new Error(`工作簿没有工作表：${filePath}`);
  const merges = (sheet.model?.merges ?? []) as string[];
  if (merges.length > 0) {
    throw new Error(
      `工作表含合并单元格（${merges.slice(0, 3).join("、")}${merges.length > 3 ? " 等" : ""}）：` +
        "请取消合并后重新保存为 .xlsx 再导入"
    );
  }
  const rowCount = sheet.rowCount ?? 0;
  const columnCount = sheet.columnCount ?? 0;
  if (rowCount < 1 || columnCount < 1) throw new Error(`工作表为空：${filePath}`);
  if (rowCount > MAX_ROWS || columnCount > MAX_COLUMNS) {
    throw new Error(
      `工作表维度异常（${rowCount} 行 × ${columnCount} 列，上限 ${MAX_ROWS} 行 × ${MAX_COLUMNS} 列）：` +
        "请拆分测试用例表后重试"
    );
  }
  const headers: string[] = [];
  for (let column = 1; column <= columnCount; column += 1) {
    headers.push(cellText(sheet.getRow(1).getCell(column).value));
  }
  if (headers.every((header) => header === "")) {
    throw new Error(`工作表缺少表头（第一行为空）：请在第一行填写列名（如：用例名、步骤、预期）`);
  }
  const rows: string[][] = [];
  for (let rowNumber = 2; rowNumber <= rowCount; rowNumber += 1) {
    const row = sheet.getRow(rowNumber);
    const cells: string[] = [];
    for (let column = 1; column <= columnCount; column += 1) {
      cells.push(cellText(row.getCell(column).value));
    }
    rows.push(cells);
  }
  while (rows.length > 0 && rows[rows.length - 1]!.every((cell) => cell === "")) {
    rows.pop();
  }
  return { headers, rows, executor: readExecutor(sheet.workbook) };
}

function readExecutor(workbook: ExcelJS.Workbook): Map<string, ExecutorRow> {
  const result = new Map<string, ExecutorRow>();
  const sheet = workbook.worksheets.find((candidate) => candidate.name.trim() === "执行器");
  if (!sheet) return result;
  const headers: string[] = [];
  for (let column = 1; column <= sheet.columnCount; column += 1) {
    headers.push(normalizeHeader(cellText(sheet.getRow(1).getCell(column).value)));
  }
  const indexOf = (...aliases: string[]): number => {
    const normalized = aliases.map(normalizeHeader);
    return headers.findIndex((header) => normalized.includes(header));
  };
  const caseIdIndex = indexOf("用例编号", "caseid");
  const displayIdIndex = indexOf("展示编号", "displayid");
  const hashIndex = indexOf("人类步骤哈希", "humanstepshash");
  const taskIndex = indexOf("artemis任务描述", "taskdesc", "artemis 任务描述");
  const refsIndex = indexOf("设计引用", "designrefs");
  if (taskIndex < 0) return result;
  for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber += 1) {
    const row = sheet.getRow(rowNumber);
    const value = (index: number): string => (index < 0 ? "" : cellText(row.getCell(index + 1).value));
    const displayId = value(displayIdIndex);
    const caseId = value(caseIdIndex);
    if (displayId === "" && caseId === "") continue;
    const entry: ExecutorRow = {
      caseId,
      displayId,
      humanStepsHash: value(hashIndex),
      taskDesc: value(taskIndex),
      designRefs: value(refsIndex)
    };
    if (displayId !== "") result.set(`display:${displayId}`, entry);
    if (caseId !== "") result.set(`case:${caseId}`, entry);
  }
  return result;
}

function normalizeHeader(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, "").replace(/[\s_-]+/g, "");
}
