import assert from "node:assert/strict";
import test from "node:test";

import JSZip from "jszip";

import {
  inferAppIdFromPackage,
  parseBinaryManifestPackage
} from "../dist/web/package-inspect.js";

function encodeUtf8Length(length) {
  return length < 0x80 ? Buffer.from([length]) : Buffer.from([0x80 | (length >> 8), length & 0xff]);
}

function stringPool(strings) {
  const data = [];
  for (const value of strings) {
    const bytes = Buffer.from(value, "utf8");
    data.push(encodeUtf8Length(value.length), encodeUtf8Length(bytes.length), bytes, Buffer.from([0]));
  }
  const dataBuffer = Buffer.concat(data);
  const offsets = Buffer.alloc(strings.length * 4);
  let cursor = 0;
  for (const [index, value] of strings.entries()) {
    offsets.writeUInt32LE(cursor, index * 4);
    cursor += encodeUtf8Length(value.length).length + encodeUtf8Length(Buffer.byteLength(value)).length + Buffer.byteLength(value) + 1;
  }
  const headerSize = 28;
  const stringsStart = headerSize + offsets.length;
  const size = stringsStart + dataBuffer.length;
  const header = Buffer.alloc(headerSize);
  header.writeUInt16LE(0x0001, 0);
  header.writeUInt16LE(headerSize, 2);
  header.writeUInt32LE(size, 4);
  header.writeUInt32LE(strings.length, 8);
  header.writeUInt32LE(0, 12);
  header.writeUInt32LE(0x100, 16);
  header.writeUInt32LE(stringsStart, 20);
  header.writeUInt32LE(0, 24);
  return Buffer.concat([header, offsets, dataBuffer]);
}

function binaryManifest(packageName) {
  const pool = stringPool(["manifest", "package", packageName]);
  const attr = Buffer.alloc(20);
  attr.writeUInt32LE(0xffffffff, 0);
  attr.writeUInt32LE(1, 4);
  attr.writeUInt32LE(2, 8);
  attr.writeUInt16LE(8, 12);
  attr.writeUInt8(0, 14);
  attr.writeUInt8(0x03, 15);
  attr.writeUInt32LE(2, 16);
  const start = Buffer.alloc(16 + 20 + 20);
  start.writeUInt16LE(0x0102, 0);
  start.writeUInt16LE(16, 2);
  start.writeUInt32LE(start.length, 4);
  start.writeUInt32LE(1, 8);
  start.writeUInt32LE(0xffffffff, 12);
  start.writeUInt32LE(0xffffffff, 16);
  start.writeUInt32LE(0, 20);
  start.writeUInt16LE(20, 24);
  start.writeUInt16LE(20, 26);
  start.writeUInt16LE(1, 28);
  start.writeUInt16LE(0, 30);
  start.writeUInt16LE(0, 32);
  start.writeUInt16LE(0, 34);
  attr.copy(start, 36);
  const header = Buffer.alloc(8);
  header.writeUInt16LE(0x0003, 0);
  header.writeUInt16LE(8, 2);
  header.writeUInt32LE(8 + pool.length + start.length, 4);
  return Buffer.concat([header, pool, start]);
}

test("parseBinaryManifestPackage: 读取 AXML manifest package", () => {
  assert.equal(parseBinaryManifestPackage(binaryManifest("com.example.bin")), "com.example.bin");
  assert.equal(parseBinaryManifestPackage(Buffer.from("not-axml")), null);
});

test("inferAppIdFromPackage: APK 文本/二进制 manifest", async () => {
  const textZip = new JSZip();
  textZip.file("AndroidManifest.xml", '<manifest package="com.example.text"/>');
  const textApk = await textZip.generateAsync({ type: "nodebuffer" });
  assert.equal(await inferAppIdFromPackage(textApk, "app.apk"), "com.example.text");

  const binZip = new JSZip();
  binZip.file("AndroidManifest.xml", binaryManifest("com.example.bin"));
  const binApk = await binZip.generateAsync({ type: "nodebuffer" });
  assert.equal(await inferAppIdFromPackage(binApk, "app.apk"), "com.example.bin");
});

test("inferAppIdFromPackage: IPA Info.plist", async () => {
  const zip = new JSZip();
  zip.file(
    "Payload/Demo.app/Info.plist",
    `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.example.ios</string></dict></plist>`
  );
  const ipa = await zip.generateAsync({ type: "nodebuffer" });
  assert.equal(await inferAppIdFromPackage(ipa, "app.ipa"), "com.example.ios");
  assert.equal(await inferAppIdFromPackage(Buffer.from("not-a-zip"), "app.apk"), null);
});
