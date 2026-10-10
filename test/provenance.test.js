import assert from "node:assert/strict";
import test from "node:test";

import { confidenceFor, isAnnotationLayerName, resolveProvenance } from "../dist/provenance.js";

test("resolveProvenance: known values pass, everything else is legacy-unknown", () => {
  assert.equal(resolveProvenance("explicit"), "explicit");
  assert.equal(resolveProvenance("inferred"), "inferred");
  assert.equal(resolveProvenance("runtime-observed"), "runtime-observed");
  assert.equal(resolveProvenance("human-confirmed"), "human-confirmed");
  assert.equal(resolveProvenance("legacy-unknown"), "legacy-unknown");
  assert.equal(resolveProvenance("constructor"), "legacy-unknown");
  assert.equal(resolveProvenance("toString"), "legacy-unknown");
  assert.equal(resolveProvenance(42), "legacy-unknown");
  assert.equal(resolveProvenance(undefined), "legacy-unknown");
  assert.equal(resolveProvenance(null), "legacy-unknown");
});

test("confidenceFor: provenance maps onto a total confidence scale", () => {
  assert.equal(confidenceFor("explicit"), "high");
  assert.equal(confidenceFor("inferred"), "low");
  assert.equal(confidenceFor("legacy-unknown"), "low");
  assert.equal(confidenceFor("runtime-observed"), "high");
  assert.equal(confidenceFor("human-confirmed"), "high");
});

test("isAnnotationLayerName: only the Flow/* convention counts", () => {
  assert.equal(isAnnotationLayerName("Flow/Note"), true);
  assert.equal(isAnnotationLayerName("Flow/Section"), true);
  assert.equal(isAnnotationLayerName("Note"), false);
  assert.equal(isAnnotationLayerName("Flow"), false);
  assert.equal(isAnnotationLayerName(undefined), false);
  assert.equal(isAnnotationLayerName(42), false);
});
