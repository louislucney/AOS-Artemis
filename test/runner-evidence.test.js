import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { MemoryStore } from "../dist/db/memory.js";
import { createAosHttpServer } from "../dist/http-server.js";
import { baseConfig, makeTempProject } from "./helpers.js";

const HOST = "evidence-host";
const TOKEN = "evidence-token-0123456789abcdef";

async function withEnv(key, value, fn) {
  const previous = process.env[key];
  process.env[key] = value;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
}

async function makeServer() {
  const rootPath = makeTempProject({ config: baseConfig() });
  const store = new MemoryStore();
  await store.upsertProject({ rootPath, name: "evidence", hostId: HOST });
  const task = await store.createRegressionTask({
    rootPath,
    refs: [],
    platforms: ["android"],
    baseline: "latest",
    targetHostId: HOST
  });
  const previousRoot = process.env.AOS_RUNNER_DEFAULT_PROJECT;
  const previousToken = process.env.MOBILE_TESTING_RUNNER_JOB_TOKEN;
  process.env.AOS_RUNNER_DEFAULT_PROJECT = rootPath;
  process.env.MOBILE_TESTING_RUNNER_JOB_TOKEN = TOKEN;
  const handle = await createAosHttpServer({ port: 0, host: "127.0.0.1", store });
  const restore = () => {
    if (previousRoot === undefined) delete process.env.AOS_RUNNER_DEFAULT_PROJECT;
    else process.env.AOS_RUNNER_DEFAULT_PROJECT = previousRoot;
    if (previousToken === undefined) delete process.env.MOBILE_TESTING_RUNNER_JOB_TOKEN;
    else process.env.MOBILE_TESTING_RUNNER_JOB_TOKEN = previousToken;
  };
  return { rootPath, task, handle, restore };
}

test("runner evidence: uploads allowed status/stderr files", async () => {
  const { rootPath, task, handle, restore } = await makeServer();
  try {
    const body = {
      rootPath,
      taskId: task.id,
      caseId: "case-1",
      traceId: "trace-1",
      files: [
        {
          name: "stderr.log",
          contentBase64: Buffer.from("LLMExhaustedError: Connection error.", "utf8").toString(
            "base64"
          )
        }
      ]
    };
    const response = await fetch(
      `http://127.0.0.1:${handle.port}/panel/api/runners/suite/tasks/${task.id}/evidence`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${TOKEN}`,
          "x-aos-host-id": HOST,
          "content-type": "application/json"
        },
        body: JSON.stringify(body)
      }
    );
    assert.equal(response.status, 200, await response.text());
    const saved = path.join(
      rootPath,
      ".artemis",
      "remote-evidence",
      task.id,
      "trace-1",
      "stderr.log"
    );
    assert.equal(fs.readFileSync(saved, "utf8"), "LLMExhaustedError: Connection error.");
  } finally {
    await handle.close();
    restore();
  }
});

test("runner evidence: accepts native structured evidence", async () => {
  const { rootPath, task, handle, restore } = await makeServer();
  try {
    const response = await fetch(
      `http://127.0.0.1:${handle.port}/panel/api/runners/suite/tasks/${task.id}/evidence`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${TOKEN}`,
          "x-aos-host-id": HOST,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          rootPath,
          taskId: task.id,
          caseId: "case-1",
          traceId: "trace-native",
          files: [
            {
              name: "native-ios.json",
              contentBase64: Buffer.from('{"actions":[]}', "utf8").toString("base64")
            },
            {
              name: "native-android.json",
              contentBase64: Buffer.from('{"steps":[]}', "utf8").toString("base64")
            },
            {
              name: "execution-evidence.json",
              contentBase64: Buffer.from('{"schemaVersion":1}', "utf8").toString("base64")
            },
            {
              name: "evidence-shot-1.png",
              contentBase64: Buffer.from("fake-png").toString("base64")
            },
            {
              name: "evidence-ax.json",
              contentBase64: Buffer.from('{"schemaVersion":1}', "utf8").toString("base64")
            },
            {
              name: "ax-final.json",
              contentBase64: Buffer.from('{"nodes":[]}', "utf8").toString("base64")
            }
          ]
        })
      }
    );
    assert.equal(response.status, 200, await response.text());
    const dir = path.join(rootPath, ".artemis", "remote-evidence", task.id, "trace-native");
    assert.equal(fs.readFileSync(path.join(dir, "native-ios.json"), "utf8"), '{"actions":[]}');
    assert.equal(fs.readFileSync(path.join(dir, "native-android.json"), "utf8"), '{"steps":[]}');
    assert.equal(
      fs.readFileSync(path.join(dir, "execution-evidence.json"), "utf8"),
      '{"schemaVersion":1}'
    );
    assert.equal(fs.readFileSync(path.join(dir, "evidence-shot-1.png"), "utf8"), "fake-png");
    assert.equal(
      fs.readFileSync(path.join(dir, "evidence-ax.json"), "utf8"),
      '{"schemaVersion":1}'
    );
    assert.equal(fs.readFileSync(path.join(dir, "ax-final.json"), "utf8"), '{"nodes":[]}');
  } finally {
    await handle.close();
    restore();
  }
});

test("runner evidence: trims the batch instead of rejecting the whole package", async () => {
  const { rootPath, task, handle, restore } = await makeServer();
  try {
    const files = [
      {
        name: "execution-evidence.json",
        contentBase64: Buffer.from('{"schemaVersion":1}', "utf8").toString("base64")
      },
      ...Array.from({ length: 5 }, (_, index) => ({
        name: `evidence-shot-${index + 1}.png`,
        contentBase64: Buffer.alloc(250 * 1024, index + 1).toString("base64")
      }))
    ];
    const response = await fetch(
      `http://127.0.0.1:${handle.port}/panel/api/runners/suite/tasks/${task.id}/evidence`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${TOKEN}`,
          "x-aos-host-id": HOST,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          rootPath,
          taskId: task.id,
          caseId: "case-1",
          traceId: "trace-budget",
          files
        })
      }
    );
    const payload = await response.json();
    assert.equal(response.status, 200, JSON.stringify(payload));
    assert.ok(payload.value.saved.some((name) => name.endsWith("execution-evidence.json")));
    assert.ok(payload.value.skipped.includes("evidence-shot-5.png"));
    const dir = path.join(rootPath, ".artemis", "remote-evidence", task.id, "trace-budget");
    assert.ok(fs.existsSync(path.join(dir, "execution-evidence.json")));
    assert.equal(fs.existsSync(path.join(dir, "evidence-shot-5.png")), false);
  } finally {
    await handle.close();
    restore();
  }
});

test("runner evidence: rejects disallowed names", async () => {
  const { rootPath, task, handle, restore } = await makeServer();
  try {
    const response = await fetch(
      `http://127.0.0.1:${handle.port}/panel/api/runners/suite/tasks/${task.id}/evidence`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${TOKEN}`,
          "x-aos-host-id": HOST,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          rootPath,
          taskId: task.id,
          caseId: "case-1",
          traceId: "trace-1",
          files: [{ name: "../../escape", contentBase64: "" }]
        })
      }
    );
    assert.equal(response.status, 409);
  } finally {
    await handle.close();
    restore();
  }
});
