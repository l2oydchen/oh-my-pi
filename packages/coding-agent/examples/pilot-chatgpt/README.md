# Pilot / ChatGPT development validation

This is a development-only overlay and a copy of the project's Pilot metrics extension. Neither file is installed into the daily OMP release or the project's live extension directory.

Merge `config.yml` into an isolated development profile when testing this checkout. `extendedContext` enables the maximum window advertised by model discovery. Current account observations were 272,000 / 872,000 for Astra and 500,000 / 872,000 for Sol (standard / maximum); these numbers are not hardcoded. An online model refresh is needed to replace old cached entries that lack capacity metadata.

`openai-chatgpt/*: f500000` sets an exact 500,000-token compaction point only for subscription GPT models. OMP checks for usage **above** that point at its normal compaction checkpoints. If a future account window is smaller, the existing context reserve safety policy takes precedence. Other providers retain their settings. Per-agent threshold overrides still take precedence.

The extension reports `contextTokens`, `contextWindow`, `contextPercent`, and whether the child has ever compacted (`compacted`). Unknown capacity is `null`, not a misleading zero percent; model switches replace stale measurements. Token usage remains OMP's provider-usage-based estimate, not a live server meter. Successful automatic or manual compaction marks `compacted`; failed/aborted automatic attempts do not.

Rotation rules are unchanged: five calls, any successful compaction, usage above 40%, or usage above 400,000 tokens. At an 872,000-token window, the 40% rule can request rotation above 348,800 tokens, before automatic compaction at 500,000. Percentages retain the existing two-decimal rounding.

Offline tests use fake model-directory responses, in-memory credentials, numeric usage fixtures, and extension events. They send no inference requests and do not construct a 500K-token prompt. Run from the checkout with the isolated `omp-bun.ps1` wrapper:

```powershell
& ../omp-bun.ps1 test packages/catalog/test/openai-chatgpt-discovery.test.ts packages/coding-agent/test/model-registry-chatgpt-discovery.test.ts packages/coding-agent/test/pilot-session-metrics.test.ts
```

Deployment into the fixed daily release, real user config, and live project extension is intentionally deferred until a separate rollout after the running task has finished.

Validation (2026-11-18): 55 focused tests passed across discovery, registry/session usage, Pilot, and compaction settings; the registry test additionally checks an actual `AgentSession` reading 235,982 tokens against an 872,000-token discovered window. Workspace `check:ts` passed with existing unrelated lint warnings. No live authentication or inference was needed.

A separate authorized live smoke test on the same date made one model-directory request and one short Astra inference. The server confirmed the windows above and returned `OK` with 14 input and 5 output tokens. The development session reported 14 / 872,000 (approximately 0.001606%); Pilot retained the same capacity and usage, rounding the percentage to 0.00%, with `compacted: false`. The resolved compaction threshold was 500,000. No large-context inference or real compaction was performed, and no live credentials were refreshed or written back. Temporary probe files and credentials are not included in this example.
