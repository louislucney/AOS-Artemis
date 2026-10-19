import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { adfToText } from "../dist/jira/adf.js";
import { buildVerifyComment } from "../dist/jira/verify-comment.js";
import { MemoryStore } from "../dist/db/memory.js";
import { seedCaseSets } from "./helpers.js";
import { verifyJiraIssue } from "../dist/workflow/verify-jira.js";

const LLM_ENTRY = {
  name: "deepseek",
  model: "deepseek-chat",
  baseUrl: "https://api.deepseek.com/v1",
  apiKey: "sk-test-key"
};

let dirCounter = 0;

function tempDir() {
  dirCounter += 1;
  return fs.mkdtempSync(path.join(os.tmpdir(), `aos-verify-jira-${process.pid}-${dirCounter}-`));
}

function text(value) {
  return { type: "text", text: value };
}

function paragraph(value) {
  return { type: "paragraph", content: [text(value)] };
}

function listItem(value) {
  return { type: "listItem", content: [paragraph(value)] };
}

function bulletList(values) {
  return { type: "bulletList", content: values.map((value) => listItem(value)) };
}

function doc(nodes) {
  return { type: "doc", version: 1, content: nodes };
}

function detailedDescription() {
  return doc([bulletList(["打开首页", "点击登录，预期：进入主页"])]);
}

function rawIssue({ key = "AOS-1", summary = "登录失败", description = detailedDescription() } = {}) {
  return {
    key,
    id: "10001",
    fields: {
      summary,
      status: { name: "To Do", statusCategory: { name: "To Do" } },
      issuetype: { name: "Bug" },
      labels: [],
      project: { key: "AOS", name: "AOS" },
      description
    }
  };
}

function stubRuntime(dir, { jiraConfigured = true } = {}) {
  return {
    configDirAbs: dir,
    store: new MemoryStore(),
    project: { rootDir: dir, dotenvValues: {} },
    async activeEntry() {
      return LLM_ENTRY;
    },
    jiraConfig: () =>
      jiraConfigured
        ? {
            configured: true,
            missing: [],
            siteUrl: "https://x.atlassian.net",
            email: "a@b.c",
            apiToken: "t"
          }
        : { configured: false, missing: ["JIRA_BASE_URL"], siteUrl: null, email: null, apiToken: null }
  };
}

function jiraClientStub({ issue = rawIssue(), comments = [] } = {}) {
  const calls = { getIssue: [], getComments: 0, createComment: [], updateComment: [], property: [] };
  return {
    calls,
    client: {
      async getIssue(key, fields) {
        calls.getIssue.push({ key, fields });
        return issue;
      },
      async getComments() {
        calls.getComments += 1;
        return comments;
      },
      async createComment(key, body) {
        calls.createComment.push({ key, body });
        return "200";
      },
      async updateComment(key, id, body) {
        calls.updateComment.push({ key, id, body });
      },
      async setCommentProperty(key, id, prop, value) {
        calls.property.push({ key, id, prop, value });
        return true;
      }
    }
  };
}

function featureRecord(jsonPath, overrides = {}) {
  return {
    key: "f-a",
    name: "账户",
    caseCount: 2,
    screens: ["账户"],
    jsonPath,
    mdPath: jsonPath.replace(/\.json$/, ".md"),
    xlsxPath: jsonPath.replace(/\.json$/, ".xlsx"),
    ...overrides
  };
}

function record(source, features) {
  return {
    id: `set-${source}`,
    projectId: null,
    createdAt: "2026-10-18T00:00:00.000Z",
    source,
    designName: null,
    fingerprint: null,
    basename: "basename",
    features
  };
}

function writeCasesFile(dir, name, flows) {
  const file = path.join(dir, "fixtures", name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ meta: {}, flows }));
  return file;
}

function caseStub(caseId, overrides = {}) {
  return {
    caseId,
    name: `用例${caseId}`,
    status: "passed",
    traceId: `trace-${caseId}`,
    quarantined: false,
    scriptProvenance: { asserts: 1, explores: 0 },
    ...overrides
  };
}

function reportStub(overrides = {}) {
  return {
    ok: true,
    testsPath: "/p/a.json",
    total: 1,
    executed: 1,
    passed: 1,
    failed: 0,
    preflight: { weakCases: [] },
    cases: [caseStub("c1")],
    error: null,
    ...overrides
  };
}

function batchStub(report, { manifestPath = "/p/runs/1.json", runId = "run-1" } = {}) {
  return {
    report,
    startedAtMs: 0,
    coverageIssue: null,
    exitCode: 0,
    quarantinedCaseIds: undefined,
    quarantineMessages: [],
    manifestPath,
    runId,
    comparison: null
  };
}

function makeDeps(dir, options = {}) {
  const jira = jiraClientStub(options.jira ?? {});
  const calls = { mappingChat: 0, chatMessages: [], devices: 0, execute: [], evidence: [], associate: [], logs: [] };
  const deps = {
    setup: { chat: async () => "pong" },
    chat: async (messages) => {
      calls.mappingChat += 1;
      calls.chatMessages.push(messages);
      return options.mappingReply ?? '{"caseIds":[]}';
    },
    listDevices: async () => {
      calls.devices += 1;
      return options.devices ?? [{ serial: "dev-1" }];
    },
    listSets: async () => options.sets ?? [],
    executeBatch: async (runtime, request) => {
      calls.execute.push(request);
      return batchStub(options.report ?? reportStub(), options.batch ?? {});
    },
    resolveJira: () => ({ client: jira.client, siteUrl: "https://x.atlassian.net" }),
    postEvidence: async (runtime, args) => {
      calls.evidence.push(args);
      return { ok: true, commentId: "900" };
    },
    associateCase: async (runtime, input) => {
      calls.associate.push(input);
    },
    log: (line) => {
      calls.logs.push(line);
    },
    now: () => new Date("2026-10-18T00:00:00.000Z")
  };
  return { deps, calls, jira };
}

function payloadOf(result) {
  return JSON.parse(result.content[0].text);
}

test("verify_jira_issue: 详细单映射命中 → 执行（caseIds 透传）＋回写 sent", async () => {
  const dir = tempDir();
  const casesFile = writeCasesFile(dir, "账户.json", [
    { id: "c1", name: "错误密码" },
    { id: "c2", name: "退出登录" }
  ]);
  const { deps, calls, jira } = makeDeps(dir, {
    sets: [record("figma:x", [featureRecord(casesFile)])],
    mappingReply: '{"caseIds":["c1"]}',
    report: reportStub({ cases: [caseStub("c1")] })
  });
  const runtime = stubRuntime(dir);
  const payload = payloadOf(await verifyJiraIssue(runtime, { issueKey: "AOS-1" }, deps));

  assert.equal(payload.ok, true);
  assert.deepEqual(payload.ticket, { key: "AOS-1", detailTier: "detailed", summary: "登录失败" });
  assert.deepEqual(payload.mapping, { selected: 1 });
  assert.equal(payload.run.conclusion, "passed");
  assert.equal(payload.run.gate, "passed");
  assert.deepEqual(payload.run.composition, { strong: 1, weak: 0, explore: 0 });

  const user = calls.chatMessages[0][1].content;
  assert.equal(user.includes("- 账户（生成自 figma:x）"), true);
  assert.equal(user.includes("  - c1 错误密码"), true);

  assert.equal(calls.execute.length, 1);
  const request = calls.execute[0];
  assert.equal(request.source, "verify_jira_issue");
  assert.equal(request.trigger, "verify_jira_issue");
  assert.equal(request.options.testsPath, casesFile);
  assert.deepEqual(request.options.caseIds, ["c1"]);
  assert.deepEqual(request.registration, { platform: "android" });

  assert.equal(payload.writeback.outcome, "sent");
  assert.equal(payload.writeback.action, "created");
  const audit = await runtime.store.listAudit(dir, { domain: "verify" });
  assert.ok(
    audit.some((event) => event.action === "writeback" && event.refs.issueKey === "AOS-1"),
    "verify 回写落审计"
  );
  assert.equal(jira.calls.createComment.length, 1);
  const commentText = adfToText(jira.calls.createComment[0].body);
  assert.equal(commentText.includes("【AOS 自动验证】AOS-1 登录失败"), true);
  assert.equal(commentText.includes("映射用例: c1"), true);
  assert.deepEqual(jira.calls.property, [
    { key: "AOS-1", id: "200", prop: "aos-verify", value: { issueKey: "AOS-1" } }
  ]);
  assert.deepEqual(calls.associate, [{ runId: "run-1", caseId: "c1", jiraKey: "AOS-1" }]);

  const select = payload.steps.find((entry) => entry.step === "select");
  assert.equal(select.mode, "mapped");
  assert.deepEqual(select.targets, [{ feature: "账户", cases: 1, provenance: "生成自 figma:x" }]);
  const runStep = payload.steps.find((entry) => entry.step === "run");
  assert.equal(typeof runStep.ms, "number");
  assert.ok(runStep.ms >= 0);
});

test("verify_jira_issue: 映射答没有 → 单子即用例（mapping.selected:0，落盘 design/jira）", async () => {
  const dir = tempDir();
  const casesFile = writeCasesFile(dir, "账户.json", [{ id: "c1", name: "错误密码" }]);
  const { deps, calls, jira } = makeDeps(dir, {
    sets: [record("figma:x", [featureRecord(casesFile, { caseCount: 1 })])],
    mappingReply: '{"caseIds":[]}',
    report: reportStub({ cases: [caseStub("jira-AOS-1-1")] })
  });
  const payload = payloadOf(await verifyJiraIssue(stubRuntime(dir), { issueKey: "AOS-1" }, deps));

  assert.deepEqual(payload.mapping, { selected: 0 });
  const testsFile = path.join(dir, "design", "jira", "AOS-1.tests.json");
  assert.equal(fs.existsSync(testsFile), true);
  assert.equal(payload.artifacts.testsFile, testsFile);
  assert.equal(calls.execute[0].options.testsPath, testsFile);
  assert.equal(payload.steps.some((entry) => entry.step === "synthesize"), true);
  const commentText = adfToText(jira.calls.createComment[0].body);
  assert.equal(commentText.includes("- 来源: 单子即用例"), true);
});

test("verify_jira_issue: 库空 → 直接合成（未调用映射 chat、无 mapping 字段）", async () => {
  const dir = tempDir();
  const { deps, calls } = makeDeps(dir, {
    sets: [],
    report: reportStub({ cases: [caseStub("jira-AOS-1-1")] })
  });
  const payload = payloadOf(await verifyJiraIssue(stubRuntime(dir), { issueKey: "AOS-1" }, deps));

  assert.equal(payload.ok, true);
  assert.equal(calls.mappingChat, 0);
  assert.equal("mapping" in payload, false);
  assert.equal(calls.execute[0].options.testsPath, path.join(dir, "design", "jira", "AOS-1.tests.json"));
});

test("verify_jira_issue: 粗单 → needs-info（未盘点设备/未映射/未写盘）", async () => {
  const dir = tempDir();
  const { deps, calls } = makeDeps(dir, {
    jira: { issue: rawIssue({ description: paragraph("首页加载慢") }) }
  });
  const payload = payloadOf(await verifyJiraIssue(stubRuntime(dir), { issueKey: "AOS-1" }, deps));

  assert.equal(payload.ok, false);
  assert.equal(payload.needs, "info");
  assert.equal(payload.category, "ticket-coarse");
  assert.deepEqual(payload.questions, [
    "这是哪个功能/页面？",
    "触发条件是什么（做了什么操作）？",
    "期望结果是什么？"
  ]);
  assert.equal(payload.context[0], "工单 AOS-1：登录失败");
  assert.equal(calls.devices, 0);
  assert.equal(calls.mappingChat, 0);
  assert.deepEqual(calls.execute, []);
  assert.equal(fs.existsSync(path.join(dir, "design")), false);
});

test("verify_jira_issue: Jira 未配置 → needs-setup（未请求 issue）", async () => {
  const dir = tempDir();
  const { deps, calls, jira } = makeDeps(dir, {});
  const payload = payloadOf(
    await verifyJiraIssue(stubRuntime(dir, { jiraConfigured: false }), { issueKey: "AOS-1" }, deps)
  );

  assert.equal(payload.ok, false);
  assert.equal(payload.needs, "setup");
  assert.equal(payload.checks[0].target, "jira");
  assert.equal(jira.calls.getIssue.length, 0);
  assert.equal(calls.execute.length, 0);
});

test("verify_jira_issue: 无设备 → needs-setup（未发起映射 chat）", async () => {
  const dir = tempDir();
  const casesFile = writeCasesFile(dir, "账户.json", [{ id: "c1", name: "错误密码" }]);
  const { deps, calls } = makeDeps(dir, {
    sets: [record("figma:x", [featureRecord(casesFile, { caseCount: 1 })])],
    devices: []
  });
  const payload = payloadOf(await verifyJiraIssue(stubRuntime(dir), { issueKey: "AOS-1" }, deps));

  assert.equal(payload.needs, "setup");
  assert.equal(payload.checks[0].target, "device");
  assert.equal(calls.mappingChat, 0);
  assert.equal(calls.execute.length, 0);
});

test("verify_jira_issue: 多设备未指定 → needs-info", async () => {
  const dir = tempDir();
  const { deps, calls } = makeDeps(dir, {
    devices: [{ serial: "dev-1" }, { serial: "dev-2" }]
  });
  const payload = payloadOf(await verifyJiraIssue(stubRuntime(dir), { issueKey: "AOS-1" }, deps));

  assert.equal(payload.needs, "info");
  assert.equal(payload.category, "device-ambiguous");
  assert.equal(payload.questions.length, 1);
  assert.equal(calls.execute.length, 0);
});

test("verify_jira_issue: scope 覆盖映射（不调映射 chat）与 0 命中 needs-info", async () => {
  const dir = tempDir();
  const casesFile = writeCasesFile(dir, "账户.json", [
    { id: "c1", name: "错误密码" },
    { id: "c2", name: "退出登录" }
  ]);
  const sets = [record("figma:x", [featureRecord(casesFile)])];
  const okDeps = makeDeps(dir, { sets, report: reportStub({ cases: [caseStub("c1")] }) });
  const payload = payloadOf(await verifyJiraIssue(stubRuntime(dir), { issueKey: "AOS-1", scope: "密码" }, okDeps.deps));

  assert.equal(payload.ok, true);
  assert.equal(okDeps.calls.mappingChat, 0);
  assert.deepEqual(okDeps.calls.execute[0].options.caseIds, ["c1"]);
  assert.deepEqual(payload.scope, { keyword: "密码", hits: 1 });

  const missDeps = makeDeps(dir, { sets });
  const miss = payloadOf(await verifyJiraIssue(stubRuntime(dir), { issueKey: "AOS-1", scope: "不存在" }, missDeps.deps));
  assert.equal(miss.ok, false);
  assert.equal(miss.needs, "info");
  assert.equal(miss.category, "scope-no-hit");
  assert.equal(missDeps.calls.execute.length, 0);
});

test("verify_jira_issue: 强断言失败 → FAIL＋失败证据回写＋评论 FAIL", async () => {
  const dir = tempDir();
  const casesFile = writeCasesFile(dir, "账户.json", [{ id: "c1", name: "错误密码" }]);
  const { deps, calls, jira } = makeDeps(dir, {
    sets: [record("figma:x", [featureRecord(casesFile, { caseCount: 1 })])],
    mappingReply: '{"caseIds":["c1"]}',
    report: reportStub({
      total: 1,
      executed: 1,
      passed: 0,
      failed: 1,
      cases: [caseStub("c1", { status: "failed", traceId: "t1" })]
    })
  });
  const payload = payloadOf(await verifyJiraIssue(stubRuntime(dir), { issueKey: "AOS-1" }, deps));

  assert.equal(payload.run.conclusion, "failed");
  assert.equal(payload.run.gate, "failed");
  assert.deepEqual(calls.evidence, [{ key: "AOS-1", traceId: "t1", deviceSerial: "dev-1" }]);
  assert.deepEqual(payload.writeback.evidence, [{ traceId: "t1", ok: true, commentId: "900" }]);
  const commentText = adfToText(jira.calls.createComment[0].body);
  assert.equal(commentText.includes("- 结论: FAIL（强断言失败 1 条）"), true);
  assert.equal(commentText.includes("- 失败: 用例c1（trace t1，强）"), true);
});

test("verify_jira_issue: 全弱/全探索 → inconclusive 且不报 PASS", async () => {
  const dir = tempDir();
  const casesFile = writeCasesFile(dir, "账户.json", [{ id: "c1", name: "探索用例" }]);
  const exploreDeps = makeDeps(dir, {
    sets: [record("figma:x", [featureRecord(casesFile, { caseCount: 1 })])],
    mappingReply: '{"caseIds":["c1"]}',
    report: reportStub({ cases: [caseStub("c1", { scriptProvenance: { asserts: 0, explores: 1 } })] })
  });
  const payload = payloadOf(await verifyJiraIssue(stubRuntime(dir), { issueKey: "AOS-1" }, exploreDeps.deps));
  assert.equal(payload.run.conclusion, "inconclusive");
  assert.equal(payload.run.gate, "inconclusive");
  const commentText = adfToText(exploreDeps.jira.calls.createComment[0].body);
  assert.equal(commentText.includes("无法判定（无强断言；弱断言仅记录路径，不代表验证通过）"), true);
  assert.equal(commentText.split("不代表验证通过").length - 1, 1);
  assert.equal(commentText.includes("- 构成: 强 0 · 弱 0 · 探索 1（共 1 条）"), true);

  const weakDeps = makeDeps(dir, {
    sets: [record("figma:x", [featureRecord(casesFile, { caseCount: 1 })])],
    mappingReply: '{"caseIds":["c1"]}',
    report: reportStub({ preflight: { weakCases: [{ id: "c1", name: "x", weakSteps: [] }] } })
  });
  const weakPayload = payloadOf(await verifyJiraIssue(stubRuntime(dir), { issueKey: "AOS-1" }, weakDeps.deps));
  assert.equal(weakPayload.run.conclusion, "inconclusive");
  assert.deepEqual(weakPayload.run.composition, { strong: 0, weak: 1, explore: 0 });

  const mixedFile = writeCasesFile(dir, "订单.json", [
    { id: "m1", name: "正确密码" },
    { id: "m2", name: "探索下单" }
  ]);
  const mixedDeps = makeDeps(dir, {
    sets: [record("figma:y", [featureRecord(mixedFile, { key: "f-b", name: "订单", caseCount: 2 })])],
    mappingReply: '{"caseIds":["m1","m2"]}',
    report: reportStub({
      total: 2,
      executed: 2,
      passed: 1,
      failed: 1,
      cases: [caseStub("m1"), caseStub("m2", { status: "failed", scriptProvenance: { asserts: 0, explores: 1 } })]
    })
  });
  const mixedPayload = payloadOf(await verifyJiraIssue(stubRuntime(dir), { issueKey: "AOS-1" }, mixedDeps.deps));
  assert.equal(mixedPayload.run.conclusion, "inconclusive");
  const mixedComment = adfToText(mixedDeps.jira.calls.createComment[0].body);
  assert.equal(mixedComment.includes("弱断言失败 1 条；弱断言仅记录路径，不代表验证通过"), true);
  assert.equal(mixedComment.includes("无强断言"), false);
});

test("verify_jira_issue: dryRun → 零写回调用＋结论预览", async () => {
  const dir = tempDir();
  const casesFile = writeCasesFile(dir, "账户.json", [{ id: "c1", name: "错误密码" }]);
  const { deps, calls, jira } = makeDeps(dir, {
    sets: [record("figma:x", [featureRecord(casesFile, { caseCount: 1 })])],
    mappingReply: '{"caseIds":["c1"]}',
    report: reportStub({
      total: 1,
      executed: 1,
      passed: 0,
      failed: 1,
      cases: [caseStub("c1", { status: "failed", traceId: "t1" })]
    })
  });
  const payload = payloadOf(await verifyJiraIssue(stubRuntime(dir), { issueKey: "AOS-1", dryRun: true }, deps));

  assert.equal(calls.execute.length, 1);
  assert.equal(payload.writeback.outcome, "dryRun");
  assert.deepEqual(payload.writeback.evidencePlanned, ["t1"]);
  assert.equal(payload.writeback.conclusionText.includes("【AOS 自动验证】AOS-1 登录失败"), true);
  assert.equal(jira.calls.createComment.length, 0);
  assert.equal(jira.calls.updateComment.length, 0);
  assert.equal(jira.calls.property.length, 0);
  assert.equal(calls.evidence.length, 0);
  assert.equal(calls.associate.length, 0);
});

test("verify_jira_issue: 复验读上次映射作上下文；同 marker 更新评论；quarantine 不计门禁", async () => {
  const dir = tempDir();
  const casesFile = writeCasesFile(dir, "账户.json", [
    { id: "c1", name: "错误密码" },
    { id: "c2", name: "退出登录" }
  ]);
  const draft = buildVerifyComment({
    issue: { key: "AOS-1", summary: "登录失败" },
    conclusion: "passed",
    composition: { strong: 1, weak: 0, explore: 0 },
    source: "用例库映射",
    device: "dev-1",
    manifestPaths: [],
    failed: [],
    mapping: { caseIds: ["c2"] }
  });
  const previousComment = {
    id: "77",
    body: {
      ...draft.adf,
      content: [
        ...(draft.adf.content ?? []),
        { type: "paragraph", content: [{ type: "text", text: "AOS-VERIFY:AOS-1" }] }
      ]
    }
  };
  const { deps, calls, jira } = makeDeps(dir, {
    jira: { comments: [previousComment] },
    sets: [record("figma:x", [featureRecord(casesFile)])],
    mappingReply: '{"caseIds":["c2"]}',
    report: reportStub({
      total: 2,
      executed: 2,
      passed: 1,
      failed: 1,
      cases: [caseStub("c1", { status: "failed", quarantined: true }), caseStub("c2")]
    })
  });
  const payload = payloadOf(await verifyJiraIssue(stubRuntime(dir), { issueKey: "AOS-1" }, deps));

  const user = calls.chatMessages[0][1].content;
  assert.equal(user.includes("上次验证选择的用例（仅供参考）：c2"), true);
  assert.equal(jira.calls.updateComment.length, 1);
  assert.equal(jira.calls.updateComment[0].id, "77");
  assert.equal(jira.calls.createComment.length, 0);
  assert.equal(payload.writeback.action, "updated");
  assert.equal(payload.run.conclusion, "passed", "quarantine 失败不计门禁");
});

test("verify_jira_issue: 批次未执行 → failedStep:run；映射异常 → failedStep:mapping", async () => {
  const dir = tempDir();
  const casesFile = writeCasesFile(dir, "账户.json", [{ id: "c1", name: "错误密码" }]);
  const sets = [record("figma:x", [featureRecord(casesFile, { caseCount: 1 })])];

  const runDeps = makeDeps(dir, {
    sets,
    mappingReply: '{"caseIds":["c1"]}',
    report: reportStub({ ok: false, error: "无可提交用例", cases: [], total: 0, executed: 0, passed: 0, failed: 0 })
  });
  const runPayload = payloadOf(await verifyJiraIssue(stubRuntime(dir), { issueKey: "AOS-1" }, runDeps.deps));
  assert.equal(runPayload.ok, false);
  assert.equal(runPayload.failedStep, "run");
  assert.equal(runPayload.detail, "无可提交用例");

  const mappingDeps = makeDeps(dir, { sets });
  mappingDeps.deps.chat = async () => {
    throw new Error("llm down");
  };
  const mappingPayload = payloadOf(await verifyJiraIssue(stubRuntime(dir), { issueKey: "AOS-1" }, mappingDeps.deps));
  assert.equal(mappingPayload.ok, false);
  assert.equal(mappingPayload.failedStep, "mapping");
  assert.equal(mappingPayload.detail.includes("llm down"), true);
});

test("verify_jira_issue: 非法 issueKey → isError 用法错误（未请求 issue）", async () => {
  const dir = tempDir();
  const { deps, jira } = makeDeps(dir, {});
  const result = await verifyJiraIssue(stubRuntime(dir), { issueKey: "???" }, deps);
  assert.equal(result.isError, true);
  const payload = payloadOf(result);
  assert.match(payload.error, /无法解析 issue key/);
  assert.equal(jira.calls.getIssue.length, 0);
});

test("verify_jira_issue: run 步 ms 在执行完成时回填（不含回写耗时）", async () => {
  const dir = tempDir();
  const casesFile = writeCasesFile(dir, "账户.json", [{ id: "c1", name: "错误密码" }]);
  const { deps } = makeDeps(dir, {
    sets: [record("figma:x", [featureRecord(casesFile, { caseCount: 1 })])],
    mappingReply: '{"caseIds":["c1"]}',
    report: reportStub({
      total: 1,
      executed: 1,
      passed: 0,
      failed: 1,
      cases: [caseStub("c1", { status: "failed", traceId: "t1" })]
    })
  });
  deps.postEvidence = async () => {
    await new Promise((resolve) => setTimeout(resolve, 80));
    return { ok: true, commentId: "900" };
  };
  const payload = payloadOf(await verifyJiraIssue(stubRuntime(dir), { issueKey: "AOS-1" }, deps));
  const runStep = payload.steps.find((entry) => entry.step === "run");
  assert.equal(typeof runStep.ms, "number");
  assert.ok(runStep.ms < 40, `run.ms 不应包含回写耗时（实际 ${runStep.ms}ms）`);
});

test("verify_jira_issue: 候选用例文件不可读 → 跳过＋日志（不阻断）", async () => {
  const dir = tempDir();
  const goodFile = writeCasesFile(dir, "账户.json", [{ id: "c1", name: "错误密码" }]);
  const { deps, calls } = makeDeps(dir, {
    sets: [
      record("figma:y", [
        featureRecord(path.join(dir, "fixtures", "missing.json"), {
          key: "f-x",
          name: "缺件",
          caseCount: 1
        }),
        featureRecord(goodFile, { key: "f-a", name: "账户", caseCount: 1 })
      ])
    ],
    mappingReply: '{"caseIds":["c1"]}',
    report: reportStub({ cases: [caseStub("c1")] })
  });
  const payload = payloadOf(await verifyJiraIssue(stubRuntime(dir), { issueKey: "AOS-1" }, deps));
  assert.equal(payload.ok, true);
  assert.equal(calls.logs.some((line) => line.includes("候选用例文件不可读")), true);
  assert.equal(calls.execute.length, 1);
  assert.equal(calls.execute[0].options.testsPath, goodFile);
});

test("verify_jira_issue: dryRun 预览带 evidenceTruncated（与发送路径同式）", async () => {
  const dir = tempDir();
  const flows = Array.from({ length: 11 }, (_, index) => ({
    id: `c${index}`,
    name: `密码用例${index}`
  }));
  const casesFile = writeCasesFile(dir, "账户.json", flows);
  const failedCases = flows.map((entry, index) =>
    caseStub(entry.id, { status: "failed", traceId: `t${index}` })
  );
  const { deps, calls } = makeDeps(dir, {
    sets: [record("figma:x", [featureRecord(casesFile, { caseCount: 11 })])],
    report: reportStub({ total: 11, executed: 11, passed: 0, failed: 11, cases: failedCases })
  });
  const payload = payloadOf(
    await verifyJiraIssue(stubRuntime(dir), { issueKey: "AOS-1", scope: "密码", dryRun: true }, deps)
  );
  assert.equal(payload.writeback.outcome, "dryRun");
  assert.equal(payload.writeback.evidencePlanned.length, 10);
  assert.equal(payload.writeback.evidenceTruncated, 1);
  assert.equal(calls.execute.length, 1);
});

test("verify_jira_issue: >200 份时窗口外功能仍进入候选（默认读取全量）", async () => {
  const dir = tempDir();
  const store = new MemoryStore();
  await store.upsertProject({ rootPath: dir, name: "p" });
  const { targetJsonPath } = await seedCaseSets(store, dir, path.join(dir, "design"), { count: 201 });
  const runtime = { ...stubRuntime(dir), store };
  const { deps, calls } = makeDeps(dir, {
    mappingReply: '{"caseIds":["case-1"]}',
    report: reportStub({ cases: [caseStub("case-1")] })
  });
  delete deps.listSets;
  const payload = payloadOf(await verifyJiraIssue(runtime, { issueKey: "AOS-1" }, deps));
  assert.equal(payload.ok, true, JSON.stringify(payload));
  assert.deepEqual(payload.mapping, { selected: 1 });
  assert.equal(calls.execute[0].options.testsPath, targetJsonPath);
});

test("verify_jira_issue: 响应含 designWarnings（缺 preflight 摘要 → null）", async () => {
  const dir = tempDir();
  const casesFile = writeCasesFile(dir, "账户.json", [{ id: "c1", name: "错误密码" }]);
  const summary = {
    available: true,
    total: 1,
    byCode: { "flow-graph-empty": 1 },
    codes: ["flow-graph-empty"],
    snapshotAt: "2026-10-18T00:00:00.000Z",
    stale: false
  };
  const withWarnings = makeDeps(dir, {
    sets: [record("figma:x", [featureRecord(casesFile, { caseCount: 1 })])],
    mappingReply: '{"caseIds":["c1"]}',
    report: reportStub({
      cases: [caseStub("c1")],
      preflight: {
        weakCases: [],
        designWarnings: [{ code: "flow-graph-empty", message: "流程图为空" }],
        designWarningSummary: summary
      }
    })
  });
  const payload = payloadOf(
    await verifyJiraIssue(stubRuntime(dir), { issueKey: "AOS-1", dryRun: true }, withWarnings.deps)
  );
  assert.deepEqual(payload.designWarnings, { ...summary, bySource: { 账户: 1 } });

  const withoutWarnings = makeDeps(dir, {
    sets: [record("figma:x", [featureRecord(casesFile, { caseCount: 1 })])],
    mappingReply: '{"caseIds":["c1"]}',
    report: reportStub({ cases: [caseStub("c1")] })
  });
  const plainPayload = payloadOf(
    await verifyJiraIssue(stubRuntime(dir), { issueKey: "AOS-1", dryRun: true }, withoutWarnings.deps)
  );
  assert.equal(plainPayload.designWarnings, null);
});
