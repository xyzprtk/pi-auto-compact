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

describe("pi-auto-compact", () => {
	it("starts a compaction when a settled agent is above 30% context usage", () => {
		const { emit } = createHarness();
		const { ctx, compact } = createContext(31);

		emit("agent_settled", ctx);

		expect(compact).toHaveBeenCalledTimes(1);
	});

	it("does not start a compaction at exactly 30% context usage", () => {
		const { emit } = createHarness();
		const { ctx, compact } = createContext(30);

		emit("agent_settled", ctx);

		expect(compact).not.toHaveBeenCalled();
	});

	it("does not compact repeatedly while usage remains above 30%", () => {
		const { emit } = createHarness();
		const { ctx, compact } = createContext(31);

		emit("agent_settled", ctx);
		compact.mock.calls[0][0].onComplete();
		emit("agent_settled", ctx);

		expect(compact).toHaveBeenCalledTimes(1);
	});

	it("rearms after usage drops below 30% and crosses the threshold again", () => {
		const { emit } = createHarness();
		const { ctx, compact, setTokens } = createContext(31);

		emit("agent_settled", ctx);
		compact.mock.calls[0][0].onComplete();
		setTokens(20);
		emit("agent_settled", ctx);
		setTokens(31);
		emit("agent_settled", ctx);

		expect(compact).toHaveBeenCalledTimes(2);
	});

	it("rearms after a compaction error so a later settled run can retry", () => {
		const { emit } = createHarness();
		const { ctx, compact } = createContext(31);

		emit("agent_settled", ctx);
		compact.mock.calls[0][0].onError(new Error("temporary failure"));
		emit("agent_settled", ctx);

		expect(compact).toHaveBeenCalledTimes(2);
	});

	it("waits when context usage is not yet known", () => {
		const { emit } = createHarness();
		const { ctx, compact } = createContext(null);

		emit("agent_settled", ctx);

		expect(compact).not.toHaveBeenCalled();
	});

	it("does not start overlapping compactions while one is in flight", () => {
		const { emit } = createHarness();
		const { ctx, compact } = createContext(31);

		emit("agent_settled", ctx);
		emit("agent_settled", ctx);

		expect(compact).toHaveBeenCalledTimes(1);
	});

	it("treats a successful session compaction as satisfying the current crossing", () => {
		const { emit } = createHarness();
		const { ctx, compact } = createContext(31);

		emit("session_compact", ctx);
		emit("agent_settled", ctx);

		expect(compact).not.toHaveBeenCalled();
	});

	it("rearms after a model change because the context window may have changed", () => {
		const { emit } = createHarness();
		const { ctx, compact } = createContext(31);

		emit("agent_settled", ctx);
		compact.mock.calls[0][0].onComplete();
		emit("model_select", ctx);
		emit("agent_settled", ctx);

		expect(compact).toHaveBeenCalledTimes(2);
	});

	it("does not overlap a compaction when the model changes mid-flight", () => {
		const { emit } = createHarness();
		const { ctx, compact } = createContext(31);

		emit("agent_settled", ctx);
		emit("model_select", ctx);
		emit("agent_settled", ctx);

		expect(compact).toHaveBeenCalledTimes(1);
	});

	it("rearms when another compaction attempt fails", () => {
		const { emit } = createHarness();
		const { ctx, compact } = createContext(31);

		emit("agent_settled", ctx);
		emit("session_compact_failed", ctx);
		emit("agent_settled", ctx);

		expect(compact).toHaveBeenCalledTimes(2);
	});
});
