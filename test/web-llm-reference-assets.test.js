import assert from "node:assert/strict";
import test from "node:test";

import { resolveCaseReference } from "../dist/web/llm/reference-assets.js";

function asset(id, filename, version = 1, createdAt = "2026-11-01T00:00:00.000Z") {
  return {
    id,
    rootPath: "/p",
    kind: "reference",
    filename,
    version,
    sha256: id.padEnd(64, "0"),
    size: 1,
    storagePath: `/p/.artemis/web/assets/reference/${id}.png`,
    uploadedBy: null,
    metadata: {},
    createdAt
  };
}

const assets = [
  asset("a1", "login.png", 1, "2026-11-01T00:00:00.000Z"),
  asset("a2", "login.png", 2, "2026-11-02T00:00:00.000Z"),
  asset("a3", "home.jpg", 1, "2026-11-03T00:00:00.000Z")
];

test("resolveCaseReference：空值回退 job 级 reference", () => {
  assert.deepEqual(
    resolveCaseReference({
      requested: "",
      assets,
      fallbackPath: "/fallback.png",
      fallbackAssetId: "job-ref"
    }),
    { referencePath: "/fallback.png", referenceAssetId: "job-ref" }
  );
});

test("resolveCaseReference：ID / asset:ID / 文件名 / 去扩展名，取最新版本", () => {
  assert.equal(
    resolveCaseReference({
      requested: "a3",
      assets,
      fallbackPath: null,
      fallbackAssetId: null
    }).referenceAssetId,
    "a3"
  );
  assert.equal(
    resolveCaseReference({
      requested: "asset:a1",
      assets,
      fallbackPath: null,
      fallbackAssetId: null
    }).referenceAssetId,
    "a1"
  );
  assert.equal(
    resolveCaseReference({
      requested: "LOGIN.PNG",
      assets,
      fallbackPath: null,
      fallbackAssetId: null
    }).referenceAssetId,
    "a2"
  );
  assert.equal(
    resolveCaseReference({
      requested: "login",
      assets,
      fallbackPath: null,
      fallbackAssetId: null
    }).referenceAssetId,
    "a2"
  );
});

test("resolveCaseReference：显式值未匹配不静默回退", () => {
  assert.deepEqual(
    resolveCaseReference({
      requested: "missing.png",
      assets,
      fallbackPath: "/fallback.png",
      fallbackAssetId: "job-ref"
    }),
    {
      referencePath: null,
      referenceAssetId: null,
      missingReason: "reference-asset-not-found:missing.png"
    }
  );
  assert.deepEqual(
    resolveCaseReference({
      requested: "asset:missing",
      assets,
      fallbackPath: "/fallback.png",
      fallbackAssetId: "job-ref"
    }),
    {
      referencePath: null,
      referenceAssetId: null,
      missingReason: "reference-asset-not-found:asset:missing"
    }
  );
});
