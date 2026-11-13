import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { allocateSequencedSecrets } from "../dist/tasks/secret-sequence.js";

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aos-secret-seq-"));
  return { stateFile: path.join(dir, ".artemis", "secret-sequences.json") };
}

test("secret sequence: +202 的 email/confirm 同组递增到 203、204", () => {
  const { stateFile } = fixture();
  const secrets = [
    { alias: "reg_email", value: "testwithgu+202@gmail.com", kind: "account", label: "Email" },
    {
      alias: "reg_email_confirm",
      value: "testwithgu+202@gmail.com",
      kind: "account",
      label: "Confirm"
    },
    { alias: "reg_phone", value: "6953512", kind: "account" }
  ];
  const first = allocateSequencedSecrets({ secrets, stateFile });
  assert.equal(first[0].value, "testwithgu+203@gmail.com");
  assert.equal(first[1].value, "testwithgu+203@gmail.com");
  assert.equal(first[2].value, "6953512");

  const second = allocateSequencedSecrets({ secrets, stateFile });
  assert.equal(second[0].value, "testwithgu+204@gmail.com");
  assert.equal(second[1].value, "testwithgu+204@gmail.com");
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  assert.equal(
    state["testwithgu@gmail.com#202"].last,
    204
  );
});

test("secret sequence: 不同 base/起始号独立分组；基线上调时从更高值继续", () => {
  const { stateFile } = fixture();
  const a = allocateSequencedSecrets({
    secrets: [
      { alias: "a", value: "one+10@example.com", kind: "account" },
      { alias: "b", value: "two+10@example.com", kind: "account" }
    ],
    stateFile
  });
  assert.equal(a[0].value, "one+11@example.com");
  assert.equal(a[1].value, "two+11@example.com");

  const b = allocateSequencedSecrets({
    secrets: [{ alias: "a", value: "one+20@example.com", kind: "account" }],
    stateFile
  });
  assert.equal(b[0].value, "one+21@example.com");
});
