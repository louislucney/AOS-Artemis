import assert from "node:assert/strict";
import test from "node:test";

import { loopbackHostAllowed, sameOriginAllowed } from "../dist/panel/http-guard.js";
import { UploadError, parseMultipartUpload } from "../dist/panel/upload.js";

test("sameOriginAllowed: 同源/无头放行；cross-site 拒绝；自定义头放行", () => {
  assert.equal(sameOriginAllowed({ "sec-fetch-site": "same-origin" }), true);
  assert.equal(sameOriginAllowed({ "sec-fetch-site": "cross-site" }), false, "跨站写请求必须拒绝");
  assert.equal(sameOriginAllowed({ "sec-fetch-site": "none" }), true, "地址栏直达");
  assert.equal(sameOriginAllowed({}), true, "非浏览器客户端（无该头）放行");
  assert.equal(sameOriginAllowed({ "sec-fetch-site": "cross-site", "x-aos-console": "1" }), true);
  assert.equal(sameOriginAllowed(undefined), true);
});

test("loopbackHostAllowed: 仅 loopback 主机名", () => {
  assert.equal(loopbackHostAllowed("127.0.0.1:8767"), true);
  assert.equal(loopbackHostAllowed("localhost:8767"), true);
  assert.equal(loopbackHostAllowed("[::1]:8767"), true);
  assert.equal(loopbackHostAllowed("10.0.0.5:8767"), false);
  assert.equal(loopbackHostAllowed("evil.example:8767"), false);
  assert.equal(loopbackHostAllowed(undefined), false);
});

function multipartBody(boundary, filename, content) {
  return Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n${content}\r\n--${boundary}--\r\n`,
    "utf8"
  );
}

test("parseMultipartUpload: 正常单文件（.xlsx）", async () => {
  const boundary = "----aosBoundary";
  const parsed = await parseMultipartUpload(
    multipartBody(boundary, "cases.xlsx", "XLSX-CONTENT"),
    `multipart/form-data; boundary=${boundary}`
  );
  assert.equal(parsed.filename, "cases.xlsx");
  assert.equal(parsed.content.toString("utf8"), "XLSX-CONTENT");
});

test("parseMultipartUpload: 文件名只取 basename、非 xlsx / 坏边界 / 超限均报错", async () => {
  const boundary = "----aosBoundary";
  const sneaky = await parseMultipartUpload(
    multipartBody(boundary, "../../evil.xlsx", "X"),
    `multipart/form-data; boundary=${boundary}`
  );
  assert.equal(sneaky.filename, "evil.xlsx", "路径穿越被 basename 截断");

  await assert.rejects(
    () => parseMultipartUpload(multipartBody(boundary, "cases.csv", "X"), `multipart/form-data; boundary=${boundary}`),
    (error) => error instanceof UploadError && error.status === 400
  );
  await assert.rejects(
    () => parseMultipartUpload(multipartBody(boundary, "cases.xlsx", "X"), "application/json"),
    (error) => error instanceof UploadError && error.status === 400
  );
  await assert.rejects(
    () => parseMultipartUpload(multipartBody(boundary, "cases.xlsx", "TOO-BIG"), `multipart/form-data; boundary=${boundary}`, 2),
    (error) => error instanceof UploadError && error.status === 413
  );
});
