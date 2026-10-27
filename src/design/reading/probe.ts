import fs from "node:fs";
import path from "node:path";

import type { Runtime } from "../../runtime.js";
import { classifyIosSerial, type IosUiNode } from "../../device/ios.js";
import { androidProbeDevice } from "./probe-android.js";
import {
  normalizeForMatch,
  toScrollAssertion,
  type Assertion,
  type InteractionCandidate,
  type InteractionNodeRef,
  type ObservedInteraction
} from "./interaction.js";

export interface ScrollProbeDevice {
  unit: "logical";
  nativeUnit: "pt" | "dp";
  size(): Promise<{ width: number; height: number } | null>;
  swipe(x1: number, y1: number, x2: number, y2: number, ms: number): Promise<void>;
  nodes(): Promise<IosUiNode[]>;
  screenshot?(): Promise<Buffer>;
}

export interface ProbeOptions {
  screenId: string;
  deviceSerial: string;
  appVersion?: string;
  designFingerprint?: string;
  maxScroll?: number;
  step?: number;
  waitMs?: number;
  outDir?: string;
}

export interface ProbeResult {
  observed: ObservedInteraction | null;
  reason: string | null;
  evidenceDir: string | null;
}

function textOf(node: IosUiNode): string {
  return [node.label, node.value, node.id].filter((value) => value.trim() !== "").join(" ");
}

function matchesText(node: IosUiNode, text: string): boolean {
  const haystack = normalizeForMatch(textOf(node));
  const needle = normalizeForMatch(text);
  return needle !== "" && (haystack === needle || haystack.includes(needle));
}

function visibleAtTop(node: IosUiNode, viewportHeight: number): boolean {
  return node.rect.y >= 0 && node.rect.y <= Math.min(12, viewportHeight * 0.05);
}

function collapsedPresent(
  nodes: IosUiNode[],
  collapsed: InteractionNodeRef[],
  viewportHeight: number,
  takeoverText: string | null = null
): boolean {
  return collapsed.some((ref) => {
    if (ref.text === null || ref.text.trim() === "") return false;
    return nodes.some(
      (node) =>
        matchesText(node, ref.text!) &&
        !(takeoverText !== null && visibleAtTop(node, viewportHeight) && matchesText(node, takeoverText)) &&
        node.rect.y + node.rect.height > 0 &&
        node.rect.y < viewportHeight
    );
  });
}

function takeoverPresent(nodes: IosUiNode[], candidate: InteractionCandidate, viewportHeight: number): boolean {
  if (candidate.kind !== "scroll-collapse") return false;
  const text = candidate.titleTakeover?.bar.text ?? null;
  if (text === null || text.trim() === "") return false;
  return nodes.some((node) => matchesText(node, text) && visibleAtTop(node, viewportHeight));
}

function takeawayRefs(candidate: InteractionCandidate): InteractionNodeRef[] {
  if (candidate.kind !== "scroll-collapse") return [];
  return candidate.sticky.filter((node) => node.origin === "takeover");
}

export async function probeScrollCollapse(
  device: ScrollProbeDevice,
  candidate: InteractionCandidate,
  options: ProbeOptions
): Promise<ProbeResult> {
  if (candidate.kind !== "scroll-collapse") {
    return { observed: null, reason: "candidate-not-scroll", evidenceDir: null };
  }
  const scrollCandidate = candidate;
  const size = await device.size();
  if (size === null) {
    return { observed: null, reason: "device-size-unavailable", evidenceDir: null };
  }
  const maxScroll = Math.max(100, options.maxScroll ?? 1200);
  const step = Math.min(
    maxScroll,
    Math.max(50, options.step ?? Math.min(400, Math.max(100, Math.round(maxScroll / 8))))
  );
  const waitMs = Math.max(0, options.waitMs ?? 150);
  const evidenceDir =
    options.outDir === undefined
      ? null
      : path.join(options.outDir, `${options.screenId}-${Date.now()}`);
  if (evidenceDir !== null) fs.mkdirSync(evidenceDir, { recursive: true });

  const capture = async (label: string): Promise<IosUiNode[]> => {
    const nodes = await device.nodes();
    if (evidenceDir !== null && device.screenshot !== undefined) {
      try {
        fs.writeFileSync(path.join(evidenceDir, `${label}.png`), await device.screenshot());
      } catch {
        /* screenshot is evidence only */
      }
    }
    return nodes;
  };
  let currentOffset = 0;
  const swipeUp = async (distance: number): Promise<void> => {
    const x = Math.round(size.width / 2);
    const y1 = Math.round(size.height * 0.75);
    const y2 = Math.max(1, y1 - distance);
    await device.swipe(x, y1, x, y2, 300);
    currentOffset += distance;
    if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
  };
  const swipeDown = async (distance: number): Promise<void> => {
    const x = Math.round(size.width / 2);
    const y1 = Math.round(size.height * 0.25);
    const y2 = Math.min(size.height - 1, y1 + distance);
    await device.swipe(x, y1, x, y2, 300);
    currentOffset = Math.max(0, currentOffset - distance);
    if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
  };

  const collapsed = scrollCandidate.collapsed;
  const takeover = takeawayRefs(scrollCandidate);
  const takeoverText = scrollCandidate.titleTakeover?.bar.text ?? takeover[0]?.text ?? null;
  const initial = await capture("before");
  const hasAxText = initial.some(
    (node) => node.label.trim() !== "" || node.value.trim() !== ""
  );
  if (!hasAxText) {
    return { observed: null, reason: "observation-no-ax-text", evidenceDir };
  }
  if (!collapsedPresent(initial, scrollCandidate.collapsed, size.height, takeoverText)) {
    return { observed: null, reason: "collapsed-text-not-visible-before", evidenceDir };
  }

  let firstChange: number | null = null;
  let fullEffect: number | null = null;
  let fullNodes: IosUiNode[] | null = null;
  let previousFullOffset = 0;

  const fullEffectReached = (nodes: IosUiNode[]): boolean => {
    const collapsedGone = !collapsedPresent(nodes, collapsed, size.height, takeoverText);
    const takeoverVisible = takeover.length === 0 || takeoverPresent(nodes, candidate, size.height);
    return collapsedGone && takeoverVisible;
  };
  const scrollTo = async (target: number): Promise<void> => {
    const maxStep = Math.max(100, Math.round(size.height * 0.6));
    while (target > currentOffset) {
      await swipeUp(Math.min(target - currentOffset, maxStep));
    }
    while (target < currentOffset) {
      await swipeDown(Math.min(currentOffset - target, maxStep));
    }
  };

  for (let offset = step; offset <= maxScroll; offset += step) {
    await scrollTo(offset);
    const nodes = await capture(`scroll-${offset}`);
    const changed =
      !collapsedPresent(nodes, collapsed, size.height, takeoverText) ||
      (takeover.length > 0 && takeoverPresent(nodes, scrollCandidate, size.height));
    if (changed && firstChange === null) firstChange = offset;
    if (fullEffectReached(nodes)) {
      fullEffect = offset;
      fullNodes = nodes;
      break;
    }
    previousFullOffset = offset;
  }
  if (firstChange === null || fullEffect === null || fullNodes === null) {
    return { observed: null, reason: "no-full-effect", evidenceDir };
  }

  let threshold = fullEffect;
  let low = previousFullOffset;
  let high = fullEffect;
  for (let iteration = 0; iteration < 5 && high - low > 16; iteration++) {
    const mid = Math.round((low + high) / 2);
    await scrollTo(mid);
    const nodes = await capture(`binary-${mid}`);
    if (fullEffectReached(nodes)) {
      high = mid;
      threshold = mid;
    } else {
      low = mid;
    }
  }

  await scrollTo(0);
  const restoredNodes = await capture("restored");
  const restored = collapsedPresent(restoredNodes, collapsed, size.height, takeoverText);

  return {
    observed: {
      kind: "scroll-collapse",
      provenance: {
        kind: "observed",
        evidence: [
          `probe:firstChange=${firstChange}pt`,
          `probe:fullEffect=${threshold}pt`,
          `probe:max=${maxScroll}pt`
        ]
      },
      screenId: options.screenId,
      unit: device.unit,
      nativeUnit: device.nativeUnit,
      thresholdSignal: "structural",
      firstChangePoints: firstChange,
      fullEffectPoints: threshold,
      sticky: scrollCandidate.sticky,
      collapsed: scrollCandidate.collapsed,
      restored,
      evidence: { before: evidenceDir ?? "before", after: evidenceDir ?? "after" }
    },
    reason: null,
    evidenceDir
  };
  return {
    observed: {
      kind: "scroll-collapse",
      provenance: {
        kind: "observed",
        evidence: [`probe:firstChange=${threshold}pt`, `probe:max=${maxScroll}pt`]
      },
      screenId: options.screenId,
      unit: device.unit,
      nativeUnit: device.nativeUnit,
      thresholdSignal: "structural",
      firstChangePoints: threshold,
      fullEffectPoints: threshold,
      sticky: scrollCandidate.sticky,
      collapsed: scrollCandidate.collapsed,
      restored,
      evidence: { before: evidenceDir ?? "before", after: evidenceDir ?? "after" }
    },
    reason: null,
    evidenceDir
  };
}

export function resolveProbeDevice(runtime: Runtime, serial: string): ScrollProbeDevice {
  return classifyIosSerial(serial) === null
    ? androidProbeDevice(serial)
    : iosProbeDevice(runtime, serial);
}

export function iosProbeDevice(runtime: Runtime, serial: string): ScrollProbeDevice {
  return {
    unit: "logical",
    nativeUnit: "pt",
    async size() {
      const device = await runtime.iosDevice(serial);
      return device === null ? null : await device.size();
    },
    async swipe(x1, y1, x2, y2, ms) {
      const device = await runtime.iosDevice(serial);
      if (device === null) throw new Error(`找不到 iOS 设备：${serial}`);
      await device.swipe(x1, y1, x2, y2, ms);
    },
    async nodes() {
      const device = await runtime.iosDevice(serial);
      if (device === null) throw new Error(`找不到 iOS 设备：${serial}`);
      return await device.nodes();
    },
    async screenshot() {
      const device = await runtime.iosDevice(serial);
      if (device === null) throw new Error(`找不到 iOS 设备：${serial}`);
      return await device.screenshot();
    }
  };
}

export interface ObservedCacheEntry {
  fingerprint: {
    deviceSerial: string;
    appVersion: string | null;
    designFingerprint: string | null;
  };
  observed: ObservedInteraction;
}

export type ObservedCache = Record<string, ObservedCacheEntry>;

export function observedCachePath(designRoot: string): string {
  return path.join(designRoot, "interactions.observed.json");
}

export function loadObservedCache(designRoot: string): ObservedCache {
  try {
    const parsed = JSON.parse(fs.readFileSync(observedCachePath(designRoot), "utf-8")) as ObservedCache;
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function saveObservedCache(designRoot: string, cache: ObservedCache): void {
  const file = observedCachePath(designRoot);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(cache, null, 2) + "\n");
}

export function observedKey(screenId: string, deviceSerial: string): string {
  return `${screenId}::${deviceSerial}`;
}

export function isObservedFresh(
  entry: ObservedCacheEntry | undefined,
  input: { deviceSerial: string; appVersion?: string; designFingerprint?: string }
): boolean {
  if (entry === undefined) return false;
  if (entry.fingerprint.deviceSerial !== input.deviceSerial) return false;
  if ((entry.fingerprint.appVersion ?? null) !== (input.appVersion ?? null)) return false;
  if ((entry.fingerprint.designFingerprint ?? null) !== (input.designFingerprint ?? null)) return false;
  return true;
}

export function assertionFromObserved(observed: ObservedInteraction): Assertion {
  return toScrollAssertion(observed);
}
