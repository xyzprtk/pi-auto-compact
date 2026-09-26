import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import extension from "../src/index.js";

type EventHandler = (event: unknown, ctx: ExtensionContext) => unknown;
type CommandHandler = (args: string, ctx: ExtensionContext) => Promise<void>;

function createHarness() {
	const handlers = new Map<string, EventHandler>();
	const commands = new Map<string, CommandHandler>();
	const pi = {
		on: vi.fn((eventName: string, handler: EventHandler) => {
			handlers.set(eventName, handler);
		}),
		registerCommand: vi.fn((name: string, options: { handler: CommandHandler }) => {
			commands.set(name, options.handler);
		}),
	} as unknown as ExtensionAPI;

	extension(pi);

	return {
		emit(eventName: string, ctx: ExtensionContext) {
			const handler = handlers.get(eventName);
			if (!handler) {
				throw new Error(`No handler registered for ${eventName}`);
			}
			return handler({ type: eventName }, ctx);
		},
		runCommand(name: string, ctx: ExtensionContext) {
			const handler = commands.get(name);
			if (!handler) {
				throw new Error(`No command registered for ${name}`);
			}
			return handler("", ctx);
		},
	};
}

function createContext(tokens: number | null, contextWindow = 100, idle = true) {
	let currentTokens = tokens;
	let isIdle = idle;
	const compact = vi.fn();
	const notify = vi.fn();
	const ctx = {
		hasUI: true,
		ui: { notify },
		isIdle: vi.fn(() => isIdle),
		getContextUsage: vi.fn(() => ({
			tokens: currentTokens,
			contextWindow,
			percent: currentTokens === null ? null : (currentTokens / contextWindow) * 100,
		})),
		compact,
	} as unknown as ExtensionContext;

	return {
		ctx,
		compact,
		notify,
		setTokens(nextTokens: number | null) {
			currentTokens = nextTokens;
		},
		setIdle(nextIdle: boolean) {
			isIdle = nextIdle;
		},
	};
}

const STANDARD_THRESHOLD_TOKENS = 125_001;

describe("pi-auto-compact", () => {
	it.each([
		{ label: "32K safety floor", contextWindow: 32_000, atThreshold: 22_000, aboveThreshold: 22_001 },
		{ label: "64K standard tier", contextWindow: 64_000, atThreshold: 32_000, aboveThreshold: 32_001 },
		{ label: "250K tier", contextWindow: 250_000, atThreshold: 125_000, aboveThreshold: 125_001 },
		{ label: "500K tier", contextWindow: 500_000, atThreshold: 275_000, aboveThreshold: 275_001 },
		{ label: "1M tier", contextWindow: 1_000_000, atThreshold: 400_000, aboveThreshold: 400_001 },
		{ label: "2M tier", contextWindow: 2_000_000, atThreshold: 800_000, aboveThreshold: 800_001 },
	])(
		"uses the $label threshold",
		({ contextWindow, atThreshold: thresholdTokens, aboveThreshold: aboveThresholdTokens }) => {
			const atThresholdHarness = createHarness();
			const atThreshold = createContext(thresholdTokens, contextWindow);
			atThresholdHarness.emit("agent_settled", atThreshold.ctx);
			expect(atThreshold.compact).not.toHaveBeenCalled();

			const aboveThresholdHarness = createHarness();
			const aboveThreshold = createContext(aboveThresholdTokens, contextWindow);
			aboveThresholdHarness.emit("agent_settled", aboveThreshold.ctx);
			expect(aboveThreshold.compact).toHaveBeenCalledTimes(1);
		},
	);

	it("leaves context windows below the safety floor to Pi's native policy", () => {
		const { emit } = createHarness();
		const { ctx, compact } = createContext(16_000, 16_000);

		emit("agent_settled", ctx);

		expect(compact).not.toHaveBeenCalled();
	});

	it("does not compact repeatedly while usage remains above the threshold", () => {
		const { emit } = createHarness();
		const { ctx, compact } = createContext(STANDARD_THRESHOLD_TOKENS, 250_000);

		emit("agent_settled", ctx);
		compact.mock.calls[0][0].onComplete();
		emit("agent_settled", ctx);

		expect(compact).toHaveBeenCalledTimes(1);
	});

	it("rearms after usage drops below the threshold and crosses it again", () => {
		const { emit } = createHarness();
		const { ctx, compact, setTokens } = createContext(STANDARD_THRESHOLD_TOKENS, 250_000);

		emit("agent_settled", ctx);
		compact.mock.calls[0][0].onComplete();
		setTokens(100_000);
		emit("agent_settled", ctx);
		setTokens(STANDARD_THRESHOLD_TOKENS);
		emit("agent_settled", ctx);

		expect(compact).toHaveBeenCalledTimes(2);
	});

	it("rearms after a compaction error so a later settled run can retry", () => {
		const { emit } = createHarness();
		const { ctx, compact } = createContext(STANDARD_THRESHOLD_TOKENS, 250_000);

		emit("agent_settled", ctx);
		compact.mock.calls[0][0].onError(new Error("temporary failure"));
		emit("agent_settled", ctx);

		expect(compact).toHaveBeenCalledTimes(2);
	});

	it("waits when context usage is not yet known", () => {
		const { emit } = createHarness();
		const { ctx, compact } = createContext(null, 250_000);

		emit("agent_settled", ctx);

		expect(compact).not.toHaveBeenCalled();
	});

	it("does not start overlapping compactions while one is in flight", () => {
		const { emit } = createHarness();
		const { ctx, compact } = createContext(STANDARD_THRESHOLD_TOKENS, 250_000);

		emit("agent_settled", ctx);
		emit("agent_settled", ctx);

		expect(compact).toHaveBeenCalledTimes(1);
	});

	it("does not compact while Pi is busy, so it cannot orphan a compaction Pi started", () => {
		const { emit } = createHarness();
		const { ctx, compact, setIdle } = createContext(STANDARD_THRESHOLD_TOKENS, 250_000);
		setIdle(false);

		emit("agent_settled", ctx);

		expect(compact).not.toHaveBeenCalled();
	});

	it("compacts once Pi becomes idle again", () => {
		const { emit } = createHarness();
		const { ctx, compact, setIdle } = createContext(STANDARD_THRESHOLD_TOKENS, 250_000);
		setIdle(false);
		emit("agent_settled", ctx);
		setIdle(true);
		emit("agent_settled", ctx);

		expect(compact).toHaveBeenCalledTimes(1);
	});

	it("keeps rearming below the threshold while Pi is busy, then compacts once idle", () => {		const { emit } = createHarness();
		const { ctx, compact, setIdle, setTokens } = createContext(STANDARD_THRESHOLD_TOKENS, 250_000);
		emit("agent_settled", ctx);
		compact.mock.calls[0][0].onComplete();
		setIdle(false);
		setTokens(100_000);
		emit("agent_settled", ctx);
		setTokens(STANDARD_THRESHOLD_TOKENS);
		emit("agent_settled", ctx);

		expect(compact).toHaveBeenCalledTimes(1);

		setIdle(true);
		emit("agent_settled", ctx);

		expect(compact).toHaveBeenCalledTimes(2);
	});

	it("treats a successful session compaction as satisfying the current crossing", () => {
		const { emit } = createHarness();
		const { ctx, compact } = createContext(STANDARD_THRESHOLD_TOKENS, 250_000);

		emit("session_compact", ctx);
		emit("agent_settled", ctx);

		expect(compact).not.toHaveBeenCalled();
	});

	it("rearms after a model change because the context window may have changed", () => {
		const { emit } = createHarness();
		const { ctx, compact } = createContext(STANDARD_THRESHOLD_TOKENS, 250_000);

		emit("agent_settled", ctx);
		compact.mock.calls[0][0].onComplete();
		emit("model_select", ctx);
		emit("agent_settled", ctx);

		expect(compact).toHaveBeenCalledTimes(2);
	});

	it("does not overlap a compaction when the model changes mid-flight", () => {
		const { emit } = createHarness();
		const { ctx, compact } = createContext(STANDARD_THRESHOLD_TOKENS, 250_000);

		emit("agent_settled", ctx);
		emit("model_select", ctx);
		emit("agent_settled", ctx);

		expect(compact).toHaveBeenCalledTimes(1);
	});

	it("rearms when another compaction attempt fails", () => {
		const { emit } = createHarness();
		const { ctx, compact } = createContext(STANDARD_THRESHOLD_TOKENS, 250_000);

		emit("agent_settled", ctx);
		emit("session_compact_failed", ctx);
		emit("agent_settled", ctx);

		expect(compact).toHaveBeenCalledTimes(2);
	});
});

describe("soft compaction outcomes", () => {
	const NOTHING_TO_COMPACT = new Error("Nothing to compact (session too small)");
	const ALREADY_COMPACTED = new Error("Already compacted");

	it.each([
		{ label: "nothing to compact", error: NOTHING_TO_COMPACT },
		{ label: "already compacted", error: ALREADY_COMPACTED },
	])("does not report $label as a failure", ({ error }) => {
		const { emit } = createHarness();
		const { ctx, compact, notify } = createContext(STANDARD_THRESHOLD_TOKENS, 250_000);

		emit("agent_settled", ctx);
		compact.mock.calls[0][0].onError(error);

		expect(notify).not.toHaveBeenCalledWith(expect.stringContaining("Auto-compaction failed"), expect.anything());
	});

	it.each([
		{ label: "nothing to compact", error: NOTHING_TO_COMPACT },
		{ label: "already compacted", error: ALREADY_COMPACTED },
	])("marks the crossing satisfied on $label instead of retrying", ({ error }) => {
		const { emit } = createHarness();
		const { ctx, compact } = createContext(STANDARD_THRESHOLD_TOKENS, 250_000);

		emit("agent_settled", ctx);
		compact.mock.calls[0][0].onError(error);
		emit("agent_settled", ctx);
		emit("agent_settled", ctx);

		expect(compact).toHaveBeenCalledTimes(1);
	});

	it("still reports a genuine compaction failure as an error", () => {
		const { emit } = createHarness();
		const { ctx, compact, notify } = createContext(STANDARD_THRESHOLD_TOKENS, 250_000);

		emit("agent_settled", ctx);
		compact.mock.calls[0][0].onError(new Error("provider rejected the request"));
		emit("agent_settled", ctx);

		expect(compact).toHaveBeenCalledTimes(2);
		expect(notify).toHaveBeenCalledWith(
			"Auto-compaction failed: provider rejected the request",
			"error",
		);
	});

	it("retries after a soft outcome once usage crosses the threshold again", () => {
		const { emit } = createHarness();
		const { ctx, compact, setTokens } = createContext(STANDARD_THRESHOLD_TOKENS, 250_000);

		emit("agent_settled", ctx);
		compact.mock.calls[0][0].onError(NOTHING_TO_COMPACT);
		setTokens(100_000);
		emit("agent_settled", ctx);
		setTokens(STANDARD_THRESHOLD_TOKENS);
		emit("agent_settled", ctx);

		expect(compact).toHaveBeenCalledTimes(2);
	});

	it("clears a soft outcome on a model change", () => {
		const { emit } = createHarness();
		const { ctx, compact } = createContext(STANDARD_THRESHOLD_TOKENS, 250_000);

		emit("agent_settled", ctx);
		compact.mock.calls[0][0].onError(NOTHING_TO_COMPACT);
		emit("model_select", ctx);
		emit("agent_settled", ctx);

		expect(compact).toHaveBeenCalledTimes(2);
	});

	it("clears a soft outcome when another compaction succeeds", () => {
		const { emit } = createHarness();
		const { ctx, compact, setTokens } = createContext(STANDARD_THRESHOLD_TOKENS, 250_000);

		emit("agent_settled", ctx);
		compact.mock.calls[0][0].onError(NOTHING_TO_COMPACT);
		emit("session_compact", ctx);
		setTokens(100_000);
		emit("agent_settled", ctx);
		setTokens(STANDARD_THRESHOLD_TOKENS);
		emit("agent_settled", ctx);

		expect(compact).toHaveBeenCalledTimes(2);
	});
});

describe("auto-compact-status command", () => {
	function status(tokens: number | null, contextWindow: number) {
		const harness = createHarness();
		const context = createContext(tokens, contextWindow);
		return {
			emit: harness.emit,
			ctx: context.ctx,
			compact: context.compact,
			notify: context.notify,
			async run() {
				await harness.runCommand("auto-compact-status", context.ctx);
				return context.notify.mock.calls.at(-1)?.[0] as string;
			},
		};
	}

	it("reports usage, the active threshold, and the armed state", async () => {
		const { run } = status(100_000, 250_000);

		const message = await run();

		expect(message).toBe(
			"Auto-compact: 100.0K of 250.0K (40.0%) | threshold 125.0K (50.0%, standard tier) | below threshold, armed",
		);
	});

	it("reports that a compaction is in flight", async () => {
		const { emit, ctx, run } = status(150_000, 250_000);
		emit("agent_settled", ctx);

		const message = await run();

		expect(message).toContain("compaction in flight");
	});

	it("reports that a settled compaction is waiting to rearm", async () => {
		const { emit, ctx, compact, run } = status(150_000, 250_000);
		emit("agent_settled", ctx);
		compact.mock.calls[0][0].onComplete();

		const message = await run();

		expect(message).toContain("over threshold, waiting for usage to fall back below it to rearm");
	});

	it("reports that the next settled run will compact", async () => {
		const { run } = status(150_000, 250_000);

		const message = await run();

		expect(message).toContain("over threshold, compacts on the next settled run");
	});

	it("reports the tier and threshold for a large context window", async () => {
		const { run } = status(400_000, 1_000_000);

		const message = await run();

		expect(message).toContain("threshold 400.0K (40.0%, large tier)");
	});

	it("explains that small context windows are left to Pi's native policy", async () => {
		const { run } = status(16_000, 16_000);

		const message = await run();

		expect(message).toContain("below the safety floor, left to Pi's native policy");
	});

	it("reports that usage is not known yet", async () => {
		const { run } = status(null, 250_000);

		const message = await run();

		expect(message).toBe("Auto-compact: context usage is not known yet.");
	});

	it("does not compact when only reporting status", async () => {
		const { compact, run } = status(150_000, 250_000);

		await run();

		expect(compact).not.toHaveBeenCalled();
	});

	it("does not claim a compaction is coming when nothing can be compacted", async () => {
		const { emit, ctx, run, compact } = status(150_000, 250_000);
		emit("agent_settled", ctx);
		compact.mock.calls[0][0].onError(new Error("Nothing to compact (session too small)"));

		const message = await run();

		expect(message).toContain("over threshold, nothing to compact yet, waiting for usage to cross again");
		expect(message).not.toContain("compacts on the next settled run");
	});
});
