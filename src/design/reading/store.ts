import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { FlowEdge } from "../../figma/flows.js";
import { writeFileAtomic } from "../../util.js";
import type { ReadingChunk } from "./types.js";

export interface ReadingPaths {
  root: string;
  chunksDir: string;
  json: string;
  markdown: string;
}

export function readingPaths(configDirAbs: string): ReadingPaths {
  const root = path.join(configDirAbs, "design", "reading");
  return {
    root,
    chunksDir: path.join(root, "chunks"),
    json: path.join(root, "reading.json"),
    markdown: path.join(root, "reading.md")
  };
}

function canonicalEdge(edge: FlowEdge): Record<string, unknown> {
  return {
    from: edge.from.id,
    to: edge.to?.id ?? null,
    element: edge.element.id,
    trigger: edge.trigger,
    actionType: edge.actionType,
    textHints: edge.textHints.map((hint) => hint.text),
    state: edge.state ?? null
  };
}

export function readingChunkHash(input: {
  screenIds: string[];
  imageSha256: string[];
  knownEdges: FlowEdge[];
  options: Record<string, unknown>;
  promptVersion: number;
  model: string;
}): string {
  const canonical = JSON.stringify({
    screenIds: input.screenIds,
    imageSha256: input.imageSha256,
    knownEdges: input.knownEdges
      .map(canonicalEdge)
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
    options: input.options,
    promptVersion: input.promptVersion,
    model: input.model
  });
  return createHash("sha256").update(canonical).digest("hex");
}

export function readCachedChunk(root: string, hash: string): ReadingChunk | null {
  const file = path.join(root, "chunks", `${hash}.json`);
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as ReadingChunk;
    if (
      !parsed ||
      typeof parsed !== "object" ||
      !Array.isArray(parsed.screens) ||
      !Array.isArray(parsed.interactions) ||
      !Array.isArray(parsed.questions) ||
      !Array.isArray(parsed.droppedScreens) ||
      !Array.isArray(parsed.unreadScreens)
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/** 写两份：`chunks/<cacheKey>.json` 供复用，`chunks/<chunkId>.json` 供人读。 */
export function writeReadingChunk(root: string, chunk: ReadingChunk): string {
  const chunksDir = path.join(root, "chunks");
  fs.mkdirSync(chunksDir, { recursive: true });
  const body = JSON.stringify(chunk, null, 2) + "\n";
  const human = path.join(chunksDir, `${chunk.chunkId}.json`);
  writeFileAtomic(human, body);
  writeFileAtomic(path.join(chunksDir, `${chunk.cacheKey}.json`), body);
  return human;
}
