import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { classifyModalityRejection } from "../../llm/vision-capability.js";
import type { ChatFn, ChatMessage } from "../../llm/chat.js";
import type { FlowEdge, FlowElement, FlowWarning } from "../../figma/flows.js";
import { isPngBuffer, screenFileName } from "../screens.js";
import { chunkReadingScreens, type ReadingChunkOptions } from "./chunk.js";
import { loadReadingAnswers } from "./answers.js";
import {
  isStateKeyword,
  normalizeMatchText,
  splitStateLabel,
  stateLabelsOf,
  type ReadingNamingStyle
} from "./naming.js";
import { mergeReadingChunks } from "./merge.js";
import { detectCanvasLayout } from "./canvas.js";
import { parseReadingReply } from "./parse.js";
import { buildReadingMessages, READING_PROMPT_VERSION } from "./prompt.js";
import { renderChunkMarkdown, renderReadingMarkdown } from "./render.js";
import {
  readCachedChunk,
  readingChunkHash,
  readingPaths,
  writeReadingChunk
} from "./store.js";
import type {
  DesignReadingResult,
  ReadingChunk,
  ReadingChunkPlan,
  ReadingBBox,
  ReadingFile,
  ReadingScreenRef,
  ReadingStats
} from "./types.js";
import { emptyReadingStats } from "./types.js";
import { errorMessage, writeFileAtomic } from "../../util.js";

interface FlowDocState {
  id?: unknown;
  label?: unknown;
  frameName?: unknown;
  elements?: unknown;
}

interface FlowDocScreen {
  id?: unknown;
  name?: unknown;
  sourceFrameName?: unknown;
  page?: unknown;
  bounds?: unknown;
  elements?: unknown;
  states?: unknown;
}

interface FlowDoc {
  source?: unknown;
  fileKey?: unknown;
  screens?: unknown;
  edges?: unknown;
  screenshots?: { summary?: { dir?: unknown } } | unknown;
}

interface LoadedScreen {
  ref: ReadingScreenRef;
  imagePath: string | null;
  knownElements: FlowElement[];
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function asFlowEdges(value: unknown): FlowEdge[] {
  return Array.isArray(value) ? (value as FlowEdge[]) : [];
}

function asFlowElements(value: unknown): FlowElement[] {
  return Array.isArray(value) ? (value as FlowElement[]) : [];
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function sha256Buffer(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function resolveImagePath(
  configDirAbs: string,
  flowsDir: string | null,
  screensDir: string | undefined,
  screenId: string
): string | null {
  const file = screenFileName(screenId);
  const candidates: string[] = [];
  if (screensDir !== undefined && screensDir.trim() !== "") {
    candidates.push(path.isAbsolute(screensDir) ? screensDir : path.join(configDirAbs, "design", screensDir));
  }
  if (flowsDir !== null) {
    candidates.push(
      path.isAbsolute(flowsDir)
        ? flowsDir
        : path.join(configDirAbs, "design", flowsDir)
    );
  }
  for (const dir of candidates) {
    const candidate = path.join(dir, file);
    if (fs.existsSync(candidate)) return candidate;
  }
  // 兜底：screens/<channel>/<screen>.png
  const root = path.join(configDirAbs, "design", "screens");
  try {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const candidate = path.join(root, entry.name, file);
      if (fs.existsSync(candidate)) return candidate;
    }
  } catch {
    /* best effort */
  }
  return null;
}

interface RawScreenEntry {
  id: string;
  name: string;
  index: number;
  imagePath: string | null;
  sourceFrameName?: string;
  bounds?: ReadingBBox;
  rawStates: unknown;
  elements: FlowElement[];
}

function asBounds(value: unknown): ReadingBBox | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as { x?: unknown; y?: unknown; width?: unknown; height?: unknown };
  const values = [record.x, record.y, record.width, record.height];
  if (!values.every((entry) => typeof entry === "number" && Number.isFinite(entry))) {
    return undefined;
  }
  return {
    x: record.x as number,
    y: record.y as number,
    width: record.width as number,
    height: record.height as number
  };
}

function loadScreens(
  doc: FlowDoc,
  configDirAbs: string,
  screensDir: string | undefined,
  includeStates: boolean,
  style: ReadingNamingStyle
): {
  screens: ReadingScreenRef[];
  loaded: LoadedScreen[];
  edges: FlowEdge[];
  canvasLayout: ReturnType<typeof detectCanvasLayout>;
} {
  const rawScreens = Array.isArray(doc.screens) ? (doc.screens as FlowDocScreen[]) : [];
  const screenshots = doc.screenshots as
    | { dir?: unknown; summary?: { dir?: unknown } }
    | undefined;
  const flowsDir =
    asString(screenshots?.dir) ?? asString(screenshots?.summary?.dir);
  const entries: RawScreenEntry[] = [];
  rawScreens.forEach((raw, index) => {
    const id = asString(raw.id);
    if (id === null) return;
    const sourceFrameName = asString(raw.sourceFrameName) ?? undefined;
    const bounds = asBounds(raw.bounds);
    entries.push({
      id,
      name: asString(raw.name) ?? id,
      index,
      imagePath: resolveImagePath(configDirAbs, flowsDir, screensDir, id),
      ...(sourceFrameName === undefined ? {} : { sourceFrameName }),
      ...(bounds === undefined ? {} : { bounds }),
      rawStates: raw.states,
      elements: asFlowElements(raw.elements)
    });
  });

  // Figma 静态稿常把 variants 当成独立 screen（Login / Empty）；仅当后缀是已知状态词时
  // 归并到主屏，避免把普通子页面误判成状态。
  const variantOf = new Map<string, { parent: RawScreenEntry; state: string }>();
  if (includeStates) {
    const variantIds = new Set<string>();
    for (const entry of entries) {
      for (const other of entries) {
        if (other.id === entry.id || other.name.length >= entry.name.length) continue;
        const split = splitStateLabel(entry.name, other.name, style);
        if (split.state !== null && isStateKeyword(split.state, style)) {
          variantIds.add(entry.id);
          break;
        }
      }
    }
    const parentCandidates = entries.filter((entry) => !variantIds.has(entry.id));
    for (const entry of entries) {
      let best: { parent: RawScreenEntry; state: string } | null = null;
      for (const candidate of parentCandidates) {
        if (candidate.id === entry.id) continue;
        const split = splitStateLabel(entry.name, candidate.name, style);
        if (split.state === null || !isStateKeyword(split.state, style)) continue;
        if (best === null || candidate.name.length > best.parent.name.length) {
          best = { parent: candidate, state: split.state };
        }
      }
      if (best !== null) variantOf.set(entry.id, best);
    }
  }

  const variantsByParent = new Map<string, RawScreenEntry[]>();
  for (const entry of entries) {
    const variant = variantOf.get(entry.id);
    if (variant === undefined) continue;
    const list = variantsByParent.get(variant.parent.id) ?? [];
    list.push(entry);
    variantsByParent.set(variant.parent.id, list);
  }

  const screens: ReadingScreenRef[] = [];
  const loaded: LoadedScreen[] = [];
  for (const entry of entries) {
    if (variantOf.has(entry.id)) continue;
    const children = variantsByParent.get(entry.id) ?? [];
    const stateInputs = [
      ...(Array.isArray(entry.rawStates) ? entry.rawStates : []),
      ...children.map((child) => ({ label: child.name }))
    ];
    const states = stateLabelsOf(stateInputs, entry.name, style);
    const ref: ReadingScreenRef = {
      id: entry.id,
      name: entry.name,
      order: entry.index,
      imagePath: entry.imagePath,
      kind: "screen",
      ...(entry.sourceFrameName === undefined ? {} : { sourceFrameName: entry.sourceFrameName }),
      ...(states.length > 0 ? { states } : {})
    };
    screens.push(ref);
    loaded.push({ ref, imagePath: entry.imagePath, knownElements: entry.elements });
    if (!includeStates) continue;

    const seenStateIds = new Set(children.map((child) => child.id));
    let offset = 0;
    const explicitStates = Array.isArray(entry.rawStates) ? entry.rawStates : [];
    for (const rawState of explicitStates) {
      if (!rawState || typeof rawState !== "object") continue;
      const state = rawState as FlowDocState;
      const stateId = asString(state.id);
      const label = asString(state.label);
      if (stateId === null || label === null || seenStateIds.has(stateId)) continue;
      if (normalizeMatchText(label) === normalizeMatchText(entry.name)) continue;
      seenStateIds.add(stateId);
      offset += 1;
      const stateImagePath = resolveImagePath(configDirAbs, flowsDir, screensDir, stateId);
      const stateFrameName = asString(state.frameName) ?? undefined;
      const split = splitStateLabel(label, entry.name, style);
      const stateRef: ReadingScreenRef = {
        id: stateId,
        name: label,
        order: entry.index + offset / 1000,
        imagePath: stateImagePath,
        kind: "state",
        parentScreenId: entry.id,
        ...(stateFrameName === undefined ? {} : { sourceFrameName: stateFrameName }),
        ...(split.state === null ? {} : { stateLabel: split.state })
      };
      screens.push(stateRef);
      loaded.push({
        ref: stateRef,
        imagePath: stateImagePath,
        knownElements: asFlowElements(state.elements)
      });
    }
    for (const child of children) {
      offset += 1;
      const split = splitStateLabel(child.name, entry.name, style);
      const childRef: ReadingScreenRef = {
        id: child.id,
        name: child.name,
        order: entry.index + offset / 1000,
        imagePath: child.imagePath,
        kind: "state",
        parentScreenId: entry.id,
        ...(child.sourceFrameName === undefined ? {} : { sourceFrameName: child.sourceFrameName }),
        ...(split.state === null ? {} : { stateLabel: split.state })
      };
      screens.push(childRef);
      loaded.push({ ref: childRef, imagePath: child.imagePath, knownElements: child.elements });
    }
  }
  return {
    screens,
    loaded,
    edges: asFlowEdges(doc.edges),
    canvasLayout: detectCanvasLayout(entries.map((entry) => ({ order: entry.index, bounds: entry.bounds })))
  };
}

function imageDataFor(
  loaded: LoadedScreen,
  imageFor: ((screenId: string) => string | null) | undefined
): { dataUrl: string; sha256: string } | null {
  const injected = imageFor?.(loaded.ref.id);
  if (typeof injected === "string" && injected.trim() !== "") {
    return { dataUrl: injected, sha256: sha256Text(injected) };
  }
  if (loaded.imagePath === null) return null;
  try {
    const bytes = fs.readFileSync(loaded.imagePath);
    if (!isPngBuffer(bytes)) return null;
    return {
      dataUrl: `data:image/png;base64,${bytes.toString("base64")}`,
      sha256: sha256Buffer(bytes)
    };
  } catch {
    return null;
  }
}

function isFallbackError(error: unknown): boolean {
  return classifyModalityRejection(error) !== null;
}

function chunkWarning(code: string, message: string, details?: string[]): FlowWarning {
  return { code, message, ...(details === undefined ? {} : { details }) };
}

function readingConcurrencyFromEnv(env: NodeJS.ProcessEnv): number {
  const raw = (env.AOS_READING_CONCURRENCY ?? "").trim();
  const value = raw === "" ? 2 : Number(raw);
  if (!Number.isFinite(value)) return 2;
  return Math.min(4, Math.max(1, Math.trunc(value)));
}

function readingTimeoutFromEnv(env: NodeJS.ProcessEnv): number {
  const raw = (env.AOS_READING_TIMEOUT_MS ?? "").trim();
  const value = raw === "" ? 180_000 : Number(raw);
  if (!Number.isFinite(value)) return 180_000;
  return Math.min(600_000, Math.max(10_000, Math.trunc(value)));
}

async function chatWithTimeout(
  chat: ChatFn,
  messages: ChatMessage[],
  timeoutMs: number
): Promise<string> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      chat(messages, controller.signal),
      new Promise<string>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error(`reading-timeout: ${timeoutMs}ms`));
        }, timeoutMs);
      })
    ]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

async function mapLimit<T, R>(
  entries: T[],
  limit: number,
  fn: (entry: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(entries.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, entries.length)) }, async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= entries.length) return;
      results[index] = await fn(entries[index]!, index);
    }
  });
  await Promise.all(workers);
  return results;
}

function statsFor(
  chunks: ReadingChunk[],
  screens: ReadingScreenRef[],
  truncatedScreens: string[],
  calls: number,
  reused: number
): ReadingStats {
  const base = emptyReadingStats();
  const screenIds = new Set(chunks.flatMap((chunk) => chunk.screenIds));
  return {
    ...base,
    chunksRequested: chunks.length,
    chunksProcessed: chunks.filter((chunk) => chunk.screenIds.length > 0).length,
    chunksReused: reused,
    chunksFailed: chunks.filter((chunk) => chunk.screenIds.length === 0).length,
    calls,
    screens: screens.length,
    screensRead: screenIds.size,
    screensTotal: screens.length,
    droppedScreens: [...new Set(chunks.flatMap((chunk) => chunk.droppedScreens))],
    truncatedScreens
  };
}

export async function runDesignReading(input: {
  runtime: { configDirAbs: string };
  flowsPath: string;
  screensDir?: string;
  options?: ReadingChunkOptions;
  model: string;
  chat?: ChatFn;
  imageFor?: (screenId: string) => string | null;
  reuse?: boolean;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
}): Promise<DesignReadingResult> {
  const empty = emptyReadingStats();
  const now = input.now ?? (() => new Date());
  const paths = readingPaths(input.runtime.configDirAbs);
  const answersLoad = loadReadingAnswers(paths.root);
  try {
    const raw = fs.readFileSync(input.flowsPath, "utf8");
    const doc = JSON.parse(raw) as FlowDoc;
    const readingSource =
      typeof doc.fileKey === "string"
        ? "figma"
        : typeof doc.source === "string" && doc.source.startsWith("pen:")
          ? "pen"
          : "flows";
    const loaded = loadScreens(
      doc,
      input.runtime.configDirAbs,
      input.screensDir,
      input.options?.includeStates === true,
      answersLoad.style
    );
    if (loaded.screens.length === 0) {
      return {
        ok: false,
        status: "skipped",
        reason: "flows.json 没有可读屏幕",
        reading: null,
        artifacts: null,
        warnings: [chunkWarning("reading-no-screens", "flows.json 没有可读屏幕")],
        stats: empty
      };
    }
    const chat = input.chat;
    if (chat === undefined) {
      return {
        ok: false,
        status: "skipped",
        reason: "未提供视觉 ChatFn",
        reading: null,
        artifacts: null,
        warnings: [chunkWarning("vision-required", "阅读需要视觉 ChatFn")],
        stats: empty
      };
    }
    const chunkOptions: ReadingChunkOptions = {
      chunkSize: input.options?.chunkSize,
      overlap: input.options?.overlap,
      maxScreens: input.options?.maxScreens ?? 50,
      edges: loaded.edges,
      elementsByScreen: new Map(loaded.loaded.map((entry) => [entry.ref.id, entry.knownElements]))
    };
    const chunked = chunkReadingScreens(loaded.screens, chunkOptions);
    const elementById = new Map(loaded.loaded.map((entry) => [entry.ref.id, entry]));
    const flowsFingerprint = sha256Text(raw);
    const screensFingerprint = sha256Text(
      JSON.stringify(loaded.loaded.map((entry) => ({ id: entry.ref.id, imagePath: entry.imagePath })))
    );
    let calls = 0;
    let reused = 0;
    const warnings: FlowWarning[] = [...answersLoad.warnings];
    if (
      input.options?.includeStates === true &&
      !loaded.screens.some((screen) => screen.kind === "state")
    ) {
      warnings.push(
        chunkWarning(
          "reading-states-unavailable",
          "readingStates:true 但 flows 中没有可用状态变体（pen states / 画板命名）；已仅读主屏"
        )
      );
    }
    if (chunked.plans.length > 20) {
      warnings.push(
        chunkWarning(
          "reading-budget-large",
          `预计 ${chunked.plans.length} 块（>20），会串行/并发调用多次视觉模型；可用 readingMaxScreens 缩小范围`
        )
      );
    }
    if (chunked.truncatedScreens.length > 0) {
      warnings.push(
        chunkWarning(
          "reading-screens-truncated",
          `readingMaxScreens=${chunkOptions.maxScreens} 截断 ${chunked.truncatedScreens.length} 屏`,
          chunked.truncatedScreens.slice(0, 10)
        )
      );
    }

    const chunks = await mapLimit(
      chunked.plans,
      input.options?.concurrency ?? readingConcurrencyFromEnv(input.env ?? process.env),
      async (plan: ReadingChunkPlan): Promise<ReadingChunk> => {
        const available = plan.screens
          .map((ref) => {
            const loadedScreen = elementById.get(ref.id);
            const image = loadedScreen ? imageDataFor(loadedScreen, input.imageFor) : null;
            return image === null ? null : { ref, image };
          })
          .filter((entry): entry is { ref: ReadingScreenRef; image: { dataUrl: string; sha256: string } } => entry !== null);
        const missingImages = plan.screens.filter(
          (ref) => !available.some((entry) => entry.ref.id === ref.id)
        );
        const maxSize = Math.min(3, available.length);
        const dropped: string[] = missingImages.map((ref) => ref.id);
        let chunkCalls = 0;
        if (available.length === 0) {
          return {
            chunkId: plan.chunkId,
            cacheKey: "",
            plannedScreenIds: plan.screens.map((screen) => screen.id),
            screenIds: [],
            screens: [],
            interactions: [],
            questions: [],
            droppedScreens: dropped,
            unreadScreens: plan.screens.map((screen) => screen.id),
            calls: 0,
            warnings: [chunkWarning("reading-images-missing", `块 ${plan.chunkId} 无可用截图`)]
          };
        }
        for (let size = maxSize; size >= 1; size -= 1) {
          const sent = available.slice(0, size);
          const sentRefs = sent.map((entry) => entry.ref);
          const droppedForAttempt = [
            ...dropped,
            ...available.slice(size).map((entry) => entry.ref.id)
          ];
          const sentIds = new Set(sentRefs.map((ref) => ref.id));
          const sentPlan: ReadingChunkPlan = {
            ...plan,
            screens: sentRefs,
            knownEdges: plan.knownEdges.filter(
              (edge) => sentIds.has(edge.from.id) && (edge.to === null || sentIds.has(edge.to.id))
            ),
            knownElements: plan.knownElements.filter(
              (element) => element.screenId === undefined || sentIds.has(element.screenId)
            )
          };
          const hash = readingChunkHash({
            screenIds: sentRefs.map((ref) => ref.id),
            imageSha256: sent.map((entry) => entry.image.sha256),
            knownEdges: sentPlan.knownEdges,
            options: { chunkSize: input.options?.chunkSize ?? 3, overlap: input.options?.overlap ?? 1 },
            promptVersion: READING_PROMPT_VERSION,
            model: input.model
          });
          const cached =
            input.reuse === false ? null : readCachedChunk(paths.root, hash);
          if (cached !== null) {
            reused += 1;
            return {
              ...cached,
              cacheKey: hash,
              plannedScreenIds: plan.screens.map((screen) => screen.id),
              calls: 0,
              droppedScreens: [...new Set([...cached.droppedScreens, ...droppedForAttempt])],
              unreadScreens: [...new Set([...cached.unreadScreens, ...droppedForAttempt])]
            };
          }
          try {
            chunkCalls += 1;
            calls += 1;
            const content = await chatWithTimeout(
              chat,
              buildReadingMessages({ plan: sentPlan, images: sent.map((entry) => ({ screenId: entry.ref.id, dataUrl: entry.image.dataUrl })) }),
              input.options?.timeoutMs ?? readingTimeoutFromEnv(input.env ?? process.env)
            );
            const parsed = parseReadingReply(content, sentPlan, loaded.screens);
            if (parsed.chunk === null) {
              throw new Error("reading-json-invalid");
            }
            const chunk: ReadingChunk = {
              ...parsed.chunk,
              cacheKey: hash,
              plannedScreenIds: plan.screens.map((screen) => screen.id),
              droppedScreens: [...new Set([...parsed.chunk.droppedScreens, ...droppedForAttempt])],
              unreadScreens: [...new Set([...parsed.chunk.unreadScreens, ...droppedForAttempt])],
              calls: chunkCalls,
              warnings: [...parsed.warnings, ...(droppedForAttempt.length > 0
                ? [chunkWarning("reading-chunk-degraded", `块 ${plan.chunkId} 降级丢尾 ${droppedForAttempt.length} 屏`, droppedForAttempt)]
                : [])]
            };
            const human = writeReadingChunk(paths.root, chunk);
            writeFileAtomic(human.replace(/\.json$/, ".md"), renderChunkMarkdown(chunk));
            return chunk;
          } catch (error) {
            if (size > 1 && isFallbackError(error)) {
              warnings.push(
                chunkWarning(
                  "reading-multi-image-rejected",
                  `块 ${plan.chunkId} 多图被拒，降为 ${size - 1} 屏：${errorMessage(error)}`
                )
              );
              continue;
            }
            return {
              chunkId: plan.chunkId,
              cacheKey: hash,
              plannedScreenIds: plan.screens.map((screen) => screen.id),
              screenIds: [],
              screens: [],
              interactions: [],
              questions: [],
              droppedScreens: [...new Set([...droppedForAttempt, ...sentRefs.map((ref) => ref.id)])],
              unreadScreens: plan.screens.map((screen) => screen.id),
              calls: chunkCalls,
              warnings: [chunkWarning("reading-chunk-failed", `块 ${plan.chunkId} 阅读失败：${errorMessage(error)}`)]
            };
          }
        }
        return {
          chunkId: plan.chunkId,
          cacheKey: "",
          plannedScreenIds: plan.screens.map((screen) => screen.id),
          screenIds: [],
          screens: [],
          interactions: [],
          questions: [],
          droppedScreens: dropped,
          unreadScreens: plan.screens.map((screen) => screen.id),
          calls: chunkCalls,
          warnings: [chunkWarning("reading-chunk-failed", `块 ${plan.chunkId} 无可用结果`)]
        };
      }
    );

    const stats = statsFor(
      chunks,
      loaded.screens,
      chunked.truncatedScreens,
      calls,
      reused
    );
    const reading: ReadingFile = mergeReadingChunks(chunks, {
      screens: loaded.screens,
      knownEdges: loaded.edges,
      source: readingSource,
      orderSource: "flows",
      flowsFingerprint,
      screensFingerprint,
      model: input.model,
      chunkSize: input.options?.chunkSize ?? 3,
      overlap: input.options?.overlap ?? 1,
      generatedAt: now().toISOString(),
      truncatedScreens: chunked.truncatedScreens,
      stats,
      answers: answersLoad.answers,
      namingStyle: answersLoad.style,
      canvasLayout: loaded.canvasLayout
    });
    warnings.push(...reading.warnings);
    if (reading.completeness.screensRead < reading.completeness.screensTotal) {
      warnings.push(
        chunkWarning(
          "reading-incomplete",
          `阅读未覆盖全部屏幕：${reading.completeness.screensRead}/${reading.completeness.screensTotal}`,
          reading.completeness.unreadScreens.slice(0, 10)
        )
      );
    }
    fs.mkdirSync(paths.root, { recursive: true });
    writeFileAtomic(paths.json, JSON.stringify({ ...reading, warnings }, null, 2) + "\n");
    writeFileAtomic(paths.markdown, renderReadingMarkdown({ ...reading, warnings }));
    const complete =
      reading.completeness.screensRead >= reading.completeness.screensTotal &&
      stats.chunksFailed === 0 &&
      reading.completeness.droppedScreens.length === 0 &&
      chunked.truncatedScreens.length === 0;
    return {
      ok: true,
      status: stats.chunksProcessed === 0 ? "skipped" : complete ? "read" : "partial",
      reason: stats.chunksProcessed === 0 ? "所有块阅读失败" : complete ? null : "部分屏幕未读/截断",
      reading,
      artifacts: { json: paths.json, markdown: paths.markdown, chunksDir: paths.chunksDir },
      warnings,
      stats: reading.stats
    };
  } catch (error) {
    return {
      ok: false,
      status: "skipped",
      reason: errorMessage(error),
      reading: null,
      artifacts: null,
      warnings: [chunkWarning("reading-failed", `阅读异常：${errorMessage(error)}`)],
      stats: empty
    };
  }
}
