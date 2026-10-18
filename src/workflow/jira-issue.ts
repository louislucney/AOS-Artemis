import fs from "node:fs";
import path from "node:path";

import { REAL_DATA_CLAUSE } from "../figma/data-policy.js";
import { designDir } from "../figma/design-store.js";
import { adfToText, asAdfNode, type AdfNode } from "../jira/adf.js";
import type { NormalizedIssue } from "../jira/context.js";

/** Jira 单解读：细致度分档、步骤提取、「单子即用例」合成与落盘。 */

export type DetailTier = "detailed" | "coarse";

export function detailTierOf(issue: NormalizedIssue): DetailTier {
  if (issue.description.acceptanceCriteria.length > 0) return "detailed";
  if (issueStepItems(issue.description.raw).length >= 2) return "detailed";
  if (issue.description.text.replace(/\s/g, "").length >= 120) return "detailed";
  return "coarse";
}

/** ADF listItem 文本（有序/无序/嵌套展平）；无列表 → []。 */
export function issueStepItems(description: unknown): string[] {
  const root = asAdfNode(description);
  if (root === null) return [];
  const items: string[] = [];
  const visit = (node: AdfNode): void => {
    if (node.type === "listItem") {
      const own: string[] = [];
      for (const child of node.content ?? []) {
        if (child.type === "bulletList" || child.type === "orderedList") continue;
        const text = adfToText(child).trim();
        if (text !== "") own.push(text);
      }
      if (own.length > 0) items.push(own.join(" "));
      for (const child of node.content ?? []) {
        if (child.type === "bulletList" || child.type === "orderedList") visit(child);
      }
      return;
    }
    for (const child of node.content ?? []) visit(child);
  };
  visit(root);
  return items;
}

export interface TicketCase {
  id: string;
  name: string;
  preconditions: string[];
  taskDesc: string;
  screens: string[];
  steps: string[];
  expectations: Array<Record<string, unknown>>;
  feature: string;
}

const EXPECTED_PATTERN = /(?:预期(?:结果)?|期望(?:结果)?|应该|应当|应出现|应显示)[：:，,]\s*(.+)$/;
const TRAILING_PUNCTUATION = /[\s，,。；;：:、]+$/;

function stepItemsOf(issue: NormalizedIssue): string[] {
  const items = issueStepItems(issue.description.raw);
  if (items.length > 0) return items;
  const lines = issue.description.text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  if (lines.length > 0) return lines;
  return [issue.summary === "" ? `验证 ${issue.key}` : issue.summary];
}

export function synthesizeCasesFromIssue(issue: NormalizedIssue): TicketCase[] {
  const items = stepItemsOf(issue);
  const steps: string[] = [];
  const expectations: Array<Record<string, unknown>> = [];
  const expectedTexts: string[] = [];
  for (const item of items) {
    const match = EXPECTED_PATTERN.exec(item);
    if (match && match[1] !== undefined && match[1].trim() !== "") {
      const action = item.slice(0, match.index).replace(TRAILING_PUNCTUATION, "");
      const expected = match[1].trim();
      steps.push(`执行「${action}」，应出现「${expected}」`);
      expectations.push({ kind: "assert", text: expected });
      expectedTexts.push(expected);
    } else {
      steps.push(`探索：${item}`);
      expectations.push({ kind: "explore" });
    }
  }
  const name = issue.summary === "" ? `验证 ${issue.key}` : issue.summary;
  const taskDesc = [
    REAL_DATA_CLAUSE,
    `用例：${name}`,
    `工单：${issue.key}`,
    `步骤：${items.join("；")}`,
    ...(expectedTexts.length > 0 ? [`预期：${expectedTexts.join("；")}`] : [])
  ].join("\n");
  return [
    {
      id: `jira-${issue.key}-1`,
      name,
      preconditions: [],
      taskDesc,
      screens: [],
      steps,
      expectations,
      feature: `jira-${issue.key}`
    }
  ];
}

export function ticketTestsPath(configDirAbs: string, issueKey: string): string {
  return path.join(designDir(configDirAbs), "jira", `${issueKey}.tests.json`);
}

/** 写「单子即用例」的临时 tests.json（覆盖式，幂等）；不注册用例库（不经 case-sets/）。 */
export function writeTicketTestsFile(
  configDirAbs: string,
  issue: NormalizedIssue,
  cases: TicketCase[],
  now: Date
): string {
  const jsonPath = ticketTestsPath(configDirAbs, issue.key);
  fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
  const source = `jira:${issue.key}`;
  const payload = {
    meta: { source, generatedAt: now.toISOString() },
    source,
    features: [{ key: `jira-${issue.key}`, name: issue.key, screens: [] }],
    counts: { flows: cases.length, screens: 0, edges: 0 },
    flows: cases
  };
  fs.writeFileSync(jsonPath, JSON.stringify(payload, null, 2) + "\n");
  return jsonPath;
}
