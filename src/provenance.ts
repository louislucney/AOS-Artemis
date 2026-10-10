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
