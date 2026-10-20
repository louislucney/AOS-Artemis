import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { CASE_SETS_DIR, caseSetStem, caseSetsDir, saveCaseSetFiles } from "../dist/figma/case-sets.js";
import { makeTempDir } from "./helpers.js";

const NOW = new Date("2026-10-14T15:30:00.000Z");

test("caseSetsDir: 指向 <configDir>/design/case-sets", () => {
  assert.equal(CASE_SETS_DIR, "case-sets");
  assert.equal(caseSetsDir("/proj/.artemis"), path.join("/proj/.artemis", "design", "case-sets"));
});

test("caseSetStem: 清洗非法字符与空白、空名回退 feature、超长截断", () => {
  assert.equal(caseSetStem("登录流程", NOW, new Set()), "20261014_153000_登录流程");
  assert.equal(caseSetStem('登录 / 流程: "验证"', NOW, new Set()), "20261014_153000_登录-流程-验证");
  assert.equal(caseSetStem("   ", NOW, new Set()), "20261014_153000_feature");
  assert.equal(caseSetStem("功".repeat(60), NOW, new Set()), `20261014_153000_${"功".repeat(40)}`);
});

test("caseSetStem: 冲突加后缀 -2、-3", () => {
  const taken = new Set(["20261014_153000_登录流程"]);
  assert.equal(caseSetStem("登录流程", NOW, taken), "20261014_153000_登录流程-2");
  taken.add("20261014_153000_登录流程-2");
  assert.equal(caseSetStem("登录流程", NOW, taken), "20261014_153000_登录流程-3");
});

test("saveCaseSetFiles: 三件套同 basename 且可读、返回路径一致", async () => {
  const dir = makeTempDir("aos-case-sets-");
  const stem = "20261014_153000_登录流程";
  const saved = await saveCaseSetFiles(dir, stem, {
    json: '{"ok":true}',
    markdown: "# 用例\n",
    xlsx: Buffer.from("xlsx-bytes")
  });
  assert.equal(path.basename(saved.jsonPath), `${stem}.json`);
  assert.equal(path.basename(saved.mdPath), `${stem}.md`);
  assert.equal(path.basename(saved.xlsxPath), `${stem}.xlsx`);
  assert.equal(fs.readFileSync(saved.jsonPath, "utf-8"), '{"ok":true}');
  assert.equal(fs.readFileSync(saved.mdPath, "utf-8"), "# 用例\n");
  assert.deepEqual(fs.readFileSync(saved.xlsxPath), Buffer.from("xlsx-bytes"));
});
