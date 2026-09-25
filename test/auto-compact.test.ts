import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import extension from "../src/index.js";

type EventHandler = (event: unknown, ctx: ExtensionContext) => unknown;

function createHarness() {
	const handlers = new Map<string, EventHandler>();
	const pi = {
		on: vi.fn((eventName: string, handler: EventHandler) => {
			handlers.set(eventName, handler);
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
	};
}

function createContext(tokens: number | null, contextWindow = 100) {
	let currentTokens = tokens;
	const compact = vi.fn();
	const notify = vi.fn();
	const ctx = {
		hasUI: true,
		ui: { notify },
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
