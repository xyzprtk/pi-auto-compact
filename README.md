# pi-auto-compact-threshold

A small [Pi](https://pi.dev) extension that automatically compacts a session using a context-window-aware percentage threshold.

The current release is `0.2.0`. The extension uses Pi's own `ctx.getContextUsage()` and `ctx.compact()` APIs. It does not estimate the context window from a hard-coded token count, and it does not add a second summarization implementation.

## Behavior

- Checks usage after each agent run reaches `agent_settled`.
- Uses a tiered percentage threshold based on the active model's context window.
- Starts at most one compaction at a time.
- Rearms after a successful compaction only when usage later falls to or below the active threshold and crosses it again.
- Retries the threshold after a failed or aborted compaction.
- Observes successful and failed compactions started elsewhere in Pi, so manual compaction also satisfies the current crossing.
- Resets its state when the session or model changes.
- Shows a notification when UI output is available and reports compaction failures without interrupting the session.
- Reports the active threshold and current usage on demand through `/auto-compact-status`.

The check happens after a run settles rather than in the middle of a tool-calling turn. This lets the current turn finish normally, then reduces the context before the next user prompt. Because the check never runs during a live turn, it cannot abort work that is already in progress.

## Threshold policy

The base threshold is percentage-based so very large context windows retain the intended ratio:

| Active context window | Base threshold | Example trigger |
|---:|---:|---:|
| Below 250K | 50% | 128K context → 64K |
| 250K–499K | 50% | 250K context → 125K |
| 500K–999K | 55% | 500K context → 275K |
| 1M or larger | 40% | 1M context → 400K; 2M context → 800K |

For small contexts, a 22K-token safety floor prevents compaction from triggering before Pi has enough older material to summarize. For example, a 32K model compacts just above 22K rather than at 16K. Models with a context window below 22K are left to Pi's native compaction policy.

At exactly the calculated threshold, the extension does not compact; it compacts only after usage crosses above it.

## Checking the active threshold

Run `/auto-compact-status` to see the current usage, the threshold in effect, and which tier produced it:

```
Auto-compact: 100.0K of 250.0K (40.0%) | threshold 125.0K (50.0%, standard tier) | below threshold, armed
```

The final field reports what the extension will do next. It is one of:

| State | Meaning |
|---|---|
| `below threshold, armed` | Usage is under the threshold. A crossing will trigger a compaction. |
| `over threshold, compacts on the next settled run` | Usage is above the threshold and a compaction is armed. |
| `over threshold, waiting for usage to fall back below it to rearm` | A compaction already ran at this crossing. The extension waits for usage to drop back under the threshold before arming again. |
| `compaction in flight` | A compaction started and has not reported completion yet. |
| `below the safety floor, left to Pi's native policy` | The context window is under 22K, so the extension never fires and Pi's own policy applies. |

The command only reads state. It never triggers a compaction and never sends a prompt to the model.

Context usage is reported by Pi and is not available until a model response has been measured. Right after a compaction it can also be reported as unknown, in which case the command says so instead of printing a number.

## Configuration scope and future exclusions

The current release uses the fixed tiered policy above and does not yet expose per-session or per-model exclusion settings. A future v2 release can support those without changing the compaction mechanism:

- A session-level on/off toggle can persist a custom session entry and restore the setting when the session is resumed.
- A model-level exclusion can match the active provider and model ID before starting an extension-triggered compaction.
- A model switch can re-evaluate the active model-specific policy.

These exclusions would apply to this extension's automatic threshold trigger. They would not disable Pi's native compaction, manual `/compact`, or overflow recovery. Disabling all automatic compaction should remain a Pi compaction setting rather than an extension-level override.

The proposed v2 behavior and open design questions are recorded in [docs/v2.md](docs/v2.md).

## Requirements

- Node.js `>=22.19.0`
- Pi with `@earendil-works/pi-coding-agent` available as a peer dependency

## Install

### From a local checkout

From the directory that contains this package:

```bash
pi install /absolute/path/to/pi-auto-compact
```

For a quick test without installing:

```bash
pi -e /absolute/path/to/pi-auto-compact/src/index.ts
```

### Directly from GitHub

Anyone with access to the public repository can install the current `main` branch directly:

```bash
pi install git:github.com/xyzprtk/pi-auto-compact
```

The repository contains a `package.json` with a Pi package manifest and the `pi-package` keyword, so Pi can clone the repository, install its package dependencies, and load `src/index.ts` as the extension.

For a fork, replace `xyzprtk` with the fork owner:

```bash
pi install git:github.com/<owner>/pi-auto-compact
```

### From npm after publishing

```bash
pi install npm:pi-auto-compact-threshold
```

The npm command becomes available after the package is published to npm. The package uses the `pi-package` keyword and declares its extension entry in `package.json`, so it can also be installed as a local Pi package directory.

## Development

```bash
npm install
npm run typecheck
npm run test:unit
npm run test:e2e
npm run check
```

The end-to-end test starts Pi in RPC mode with a local mock OpenAI-compatible provider. It verifies that the extension is discovered by the real Pi runtime, crosses the threshold, sends a real compaction request, and completes without an overlapping second compaction.

## Design notes

Pi's normal automatic compaction remains enabled. This extension adds an earlier, model-aware policy threshold and delegates the actual summary generation and persistence to Pi. Compaction is lossy by design; the complete session history remains in Pi's session file and can be revisited with `/tree`.

The policy is based on the active model's reported `contextWindow`, not a hard-coded token count. This matters because long-context benchmarks show that a model's advertised context window is not always its effective reasoning range:

- [Anthropic context windows](https://platform.claude.com/docs/en/build-with-claude/context-windows)
- [Anthropic context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
- [RULER](https://arxiv.org/abs/2404.06654)
- [NoLiMa](https://arxiv.org/abs/2502.05167)
- [Lost in the Middle](https://arxiv.org/abs/2307.03172)

## Prompt-cache behavior

Pi's compaction implementation uses `cacheRetention: "none"` for summarization requests because the one-off summary call is not expected to share the normal conversation cache. See the [Pi compaction implementation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/compaction/compaction.ts).

After compaction, the next normal request replaces the older conversation prefix with a summary. Provider caches generally reuse only matching prefixes, so the first post-compaction request can have a lower cache-hit rate. Later turns can build a new cache for the compacted prefix, but another compaction creates another discontinuity. A lower cache-hit rate does not necessarily mean a higher total cost: fewer input tokens can offset the lower hit rate. OpenAI documents this tradeoff in its [prompt caching guide](https://developers.openai.com/api/docs/guides/prompt-caching).

The package is named `pi-auto-compact-threshold` rather than `pi-auto-compact` because the latter name is already in use on the public npm registry.

## License

MIT
