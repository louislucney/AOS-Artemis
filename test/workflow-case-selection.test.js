import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  containsKeyword,
  latestFeatures,
  normalizeKeyword,
  provenanceOf,
  readCaseSummaries,
  selectByScope
} from "../dist/workflow/case-selection.js";

let dirCounter = 0;

function tempDir() {
  dirCounter += 1;
  return fs.mkdtempSync(path.join(os.tmpdir(), `aos-case-selection-${process.pid}-${dirCounter}-`));
}

function writeFlows(dir, name, flows) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, JSON.stringify({ meta: {}, flows }));
  return file;
}

function feature(overrides = {}) {
  return {
    key: "f-key",
    name: "功能",
    caseCount: 2,
    screens: [],
    jsonPath: "/p/a.json",
    mdPath: "/p/a.md",
    xlsxPath: "/p/a.xlsx",
    ...overrides
  };
}

function set(source, features, createdAt = "2026-10-18T00:00:00.000Z") {
  return {
    id: `set-${source}`,
    projectId: null,
    createdAt,
    source,
    designName: null,
    fingerprint: null,
    basename: "basename",
    features
  };
}

test("readCaseSummaries: 只收 string 型 id/name；缺文件/坏 JSON/非数组 → []", () => {
  const dir = tempDir();
  const file = writeFlows(dir, "cases.json", [
    { id: "a", name: "甲" },
    { id: 1, name: "乙" },
    { name: "丙" },
    { id: "d" },
    { id: "e", name: "戊", steps: ["x"] },
    null
  ]);
  assert.deepEqual(readCaseSummaries(file), [
    { id: "a", name: "甲" },
    { id: "e", name: "戊" }
  ]);
  assert.deepEqual(readCaseSummaries(path.join(dir, "missing.json")), []);

  const bad = path.join(dir, "bad.json");
  fs.writeFileSync(bad, "{not json");
  assert.deepEqual(readCaseSummaries(bad), []);

  const notArray = path.join(dir, "notarray.json");
  fs.writeFileSync(notArray, JSON.stringify({ flows: "nope" }));
  assert.deepEqual(readCaseSummaries(notArray), []);
});

test("normalizeKeyword / containsKeyword: NFKC＋大小写＋空白归一", () => {
  assert.equal(normalizeKeyword(" ＡｂC　d "), "abcd");
  assert.equal(containsKeyword("账户 设置", normalizeKeyword("设置")), true);
  assert.equal(containsKeyword("账户", normalizeKeyword("订单")), false);
});

test("provenanceOf: 导入自 / 生成自 两条文案", () => {
  assert.equal(provenanceOf("imported:qa.xlsx@abcd1234"), "导入自 qa.xlsx@abcd1234");
  assert.equal(provenanceOf("figma:https://example.com"), "生成自 figma:https://example.com");
});

test("latestFeatures: 列表新→旧，每 feature.key 取首个并带 provenance", () => {
  const sets = [
    set("figma:a", [feature({ key: "f-a", name: "登录", jsonPath: "/p/a.json" })]),
    set("imported:qa.xlsx@1234abcd", [
      feature({ key: "f-a", name: "登录旧", jsonPath: "/p/old.json" }),
      feature({ key: "imp-b", name: "账户", jsonPath: "/p/b.json" })
    ])
  ];
  assert.deepEqual(latestFeatures(sets), [
    { feature: "登录", jsonPath: "/p/a.json", cases: 2, provenance: "生成自 figma:a" },
    { feature: "账户", jsonPath: "/p/b.json", cases: 2, provenance: "导入自 qa.xlsx@1234abcd" }
  ]);
  assert.deepEqual(latestFeatures([]), []);
});

test("selectByScope: 功能名命中→整集透传；用例名命中→caseIds 过滤；0 命中→[]", () => {
  const dir = tempDir();
  const file = writeFlows(dir, "cases.json", [
    { id: "c1", name: "修改密码" },
    { id: "c2", name: "退出登录" }
  ]);
  const candidates = [
    { feature: "账户", jsonPath: file, cases: 2, provenance: "导入自 qa.xlsx@1234abcd" },
    { feature: "订单", jsonPath: "/p/missing.json", cases: 3, provenance: "生成自 figma:x" }
  ];
  assert.deepEqual(selectByScope(candidates, normalizeKeyword("订单")), [
    { feature: "订单", jsonPath: "/p/missing.json", cases: 3, provenance: "生成自 figma:x" }
  ]);
  assert.deepEqual(selectByScope(candidates, normalizeKeyword("密码")), [
    {
      feature: "账户",
      jsonPath: file,
      cases: 1,
      provenance: "导入自 qa.xlsx@1234abcd",
      caseIds: ["c1"]
    }
  ]);
  assert.deepEqual(selectByScope(candidates, normalizeKeyword("不存在")), []);
});
