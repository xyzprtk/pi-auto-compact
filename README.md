# pi-auto-compact-threshold

A small [Pi](https://pi.dev) extension that automatically compacts a session when its context usage exceeds **30% of the active model's context window**.

The extension uses Pi's own `ctx.getContextUsage()` and `ctx.compact()` APIs. It does not estimate the context window from a hard-coded token count, and it does not add a second summarization implementation.

## Behavior

- Checks usage after each agent run reaches `agent_settled`.
- Compacts only when `tokens > contextWindow * 0.30`; exactly 30% does not trigger it.
- Starts at most one compaction at a time.
- Rearms after a successful compaction only when usage later falls to 30% or below and crosses 30% again.
- Retries the threshold after a failed or aborted compaction.
- Observes successful and failed compactions started elsewhere in Pi, so manual compaction also satisfies the current crossing.
- Resets its state when the session or model changes.
- Shows a notification when UI output is available and reports compaction failures without interrupting the session.

The check happens after a run settles rather than in the middle of a tool-calling turn. This lets the current turn finish normally, then reduces the context before the next user prompt.

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

Pi's normal automatic compaction remains enabled. This extension adds an earlier policy threshold and delegates the actual summary generation and persistence to Pi. Compaction is lossy by design; the complete session history remains in Pi's session file and can be revisited with `/tree`.

The package is named `pi-auto-compact-threshold` rather than `pi-auto-compact` because the latter name is already in use on the public npm registry.

## License

MIT
