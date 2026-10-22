import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { startCmsOpenServer } from "../dist/open/server.js";

async function withServer(options, run) {
  const workRoot = await mkdtemp(join(tmpdir(), "aos-cms-open-"));
  const server = await startCmsOpenServer({
    port: 0,
    host: "127.0.0.1",
    workRoot,
    cors: ["https://cms.example"],
    ...options
  });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    await run(base, server);
  } finally {
    await server.close();
    await rm(workRoot, { recursive: true, force: true });
  }
}

async function zipRunner(_input, workDir) {
  await mkdir(workDir, { recursive: true });
  const zipPath = join(workDir, "result.zip");
  await writeFile(zipPath, Buffer.from("PK\u0003\u0004stub"));
  return { zipPath, counts: { screens: 1, cases: 1 }, warnings: [] };
}

async function waitTerminal(base, jobId) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await fetch(`${base}/jobs/${jobId}`);
    const body = await response.json();
    if (["done", "failed", "cancelled"].includes(body.status)) return body;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("job did not finish");
}

test("server: create -> poll -> download", async () => {
  await withServer({ runner: zipRunner }, async (base) => {
    const created = await fetch(`${base}/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        source: { type: "figma", url: "https://www.figma.com/design/ABC/demo", token: "t" },
        llm: null
      })
    });
    assert.equal(created.status, 202);
    const { jobId } = await created.json();
    const job = await waitTerminal(base, jobId);
    assert.equal(job.status, "done");
    const download = await fetch(`${base}/jobs/${jobId}/download`);
    assert.equal(download.status, 200);
    assert.match(download.headers.get("content-disposition"), /design-tests-/);
  });
});

test("server: unknown job, not-ready and expired", async () => {
  await withServer({ runner: zipRunner }, async (base) => {
    const missing = await fetch(`${base}/jobs/nope`);
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).code, "job_not_found");

    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const slowRunner = async (input, workDir) => {
      await gate;
      return zipRunner(input, workDir);
    };
    const server2 = await startCmsOpenServer({
      port: 0,
      host: "127.0.0.1",
      workRoot: join(tmpdir(), `aos-cms-open-${Date.now()}`),
      runner: slowRunner
    });
    try {
      const created = await fetch(`http://127.0.0.1:${server2.port}/jobs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source: { type: "figma", url: "https://www.figma.com/design/ABC/demo" } })
      });
      const { jobId } = await created.json();
      const notReady = await fetch(`http://127.0.0.1:${server2.port}/jobs/${jobId}/download`);
      assert.equal(notReady.status, 409);
      release();
      await waitTerminal(`http://127.0.0.1:${server2.port}`, jobId);
    } finally {
      await server2.close();
    }
  });
});

test("server: expired artifact returns 410", async () => {
  await withServer(
    {
      runner: async (_input, workDir) => {
        await mkdir(workDir, { recursive: true });
        return {
          zipPath: join(workDir, "missing.zip"),
          counts: { screens: 0, cases: 0 },
          warnings: []
        };
      }
    },
    async (base) => {
      const created = await fetch(`${base}/jobs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source: { type: "figma", url: "https://www.figma.com/design/ABC/demo" } })
      });
      const { jobId } = await created.json();
      await waitTerminal(base, jobId);
      const download = await fetch(`${base}/jobs/${jobId}/download`);
      assert.equal(download.status, 410);
    }
  );
});

test("server: cors default rejects cross-origin and multipart is parsed", async () => {
  await withServer({ runner: zipRunner, cors: [] }, async (base) => {
    const denied = await fetch(`${base}/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://evil.example" },
      body: JSON.stringify({ source: { type: "figma", url: "https://www.figma.com/design/ABC/demo" } })
    });
    assert.equal(denied.status, 403);
  });

  let captured = null;
  await withServer(
    {
      cors: ["https://cms.example"],
      runner: async (input, workDir) => {
        captured = input;
        return zipRunner(input, workDir);
      }
    },
    async (base) => {
      const form = new FormData();
      form.set("source", "pen");
      form.set("staticFallback", "false");
      form.set("llm", JSON.stringify({ baseUrl: "https://api.example.com/v1", model: "m", apiKey: "k" }));
      form.set("penFile", new Blob([Buffer.from("{}")], { type: "application/octet-stream" }), "design.pen");
      form.set("template", new Blob([Buffer.from("x")], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), "t.xlsx");
      const response = await fetch(`${base}/jobs`, {
        method: "POST",
        headers: { origin: "https://cms.example" },
        body: form
      });
      assert.equal(response.status, 202);
      assert.equal(response.headers.get("access-control-allow-origin"), "https://cms.example");
      const { jobId } = await response.json();
      await waitTerminal(base, jobId);
      assert.equal(captured.source, "pen");
      assert.equal(captured.staticFallback, false);
      assert.match(captured.penFile, /design\.pen$/);
      assert.match(captured.templatePath, /\.xlsx$/);
    }
  );
});

test("server: json body limit", async () => {
  await withServer({ runner: zipRunner }, async (base) => {
    const huge = JSON.stringify({ pad: "x".repeat(1_100_000) });
    const response = await fetch(`${base}/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: huge
    });
    assert.equal(response.status, 413);
  });
});

test("server: cancelling a running job", async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  await withServer(
    {
      runner: async (input, workDir) => {
        await gate;
        return zipRunner(input, workDir);
      }
    },
    async (base) => {
      const created = await fetch(`${base}/jobs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source: { type: "figma", url: "https://www.figma.com/design/ABC/demo" } })
      });
      const { jobId } = await created.json();
      await new Promise((resolve) => setTimeout(resolve, 30));
      const cancel = await fetch(`${base}/jobs/${jobId}`, { method: "DELETE" });
      assert.equal(cancel.status, 200);
      assert.equal((await cancel.json()).cancelRequested, true);
      release();
      const job = await waitTerminal(base, jobId);
      assert.equal(job.status, "cancelled");
    }
  );
});
