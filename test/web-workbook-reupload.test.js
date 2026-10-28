import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import ExcelJS from "exceljs";

import { MemoryStore } from "../dist/db/memory.js";
import { handlePanelActionRequest } from "../dist/panel/actions.js";
import { storeWebAsset } from "../dist/web/assets.js";
import { ensureWorkbookCopy, workbookCopyPath } from "../dist/web/workbook.js";
import { writebackWorkbook } from "../dist/web/writeback.js";
import {
  detectSystemColumns,
  rebaseWorkbookJournal,
  resolveCaseIdHeader
} from "../dist/web/workbook-reupload.js";

const ADMIN = { name: "alice", role: "maintainer", source: "user" };
const HEADERS = [
  "用例编号",
  "用例名",
  "步骤",
  "建议｜脚本文件",
  "执行｜结果",
  "执行｜traceId"
];
const ROWS = [
  ["TC-1", "登录成功", "1. 打开应用", "login.yaml", "FAIL", "trace-1"],
  ["TC-2", "退出登录", "2. 点击退出", "logout.yaml", "PASS", "trace-2"]
];

/** 已写回过的系统值（与 ROWS 的系统列一致），模拟 Plan 1 的 journal。 */
const SEEDED = [
  ["TC-1", "scriptFile", "login.yaml", "用例!D2"],
  ["TC-1", "result", "FAIL", "用例!E2"],
  ["TC-1", "traceId", "trace-1", "用例!F2"],
  ["TC-2", "scriptFile", "logout.yaml", "用例!D3"],
  ["TC-2", "result", "PASS", "用例!E3"],
  ["TC-2", "traceId", "trace-2", "用例!F3"]
];

async function tempDir(t, prefix = "aos-web-reupload-") {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  if (t) t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function makeProject(store, rootPath, name = "acme") {
  await mkdir(rootPath, { recursive: true });
  await store.upsertProject({ rootPath, name });
  return store.createWebProject({ rootPath, name, normalizedName: name, platforms: ["android"] });
}

function cellText(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value.richText)) return value.richText.map((part) => part.text).join("");
  if (value.result !== undefined && value.result !== null) return cellText(value.result);
  if (typeof value.text === "string") return value.text;
  return "";
}

async function workbookBuffer({
  headers = HEADERS,
  rows = ROWS,
  sheetName = "用例",
  extraSheets = []
} = {}) {
  const workbook = new ExcelJS.Workbook();
  for (const extra of extraSheets) {
    const sheet = workbook.addWorksheet(extra.name);
    for (const row of extra.rows) sheet.addRow(row);
  }
  const sheet = workbook.addWorksheet(sheetName);
  sheet.addRow(headers);
  for (const row of rows) sheet.addRow(row);
  return Buffer.from((await workbook.xlsx.writeBuffer()));
}

async function saveMapping(
  store,
  { rootPath, assetId, sheetName = "用例", caseId = "用例编号", steps = "步骤" }
) {
  return store.saveExcelMapping({
    rootPath,
    assetId,
    sheetName,
    headerFingerprint: `fp-${assetId}`,
    columnMap: { caseId, steps },
    createdBy: "alice"
  });
}

async function seedJournal(store, { rootPath, assetId, sheetName = "用例" }) {
  for (const [caseId, columnKey, value, cellRef] of SEEDED) {
    await store.recordExcelWriteback({
      rootPath,
      assetId,
      sheetName,
      jobId: "job-seed",
      caseId,
      columnKey,
      cellRef,
      value,
      actor: "alice"
    });
  }
}

function journalCount(store) {
  return store.exportState().excelWritebacks.length;
}

async function lastValue(store, rootPath, assetId, caseId, columnKey, sheetName = "用例") {
  const record = await store.lastExcelWritebackByCellKey(
    rootPath,
    assetId,
    sheetName,
    caseId,
    columnKey
  );
  return record ? record.value : null;
}

async function upload(buffer, { fields = {}, filename = "cases.xlsx", boundary = "----aosReupload" } = {}) {
  const parts = [];
  for (const [key, value] of Object.entries(fields)) {
    parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`);
  }
  parts.push(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`
  );
  const body = Buffer.concat([
    Buffer.from(parts.join(""), "utf8"),
    buffer,
    Buffer.from(`\r\n--${boundary}--\r\n`, "utf8")
  ]);
  return {
    method: "POST",
    url: new URL("http://localhost/panel/api/projects/assets"),
    body: {},
    rawBody: body,
    contentType: `multipart/form-data; boundary=${boundary}`,
    identity: ADMIN
  };
}

test("inherit：下载后原样重上传，未改系统格重播种到新 asset，随后可被写回刷新", async (t) => {
  const workspace = await tempDir(t);
  const rootPath = path.join(workspace, "acme");
  const store = new MemoryStore();
  await makeProject(store, rootPath);

  const buffer = await workbookBuffer();
  const previous = await storeWebAsset({
    store,
    rootPath,
    kind: "excel",
    filename: "cases.xlsx",
    buffer
  });
  await seedJournal(store, { rootPath, assetId: previous.id });
  await saveMapping(store, { rootPath, assetId: previous.id });
  const reuploaded = await storeWebAsset({
    store,
    rootPath,
    kind: "excel",
    filename: "cases.xlsx",
    buffer
  });
  assert.equal(reuploaded.version, previous.version + 1);
  assert.notEqual(reuploaded.id, previous.id);

  const result = await rebaseWorkbookJournal({
    store,
    rootPath,
    previousAssetId: previous.id,
    newAssetId: reuploaded.id,
    workbookPath: reuploaded.storagePath,
    mode: "inherit"
  });

  assert.equal(result.mode, "inherit");
  assert.equal(result.rebased, 6);
  assert.equal(result.frozen, 0);
  assert.deepEqual(result.mismatched, []);
  assert.deepEqual(result.systemHeaders, ["建议｜脚本文件", "执行｜结果", "执行｜traceId"]);
  assert.deepEqual(result.warnings, []);
  assert.equal(await lastValue(store, rootPath, reuploaded.id, "TC-1", "result"), "FAIL");
  assert.equal(await lastValue(store, rootPath, reuploaded.id, "TC-2", "scriptFile"), "logout.yaml");

  // 重播种后，新 asset 的工作副本按 journal 归属可刷新（不再是「人工冻结」）。
  const copyPath = workbookCopyPath(rootPath, reuploaded.id);
  await ensureWorkbookCopy(reuploaded.storagePath, copyPath);
  const second = await writebackWorkbook({
    workbookPath: copyPath,
    assetId: reuploaded.id,
    sheetName: "用例",
    caseIdHeader: "用例编号",
    rows: [{ caseId: "TC-1", values: { result: "PASS" } }],
    lastSystemValue: (caseId, key) => lastValue(store, rootPath, reuploaded.id, caseId, key)
  });
  assert.equal(second.written, 1);
  assert.equal(second.warnings.length, 0);
});

test("inherit：手改某系统格 → 该格 frozen（记入 mismatched），其余一致格重播种", async (t) => {
  const workspace = await tempDir(t);
  const rootPath = path.join(workspace, "acme");
  const store = new MemoryStore();
  await makeProject(store, rootPath);

  const previous = await storeWebAsset({
    store,
    rootPath,
    kind: "excel",
    filename: "cases.xlsx",
    buffer: await workbookBuffer()
  });
  await seedJournal(store, { rootPath, assetId: previous.id });
  await saveMapping(store, { rootPath, assetId: previous.id });

  const editedRows = ROWS.map((row, index) =>
    index === 0 ? [row[0], row[1], row[2], row[3], "人工结论", row[5]] : row
  );
  const edited = await storeWebAsset({
    store,
    rootPath,
    kind: "excel",
    filename: "cases.xlsx",
    buffer: await workbookBuffer({ rows: editedRows })
  });

  const result = await rebaseWorkbookJournal({
    store,
    rootPath,
    previousAssetId: previous.id,
    newAssetId: edited.id,
    workbookPath: edited.storagePath,
    mode: "inherit"
  });
  assert.equal(result.rebased, 5);
  assert.equal(result.frozen, 1);
  assert.deepEqual(result.mismatched, ["TC-1「执行｜结果」"]);
  assert.equal(await lastValue(store, rootPath, edited.id, "TC-1", "result"), null);
  assert.equal(await lastValue(store, rootPath, edited.id, "TC-2", "result"), "PASS");
  assert.equal(await lastValue(store, rootPath, edited.id, "TC-1", "traceId"), "trace-1");
});

test("human/缺省：全部视为人工格，journal 不新增", async (t) => {
  const workspace = await tempDir(t);
  const rootPath = path.join(workspace, "acme");
  const store = new MemoryStore();
  await makeProject(store, rootPath);

  const previous = await storeWebAsset({
    store,
    rootPath,
    kind: "excel",
    filename: "cases.xlsx",
    buffer: await workbookBuffer()
  });
  await seedJournal(store, { rootPath, assetId: previous.id });
  const reuploaded = await storeWebAsset({
    store,
    rootPath,
    kind: "excel",
    filename: "cases.xlsx",
    buffer: await workbookBuffer()
  });

  const before = journalCount(store);
  const result = await rebaseWorkbookJournal({
    store,
    rootPath,
    previousAssetId: previous.id,
    newAssetId: reuploaded.id,
    workbookPath: reuploaded.storagePath
  });
  assert.equal(result.mode, "human", "缺省 human");
  assert.equal(result.rebased, 0);
  assert.equal(result.frozen, 6);
  assert.deepEqual(result.mismatched, []);
  assert.equal(journalCount(store), before, "human 不写 journal");
  assert.equal(await lastValue(store, rootPath, reuploaded.id, "TC-1", "result"), null);
});

test("旧 asset 无 journal：全部 frozen，不伪造系统格", async (t) => {
  const workspace = await tempDir(t);
  const rootPath = path.join(workspace, "acme");
  const store = new MemoryStore();
  await makeProject(store, rootPath);

  const previous = await storeWebAsset({
    store,
    rootPath,
    kind: "excel",
    filename: "cases.xlsx",
    buffer: await workbookBuffer()
  });
  await saveMapping(store, { rootPath, assetId: previous.id });
  const reuploaded = await storeWebAsset({
    store,
    rootPath,
    kind: "excel",
    filename: "cases.xlsx",
    buffer: await workbookBuffer()
  });

  const result = await rebaseWorkbookJournal({
    store,
    rootPath,
    previousAssetId: previous.id,
    newAssetId: reuploaded.id,
    workbookPath: reuploaded.storagePath,
    mode: "inherit"
  });
  assert.equal(result.rebased, 0);
  assert.equal(result.frozen, 6);
  assert.deepEqual(result.mismatched, []);
  assert.deepEqual(result.warnings, []);
  assert.equal(journalCount(store), 0, "无 journal 不得伪造");
});

test("inherit 幂等：同 newAssetId 重复 rebase 不重复堆 journal", async (t) => {
  const workspace = await tempDir(t);
  const rootPath = path.join(workspace, "acme");
  const store = new MemoryStore();
  await makeProject(store, rootPath);

  const previous = await storeWebAsset({
    store,
    rootPath,
    kind: "excel",
    filename: "cases.xlsx",
    buffer: await workbookBuffer()
  });
  await seedJournal(store, { rootPath, assetId: previous.id });
  await saveMapping(store, { rootPath, assetId: previous.id });
  const reuploaded = await storeWebAsset({
    store,
    rootPath,
    kind: "excel",
    filename: "cases.xlsx",
    buffer: await workbookBuffer()
  });

  const first = await rebaseWorkbookJournal({
    store,
    rootPath,
    previousAssetId: previous.id,
    newAssetId: reuploaded.id,
    workbookPath: reuploaded.storagePath,
    mode: "inherit"
  });
  assert.equal(first.rebased, 6);
  const afterFirst = journalCount(store);

  const second = await rebaseWorkbookJournal({
    store,
    rootPath,
    previousAssetId: previous.id,
    newAssetId: reuploaded.id,
    workbookPath: reuploaded.storagePath,
    mode: "inherit"
  });
  assert.equal(second.rebased, 6, "重复 rebase 仍报告已重播种");
  assert.equal(second.frozen, 0);
  assert.equal(journalCount(store), afterFirst, "不得重复追加 journal 行");
});

test("detectSystemColumns：只认 建议｜/执行｜ 前缀列，不误伤人工列", () => {
  const headers = [
    "用例编号",
    "用例名",
    "步骤",
    "执行｜结果",
    "执行｜备注",
    "建议｜脚本文件",
    "人工｜结果",
    "备注",
    "执行｜traceId"
  ];
  assert.deepEqual(detectSystemColumns(headers, "用例编号"), [
    "执行｜结果",
    "执行｜备注",
    "建议｜脚本文件",
    "执行｜traceId"
  ]);
  assert.deepEqual(detectSystemColumns(["用例编号", "备注"], "用例编号"), []);
  // 用例编号右侧才算系统区（锚点左侧是业务列，即使表头带前缀）。
  assert.deepEqual(detectSystemColumns(["执行｜结果", "用例编号", "建议｜脚本文件"], "用例编号"), [
    "建议｜脚本文件"
  ]);
  assert.deepEqual(resolveCaseIdHeader(["展示编号", "步骤"], null), "展示编号");
  assert.deepEqual(resolveCaseIdHeader(["用例编号", "步骤"], "展示编号"), "用例编号");
  assert.equal(resolveCaseIdHeader(["步骤"], null), null);
});

test("inherit：用例编号表头经已保存映射解析（别名/自定义列名）", async (t) => {
  const workspace = await tempDir(t);
  const rootPath = path.join(workspace, "acme");
  const store = new MemoryStore();
  await makeProject(store, rootPath);

  const headers = ["展示编号", "用例名", "步骤", "执行｜结果"];
  const rows = [
    ["TC-1", "登录成功", "1. 打开应用", "FAIL"],
    ["TC-2", "退出登录", "2. 点击退出", "PASS"]
  ];
  const previous = await storeWebAsset({
    store,
    rootPath,
    kind: "excel",
    filename: "cases.xlsx",
    buffer: await workbookBuffer({ headers, rows })
  });
  await store.saveExcelMapping({
    rootPath,
    assetId: previous.id,
    sheetName: "用例",
    headerFingerprint: "fp-1",
    columnMap: { caseId: "展示编号", steps: "步骤" }
  });
  await store.recordExcelWriteback({
    rootPath,
    assetId: previous.id,
    sheetName: "用例",
    caseId: "TC-1",
    columnKey: "result",
    cellRef: "用例!D2",
    value: "FAIL"
  });
  await store.recordExcelWriteback({
    rootPath,
    assetId: previous.id,
    sheetName: "用例",
    caseId: "TC-2",
    columnKey: "result",
    cellRef: "用例!D3",
    value: "PASS"
  });

  const reuploaded = await storeWebAsset({
    store,
    rootPath,
    kind: "excel",
    filename: "cases.xlsx",
    buffer: await workbookBuffer({ headers, rows })
  });
  const result = await rebaseWorkbookJournal({
    store,
    rootPath,
    previousAssetId: previous.id,
    newAssetId: reuploaded.id,
    workbookPath: reuploaded.storagePath,
    mode: "inherit"
  });
  assert.equal(result.rebased, 2);
  assert.equal(result.frozen, 0);
  assert.equal(await lastValue(store, rootPath, reuploaded.id, "TC-2", "result"), "PASS");
});

test("API 上传：systemColumns 仅 excel、typed 400，inherit 返回计数并重播种", async (t) => {
  const workspace = await tempDir(t);
  const rootPath = path.join(workspace, "acme");
  const store = new MemoryStore();
  await makeProject(store, rootPath);
  const deps = { store, env: {}, workspaceRoot: workspace };

  const first = await handlePanelActionRequest(
    await upload(await workbookBuffer(), { fields: { project: rootPath, kind: "excel" } }),
    deps
  );
  assert.equal(first.status, 200, first.body);
  const firstBody = JSON.parse(first.body);
  assert.equal(firstBody.systemColumns.mode, "human", "未传默认 human");
  assert.equal(firstBody.systemColumns.rebased, 0);
  await seedJournal(store, { rootPath, assetId: firstBody.asset.id });
  await saveMapping(store, { rootPath, assetId: firstBody.asset.id });

  const second = await handlePanelActionRequest(
    await upload(await workbookBuffer(), {
      fields: { project: rootPath, kind: "excel", systemColumns: "inherit" }
    }),
    deps
  );
  assert.equal(second.status, 200, second.body);
  const secondBody = JSON.parse(second.body);
  assert.equal(secondBody.systemColumns.mode, "inherit");
  assert.equal(secondBody.systemColumns.rebased, 6);
  assert.equal(secondBody.systemColumns.frozen, 0);
  assert.deepEqual(secondBody.systemColumns.mismatched, []);
  assert.equal(
    await lastValue(store, rootPath, secondBody.asset.id, "TC-1", "result"),
    "FAIL"
  );

  const notExcel = await handlePanelActionRequest(
    await upload(Buffer.from("PK-zip"), {
      fields: { project: rootPath, kind: "scripts", systemColumns: "inherit" },
      filename: "flow.zip"
    }),
    deps
  );
  assert.equal(notExcel.status, 400, notExcel.body);
  assert.equal(JSON.parse(notExcel.body).code, "invalid-system-columns");

  const invalid = await handlePanelActionRequest(
    await upload(await workbookBuffer(), {
      fields: { project: rootPath, kind: "excel", systemColumns: "adopt" }
    }),
    deps
  );
  assert.equal(invalid.status, 400, invalid.body);
  assert.equal(JSON.parse(invalid.body).code, "invalid-system-columns");
});

test("API 上传：inherit 遇无 journal 旧版本仍成功，全部冻结并如实计数", async (t) => {
  const workspace = await tempDir(t);
  const rootPath = path.join(workspace, "acme");
  const store = new MemoryStore();
  await makeProject(store, rootPath);
  const deps = { store, env: {}, workspaceRoot: workspace };

  const first = await handlePanelActionRequest(
    await upload(await workbookBuffer(), { fields: { project: rootPath, kind: "excel" } }),
    deps
  );
  assert.equal(first.status, 200, first.body);
  const firstBody = JSON.parse(first.body);
  await saveMapping(store, { rootPath, assetId: firstBody.asset.id });

  const second = await handlePanelActionRequest(
    await upload(await workbookBuffer(), {
      fields: { project: rootPath, kind: "excel", systemColumns: "inherit" }
    }),
    deps
  );
  assert.equal(second.status, 200, second.body);
  const body = JSON.parse(second.body);
  assert.equal(body.ok, true);
  assert.equal(body.systemColumns.rebased, 0);
  assert.equal(body.systemColumns.frozen, 6);
  assert.deepEqual(body.systemColumns.mismatched, []);
  assert.deepEqual(body.systemColumns.warnings, []);
  assert.equal((await store.listWebAssets(rootPath, "excel")).length, 2);
});

test("inherit：多表工作簿按上一版本映射的工作表重播种（不读第一张表）", async (t) => {
  const workspace = await tempDir(t);
  const rootPath = path.join(workspace, "acme");
  const store = new MemoryStore();
  await makeProject(store, rootPath);

  const buffer = await workbookBuffer({
    extraSheets: [
      {
        name: "说明",
        rows: [
          ["执行｜结果", "执行｜traceId"],
          ["不是用例表", "decoy-trace"]
        ]
      }
    ]
  });
  const previous = await storeWebAsset({
    store,
    rootPath,
    kind: "excel",
    filename: "cases.xlsx",
    buffer
  });
  await seedJournal(store, { rootPath, assetId: previous.id });
  await saveMapping(store, { rootPath, assetId: previous.id, sheetName: "用例" });

  const reuploaded = await storeWebAsset({
    store,
    rootPath,
    kind: "excel",
    filename: "cases.xlsx",
    buffer
  });
  const result = await rebaseWorkbookJournal({
    store,
    rootPath,
    previousAssetId: previous.id,
    newAssetId: reuploaded.id,
    workbookPath: reuploaded.storagePath,
    mode: "inherit"
  });
  assert.equal(result.rebased, 6);
  assert.equal(result.frozen, 0);
  assert.deepEqual(result.warnings, []);
  assert.equal(await lastValue(store, rootPath, reuploaded.id, "TC-1", "result"), "FAIL");
  const records = await store.lastExcelWritebackByCellKey(
    rootPath,
    reuploaded.id,
    "说明",
    "不是用例表",
    "result"
  );
  assert.equal(records, null, "不得从其他工作表读系统格");
});

test("inherit：上一版本没有保存映射 → 告警并全部冻结（不静默 0/0）", async (t) => {
  const workspace = await tempDir(t);
  const rootPath = path.join(workspace, "acme");
  const store = new MemoryStore();
  await makeProject(store, rootPath);

  const previous = await storeWebAsset({
    store,
    rootPath,
    kind: "excel",
    filename: "cases.xlsx",
    buffer: await workbookBuffer()
  });
  await seedJournal(store, { rootPath, assetId: previous.id });
  const before = journalCount(store);
  const reuploaded = await storeWebAsset({
    store,
    rootPath,
    kind: "excel",
    filename: "cases.xlsx",
    buffer: await workbookBuffer()
  });

  const result = await rebaseWorkbookJournal({
    store,
    rootPath,
    previousAssetId: previous.id,
    newAssetId: reuploaded.id,
    workbookPath: reuploaded.storagePath,
    mode: "inherit"
  });
  assert.equal(result.rebased, 0);
  assert.equal(result.frozen, 6, "仍如实统计冻结格，不返回 0/0");
  assert.ok(
    result.warnings.some((warning) => /列映射/.test(warning)),
    `缺少映射必须告警：${result.warnings.join("；")}`
  );
  assert.equal(journalCount(store), before, "无映射不得重播种");
});

test("inherit：单格 journal 写入失败只冻结该格，计数与告警如实反映部分重播种", async (t) => {
  const workspace = await tempDir(t);
  const rootPath = path.join(workspace, "acme");
  const store = new MemoryStore();
  await makeProject(store, rootPath);

  const previous = await storeWebAsset({
    store,
    rootPath,
    kind: "excel",
    filename: "cases.xlsx",
    buffer: await workbookBuffer()
  });
  await seedJournal(store, { rootPath, assetId: previous.id });
  await saveMapping(store, { rootPath, assetId: previous.id });
  const seeded = journalCount(store);
  const reuploaded = await storeWebAsset({
    store,
    rootPath,
    kind: "excel",
    filename: "cases.xlsx",
    buffer: await workbookBuffer()
  });

  let writes = 0;
  const failing = new Proxy(store, {
    get(target, property) {
      if (property === "recordExcelWriteback") {
        return async (input) => {
          if (writes >= 2) throw new Error("journal down");
          writes += 1;
          return target.recordExcelWriteback(input);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    }
  });

  const result = await rebaseWorkbookJournal({
    store: failing,
    rootPath,
    previousAssetId: previous.id,
    newAssetId: reuploaded.id,
    workbookPath: reuploaded.storagePath,
    mode: "inherit"
  });
  assert.equal(result.rebased, 2, "已落地的 journal 行必须计入 rebased");
  assert.equal(result.frozen, 4);
  assert.equal(journalCount(store), seeded + 2);
  assert.ok(
    result.warnings.some((warning) => /重播种失败/.test(warning)),
    `单格失败必须告警：${result.warnings.join("；")}`
  );
  assert.equal(result.warnings.length, 4);
});
