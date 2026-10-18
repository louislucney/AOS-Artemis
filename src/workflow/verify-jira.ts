import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import type { CaseSetRecord } from "../db/types.js";
import { executeSuiteBatch } from "../figma/suite-batch.js";
import type { SuiteCaseResult } from "../figma/suite-runner.js";
import { adfToText } from "../jira/adf.js";
import type { JiraClient } from "../jira/client.js";
import { findCommentByMarker, upsertMarkedComment } from "../jira/comments.js";
import { normalizeIssue, parseIssueKey } from "../jira/context.js";
import { postEvidenceToIssue } from "../jira/post.js";
import { resolveJiraClient } from "../jira/resolve.js";
import { buildVerifyComment, parseVerifyMapping, verifyMarker } from "../jira/verify-comment.js";
import { makeChatFn, type ChatFn } from "../llm/chat.js";
import { log as logInfo, logWarn } from "../log.js";
import type { Runtime } from "../runtime.js";
import { platformOf } from "../tasks/run-registry.js";
import { errorMessage } from "../util.js";
import { latestFeatures, normalizeKeyword, readCaseSummaries, selectByScope, type CaseTarget } from "./case-selection.js";
import { defaultListDevices, pickDevice } from "./devices.js";
import { detailTierOf, synthesizeCasesFromIssue, writeTicketTestsFile } from "./jira-issue.js";
import { selectCasesWithLlm } from "./jira-mapping.js";
import { checkJira, checkLlm, type SetupDeps } from "./setup.js";

/** `verify_jira_issue` 编排（统一服务 ③）：读单分档 → 库映射/单子即用例 → 执行 → 聚合 → 回写。
 * `dryRun` 不回写任何东西；聚合口径：任一强断言失败→FAIL，全弱/全探索→无法判定（披露构成）。 */

export interface VerifyJiraIssueArgs {
  issueKey: string;
  device?: string;
  scope?: string;
  dryRun?: boolean;
}

export interface VerifyJiraIssueDeps {
  setup?: SetupDeps;
  chat?: ChatFn;
  listDevices?: () => Promise<Array<{ serial: string }>>;
  listSets?: (runtime: Runtime, limit: number) => Promise<CaseSetRecord[]>;
  executeBatch?: typeof executeSuiteBatch;
  resolveJira?: typeof resolveJiraClient;
  postEvidence?: typeof postEvidenceToIssue;
  associateCase?: (runtime: Runtime, input: { runId: string; caseId: string; jiraKey: string }) => Promise<unknown>;
  log?: (line: string) => void;
  now?: () => Date;
}

const EVIDENCE_POST_CAP = 10;
const TICKET_SUGGESTIONS = [
  "核对单号与站点权限（可先用 jira_issue_get 单独验证）",
  "若为 429 限流：稍后重试"
];
const MAPPING_FAILURE_SUGGESTIONS = [
  "稍后重试（LLM 波动）",
  "或给 scope 直接指定要跑的用例范围"
];
const RUN_FAILURE_SUGGESTION =
  "用例与证据已落盘（.artemis/design/runs/、.artemis/traces/），按提示处理后重跑安全";
const RUN_NOT_EXECUTED_SUGGESTIONS = [
  "确认设备在线且可驱动：node dist/cli.js doctor（Android 查 adb 授权；iOS 查 Appium/WDA 状态）",
  RUN_FAILURE_SUGGESTION
];

type Conclusion = "passed" | "failed" | "inconclusive";

interface FailedEntry {
  caseId: string;
  name: string;
  classification: "strong" | "weak" | "explore";
  traceId: string | null;
}

function jsonResult(payload: unknown, isError = false): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }], isError };
}

function trimOrNull(value: string | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function classifyCase(entry: SuiteCaseResult, weakIds: Set<string>): "strong" | "weak" | "explore" {
  if (weakIds.has(entry.caseId)) return "weak";
  if (entry.scriptProvenance === null) return "weak";
  if (entry.scriptProvenance.asserts === 0) return "explore";
  return "strong";
}

async function readPreviousMapping(client: JiraClient, issueKey: string): Promise<string[]> {
  try {
    const comments = await client.getComments(issueKey);
    const existing = findCommentByMarker(comments, verifyMarker(issueKey));
    if (existing === null) return [];
    const body = comments.find((comment) => comment.id === existing.id)?.body;
    return parseVerifyMapping(adfToText(body));
  } catch (error) {
    logWarn(`verify_jira_issue: 上次映射读取降级：${errorMessage(error)}`);
    return [];
  }
}

export async function verifyJiraIssue(
  runtime: Runtime,
  args: VerifyJiraIssueArgs,
  deps: VerifyJiraIssueDeps = {}
): Promise<CallToolResult> {
  const issueKeyInput = typeof args.issueKey === "string" ? args.issueKey : "";
  const key = parseIssueKey(issueKeyInput);
  if (key === null) {
    return jsonResult(
      { ok: false, error: `无法解析 issue key："${issueKeyInput}"。请传 key（如 AOS-123）或 browse URL。` },
      true
    );
  }
  const requestedDevice = trimOrNull(args.device);
  const scope = trimOrNull(args.scope);
  const dryRun = args.dryRun === true;
  const logLine = deps.log ?? logInfo;
  const steps: Array<Record<string, unknown>> = [];

  const jiraNeed = checkJira(runtime);
  if (jiraNeed !== null) {
    return jsonResult({ ok: false, needs: "setup", checks: [jiraNeed] });
  }
  const resolved = (deps.resolveJira ?? resolveJiraClient)(runtime);
  if (resolved === null) {
    return jsonResult({
      ok: false,
      needs: "setup",
      checks: [
        {
          target: "jira",
          missing: ["Jira 凭证"],
          howTo: ["调用 aos_configure 同时提供 jiraSite / jiraEmail / jiraApiToken（写入项目 .env 并即时刷新）"]
        }
      ]
    });
  }

  let issue;
  try {
    const raw = await resolved.client.getIssue(key, ["summary", "description", "labels"]);
    issue = normalizeIssue(raw, resolved.siteUrl);
  } catch (error) {
    return jsonResult({
      ok: false,
      failedStep: "ticket",
      detail: errorMessage(error),
      suggestions: TICKET_SUGGESTIONS
    });
  }

  const detailTier = detailTierOf(issue);
  steps.push({ step: "ticket", key: issue.key, detailTier });
  if (detailTier === "coarse") {
    return jsonResult({
      ok: false,
      needs: "info",
      category: "ticket-coarse",
      questions: ["这是哪个功能/页面？", "触发条件是什么（做了什么操作）？", "期望结果是什么？"],
      context: [
        `工单 ${issue.key}：${issue.summary}`,
        "在工单描述里补充「步骤/复现条件＋预期结果」后重跑；或给 scope 指向用例库里的相关功能"
      ]
    });
  }

  const llmNeed = await checkLlm(runtime, deps.setup);
  if (llmNeed !== null) {
    return jsonResult({ ok: false, needs: "setup", checks: [llmNeed] });
  }

  const pick = await pickDevice(requestedDevice, async () => {
    if (deps.listDevices !== undefined) return await deps.listDevices();
    return await defaultListDevices(runtime);
  });
  if (!pick.ok) {
    return pick.needs === "setup"
      ? jsonResult({ ok: false, needs: "setup", checks: [pick.check] })
      : jsonResult({
          ok: false,
          needs: "info",
          category: pick.category,
          questions: pick.questions,
          context: pick.context
        });
  }
  const device = pick.device;
  steps.push({ step: "device", device });

  const listSets =
    deps.listSets ?? ((rt: Runtime, limit: number) => rt.store.listCaseSets(rt.project.rootDir, limit));
  const keyword = scope === null ? null : normalizeKeyword(scope);
  let mode: "scope" | "mapped" | "ticket";
  let targets: CaseTarget[] = [];
  let mappingAttempted = false;
  let mappedSelected = 0;
  let selectedCaseIds: string[] = [];
  let testsFile: string | null = null;

  if (keyword !== null) {
    mode = "scope";
    const features = latestFeatures(await listSets(runtime, 200));
    targets = selectByScope(features, keyword);
    if (targets.length === 0) {
      return jsonResult({
        ok: false,
        needs: "info",
        category: "scope-no-hit",
        questions: [`用例库里没有匹配「${scope}」的用例：换关键词，或给 Excel 测试文档导入/用 design_to_test 生成`],
        context: features.map((entry) => `${entry.feature}（${entry.cases} 条，${entry.provenance}）`)
      });
    }
  } else {
    const features = latestFeatures(await listSets(runtime, 200))
      .map((target) => ({ target, cases: readCaseSummaries(target.jsonPath) }))
      .filter((entry) => entry.cases.length > 0);
    if (features.length === 0) {
      mode = "ticket";
    } else {
      mappingAttempted = true;
      const previous = await readPreviousMapping(resolved.client, issue.key);
      const entry = await runtime.activeEntry();
      const chatTarget =
        entry !== null && entry.baseUrl !== null && entry.apiKey !== null
          ? { baseUrl: entry.baseUrl, apiKey: entry.apiKey, model: entry.model }
          : { baseUrl: "", apiKey: "", model: "" };
      const chat = deps.chat ?? makeChatFn(chatTarget);
      const selection = await selectCasesWithLlm(chat, {
        issue: {
          key: issue.key,
          summary: issue.summary,
          descriptionText: issue.description.text,
          acceptanceCriteria: issue.description.acceptanceCriteria
        },
        candidates: features.map((item) => ({
          feature: item.target.feature,
          provenance: item.target.provenance,
          cases: item.cases
        })),
        ...(previous.length > 0 ? { previous } : {})
      });
      steps.push({
        step: "map",
        candidates: features.reduce((sum, item) => sum + item.cases.length, 0),
        selected: selection.ok ? selection.caseIds.length : 0
      });
      if (!selection.ok) {
        return jsonResult({
          ok: false,
          failedStep: "mapping",
          detail: selection.error,
          suggestions: MAPPING_FAILURE_SUGGESTIONS
        });
      }
      mappedSelected = selection.caseIds.length;
      if (mappedSelected > 0) {
        mode = "mapped";
        selectedCaseIds = selection.caseIds;
        for (const item of features) {
          const selectedIds = selection.caseIds.filter((id) => item.cases.some((record) => record.id === id));
          if (selectedIds.length === 0) continue;
          targets.push({ ...item.target, cases: selectedIds.length, caseIds: selectedIds });
        }
      } else {
        mode = "ticket";
      }
    }
  }

  if (mode === "ticket") {
    const cases = synthesizeCasesFromIssue(issue);
    testsFile = writeTicketTestsFile(runtime.configDirAbs, issue, cases, deps.now?.() ?? new Date());
    targets = [
      {
        feature: `jira-${issue.key}`,
        jsonPath: testsFile,
        cases: cases.length,
        provenance: "单子即用例"
      }
    ];
    steps.push({ step: "synthesize", cases: cases.length, testsFile });
  }

  const echo = targets.map((target) => ({
    feature: target.feature,
    cases: target.cases,
    provenance: target.provenance
  }));
  steps.push({ step: "select", mode, targets: echo });
  const totalCases = targets.reduce((sum, target) => sum + target.cases, 0);
  logLine(
    `verify_jira_issue: 验证目标 ${echo
      .map((entry) => `${entry.feature} ×${entry.cases}（${entry.provenance}）`)
      .join("；")} · 设备 ${device}`
  );
  logLine(`verify_jira_issue: 即将执行 ${totalCases} 条用例 · ${targets.length} 个集 · 设备 ${device}`);
  steps.push({ step: "run", cases: totalCases, sets: targets.length, device });

  const executeBatch = deps.executeBatch ?? executeSuiteBatch;
  const summaries: Array<{ feature: string; jsonPath: string; manifestPath: string | null }> = [];
  const runs: Array<{ runId: string; caseIds: string[] }> = [];
  const failedEntries: FailedEntry[] = [];
  const traceIds: string[] = [];
  let total = 0;
  let executed = 0;
  let passed = 0;
  let failed = 0;
  let strongTotal = 0;
  let weakTotal = 0;
  let exploreTotal = 0;
  let strongFailed = 0;
  let weakFailed = 0;

  for (const target of targets) {
    let batch;
    try {
      batch = await executeBatch(
        runtime,
        {
          options: {
            testsPath: target.jsonPath,
            deviceSerial: device,
            ...(target.caseIds !== undefined ? { caseIds: target.caseIds } : {}),
            apiErrors: true,
            failOnApiErrors: false,
            stopOnFailure: false
          },
          source: "verify_jira_issue",
          trigger: "verify_jira_issue",
          registration: { platform: platformOf(device) }
        },
        { log: logLine }
      );
    } catch (error) {
      return jsonResult({
        ok: false,
        failedStep: "run",
        detail: errorMessage(error),
        suggestions: [RUN_FAILURE_SUGGESTION],
        artifacts: { sets: summaries }
      });
    }
    const report = batch.report;
    summaries.push({ feature: target.feature, jsonPath: target.jsonPath, manifestPath: batch.manifestPath });
    if (!report.ok) {
      return jsonResult({
        ok: false,
        failedStep: "run",
        detail: report.error ?? "套件未执行（无可提交用例）",
        suggestions: RUN_NOT_EXECUTED_SUGGESTIONS,
        artifacts: { sets: summaries }
      });
    }
    if (typeof batch.runId === "string" && batch.runId !== "") {
      runs.push({ runId: batch.runId, caseIds: report.cases.map((entry) => entry.caseId) });
    }
    const weakIds = new Set((report.preflight?.weakCases ?? []).map((entry) => entry.id));
    for (const entry of report.cases) {
      const classification = classifyCase(entry, weakIds);
      if (classification === "strong") strongTotal += 1;
      else if (classification === "weak") weakTotal += 1;
      else exploreTotal += 1;
      if (entry.status !== "passed" && entry.quarantined !== true) {
        if (classification === "strong") strongFailed += 1;
        else weakFailed += 1;
        failedEntries.push({
          caseId: entry.caseId,
          name: entry.name,
          classification,
          traceId: entry.traceId ?? null
        });
      }
      if (typeof entry.traceId === "string" && entry.traceId !== "") traceIds.push(entry.traceId);
    }
    total += report.total;
    executed += report.executed;
    passed += report.passed;
    failed += report.failed;
  }

  const conclusion: Conclusion =
    strongFailed > 0 ? "failed" : strongTotal === 0 ? "inconclusive" : weakFailed > 0 ? "inconclusive" : "passed";
  const sourceLabel =
    mode === "ticket" ? "单子即用例" : [...new Set(targets.map((target) => target.provenance))].join("；");
  const commentInput = {
    issue: { key: issue.key, summary: issue.summary },
    conclusion,
    composition: { strong: strongTotal, weak: weakTotal, explore: exploreTotal },
    source: sourceLabel,
    device,
    manifestPaths: summaries
      .map((summary) => summary.manifestPath)
      .filter((entry): entry is string => typeof entry === "string" && entry !== ""),
    failed: failedEntries,
    ...(mode === "mapped" && selectedCaseIds.length > 0 ? { mapping: { caseIds: selectedCaseIds } } : {})
  };

  const writeback: Record<string, unknown> = { outcome: dryRun ? "dryRun" : "sent" };
  const failedWithTrace = failedEntries.filter((entry) => entry.traceId !== null);
  if (dryRun) {
    writeback.evidencePlanned = failedWithTrace.slice(0, EVIDENCE_POST_CAP).map((entry) => entry.traceId);
    writeback.conclusionText = buildVerifyComment(commentInput).text;
  } else {
    const writebackErrors: string[] = [];
    const postEvidence = deps.postEvidence ?? postEvidenceToIssue;
    const planned = failedWithTrace.slice(0, EVIDENCE_POST_CAP);
    const evidenceResults: Array<Record<string, unknown>> = [];
    for (const entry of planned) {
      try {
        const payload = await postEvidence(runtime, {
          key: issue.key,
          traceId: entry.traceId as string,
          deviceSerial: device
        });
        const ok = payload.ok !== false;
        if (!ok) writebackErrors.push(`${entry.traceId}: ${String(payload.error ?? "证据回写失败")}`);
        evidenceResults.push({ traceId: entry.traceId, ok, commentId: payload.commentId ?? null });
      } catch (error) {
        writebackErrors.push(`${entry.traceId}: ${errorMessage(error)}`);
        evidenceResults.push({ traceId: entry.traceId, ok: false });
      }
    }
    if (failedWithTrace.length > planned.length) {
      writeback.evidenceTruncated = failedWithTrace.length - planned.length;
    }
    writeback.evidence = evidenceResults;
    try {
      const result = await upsertMarkedComment(resolved.client, issue.key, {
        marker: verifyMarker(issue.key),
        body: buildVerifyComment(commentInput).adf,
        property: { key: "aos-verify", value: { issueKey: issue.key } }
      });
      writeback.action = result.action;
      writeback.commentId = result.commentId;
      writeback.propertySet = result.propertySet;
    } catch (error) {
      writebackErrors.push(`结论评论: ${errorMessage(error)}`);
    }
    const associate =
      deps.associateCase ??
      ((rt: Runtime, input: { runId: string; caseId: string; jiraKey: string }) =>
        rt.store.setCaseIssueKey({ rootPath: rt.project.rootDir, ...input }));
    for (const run of runs) {
      for (const caseId of run.caseIds) {
        try {
          await associate(runtime, { runId: run.runId, caseId, jiraKey: issue.key });
        } catch (error) {
          writebackErrors.push(`关联 ${caseId}: ${errorMessage(error)}`);
        }
      }
    }
    if (writebackErrors.length > 0) writeback.errors = writebackErrors;
  }

  return jsonResult({
    ok: true,
    ticket: { key: issue.key, detailTier, summary: issue.summary },
    ...(mappingAttempted ? { mapping: { selected: mappedSelected } } : {}),
    ...(scope !== null ? { scope: { keyword: scope, hits: totalCases } } : {}),
    steps,
    artifacts: { sets: summaries, ...(testsFile !== null ? { testsFile } : {}) },
    run: {
      device,
      sets: targets.length,
      total,
      executed,
      passed,
      failed,
      gate: conclusion,
      conclusion,
      composition: { strong: strongTotal, weak: weakTotal, explore: exploreTotal },
      traceIds
    },
    writeback
  });
}
