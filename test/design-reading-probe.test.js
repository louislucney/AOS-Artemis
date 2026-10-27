import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  isObservedFresh,
  loadObservedCache,
  observedKey,
  probeScrollCollapse,
  saveObservedCache,
  assertionFromObserved
} from "../dist/design/reading/probe.js";
import { runInteractionProbe } from "../dist/design/reading/probe-command.js";
import { androidProbeDevice, parseAndroidNodes } from "../dist/design/reading/probe-android.js";
import { createImage, toPng } from "./helpers.js";

function node(label, y, height = 20) {
  return {
    type: "StaticText",
    label,
    value: "",
    id: "",
    rect: { x: 0, y, width: 200, height }
  };
}

function fakeDevice() {
  let offset = 0;
  return {
    unit: "device-points",
    async size() {
      return { width: 375, height: 855 };
    },
    async swipe(_x1, y1, _x2, y2) {
      const distance = Math.abs(y2 - y1);
      offset += y2 < y1 ? distance : -distance;
    },
    async nodes() {
      const nodes = [node("到店自取", 44 - offset)];
      if (offset >= 100) nodes.push(node("到店自取", 0));
      return nodes;
    }
  };
}

function candidate() {
  return {
    kind: "scroll-collapse",
    beforeFrameId: "before",
    afterFrameId: "after",
    pairing: {
      track: "structural",
      score: 1,
      matchedTexts: 10,
      support: 1,
      offset: 360,
      deltaMode: 360,
      contentDiff: 0,
      visualAtOffset: 0.68
    },
    delta: { designPx: 360, devicePoints: 360 },
    sticky: [
      {
        id: "bar",
        name: "App Bar",
        text: "到店自取",
        origin: "takeover",
        region: "header"
      }
    ],
    collapsed: [{ id: "tab", name: "Tab", text: "到店自取", region: "content" }],
    titleTakeover: { bar: { id: "bar", name: "App Bar", text: "到店自取" }, from: { id: "tab", name: "Tab", text: "到店自取" } },
    provenance: { kind: "inferred", basis: "structural", score: 1 },
    evidence: []
  };
}

test("probe: scroll-collapse -> observed, restore and assertion regions", async () => {
  const result = await probeScrollCollapse(fakeDevice(), candidate(), {
    screenId: "screen-1",
    deviceSerial: "device-1",
    maxScroll: 400,
    step: 100,
    waitMs: 0
  });
  assert.equal(result.reason, null);
  assert.ok(result.observed);
  assert.equal(result.observed.kind, "scroll-collapse");
  assert.equal(result.observed.thresholdSignal, "structural");
  assert.ok(result.observed.firstChangePoints > 0);
  assert.equal(result.observed.restored, true);

  const assertion = assertionFromObserved(result.observed);
  assert.equal(assertion.source, "observed");
  assert.ok(
    assertion.afterScroll.some(
      (query) => query.kind === "absentText" && query.text === "到店自取" && query.region === "content"
    )
  );
  assert.ok(
    assertion.afterScroll.some(
      (query) => query.kind === "presentText" && query.text === "到店自取" && query.region === "header"
    )
  );
  assert.ok(
    assertion.afterRestore.some(
      (query) => query.kind === "absentText" && query.text === "到店自取" && query.region === "header"
    )
  );
});

test("probe: non-scroll candidate is rejected", async () => {
  const result = await probeScrollCollapse(fakeDevice(), { kind: "state-change" }, {
    screenId: "s",
    deviceSerial: "d"
  });
  assert.equal(result.observed, null);
  assert.equal(result.reason, "candidate-not-scroll");
});

test("probe: observed cache requires matching device/app/design fingerprint", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aos-probe-cache-"));
  const cache = loadObservedCache(dir);
  const entry = {
    fingerprint: { deviceSerial: "d1", appVersion: "1.0", designFingerprint: "f1" },
    observed: {
      kind: "scroll-collapse",
      provenance: { kind: "observed", evidence: [] },
      screenId: "s",
      unit: "device-points",
      thresholdSignal: "structural",
      firstChangePoints: 100,
      fullEffectPoints: 100,
      sticky: [],
      collapsed: [],
      restored: true,
      evidence: { before: "", after: "" }
    }
  };
  cache[observedKey("s", "d1")] = entry;
  saveObservedCache(dir, cache);
  const loaded = loadObservedCache(dir);
  assert.equal(isObservedFresh(loaded[observedKey("s", "d1")], { deviceSerial: "d1", appVersion: "1.0", designFingerprint: "f1" }), true);
  assert.equal(isObservedFresh(loaded[observedKey("s", "d1")], { deviceSerial: "d1", appVersion: "2.0", designFingerprint: "f1" }), false);
  assert.equal(isObservedFresh(loaded[observedKey("s", "d1")], { deviceSerial: "d2", appVersion: "1.0", designFingerprint: "f1" }), false);
});


test("probe command: matches reading candidate, probes and caches", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aos-probe-command-"));
  fs.mkdirSync(path.join(dir, "design", "reading"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "design", "flows.json"),
    JSON.stringify({
      screens: [
        { id: "before", name: "MOP", states: [{ id: "after", label: "MOP-下滑" }] }
      ]
    })
  );
  fs.writeFileSync(
    path.join(dir, "design", "reading", "reading.json"),
    JSON.stringify({
      flowsFingerprint: "f1",
      interactionCandidates: [candidate()]
    })
  );
  const result = await runInteractionProbe(
    { configDirAbs: dir, project: { rootDir: dir } },
    {
      screen: "MOP",
      deviceSerial: "604E430A-5BE7-4FAD-99F5-11CF0539553B",
      appVersion: "1.0",
      maxScroll: 400,
      step: 100,
      noSave: false
    },
    { device: fakeDevice() }
  );
  assert.equal(result.exitCode, 0, JSON.stringify(result.payload));
  assert.equal(result.payload.ok, true);
  assert.equal(result.payload.observed.restored, true);
  const cache = JSON.parse(
    fs.readFileSync(path.join(dir, "design", "interactions.observed.json"), "utf-8")
  );
  const key = observedKey("after", "604E430A-5BE7-4FAD-99F5-11CF0539553B");
  assert.ok(cache[key]);
});


test("probe android: parses uiautomator nodes and uses device pixels", async () => {
  const xml = `<hierarchy><node text="到店自取" content-desc="" resource-id="tab" bounds="[0,44][200,64]" /><node text="" content-desc="App Bar" resource-id="bar" bounds="[0,0][375,44]" /></hierarchy>`;
  const nodes = parseAndroidNodes(xml);
  assert.equal(nodes.length, 2);
  assert.equal(nodes[0].label, "到店自取");
  assert.deepEqual(nodes[0].rect, { x: 0, y: 44, width: 200, height: 20 });
  assert.equal(nodes[1].label, "App Bar");
  const png = toPng(createImage(1080, 2400));
  const device = androidProbeDevice("emulator-5554", {
    env: { AOS_ADB_PATH: "/fake/adb" },
    pathExists: () => true,
    exec: async (_command, args) => {
      if (args.includes("cat")) return { code: 0, stdout: xml, stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    },
    execBuffer: async () => ({ code: 0, stdout: png, stderr: "" })
  });
  assert.equal(device.unit, "device-px");
  assert.deepEqual(await device.size(), { width: 1080, height: 2400 });
  assert.equal((await device.nodes()).length, 2);
});
