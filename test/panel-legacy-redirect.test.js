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
  assert.match(jobs.headers.Location, /section=tasks/);

  const review = await redirect("http://x/panel?project=%2Fw%2Fp&view=review");
  assert.equal(review.status, 302);
  assert.match(review.headers.Location, /section=tasks/);
  assert.match(review.headers.Location, /view=review/);

  const pkg = await redirect("http://x/panel?project=%2Fw%2Fp&section=assets&kind=package");
  assert.equal(pkg.status, 302);
  assert.match(pkg.headers.Location, /section=assets/);
  assert.match(pkg.headers.Location, /tab=packages/);
  assert.doesNotMatch(pkg.headers.Location, /kind=package/);
});
