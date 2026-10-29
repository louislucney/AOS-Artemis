import { mkdir, open, readFile, stat } from "node:fs/promises";
import path from "node:path";

import ExcelJS from "exceljs";

import { writeFileAtomic } from "../util.js";

export const CSV_SHEET_NAME = "csv";

/** CSV→XLSX 与 xlsx 解析共享的维度上限：转换前先判，避免 ExcelJS 物化百万行。 */
export const SHEET_MAX_ROWS = 10000;
export const SHEET_MAX_COLUMNS = 200;

export type CsvEncoding = "utf-8" | "gb18030";

export type CsvLineEnding = "\n" | "\r\n";

export const CSV_ENCODINGS: readonly CsvEncoding[] = ["utf-8", "gb18030"];

export interface DecodedCsv {
  text: string;
  encoding: CsvEncoding;
  /** 输入带 UTF-8 BOM（正文已剥离 BOM）。GB18030 恒为 false。 */
  bom: boolean;
}

export type CsvErrorCode = "unterminated-quote" | "unsupported-encoding" | "too-large";

export class CsvError extends Error {
  readonly code: CsvErrorCode;

  constructor(code: CsvErrorCode, message: string) {
    super(message);
    this.name = "CsvError";
    this.code = code;
  }
}

export type CsvExportErrorCode =
  | "same-path"
  | "output-exists"
  | "read-failed"
  | "write-failed"
  | "invalid-workbook"
  | "sheet-not-found"
  | "unencodable"
  | "invalid-option";

export class CsvExportError extends Error {
  readonly code: CsvExportErrorCode;

  constructor(code: CsvExportErrorCode, message: string) {
    super(message);
    this.name = "CsvExportError";
    this.code = code;
  }
}

const UTF8_BOM = [0xef, 0xbb, 0xbf] as const;

function hasUtf8Bom(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 3 &&
    bytes[0] === UTF8_BOM[0] &&
    bytes[1] === UTF8_BOM[1] &&
    bytes[2] === UTF8_BOM[2]
  );
}

function isZipMagic(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === 0x50 && bytes[1] === 0x4b;
}

function stripTextBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function tryDecodeUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function isUtf16Bom(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 2 &&
    ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff))
  );
}

function assertSupportedBytes(bytes: Uint8Array): void {
  if (isUtf16Bom(bytes)) {
    throw new CsvError(
      "unsupported-encoding",
      "CSV 是 UTF-16 编码（检测到 UTF-16 BOM）：请另存为 UTF-8 或 GB18030 后重试"
    );
  }
  if (bytes.includes(0)) {
    throw new CsvError(
      "unsupported-encoding",
      "CSV 含 NUL 字节（可能是 UTF-16 或无 BOM 的二进制）：请另存为 UTF-8 或 GB18030 后重试"
    );
  }
}

/**
 * 编码识别固定顺序：UTF-8 BOM → 合法 UTF-8 → GB18030。GB18030 是中文 CSV 的常见
 * 导出编码（Excel 简体中文默认），用 TextDecoder 解码，不做有损替换以外的转换。
 * UTF-16 BOM / NUL 字节在解码前显式拒绝，避免把 UTF-16 误当 GB18030 读出乱码。
 */
export function decodeCsv(input: Buffer | Uint8Array): DecodedCsv {
  const bytes = input;
  assertSupportedBytes(bytes);
  const bom = hasUtf8Bom(bytes);
  const body = bom ? bytes.subarray(3) : bytes;
  const utf8 = tryDecodeUtf8(body);
  if (utf8 !== null) {
    return { text: stripTextBom(utf8), encoding: "utf-8", bom };
  }
  const gb = new TextDecoder("gb18030").decode(body);
  return { text: stripTextBom(gb), encoding: "gb18030", bom: false };
}

/**
 * 内容嗅探：不是 zip（xlsx）、无 NUL 字节、且首行含逗号时按 CSV 处理。
 * `parseExcel` 只拿到 Buffer，没有文件名可依，靠这个启发式区分 CSV 与损坏的 xlsx；
 * 单列 CSV（没有逗号）会被当作损坏工作簿拒绝，这是刻意取舍。
 */
export function looksLikeCsv(input: Buffer | Uint8Array): boolean {
  if (input.length === 0 || isZipMagic(input)) return false;
  let text: string;
  try {
    text = decodeCsv(input).text;
  } catch {
    return false;
  }
  if (text.trim() === "") return false;
  const firstLine = text.split(/\r\n|\n|\r/, 1)[0] ?? "";
  return firstLine.includes(",");
}

export interface CsvParseLimits {
  maxRows?: number;
  maxColumns?: number;
}

function tooLarge(rows: number, columns: number, limits: CsvParseLimits): CsvError {
  const maxRows = limits.maxRows ?? SHEET_MAX_ROWS;
  const maxColumns = limits.maxColumns ?? SHEET_MAX_COLUMNS;
  return new CsvError(
    "too-large",
    `工作表维度异常（${rows} 行 × ${columns} 列，上限 ${maxRows} 行 × ${maxColumns} 列）：请拆表后重试`
  );
}

/**
 * RFC4180 解析：引号字段可含逗号/换行/转义引号（`""`）；CRLF、LF 与单独 CR 都当行尾。
 * 全空行保留为 `[""]`（行号与源文件一致）；文件末尾换行不额外产生空行。
 * 传 `maxRows`/`maxColumns` 时边解析边判，超限立即抛 `too-large`（不先建完整二维表）。
 */
export function parseCsv(text: string, limits: CsvParseLimits = {}): string[][] {
  if (text === "") return [];
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let atFieldStart = true;
  let lastWasRowEnd = false;
  let parsedMaxColumns = 0;

  const pushField = (): void => {
    row.push(field);
    field = "";
    atFieldStart = true;
    parsedMaxColumns = Math.max(parsedMaxColumns, row.length);
    if (limits.maxColumns !== undefined && row.length > limits.maxColumns) {
      throw tooLarge(rows.length + 1, row.length, limits);
    }
  };
  const pushRow = (): void => {
    pushField();
    rows.push(row);
    row = [];
    if (limits.maxRows !== undefined && rows.length > limits.maxRows) {
      throw tooLarge(rows.length, parsedMaxColumns, limits);
    }
  };

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (inQuotes) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === ",") {
      pushField();
      lastWasRowEnd = false;
      continue;
    }
    if (char === "\r" || char === "\n") {
      if (char === "\r" && text[index + 1] === "\n") index += 1;
      pushRow();
      lastWasRowEnd = true;
      continue;
    }
    if (char === '"' && atFieldStart) {
      inQuotes = true;
      atFieldStart = false;
      lastWasRowEnd = false;
      continue;
    }
    field += char;
    atFieldStart = false;
    lastWasRowEnd = false;
  }

  if (inQuotes) {
    throw new CsvError("unterminated-quote", "CSV 存在未闭合的引号：请检查文件末尾");
  }
  if (!lastWasRowEnd || field !== "" || row.length > 0) pushRow();
  return rows;
}

function encodeGb18030(text: string): Buffer {
  const table = gb18030Table();
  const bytes: number[] = [];
  for (const char of text) {
    const codePoint = char.codePointAt(0)!;
    if (codePoint <= 0x7f) {
      bytes.push(codePoint);
      continue;
    }
    const mapped = table.get(char);
    if (mapped !== undefined) {
      bytes.push(...mapped);
      continue;
    }
    if (codePoint >= 0x10000 && codePoint <= 0x10ffff) {
      // GB18030 四字节区对补充平面线性映射：U+10000 起 index 189000，逐码点递增。
      bytes.push(...gb18030FourByte(codePoint - 0x10000 + 189000));
      continue;
    }
    throw new CsvExportError(
      "unencodable",
      `GB18030 无法表示字符 U+${codePoint.toString(16).toUpperCase()}` +
        (codePoint >= 0xd800 && codePoint <= 0xdfff ? "（孤立代理项）" : `「${char}」`)
    );
  }
  return Buffer.from(bytes);
}

function gb18030FourByte(index: number): [number, number, number, number] {
  const byte4 = 0x30 + (index % 10);
  index = Math.floor(index / 10);
  const byte3 = 0x81 + (index % 126);
  index = Math.floor(index / 126);
  const byte2 = 0x30 + (index % 10);
  index = Math.floor(index / 10);
  return [0x81 + index, byte2, byte3, byte4];
}

/** BMP 四字节区 index 上限（0x8431A439）；189000 起是补充平面线性区。 */
const GB18030_BMP_FOUR_BYTE_MAX = 39419;

let gbTableCache: Map<string, readonly number[]> | null = null;

/**
 * 用 GB18030 解码器反向枚举编码空间：先双字节区（约 2.4 万项，规范优先），
 * 再 BMP 四字节区（0..39419，约 12ms），首次编码时建表并缓存。
 */
function gb18030Table(): Map<string, readonly number[]> {
  if (gbTableCache !== null) return gbTableCache;
  const table = new Map<string, readonly number[]>();
  const decoder = new TextDecoder("gb18030", { fatal: true });
  for (let lead = 0x81; lead <= 0xfe; lead += 1) {
    for (let trail = 0x40; trail <= 0xfe; trail += 1) {
      if (trail === 0x7f) continue;
      let decoded: string;
      try {
        decoded = decoder.decode(Uint8Array.from([lead, trail]));
      } catch {
        continue;
      }
      if (decoded.length !== 1 || decoded === "\ufffd" || table.has(decoded)) continue;
      table.set(decoded, [lead, trail]);
    }
  }
  for (let index = 0; index <= GB18030_BMP_FOUR_BYTE_MAX; index += 1) {
    const encoded = gb18030FourByte(index);
    let decoded: string;
    try {
      decoded = decoder.decode(Uint8Array.from(encoded));
    } catch {
      continue;
    }
    if (decoded.length !== 1 || table.has(decoded)) continue;
    table.set(decoded, encoded);
  }
  gbTableCache = table;
  return table;
}

function quoteCsvField(value: string): string {
  if (!/[",\r\n]/.test(value)) return value;
  return `"${value.replaceAll('"', '""')}"`;
}

export interface CsvEncodeOptions {
  encoding?: CsvEncoding;
  lineEnding?: CsvLineEnding;
  /** 仅 UTF-8 生效：在文件头写 EF BB BF；GB18030 + `bom:true` 抛 invalid-option。 */
  bom?: boolean;
}

export function encodeCsv(
  rows: readonly (readonly string[])[],
  options: CsvEncodeOptions = {}
): Buffer {
  const encoding = options.encoding ?? "utf-8";
  const lineEnding = options.lineEnding ?? "\n";
  if (!CSV_ENCODINGS.includes(encoding)) {
    throw new CsvExportError("invalid-option", `未知 CSV 编码：${String(encoding)}`);
  }
  if (lineEnding !== "\n" && lineEnding !== "\r\n") {
    throw new CsvExportError(
      "invalid-option",
      `未知行尾：${JSON.stringify(lineEnding)}（仅支持 \\n、\\r\\n）`
    );
  }
  if (encoding === "gb18030" && options.bom === true) {
    throw new CsvExportError("invalid-option", "GB18030 不支持 BOM；如需 BOM 请使用 UTF-8");
  }
  const text =
    rows.length === 0
      ? ""
      : `${rows.map((row) => row.map(quoteCsvField).join(",")).join(lineEnding)}${lineEnding}`;
  if (encoding === "gb18030") return encodeGb18030(text);
  const body = Buffer.from(text, "utf8");
  return options.bom === true ? Buffer.concat([Buffer.from(UTF8_BOM), body]) : body;
}

export interface CsvWorkbook {
  buffer: Buffer;
  sheetName: string;
  encoding: CsvEncoding;
  bom: boolean;
  rows: number;
  columns: number;
}

/** CSV → 内存 XLSX：单工作表 `csv`，所有行/列按字符串写入（`001` 不退化成数字）。 */
export async function csvToXlsxBuffer(input: Buffer | Uint8Array): Promise<CsvWorkbook> {
  const decoded = decodeCsv(input);
  const rows = parseCsv(decoded.text, {
    maxRows: SHEET_MAX_ROWS,
    maxColumns: SHEET_MAX_COLUMNS
  });
  const columns = rows.reduce((max, row) => Math.max(max, row.length), 0);
  if (rows.length > SHEET_MAX_ROWS || columns > SHEET_MAX_COLUMNS) {
    throw tooLarge(rows.length, columns, {});
  }
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(CSV_SHEET_NAME);
  for (const row of rows) sheet.addRow([...row]);
  return {
    buffer: Buffer.from(await workbook.xlsx.writeBuffer()),
    sheetName: CSV_SHEET_NAME,
    encoding: decoded.encoding,
    bom: decoded.bom,
    rows: rows.length,
    columns
  };
}

function valueToText(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== "object") return String(value);
  const record = value as unknown as Record<string, unknown>;
  const rich = record.richText;
  if (Array.isArray(rich)) {
    return rich
      .map((part) => {
        if (part === null || typeof part !== "object") return "";
        const text = (part as { text?: unknown }).text;
        return typeof text === "string" ? text : "";
      })
      .join("");
  }
  if (typeof record.text === "string") return record.text;
  if (record.result !== undefined && record.result !== null) {
    return valueToText(record.result as ExcelJS.CellValue);
  }
  if (typeof record.error === "string") return record.error;
  return "";
}

function readCellText(cell: ExcelJS.Cell): string {
  const formulaType = cell.formulaType;
  if (formulaType === ExcelJS.FormulaType.Master || formulaType === ExcelJS.FormulaType.Shared) {
    return valueToText(cell.result as ExcelJS.CellValue);
  }
  return valueToText(cell.value);
}

export interface CsvExportOptions {
  encoding?: CsvEncoding;
  lineEnding?: CsvLineEnding;
  /** UTF-8 BOM；GB18030 + `bom:true` 抛 invalid-option。 */
  bom?: boolean;
  /** 缺省第一张表。 */
  sheetName?: string;
  /** 缺省 false：输出已存在时拒绝，避免覆盖上一次结果。 */
  overwrite?: boolean;
  /** 原件（只读 CSV）路径；与输出相同时同样拒绝。 */
  originalPath?: string;
}

export interface CsvExportResult {
  outPath: string;
  sheetName: string;
  encoding: CsvEncoding;
  lineEnding: CsvLineEnding;
  bom: boolean;
  rows: number;
  columns: number;
}

/**
 * 工作副本（xlsx）→ 新的结果 CSV 文件：只写 `outPath`，绝不改写工作副本与原件；
 * 跳过隐藏列，公式取缓存值，按 RFC4180 引用，编码/行尾按请求保留。
 */
export async function exportWorkbookCsv(
  workbookPath: string,
  outPath: string,
  options: CsvExportOptions = {}
): Promise<CsvExportResult> {
  const source = path.resolve(workbookPath);
  const out = path.resolve(outPath);
  if (source === out) {
    throw new CsvExportError("same-path", `CSV 输出不能是工作副本本身：${out}`);
  }
  if (options.originalPath !== undefined && path.resolve(options.originalPath) === out) {
    throw new CsvExportError("same-path", `CSV 输出不能覆盖原件：${out}`);
  }
  const encoding = options.encoding ?? "utf-8";
  const lineEnding = options.lineEnding ?? "\n";
  if (!CSV_ENCODINGS.includes(encoding)) {
    throw new CsvExportError("invalid-option", `未知 CSV 编码：${String(encoding)}`);
  }
  if (lineEnding !== "\n" && lineEnding !== "\r\n") {
    throw new CsvExportError(
      "invalid-option",
      `未知行尾：${JSON.stringify(lineEnding)}（仅支持 \\n、\\r\\n）`
    );
  }
  if (encoding === "gb18030" && options.bom === true) {
    throw new CsvExportError("invalid-option", "GB18030 不支持 BOM；如需 BOM 请使用 UTF-8");
  }
  if (options.overwrite !== true) {
    try {
      const info = await stat(out);
      throw new CsvExportError(
        "output-exists",
        info.isDirectory() ? `CSV 输出路径是目录（不覆盖）：${out}` : `CSV 输出已存在（不覆盖）：${out}`
      );
    } catch (error) {
      if (error instanceof CsvExportError) throw error;
    }
  }

  let buffer: Buffer;
  try {
    buffer = await readFile(source);
  } catch (error) {
    throw new CsvExportError(
      "read-failed",
      `工作副本不可读：${source}（${error instanceof Error ? error.message : String(error)}）`
    );
  }
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(buffer as unknown as Parameters<typeof workbook.xlsx.load>[0]);
  } catch (error) {
    throw new CsvExportError(
      "invalid-workbook",
      `无法读取工作副本（不是有效的 .xlsx）：${error instanceof Error ? error.message : String(error)}`
    );
  }
  const wanted = options.sheetName?.trim() ?? "";
  const sheet =
    wanted === ""
      ? workbook.worksheets[0]
      : workbook.worksheets.find((candidate) => candidate.name.trim() === wanted);
  if (sheet === undefined) {
    throw new CsvExportError(
      "sheet-not-found",
      wanted === ""
        ? "工作簿没有工作表"
        : `工作表不存在：${options.sheetName}；当前工作表：${workbook.worksheets.map((item) => item.name).join("、")}`
    );
  }

  const columns: number[] = [];
  const columnCount = sheet.columnCount ?? 0;
  for (let column = 1; column <= columnCount; column += 1) {
    if (sheet.getColumn(column).hidden) continue;
    columns.push(column);
  }
  const rowCount = sheet.rowCount ?? 0;
  const rows: string[][] = [];
  for (let rowNumber = 1; rowNumber <= rowCount; rowNumber += 1) {
    const row = sheet.getRow(rowNumber);
    rows.push(columns.map((column) => readCellText(row.getCell(column))));
  }

  const data = encodeCsv(rows, {
    encoding,
    lineEnding,
    ...(options.bom === undefined ? {} : { bom: options.bom })
  });
  await mkdir(path.dirname(out), { recursive: true });
  if (options.overwrite === true) {
    try {
      writeFileAtomic(out, data);
    } catch (error) {
      throw new CsvExportError(
        "write-failed",
        `CSV 写入失败：${out}（${error instanceof Error ? error.message : String(error)}）`
      );
    }
  } else {
    let handle: Awaited<ReturnType<typeof open>> | null = null;
    try {
      handle = await open(out, "wx");
      await handle.writeFile(data);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new CsvExportError("output-exists", `CSV 输出已存在（不覆盖）：${out}`);
      }
      throw new CsvExportError(
        "write-failed",
        `CSV 写入失败：${out}（${error instanceof Error ? error.message : String(error)}）`
      );
    } finally {
      await handle?.close();
    }
  }

  return {
    outPath: out,
    sheetName: sheet.name,
    encoding,
    lineEnding,
    bom: encoding === "utf-8" && options.bom === true,
    rows: rows.length,
    columns: columns.length
  };
}
