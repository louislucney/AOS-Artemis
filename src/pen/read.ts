export interface PenVariable {
  type?: string;
  value?: unknown;
  [key: string]: unknown;
}

export interface PenNode {
  id?: string;
  type?: string;
  name?: string;
  ref?: string;
  reusable?: boolean;
  children?: PenNode[];
  [key: string]: unknown;
}

export interface PenDocument {
  version?: string;
  themes?: Record<string, string[]>;
  variables?: Record<string, PenVariable>;
  children?: PenNode[];
  [key: string]: unknown;
}

export interface PenValidation {
  errors: string[];
  warnings: string[];
}

export interface PenSummary {
  version: string | null;
  topLevel: number;
  totalNodes: number;
  byType: Record<string, number>;
  screens: Array<{ id: string | null; name: string }>;
  components: Array<{ id: string | null; name: string }>;
  instances: number;
  texts: number;
  textSamples: string[];
  variables: { total: number; byType: Record<string, number> };
  themes: Record<string, string[]>;
  images: string[];
}

const WARNING_CAP = 60;

function capList(list: string[], cap = WARNING_CAP): string[] {
  if (list.length <= cap) return list;
  return [...list.slice(0, cap), `...（共 ${list.length} 条，已截断）`];
}

export function stripJsonComments(text: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === "/" && next === "/") {
      i += 2;
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i += 1;
      out += " ";
      continue;
    }
    out += ch;
  }
  return out;
}

export function parsePenText(text: string): PenDocument {
  const cleaned = stripJsonComments(text.replace(/^\uFEFF/, ""));
  const parsed = JSON.parse(cleaned) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(".pen 根节点必须是 JSON 对象");
  }
  const doc = parsed as PenDocument;
  if (!Array.isArray(doc.children)) throw new Error(".pen 缺少 children 数组");
  return doc;
}

export function collectPenNodes(doc: PenDocument): PenNode[] {
  const out: PenNode[] = [];
  const visit = (node: PenNode): void => {
    out.push(node);
    if (Array.isArray(node.children)) {
      for (const child of node.children) {
        if (child && typeof child === "object") visit(child);
      }
    }
  };
  for (const child of doc.children ?? []) {
    if (child && typeof child === "object") visit(child);
  }
  return out;
}

export function validatePen(doc: PenDocument): PenValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const ids = new Set<string>();
  const refs: Array<{ ref: string; name: string }> = [];
  const nodes = collectPenNodes(doc);

  for (const node of nodes) {
    const id = typeof node.id === "string" && node.id.length > 0 ? node.id : null;
    if (!id) {
      warnings.push(`节点缺少 id（type=${node.type ?? "?"}, name=${node.name ?? "?"}）`);
    } else {
      if (id.includes("/")) errors.push(`id 含 "/"（格式禁止）：${id}`);
      if (ids.has(id)) errors.push(`id 重复：${id}`);
      ids.add(id);
    }
    if (node.type === "ref") {
      const target = typeof node.ref === "string" ? node.ref : "";
      if (!target) errors.push(`ref 节点缺少目标：${node.id ?? node.name ?? "?"}`);
      else refs.push({ ref: target, name: node.name ?? node.id ?? target });
    }
  }
  for (const entry of refs) {
    if (!ids.has(entry.ref)) errors.push(`ref 悬空：${entry.name} -> ${entry.ref}`);
  }

  const variables = doc.variables ?? {};
  for (const name of Object.keys(variables)) {
    if (!name || name.includes(":")) errors.push(`变量名非法（空或含 ":"）：${JSON.stringify(name)}`);
  }

  const missingVariables = new Set<string>();
  const visitValue = (value: unknown): void => {
    if (typeof value === "string") {
      if (value.startsWith("$") && value.length > 1 && !(value.slice(1) in variables)) {
        missingVariables.add(value.slice(1));
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visitValue(item);
      return;
    }
    if (value && typeof value === "object") {
      for (const item of Object.values(value as Record<string, unknown>)) visitValue(item);
    }
  };
  for (const node of nodes) {
    for (const [key, value] of Object.entries(node)) {
      if (key !== "children") visitValue(value);
    }
  }
  visitValue(doc.variables);
  for (const name of missingVariables) {
    warnings.push(`引用了未定义变量 $${name}（可能来自 imports 外链 .pen 库）`);
  }

  for (const [axis, values] of Object.entries(doc.themes ?? {})) {
    if (!Array.isArray(values) || values.length === 0) warnings.push(`主题轴 ${axis} 没有取值`);
  }

  return { errors: capList(errors), warnings: capList(warnings) };
}

export function summarizePen(doc: PenDocument): PenSummary {
  const nodes = collectPenNodes(doc);
  const byType: Record<string, number> = {};
  const components: Array<{ id: string | null; name: string }> = [];
  const textSamples: string[] = [];
  const images = new Set<string>();
  let instances = 0;
  let texts = 0;

  const collectImages = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) collectImages(item);
      return;
    }
    if (!value || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    if (record.type === "image" && typeof record.url === "string") images.add(record.url);
    for (const item of Object.values(record)) collectImages(item);
  };

  for (const node of nodes) {
    const type = typeof node.type === "string" ? node.type : "unknown";
    byType[type] = (byType[type] ?? 0) + 1;
    if (node.reusable === true) components.push({ id: node.id ?? null, name: node.name ?? "" });
    if (type === "ref") instances++;
    if (type === "text") {
      texts++;
      const content = typeof node.content === "string" ? node.content : "";
      if (content && textSamples.length < 8) textSamples.push(content);
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === "fill" || key === "stroke") collectImages(value);
    }
  }

  const screens: Array<{ id: string | null; name: string }> = [];
  for (const child of doc.children ?? []) {
    if (child?.type === "frame") screens.push({ id: child.id ?? null, name: child.name ?? "" });
  }

  const variables = doc.variables ?? {};
  const variablesByType: Record<string, number> = {};
  for (const variable of Object.values(variables)) {
    const type = typeof variable?.type === "string" ? variable.type : "unknown";
    variablesByType[type] = (variablesByType[type] ?? 0) + 1;
  }

  return {
    version: typeof doc.version === "string" ? doc.version : null,
    topLevel: (doc.children ?? []).length,
    totalNodes: nodes.length,
    byType,
    screens,
    components,
    instances,
    texts,
    textSamples,
    variables: { total: Object.keys(variables).length, byType: variablesByType },
    themes: doc.themes ?? {},
    images: [...images]
  };
}
