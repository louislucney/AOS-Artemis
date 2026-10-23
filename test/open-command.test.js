import assert from "node:assert/strict";
import test from "node:test";

import { runCmsOpen } from "../dist/open/command.js";

test("cms-open: invalid port exits 2", async () => {
  const errors = [];
  const code = await runCmsOpen(["--port", "abc"], {
    errorLog: (line) => errors.push(line)
  });
  assert.equal(code, 2);
  assert.match(errors.join("\n"), /--port/);
});

test("cms-open: help lists flags", async () => {
  const lines = [];
  const code = await runCmsOpen(["--help"], { log: (line) => lines.push(line) });
  assert.equal(code, 0);
  const text = lines.join("\n");
  for (const flag of ["--cors", "--max-queue", "--rate-limit", "--max-jobs-per-day", "--job-timeout-ms", "--retention-ms", "--token", "--check"]) {
    assert.match(text, new RegExp(flag));
  }
});

test("cms-open: --token enables bearer auth (flag and env)", async () => {
  const flagLines = [];
  const flagCode = await runCmsOpen(["--port", "0", "--check", "--token", "secret"], {
    log: (line) => flagLines.push(line)
  });
  assert.equal(flagCode, 0);
  assert.match(flagLines.join("\n"), /鉴权.*Bearer/);

  const envLines = [];
  const envCode = await runCmsOpen(["--port", "0", "--check"], {
    env: { AOS_CMS_OPEN_TOKEN: "env-secret" },
    log: (line) => envLines.push(line)
  });
  assert.equal(envCode, 0);
  assert.match(envLines.join("\n"), /鉴权.*Bearer/);
});

test("cms-open: --check starts, warns on 0.0.0.0, and exits", async () => {
  const lines = [];
  const code = await runCmsOpen(["--port", "0", "--host", "0.0.0.0", "--check"], {
    log: (line) => lines.push(line)
  });
  assert.equal(code, 0);
  assert.match(lines.join("\n"), /WARN 监听 0\.0\.0\.0/);
  assert.match(lines.join("\n"), /自检通过/);
});

test("cms-open: rate limit flag/env validated and logged", async () => {
  const lines = [];
  const code = await runCmsOpen(["--port", "0", "--check", "--rate-limit", "60"], {
    log: (line) => lines.push(line)
  });
  assert.equal(code, 0);
  assert.match(lines.join("\n"), /限流: 60 次\/分钟\/客户端/);

  const errors = [];
  const badFlag = await runCmsOpen(["--rate-limit", "-1"], {
    errorLog: (line) => errors.push(line)
  });
  assert.equal(badFlag, 2);
  assert.match(errors.join("\n"), /--rate-limit/);

  const envErrors = [];
  const badEnv = await runCmsOpen(["--port", "0", "--check"], {
    env: { AOS_CMS_OPEN_RATE_LIMIT: "abc" },
    errorLog: (line) => envErrors.push(line)
  });
  assert.equal(badEnv, 2);
  assert.match(envErrors.join("\n"), /--rate-limit/);
});

test("cms-open: daily job quota flag/env validated and logged", async () => {
  const lines = [];
  const code = await runCmsOpen(["--port", "0", "--check", "--max-jobs-per-day", "5"], {
    log: (line) => lines.push(line)
  });
  assert.equal(code, 0);
  assert.match(lines.join("\n"), /每日任务配额: 5 次\/客户端\/UTC 日/);

  const envLines = [];
  const envCode = await runCmsOpen(["--port", "0", "--check"], {
    env: { AOS_CMS_OPEN_MAX_JOBS_PER_DAY: "9" },
    log: (line) => envLines.push(line)
  });
  assert.equal(envCode, 0);
  assert.match(envLines.join("\n"), /每日任务配额: 9/);

  const errors = [];
  const bad = await runCmsOpen(["--max-jobs-per-day", "abc"], {
    errorLog: (line) => errors.push(line)
  });
  assert.equal(bad, 2);
  assert.match(errors.join("\n"), /--max-jobs-per-day/);
});
