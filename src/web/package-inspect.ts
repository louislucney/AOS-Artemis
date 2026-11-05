import { spawnSync } from "node:child_process";

import JSZip from "jszip";

import { isValidAppId } from "./script-gen.js";

const RES_STRING_POOL_TYPE = 0x0001;
const RES_XML_START_ELEMENT_TYPE = 0x0102;
const UTF8_FLAG = 0x100;
const NO_ENTRY = 0xffffffff;
const TYPE_STRING = 0x03;
const TYPE_INT_DEC = 0x10;
const TYPE_INT_HEX = 0x11;
const MAX_MANIFEST_BYTES = 5 * 1024 * 1024;

export interface AndroidManifestInfo {
  packageName: string | null;
  versionCode: number | null;
  versionName: string | null;
}

function u16(buffer: Buffer, offset: number): number {
  return buffer.readUInt16LE(offset);
}

function u32(buffer: Buffer, offset: number): number {
  return buffer.readUInt32LE(offset);
}

function readUtf8Length(buffer: Buffer, offset: number): { length: number; next: number } {
  const first = buffer[offset] ?? 0;
  if ((first & 0x80) === 0) return { length: first, next: offset + 1 };
  return {
    length: ((first & 0x7f) << 8) | (buffer[offset + 1] ?? 0),
    next: offset + 2
  };
}

function readUtf16Length(buffer: Buffer, offset: number): { length: number; next: number } {
  const first = u16(buffer, offset);
  if ((first & 0x8000) === 0) return { length: first, next: offset + 2 };
  return {
    length: ((first & 0x7fff) << 16) | u16(buffer, offset + 2),
    next: offset + 4
  };
}

function readStringPool(buffer: Buffer, offset: number): string[] {
  const headerSize = u16(buffer, offset + 2);
  const size = u32(buffer, offset + 4);
  const count = u32(buffer, offset + 8);
  const flags = u32(buffer, offset + 16);
  const stringsStart = u32(buffer, offset + 20);
  const tableStart = offset + headerSize;
  const dataStart = offset + stringsStart;
  const end = Math.min(buffer.length, offset + size);
  if (count > 1_000_000 || tableStart + count * 4 > end || dataStart > end) return [];
  const out: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const relative = u32(buffer, tableStart + index * 4);
    let cursor = dataStart + relative;
    if (cursor >= end) {
      out.push("");
      continue;
    }
    if ((flags & UTF8_FLAG) !== 0) {
      const utf16 = readUtf8Length(buffer, cursor);
      cursor = utf16.next;
      const utf8 = readUtf8Length(buffer, cursor);
      cursor = utf8.next;
      const finish = Math.min(end, cursor + utf8.length);
      out.push(buffer.subarray(cursor, finish).toString("utf8"));
    } else {
      const length = readUtf16Length(buffer, cursor);
      cursor = length.next;
      const finish = Math.min(end, cursor + length.length * 2);
      out.push(buffer.subarray(cursor, finish).toString("utf16le"));
    }
  }
  return out;
}

/**
 * 解析 Android 二进制 XML（AXML）里 `<manifest>` 的 package / versionCode / versionName。
 * 只读 string pool + 第一个 start element；遇到结构异常返回 null，不猜。
 */
export function parseBinaryManifestInfo(buffer: Buffer): AndroidManifestInfo | null {
  if (buffer.length < 8 || u16(buffer, 0) !== 0x0003) return null;
  let strings: string[] = [];
  let offset = u16(buffer, 2);
  while (offset + 8 <= buffer.length) {
    const type = u16(buffer, offset);
    const size = u32(buffer, offset + 4);
    if (size < 8 || offset + size > buffer.length) return null;
    if (type === RES_STRING_POOL_TYPE) {
      strings = readStringPool(buffer, offset);
    } else if (type === RES_XML_START_ELEMENT_TYPE) {
      if (strings.length === 0 || offset + 16 + 20 > buffer.length) return null;
      const nameIndex = u32(buffer, offset + 20);
      const name = strings[nameIndex];
      if (name !== "manifest") {
        offset += size;
        continue;
      }
      const attributeStart = u16(buffer, offset + 24);
      const attributeSize = u16(buffer, offset + 26);
      const attributeCount = u16(buffer, offset + 28);
      if (attributeSize < 20 || attributeCount > 1000) return null;
      const base = offset + 16 + attributeStart;
      let packageName: string | null = null;
      let versionCode: number | null = null;
      let versionName: string | null = null;
      for (let index = 0; index < attributeCount; index += 1) {
        const attr = base + index * attributeSize;
        if (attr + 20 > buffer.length) return null;
        const attrName = strings[u32(buffer, attr + 4)];
        const rawValue = u32(buffer, attr + 8);
        const dataType = buffer[attr + 15];
        const data = u32(buffer, attr + 16);
        const stringValue =
          rawValue !== NO_ENTRY && strings[rawValue] !== undefined
            ? strings[rawValue] ?? null
            : dataType === TYPE_STRING && strings[data] !== undefined
              ? strings[data] ?? null
              : null;
        if (attrName === "package") {
          packageName = stringValue;
        } else if (attrName === "versionCode") {
          versionCode =
            dataType === TYPE_INT_DEC || dataType === TYPE_INT_HEX
              ? data
              : stringValue !== null && /^\d+$/.test(stringValue)
                ? Number(stringValue)
                : null;
        } else if (attrName === "versionName") {
          versionName = stringValue;
        }
      }
      return { packageName, versionCode, versionName };
    }
    offset += size;
  }
  return null;
}

export function parseBinaryManifestPackage(buffer: Buffer): string | null {
  return parseBinaryManifestInfo(buffer)?.packageName ?? null;
}

function parseTextManifestInfo(text: string): AndroidManifestInfo {
  const tag = /<manifest\b[^>]*>/i.exec(text)?.[0] ?? text;
  const attr = (name: string): string | null => {
    const match = new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`, "i").exec(tag);
    return match?.[1]?.trim() ?? null;
  };
  const versionCodeRaw = attr("android:versionCode") ?? attr("versionCode");
  return {
    packageName: attr("package"),
    versionCode:
      versionCodeRaw !== null && /^\d+$/.test(versionCodeRaw) ? Number(versionCodeRaw) : null,
    versionName: attr("android:versionName") ?? attr("versionName")
  };
}

export interface IosAppInfo {
  bundleId: string | null;
  version: string | null;
  build: string | null;
}

function parsePlistInfo(xml: string): IosAppInfo {
  const value = (key: string): string | null => {
    const match = new RegExp(
      `<key>\\s*${key}\\s*</key>\\s*<string>\\s*([^<]*?)\\s*</string>`,
      "i"
    ).exec(xml);
    return match?.[1]?.trim() ?? null;
  };
  return {
    bundleId: value("CFBundleIdentifier"),
    version: value("CFBundleShortVersionString"),
    build: value("CFBundleVersion")
  };
}

/** 读取 Info.plist（XML 或 macOS plutil 可转换的二进制）中的 bundleId/版本号。 */
export function inspectIosInfoPlist(buffer: Buffer): IosAppInfo | null {
  if (buffer.length === 0 || buffer.length > MAX_MANIFEST_BYTES) return null;
  const xml = buffer.subarray(0, 6).toString("ascii").startsWith("bplist")
    ? plistToXml(buffer)
    : buffer.toString("utf8");
  return xml === null ? null : parsePlistInfo(xml);
}

/** 读取 .ipa 内 `Payload/*.app/Info.plist`；非 IPA 返回 null。 */
export async function inspectIosPackage(buffer: Buffer): Promise<IosAppInfo | null> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch {
    return null;
  }
  const entry = Object.keys(zip.files).find((name) =>
    /^Payload\/[^/]+\.app\/Info\.plist$/.test(name)
  );
  if (entry === undefined) return null;
  const file = zip.file(entry);
  if (file === null) return null;
  let plist: Buffer;
  try {
    plist = await file.async("nodebuffer");
  } catch {
    return null;
  }
  return inspectIosInfoPlist(plist);
}

function plistToXml(buffer: Buffer): string | null {
  if (buffer.subarray(0, 6).toString("ascii") !== "bplist") return null;
  const result = spawnSync("plutil", ["-convert", "xml1", "-o", "-", "-"], {
    input: buffer,
    encoding: "utf8",
    timeout: 5000,
    maxBuffer: 10 * 1024 * 1024
  });
  if (result.status !== 0 || typeof result.stdout !== "string") return null;
  return result.stdout;
}

function validate(appId: string | null, platform: "android" | "ios"): string | null {
  const trimmed = appId?.trim() ?? "";
  if (trimmed === "" || !isValidAppId(trimmed, platform)) return null;
  return trimmed;
}

/** 读取 APK 内 AndroidManifest.xml 的 package / versionCode / versionName；非 APK 返回 null。 */
export async function inspectAndroidPackage(buffer: Buffer): Promise<AndroidManifestInfo | null> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch {
    return null;
  }
  const manifest = zip.file("AndroidManifest.xml");
  if (manifest === null) return null;
  let data: Buffer;
  try {
    data = await manifest.async("nodebuffer");
  } catch {
    return null;
  }
  if (data.length === 0 || data.length > MAX_MANIFEST_BYTES) return null;
  const head = data.subarray(0, 64).toString("utf8").trimStart();
  const info = head.startsWith("<")
    ? parseTextManifestInfo(data.toString("utf8"))
    : parseBinaryManifestInfo(data);
  if (info === null) return null;
  return { ...info, packageName: validate(info.packageName, "android") };
}

/**
 * 从 APK/IPA 资产推断 appId（best-effort）：
 * - APK：AndroidManifest.xml（文本 XML 或二进制 AXML）的 package；
 * - IPA：Payload/*.app/Info.plist 的 CFBundleIdentifier（XML 或 macOS plutil 可读的二进制）。
 * 推断失败返回 null，由调用方保留手填/项目配置。
 */
export async function inferAppIdFromPackage(
  buffer: Buffer,
  _filename: string
): Promise<string | null> {
  const apk = await inspectAndroidPackage(buffer);
  if (apk !== null) return apk.packageName;
  const ios = await inspectIosPackage(buffer);
  return ios === null ? null : validate(ios.bundleId, "ios");
}
