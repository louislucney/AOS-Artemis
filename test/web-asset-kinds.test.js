import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { MemoryStore } from "../dist/db/memory.js";
import { handlePanelActionRequest } from "../dist/panel/actions.js";
import {
  listWebAssets,
  storeWebAsset,
  WebAssetError,
  WEB_ASSET_MAX_BYTES,
  webAssetMaxBytes
} from "../dist/web/assets.js";

const ADMIN = { name: "alice", role: "maintainer", source: "user" };
const MB = 1024 * 1024;
const APK = Buffer.from("PK-fake-apk-content");
const IPA = Buffer.from("PK-fake-ipa-content");
const ZIP = Buffer.from("PK-fake-zip-content");

async function tempDir(t, prefix) {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  if (t) t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function makeProject(store, rootPath, name = "acme") {
  await store.upsertProject({ rootPath, name });
  return store.createWebProject({ rootPath, name, normalizedName: name, platforms: ["android"] });
}

function multipartBody(boundary, { fields = {}, filename = "app.apk", content = APK } = {}) {
  const parts = [];
  for (const [key, value] of Object.entries(fields)) {
    parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`);
  }
  parts.push(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n${content}\r\n`
  );
  parts.push(`--${boundary}--\r\n`);
  return Buffer.from(parts.join(""), "utf8");
}

function uploadRequest(body, { boundary = "----aosKinds" } = {}) {
  return {
    method: "POST",
    url: new URL("http://localhost/panel/api/projects/assets"),
    body: {},
    rawBody: body,
    contentType: `multipart/form-data; boundary=${boundary}`,
    identity: ADMIN
  };
}

test("webAssetMaxBytes: 各类型上限（excel/scripts 20MB、materials 50MB、package 200MB）", () => {
  assert.equal(webAssetMaxBytes("excel"), 20 * MB);
  assert.equal(webAssetMaxBytes("materials"), 50 * MB);
  assert.equal(webAssetMaxBytes("package"), 200 * MB);
  assert.equal(webAssetMaxBytes("scripts"), 20 * MB);
  assert.equal(WEB_ASSET_MAX_BYTES, 20 * MB, "旧常量保留为 excel 上限");
});

test("storeWebAsset: package 接受 .apk/.ipa（大小写不敏感），excel 拒绝 .apk", async (t) => {
  const workspace = await tempDir(t, "aos-kinds-");
  const rootPath = path.join(workspace, "acme");
  await mkdir(rootPath, { recursive: true });
  const store = new MemoryStore();
  await makeProject(store, rootPath);

  const apk = await storeWebAsset({
    store,
    rootPath,
    kind: "package",
    filename: "App.APK",
    buffer: APK
  });
  assert.equal(apk.kind, "package");
  assert.equal(apk.filename, "App.APK");
  assert.match(apk.storagePath, /\.artemis[/\\]web[/\\]assets[/\\]package[/\\][0-9a-f]{64}\.apk$/);
  await access(apk.storagePath);

  const ipa = await storeWebAsset({
    store,
    rootPath,
    kind: "package",
    filename: "App.ipa",
    buffer: IPA
  });
  assert.equal(ipa.version, 2, "version 按 kind 累计");
  assert.equal(ipa.storagePath.endsWith(".ipa"), true);

  await assert.rejects(
    () => storeWebAsset({ store, rootPath, kind: "excel", filename: "app.apk", buffer: APK }),
    (error) => error instanceof WebAssetError && error.code === "invalid-extension"
  );
  await assert.rejects(
    () => storeWebAsset({ store, rootPath, kind: "package", filename: "app.aab", buffer: APK }),
    (error) => error instanceof WebAssetError && error.code === "invalid-extension"
  );
  assert.deepEqual(await listWebAssets(store, rootPath, "excel"), [], "被拒的上传不登记行");
});

test("storeWebAsset: scripts 仅接受 .zip（.yaml 被拒）", async (t) => {
  const workspace = await tempDir(t, "aos-kinds-");
  const rootPath = path.join(workspace, "acme");
  await mkdir(rootPath, { recursive: true });
  const store = new MemoryStore();
  await makeProject(store, rootPath);

  const bundle = await storeWebAsset({
    store,
    rootPath,
    kind: "scripts",
    filename: "flow.ZIP",
    buffer: ZIP
  });
  assert.equal(bundle.kind, "scripts");
  assert.match(bundle.storagePath, /\.artemis[/\\]web[/\\]assets[/\\]scripts[/\\][0-9a-f]{64}\.zip$/);

  for (const filename of ["flow.yaml", "flow.yml", "flow.tar.gz", "flow"]) {
    await assert.rejects(
      () => storeWebAsset({ store, rootPath, kind: "scripts", filename, buffer: ZIP }),
      (error) => error instanceof WebAssetError && error.code === "invalid-extension",
      `${filename} 应被拒`
    );
  }
  assert.equal((await listWebAssets(store, rootPath, "scripts")).length, 1);
});

test("storeWebAsset: materials 接受 .zip/.json/.csv/.txt", async (t) => {
  const workspace = await tempDir(t, "aos-kinds-");
  const rootPath = path.join(workspace, "acme");
  await mkdir(rootPath, { recursive: true });
  const store = new MemoryStore();
  await makeProject(store, rootPath);

  const cases = [
    ["materials.zip", ZIP],
    ["data.json", Buffer.from("{}")],
    ["table.csv", Buffer.from("a,b\n1,2\n")],
    ["readme.txt", Buffer.from("hello")]
  ];
  for (const [filename, buffer] of cases) {
    const asset = await storeWebAsset({ store, rootPath, kind: "materials", filename, buffer });
    assert.equal(asset.kind, "materials");
    assert.equal(asset.filename, filename);
    assert.match(asset.storagePath, /\.artemis[/\\]web[/\\]assets[/\\]materials[/\\]/);
  }
  assert.equal((await listWebAssets(store, rootPath, "materials")).length, cases.length);

  await assert.rejects(
    () => storeWebAsset({ store, rootPath, kind: "materials", filename: "node.apk", buffer: APK }),
    (error) => error instanceof WebAssetError && error.code === "invalid-extension"
  );
  await assert.rejects(
    () => storeWebAsset({ store, rootPath, kind: "materials", filename: "cases.xlsx", buffer: ZIP }),
    (error) => error instanceof WebAssetError && error.code === "invalid-extension"
  );
});

test("storeWebAsset: 超 kind 上限拒绝，边界值通过", async (t) => {
  const workspace = await tempDir(t, "aos-kinds-");
  const rootPath = path.join(workspace, "acme");
  await mkdir(rootPath, { recursive: true });
  const store = new MemoryStore();
  await makeProject(store, rootPath);

  await assert.rejects(
    () =>
      storeWebAsset({
        store,
        rootPath,
        kind: "scripts",
        filename: "bundle.zip",
        buffer: Buffer.alloc(webAssetMaxBytes("scripts") + 1)
      }),
    (error) => error instanceof WebAssetError && error.code === "too-large"
  );
  await assert.rejects(
    () =>
      storeWebAsset({
        store,
        rootPath,
        kind: "materials",
        filename: "materials.zip",
        buffer: Buffer.alloc(webAssetMaxBytes("materials") + 1)
      }),
    (error) => error instanceof WebAssetError && error.code === "too-large"
  );
  await assert.rejects(
    () =>
      storeWebAsset({
        store,
        rootPath,
        kind: "excel",
        filename: "cases.xlsx",
        buffer: Buffer.alloc(webAssetMaxBytes("excel") + 1)
      }),
    (error) => error instanceof WebAssetError && error.code === "too-large"
  );
  assert.deepEqual(await listWebAssets(store, rootPath), [], "超限不落盘不登记");

  const boundary = await storeWebAsset({
    store,
    rootPath,
    kind: "scripts",
    filename: "bundle.zip",
    buffer: Buffer.alloc(webAssetMaxBytes("scripts"))
  });
  assert.equal(boundary.size, webAssetMaxBytes("scripts"));
});

test("storeWebAsset: 同 sha 重复上传新建 version 行但复用 CAS 文件", async (t) => {
  const workspace = await tempDir(t, "aos-kinds-");
  const rootPath = path.join(workspace, "acme");
  await mkdir(rootPath, { recursive: true });
  const store = new MemoryStore();
  await makeProject(store, rootPath);

  const first = await storeWebAsset({
    store,
    rootPath,
    kind: "package",
    filename: "app.apk",
    buffer: APK
  });
  const second = await storeWebAsset({
    store,
    rootPath,
    kind: "package",
    filename: "app-renamed.apk",
    buffer: APK
  });
  assert.equal(second.storagePath, first.storagePath);
  assert.equal(second.sha256, first.sha256);
  assert.equal(second.version, first.version + 1);
  assert.notEqual(second.id, first.id);

  const files = await readdir(path.join(rootPath, ".artemis", "web", "assets", "package"));
  assert.deepEqual(files, [`${first.sha256}.apk`]);

  const listed = await listWebAssets(store, rootPath, "package");
  assert.deepEqual(listed.map((asset) => asset.version), [2, 1]);
});

test("storeWebAsset: 未知 kind / 目录穿越文件名（只取 basename，不越界）", async (t) => {
  const workspace = await tempDir(t, "aos-kinds-");
  const rootPath = path.join(workspace, "acme");
  await mkdir(rootPath, { recursive: true });
  const store = new MemoryStore();
  await makeProject(store, rootPath);

  await assert.rejects(
    () => storeWebAsset({ store, rootPath, kind: "binary", filename: "app.apk", buffer: APK }),
    (error) => error instanceof WebAssetError && error.code === "unsupported-kind"
  );

  const traversal = await storeWebAsset({
    store,
    rootPath,
    kind: "package",
    filename: "../../evil.apk",
    buffer: APK
  });
  assert.equal(traversal.filename, "evil.apk");
  assert.equal(
    path.dirname(traversal.storagePath),
    path.join(rootPath, ".artemis", "web", "assets", "package")
  );
  assert.equal(traversal.storagePath.includes(".."), false);

  await assert.rejects(
    () =>
      storeWebAsset({
        store,
        rootPath,
        kind: "package",
        filename: "..\\evil.apk",
        buffer: APK
      }),
    (error) => error instanceof WebAssetError && error.code === "invalid-filename",
    "Windows 路径分隔符拒绝，不做静默 basename"
  );
});

test("storeWebAsset: metadata 透传（materials secret 标记）且缺省为空对象", async (t) => {
  const workspace = await tempDir(t, "aos-kinds-");
  const rootPath = path.join(workspace, "acme");
  await mkdir(rootPath, { recursive: true });
  const store = new MemoryStore();
  await makeProject(store, rootPath);

  const plain = await storeWebAsset({
    store,
    rootPath,
    kind: "materials",
    filename: "a.txt",
    buffer: Buffer.from("a")
  });
  assert.deepEqual(plain.metadata, {});

  const secret = await storeWebAsset({
    store,
    rootPath,
    kind: "materials",
    filename: "creds.json",
    buffer: Buffer.from("{}"),
    metadata: { secret: true }
  });
  assert.deepEqual(secret.metadata, { secret: true });
  const stored = await store.getWebAsset(rootPath, secret.id);
  assert.deepEqual(stored.metadata, { secret: true });
});

test("API /panel/api/projects/assets: 接受 package/scripts/materials 与 secret=true", async (t) => {
  const workspace = await tempDir(t, "aos-kinds-api-");
  const rootPath = path.join(workspace, "acme");
  await mkdir(rootPath, { recursive: true });
  const store = new MemoryStore();
  await makeProject(store, rootPath);
  const deps = { store, env: {}, workspaceRoot: workspace };

  const pkg = await handlePanelActionRequest(
    uploadRequest(
      multipartBody("----aosKinds", {
        fields: { project: rootPath, kind: "package" },
        filename: "app.apk",
        content: APK
      })
    ),
    deps
  );
  assert.equal(pkg.status, 200, pkg.body);
  assert.equal(JSON.parse(pkg.body).asset.kind, "package");

  const scripts = await handlePanelActionRequest(
    uploadRequest(
      multipartBody("----aosKinds", {
        fields: { project: rootPath, kind: "scripts" },
        filename: "flow.zip",
        content: ZIP
      })
    ),
    deps
  );
  assert.equal(scripts.status, 200, scripts.body);
  assert.equal(JSON.parse(scripts.body).asset.kind, "scripts");

  const secret = await handlePanelActionRequest(
    uploadRequest(
      multipartBody("----aosKinds", {
        fields: { project: rootPath, kind: "materials", secret: "true" },
        filename: "creds.json",
        content: Buffer.from("{}")
      })
    ),
    deps
  );
  assert.equal(secret.status, 200, secret.body);
  assert.deepEqual(JSON.parse(secret.body).asset.metadata, { secret: true });

  const normal = await handlePanelActionRequest(
    uploadRequest(
      multipartBody("----aosKinds", {
        fields: { project: rootPath, kind: "materials" },
        filename: "readme.txt",
        content: Buffer.from("hi")
      })
    ),
    deps
  );
  assert.equal(normal.status, 200, normal.body);
  assert.deepEqual(JSON.parse(normal.body).asset.metadata, {}, "未传 secret 不伪造标记");

  assert.equal((await listWebAssets(store, rootPath, "package")).length, 1);
  assert.equal((await listWebAssets(store, rootPath, "scripts")).length, 1);
  assert.equal((await listWebAssets(store, rootPath, "materials")).length, 2);
});

test("API /panel/api/projects/assets: extension 与 kind 不匹配/超大/未知 kind 返回 typed 400/413", async (t) => {
  const workspace = await tempDir(t, "aos-kinds-api-");
  const rootPath = path.join(workspace, "acme");
  await mkdir(rootPath, { recursive: true });
  const store = new MemoryStore();
  await makeProject(store, rootPath);
  const deps = { store, env: {}, workspaceRoot: workspace };

  const wrongExt = await handlePanelActionRequest(
    uploadRequest(
      multipartBody("----aosKinds", {
        fields: { project: rootPath, kind: "package" },
        filename: "cases.xlsx",
        content: ZIP
      })
    ),
    deps
  );
  assert.equal(wrongExt.status, 400, wrongExt.body);
  assert.equal(JSON.parse(wrongExt.body).code, "invalid-extension");

  const badKind = await handlePanelActionRequest(
    uploadRequest(
      multipartBody("----aosKinds", {
        fields: { project: rootPath, kind: "binary" },
        filename: "app.apk",
        content: APK
      })
    ),
    deps
  );
  assert.equal(badKind.status, 400, badKind.body);
  assert.match(JSON.parse(badKind.body).error, /kind/);

  const tooLarge = await handlePanelActionRequest(
    uploadRequest(
      multipartBody("----aosKinds", {
        fields: { project: rootPath, kind: "scripts" },
        filename: "flow.zip",
        content: Buffer.alloc(webAssetMaxBytes("scripts") + 1)
      })
    ),
    deps
  );
  assert.equal(tooLarge.status, 413, tooLarge.body);

  const secretOnPackage = await handlePanelActionRequest(
    uploadRequest(
      multipartBody("----aosKinds", {
        fields: { project: rootPath, kind: "package", secret: "true" },
        filename: "app.apk",
        content: APK
      })
    ),
    deps
  );
  assert.equal(secretOnPackage.status, 400, secretOnPackage.body);
  assert.equal(JSON.parse(secretOnPackage.body).code, "invalid-metadata");

  const backslash = await handlePanelActionRequest(
    uploadRequest(
      multipartBody("----aosKinds", {
        fields: { project: rootPath, kind: "package" },
        filename: "..\\app.apk",
        content: APK
      })
    ),
    deps
  );
  assert.equal(backslash.status, 400, backslash.body);
  assert.equal(JSON.parse(backslash.body).code, "invalid-filename");

  assert.deepEqual(await store.listWebAssets(rootPath), []);
});
