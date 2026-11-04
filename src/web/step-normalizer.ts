import type { ChatFn } from "../llm/chat.js";

export type NormalizedSelector = {
  text: string;
  relation?: "rightOf" | "leftOf" | "below" | "above";
};

export type NormalizedAction =
  | { type: "launch" }
  | { type: "tap"; target: NormalizedSelector }
  | { type: "input"; target: NormalizedSelector; value: string }
  | { type: "verify"; target?: NormalizedSelector }
  | { type: "scroll"; direction?: "UP" | "DOWN" }
  | { type: "back" }
  | { type: "wait" }
  | { type: "manual"; reason: string };

export interface NormalizedStep {
  step: number;
  actions: NormalizedAction[];
  confidence: "high" | "medium" | "low";
  note?: string;
}

export interface NormalizeCaseInput {
  caseId: string;
  name: string;
  steps: string[];
  expected: string | null;
  preconditions: string[];
  platform: "android" | "ios";
  appId: string;
}

export interface StepNormalizer {
  normalize(input: NormalizeCaseInput, signal?: AbortSignal): Promise<NormalizedStep[] | null>;
}

const RELATIONS = new Set(["rightOf", "leftOf", "below", "above"]);
const SYSTEM_LABELS = new Set([
  "ok",
  "cancel",
  "submit",
  "back",
  "next",
  "done",
  "save",
  "close",
  "yes",
  "no",
  "確定",
  "确定",
  "取消",
  "提交",
  "返回",
  "下一步",
  "完成",
  "儲存",
  "保存",
  "關閉",
  "关闭",
  "是",
  "否"
]);

const SYSTEM_PROMPT = [
  "你是移动端手工测试用例的步骤规范化器。把用户给出的用例步骤转换成受控 JSON 动作计划。",
  "输入可能是简体中文、繁体中文或英文；标签必须保留原文，不要翻译。",
  "只允许以下动作：launch, tap, input, verify, scroll, back, wait, manual。",
  '输出必须是单个 JSON 对象：{"steps":[{"step":1,"actions":[...],"confidence":"high"}]}。',
  "规则：",
  "1. tap 的 target.text 必须是原文中出现的文字（步骤、用例名或预期结果），不得发明标签。",
  '2. 图标按钮用 "next to X" 描述时，输出 {"type":"tap","target":{"text":"X","relation":"rightOf"}}；明确 left of/below/above/under 时用对应 relation。',
  '3. input 的 target.text 是字段标签；value 必须是原文中的值；原文写 "A random code" 时用 "AOSINVALID0001"。',
  "4. verify 不产生点击；只标记该步骤是验证点。",
  '5. 跨用例依赖 "Complete TC_XX" 输出 {"type":"manual","reason":"depends-on:TC_XX"}。',
  '6. 无法可靠映射时输出 {"type":"manual","reason":"..."}，不要猜。',
  "7. 不要输出 YAML、shell、解释文字或 Markdown。"
].join("\n");

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizedSource(input: NormalizeCaseInput): string {
  return [input.caseId, input.name, ...input.steps, input.expected ?? "", ...input.preconditions]
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function validateSelector(raw: unknown, source: string): NormalizedSelector | null {
  if (!isRecord(raw)) return null;
  const text = typeof raw.text === "string" ? raw.text.trim() : "";
  const chars = [...text];
  if (chars.length < 1 || chars.length > 40 || text.includes("${") || /[\r\n\t]/.test(text)) {
    return null;
  }
  const relation = raw.relation;
  if (
    relation !== undefined &&
    (typeof relation !== "string" || !RELATIONS.has(relation))
  ) {
    return null;
  }
  const normalized = text.replace(/\s+/g, " ").toLowerCase();
  if (!source.includes(normalized) && !SYSTEM_LABELS.has(normalized)) return null;
  return {
    text,
    ...(relation === undefined
      ? {}
      : { relation: relation as NormalizedSelector["relation"] })
  };
}

function validateActions(raw: unknown, source: string): NormalizedAction[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 20) return null;
  const out: NormalizedAction[] = [];
  for (const entry of raw) {
    if (!isRecord(entry) || typeof entry.type !== "string") return null;
    switch (entry.type) {
      case "launch":
        out.push({ type: "launch" });
        break;
      case "tap": {
        const target = validateSelector(entry.target, source);
        if (target === null) return null;
        out.push({ type: "tap", target });
        break;
      }
      case "input": {
        const target = validateSelector(entry.target, source);
        const value = typeof entry.value === "string" ? entry.value.trim() : "";
        if (
          target === null ||
          value === "" ||
          [...value].length > 200 ||
          /[\r\n\t]/.test(value) ||
          value.includes("${")
        ) {
          return null;
        }
        out.push({ type: "input", target, value });
        break;
      }
      case "verify": {
        const target = entry.target === undefined ? undefined : validateSelector(entry.target, source);
        if (target === null) return null;
        out.push({ type: "verify", ...(target === undefined ? {} : { target }) });
        break;
      }
      case "scroll": {
        const direction = entry.direction;
        if (direction !== undefined && direction !== "UP" && direction !== "DOWN") return null;
        out.push({
          type: "scroll",
          ...(direction === undefined ? {} : { direction })
        });
        break;
      }
      case "back":
        out.push({ type: "back" });
        break;
      case "wait":
        out.push({ type: "wait" });
        break;
      case "manual": {
        const reason = typeof entry.reason === "string" ? entry.reason.trim() : "";
        if (reason === "" || [...reason].length > 200) return null;
        out.push({ type: "manual", reason });
        break;
      }
      default:
        return null;
    }
  }
  return out;
}

export function validateNormalizedSteps(
  raw: unknown,
  input: NormalizeCaseInput
): NormalizedStep[] | null {
  const root = Array.isArray(raw)
    ? raw
    : isRecord(raw) && Array.isArray(raw.steps)
      ? raw.steps
      : null;
  if (root === null || root.length === 0 || root.length > input.steps.length) return null;
  const source = normalizedSource(input);
  const seen = new Set<number>();
  const out: NormalizedStep[] = [];
  for (const entry of root) {
    if (!isRecord(entry)) return null;
    const step = entry.step;
    if (
      typeof step !== "number" ||
      !Number.isInteger(step) ||
      step < 1 ||
      step > input.steps.length ||
      seen.has(step)
    ) {
      return null;
    }
    seen.add(step);
    const actions = validateActions(entry.actions, source);
    if (actions === null) return null;
    const confidence = entry.confidence;
    if (confidence !== undefined && confidence !== "high" && confidence !== "medium" && confidence !== "low") {
      return null;
    }
    const note = entry.note;
    if (note !== undefined && (typeof note !== "string" || [...note].length > 200)) return null;
    out.push({
      step,
      actions,
      confidence: confidence ?? "medium",
      ...(typeof note === "string" && note.trim() !== "" ? { note: note.trim() } : {})
    });
  }
  return out;
}

export function buildNormalizerMessages(input: NormalizeCaseInput): Array<{ role: "system" | "user"; content: string }> {
  return [
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "user",
      content: JSON.stringify(
        {
          caseId: input.caseId,
          name: input.name,
          platform: input.platform,
          appId: input.appId,
          steps: input.steps,
          expected: input.expected,
          preconditions: input.preconditions
        },
        null,
        2
      )
    }
  ];
}

export function parseNormalizedResponse(
  raw: string,
  input: NormalizeCaseInput
): NormalizedStep[] | null {
  const text = raw.replace(/```(?:json)?/gi, " ").trim();
  const arrayStart = text.indexOf("[");
  const arrayEnd = text.lastIndexOf("]");
  if (arrayStart >= 0 && arrayEnd > arrayStart) {
    try {
      const parsed: unknown = JSON.parse(text.slice(arrayStart, arrayEnd + 1));
      if (Array.isArray(parsed)) {
        const validated = validateNormalizedSteps(parsed, input);
        if (validated !== null) return validated;
      }
    } catch {
      /* fall through to object parsing */
    }
  }
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  return validateNormalizedSteps(parsed, input);
}

export function createLlmStepNormalizer(options: {
  chat: ChatFn;
  model: string;
  timeoutMs?: number;
}): StepNormalizer {
  const timeoutMs = options.timeoutMs ?? 30_000;
  return {
    async normalize(input, signal) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const onAbort = (): void => controller.abort();
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        const raw = await options.chat(buildNormalizerMessages(input), controller.signal);
        return parseNormalizedResponse(raw, input);
      } catch {
        return null;
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      }
    }
  };
}
