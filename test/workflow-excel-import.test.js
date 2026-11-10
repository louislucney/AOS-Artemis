import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import ExcelJS from "exceljs";

import { MemoryStore } from "../dist/db/memory.js";
import { caseSetsDir } from "../dist/figma/case-sets.js";
import { preflightGeneratedTests } from "../dist/figma/preflight.js";
import { importTestDocument } from "../dist/workflow/excel-import.js";
import { baseConfig, loadTestRuntime, makeTempProject } from "./helpers.js";

async function project() {
  const dir = makeTempProject({ config: baseConfig() });
  const store = new MemoryStore();
  const { runtime } = await loadTestRuntime(dir, { store });
  return { dir, runtime, store };
}

async function writeSheet(file, rows, mutate) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Sheet1");
  for (const row of rows) sheet.addRow(row);
  if (mutate) mutate(sheet);
  await workbook.xlsx.writeFile(file);
  return file;
}

function sha8(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex").slice(0, 8);
}

test("importTestDocument: 单模块 → 三件套 + 源副本 + 登记（真实数据/断言口径）", async () => {
  const { dir, runtime, store } = await project();
  const file = await writeSheet(path.join(dir, "cases.xlsx"), [
    ["用例名", "步骤", "预期", "前置"],
    ["登录", "输入账号密码并点击登录", "进入首页", "应用已安装"]
  ]);
  const first = await importTestDocument(runtime, { excelPath: file });
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(first.status, "imported");
  assert.equal(first.sets.length, 1);
  const importAudit = await store.listAudit(runtime.project.rootDir, { domain: "import" });
  assert.ok(
    importAudit.some((event) => event.action === "excel.imported" && event.result === "ok"),
    "导入落审计"
  );
  const webAssets = await store.listWebAssets(runtime.project.rootDir, "excel");
  assert.equal(webAssets.length, 1, "导入的 Excel 同时登记为 Web 测试资产");
  assert.equal(webAssets[0].kind, "excel");
  assert.equal(webAssets[0].filename, "cases.xlsx");
  const set = first.sets[0];
  assert.equal(set.caseCount, 1);
  assert.equal(set.feature, "cases");
  assert.equal(set.featureKey, "imp-cases");
  for (const filePath of [set.jsonPath, set.mdPath, set.xlsxPath]) {
    assert.ok(fs.existsSync(filePath), filePath);
  }
  const document = JSON.parse(fs.readFileSync(set.jsonPath, "utf8"));
  assert.equal(first.sourceId, `imported:cases.xlsx@${sha8(file)}`);
  assert.equal(document.meta.source, first.sourceId);
  assert.match(document.flows[0].id, new RegExp(`^imp-${sha8(file)}-2$`));
  assert.ok(document.flows[0].taskDesc.includes("【真实数据】"));
  const markdown = fs.readFileSync(set.mdPath, "utf8");
  assert.equal(
    (markdown.match(/【真实数据】/g) ?? []).length,
    1,
    "人类可读 md 只在顶部提示一次真实数据约束"
  );
  assert.ok(!markdown.includes("数据必须经被测应用的真实请求链路准备"), "md code fence 不重复完整条款");
  assert.match(markdown, /执行请用 tests\.json 的 taskDesc/);
  assert.ok(document.flows[0].steps[0].includes("应出现「进入首页」"));
  assert.equal(document.flows[0].expectations[0].kind, "assert");

  const preflight = preflightGeneratedTests(runtime.configDirAbs, { testsPath: set.jsonPath });
  assert.equal(preflight.cases, 1);
  assert.deepEqual(preflight.weakCases, []);
  assert.deepEqual(preflight.dataPolicy.missing, []);
  assert.equal(preflight.artifacts.excelPresent, true);

  const sourceCopies = fs.readdirSync(caseSetsDir(runtime.configDirAbs)).filter((name) => name.endsWith(".source.xlsx"));
  assert.equal(sourceCopies.length, 1);
  assert.ok(first.sourceCopy.endsWith(".source.xlsx"));

  const sets = await store.listCaseSets(runtime.project.rootDir, 10);
  assert.equal(sets.length, 1);
  assert.equal(sets[0].source, first.sourceId);
  assert.match(sets[0].fingerprint, /^[0-9a-f]{64}$/);
  assert.equal(sets[0].features[0].key, set.featureKey);
  assert.equal(sets[0].features[0].caseCount, 1);

  const second = await importTestDocument(runtime, { excelPath: file });
  assert.equal(second.ok, true);
  assert.equal(second.status, "skipped");
  assert.equal(second.sets[0].jsonPath, set.jsonPath);
  assert.equal(fs.readdirSync(caseSetsDir(runtime.configDirAbs)).filter((name) => name.endsWith(".json")).length, 1);
  assert.equal((await store.listCaseSets(runtime.project.rootDir, 10)).length, 1);
});

test("importTestDocument: CSV 源文件 → 三件套 + CSV 源副本", async () => {
  const { dir, runtime, store } = await project();
  const file = path.join(dir, "cases.csv");
  fs.writeFileSync(
    file,
    '用例名,步骤,预期,模块\n登录,"输入账号,点击登录",进入首页,账户\n'
  );
  const result = await importTestDocument(runtime, { excelPath: file });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.status, "imported");
  assert.equal(result.sets.length, 1);
  assert.equal(result.sourceId, `imported:cases.csv@${sha8(file)}`);
  assert.ok(result.sourceCopy.endsWith(".source.csv"));
  assert.ok(fs.existsSync(result.sets[0].xlsxPath), "CSV 导入仍生成 xlsx 三件套");
  assert.equal(result.sets[0].caseCount, 1);
  const assets = await store.listWebAssets(runtime.project.rootDir, "excel");
  assert.equal(assets.length, 1);
  assert.equal(assets[0].filename, "cases.csv");
  assert.equal(assets[0].metadata.format, "csv");
  const second = await importTestDocument(runtime, { excelPath: file });
  assert.equal(second.status, "skipped");
});

test("importTestDocument: 按模块拆集（一个登记记录，多 features）", async () => {
  const { dir, runtime, store } = await project();
  const file = await writeSheet(path.join(dir, "multi.xlsx"), [
    ["用例名", "步骤", "预期", "模块"],
    ["登录", "点击登录", "进入首页", "账户"],
    ["下单", "提交订单", "出现订单号", "交易"],
    ["退款", "申请退款", "出现退款单", "交易"]
  ]);
  const result = await importTestDocument(runtime, { excelPath: file });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.sets.length, 2);
  assert.deepEqual(result.sets.map((set) => set.feature).sort(), ["交易", "账户"]);
  assert.deepEqual(result.sets.map((set) => set.caseCount).sort(), [1, 2]);
  assert.deepEqual(
    result.sets.map((set) => set.featureKey).sort(),
    ["imp-multi-交易", "imp-multi-账户"].sort()
  );
  const sets = await store.listCaseSets(runtime.project.rootDir, 10);
  assert.equal(sets.length, 1);
  assert.equal(sets[0].features.length, 2);
});

test("importTestDocument: columns 覆盖列名", async () => {
  const { dir, runtime } = await project();
  const file = await writeSheet(path.join(dir, "custom.xlsx"), [
    ["编号", "操作", "结果"],
    ["登录", "点击登录", "进入首页"]
  ]);
  const result = await importTestDocument(runtime, {
    excelPath: file,
    columns: { name: "编号", steps: "操作", expected: "结果" }
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  const document = JSON.parse(fs.readFileSync(result.sets[0].jsonPath, "utf8"));
  assert.equal(document.flows[0].name, "登录");
  assert.ok(document.flows[0].steps[0].includes("应出现「进入首页」"));
});

test("importTestDocument: 缺必填列 → ok:false（列出当前表头）", async () => {
  const { dir, runtime } = await project();
  const file = await writeSheet(path.join(dir, "bad.xlsx"), [
    ["编号", "说明"],
    ["登录", "点击登录"]
  ]);
  const result = await importTestDocument(runtime, { excelPath: file });
  assert.equal(result.ok, false);
  assert.ok(result.error.includes("缺少必需列"));
  assert.ok(result.error.includes("用例名"));
  assert.ok(result.error.includes("步骤"));
  assert.ok(result.error.includes("编号、说明"));
});

test("importTestDocument: 识别 Test Case / Test Step 等英文表头", async () => {
  const { dir, runtime } = await project();
  const file = await writeSheet(path.join(dir, "english.xlsx"), [
    ["TC", "Modules", "Section", "Test Case", "Precondition", "Test Data", "Test Step", "Expected Result", "Result"],
    ["TC-1", "Login", "Auth", "Login with password", "App installed", "user/pass", "Open login and submit", "Home shown", "PASS"]
  ]);
  const result = await importTestDocument(runtime, { excelPath: file });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.status, "imported");
  assert.equal(result.sets[0].caseCount, 1);
  const document = JSON.parse(fs.readFileSync(result.sets[0].jsonPath, "utf8"));
  assert.equal(document.flows[0].name, "Login with password");
  assert.match(document.flows[0].steps[0], /Open login and submit/);
});

test("importTestDocument: 无预期 → explore 步骤（弱断言豁免）", async () => {
  const { dir, runtime } = await project();
  const file = await writeSheet(path.join(dir, "explore.xlsx"), [
    ["用例名", "步骤"],
    ["随便点点", "浏览首页"]
  ]);
  const result = await importTestDocument(runtime, { excelPath: file });
  assert.equal(result.ok, true, JSON.stringify(result));
  const document = JSON.parse(fs.readFileSync(result.sets[0].jsonPath, "utf8"));
  assert.ok(document.flows[0].steps[0].startsWith("探索"));
  assert.equal(document.flows[0].expectations[0].kind, "explore");
  const preflight = preflightGeneratedTests(runtime.configDirAbs, { testsPath: result.sets[0].jsonPath });
  assert.deepEqual(preflight.weakCases, []);
});

test("importTestDocument: 同一文档内容更新 → featureKey 稳定（最新份可取代旧版）", async () => {
  const { dir, runtime, store } = await project();
  const file = path.join(dir, "cases.xlsx");
  await writeSheet(file, [
    ["用例名", "步骤", "预期"],
    ["登录", "点击登录", "进入首页"]
  ]);
  const v1 = await importTestDocument(runtime, { excelPath: file });
  assert.equal(v1.ok, true);
  await writeSheet(file, [
    ["用例名", "步骤", "预期"],
    ["登录", "点击登录", "进入首页"],
    ["下单", "提交订单", "出现订单号"]
  ]);
  const v2 = await importTestDocument(runtime, { excelPath: file });
  assert.equal(v2.ok, true);
  assert.equal(v2.status, "imported");
  assert.notEqual(v2.sourceId, v1.sourceId);
  assert.equal(v2.sets[0].featureKey, v1.sets[0].featureKey);
  const sets = await store.listCaseSets(runtime.project.rootDir, 10);
  assert.equal(sets.length, 2);
  assert.equal(sets[0].source, v2.sourceId, "最新份排在最前");
  assert.equal(sets[0].features[0].key, v1.sets[0].featureKey);
});

test("importTestDocument: 登记失败回滚本地归档，重试可重新导入（不落 skipped 假象）", async () => {
  const dir = makeTempProject({ config: baseConfig() });
  const store = new MemoryStore();
  const { runtime } = await loadTestRuntime(dir, { store });
  let failures = 1;
  const originalRecordCaseSet = runtime.store.recordCaseSet.bind(runtime.store);
  runtime.store.recordCaseSet = async (input) => {
    if (failures > 0) {
      failures -= 1;
      throw new Error("db down");
    }
    return originalRecordCaseSet(input);
  };
  const file = path.join(dir, "cases.xlsx");
  await writeSheet(file, [
    ["用例名", "步骤", "预期"],
    ["登录", "点击登录", "进入首页"]
  ]);
  const failed = await importTestDocument(runtime, { excelPath: file });
  assert.equal(failed.ok, false);
  assert.ok(failed.error.includes("登记失败"), failed.error);
  const setsDir = caseSetsDir(runtime.configDirAbs);
  const leftovers = fs.existsSync(setsDir)
    ? fs.readdirSync(setsDir).filter((name) => /\.(json|md|xlsx)$/.test(name))
    : [];
  assert.deepEqual(leftovers, [], `leftovers: ${leftovers.join(",")}`);

  const retry = await importTestDocument(runtime, { excelPath: file });
  assert.equal(retry.ok, true);
  assert.equal(retry.status, "imported");
  assert.equal((await store.listCaseSets(runtime.project.rootDir, 10)).length, 1);
});

test("importTestDocument: 扩展别名不改变旧导入器的 first-match 优先级", async () => {
  const { dir, runtime } = await project();
  const file = await writeSheet(path.join(dir, "precedence.xlsx"), [
    ["用例ID", "用例编号", "用例名", "测试过程", "步骤", "预期"],
    ["EXT-1", "C-1", "登录", "错误过程", "点击登录", "进入首页"]
  ]);
  const result = await importTestDocument(runtime, { excelPath: file });
  assert.equal(result.ok, true, JSON.stringify(result));
  const document = JSON.parse(fs.readFileSync(result.sets[0].jsonPath, "utf8"));
  const flow = document.flows[0];
  assert.equal(flow.displayId, "C-1", "displayId 仍绑定旧别名列「用例编号」，不被前置「用例ID」抢走");
  assert.ok(flow.taskDesc.includes("点击登录"), flow.taskDesc);
  assert.ok(!flow.taskDesc.includes("错误过程"), flow.taskDesc);
  assert.ok(flow.steps[0].includes("点击登录"), JSON.stringify(flow.steps));
});

test("importTestDocument: displayId/testData 旧别名锁定（展示编号/测试数据）", async () => {
  const { dir, runtime } = await project();
  const file = await writeSheet(path.join(dir, "legacy-aliases.xlsx"), [
    ["用例名", "步骤", "展示编号", "测试数据"],
    ["登录", "点击登录", "D-9", "账号: demo\n密码: 123456"]
  ]);
  const result = await importTestDocument(runtime, { excelPath: file });
  assert.equal(result.ok, true, JSON.stringify(result));
  const document = JSON.parse(fs.readFileSync(result.sets[0].jsonPath, "utf8"));
  const flow = document.flows[0];
  assert.equal(flow.displayId, "D-9");
  assert.deepEqual(flow.testData, ["账号: demo", "密码: 123456"]);
  assert.ok(flow.taskDesc.includes("【测试数据】"), flow.taskDesc);
  assert.ok(flow.taskDesc.includes("账号: demo"), flow.taskDesc);
});

const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z0ZkAAAAASUVORK5CYII=";

test("importTestDocument: Excel 内嵌图片 → design.excelImages + 显式提醒", async () => {
  const { dir, runtime } = await project();
  const file = path.join(dir, "with-image.xlsx");
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Sheet1");
  sheet.addRow(["用例名", "步骤", "预期"]);
  sheet.addRow(["登录", "输入账号密码", "进入首页"]);
  const imageId = workbook.addImage({ base64: TINY_PNG_BASE64, extension: "png" });
  sheet.addImage(imageId, "F2:G5");
  await workbook.xlsx.writeFile(file);

  const result = await importTestDocument(runtime, { excelPath: file });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.ok(result.design, "返回设计上下文摘要");
  assert.equal(result.design.excelImages, 1);
  assert.ok(
    result.design.warnings.some((warning) => warning.includes("内嵌图片")),
    JSON.stringify(result.design.warnings)
  );
  assert.ok(
    result.warnings.some((warning) => warning.includes("内嵌图片")),
    JSON.stringify(result.warnings)
  );
});

test("importTestDocument: Section 分组 + Wireframe 设计引用 + Related TC（真实模板列）", async () => {
  const { dir, runtime } = await project();
  const file = await writeSheet(path.join(dir, "navigation-menu.xlsx"), [
    [
      "TC",
      "Modules",
      "Section",
      "Test Case",
      "Precondition",
      "Test Data",
      "Related TC",
      "Test Step",
      "Expected Result",
      "Wireframe"
    ],
    [
      "TC_01",
      "Login / Register",
      "Login",
      "Login success",
      "",
      "",
      "TC_00",
      "1.Click login",
      "1.Go to Homepage",
      "0.1_Login/Register\n1.0_Homepage"
    ],
    [
      "TC_02",
      "Login / Register",
      "Register (Smiles card)",
      "Register with Smiles card",
      "",
      "",
      "TC_01",
      "1.Open register",
      "1.See register form",
      "0.1_Login/Register\n0.3.2_Register_Card Info (Smile Classic)"
    ],
    [
      "TC_03",
      "Login / Register",
      "Register (MOGI)",
      "Register with MOGI",
      "",
      "",
      "",
      "1.Open register",
      "1.See MOGI form",
      "0.0.4_Landing Page\n0.1_Register (Smiles MOGI Virtual Card)"
    ],
    [
      "TC_04",
      "Login / Register",
      "Register (Student/Military)",
      "Student register",
      "",
      "",
      "",
      "1.Open register",
      "1.See student form",
      "0.3.2_Register_Mobile (Student/ Military)0.2.1_OTP - Case 1"
    ]
  ]);

  const result = await importTestDocument(runtime, { excelPath: file });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(
    result.sets.map((set) => set.feature).sort(),
    ["Login", "Register (MOGI)", "Register (Smiles card)", "Register (Student/Military)"].sort()
  );

  const smiles = result.sets.find((set) => set.feature === "Register (Smiles card)");
  assert.ok(smiles);
  const document = JSON.parse(fs.readFileSync(smiles.jsonPath, "utf8"));
  const flow = document.flows[0];
  assert.equal(flow.module, "Login / Register");
  assert.equal(flow.section, "Register (Smiles card)");
  assert.deepEqual(flow.screens, [
    "0.1_Login/Register",
    "0.3.2_Register_Card Info (Smile Classic)"
  ]);
  assert.deepEqual(flow.designRefs, {
    screens: ["0.1_Login/Register", "0.3.2_Register_Card Info (Smile Classic)"],
    nodeIds: []
  });
  assert.deepEqual(flow.relatedCases, ["TC_01"]);
  assert.ok(flow.taskDesc.includes("设计引用：0.1_Login/Register、0.3.2_Register_Card Info (Smile Classic)"));
  assert.deepEqual(result.design.columns, {
    section: "Section",
    wireframe: "Wireframe",
    relatedTc: "Related TC"
  });

  const student = result.sets.find((set) => set.feature === "Register (Student/Military)");
  assert.ok(student);
  const studentDocument = JSON.parse(fs.readFileSync(student.jsonPath, "utf8"));
  assert.deepEqual(studentDocument.flows[0].screens, [
    "0.3.2_Register_Mobile (Student/ Military)",
    "0.2.1_OTP - Case 1"
  ]);
});

test("importTestDocument: Wireframe 是 URL/图片、Related TC 是 Jira 单号 → 不误用并提醒", async () => {
  const { dir, runtime } = await project();
  const file = await writeSheet(path.join(dir, "mismatched-template.xlsx"), [
    ["TC", "Modules", "Section", "Test Case", "Test Step", "Expected Result", "Wireframe", "Related TC"],
    [
      "TC_01",
      "Login",
      "Login",
      "Login",
      "1.Click login",
      "1.Home",
      "https://www.figma.com/design/abc",
      "AOS-123"
    ],
    [
      "TC_02",
      "Login",
      "Login",
      "Login again",
      "1.Click login",
      "1.Home",
      "images/login-screen.png",
      "TC_01"
    ]
  ]);

  const result = await importTestDocument(runtime, { excelPath: file });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.design.columns, {
    section: "Section",
    wireframe: "Wireframe",
    relatedTc: "Related TC"
  });
  assert.equal(result.design.designRefs, 0);
  assert.ok(
    result.warnings.some((warning) => warning.includes("URL/文件路径")),
    JSON.stringify(result.warnings)
  );
  assert.ok(
    result.warnings.some((warning) => warning.includes("Jira 单号")),
    JSON.stringify(result.warnings)
  );

  const login = result.sets.find((set) => set.feature === "Login");
  assert.ok(login);
  const document = JSON.parse(fs.readFileSync(login.jsonPath, "utf8"));
  const second = document.flows.find((flow) => flow.displayId === "TC_02");
  assert.deepEqual(second.relatedCases, ["TC_01"]);
  assert.equal(second.designRefs, undefined, "URL/图片不得写入 designRefs");
  const first = document.flows.find((flow) => flow.displayId === "TC_01");
  assert.equal(first.relatedCases, undefined, "Jira 单号不得写入 relatedCases");
});

test("importTestDocument: 检测到设计基线但无设计引用 → 提醒并给出 ui-diff 下一步", async () => {
  const { dir, runtime } = await project();
  const design = path.join(runtime.configDirAbs, "design");
  fs.mkdirSync(design, { recursive: true });
  fs.writeFileSync(
    path.join(design, "flows.json"),
    JSON.stringify({ screens: [{ id: "s1", name: "登录" }], edges: [] }, null, 2)
  );
  fs.writeFileSync(
    path.join(design, "ui-contract.json"),
    JSON.stringify({ screens: [{ id: "s1", name: "登录" }] }, null, 2)
  );
  const file = await writeSheet(path.join(dir, "design-context.xlsx"), [
    ["用例名", "步骤", "预期"],
    ["登录", "输入账号密码", "进入首页"]
  ]);

  const result = await importTestDocument(runtime, { excelPath: file });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.ok(result.design, "返回设计上下文摘要");
  assert.equal(result.design.available, true);
  assert.ok(result.design.sources.includes("flows.json"));
  assert.ok(result.design.sources.includes("ui-contract.json"));
  assert.ok(
    result.design.warnings.some((warning) => warning.includes("设计引用")),
    JSON.stringify(result.design.warnings)
  );
  assert.match(result.design.nextAction ?? "", /--ui-diff/);
});
