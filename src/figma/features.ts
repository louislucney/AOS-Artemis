import type { ChatFn } from "../llm/chat.js";

/** 功能切分（DESIGN：回归服务 §5.1）：把一稿多功能的流程按功能切成"份"。
 * 信号优先级（确定性，同输入同输出）：① Figma 页面 ② 屏幕名公共前缀（未覆盖屏按
 * 边邻居多数归并）③ 无向图连通分量 ④ 单组回退。所有遍历按屏幕名 code-point 排序。 */
export interface FeatureSplitInput {
  screens: { name: string; page?: string }[];
  edges: { from: string; to: string | null }[];
}

export interface FeatureGroup {
  key: string;
  name: string;
  screens: string[];
  signal: "page" | "name-prefix" | "cluster" | "fallback";
  candidateName: string | null;
}

export interface FeatureWarning {
  code: string;
  message: string;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function prefixToken(name: string): string | null {
  const match = /^([^\s\-_·/\d]+)/.exec(name.trim());
  return match ? match[1]! : null;
}

function makeGroup(
  screens: string[],
  signal: FeatureGroup["signal"],
  candidateName: string | null
): FeatureGroup {
  return { key: "", name: "", screens: [...screens].sort(compareText), signal, candidateName };
}

function sortGroups(groups: FeatureGroup[]): FeatureGroup[] {
  return groups.sort((a, b) => compareText(a.screens[0] ?? "", b.screens[0] ?? ""));
}

function buildAdjacency(
  names: Set<string>,
  edges: FeatureSplitInput["edges"]
): Map<string, string[]> {
  const adjacency = new Map<string, string[]>();
  const link = (from: string, to: string): void => {
    const bucket = adjacency.get(from) ?? [];
    bucket.push(to);
    adjacency.set(from, bucket);
  };
  for (const edge of edges) {
    if (!edge.to || !names.has(edge.from) || !names.has(edge.to)) continue;
    link(edge.from, edge.to);
    link(edge.to, edge.from);
  }
  return adjacency;
}

export function splitFeatures(input: FeatureSplitInput): FeatureGroup[] {
  const names = [...new Set(input.screens.map((screen) => screen.name))].sort(compareText);
  if (names.length === 0) return [];
  const known = new Set(names);
  const adjacency = buildAdjacency(known, input.edges);

  const byPage = new Map<string, string[]>();
  for (const name of names) {
    const page = input.screens.find((screen) => screen.name === name)?.page?.trim();
    if (!page) continue;
    const bucket = byPage.get(page) ?? [];
    bucket.push(name);
    byPage.set(page, bucket);
  }
  if (byPage.size >= 2) {
    return sortGroups(
      [...byPage.entries()].map(([page, screens]) => makeGroup(screens, "page", page))
    );
  }

  const byPrefix = new Map<string, string[]>();
  for (const name of names) {
    const token = prefixToken(name);
    if (!token) continue;
    const bucket = byPrefix.get(token) ?? [];
    bucket.push(name);
    byPrefix.set(token, bucket);
  }
  const groups: FeatureGroup[] = [];
  const assigned = new Set<string>();
  for (const [token, screens] of byPrefix) {
    if (screens.length < 2) continue;
    groups.push(makeGroup(screens, "name-prefix", token));
    for (const screen of screens) assigned.add(screen);
  }
  if (groups.length > 0) {
    for (const name of names.filter((entry) => !assigned.has(entry))) {
      const counts = new Map<FeatureGroup, number>();
      for (const neighbor of adjacency.get(name) ?? []) {
        const owner = groups.find((group) => group.screens.includes(neighbor));
        if (owner) counts.set(owner, (counts.get(owner) ?? 0) + 1);
      }
      let best: FeatureGroup | null = null;
      let bestCount = 0;
      for (const [group, count] of counts) {
        if (count > bestCount) {
          best = group;
          bestCount = count;
          continue;
        }
        if (
          count === bestCount &&
          best !== null &&
          compareText(group.screens[0] ?? "", best.screens[0] ?? "") < 0
        ) {
          best = group;
        }
      }
      if (best) {
        best.screens.push(name);
        best.screens.sort(compareText);
      } else {
        groups.push(makeGroup([name], "cluster", null));
      }
    }
    return sortGroups(groups);
  }

  const seen = new Set<string>();
  const components: string[][] = [];
  for (const name of names) {
    if (seen.has(name)) continue;
    const queue = [name];
    seen.add(name);
    const component: string[] = [];
    while (queue.length > 0) {
      const current = queue.shift()!;
      component.push(current);
      for (const neighbor of adjacency.get(current) ?? []) {
        if (seen.has(neighbor)) continue;
        seen.add(neighbor);
        queue.push(neighbor);
      }
    }
    components.push(component);
  }
  if (components.length >= 2) {
    return sortGroups(components.map((screens) => makeGroup(screens, "cluster", null)));
  }

  return [makeGroup(names, "fallback", null)];
}

const NAME_SYSTEM_PROMPT =
  '你是测试架构师。为一组屏幕起一个简短的中文功能名；只输出 JSON：{"name":"…"}；名称不超过 8 个字，不含标点。';

function cleanName(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/["'“”「」\r\n\t]/g, "").trim();
  if (!cleaned) return null;
  return cleaned.slice(0, maxLength);
}

function parseNameJson(raw: string): string | null {
  const trimmed = raw.trim();
  const candidates = [trimmed];
  const match = /\{[\s\S]*\}/.exec(trimmed);
  if (match) candidates.push(match[0]);
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as { name?: unknown };
      const name = cleanName(parsed?.name, 8);
      if (name) return name;
    } catch {
      /* 尝试下一个候选 */
    }
  }
  return null;
}

async function askFeatureName(chat: ChatFn, group: FeatureGroup): Promise<string | null> {
  try {
    const raw = await chat([
      { role: "system", content: NAME_SYSTEM_PROMPT },
      { role: "user", content: group.screens.join("、") }
    ]);
    return parseNameJson(raw);
  } catch {
    return null;
  }
}

/** 命名回退链：候选名（≤16 字）→ LLM（≤8 字）→ `功能N`（N=按屏幕名字典序的组序号）+ 告警。 */
export async function nameFeatures(
  groups: FeatureGroup[],
  deps: { chat?: ChatFn | null } = {}
): Promise<{ groups: FeatureGroup[]; warnings: FeatureWarning[] }> {
  const warnings: FeatureWarning[] = [];
  const ordered = [...groups].sort((a, b) => compareText(a.screens[0] ?? "", b.screens[0] ?? ""));
  const named: FeatureGroup[] = [];
  for (const [index, group] of ordered.entries()) {
    const candidate = cleanName(group.candidateName, 16);
    if (candidate) {
      named.push({ ...group, name: candidate });
      continue;
    }
    const fromLlm = deps.chat ? await askFeatureName(deps.chat, group) : null;
    if (fromLlm) {
      named.push({ ...group, name: fromLlm });
      continue;
    }
    const fallback = `功能${index + 1}`;
    named.push({ ...group, name: fallback });
    warnings.push({
      code: "feature-naming-fallback",
      message: `功能命名回退：${group.screens[0] ?? "?"}（${group.screens.length} 屏）→ ${fallback}`
    });
  }
  return { groups: named, warnings };
}
