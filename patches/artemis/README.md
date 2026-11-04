# ARTEMIS downstream patches

`artemis/` is an upstream submodule; AOS changes are carried as patch files here
so a fresh clone still checks out the upstream commit.

Apply after `git submodule update --init --recursive`:

```bash
node scripts/apply-artemis-patches.mjs
```

- `0001-aos-web-llm-hooks.patch` — PATCH (aos-mcp) security hooks for web LLM:
  text/screenshot redaction, action placeholder injection, storage/trace
  redaction, and LLM boundary text redaction.
- Requires `AOS_LLM_HOOKS=1` and `AOS_LLM_SECRET_FILE` (the center worker writes
  the project-scoped 0600 JSON file).
- Re-apply after submodule updates; verify with
  `artemis/.venv/bin/python -m pytest artemis/tests/unit/security/test_redaction.py`.
