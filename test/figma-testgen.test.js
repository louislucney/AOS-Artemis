import assert from "node:assert/strict";
import test from "node:test";

import { buildFlowGraph } from "../dist/figma/flows.js";
import { generateTestCases, linearizeFlows, renderMarkdown } from "../dist/figma/test-gen.js";

function syntheticDocument({ extraEntry = false } = {}) {
  const settings = extraEntry
    ? [
        {
          id: "9:1",
          name: "Settings",
          type: "FRAME",
          children: [
            {
              id: "9:2",
              name: "Open Home",
              type: "BUTTON",
              children: [{ id: "9:3", name: "L", type: "TEXT", characters: "Go home" }],
              interactions: [
                {
                  trigger: { type: "ON_CLICK" },
                  actions: [{ type: "NODE", destinationId: "10:1", navigation: "NAVIGATE" }]
                }
              ]
            }
          ]
        }
      ]
    : [];

  return {
    id: "0:0",
    name: "Doc",
    type: "DOCUMENT",
    children: [
      {
        id: "1:0",
        name: "Page 1",
        type: "PAGE",
        children: [
          ...settings,
          {
            id: "10:1",
            name: "Home",
            type: "FRAME",
            children: [
              { id: "10:5", name: "Welcome", type: "TEXT", characters: "Welcome Back" },
              {
                id: "10:2",
                name: "CTA Button",
                type: "INSTANCE",
                children: [{ id: "10:3", name: "Label", type: "TEXT", characters: "Buy now" }],
                interactions: [
                  {
                    trigger: { type: "ON_CLICK" },
                    actions: [{ type: "NODE", destinationId: "11:1", navigation: "NAVIGATE" }]
                  }
                ]
              }
            ]
          },
          {
            id: "11:1",
            name: "Checkout",
            type: "FRAME",
            children: [
              { id: "11:5", name: "Amount", type: "TEXT", characters: "Pay now" },
              {
                id: "11:2",
                name: "Payment Loader",
                type: "FRAME",
                interactions: [
                  {
                    trigger: { type: "AFTER_TIMEOUT", timeout: 2000 },
                    actions: [{ type: "NODE", destinationId: "12:1", navigation: "NAVIGATE" }]
                  }
                ]
              }
            ]
          },
          {
            id: "12:1",
            name: "Success",
            type: "FRAME",
            children: [
              { id: "12:5", name: "Done", type: "TEXT", characters: "Done" },
              {
                id: "12:2",
                name: "Back Link",
                type: "VECTOR",
                interactions: [
                  {
                    trigger: { type: "ON_CLICK" },
                    actions: [{ type: "NODE", navigation: "BACK" }]
                  }
                ]
              }
            ]
          }
        ]
      }
    ]
  };
}

test("linearizeFlows: chains consecutive interactions into a path and stops at back edges", () => {
  const graph = buildFlowGraph(syntheticDocument());
  const flows = linearizeFlows(graph);
  assert.equal(flows.length, 1);
  assert.equal(flows[0].length, 3);
  assert.equal(flows[0][0].to.name, "Checkout");
  assert.equal(flows[0][1].trigger, "AFTER_TIMEOUT");
  assert.equal(flows[0][2].back, true);
});

test("generateTestCases: artemis task descriptions with locators and assertions", () => {
  const graph = buildFlowGraph(syntheticDocument());
  const cases = generateTestCases(graph);

  assert.equal(cases.length, 1);
  const testCase = cases[0];
  assert.equal(testCase.name, "Home → Checkout → Success");
  assert.deepEqual(testCase.screens, ["Home", "Checkout", "Success"]);

  assert.match(testCase.steps[0], /点击「Buy now」（设计元素：CTA Button）/);
  assert.match(testCase.steps[0], /验证进入「Checkout」/);
  assert.match(testCase.steps[0], /「Pay now」/, "assertion hints from destination screen");
  assert.match(testCase.steps[1], /^等待 2 秒/);
  assert.match(testCase.steps[2], /返回上一页/);

  assert.match(testCase.taskDesc, /【设计流程端到端验证】Home → Checkout → Success/);
  assert.match(testCase.taskDesc, /1\) 点击「Buy now」/);
  assert.match(testCase.taskDesc, /PASS\/FAIL/);
});

test("generateTestCases: entry screens with incoming edges are not treated as starts", () => {
  const graph = buildFlowGraph(syntheticDocument({ extraEntry: true }));
  assert.deepEqual(graph.entryScreens, ["Settings"]);

  const cases = generateTestCases(graph);
  assert.equal(cases.length, 1);
  assert.equal(cases[0].name, "Settings → Home → Checkout → Success");
  assert.match(cases[0].steps[0], /点击「Go home」/);
});

test("generateTestCases: frozen i18n keys are attached when strings.json mapping is provided", () => {
  const graph = buildFlowGraph(syntheticDocument());
  const cases = generateTestCases(graph, {
    i18nKeys: new Map([["Buy now", "home.cta_button"]])
  });
  assert.match(cases[0].steps[0], /设计元素：CTA Button；i18n: home\.cta_button/);
  assert.match(cases[0].taskDesc, /i18n: home\.cta_button/);
});

test("renderMarkdown: checklist + embedded task descriptions", () => {
  const graph = buildFlowGraph(syntheticDocument());
  const markdown = renderMarkdown(generateTestCases(graph), {
    source: "unit-test",
    generatedAt: "2026-09-29T00:00:00Z"
  });
  assert.match(markdown, /# 设计流程测试用例/);
  assert.match(markdown, /- \[ \] 1\) 点击「Buy now」/);
  assert.match(markdown, /### artemis 任务描述/);
  assert.match(markdown, /```text/);
});
