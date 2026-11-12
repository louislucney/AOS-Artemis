import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { renderWebAssetsPage } from "../dist/console/pages.js";
import { MemoryStore } from "../dist/db/memory.js";
import { handlePanelActionRequest } from "../dist/panel/actions.js";
import { storeWebAsset } from "../dist/web/assets.js";
import { baseConfig, makeTempProject } from "./helpers.js";

async function setup() {
  const dir = makeTempProject({ config: baseConfig() });
  const store = new MemoryStore();
  await store.upsertProject({ rootPath: dir, name: "assets" });
  return { dir, store };
}


async function seedAsset(store, dir, filename = "app.apk", kind = "package") {
  return await storeWebAsset({
    store,
    rootPath: dir,
    kind,
    filename,
    buffer: Buffer.from(`fake-${filename}`)
  });
}

test("assets: 归档默认隐藏、可恢复；已归档视图显示操作按钮", async () => {
  const { dir, store } = await setup();
  const asset = await seedAsset(store, dir);

  const archivedResponse = await handlePanelActionRequest(
    {
      method: "POST",
      url: new URL("http://localhost/panel/api/projects/assets/archive"),
      body: { project: dir, assetId: asset.id, archived: true }
    },
    { store, env: {} }
  );
  assert.equal(archivedResponse.status, 200);
  const archived = await store.getWebAsset(dir, asset.id);
  assert.ok(archived?.archivedAt);
  assert.equal((await store.listWebAssets(dir)).length, 0, "默认列表不含归档");
  assert.equal(
    (await store.listWebAssets(dir, undefined, { includeArchived: true })).length,
    1
  );

  const activeHtml = renderWebAssetsPage({
    rootPath: dir,
    rootLabel: "assets",
    assets: [],
    packages: [],
    materials: [],
    references: [],
    mappings: [],
    archivedView: false
  });
  assert.match(activeHtml, /查看已归档/);

  const archivedHtml = renderWebAssetsPage({
    rootPath: dir,
    rootLabel: "assets",
    assets: [],
    packages: [archived],
    materials: [],
    references: [],
    mappings: [],
    archivedView: true
  });
  assert.match(archivedHtml, /恢复/);
  assert.match(archivedHtml, /彻底删除/);
  assert.match(archivedHtml, /已归档/);

  const restoredResponse = await handlePanelActionRequest(
    {
      method: "POST",
      url: new URL("http://localhost/panel/api/projects/assets/archive"),
      body: { project: dir, assetId: asset.id, archived: false }
    },
    { store, env: {} }
  );
  assert.equal(restoredResponse.status, 200);
  assert.equal((await store.getWebAsset(dir, asset.id))?.archivedAt, null);
  assert.equal((await store.listWebAssets(dir)).length, 1);
});

test("assets: 无引用可彻底删除并清理文件；有引用拒绝", async () => {
  const { dir, store } = await setup();
  const asset = await seedAsset(store, dir);
  assert.ok(fs.existsSync(asset.storagePath));

  const deleted = await handlePanelActionRequest(
    {
      method: "POST",
      url: new URL("http://localhost/panel/api/projects/assets/delete"),
      body: { project: dir, assetId: asset.id }
    },
    { store, env: {} }
  );
  assert.equal(deleted.status, 200);
  assert.equal(await store.getWebAsset(dir, asset.id), null);
  assert.equal(fs.existsSync(asset.storagePath), false, "无共享时删除文件");

  const second = await seedAsset(store, dir, "app2.apk");
  await store.createRegressionTask({
    rootPath: dir,
    refs: [{ caseSetId: "cs-1", featureKey: "f-1" }],
    platforms: ["android"],
    baseline: "latest",
    appAssetId: second.id
  });
  const refused = await handlePanelActionRequest(
    {
      method: "POST",
      url: new URL("http://localhost/panel/api/projects/assets/delete"),
      body: { project: dir, assetId: second.id }
    },
    { store, env: {} }
  );
  assert.equal(refused.status, 409);
  assert.match(refused.body, /仍被引用/);
  assert.ok(fs.existsSync(second.storagePath));
});

test("assets: 同一文件被多个资产共享时，删除一条记录保留文件", async () => {
  const { dir, store } = await setup();
  const first = await seedAsset(store, dir);
  const second = await store.createWebAsset({
    rootPath: dir,
    kind: "reference",
    filename: "shared.png",
    sha256: first.sha256,
    size: first.size,
    storagePath: first.storagePath
  });
  const deleted = await handlePanelActionRequest(
    {
      method: "POST",
      url: new URL("http://localhost/panel/api/projects/assets/delete"),
      body: { project: dir, assetId: first.id }
    },
    { store, env: {} }
  );
  assert.equal(deleted.status, 200);
  const remaining = await store.getWebAsset(dir, second.id);
  assert.equal(remaining?.id, second.id);
  assert.ok(fs.existsSync(first.storagePath), "共享文件仍被保留");
});
