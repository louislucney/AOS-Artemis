import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
    await run(base, server, workRoot);
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

async function waitTerminal(base, jobId, headers = {}) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await fetch(`${base}/jobs/${jobId}`, { headers });
    const body = await response.json();
    if (["done", "failed", "cancelled"].includes(body.status)) return body;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("job did not finish");
}

async function waitStatus(base, jobId, status, headers = {}) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await fetch(`${base}/jobs/${jobId}`, { headers });
    const body = await response.json();
    if (body.status === status) return body;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`job did not reach ${status}`);
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
    assert.equal("artifactPath" in job, false, "状态响应不暴露服务端路径");
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

test("server: completed jobs survive restart (metadata + artifact)", async () => {
  const workRoot = await mkdtemp(join(tmpdir(), "aos-cms-open-restart-"));
  let jobId = "";
  const server1 = await startCmsOpenServer({
    port: 0,
    host: "127.0.0.1",
    workRoot,
    runner: zipRunner
  });
  try {
    const created = await fetch(`http://127.0.0.1:${server1.port}/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: { type: "figma", url: "https://www.figma.com/design/ABC/demo" } })
    });
    jobId = (await created.json()).jobId;
    await waitTerminal(`http://127.0.0.1:${server1.port}`, jobId);
  } finally {
    await server1.close();
  }

  const server2 = await startCmsOpenServer({
    port: 0,
    host: "127.0.0.1",
    workRoot,
    runner: zipRunner
  });
  try {
    const base = `http://127.0.0.1:${server2.port}`;
    const job = await (await fetch(`${base}/jobs/${jobId}`)).json();
    assert.equal(job.status, "done");
    const download = await fetch(`${base}/jobs/${jobId}/download`);
    assert.equal(download.status, 200);
  } finally {
    await server2.close();
    await rm(workRoot, { recursive: true, force: true });
  }
});

test("server: running jobs become job_interrupted after restart", async () => {
  const workRoot = await mkdtemp(join(tmpdir(), "aos-cms-open-interrupt-"));
  const never = new Promise(() => {});
  const server1 = await startCmsOpenServer({
    port: 0,
    host: "127.0.0.1",
    workRoot,
    runner: async () => never
  });
  let jobId = "";
  try {
    const base = `http://127.0.0.1:${server1.port}`;
    const created = await fetch(`${base}/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: { type: "figma", url: "https://www.figma.com/design/ABC/demo" } })
    });
    jobId = (await created.json()).jobId;
    await waitStatus(base, jobId, "running");
  } finally {
    await server1.close();
  }

  const server2 = await startCmsOpenServer({
    port: 0,
    host: "127.0.0.1",
    workRoot,
    runner: zipRunner
  });
  try {
    const job = await (await fetch(`http://127.0.0.1:${server2.port}/jobs/${jobId}`)).json();
    assert.equal(job.status, "failed");
    assert.equal(job.error.code, "job_interrupted");
  } finally {
    await server2.close();
    await rm(workRoot, { recursive: true, force: true });
  }
});

test("server: startup removes orphan work directories", async () => {
  const workRoot = await mkdtemp(join(tmpdir(), "aos-cms-open-orphan-"));
  const orphan = join(workRoot, "orphan-job");
  await mkdir(orphan, { recursive: true });
  await writeFile(join(orphan, "leftover.txt"), "x");
  const server = await startCmsOpenServer({
    port: 0,
    host: "127.0.0.1",
    workRoot,
    runner: zipRunner
  });
  try {
    assert.equal(existsSync(orphan), false);
  } finally {
    await server.close();
    await rm(workRoot, { recursive: true, force: true });
  }
});

test("server: tick removes expired job record and work directory", async () => {
  const workRoot = await mkdtemp(join(tmpdir(), "aos-cms-open-expire-"));
  const server = await startCmsOpenServer({
    port: 0,
    host: "127.0.0.1",
    workRoot,
    retentionMs: 1,
    runner: zipRunner
  });
  try {
    const base = `http://127.0.0.1:${server.port}`;
    const created = await fetch(`${base}/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: { type: "figma", url: "https://www.figma.com/design/ABC/demo" } })
    });
    const { jobId } = await created.json();
    await waitTerminal(base, jobId);
    const jobDir = join(workRoot, jobId);
    assert.equal(existsSync(jobDir), true);
    await new Promise((resolve) => setTimeout(resolve, 5));
    server.tick();
    assert.equal(existsSync(jobDir), false);
    const missing = await fetch(`${base}/jobs/${jobId}`);
    assert.equal(missing.status, 404);
  } finally {
    await server.close();
    await rm(workRoot, { recursive: true, force: true });
  }
});

test("server: bearer token protects all endpoints except healthz", async () => {
  await withServer({ runner: zipRunner, authToken: "secret" }, async (base) => {
    const health = await fetch(`${base}/healthz`);
    assert.equal(health.status, 200);

    const payload = JSON.stringify({
      source: { type: "figma", url: "https://www.figma.com/design/ABC/demo" }
    });
    const denied = await fetch(`${base}/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: payload
    });
    assert.equal(denied.status, 401);
    assert.match(denied.headers.get("www-authenticate") ?? "", /Bearer/);
    assert.equal((await denied.json()).code, "unauthorized");

    const wrong = await fetch(`${base}/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer nope" },
      body: payload
    });
    assert.equal(wrong.status, 401);

    const created = await fetch(`${base}/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer secret" },
      body: payload
    });
    assert.equal(created.status, 202);
    const { jobId } = await created.json();
    const auth = { authorization: "Bearer secret" };
    await waitTerminal(base, jobId, auth);
    const polled = await fetch(`${base}/jobs/${jobId}`, { headers: auth });
    assert.equal(polled.status, 200);
    const unauthenticated = await fetch(`${base}/jobs/${jobId}`);
    assert.equal(unauthenticated.status, 401);

    const preflight = await fetch(`${base}/jobs`, {
      method: "OPTIONS",
      headers: { origin: "https://cms.example" }
    });
    assert.equal(preflight.status, 204);
  });
});

test("server: persisted jobs never contain request credentials", async () => {
  const workRoot = await mkdtemp(join(tmpdir(), "aos-cms-open-secrets-"));
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const server = await startCmsOpenServer({
    port: 0,
    host: "127.0.0.1",
    workRoot,
    runner: async (input, workDir) => {
      await gate;
      return zipRunner(input, workDir);
    }
  });
  try {
    const base = `http://127.0.0.1:${server.port}`;
    const created = await fetch(`${base}/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        source: {
          type: "figma",
          url: "https://www.figma.com/design/ABC/demo",
          token: "figd_secret"
        },
        llm: { baseUrl: "https://api.example.com/v1", model: "m", apiKey: "sk_secret" }
      })
    });
    const { jobId } = await created.json();
    await waitStatus(base, jobId, "running");
    const persisted = await readFile(join(workRoot, "jobs.json"), "utf-8");
    assert.doesNotMatch(persisted, /figd_secret|sk_secret/);
    release();
    await waitTerminal(base, jobId);
  } finally {
    await server.close();
    await rm(workRoot, { recursive: true, force: true });
  }
});

test("server: rate limit per client (healthz exempt, window resets)", async () => {
  let now = 1_000_000;
  await withServer(
    { runner: zipRunner, rateLimitPerMinute: 2, now: () => now },
    async (base) => {
      for (let index = 0; index < 2; index += 1) {
        const response = await fetch(`${base}/jobs/missing`);
        assert.equal(response.status, 404);
      }
      const limited = await fetch(`${base}/jobs/missing`);
      assert.equal(limited.status, 429);
      const body = await limited.json();
      assert.equal(body.code, "rate_limited");
      assert.match(String(limited.headers.get("retry-after")), /^\d+$/);

      const health = await fetch(`${base}/healthz`);
      assert.equal(health.status, 200, "健康检查不受限流");

      now += 60_001;
      const afterWindow = await fetch(`${base}/jobs/missing`);
      assert.equal(afterWindow.status, 404, "窗口过后恢复");
    }
  );
});
