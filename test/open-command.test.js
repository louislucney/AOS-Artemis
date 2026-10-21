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
  for (const flag of ["--cors", "--max-queue", "--job-timeout-ms", "--retention-ms", "--check"]) {
    assert.match(text, new RegExp(flag));
  }
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
