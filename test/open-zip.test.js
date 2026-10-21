import assert from "node:assert/strict";
import test from "node:test";

import { buildZip } from "../dist/open/zip.js";

function readCentralDirectory(buffer) {
  const eocd = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(eocd >= 0, "EOCD present");
  const count = buffer.readUInt16LE(eocd + 10);
  const offset = buffer.readUInt32LE(eocd + 16);
  const names = [];
  let cursor = offset;
  for (let index = 0; index < count; index += 1) {
    assert.equal(buffer.readUInt32LE(cursor), 0x02014b50);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    names.push(buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf-8"));
    const extra = buffer.readUInt16LE(cursor + 30);
    const comment = buffer.readUInt16LE(cursor + 32);
    cursor += 46 + nameLength + extra + comment;
  }
  return names;
}

test("zip: writes stored entries with utf-8 names", () => {
  const buffer = buildZip([
    { path: "design.md", data: Buffer.from("# 设计", "utf-8") },
    { path: "screens/登录页.png", data: Buffer.from([0x89, 0x50, 0x4e, 0x47]) }
  ]);
  assert.deepEqual(readCentralDirectory(buffer), ["design.md", "screens/登录页.png"]);
});

test("zip: rejects traversal and absolute paths", () => {
  assert.throws(() => buildZip([{ path: "../x", data: Buffer.from("x") }]), /非法/);
  assert.throws(() => buildZip([{ path: "/x", data: Buffer.from("x") }]), /非法/);
});
