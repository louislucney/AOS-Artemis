import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  readingChunkHash,
  readingPaths,
  writeReadingChunk
} from "../dist/design/reading/store.js";
import { answerMatchesInteraction, answerMatchesQuestion, loadReadingAnswers } from "../dist/design/reading/answers.js";
import {
  canonicalizeMatch,
  isGenericLabel,
  isStateKeyword,
  normalizeMatchText,
  splitStateLabel,
  stateLabelsOf
} from "../dist/design/reading/naming.js";
import { chunkReadingScreens } from "../dist/design/reading/chunk.js";
import { buildReadingMessages } from "../dist/design/reading/prompt.js";
import { parseReadingReply } from "../dist/design/reading/parse.js";
import { makeTempDir } from "./helpers.js";

function screen(index) {
  return {
    id: `s${index}`,
    name: `Screen ${index}`,
    order: index - 1,
    imagePath: null
  };
}

test("chunk: 7 屏 → [1,2,3] [3,4,5] [5,6,7]", () => {
  const screens = [1, 2, 3, 4, 5, 6, 7].map(screen);
  const { plans, truncated } = chunkReadingScreens(screens, { chunkSize: 3, overlap: 1 });
  assert.equal(truncated, 0);
  assert.deepEqual(
    plans.map((plan) => plan.screens.map((entry) => entry.id)),
    [
      ["s1", "s2", "s3"],
      ["s3", "s4", "s5"],
      ["s5", "s6", "s7"]
    ]
  );
});

test("chunk: maxScreens 截断并返回 truncatedScreens", () => {
  const screens = [1, 2, 3, 4, 5, 6, 7, 8, 9].map(screen);
  const result = chunkReadingScreens(screens, { chunkSize: 3, overlap: 1, maxScreens: 4 });
  assert.equal(result.truncated, 5);
  assert.deepEqual(result.truncatedScreens, ["s5", "s6", "s7", "s8", "s9"]);
  assert.deepEqual(
    [...new Set(result.plans.flatMap((plan) => plan.screens.map((entry) => entry.id)))],
    ["s1", "s2", "s3", "s4"]
  );
});

test("chunk: 6..10 屏的分块数", () => {
  const counts = {};
  for (let n = 6; n <= 10; n += 1) {
    const screens = Array.from({ length: n }, (_, index) => screen(index + 1));
    counts[n] = chunkReadingScreens(screens, { chunkSize: 3, overlap: 1 }).plans.length;
  }
  assert.deepEqual(counts, { 6: 3, 7: 3, 8: 4, 9: 4, 10: 5 });
});

test("store: hash 对图片、模型、edges 敏感且稳定", () => {
  const base = {
    screenIds: ["s1"],
    imageSha256: ["a"],
    knownEdges: [],
    options: { chunkSize: 3, overlap: 1 },
    promptVersion: 1,
    model: "m1"
  };
  assert.equal(readingChunkHash(base), readingChunkHash({ ...base }));
  assert.notEqual(readingChunkHash(base), readingChunkHash({ ...base, imageSha256: ["b"] }));
  assert.notEqual(readingChunkHash(base), readingChunkHash({ ...base, screenIds: ["s2"] }));
  assert.notEqual(readingChunkHash(base), readingChunkHash({ ...base, model: "m2" }));
  assert.notEqual(
    readingChunkHash(base),
    readingChunkHash({
      ...base,
      knownEdges: [
        {
          from: { id: "s1", name: "S1" },
          to: { id: "s2", name: "S2" },
          element: { id: "e", name: "E", type: "T" },
          textHints: [],
          trigger: "ON_CLICK",
          actionType: "NAVIGATE"
        }
      ]
    })
  );
});

test("store: chunk 写盘可读且路径在 design/reading 下", () => {
  const dir = makeTempDir("aos-reading-");
  const paths = readingPaths(dir);
  assert.ok(paths.root.endsWith(path.join("design", "reading")));
  assert.ok(!("cropsDir" in paths), "MVP 不承诺 cropsDir");

  const chunk = {
    chunkId: "chunk-001",
    cacheKey: "hash-1",
    plannedScreenIds: ["s1"],
    screenIds: ["s1"],
    screens: [],
    interactions: [],
    questions: [],
    droppedScreens: [],
    unreadScreens: [],
    calls: 1,
    warnings: []
  };
  const file = writeReadingChunk(paths.root, chunk);
  assert.ok(fs.existsSync(file));
  assert.ok(fs.existsSync(path.join(paths.chunksDir, "hash-1.json")));
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).cacheKey, "hash-1");
});

function planFor(ids) {
  return {
    chunkId: "chunk-001",
    screens: ids.map((id, index) => ({ id, name: `Screen ${id}`, order: index, imagePath: null })),
    boundaryBefore: null,
    boundaryAfter: null,
    knownEdges: [],
    knownElements: []
  };
}

test("prompt: 必含 headerControls/search 清单与三档状态", () => {
  const messages = buildReadingMessages({
    plan: planFor(["s1"]),
    images: [{ screenId: "s1", dataUrl: "data:image/png;base64,AA==" }]
  });
  const text = messages
    .map((message) =>
      typeof message.content === "string"
        ? message.content
        : message.content
            .map((part) => (part.type === "text" ? part.text : ""))
            .join("")
    )
    .join("\n");
  assert.match(text, /headerControls/);
  assert.match(text, /search/);
  assert.match(text, /observed/);
  assert.match(text, /inferred/);
  assert.match(text, /unconfirmed/);
  assert.match(text, /不得省略/);
});

test("parse: 缺 headerControls 的屏幕整屏丢弃并 warning", () => {
  const parsed = parseReadingReply(
    JSON.stringify({ screens: [{ screenId: "s1", name: "S1" }] }),
    planFor(["s1"])
  );
  assert.equal(parsed.chunk?.screens.length, 0);
  assert.ok(parsed.warnings.some((warning) => warning.code === "reading-screen-invalid"));
});

test("parse: 空 headerControls 合法；chrome 标签出 warning", () => {
  const reply = {
    screens: [
      {
        screenId: "s1",
        name: "S1",
        observed: {
          title: "Flow/Header",
          headerControls: [],
          persistentNav: { sideNav: [], bottomTabs: [], activeTab: null },
          contentGroups: [],
          floatingActions: [],
          annotations: []
        },
        states: [],
        inferredInteractions: []
      }
    ]
  };
  const parsed = parseReadingReply(JSON.stringify(reply), planFor(["s1"]));
  assert.equal(parsed.chunk.screens.length, 1, "空数组合法");
  assert.ok(parsed.warnings.some((warning) => warning.code === "chrome-suspect"));
});

test("parse: 搜索按钮保留为 search；unconfirmed 自动补 question", () => {
  const reply = {
    screens: [
      {
        screenId: "s1",
        name: "行動預點",
        observed: {
          title: "推薦",
          headerControls: [
            { kind: "search", label: null, bbox: { x: 0.8, y: 0.1, width: 0.1, height: 0.1 } }
          ],
          persistentNav: {
            sideNav: ["飲料"],
            bottomTabs: ["首頁", "行動預點"],
            activeTab: "行動預點"
          },
          contentGroups: [{ label: "推薦", items: ["冰蘋果山茶花風味美式"] }],
          floatingActions: [],
          annotations: []
        },
        states: [],
        inferredInteractions: [
          {
            element: "search",
            action: "tap",
            to: "product-search",
            basis: "icon+position",
            status: "inferred",
            confidence: 0.9,
            why: "顶部放大镜"
          }
        ]
      }
    ],
    crossScreenLinks: [
      {
        fromScreenId: "s1",
        fromElement: "產品搜尋",
        toScreenId: null,
        toLabel: "產品搜尋",
        status: "unconfirmed",
        basis: "annotation-line",
        why: "线起点不明"
      }
    ],
    questions: []
  };
  const parsed = parseReadingReply(JSON.stringify(reply), planFor(["s1"]));
  assert.equal(parsed.chunk.screens[0].headerControls[0].kind, "search");
  assert.ok(parsed.chunk.questions.some((question) => question.question.includes("產品搜尋")));
  const searchEdge = parsed.chunk.interactions.find((edge) => edge.fromElement === "search");
  assert.equal(searchEdge.toScreenId, null);
  assert.equal(searchEdge.status, "unconfirmed");
  assert.ok(parsed.chunk.questions.some((question) => question.element === "search"));
});

import { ChatError } from "../dist/llm/chat.js";
import { mergeReadingChunks } from "../dist/design/reading/merge.js";
import { renderReadingMarkdown } from "../dist/design/reading/render.js";
import { runDesignReading } from "../dist/design/reading/run.js";

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lK3Q6wAAAABJRU5ErkJggg==";

function observation(id, overrides = {}) {
  return {
    screenId: id,
    name: `Screen ${id}`,
    title: `Title ${id}`,
    headerControls: [
      { kind: "search", label: null, bbox: { x: 0.8, y: 0.1, width: 0.1, height: 0.1 }, confidence: 0.9 }
    ],
    persistentNav: { sideNav: [], bottomTabs: ["首頁"], activeTab: "首頁" },
    contentGroups: [],
    floatingActions: [],
    annotations: [],
    ...overrides
  };
}

function chunkOf(id, screenIds, overrides = {}) {
  return {
    chunkId: id,
    cacheKey: id,
    plannedScreenIds: screenIds,
    screenIds,
    screens: screenIds.map((screenId) => observation(screenId)),
    interactions: [],
    questions: [],
    droppedScreens: [],
    unreadScreens: [],
    calls: 1,
    warnings: [],
    ...overrides
  };
}

function metadata(screens) {
  return {
    screens,
    knownEdges: [],
    source: "flows.json",
    model: "m",
    chunkSize: 3,
    overlap: 1,
    generatedAt: "2026-10-26T00:00:00.000Z"
  };
}

test("merge: 同屏冲突保留两份 + question；observed 不被 inferred 覆盖", () => {
  const screens = [
    { id: "s1", name: "S1", order: 0, imagePath: null },
    { id: "s2", name: "S2", order: 1, imagePath: null }
  ];
  const chunks = [
    chunkOf("chunk-001", ["s1", "s2"], {
      screens: [
        observation("s1", { headerControls: [{ kind: "search", label: null, bbox: { x: 0.8, y: 0.1, width: 0.1, height: 0.1 }, confidence: 0.9 }] }),
        observation("s2")
      ],
      interactions: [
        { id: "e1", fromScreenId: "s1", fromElement: "search", action: "tap", toScreenId: "s2", toLabel: null, status: "observed", basis: "line", confidence: 1, why: null }
      ]
    }),
    chunkOf("chunk-002", ["s1", "s2"], {
      screens: [
        observation("s1", { headerControls: [{ kind: "search", label: null, bbox: { x: 0.7, y: 0.1, width: 0.1, height: 0.1 }, confidence: 0.8 }] }),
        observation("s2")
      ],
      interactions: [
        { id: "e2", fromScreenId: "s1", fromElement: "search", action: "tap", toScreenId: "s2", toLabel: null, status: "inferred", basis: "layout", confidence: 0.5, why: null }
      ]
    })
  ];
  const reading = mergeReadingChunks(chunks, metadata(screens));
  assert.equal(reading.completeness.overlapConflicts, 1);
  assert.ok(reading.questions.some((question) => question.question.includes("同一屏")));
  assert.equal(reading.interactions.find((edge) => edge.fromElement === "search").status, "observed");
});

test("merge: 端点/overlap/搜索旁注进入 question 与 spine provenance", () => {
  const screens = [
    { id: "s1", name: "行動預點", order: 0, imagePath: null },
    { id: "s2", name: "產品搜尋", order: 1, imagePath: null }
  ];
  const chunks = [
    chunkOf("chunk-001", ["s1", "s2"], {
      screens: [
        observation("s1", {
          name: "行動預點",
          title: "推薦",
          headerControls: [],
          annotations: [{ text: "產品搜尋", source: "annotation-line", target: null, bbox: null }]
        }),
        observation("s2", { name: "產品搜尋", title: "產品搜尋" })
      ],
      interactions: [
        { id: "bad", fromScreenId: "s1", fromElement: "search", action: "tap", toScreenId: "ghost", toLabel: null, status: "observed", basis: "line", confidence: 1, why: null },
        { id: "good", fromScreenId: "s1", fromElement: "search", action: "tap", toScreenId: "s2", toLabel: null, status: "inferred", basis: "layout", confidence: 0.5, why: null }
      ]
    })
  ];
  const reading = mergeReadingChunks(chunks, metadata(screens));
  const bad = reading.interactions.find((edge) => edge.id === "bad");
  assert.equal(bad.status, "unconfirmed");
  assert.equal(bad.toScreenId, null);
  assert.ok(reading.questions.some((question) => question.question.includes("ghost")));
  assert.ok(reading.questions.some((question) => question.question.includes("搜索入口")));
  assert.ok(reading.spine.edgeIds.length > 0);
  assert.equal(reading.spine.status, "unconfirmed", "屏数 <3 时主线只能是假设");
  assert.equal(typeof reading.spine.statusSummary.inferred, "number");
});

test("render: markdown 含主线/完整性/问题并转义模型文本", () => {
  const screens = [{ id: "s1", name: "S1", order: 0, imagePath: null }];
  const reading = mergeReadingChunks([chunkOf("chunk-001", ["s1"])], metadata(screens));
  reading.questions.push({ id: "q", screenId: "s1", screenName: "S1", element: null, question: "a | b\nc", why: "x" });
  reading.answers = [{ id: "a1", match: { screenId: "s1" }, answer: "custom | answer" }];
  const markdown = renderReadingMarkdown(reading);
  assert.match(markdown, /CR 主线/);
  assert.match(markdown, /完整性/);
  assert.match(markdown, /问题/);
  assert.match(markdown, /人工答案/);
  assert.match(markdown, /custom \\\| answer/);
  assert.match(markdown, /a \\\| b c/);
});

function flowDoc(count) {
  return {
    screens: Array.from({ length: count }, (_, index) => ({
      id: `s${index + 1}`,
      name: `Screen ${index + 1}`,
      elements: []
    })),
    edges: [],
    screenshots: { dir: "screens/test" }
  };
}

function replyFor(ids) {
  return JSON.stringify({
    screens: ids.map((id) => ({
      screenId: id,
      name: `Screen ${id}`,
      observed: {
        title: `Title ${id}`,
        headerControls: [],
        persistentNav: { sideNav: [], bottomTabs: [], activeTab: null },
        contentGroups: [],
        floatingActions: [],
        annotations: []
      },
      states: [],
      inferredInteractions: []
    })),
    crossScreenLinks: [],
    questions: []
  });
}

function writeFlows(dir, count) {
  const file = path.join(dir, "flows.json");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(flowDoc(count)));
  return file;
}

test("run: 8 屏 fake chat → 4 块；第 2 块失败仍 partial", async () => {
  const dir = makeTempDir("aos-reading-run-");
  const flowsPath = writeFlows(dir, 8);
  let calls = 0;
  const chat = async (messages) => {
    calls += 1;
    if (calls === 2) throw new ChatError("provider failed", { status: 500 });
    const text = messages
      .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join(" ");
    const ids = ["s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8"].filter((id) => text.includes(`id=${id}`));
    return replyFor(ids);
  };
  const result = await runDesignReading({
    runtime: { configDirAbs: dir },
    flowsPath,
    model: "m",
    chat,
    imageFor: () => PNG,
    options: { concurrency: 1 }
  });
  assert.equal(result.status, "partial");
  assert.equal(result.stats.chunksRequested, 4);
  assert.equal(result.stats.chunksFailed, 1);
  assert.equal(result.stats.calls, 4);
  assert.ok(fs.existsSync(result.artifacts.json));
  assert.ok(fs.existsSync(result.artifacts.markdown));
  assert.ok(fs.existsSync(path.join(result.artifacts.chunksDir, "chunk-001.md")));
  assert.equal(typeof result.reading.flowsFingerprint, "string");
  assert.equal(typeof result.reading.screensFingerprint, "string");
  assert.ok(result.reading.completeness.screensRead < 8);
});

test("run: 多图被拒 → 丢尾 2 屏成功；缓存键用实际 image 集", async () => {
  const dir = makeTempDir("aos-reading-fallback-");
  const flowsPath = writeFlows(dir, 3);
  let calls = 0;
  const chat = async (messages) => {
    calls += 1;
    if (calls === 1) throw new ChatError("model does not support image input", { status: 400 });
    const text = messages
      .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join(" ");
    const ids = ["s1", "s2", "s3"].filter((id) => text.includes(`id=${id}`));
    return replyFor(ids);
  };
  const result = await runDesignReading({
    runtime: { configDirAbs: dir },
    flowsPath,
    model: "m",
    chat,
    imageFor: () => PNG,
    options: { concurrency: 1 }
  });
  assert.equal(result.status, "partial");
  assert.equal(result.stats.calls, 2);
  assert.deepEqual(result.stats.droppedScreens, ["s3"]);
  assert.ok(result.stats.screensRead >= 2);
});

test("run: 42 屏 → reading-budget-large warning；maxScreens 截断", async () => {
  const dir = makeTempDir("aos-reading-budget-");
  const flowsPath = writeFlows(dir, 42);
  const chat = async (messages) => {
    const text = messages
      .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join(" ");
    const ids = Array.from({ length: 42 }, (_, index) => `s${index + 1}`).filter((id) =>
      text.includes(`id=${id}`)
    );
    return replyFor(ids);
  };
  const full = await runDesignReading({
    runtime: { configDirAbs: dir },
    flowsPath,
    model: "m",
    chat,
    imageFor: () => PNG,
    options: { concurrency: 4 }
  });
  assert.ok(full.warnings.some((warning) => warning.code === "reading-budget-large"));

  const limited = await runDesignReading({
    runtime: { configDirAbs: dir },
    flowsPath,
    model: "m",
    chat,
    imageFor: () => PNG,
    options: { concurrency: 4, maxScreens: 10 }
  });
  assert.deepEqual(
    limited.stats.truncatedScreens,
    Array.from({ length: 32 }, (_, index) => `s${index + 11}`)
  );
  assert.equal(limited.stats.screensTotal, 42);
});

test("run: 缓存命中 → 二次调用 0 次模型，chunksReused > 0；名称按当前 refs 重解析", async () => {
  const dir = makeTempDir("aos-reading-cache-");
  const flowsPath = writeFlows(dir, 3);
  let calls = 0;
  const chat = async () => {
    calls += 1;
    return replyFor(["s1", "s2", "s3"]);
  };
  const first = await runDesignReading({
    runtime: { configDirAbs: dir }, flowsPath, model: "m", chat, imageFor: () => PNG
  });
  assert.equal(calls, 1);
  assert.equal(first.status, "read");

  // 改 flows 里的显示名，但屏幕/图片/参数不变：缓存应命中并重解析名称。
  const doc = flowDoc(3);
  doc.screens[0].name = "Renamed S1";
  fs.writeFileSync(flowsPath, JSON.stringify(doc));
  const second = await runDesignReading({
    runtime: { configDirAbs: dir }, flowsPath, model: "m", chat, imageFor: () => PNG
  });
  assert.equal(calls, 1, "缓存命中后不再调用模型");
  assert.ok(second.stats.chunksReused > 0);
  assert.equal(second.reading.screens.find((screen) => screen.screenId === "s1").name, "Renamed S1");
});

test("run: 降级后 plannedScreenIds 仍是原计划，screenIds 是实际读到", async () => {
  const dir = makeTempDir("aos-reading-planned-");
  const flowsPath = writeFlows(dir, 3);
  let calls = 0;
  const chat = async (messages) => {
    calls += 1;
    if (calls === 1) throw new ChatError("model does not support image input", { status: 400 });
    const text = messages
      .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join(" ");
    const ids = ["s1", "s2", "s3"].filter((id) => text.includes(`id=${id}`));
    return replyFor(ids);
  };
  const result = await runDesignReading({
    runtime: { configDirAbs: dir },
    flowsPath,
    model: "m",
    chat,
    imageFor: () => PNG,
    options: { concurrency: 1 }
  });
  const chunk = JSON.parse(fs.readFileSync(path.join(result.artifacts.chunksDir, "chunk-001.json"), "utf8"));
  assert.deepEqual(chunk.plannedScreenIds, ["s1", "s2", "s3"]);
  assert.deepEqual(chunk.screenIds, ["s1", "s2"]);
  assert.deepEqual(chunk.droppedScreens, ["s3"]);
});

test("merge: 段内 questions 不丢，按稳定 key 去重", () => {
  const screens = [{ id: "s1", name: "S1", order: 0, imagePath: null }, { id: "s2", name: "S2", order: 1, imagePath: null }];
  const chunks = [
    chunkOf("chunk-001", ["s1", "s2"], {
      questions: [{ id: "model-1", screenId: "s1", screenName: "S1", element: "search", question: "搜索去哪？", why: "x" }]
    }),
    chunkOf("chunk-002", ["s1", "s2"], {
      questions: [{ id: "model-2", screenId: "s1", screenName: "S1", element: "search", question: "搜索去哪？", why: "x" }]
    })
  ];
  const reading = mergeReadingChunks(chunks, metadata(screens));
  assert.equal(reading.questions.filter((q) => q.question === "搜索去哪？").length, 1);
});

test("merge: 稠密 20 屏主线有搜索预算，不阻塞", () => {
  const screens = Array.from({ length: 20 }, (_, index) => ({ id: `s${index + 1}`, name: `S${index + 1}`, order: index, imagePath: null }));
  const interactions = [];
  for (let i = 1; i <= 20; i += 1) {
    for (let j = 1; j <= 20; j += 1) {
      if (i === j) continue;
      interactions.push({
        id: `e-${i}-${j}`, fromScreenId: `s${i}`, fromElement: `to-${j}`, action: "tap",
        toScreenId: `s${j}`, toLabel: null, status: "inferred", basis: "dense", confidence: 0.5, why: null
      });
    }
  }
  const chunk = chunkOf("chunk-001", screens.map((screen) => screen.id), {
    screens: screens.map((screen) => observation(screen.id)),
    interactions
  });
  const started = Date.now();
  const reading = mergeReadingChunks([chunk], metadata(screens));
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 1000, `merge took ${elapsed}ms`);
  assert.ok(reading.spine.basis.includes("bounded-search"));
});

test("merge: 同源不同目标出 question；inferred 可升级 unconfirmed", () => {
  const screens = [
    { id: "s1", name: "S1", order: 0, imagePath: null },
    { id: "s2", name: "S2", order: 1, imagePath: null },
    { id: "s3", name: "S3", order: 2, imagePath: null }
  ];
  const base = { fromScreenId: "s1", fromElement: "search", action: "tap", toLabel: null, basis: "x", confidence: null, why: null };
  const chunk = chunkOf("chunk-001", ["s1", "s2", "s3"], {
    screens: [observation("s1"), observation("s2"), observation("s3")],
    interactions: [
      { ...base, id: "a", toScreenId: "s2", status: "observed" },
      { ...base, id: "b", toScreenId: "s3", status: "observed" },
      { ...base, id: "c", toScreenId: "s2", status: "unconfirmed" },
      { ...base, id: "d", toScreenId: "s2", status: "inferred" }
    ]
  });
  const reading = mergeReadingChunks([chunk], metadata(screens));
  assert.ok(reading.questions.some((q) => q.question.includes("两个目标")));
  assert.equal(
    reading.interactions.filter((edge) => edge.toScreenId === "s2").every((edge) => edge.status === "observed"),
    true
  );
});

test("chunk: knownElements 按屏幕携带 screenId（供降级重过滤）", () => {
  const screens = [1, 2, 3].map(screen);
  const result = chunkReadingScreens(screens, {
    chunkSize: 3,
    overlap: 1,
    elementsByScreen: new Map([
      ["s1", [{ id: "vision-s1-1", class: "search-entry", intent: "navigate", label: "搜索", provenance: "vision-inferred" }]]
    ])
  });
  assert.equal(result.plans[0].knownElements[0].screenId, "s1");
});

test("run: 从 flows.screenshots.dir 读取真实 PNG（不走 imageFor）", async () => {
  const dir = makeTempDir("aos-reading-path-");
  const flowsPath = writeFlows(dir, 1);
  const imageDir = path.join(dir, "design", "screens", "test");
  fs.mkdirSync(imageDir, { recursive: true });
  const bytes = Buffer.from(PNG.split(",")[1], "base64");
  fs.writeFileSync(path.join(imageDir, "s1.png"), bytes);
  const result = await runDesignReading({
    runtime: { configDirAbs: dir },
    flowsPath,
    model: "m",
    chat: async () => replyFor(["s1"])
  });
  assert.equal(result.status, "read");
  assert.equal(result.stats.screensRead, 1);
});

test("parse: 缺 bbox 的控件保留（仅失去几何）；目标按屏幕名解析", () => {
  const plan = planFor(["s1"]);
  const reply = {
    screens: [
      {
        screenId: "s1",
        name: "S1",
        observed: {
          title: "推薦",
          headerControls: [{ kind: "search", label: null }],
          persistentNav: { sideNav: [], bottomTabs: [], activeTab: null },
          contentGroups: [],
          floatingActions: [],
          annotations: []
        },
        states: [],
        inferredInteractions: [
          { element: "search", action: "tap", to: "產品搜尋", status: "inferred", basis: "icon", confidence: 0.8 }
        ]
      }
    ]
  };
  const parsed = parseReadingReply(JSON.stringify(reply), plan, [
    { id: "s1", name: "S1", order: 0, imagePath: null },
    { id: "s2", name: "產品搜尋", order: 1, imagePath: null }
  ]);
  assert.equal(parsed.chunk.screens[0].headerControls.length, 1);
  assert.equal(parsed.chunk.screens[0].headerControls[0].bbox, null);
  assert.ok(parsed.warnings.some((warning) => warning.code === "reading-control-bbox-missing"));
  assert.equal(parsed.chunk.interactions[0].toScreenId, "s2");
  assert.equal(parsed.chunk.interactions[0].status, "inferred");
});

test("merge: questions 只保留前 20 条（标注线优先），其余计数", () => {
  const screens = [{ id: "s1", name: "S1", order: 0, imagePath: null }];
  const questions = Array.from({ length: 25 }, (_, index) => ({
    id: `q-${index}`,
    screenId: "s1",
    screenName: "S1",
    element: index === 0 ? "search" : `control-${index}`,
    question: `问题 ${index}`,
    why: index === 0 ? "annotation line 线起点不明" : "普通未决"
  }));
  const reading = mergeReadingChunks([chunkOf("chunk-001", ["s1"], { questions })], metadata(screens));
  assert.equal(reading.questions.length, 20);
  assert.equal(reading.completeness.questionsTotal, 25);
  assert.equal(reading.completeness.questionsOmitted, 5);
  assert.match(reading.questions[0].why, /annotation/);
});

test("merge: knownEdges 按 provenance 映射，不把 inferred 当 observed", () => {
  const screens = [
    { id: "s1", name: "S1", order: 0, imagePath: null },
    { id: "s2", name: "S2", order: 1, imagePath: null }
  ];
  const edge = (provenance) => ({
    from: { id: "s1", name: "S1" },
    to: { id: "s2", name: "S2" },
    element: { id: `e-${provenance}`, name: `E-${provenance}`, type: "T" },
    textHints: [],
    trigger: "ON_CLICK",
    actionType: "NAVIGATE",
    provenance
  });
  const input = { ...metadata(screens), knownEdges: [edge("inferred"), edge("explicit")] };
  const reading = mergeReadingChunks([chunkOf("chunk-001", ["s1", "s2"])], input);
  assert.deepEqual(
    new Set(reading.interactions.map((entry) => entry.status)),
    new Set(["inferred", "observed"])
  );
});

test("parse: 目标包含屏幕名时解析；非关键控件无目标不刷问题", () => {
  const plan = planFor(["s1"]);
  const known = [
    { id: "s1", name: "行動預點", order: 0, imagePath: null },
    { id: "s2", name: "產品搜尋", order: 1, imagePath: null }
  ];
  const reply = {
    screens: [
      {
        screenId: "s1",
        name: "行動預點",
        observed: {
          title: "推薦",
          headerControls: [],
          persistentNav: { sideNav: [], bottomTabs: [], activeTab: null },
          contentGroups: [],
          floatingActions: [],
          annotations: []
        },
        states: [],
        inferredInteractions: [
          { element: "搜尋（右上角圓形放大鏡）", action: "tap", to: "產品搜尋（名稱來自畫板描述）", status: "unconfirmed", basis: "icon", confidence: 0.5 },
          { element: "商品「+」按鈕", action: "tap", to: null, status: "unconfirmed", basis: "no-result", confidence: 0.2 }
        ]
      }
    ]
  };
  const parsed = parseReadingReply(JSON.stringify(reply), plan, known);
  assert.equal(parsed.chunk.interactions.find((edge) => edge.fromElement.includes("搜尋")).toScreenId, "s2");
  assert.equal(parsed.chunk.questions.filter((q) => q.element === "商品「+」按鈕").length, 0);
  assert.ok(parsed.chunk.questions.some((q) => q.element?.includes("搜尋")));
});

test("merge: 缓存问题过滤（非关键 target 问题丢弃）与 toLabel 全局屏幕名解析", () => {
  const screens = [
    { id: "s1", name: "行動預點", order: 0, imagePath: null },
    { id: "s2", name: "產品搜尋", order: 1, imagePath: null }
  ];
  const chunk = chunkOf("chunk-001", ["s1", "s2"], {
    screens: [observation("s1"), observation("s2")],
    interactions: [
      { id: "resolve", fromScreenId: "s1", fromElement: "搜尋（右上角圓形放大鏡）", action: "tap", toScreenId: null, toLabel: "產品搜尋（名稱來自畫板描述）", status: "unconfirmed", basis: "icon", confidence: 0.4, why: null }
    ],
    questions: [
      { id: "generic", screenId: "s1", screenName: "行動預點", element: "商品「+」按鈕", question: "「商品「+」按鈕」的目标页面/状态是什么？", why: "x" },
      { id: "key", screenId: "s1", screenName: "行動預點", element: "搜尋（右上角圓形放大鏡）", question: "「搜尋」的目标页面/状态是什么？", why: "x" }
    ]
  });
  const reading = mergeReadingChunks([chunk], metadata(screens));
  assert.equal(reading.interactions.find((edge) => edge.id === "resolve").toScreenId, "s2");
  assert.ok(!reading.questions.some((q) => q.id === "generic"));
  assert.ok(reading.questions.some((q) => q.id === "key"));
});

test("answers: 命中问题后抑制，并把交互标为人工确认", () => {
  const screens = [
    { id: "BO0bP", name: "確認訂單", order: 0, imagePath: null },
    { id: "AhE2Z", name: "訂單狀態", order: 1, imagePath: null }
  ];
  const chunk = chunkOf("chunk-001", ["BO0bP", "AhE2Z"], {
    screens: [observation("BO0bP", { name: "確認訂單" }), observation("AhE2Z", { name: "訂單狀態" })],
    interactions: [
      { id: "checkout", fromScreenId: "BO0bP", fromElement: "確認結帳 $289", action: "tap", toScreenId: null, toLabel: null, status: "unconfirmed", basis: "layout", confidence: 0.3, why: null }
    ],
    questions: [
      { id: "q-checkout", screenId: "BO0bP", screenName: "確認訂單", element: null, question: "「確認結帳 $289」點擊後是否進入 AhE2Z 訂單狀態？", why: "x" }
    ]
  });
  const answers = [
    {
      id: "checkout",
      match: { screenId: "BO0bP", elementIncludes: "確認結帳" },
      answer: "沿用既有结帐逻辑，完成后进入订单详情",
      resolution: { toScreenId: "AhE2Z", action: "tap" }
    }
  ];
  const reading = mergeReadingChunks([chunk], { ...metadata(screens), answers });
  assert.equal(reading.questions.some((q) => q.id === "q-checkout"), false);
  assert.equal(reading.completeness.questionsAnswered, 1);
  const edge = reading.interactions.find((entry) => entry.id === "checkout");
  assert.equal(edge.toScreenId, "AhE2Z");
  assert.equal(edge.status, "observed");
  assert.match(edge.basis, /human-answer/);
});

test("answers: self 目标用于页内切换/底部弹层", () => {
  const screens = [{ id: "nR4HH", name: "取餐方法", order: 0, imagePath: null }];
  const chunk = chunkOf("chunk-001", ["nR4HH"], {
    interactions: [
      { id: "tab", fromScreenId: "nR4HH", fromElement: "取餐方式 tab", action: "tap", toScreenId: null, toLabel: null, status: "unconfirmed", basis: "layout", confidence: 0.2, why: null }
    ]
  });
  const answers = [
    {
      id: "pickup-tab",
      match: { screenId: "nR4HH", elementIncludes: "取餐方式 tab" },
      answer: "页内切换取餐方式，不跳页",
      resolution: { toScreenId: "self", action: "switch", toLabel: "state:pickup-method" }
    }
  ];
  const reading = mergeReadingChunks([chunk], { ...metadata(screens), answers });
  const edge = reading.interactions.find((entry) => entry.id === "tab");
  assert.equal(edge.toScreenId, "nR4HH");
  assert.equal(edge.action, "switch");
  assert.equal(edge.toLabel, "state:pickup-method");
});

test("merge: 同源交互保留目标冲突，重复 id 自动加后缀", () => {
  const screens = [
    { id: "s1", name: "S1", order: 0, imagePath: null },
    { id: "s2", name: "S2", order: 1, imagePath: null }
  ];
  const chunk = chunkOf("chunk-001", ["s1", "s2"], {
    interactions: [
      { id: "dup", fromScreenId: "s1", fromElement: "搜尋", action: "tap", toScreenId: null, toLabel: null, status: "unconfirmed", basis: "icon", confidence: 0.6, why: null },
      { id: "dup", fromScreenId: "s1", fromElement: "搜尋", action: "tap", toScreenId: "s2", toLabel: null, status: "inferred", basis: "resolved-target", confidence: null, why: null }
    ]
  });
  const reading = mergeReadingChunks([chunk], metadata(screens));
  assert.equal(new Set(reading.interactions.map((edge) => edge.id)).size, reading.interactions.length);
  assert.deepEqual(
    new Set(reading.interactions.map((edge) => edge.toScreenId)),
    new Set([null, "s2"])
  );
});

test("answers: 空 match 不命中任何交互", () => {
  const edge = {
    id: "e",
    fromScreenId: "s1",
    fromElement: "搜尋",
    action: "tap",
    toScreenId: null,
    toLabel: null,
    status: "unconfirmed",
    basis: "icon",
    confidence: 0.5,
    why: null
  };
  assert.equal(
    answerMatchesInteraction({ id: "empty", match: {}, answer: "x" }, edge),
    false
  );
});

test("merge: 画板顺序 knownEdge 标 canvas-order", () => {
  const screens = [
    { id: "s1", name: "S1", order: 0, imagePath: null },
    { id: "s2", name: "S2", order: 1, imagePath: null }
  ];
  const reading = mergeReadingChunks([chunkOf("chunk-001", ["s1", "s2"])], {
    ...metadata(screens),
    knownEdges: [
      {
        from: { id: "s1", name: "S1" },
        to: { id: "s2", name: "S2" },
        element: { id: "e", name: "推断跳转（按画板排布）", type: "T" },
        textHints: [],
        trigger: "ON_CLICK",
        actionType: "NAVIGATE",
        provenance: "inferred"
      }
    ]
  });
  assert.equal(reading.interactions[0].basis, "canvas-order");
  assert.equal(reading.interactions[0].confidence, 0.3);
});

test("parse: 读取画板标签与状态，不混入 title", () => {
  const reply = {
    screens: [
      {
        screenId: "s1",
        name: "行動預點",
        boardLabel: "行動預點-下滑",
        stateLabel: "下滑",
        observed: {
          title: null,
          headerControls: [],
          persistentNav: { sideNav: [], bottomTabs: [], activeTab: null },
          contentGroups: [],
          floatingActions: [],
          annotations: []
        },
        states: [],
        inferredInteractions: []
      }
    ]
  };
  const parsed = parseReadingReply(JSON.stringify(reply), planFor(["s1"]));
  assert.equal(parsed.chunk.screens[0].boardLabel, "行動預點-下滑");
  assert.equal(parsed.chunk.screens[0].stateLabel, "下滑");
  assert.equal(parsed.chunk.screens[0].title, null);
});

test("prompt: 要求记录画板标签/状态且不混入 headerControls", () => {
  const messages = buildReadingMessages({
    plan: planFor(["s1"]),
    images: [{ screenId: "s1", dataUrl: "data:image/png;base64,AA==" }]
  });
  const text = messages
    .map((message) =>
      typeof message.content === "string"
        ? message.content
        : message.content
            .map((part) => (part.type === "text" ? part.text : ""))
            .join("")
    )
    .join("\n");
  assert.match(text, /boardLabel/);
  assert.match(text, /stateLabel/);
  assert.match(text, /手机外框上方|畫板標籤|画板标签/);
});

test("merge: 相邻块补齐缺失的画板标签/状态，不算结构冲突", () => {
  const screens = [{ id: "s1", name: "行動預點", order: 0, imagePath: null }];
  const chunks = [
    chunkOf("chunk-001", ["s1"], {
      screens: [observation("s1", { boardLabel: null, stateLabel: null })]
    }),
    chunkOf("chunk-002", ["s1"], {
      screens: [observation("s1", { boardLabel: "行動預點-下滑", stateLabel: "下滑" })]
    })
  ];
  const reading = mergeReadingChunks(chunks, metadata(screens));
  assert.equal(reading.screens[0].boardLabel, "行動預點-下滑");
  assert.equal(reading.screens[0].stateLabel, "下滑");
  assert.equal(reading.completeness.overlapConflicts, 0);
});

test("render: 屏幕段落显示画板标签与状态", () => {
  const screens = [{ id: "s1", name: "行動預點", order: 0, imagePath: null }];
  const reading = mergeReadingChunks(
    [
      chunkOf("chunk-001", ["s1"], {
        screens: [observation("s1", { boardLabel: "行動預點-下滑", stateLabel: "下滑" })]
      })
    ],
    metadata(screens)
  );
  const markdown = renderReadingMarkdown(reading);
  assert.match(markdown, /画板: 行動預點-下滑/);
  assert.match(markdown, /状态: 下滑/);
});

test("merge: flows states 标签进入 knownStates", () => {
  const screens = [
    {
      id: "s1",
      name: "行動預點",
      order: 0,
      imagePath: null,
      states: ["行動預點-下滑", "行動預點-內用點餐"]
    }
  ];
  const reading = mergeReadingChunks([chunkOf("chunk-001", ["s1"])], metadata(screens));
  assert.deepEqual(reading.screens[0].knownStates, [
    "行動預點-下滑",
    "行動預點-內用點餐"
  ]);
});

test("render: 屏幕段落显示已知状态标签", () => {
  const screens = [
    {
      id: "s1",
      name: "行動預點",
      order: 0,
      imagePath: null,
      states: ["行動預點-下滑"]
    }
  ];
  const reading = mergeReadingChunks([chunkOf("chunk-001", ["s1"])], metadata(screens));
  const markdown = renderReadingMarkdown(reading);
  assert.match(markdown, /已知状态: 行動預點-下滑/);
});

test("run: flows states 只做元数据，不增加读图块", async () => {
  const dir = makeTempDir("aos-reading-states-");
  const flowsPath = writeFlows(dir, 3);
  const doc = flowDoc(3);
  doc.screens[0].states = [{ id: "st1", label: "Screen 1-下滑" }];
  fs.writeFileSync(flowsPath, JSON.stringify(doc));
  let calls = 0;
  const chat = async () => {
    calls += 1;
    return replyFor(["s1", "s2", "s3"]);
  };
  const result = await runDesignReading({
    runtime: { configDirAbs: dir },
    flowsPath,
    model: "m",
    chat,
    imageFor: () => PNG,
    options: { concurrency: 1 }
  });
  assert.equal(calls, 1);
  assert.equal(result.stats.screensTotal, 3);
  assert.deepEqual(
    result.reading.screens.find((screen) => screen.screenId === "s1").knownStates,
    ["Screen 1-下滑"]
  );
});

test("run: includeStates 读取状态变体，标注 parent 且不进入 CR 主线", async () => {
  const dir = makeTempDir("aos-reading-include-states-");
  const flowsPath = writeFlows(dir, 3);
  const doc = flowDoc(3);
  doc.screens[0].states = [{ id: "st1", label: "Screen 1-下滑", elements: [] }];
  fs.writeFileSync(flowsPath, JSON.stringify(doc));
  const chat = async (messages) => {
    const text = messages
      .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join(" ");
    const ids = ["s1", "s2", "s3", "st1"].filter((id) => text.includes(`id=${id}`));
    return replyFor(ids);
  };
  const result = await runDesignReading({
    runtime: { configDirAbs: dir },
    flowsPath,
    model: "m",
    chat,
    imageFor: () => PNG,
    options: { concurrency: 1, includeStates: true }
  });
  assert.equal(result.stats.screensTotal, 4);
  const state = result.reading.screens.find((screen) => screen.screenId === "st1");
  assert.equal(state.kind, "state");
  assert.equal(state.parentScreenId, "s1");
  assert.equal(result.reading.spine.screenIds.includes("st1"), false);
  assert.match(renderReadingMarkdown(result.reading), /状态变体/);
  assert.match(renderReadingMarkdown(result.reading), /父屏: `s1`/);
});


test("naming: 状态标签支持多分隔符/多语言，拆不出保留完整 label", () => {
  assert.equal(splitStateLabel("行動預點 / 下滑", "行動預點").state, "下滑");
  assert.equal(splitStateLabel("行動預點（空态）", "行動預點").state, "空态");
  assert.equal(splitStateLabel("行動預點_Scrolled", "行動預點").state, "Scrolled");
  assert.equal(splitStateLabel("Screen 1 – エラー", "Screen 1").state, "エラー");
  assert.equal(splitStateLabel("Scrolled | Screen 1", "Screen 1").state, "Scrolled");
  assert.equal(splitStateLabel("下滑", "Screen 1").state, "下滑");
  assert.equal(splitStateLabel("Screen 1", "Screen 1").state, null);
  assert.equal(splitStateLabel("Frame 2410", "Screen 1").state, null);
  assert.equal(splitStateLabel("Screen 1 ~ Empty", "Screen 1", { separators: ["~"] }).state, "Empty");
  assert.equal(isStateKeyword("CustomState", { stateKeywords: ["customstate"] }), true);
  assert.equal(stateLabelsOf(
    [{ label: "Screen 1 / Empty" }, { label: "Screen 1（空态）" }, { label: "Screen 1" }],
    "Screen 1"
  ).length, 2);
});

test("naming: 通用画板名不算有效 boardLabel", () => {
  assert.equal(isGenericLabel("Frame 2406"), true);
  assert.equal(isGenericLabel("Screen 1"), true);
  assert.equal(isGenericLabel("Group 12"), true);
  assert.equal(isGenericLabel("Text 3"), true);
  assert.equal(isGenericLabel("Homepage"), false);
  assert.equal(isGenericLabel("行動預點"), false);
  assert.equal(isStateKeyword("Empty"), true);
  assert.equal(isStateKeyword("Error"), true);
  assert.equal(isStateKeyword("Help"), false);
});

test("naming: 繁简/标点/同义词归一用于 answers 匹配", () => {
  assert.equal(normalizeMatchText("門市／取餐"), normalizeMatchText("门市取餐"));
  assert.equal(
    canonicalizeMatch("底部弹层"),
    canonicalizeMatch("bottom sheet")
  );
  assert.equal(canonicalizeMatch("結帳"), canonicalizeMatch("checkout"));
});


test("answers: 繁简/同义词/标点归一命中", () => {
  const base = {
    id: "q1",
    screenId: "s1",
    screenName: "行動預點",
    element: "門市",
    question: "「門市」的目標頁面是什麼？",
    why: "x"
  };
  assert.equal(
    answerMatchesQuestion({ id: "a1", match: { elementIncludes: "门市" }, answer: "x" }, base),
    true
  );
  assert.equal(
    answerMatchesQuestion(
      { id: "a2", match: { questionIncludes: "底部弹层" }, answer: "x" },
      { ...base, element: null, question: "底部彈層要去哪裡？" }
    ),
    true
  );
});

test("merge: 通用 Frame/Screen 名不作为 boardLabel", () => {
  const screens = [
    { id: "s1", name: "Homepage", order: 0, imagePath: null, sourceFrameName: "Frame 2406" },
    { id: "s2", name: "Frame 2407", order: 1, imagePath: null, sourceFrameName: "Frame 2407" }
  ];
  const chunk = chunkOf("chunk-001", ["s1", "s2"], {
    screens: [
      observation("s1", { boardLabel: "Frame 2406" }),
      observation("s2", { boardLabel: "Frame 2407" })
    ]
  });
  const reading = mergeReadingChunks([chunk], metadata(screens));
  assert.equal(reading.screens.find((screen) => screen.screenId === "s1").boardLabel, "Homepage");
  assert.equal(reading.screens.find((screen) => screen.screenId === "s2").boardLabel, null);
});

test("run: 状态标签支持 slash/括号/英文并保留 ref 状态", async () => {
  const dir = makeTempDir("aos-reading-style-states-");
  const flowsPath = writeFlows(dir, 3);
  const doc = flowDoc(3);
  doc.screens[0].states = [
    { id: "st1", label: "Screen 1 / 下滑", elements: [] },
    { id: "st2", label: "Screen 1（空态）", elements: [] },
    { id: "st3", label: "Screen 1_Scrolled", elements: [] }
  ];
  fs.writeFileSync(flowsPath, JSON.stringify(doc));
  const chat = async (messages) => {
    const text = messages
      .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join(" ");
    const ids = ["s1", "s2", "s3", "st1", "st2", "st3"].filter((id) => text.includes(`id=${id}`));
    return replyFor(ids);
  };
  const result = await runDesignReading({
    runtime: { configDirAbs: dir },
    flowsPath,
    model: "m",
    chat,
    imageFor: () => PNG,
    options: { concurrency: 1, includeStates: true }
  });
  assert.equal(result.stats.screensTotal, 6);
  assert.equal(result.reading.screens.find((screen) => screen.screenId === "st1").stateLabel, "下滑");
  assert.equal(result.reading.screens.find((screen) => screen.screenId === "st2").stateLabel, "空态");
  assert.equal(result.reading.screens.find((screen) => screen.screenId === "st3").stateLabel, "Scrolled");
  assert.equal(result.reading.spine.screenIds.includes("st1"), false);
});


test("answers: answers.json style 可配置分隔符/状态词/同义词", () => {
  const dir = makeTempDir("aos-reading-answers-style-");
  fs.writeFileSync(
    path.join(dir, "answers.json"),
    JSON.stringify({
      version: 1,
      style: {
        separators: ["~"],
        stateKeywords: ["custom-state"],
        synonyms: { custom: ["custom-alias"] }
      },
      answers: []
    })
  );
  const loaded = loadReadingAnswers(dir);
  assert.deepEqual(loaded.style.separators, ["~"]);
  assert.deepEqual(loaded.style.stateKeywords, ["custom-state"]);
  assert.deepEqual(loaded.style.synonyms, { custom: ["custom-alias"] });
});


test("prompt: 画板标签不假设位置，通用 Frame 名不采用", () => {
  const messages = buildReadingMessages({
    plan: planFor(["s1"]),
    images: [{ screenId: "s1", dataUrl: "data:image/png;base64,AA==" }]
  });
  const text = messages
    .map((message) =>
      typeof message.content === "string"
        ? message.content
        : message.content
            .map((part) => (part.type === "text" ? part.text : ""))
            .join("")
    )
    .join("\n");
  assert.match(text, /Frame/);
  assert.match(text, /画板名|页面名|外框上方/);
  assert.match(text, /分隔符|拆不出/);
});

test("run: Figma 式独立 variant 屏按状态归并，不当主屏", async () => {
  const dir = makeTempDir("aos-reading-figma-variants-");
  const flowsPath = writeFlows(dir, 3);
  const doc = flowDoc(3);
  doc.screens[1].name = "Screen 1 / Empty";
  doc.screens[2].name = "Screen 1 / Error";
  fs.writeFileSync(flowsPath, JSON.stringify(doc));
  const chat = async (messages) => {
    const text = messages
      .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join(" ");
    const ids = ["s1", "s2", "s3"].filter((id) => text.includes(`id=${id}`));
    return replyFor(ids);
  };
  const result = await runDesignReading({
    runtime: { configDirAbs: dir },
    flowsPath,
    model: "m",
    chat,
    imageFor: () => PNG,
    options: { concurrency: 1, includeStates: true }
  });
  assert.equal(result.stats.screensTotal, 3);
  assert.equal(result.reading.screens.find((screen) => screen.screenId === "s2").kind, "state");
  assert.equal(result.reading.screens.find((screen) => screen.screenId === "s2").parentScreenId, "s1");
  assert.equal(result.reading.screens.find((screen) => screen.screenId === "s2").stateLabel, "Empty");
  assert.deepEqual(
    result.reading.screens.find((screen) => screen.screenId === "s1").knownStates,
    ["Screen 1 / Empty", "Screen 1 / Error"]
  );
  assert.equal(result.reading.spine.screenIds.includes("s2"), false);
});

test("run: readingStates 无状态输入时给显式 warning", async () => {
  const dir = makeTempDir("aos-reading-no-states-");
  const flowsPath = writeFlows(dir, 3);
  const chat = async (messages) => {
    const text = messages
      .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join(" ");
    const ids = ["s1", "s2", "s3"].filter((id) => text.includes(`id=${id}`));
    return replyFor(ids);
  };
  const result = await runDesignReading({
    runtime: { configDirAbs: dir },
    flowsPath,
    model: "m",
    chat,
    imageFor: () => PNG,
    options: { concurrency: 1, includeStates: true }
  });
  assert.ok(result.warnings.some((warning) => warning.code === "reading-states-unavailable"));
});
