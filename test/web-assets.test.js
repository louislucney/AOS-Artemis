import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { newDb } from "pg-mem";

import { FileStore } from "../dist/db/file.js";
import { MemoryStore } from "../dist/db/memory.js";
import { PostgresStore } from "../dist/db/postgres.js";
import { handlePanelActionRequest } from "../dist/panel/actions.js";
import { parseMultipartUpload } from "../dist/panel/upload.js";
import { createWebProject } from "../dist/web/project-service.js";
import {
  listWebAssets,
  storeWebAsset,
  WebAssetError,
  WEB_ASSET_MAX_BYTES
} from "../dist/web/assets.js";

const ADMIN = { name: "alice", role: "maintainer", source: "user" };
const DISPATCHER = { name: "bob", role: "dispatcher", source: "user" };
const XLSX = Buffer.from("PK-fake-xlsx-content");

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

async function tempDir(t, prefix) {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  if (t) t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function makeProject(store, rootPath, name = "acme") {
  await store.upsertProject({ rootPath, name });
  return store.createWebProject({
    rootPath,
    name,
    normalizedName: name,
    platforms: ["android"]
  });
}

function multipartBody(boundary, { fields = {}, filename = "cases.xlsx", content = XLSX } = {}) {
  const parts = [];
  for (const [key, value] of Object.entries(fields)) {
    parts.push(
      `--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`
    );
  }
  parts.push(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet\r\n\r\n${content}\r\n`
  );
  parts.push(`--${boundary}--\r\n`);
  return Buffer.from(parts.join(""), "utf8");
}

function uploadRequest(body, { identity = ADMIN, boundary = "----aosAssets" } = {}) {
  return {
    method: "POST",
    url: new URL("http://localhost/panel/api/projects/assets"),
    body: {},
    rawBody: body,
    contentType: `multipart/form-data; boundary=${boundary}`,
    identity
  };
}

async function makePgStore() {
  const mem = newDb();
  const { Pool } = mem.adapters.createPg();
  const store = new PostgresStore(new Pool());
  await store.init();
  return store;
}

test("storeWebAsset: 写 assets/excel/<sha>.xlsx 并登记记录", async (t) => {
  const workspace = await tempDir(t, "aos-assets-");
  const rootPath = path.join(workspace, "acme");
  await mkdir(rootPath, { recursive: true });
  const store = new MemoryStore();
  const web = await makeProject(store, rootPath);

  const asset = await storeWebAsset({
    store,
    rootPath,
    kind: "excel",
    filename: "Cases.XLSX",
    buffer: XLSX,
    uploadedBy: "alice"
  });

  const digest = sha256(XLSX);
  assert.match(asset.id, /^[0-9a-f-]{36}$/);
  assert.equal(asset.rootPath, rootPath);
  assert.equal(asset.projectId, web.projectId);
  assert.equal(asset.kind, "excel");
  assert.equal(asset.version, 1);
  assert.equal(asset.filename, "Cases.XLSX");
  assert.equal(asset.sha256, digest);
  assert.equal(asset.size, XLSX.length);
  assert.equal(asset.uploadedBy, "alice");
  assert.equal(asset.createdAt.length > 0, true);
  assert.deepEqual(asset.metadata, {});
  assert.equal(
    asset.storagePath,
    path.join(rootPath, ".artemis", "web", "assets", "excel", `${digest}.xlsx`)
  );
  assert.deepEqual(await readFile(asset.storagePath), XLSX);

  const stored = await store.getWebAsset(rootPath, asset.id);
  assert.deepEqual(stored, asset);
  assert.equal(await store.getWebAsset(rootPath, "missing"), null);
});

test("storeWebAsset: 重复内容复用同一文件但 version 递增（每次上传一行）", async (t) => {
  const workspace = await tempDir(t, "aos-assets-");
  const rootPath = path.join(workspace, "acme");
  await mkdir(rootPath, { recursive: true });
  const store = new MemoryStore();
  await makeProject(store, rootPath);

  const first = await storeWebAsset({ store, rootPath, kind: "excel", filename: "a.xlsx", buffer: XLSX });
  const second = await storeWebAsset({ store, rootPath, kind: "excel", filename: "b.xlsx", buffer: XLSX });
  assert.equal(second.storagePath, first.storagePath, "内容寻址复用同一文件");
  assert.equal(second.sha256, first.sha256);
  assert.equal(second.version, 2);
  assert.notEqual(second.id, first.id);

  const files = await readdir(path.join(rootPath, ".artemis", "web", "assets", "excel"));
  assert.deepEqual(files, [`${first.sha256}.xlsx`], "同一内容只落一个文件");

  const listed = await listWebAssets(store, rootPath, "excel");
  assert.deepEqual(
    listed.map((asset) => asset.version),
    [2, 1],
    "列表按 version 新→旧"
  );
  assert.deepEqual(await listWebAssets(store, rootPath), listed);
  assert.deepEqual(await listWebAssets(store, rootPath, "package"), []);

  const third = await storeWebAsset({
    store,
    rootPath,
    kind: "excel",
    filename: "c.xlsx",
    buffer: Buffer.from("other")
  });
  assert.equal(third.version, 3);
  assert.notEqual(third.storagePath, first.storagePath);
});

test("storeWebAsset: 非 .xlsx/.csv / 空文件 / 超 20MB 抛 WebAssetError", async (t) => {
  const workspace = await tempDir(t, "aos-assets-");
  const rootPath = path.join(workspace, "acme");
  await mkdir(rootPath, { recursive: true });
  const store = new MemoryStore();
  await makeProject(store, rootPath);

  await assert.rejects(
    () => storeWebAsset({ store, rootPath, kind: "excel", filename: "cases.txt", buffer: XLSX }),
    (error) => error instanceof WebAssetError && error.code === "invalid-extension"
  );
  await assert.rejects(
    () => storeWebAsset({ store, rootPath, kind: "excel", filename: "cases.xls", buffer: XLSX }),
    (error) => error instanceof WebAssetError && error.code === "invalid-extension"
  );
  await assert.rejects(
    () => storeWebAsset({ store, rootPath, kind: "excel", filename: "cases.xlsx", buffer: Buffer.alloc(0) }),
    (error) => error instanceof WebAssetError && error.code === "empty-file"
  );
  await assert.rejects(
    () =>
      storeWebAsset({
        store,
        rootPath,
        kind: "excel",
        filename: "cases.xlsx",
        buffer: Buffer.alloc(WEB_ASSET_MAX_BYTES + 1)
      }),
    (error) => error instanceof WebAssetError && error.code === "too-large"
  );
  assert.deepEqual(await store.listWebAssets(rootPath), [], "校验失败不写记录");
});

test("storeWebAsset: 文件名只取 basename（拒绝目录穿越）", async (t) => {
  const workspace = await tempDir(t, "aos-assets-");
  const rootPath = path.join(workspace, "acme");
  await mkdir(rootPath, { recursive: true });
  const store = new MemoryStore();
  await makeProject(store, rootPath);

  const asset = await storeWebAsset({
    store,
    rootPath,
    kind: "excel",
    filename: "../../evil.xlsx",
    buffer: XLSX
  });
  assert.equal(asset.filename, "evil.xlsx");
  assert.equal(
    path.dirname(asset.storagePath),
    path.join(rootPath, ".artemis", "web", "assets", "excel")
  );
});

test("API /panel/api/projects/assets: 上传成功后 list 可见并写 asset.upload 审计", async (t) => {
  const workspace = await tempDir(t, "aos-assets-api-");
  const rootPath = path.join(workspace, "acme");
  await mkdir(rootPath, { recursive: true });
  const store = new MemoryStore();
  await makeProject(store, rootPath, "acme");
  const deps = { store, env: {}, workspaceRoot: workspace };

  const body = multipartBody("----aosAssets", {
    fields: { project: rootPath, kind: "excel" },
    filename: "cases.xlsx"
  });
  const res = await handlePanelActionRequest(uploadRequest(body), deps);
  assert.equal(res.status, 200, res.body);
  const payload = JSON.parse(res.body);
  assert.equal(payload.ok, true);
  assert.equal(payload.asset.kind, "excel");
  assert.equal(payload.asset.version, 1);
  assert.equal(payload.asset.filename, "cases.xlsx");
  assert.equal(payload.asset.sha256, sha256(XLSX));
  assert.equal(payload.asset.uploadedBy, "alice");
  assert.equal(Object.hasOwn(payload.asset, "content"), false);
  assert.equal(typeof payload.asset.storagePath, "string");

  const listed = await listWebAssets(store, rootPath, "excel");
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, payload.asset.id);

  const audit = await store.listAudit(rootPath, { domain: "asset" });
  assert.equal(audit.length, 1);
  assert.equal(audit[0].action, "asset.upload");
  assert.equal(audit[0].result, "ok");
  assert.equal(audit[0].actor, "alice");
  assert.match(audit[0].summary, /cases\.xlsx/);
  assert.equal(audit[0].refs.sha256, sha256(XLSX));
});

test("API /panel/api/projects/assets: 上传 CSV 成功并记录 format/encoding", async (t) => {
  const workspace = await tempDir(t, "aos-assets-api-");
  const rootPath = path.join(workspace, "acme");
  await mkdir(rootPath, { recursive: true });
  const store = new MemoryStore();
  await makeProject(store, rootPath, "acme");
  const deps = { store, env: {}, workspaceRoot: workspace };
  const csv = Buffer.from("用例编号,步骤\n001,点击\n", "utf8");

  const body = multipartBody("----aosAssets", {
    fields: { project: rootPath, kind: "excel" },
    filename: "cases.csv",
    content: csv
  });
  const res = await handlePanelActionRequest(uploadRequest(body), deps);
  assert.equal(res.status, 200, res.body);
  const payload = JSON.parse(res.body);
  assert.equal(payload.asset.kind, "excel");
  assert.equal(payload.asset.filename, "cases.csv");
  assert.equal(path.extname(payload.asset.storagePath), ".csv");
  assert.deepEqual(payload.asset.metadata, { format: "csv", encoding: "utf-8" });
  assert.deepEqual(await readFile(payload.asset.storagePath), csv, "原件按原字节保存");
});

test("API /panel/api/projects/assets: 拒绝错误扩展名/缺项目/未知项目/未知 kind/无文件", async (t) => {
  const workspace = await tempDir(t, "aos-assets-api-");
  const rootPath = path.join(workspace, "acme");
  await mkdir(rootPath, { recursive: true });
  const store = new MemoryStore();
  await makeProject(store, rootPath);
  const deps = { store, env: {}, workspaceRoot: workspace };

  const wrongExt = await handlePanelActionRequest(
    uploadRequest(
      multipartBody("----aosAssets", {
        fields: { project: rootPath, kind: "excel" },
        filename: "cases.xls"
      })
    ),
    deps
  );
  assert.equal(wrongExt.status, 400, wrongExt.body);

  const missingProject = await handlePanelActionRequest(
    uploadRequest(multipartBody("----aosAssets", { fields: { kind: "excel" } })),
    deps
  );
  assert.equal(missingProject.status, 400, missingProject.body);
  assert.match(JSON.parse(missingProject.body).error, /project/);

  const unknownProject = await handlePanelActionRequest(
    uploadRequest(
      multipartBody("----aosAssets", {
        fields: { project: path.join(workspace, "nope"), kind: "excel" }
      })
    ),
    deps
  );
  assert.equal(unknownProject.status, 404, unknownProject.body);

  const badKind = await handlePanelActionRequest(
    uploadRequest(
      multipartBody("----aosAssets", {
        fields: { project: rootPath, kind: "binary" }
      })
    ),
    deps
  );
  assert.equal(badKind.status, 400, badKind.body);
  assert.match(JSON.parse(badKind.body).error, /kind/);

  const mismatchedKind = await handlePanelActionRequest(
    uploadRequest(
      multipartBody("----aosAssets", {
        fields: { project: rootPath, kind: "package" }
      })
    ),
    deps
  );
  assert.equal(mismatchedKind.status, 400, mismatchedKind.body, "kind 与扩展名不匹配");
  assert.equal(JSON.parse(mismatchedKind.body).code, "invalid-extension");

  const missingKind = await handlePanelActionRequest(
    uploadRequest(multipartBody("----aosAssets", { fields: { project: rootPath } })),
    deps
  );
  assert.equal(missingKind.status, 400, missingKind.body);
  assert.match(JSON.parse(missingKind.body).error, /kind/);

  const noFile = await handlePanelActionRequest(
    uploadRequest(
      Buffer.from(
        '--b\r\nContent-Disposition: form-data; name="project"\r\n\r\n' +
          `${rootPath}\r\n--b--\r\n`,
        "utf8"
      ),
      { boundary: "b" }
    ),
    deps
  );
  assert.equal(noFile.status, 400, noFile.body);

  assert.deepEqual(await store.listWebAssets(rootPath), []);
});

test("API /panel/api/projects/assets: 跨主机路径歧义 409（不猜项目）", async (t) => {
  const workspace = await tempDir(t, "aos-assets-api-");
  const rootPath = path.join(workspace, "acme");
  await mkdir(rootPath, { recursive: true });
  const store = new MemoryStore();
  await store.upsertProject({ rootPath, name: "acme", hostId: "host-a" });
  await store.upsertProject({ rootPath, name: "acme", hostId: "host-b" });
  const deps = { store, env: {}, workspaceRoot: workspace };

  const res = await handlePanelActionRequest(
    uploadRequest(
      multipartBody("----aosAssets", { fields: { project: rootPath, kind: "excel" } })
    ),
    deps
  );
  assert.equal(res.status, 409, res.body);
  const payload = JSON.parse(res.body);
  assert.equal(payload.candidates.length, 2);
  assert.deepEqual(
    payload.candidates.map((candidate) => candidate.hostId).sort(),
    ["host-a", "host-b"]
  );
  assert.deepEqual(await store.listWebAssets(rootPath), []);
});

test("API /panel/api/projects/assets: store 失败写 failed 审计，CAS 文件保留且重试复用不产生孤儿行", async (t) => {
  const workspace = await tempDir(t, "aos-assets-api-");
  const rootPath = path.join(workspace, "acme");
  await mkdir(rootPath, { recursive: true });
  const store = new MemoryStore();
  await makeProject(store, rootPath);
  const deps = { store, env: {}, workspaceRoot: workspace };

  const realCreate = store.createWebAsset.bind(store);
  let failures = 1;
  store.createWebAsset = async (input) => {
    if (failures > 0) {
      failures -= 1;
      throw new Error("模拟台账写入失败");
    }
    return realCreate(input);
  };

  const body = multipartBody("----aosAssets", {
    fields: { project: rootPath, kind: "excel" },
    filename: "cases.xlsx"
  });
  const failed = await handlePanelActionRequest(uploadRequest(body), deps);
  assert.equal(failed.status, 500, failed.body);

  const storagePath = path.join(
    rootPath,
    ".artemis",
    "web",
    "assets",
    "excel",
    `${sha256(XLSX)}.xlsx`
  );
  assert.deepEqual(await readFile(storagePath), XLSX, "文件先落盘且失败时不删除共享 CAS 文件");
  assert.equal((await store.listWebAssets(rootPath)).length, 0, "失败不登记行");

  const failedAudit = (await store.listAudit(rootPath, { domain: "asset" })).find(
    (event) => event.result === "failed"
  );
  assert.ok(failedAudit, "store 失败应写 failed 审计");
  assert.equal(failedAudit.action, "asset.upload");
  assert.match(failedAudit.summary, /模拟台账写入失败/);

  const retried = await handlePanelActionRequest(uploadRequest(body), deps);
  assert.equal(retried.status, 200, retried.body);
  const listed = await store.listWebAssets(rootPath, "excel");
  assert.equal(listed.length, 1, "重试只补一行，复用已有 CAS 文件");
  assert.equal(listed[0].storagePath, storagePath);
  const audit = await store.listAudit(rootPath, { domain: "asset" });
  assert.deepEqual(
    audit.map((event) => event.result).sort(),
    ["failed", "ok"]
  );
});

test("parseMultipartUpload: 扩展名/上限可配置（默认仍为 .xlsx + 20MB）", async () => {
  const boundary = "----aosAssets";
  const csv = multipartBody(boundary, {
    fields: { project: "/w/acme" },
    filename: "cases.csv",
    content: Buffer.from("a,b\n1,2\n")
  });
  const parsed = await parseMultipartUpload(csv, `multipart/form-data; boundary=${boundary}`, {
    extensions: [".csv"],
    maxBytes: 1024
  });
  assert.equal(parsed.filename, "cases.csv");
  assert.equal(parsed.fields.project, "/w/acme");
  assert.equal(parsed.content.toString("utf8"), "a,b\n1,2\n");

  await assert.rejects(
    () =>
      parseMultipartUpload(csv, `multipart/form-data; boundary=${boundary}`, {
        extensions: [".xlsx"]
      }),
    (error) => error.status === 400
  );
  await assert.rejects(
    () =>
      parseMultipartUpload(csv, `multipart/form-data; boundary=${boundary}`, {
        extensions: [".csv"],
        maxBytes: 2
      }),
    (error) => error.status === 413
  );
  await assert.rejects(
    () =>
      parseMultipartUpload(
        multipartBody(boundary, { filename: "cases.csv", content: "X" }),
        `multipart/form-data; boundary=${boundary}`
      ),
    (error) => error.status === 400,
    "默认白名单不含 .csv"
  );
});

test("API /panel/api/projects/assets: >20MB 结构化拒绝；dispatcher 403", async (t) => {
  const workspace = await tempDir(t, "aos-assets-api-");
  const rootPath = path.join(workspace, "acme");
  await mkdir(rootPath, { recursive: true });
  const store = new MemoryStore();
  await makeProject(store, rootPath);
  const deps = { store, env: {}, workspaceRoot: workspace };

  const tooLarge = await handlePanelActionRequest(
    uploadRequest(
      multipartBody("----aosAssets", {
        fields: { project: rootPath, kind: "excel" },
        content: Buffer.alloc(WEB_ASSET_MAX_BYTES + 1)
      })
    ),
    deps
  );
  assert.equal(tooLarge.status, 413, tooLarge.body);
  assert.equal(typeof JSON.parse(tooLarge.body).error, "string");

  const forbidden = await handlePanelActionRequest(
    uploadRequest(
      multipartBody("----aosAssets", {
        fields: { project: rootPath, kind: "excel" }
      }),
      { identity: DISPATCHER }
    ),
    deps
  );
  assert.equal(forbidden.status, 403, forbidden.body);
  assert.equal(JSON.parse(forbidden.body).code, "role_forbidden");

  assert.deepEqual(await store.listWebAssets(rootPath), []);
});

test("FileStore: 重启后资产记录仍在", async (t) => {
  const home = await tempDir(t, "aos-assets-file-");
  const rootPath = path.join(home, "acme");
  await mkdir(rootPath, { recursive: true });

  let store = await FileStore.create({ homeDir: home });
  await makeProject(store, rootPath);
  const asset = await storeWebAsset({
    store,
    rootPath,
    kind: "excel",
    filename: "cases.xlsx",
    buffer: XLSX,
    uploadedBy: "alice"
  });
  await store.close();

  store = await FileStore.create({ homeDir: home });
  const listed = await store.listWebAssets(rootPath, "excel");
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, asset.id);
  assert.equal(listed[0].sha256, asset.sha256);
  assert.equal((await store.getWebAsset(rootPath, asset.id)).storagePath, asset.storagePath);
  assert.deepEqual(await readFile(listed[0].storagePath), XLSX);
  await store.close();
});

test("storeWebAsset: 项目目录必须已存在（不代建目录）", async (t) => {
  const workspace = await tempDir(t, "aos-assets-");
  const rootPath = path.join(workspace, "missing");
  const store = new MemoryStore();
  await assert.rejects(
    () => storeWebAsset({ store, rootPath, kind: "excel", filename: "cases.xlsx", buffer: XLSX }),
    (error) => error instanceof WebAssetError && error.code === "project-root-missing"
  );
  await assert.rejects(() => access(rootPath), "不得在请求路径上凭空创建项目目录");
  assert.deepEqual(await store.listWebAssets(rootPath), []);
});

test("storeWebAsset: projectId 从 upsertProject 解析（web.projectId 也已补链）", async (t) => {
  const workspace = await tempDir(t, "aos-assets-");
  const store = new MemoryStore();
  const created = await createWebProject({
    store,
    workspaceRoot: workspace,
    name: "linked-asset",
    platforms: ["android"],
    appPackage: "com.linked"
  });
  const project = await store.getProjectByPath(created.rootPath);
  assert.ok(project);
  assert.equal((await store.getWebProject(created.rootPath)).projectId, project.id);

  const asset = await storeWebAsset({
    store,
    rootPath: created.rootPath,
    kind: "excel",
    filename: "cases.xlsx",
    buffer: XLSX
  });
  assert.equal(asset.projectId, project.id);
});

test("API /panel/api/projects/assets: 归档项目拒绝上传（409）", async (t) => {
  const workspace = await tempDir(t, "aos-assets-api-");
  const rootPath = path.join(workspace, "acme");
  await mkdir(rootPath, { recursive: true });
  const store = new MemoryStore();
  await makeProject(store, rootPath);
  await store.archiveWebProject(rootPath, "2026-10-28T00:00:00.000Z");
  const deps = { store, env: {}, workspaceRoot: workspace };

  const res = await handlePanelActionRequest(
    uploadRequest(
      multipartBody("----aosAssets", {
        fields: { project: rootPath, kind: "excel" },
        filename: "cases.xlsx"
      })
    ),
    deps
  );
  assert.equal(res.status, 409, res.body);
  const payload = JSON.parse(res.body);
  assert.equal(payload.code, "project-archived");
  assert.match(payload.error, /归档/);
  assert.deepEqual(await store.listWebAssets(rootPath), []);
  await assert.rejects(
    () => access(path.join(rootPath, ".artemis", "web", "assets", "excel")),
    "归档项目不得写入资产文件"
  );
});

test("API /panel/api/projects/assets: 跨主机项目拒绝本机写盘（409）", async (t) => {
  const workspace = await tempDir(t, "aos-assets-api-");
  const rootPath = path.join(workspace, "acme");
  await mkdir(rootPath, { recursive: true });
  const store = new MemoryStore();
  await store.upsertProject({ rootPath, name: "acme", hostId: "host-a" });
  const deps = { store, env: {}, workspaceRoot: workspace, localHostId: "center" };

  const res = await handlePanelActionRequest(
    uploadRequest(
      multipartBody("----aosAssets", {
        fields: { project: rootPath, kind: "excel" },
        filename: "cases.xlsx"
      })
    ),
    deps
  );
  assert.equal(res.status, 409, res.body);
  const payload = JSON.parse(res.body);
  assert.equal(payload.code, "cross-host-write");
  assert.match(payload.error, /host-a/);
  assert.match(payload.error, /项目机/);
  assert.deepEqual(await store.listWebAssets(rootPath), []);
  await assert.rejects(() => access(path.join(rootPath, ".artemis", "web", "assets")));
});

test("PostgresStore (pg-mem): web_assets 往返、版本递增与 kind 过滤", async () => {
  const store = await makePgStore();
  const rootPath = "/w/acme";
  const first = await store.createWebAsset({
    rootPath,
    kind: "excel",
    filename: "a.xlsx",
    sha256: sha256(XLSX),
    size: XLSX.length,
    storagePath: "/w/acme/.artemis/web/assets/excel/a.xlsx",
    uploadedBy: "alice",
    metadata: { note: "first" }
  });
  assert.equal(first.version, 1);
  assert.equal(first.projectId, null);
  assert.deepEqual(first.metadata, { note: "first" });

  const second = await store.createWebAsset({
    rootPath,
    kind: "excel",
    filename: "b.xlsx",
    sha256: sha256(XLSX),
    size: XLSX.length,
    storagePath: first.storagePath,
    uploadedBy: "bob"
  });
  assert.equal(second.version, 2);
  const pkg = await store.createWebAsset({
    rootPath,
    kind: "package",
    filename: "app.apk",
    sha256: "f".repeat(64),
    size: 10,
    storagePath: "/w/acme/.artemis/web/assets/package/app.apk"
  });
  assert.equal(pkg.version, 1, "version 按 kind 独立");

  const excel = await store.listWebAssets(rootPath, "excel");
  assert.deepEqual(excel.map((asset) => asset.version), [2, 1]);
  assert.equal((await store.listWebAssets(rootPath)).length, 3);
  assert.equal((await store.getWebAsset(rootPath, second.id)).filename, "b.xlsx");
  assert.equal(await store.getWebAsset(rootPath, "missing"), null);
});
