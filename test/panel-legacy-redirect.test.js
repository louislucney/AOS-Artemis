import assert from "node:assert/strict";
import test from "node:test";

import { MemoryStore } from "../dist/db/memory.js";
import { handlePanelRequest } from "../dist/panel/web.js";

function deps() {
  return { store: new MemoryStore(), env: {} };
}

function redirect(url) {
  return handlePanelRequest(new URL(url), deps(), { legacyRedirect: true });
}

test("legacy panel routes 302 to the new IA", async () => {
  const library = await redirect("http://x/panel?project=%2Fw%2Fp&host=h&section=library");
  assert.equal(library.status, 302);
  assert.match(library.headers.Location, /section=assets/);
  assert.match(library.headers.Location, /tab=case-sets/);
  assert.doesNotMatch(library.headers.Location, /section=library/);

  const dispatch = await redirect(
    "http://x/panel?project=%2Fw%2Fp&section=dispatch&source=case-set&ref=set-1"
  );
  assert.equal(dispatch.status, 302);
  assert.match(dispatch.headers.Location, /section=create/);
  assert.match(dispatch.headers.Location, /type=suite/);
  assert.match(dispatch.headers.Location, /source=case-set/);
  assert.match(dispatch.headers.Location, /ref=set-1/);

  const jobs = await redirect("http://x/panel?project=%2Fw%2Fp&section=jobs");
  assert.equal(jobs.status, 302);
  assert.match(jobs.headers.Location, /section=create/);
  assert.match(jobs.headers.Location, /type=web/);

  const jobDetail = await redirect(
    "http://x/panel?project=%2Fw%2Fp&section=jobs&job=job-1&host=h"
  );
  assert.equal(jobDetail.status, 302);
  assert.match(jobDetail.headers.Location, /section=tasks/);
  assert.match(jobDetail.headers.Location, /task=job-1/);
  assert.doesNotMatch(jobDetail.headers.Location, /job=job-1/);
  const jobAgain = await redirect(`http://x${jobDetail.headers.Location}`).catch(() => null);
  assert.notEqual(jobAgain?.status, 302);

  const legacyTask = await redirect("http://x/panel?project=%2Fw%2Fp&task=task-1&host=h");
  assert.equal(legacyTask.status, 302);
  assert.match(legacyTask.headers.Location, /section=tasks/);
  assert.match(legacyTask.headers.Location, /task=task-1/);

  const review = await redirect("http://x/panel?project=%2Fw%2Fp&view=review");
  assert.equal(review.status, 302);
  assert.match(review.headers.Location, /section=tasks/);
  assert.match(review.headers.Location, /view=review/);

  // 重定向目标必须幂等，不能再 302（否则 JSON 客户端会陷入重定向循环）。
  const reviewAgain = await redirect(`http://x${review.headers.Location}`);
  assert.notEqual(reviewAgain.status, 302);

  const stats = await redirect("http://x/panel?project=%2Fw%2Fp&section=tasks&view=stats");
  assert.notEqual(stats.status, 302);

  const pkg = await redirect("http://x/panel?project=%2Fw%2Fp&section=assets&kind=package");
  assert.equal(pkg.status, 302);
  assert.match(pkg.headers.Location, /section=assets/);
  assert.match(pkg.headers.Location, /tab=packages/);
  assert.doesNotMatch(pkg.headers.Location, /kind=package/);

  // JSON 视图保持旧契约，不参与 302。
  const json = await redirect("http://x/panel.json?project=%2Fw%2Fp&view=review");
  assert.notEqual(json.status, 302);
});
