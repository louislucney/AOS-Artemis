import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import ExcelJS from "exceljs";
import { newDb } from "pg-mem";

import { FileStore } from "../dist/db/file.js";
import { MemoryStore } from "../dist/db/memory.js";
import { PostgresStore } from "../dist/db/postgres.js";
import { handlePanelActionRequest } from "../dist/panel/actions.js";
import { panelRequiredRoleForPath } from "../dist/panel/roles.js";
import { storeWebAsset } from "../dist/web/assets.js";
import {
  ExcelMappingServiceError,
  findExcelMapping,
  listExcelMappings,
  mappingFingerprint,
  previewExcelAsset,
  saveExcelMapping
} from "../dist/web/excel-mapping.js";
import {
  ExcelMappingError,
  semanticFingerprint,
  suggestExcelMapping
} from "../dist/web/excel.js";

const MAINTAINER = { name: "alice", role: "maintainer", source: "user" };
const DISPATCHER = { name: "bob", role: "dispatcher", source: "user" };
const VIEWER = { name: "carol", role: "viewer", source: "user" };

const HEADERS = [
  "用例编号",
  "用例名",
  "步骤",
  "预期",
  "前置条件",
  "模块",
  "优先级",
  "测试数据",
  "测试编号"
];

async function tempDir(t, prefix) {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  if (t) t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function xlsxBuffer(rows, { sheetName = "用例", extraSheets = [] } = {}) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(sheetName);
  for (const row of rows) sheet.addRow(row);
  for (const extra of extraSheets) {
    const worksheet = workbook.addWorksheet(extra.name);
    for (const row of extra.rows) worksheet.addRow(row);
  }
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

function workbook({ headers = HEADERS, rows = [], sheetName = "用例" } = {}) {
  return xlsxBuffer([headers, ...rows], { sheetName });
}

function isMappingError(code) {
  return (error) => {
    assert.ok(error instanceof ExcelMappingError, `expected ExcelMappingError, got ${error}`);
    assert.equal(error.code, code, error.message);
    return true;
  };
}

function isServiceError(code, status) {
  return (error) => {
    assert.ok(
      error instanceof ExcelMappingServiceError,
      `expected ExcelMappingServiceError, got ${error}`
    );
    assert.equal(error.code, code, error.message);
    if (status !== undefined) assert.equal(error.status, status);
    return true;
  };
}

async function setupProject(t, prefix = "aos-excel-mapping-") {
  const workspace = await tempDir(t, prefix);
  const rootPath = path.join(workspace, "acme");
  await mkdir(rootPath, { recursive: true });
  const store = new MemoryStore();
  await store.upsertProject({ rootPath, name: "acme" });
  await store.createWebProject({
    rootPath,
    name: "acme",
    normalizedName: "acme",
    platforms: ["android"]
  });
  return { workspace, rootPath, store };
}

async function addExcelAsset(store, rootPath, buffer, filename = "cases.xlsx") {
  return storeWebAsset({
    store,
    rootPath,
    kind: "excel",
    filename,
    buffer,
    uploadedBy: "alice"
  });
}

function depsFor(store) {
  return { store, env: {}, workspaceRoot: null };
}

function postJson(deps, pathname, body, identity = MAINTAINER) {
  return handlePanelActionRequest(
    {
      method: "POST",
      url: new URL(`http://localhost${pathname}`),
      body,
      identity
    },
    deps
  );
}

async function makePgStore() {
  const mem = newDb();
  const { Pool } = mem.adapters.createPg();
  const store = new PostgresStore(new Pool());
  await store.init();
  return store;
}

test("previewExcelAsset: 返回表头/建议/语义指纹；缺必填列仍可预览、列换序指纹不变", async (t) => {
  const { rootPath, store } = await setupProject(t);
  const partialHeaders = ["备注", "标题", "步骤", "自定义"];
  const asset = await addExcelAsset(store, rootPath, await xlsxBuffer([partialHeaders]));

  const preview = await previewExcelAsset({
    store,
    rootPath,
    assetId: asset.id
  });
  assert.equal(preview.sheetName, "用例");
  assert.deepEqual(preview.headers, partialHeaders);
  assert.deepEqual(preview.suggested, { name: "标题", steps: "步骤" });
  assert.equal(preview.fingerprint, semanticFingerprint("用例", partialHeaders));
  assert.deepEqual(preview.rejectedPreview, []);

  const reordered = ["自定义", "步骤", "标题", "备注"];
  const reorderedAsset = await addExcelAsset(
    store,
    rootPath,
    await xlsxBuffer([reordered]),
    "reordered.xlsx"
  );
  const reorderedPreview = await previewExcelAsset({
    store,
    rootPath,
    assetId: reorderedAsset.id
  });
  assert.deepEqual(reorderedPreview.suggested, { name: "标题", steps: "步骤" });
  assert.equal(reorderedPreview.fingerprint, preview.fingerprint, "列顺序变化语义指纹相同");
});

test("mappingFingerprint: 与建议映射的语义指纹一致，随确认字段集合/工作表变化", () => {
  const headers = ["用例编号", "用例名", "步骤", "预期", "备注"];
  const suggested = suggestExcelMapping(headers);
  assert.equal(
    mappingFingerprint("用例", suggested),
    semanticFingerprint("用例", headers),
    "建议映射指纹与 Task 5 语义指纹同源"
  );
  assert.match(mappingFingerprint("用例", suggested), /^[0-9a-f]{64}$/);

  const minimal = { caseId: "用例编号", steps: "步骤" };
  assert.notEqual(mappingFingerprint("用例", minimal), mappingFingerprint("用例", suggested));
  assert.equal(
    mappingFingerprint("用例", { steps: "步骤", caseId: "用例编号" }),
    mappingFingerprint("用例", minimal),
    "映射键顺序不影响指纹"
  );
  assert.notEqual(mappingFingerprint("其他", suggested), mappingFingerprint("用例", suggested));
});

test("saveExcelMapping: 同 asset+fingerprint upsert（最新覆盖），find/list 可查回", async (t) => {
  const { rootPath, store } = await setupProject(t);
  const headers = ["用例编号", "用例名", "标题", "步骤"];
  const asset = await addExcelAsset(store, rootPath, await xlsxBuffer([headers]));
  const preview = await previewExcelAsset({ store, rootPath, assetId: asset.id });
  assert.deepEqual(preview.suggested, {
    caseId: "用例编号",
    name: "用例名",
    steps: "步骤"
  });

  const saved = await saveExcelMapping({
    store,
    rootPath,
    assetId: asset.id,
    sheetName: "用例",
    columnMap: preview.suggested,
    createdBy: "alice"
  });
  assert.match(saved.id, /^[0-9a-f-]{36}$/);
  assert.equal(saved.rootPath, rootPath);
  assert.equal(saved.assetId, asset.id);
  assert.equal(saved.sheetName, "用例");
  assert.equal(saved.headerFingerprint, preview.fingerprint);
  assert.deepEqual(saved.columnMap, preview.suggested);
  assert.equal(saved.createdBy, "alice");
  assert.equal(saved.createdAt.length > 0, true);

  assert.deepEqual(
    await findExcelMapping(store, rootPath, asset.id, saved.headerFingerprint),
    saved
  );
  assert.equal(await findExcelMapping(store, rootPath, asset.id, "f".repeat(64)), null);
  assert.equal(await findExcelMapping(store, rootPath, "missing", saved.headerFingerprint), null);

  const updatedMap = { caseId: "用例编号", name: "标题", steps: "步骤" };
  const updated = await saveExcelMapping({
    store,
    rootPath,
    assetId: asset.id,
    sheetName: "用例",
    columnMap: updatedMap,
    createdBy: "bob"
  });
  assert.equal(updated.headerFingerprint, saved.headerFingerprint, "字段集合相同指纹不变");
  assert.equal(updated.id, saved.id, "同键原地更新");
  assert.deepEqual(updated.columnMap, updatedMap);
  assert.equal(updated.createdBy, "bob");
  assert.equal(updated.createdAt, saved.createdAt);

  const listed = await listExcelMappings(store, rootPath);
  assert.deepEqual(listed, [updated]);

  const other = await addExcelAsset(store, rootPath, await xlsxBuffer([["用例编号", "步骤"]]), "other.xlsx");
  await saveExcelMapping({
    store,
    rootPath,
    assetId: other.id,
    sheetName: "用例",
    columnMap: { caseId: "用例编号", steps: "步骤" },
    createdBy: "alice"
  });
  assert.equal((await listExcelMappings(store, rootPath)).length, 2);
  assert.equal((await listExcelMappings(store, rootPath, other.id)).length, 1);
  assert.equal((await listExcelMappings(store, rootPath, other.id))[0].assetId, other.id);
  assert.equal((await listExcelMappings(store, rootPath, "missing")).length, 0);
});

test("saveExcelMapping: 列换序后同一语义指纹仍能命中已保存映射", async (t) => {
  const { rootPath, store } = await setupProject(t);
  const asset = await addExcelAsset(store, rootPath, await xlsxBuffer([HEADERS]));
  const saved = await saveExcelMapping({
    store,
    rootPath,
    assetId: asset.id,
    sheetName: "用例",
    columnMap: suggestExcelMapping(HEADERS),
    createdBy: "alice"
  });

  const reordered = [...HEADERS].reverse();
  const moved = await addExcelAsset(
    store,
    rootPath,
    await xlsxBuffer([reordered]),
    "moved.xlsx"
  );
  const preview = await previewExcelAsset({ store, rootPath, assetId: moved.id });
  assert.equal(preview.fingerprint, saved.headerFingerprint);
  assert.deepEqual(
    await findExcelMapping(store, rootPath, asset.id, preview.fingerprint),
    saved
  );
});

test("saveExcelMapping: 缺必填列/列不存在/未知字段/未知资产/非 Excel/越界路径显式报错", async (t) => {
  const { workspace, rootPath, store } = await setupProject(t);
  const asset = await addExcelAsset(store, rootPath, await xlsxBuffer([HEADERS]));

  await assert.rejects(
    () =>
      saveExcelMapping({
        store,
        rootPath,
        assetId: asset.id,
        sheetName: "用例",
        columnMap: { caseId: "用例编号" }
      }),
    isMappingError("missing-required")
  );
  await assert.rejects(
    () =>
      saveExcelMapping({
        store,
        rootPath,
        assetId: asset.id,
        sheetName: "用例",
        columnMap: { caseId: "用例编号", steps: "不存在的列" }
      }),
    isMappingError("column-not-found")
  );
  await assert.rejects(
    () =>
      saveExcelMapping({
        store,
        rootPath,
        assetId: asset.id,
        sheetName: "用例",
        columnMap: { caseId: "用例编号", steps: "步骤", unknown: "预期" }
      }),
    isServiceError("invalid-column-map", 400)
  );
  await assert.rejects(
    () =>
      saveExcelMapping({
        store,
        rootPath,
        assetId: asset.id,
        sheetName: "用例",
        columnMap: { caseId: "用例编号", steps: 42 }
      }),
    isServiceError("invalid-column-map", 400)
  );
  await assert.rejects(
    () =>
      saveExcelMapping({
        store,
        rootPath,
        assetId: asset.id,
        sheetName: "",
        columnMap: suggestExcelMapping(HEADERS)
      }),
    isServiceError("invalid-sheet", 400)
  );
  await assert.rejects(
    () =>
      saveExcelMapping({
        store,
        rootPath,
        assetId: asset.id,
        sheetName: "不存在",
        columnMap: suggestExcelMapping(HEADERS)
      }),
    isMappingError("sheet-not-found")
  );
  await assert.rejects(
    () =>
      saveExcelMapping({
        store,
        rootPath,
        assetId: "missing",
        sheetName: "用例",
        columnMap: suggestExcelMapping(HEADERS)
      }),
    isServiceError("asset-not-found", 404)
  );

  const packageAsset = await store.createWebAsset({
    rootPath,
    kind: "package",
    filename: "app.apk",
    sha256: "a".repeat(64),
    size: 1,
    storagePath: path.join(rootPath, ".artemis", "web", "assets", "package", "app.apk")
  });
  await assert.rejects(
    () =>
      saveExcelMapping({
        store,
        rootPath,
        assetId: packageAsset.id,
        sheetName: "用例",
        columnMap: suggestExcelMapping(HEADERS)
      }),
    isServiceError("asset-not-excel", 400)
  );

  const outside = path.join(workspace, "outside.xlsx");
  const escapeAsset = await store.createWebAsset({
    rootPath,
    kind: "excel",
    filename: "outside.xlsx",
    sha256: "b".repeat(64),
    size: 1,
    storagePath: outside
  });
  await assert.rejects(
    () =>
      saveExcelMapping({
        store,
        rootPath,
        assetId: escapeAsset.id,
        sheetName: "用例",
        columnMap: suggestExcelMapping(HEADERS)
      }),
    isServiceError("asset-path-invalid", 400)
  );

  const missingFile = await store.createWebAsset({
    rootPath,
    kind: "excel",
    filename: "gone.xlsx",
    sha256: "c".repeat(64),
    size: 1,
    storagePath: path.join(rootPath, ".artemis", "web", "assets", "excel", "gone.xlsx")
  });
  await assert.rejects(
    () =>
      saveExcelMapping({
        store,
        rootPath,
        assetId: missingFile.id,
        sheetName: "用例",
        columnMap: suggestExcelMapping(HEADERS)
      }),
    isServiceError("asset-file-missing", 404)
  );

  assert.deepEqual(await listExcelMappings(store, rootPath), [], "校验失败不写映射");
  assert.deepEqual(
    await findExcelMapping(store, rootPath, asset.id, semanticFingerprint("用例", HEADERS)),
    null
  );
});

test("FileStore: 映射在重启后仍在且 upsert 生效", async (t) => {
  const home = await tempDir(t, "aos-excel-map-file-");
  const rootPath = path.join(home, "acme");
  await mkdir(rootPath, { recursive: true });

  let store = await FileStore.create({ homeDir: home });
  await store.upsertProject({ rootPath, name: "acme" });
  await store.createWebProject({
    rootPath,
    name: "acme",
    normalizedName: "acme",
    platforms: ["android"]
  });
  const asset = await addExcelAsset(store, rootPath, await xlsxBuffer([HEADERS]));
  const saved = await saveExcelMapping({
    store,
    rootPath,
    assetId: asset.id,
    sheetName: "用例",
    columnMap: suggestExcelMapping(HEADERS),
    createdBy: "alice"
  });
  await store.close();

  store = await FileStore.create({ homeDir: home });
  assert.deepEqual(await findExcelMapping(store, rootPath, asset.id, saved.headerFingerprint), saved);
  const updated = await saveExcelMapping({
    store,
    rootPath,
    assetId: asset.id,
    sheetName: "用例",
    columnMap: { caseId: "用例编号", steps: "步骤" },
    createdBy: "bob"
  });
  assert.notEqual(updated.headerFingerprint, saved.headerFingerprint);
  assert.equal((await listExcelMappings(store, rootPath)).length, 2);
  await store.close();
});

test("PostgresStore (pg-mem): excel_mappings 往返、同键 upsert 与列表过滤", async () => {
  const store = await makePgStore();
  const rootPath = "/w/acme";
  const insert = (fingerprint, columnMap, createdBy = "alice") =>
    store.saveExcelMapping({
      rootPath,
      assetId: "asset-1",
      sheetName: "用例",
      headerFingerprint: fingerprint,
      columnMap,
      createdBy
    });

  const first = await insert("f".repeat(64), { caseId: "用例编号", steps: "步骤" });
  assert.equal(first.rootPath, rootPath);
  assert.equal(first.createdBy, "alice");
  assert.deepEqual(first.columnMap, { caseId: "用例编号", steps: "步骤" });

  const updated = await insert(
    "f".repeat(64),
    { caseId: "用例编号", name: "用例名", steps: "步骤" },
    "bob"
  );
  assert.equal(updated.id, first.id);
  assert.equal(updated.createdBy, "bob");
  assert.deepEqual(updated.columnMap, { caseId: "用例编号", name: "用例名", steps: "步骤" });

  const second = await insert("e".repeat(64), { caseId: "用例编号", steps: "步骤" });
  assert.notEqual(second.id, first.id);

  assert.deepEqual(await store.findExcelMapping(rootPath, "asset-1", "f".repeat(64)), updated);
  assert.equal(await store.findExcelMapping(rootPath, "asset-1", "d".repeat(64)), null);
  assert.equal(await store.findExcelMapping(rootPath, "asset-2", "f".repeat(64)), null);
  assert.equal((await store.listExcelMappings(rootPath, "asset-1")).length, 2);
  assert.equal((await store.listExcelMappings(rootPath)).length, 2);
  assert.equal((await store.listExcelMappings(rootPath, "asset-2")).length, 0);
});

test("API /panel/api/projects/excel/preview: 返回预览、缺必填列仍 200，越界/非 Excel/未知资产显式拒绝", async (t) => {
  const { workspace, rootPath, store } = await setupProject(t);
  const deps = depsFor(store);
  const asset = await addExcelAsset(store, rootPath, await xlsxBuffer([HEADERS]));

  const ok = await postJson(deps, "/panel/api/projects/excel/preview", {
    project: rootPath,
    assetId: asset.id
  });
  assert.equal(ok.status, 200, ok.body);
  const preview = JSON.parse(ok.body);
  assert.equal(preview.ok, true);
  assert.equal(preview.sheetName, "用例");
  assert.deepEqual(preview.headers, HEADERS);
  assert.deepEqual(preview.suggested, suggestExcelMapping(HEADERS));
  assert.equal(preview.fingerprint, semanticFingerprint("用例", HEADERS));
  assert.deepEqual(preview.rejectedPreview, []);

  const twoRowAsset = await addExcelAsset(
    store,
    rootPath,
    await xlsxBuffer([HEADERS, ["1001", "登录", "打开", "成功"]]),
    "two-rows.xlsx"
  );
  const withHeaderRow = await postJson(deps, "/panel/api/projects/excel/preview", {
    project: rootPath,
    assetId: twoRowAsset.id,
    headerRow: 2
  });
  assert.equal(withHeaderRow.status, 200, withHeaderRow.body);
  assert.equal(JSON.parse(withHeaderRow.body).headers[0], "1001");

  const partial = await addExcelAsset(
    store,
    rootPath,
    await xlsxBuffer([["备注", "标题"]]),
    "partial.xlsx"
  );
  const partialRes = await postJson(deps, "/panel/api/projects/excel/preview", {
    project: rootPath,
    assetId: partial.id
  });
  assert.equal(partialRes.status, 200, partialRes.body);
  const partialPayload = JSON.parse(partialRes.body);
  assert.deepEqual(partialPayload.suggested, { name: "标题" });
  assert.equal(partialPayload.fingerprint, semanticFingerprint("用例", ["备注", "标题"]));

  const unknown = await postJson(deps, "/panel/api/projects/excel/preview", {
    project: rootPath,
    assetId: "missing"
  });
  assert.equal(unknown.status, 404, unknown.body);
  assert.equal(JSON.parse(unknown.body).code, "asset-not-found");

  const packageAsset = await store.createWebAsset({
    rootPath,
    kind: "package",
    filename: "app.apk",
    sha256: "a".repeat(64),
    size: 1,
    storagePath: path.join(rootPath, ".artemis", "web", "assets", "package", "app.apk")
  });
  const notExcel = await postJson(deps, "/panel/api/projects/excel/preview", {
    project: rootPath,
    assetId: packageAsset.id
  });
  assert.equal(notExcel.status, 400, notExcel.body);
  assert.equal(JSON.parse(notExcel.body).code, "asset-not-excel");

  const escapeAsset = await store.createWebAsset({
    rootPath,
    kind: "excel",
    filename: "outside.xlsx",
    sha256: "b".repeat(64),
    size: 1,
    storagePath: path.join(workspace, "outside.xlsx")
  });
  const traversal = await postJson(deps, "/panel/api/projects/excel/preview", {
    project: rootPath,
    assetId: escapeAsset.id
  });
  assert.equal(traversal.status, 400, traversal.body);
  assert.equal(JSON.parse(traversal.body).code, "asset-path-invalid");

  const corrupt = await addExcelAsset(store, rootPath, Buffer.from("not an xlsx"), "bad.xlsx");
  const invalid = await postJson(deps, "/panel/api/projects/excel/preview", {
    project: rootPath,
    assetId: corrupt.id
  });
  assert.equal(invalid.status, 400, invalid.body);
  assert.equal(JSON.parse(invalid.body).code, "invalid-workbook");

  const badHeader = await postJson(deps, "/panel/api/projects/excel/preview", {
    project: rootPath,
    assetId: asset.id,
    headerRow: 99
  });
  assert.equal(badHeader.status, 400, badHeader.body);
  assert.equal(JSON.parse(badHeader.body).code, "invalid-header-row");

  const forbidden = await postJson(
    deps,
    "/panel/api/projects/excel/preview",
    { project: rootPath, assetId: asset.id },
    DISPATCHER
  );
  assert.equal(forbidden.status, 403, forbidden.body);
  assert.equal(JSON.parse(forbidden.body).code, "role_forbidden");

  const otherProject = path.join(workspace, "other");
  await mkdir(otherProject, { recursive: true });
  await store.upsertProject({ rootPath: otherProject, name: "other" });
  const scoped = await postJson(deps, "/panel/api/projects/excel/preview", {
    project: otherProject,
    assetId: asset.id
  });
  assert.equal(scoped.status, 404, scoped.body);
  assert.equal(JSON.parse(scoped.body).code, "asset-not-found");
});

test("API /panel/api/projects/excel/mapping: 保存 upsert 并写 excel.mapping.save 审计", async (t) => {
  const { rootPath, store } = await setupProject(t);
  const deps = depsFor(store);
  const headers = ["用例编号", "用例名", "标题", "步骤", "预期"];
  const asset = await addExcelAsset(store, rootPath, await xlsxBuffer([headers]));
  const columnMap = suggestExcelMapping(headers);
  assert.deepEqual(columnMap, { caseId: "用例编号", name: "用例名", steps: "步骤", expected: "预期" });

  const res = await postJson(deps, "/panel/api/projects/excel/mapping", {
    project: rootPath,
    assetId: asset.id,
    sheetName: "用例",
    columnMap
  });
  assert.equal(res.status, 200, res.body);
  const payload = JSON.parse(res.body);
  assert.equal(payload.ok, true);
  const saved = payload.mapping;
  assert.equal(saved.assetId, asset.id);
  assert.equal(saved.headerFingerprint, semanticFingerprint("用例", headers));
  assert.deepEqual(saved.columnMap, columnMap);
  assert.equal(saved.createdBy, "alice");

  const audit = await store.listAudit(rootPath, { domain: "excel" });
  assert.equal(audit.length, 1);
  assert.equal(audit[0].action, "excel.mapping.save");
  assert.equal(audit[0].result, "ok");
  assert.equal(audit[0].actor, "alice");
  assert.equal(audit[0].refs.assetId, asset.id);
  assert.equal(audit[0].refs.headerFingerprint, saved.headerFingerprint);

  const updatedMap = { ...columnMap, name: "标题" };
  const resaved = await postJson(deps, "/panel/api/projects/excel/mapping", {
    project: rootPath,
    assetId: asset.id,
    sheetName: "用例",
    columnMap: updatedMap
  });
  assert.equal(resaved.status, 200, resaved.body);
  const resavedMapping = JSON.parse(resaved.body).mapping;
  assert.equal(resavedMapping.id, saved.id, "同键 upsert");
  assert.equal(resavedMapping.headerFingerprint, saved.headerFingerprint);
  assert.deepEqual(resavedMapping.columnMap, updatedMap);
  assert.equal((await listExcelMappings(store, rootPath)).length, 1);

  const changedFields = await postJson(deps, "/panel/api/projects/excel/mapping", {
    project: rootPath,
    assetId: asset.id,
    sheetName: "用例",
    columnMap: { caseId: "用例编号", steps: "步骤" }
  });
  assert.equal(changedFields.status, 200, changedFields.body);
  assert.notEqual(
    JSON.parse(changedFields.body).mapping.headerFingerprint,
    saved.headerFingerprint,
    "确认的字段集合变化 → 新指纹/新行"
  );
  assert.equal((await listExcelMappings(store, rootPath)).length, 2);

  const invalid = await postJson(deps, "/panel/api/projects/excel/mapping", {
    project: rootPath,
    assetId: asset.id,
    sheetName: "用例",
    columnMap: { caseId: "用例编号" }
  });
  assert.equal(invalid.status, 400, invalid.body);
  assert.equal(JSON.parse(invalid.body).code, "missing-required");
  const failedAudit = (await store.listAudit(rootPath, { domain: "excel" })).find(
    (event) => event.result === "failed"
  );
  assert.ok(failedAudit, "校验失败写 failed 审计");
  assert.equal(failedAudit.action, "excel.mapping.save");

  const missingSheet = await postJson(deps, "/panel/api/projects/excel/mapping", {
    project: rootPath,
    assetId: asset.id,
    columnMap
  });
  assert.equal(missingSheet.status, 400, missingSheet.body);
  assert.equal(JSON.parse(missingSheet.body).code, "invalid-sheet");

  const unknown = await postJson(deps, "/panel/api/projects/excel/mapping", {
    project: rootPath,
    assetId: "missing",
    sheetName: "用例",
    columnMap
  });
  assert.equal(unknown.status, 404, unknown.body);
  assert.equal(JSON.parse(unknown.body).code, "asset-not-found");

  const forbidden = await postJson(
    deps,
    "/panel/api/projects/excel/mapping",
    { project: rootPath, assetId: asset.id, sheetName: "用例", columnMap },
    DISPATCHER
  );
  assert.equal(forbidden.status, 403, forbidden.body);

  const viewer = await postJson(
    deps,
    "/panel/api/projects/excel/mapping",
    { project: rootPath, assetId: asset.id, sheetName: "用例", columnMap },
    VIEWER
  );
  assert.equal(viewer.status, 403, viewer.body);
});

test("面板角色：预览与映射保存均要求 maintainer", () => {
  assert.equal(panelRequiredRoleForPath("/panel/api/projects/excel/preview"), "maintainer");
  assert.equal(panelRequiredRoleForPath("/panel/api/projects/excel/mapping"), "maintainer");
});
