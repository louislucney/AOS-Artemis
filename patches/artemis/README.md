# ARTEMIS downstream patches

`artemis/` is an upstream submodule; AOS changes are carried as patch files here
so a fresh clone still checks out the upstream commit.

Apply after `git submodule update --init --recursive`:

```bash
node scripts/apply-artemis-patches.mjs
```

- `0001-aos-web-llm-hooks.patch` — PATCH (aos-mcp) security hooks for web LLM:
  text/screenshot redaction, action placeholder injection, storage/trace
  redaction, and LLM boundary text redaction; plus non-Google provider redirect
  (`AOS_LLM_REDIRECT_GOOGLE=1`) that maps residual `get_google_llm` /
  lightweight-judge paths to the selected OpenAI-compatible LLM.
- Requires `AOS_LLM_HOOKS=1` and `AOS_LLM_SECRET_FILE` (the center worker writes
  the project-scoped 0600 JSON file).
- Hook API version: `AOS_HOOK_API_VERSION = 1`; `npm run artemis:patch` rejects a
  mismatched submodule instead of running without redaction.
- Missing screenshot bounds: strict fallback to a 1×1 black image (`drop`);
  `AOS_LLM_REDACT_IMAGE_FALLBACK=none|blur` overrides.
- Re-apply after submodule updates; verify with
  `artemis/.venv/bin/python -m pytest artemis/tests/unit/security/test_redaction.py`.
