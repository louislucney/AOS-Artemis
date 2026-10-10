/** Provenance / confidence / text-class vocabulary shared by the design
 * pipeline (ADR-0008): producers tag what they know, consumers branch on it.
 * Absent fields resolve to `legacy-unknown` (conservative, never silently
 * promoted). Confidence is derived from provenance on read, so a persisted
 * confidence contradicting its provenance can never promote anything. */

export type Provenance =
  | "explicit"
  | "inferred"
  | "runtime-observed"
  | "human-confirmed"
  | "legacy-unknown";

export type Confidence = "high" | "low";

export type TextClass = "runtime-text" | "annotation" | "layer-name";

const CONFIDENCE_BY_PROVENANCE: Record<Provenance, Confidence> = {
  explicit: "high",
  inferred: "low",
  "runtime-observed": "high",
  "human-confirmed": "high",
  "legacy-unknown": "low"
};

export function confidenceFor(provenance: Provenance): Confidence {
  return CONFIDENCE_BY_PROVENANCE[provenance];
}

export function resolveProvenance(value: unknown): Provenance {
  return typeof value === "string" && Object.hasOwn(CONFIDENCE_BY_PROVENANCE, value)
    ? (value as Provenance)
    : "legacy-unknown";
}

/** `Flow/*` layer-name convention marking design annotations (shared by the
 * Figma ancestor walk and the pen subtree walk). */
export function isAnnotationLayerName(name: unknown): boolean {
  return typeof name === "string" && name.startsWith("Flow/");
}

/** Unconfirmed evidence (heuristic inference or legacy artifacts): generation
 * must emit exploration steps, never hard assertions. */
export function isUnconfirmedProvenance(provenance: Provenance): boolean {
  return provenance === "inferred" || provenance === "legacy-unknown";
}

/** How a generated step is judged: hard assertions gate PASS/FAIL, exploration
 * steps only record their actual path (deferred semantics). */
export type StepKind = "assert" | "explore";

export function isExploreKind(value: unknown): boolean {
  return value === "explore";
}

/** Gate-side classification for flow coverage: only `inferred` evidence is
 * exempt from the hard gate. Legacy artifacts stay gating (fail loud — never
 * silently weaken an old project's gate); confirmed evidence always gates.
 * Note this is deliberately NOT the inverse of `isUnconfirmedProvenance`
 * (assertion side): legacy is unconfirmed for assertions yet still gating. */
export function isHardCoverageTarget(provenance: Provenance): boolean {
  return provenance !== "inferred";
}

/** Convenience for persisted artifacts: classify a raw provenance value for
 * coverage gating (missing/unknown → legacy-unknown → hard). */
export function isHardCoverageValue(value: unknown): boolean {
  return isHardCoverageTarget(resolveProvenance(value));
}
