# pi-auto-compact-threshold

A small [Pi](https://pi.dev) extension that automatically compacts a session using a context-window-aware percentage threshold.

The extension uses Pi's own `ctx.getContextUsage()` and `ctx.compact()` APIs. It does not estimate the context window from a hard-coded token count, and it does not add a second summarization implementation.

## Behavior

- Checks usage after each agent run reaches `agent_settled`.
- Uses a tiered percentage threshold based on the active model's context window.
- Starts at most one compaction at a time.
- Rearms after a successful compaction only when usage later falls to or below the active threshold and crosses it again.
- Retries the threshold after a failed or aborted compaction.
- Observes successful and failed compactions started elsewhere in Pi, so manual compaction also satisfies the current crossing.
- Resets its state when the session or model changes.
- Shows a notification when UI output is available and reports compaction failures without interrupting the session.

The check happens after a run settles rather than in the middle of a tool-calling turn. This lets the current turn finish normally, then reduces the context before the next user prompt.

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

### From npm after publishing

```bash
pi install npm:pi-auto-compact-threshold
```

The package uses the `pi-package` keyword and declares its extension entry in `package.json`, so it can also be installed as a local Pi package directory.

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
