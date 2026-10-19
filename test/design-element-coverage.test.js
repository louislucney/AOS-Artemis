import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_CANDIDATE_TOKENS,
  candidateNameMatches,
  coverageWarnings,
  evaluateCandidateCoverage,
  parseCandidateTokens
} from "../dist/design/element-coverage.js";

function candidate(overrides = {}) {
  return {
    id: "1:1",
    name: "Button/My Order",
    type: "frame",
    textHints: [],
    state: null,
    ...overrides
  };
}

function element(overrides = {}) {
  return {
    id: "el-1",
    class: "cta",
    intent: "submit",
    provenance: "vision-inferred",
    ...overrides
  };
}

test("candidateNameMatches: 任一段命中（Icon/Bag→Bag, Button/My Order→Button）", () => {
  assert.equal(candidateNameMatches("Button/My Order"), true);
  assert.equal(candidateNameMatches("Icon/Bag"), true);
  assert.equal(candidateNameMatches("Tab/Icon+Text"), true);
  assert.equal(candidateNameMatches("my order/button"), true);
  assert.equal(candidateNameMatches("Sticky button"), true);
  assert.equal(candidateNameMatches("Icon/Star"), false);
  assert.equal(candidateNameMatches("Frame 12"), false);
  assert.equal(candidateNameMatches(""), false);
});

test("candidateNameMatches: 中文词与 AOS_VISION_CANDIDATE_TOKENS 追加", () => {
  assert.ok(DEFAULT_CANDIDATE_TOKENS.includes("Button"));
  assert.ok(DEFAULT_CANDIDATE_TOKENS.includes("按钮"));
  assert.equal(candidateNameMatches("图标/购物袋"), true);
  assert.equal(candidateNameMatches("主按钮"), true);
  assert.equal(candidateNameMatches("返回按钮"), true);

  const extra = parseCandidateTokens("Promo, 促销 , ,promo");
  assert.deepEqual(extra, ["promo", "促销"]);
  assert.equal(candidateNameMatches("Promo/Banner"), false);
  assert.equal(candidateNameMatches("Promo/Banner", extra), true);
  assert.equal(candidateNameMatches("促销卡片", extra), true);
});

test("evaluateCandidateCoverage: nodeId / IoU / 中心命中都算 covered", () => {
  const candidates = [
    candidate({ id: "1:1", name: "Button/My Order", bbox: { x: 0, y: 0, width: 100, height: 40 } }),
    candidate({ id: "1:2", name: "Icon/Bag", bbox: { x: 200, y: 0, width: 40, height: 40 } }),
    candidate({ id: "1:3", name: "Tab/Home", bbox: { x: 300, y: 0, width: 80, height: 40 } }),
    candidate({ id: "1:4", name: "Button/Iou", bbox: { x: 0, y: 200, width: 100, height: 100 } })
  ];
  const elements = [
    element({ id: "e1", nodeId: "1:1", bbox: { x: 5, y: 5, width: 10, height: 10 } }),
    element({ id: "e2", bbox: { x: 200, y: 0, width: 40, height: 40 } }),
    element({ id: "e3", bbox: { x: 330, y: 15, width: 10, height: 10 } }),
    element({ id: "e4", bbox: { x: -60, y: 200, width: 100, height: 100 } })
  ];
  const coverage = evaluateCandidateCoverage({
    state: null,
    designNodes: 7,
    candidates,
    elements
  });
  assert.equal(coverage.state, null);
  assert.equal(coverage.designNodes, 7);
  assert.equal(coverage.candidateNodes, 4);
  assert.equal(coverage.recognizedElements, 4);
  assert.equal(coverage.groundedElements, 1);
  assert.equal(coverage.ungroundedElements, 3);
  assert.equal(coverage.coveredCandidates, 4);
  assert.equal(coverage.uncoveredCandidates, 0);
  assert.equal(coverage.unverifiableCandidates, 0);
  assert.equal(coverage.notEvaluatedCandidates, 0);
  assert.deepEqual(
    coverage.details.map((detail) => detail.status),
    ["covered", "covered", "covered", "covered"]
  );
  assert.equal(coverage.details[0].reason, undefined);
  assert.equal(coverage.details[3].reason, undefined, "IoU-only path: element center outside candidate bbox");
});

test("evaluateCandidateCoverage: 无几何但文本命中 → covered", () => {
  const coverage = evaluateCandidateCoverage({
    state: "light",
    designNodes: 2,
    candidates: [
      candidate({ id: "6:1", name: "Icon/Bag", textHints: ["购物袋"], state: "light" }),
      candidate({ id: "6:2", name: "Button/Label", textHints: ["结算"], state: "light" })
    ],
    elements: [
      element({ id: "e1", class: "cart-entry", intent: "navigate", label: "购物袋" }),
      element({
        id: "e2",
        class: "cta",
        intent: "submit",
        label: "去结算",
        bbox: { x: 500, y: 500, width: 20, height: 20 }
      })
    ]
  });
  assert.equal(coverage.coveredCandidates, 2);
  assert.equal(coverage.uncoveredCandidates, 0);
  assert.equal(coverage.unverifiableCandidates, 0);
  assert.deepEqual(
    coverage.details.map((detail) => detail.status),
    ["covered", "covered"]
  );
});

test("evaluateCandidateCoverage: 无几何无文本 → unverifiable", () => {
  const candidates = [
    candidate({ id: "2:1", name: "Frame/Auto" }),
    candidate({ id: "2:2", name: "Frame/Auto2", textHints: ["立即购买"] })
  ];
  const coverage = evaluateCandidateCoverage({
    state: null,
    designNodes: 2,
    candidates,
    elements: [element({ id: "e1", label: "提交" })]
  });
  assert.equal(coverage.coveredCandidates, 0);
  assert.equal(coverage.uncoveredCandidates, 0);
  assert.equal(coverage.unverifiableCandidates, 2);
  assert.equal(coverage.notEvaluatedCandidates, 0);
  assert.deepEqual(
    coverage.details.map((detail) => [detail.status, detail.reason]),
    [
      ["unverifiable", "no-text"],
      ["unverifiable", "no-geometry"]
    ]
  );
});

test("evaluateCandidateCoverage: 同 state 重复文本 → ambiguous-text，不假 covered", () => {
  const candidates = [
    candidate({ id: "3:1", name: "Button/Confirm", textHints: ["确定"], state: "light" }),
    candidate({ id: "3:2", name: "Button/Cancel", textHints: ["确定"], state: "light" }),
    candidate({ id: "3:3", name: "Button/Other", state: "dark" })
  ];
  const elements = [element({ id: "e1", class: "cta", intent: "submit", label: "确定" })];
  const coverage = evaluateCandidateCoverage({
    state: "light",
    designNodes: 3,
    candidates,
    elements
  });
  assert.equal(coverage.candidateNodes, 2, "only same-state candidates are evaluated");
  assert.equal(coverage.coveredCandidates, 0);
  assert.equal(coverage.uncoveredCandidates, 0);
  assert.equal(coverage.unverifiableCandidates, 2);
  assert.deepEqual(
    coverage.details.map((detail) => [detail.status, detail.reason]),
    [
      ["unverifiable", "ambiguous-text"],
      ["unverifiable", "ambiguous-text"]
    ]
  );

  const dark = evaluateCandidateCoverage({
    state: "dark",
    designNodes: 3,
    candidates,
    elements
  });
  assert.equal(dark.candidateNodes, 1, "light candidates must not leak into the dark state");
  assert.equal(dark.details[0].nodeId, "3:3");
  assert.equal(dark.details[0].status, "unverifiable");
  assert.equal(dark.details[0].reason, "no-text");
});

test("evaluateCandidateCoverage: notEvaluatedReason 全量 not-evaluated", () => {
  const candidates = [
    candidate({ id: "4:1", bbox: { x: 0, y: 0, width: 10, height: 10 }, state: "dark" }),
    candidate({ id: "4:2", name: "Icon/Bag", state: "dark" })
  ];
  const coverage = evaluateCandidateCoverage({
    state: "dark",
    designNodes: 10,
    candidates,
    elements: [],
    notEvaluatedReason: "capped",
    candidatesTruncated: 4
  });
  assert.equal(coverage.notEvaluatedCandidates, 2);
  assert.equal(coverage.notEvaluated, true);
  assert.equal(coverage.coveredCandidates, 0);
  assert.equal(coverage.uncoveredCandidates, 0);
  assert.equal(coverage.unverifiableCandidates, 0);
  assert.equal(coverage.candidatesTruncated, 4);
  assert.deepEqual(
    coverage.details.map((detail) => [detail.status, detail.reason]),
    [
      ["not-evaluated", "capped"],
      ["not-evaluated", "capped"]
    ]
  );
});

test("coverageWarnings: uncovered 具名；unverifiable 每屏一条；零候选出 vocabulary-unmatched", () => {
  const main = evaluateCandidateCoverage({
    state: null,
    designNodes: 8,
    candidates: [
      candidate({ id: "5:1", name: "Button/Promo", bbox: { x: 0, y: 0, width: 40, height: 20 } }),
      candidate({ id: "5:2", name: "Icon/Star", bbox: { x: 0, y: 40, width: 40, height: 20 } }),
      candidate({ id: "5:3", name: "Frame/Auto" })
    ],
    elements: []
  });
  const dark = evaluateCandidateCoverage({
    state: "dark",
    designNodes: 4,
    candidates: [
      candidate({ id: "5:4", name: "Button/Gift", state: "dark", bbox: { x: 0, y: 0, width: 40, height: 20 } }),
      candidate({ id: "5:5", name: "Frame/Auto2", state: "dark" })
    ],
    elements: []
  });
  const unmatched = evaluateCandidateCoverage({
    state: null,
    designNodes: 12,
    candidates: [],
    elements: []
  });
  const notEvaluated = evaluateCandidateCoverage({
    state: "disabled",
    designNodes: 3,
    candidates: [candidate({ id: "5:6", name: "Button/Off", state: "disabled" })],
    elements: [],
    notEvaluatedReason: "render-missing"
  });
  const notEvaluatedEmpty = evaluateCandidateCoverage({
    state: null,
    designNodes: 3,
    candidates: [],
    elements: [],
    notEvaluatedReason: "render-missing"
  });
  assert.equal(notEvaluatedEmpty.notEvaluated, true);

  const warnings = coverageWarnings("结算页", [
    main,
    dark,
    unmatched,
    notEvaluated,
    notEvaluatedEmpty
  ]);
  const uncovered = warnings.filter((warning) => warning.code === "vision-candidate-uncovered");
  assert.equal(uncovered.length, 2, "one uncovered warning per evaluated state");
  const named = uncovered.flatMap((warning) => warning.details ?? []);
  assert.ok(named.some((detail) => detail.includes("Button/Promo")));
  assert.ok(named.some((detail) => detail.includes("Icon/Star")));
  assert.ok(named.some((detail) => detail.includes("Button/Gift")));
  assert.ok(uncovered.every((warning) => warning.message.includes("结算页")));
  assert.ok(uncovered[1].message.includes("状态「dark」"));

  const unverifiable = warnings.filter((warning) => warning.code === "vision-candidate-unverifiable");
  assert.equal(unverifiable.length, 1, "one summary warning per screen, not per candidate");
  assert.ok(unverifiable[0].message.includes("2"), "message counts 2 unverifiable candidates");

  const vocabulary = warnings.filter(
    (warning) => warning.code === "vision-candidate-vocabulary-unmatched"
  );
  assert.equal(vocabulary.length, 1);
  assert.ok(vocabulary[0].message.includes("结算页"));
  assert.ok(vocabulary[0].message.includes("12"));

  assert.equal(
    warnings.filter((warning) => (warning.details ?? []).some((detail) => detail.includes("Button/Off"))).length,
    0,
    "not-evaluated candidates must not emit per-candidate warnings"
  );
});
