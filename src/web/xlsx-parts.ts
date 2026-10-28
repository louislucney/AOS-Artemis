/**
 * 最小 ZIP 中央目录读取：只列 entry 名，不解压、不依赖第三方库。
 * 用途：写回前拒绝 exceljs 无法安全往返的对象（图表/透视/宏/切片器/ActiveX），
 * 写回后比对 parts 清单，发现未知 part 丢失即拒绝交付。
 */
export class XlsxPartsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "XlsxPartsError";
  }
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const EOCD_MIN_BYTES = 22;
const MAX_COMMENT_BYTES = 0xffff;

function normalizePartName(raw: string): string {
  return raw.replace(/\\/g, "/").replace(/^\/+/, "");
}

function findEndOfCentralDirectory(buffer: Buffer): number {
  if (buffer.length < EOCD_MIN_BYTES) {
    throw new XlsxPartsError("不是有效的 ZIP（文件过短）");
  }
  const earliest = Math.max(0, buffer.length - EOCD_MIN_BYTES - MAX_COMMENT_BYTES);
  for (let offset = buffer.length - EOCD_MIN_BYTES; offset >= earliest; offset -= 1) {
    if (buffer.readUInt32LE(offset) === EOCD_SIGNATURE) return offset;
  }
  throw new XlsxPartsError("不是有效的 ZIP（找不到中央目录结尾）");
}

/** 读取中央目录的 entry 名列表（目录 entry 被忽略）。损坏/不支持 Zip64 时抛 `XlsxPartsError`。 */
export function readXlsxParts(buffer: Buffer): string[] {
  const eocd = findEndOfCentralDirectory(buffer);
  const entryCount = buffer.readUInt16LE(eocd + 10);
  const directorySize = buffer.readUInt32LE(eocd + 12);
  const directoryOffset = buffer.readUInt32LE(eocd + 16);
  if (
    entryCount === 0xffff ||
    directorySize === 0xffffffff ||
    directoryOffset === 0xffffffff
  ) {
    throw new XlsxPartsError("暂不支持 Zip64 工作簿");
  }
  if (directoryOffset + directorySize > buffer.length) {
    throw new XlsxPartsError("ZIP 中央目录越界（文件可能被截断）");
  }

  const parts: string[] = [];
  let offset = directoryOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== CENTRAL_SIGNATURE) {
      throw new XlsxPartsError("ZIP 中央目录损坏");
    }
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const nameStart = offset + 46;
    const nameEnd = nameStart + nameLength;
    if (nameEnd > buffer.length) throw new XlsxPartsError("ZIP entry 名越界（文件可能被截断）");
    const name = normalizePartName(buffer.toString("utf8", nameStart, nameEnd));
    if (name !== "" && !name.endsWith("/")) parts.push(name);
    offset = nameEnd + extraLength + commentLength;
  }
  return parts;
}

const UNSUPPORTED_PREFIXES = [
  "xl/charts/",
  "xl/pivottables/",
  "xl/pivotcache/",
  "xl/slicers/",
  "xl/activex/",
  "xl/ctrlprops/"
];

const UNSUPPORTED_NAMES = ["xl/vbaproject.bin"];

/** 返回工作簿中 exceljs 无法安全往返的 part（空数组＝可写回）。 */
export function findUnsupportedParts(entries: readonly string[]): string[] {
  const hits: string[] = [];
  for (const raw of entries) {
    const name = normalizePartName(raw);
    const lower = name.toLowerCase();
    if (UNSUPPORTED_NAMES.includes(lower) || UNSUPPORTED_PREFIXES.some((prefix) => lower.startsWith(prefix))) {
      hits.push(name);
    }
  }
  return hits;
}

/**
 * exceljs 重写工作簿时允许被改写/替换/移除的 part；drawings/images/comments 按
 * best-effort 放行（可能丢失，但不阻断）。其余 part 在写回后消失即视为静默丢失。
 */
const REWRITABLE_PART_PATTERNS: RegExp[] = [
  /^\[content_types\]\.xml$/i,
  /^_rels\/\.rels$/i,
  /^xl\/workbook\.xml$/i,
  /^xl\/_rels\/workbook\.xml\.rels$/i,
  /^xl\/worksheets\//i,
  /^xl\/styles\.xml$/i,
  /^xl\/sharedstrings\.xml$/i,
  /^xl\/calchain\.xml$/i,
  /^xl\/theme\//i,
  /^xl\/drawings\//i,
  /^xl\/media\//i,
  /^xl\/comments[^/]*\.xml$/i,
  /^xl\/threadedcomments\//i,
  /^docprops\//i
];

/** 写回前存在、写回后消失且不允许改写的 part（空数组＝未发现静默丢失）。 */
export function lostParts(before: readonly string[], after: readonly string[]): string[] {
  const remaining = new Set(after.map((name) => normalizePartName(name)));
  return before
    .map((name) => normalizePartName(name))
    .filter(
      (name) =>
        name !== "" &&
        !remaining.has(name) &&
        !REWRITABLE_PART_PATTERNS.some((pattern) => pattern.test(name))
    );
}
