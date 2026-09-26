import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const STANDARD_CONTEXT_THRESHOLD = 0.5;
const MEDIUM_CONTEXT_THRESHOLD = 0.55;
const LARGE_CONTEXT_THRESHOLD = 0.4;
const SMALL_CONTEXT_TRIGGER_FLOOR = 22_000;

const SOFT_COMPACTION_ERRORS = ["Nothing to compact", "Already compacted"];

function isSoftCompactionError(error: Error): boolean {
	return SOFT_COMPACTION_ERRORS.some((message) => error.message.includes(message));
}

interface CompactionPolicy {
	thresholdTokens: number;
	percent: number;
	tier: "large" | "medium" | "standard";
}

function getCompactionPolicy(contextWindow: number): CompactionPolicy {
	const percent =
		contextWindow >= 1_000_000
			? LARGE_CONTEXT_THRESHOLD
			: contextWindow >= 500_000
				? MEDIUM_CONTEXT_THRESHOLD
				: STANDARD_CONTEXT_THRESHOLD;

	const tier = contextWindow >= 1_000_000 ? "large" : contextWindow >= 500_000 ? "medium" : "standard";

	return {
		thresholdTokens: Math.max(contextWindow * percent, SMALL_CONTEXT_TRIGGER_FLOOR),
		percent,
		tier,
	};
}

function notify(ctx: ExtensionContext, message: string, type: "info" | "warning" | "error"): void {
	if (ctx.hasUI) {
		ctx.ui.notify(message, type);
	}
}

function formatPercent(percent: number): string {
	return `${percent.toFixed(1)}%`;
}

function formatTokens(tokens: number): string {
	if (tokens >= 1_000_000) {
		return `${(tokens / 1_000_000).toFixed(2)}M`;
	}
	if (tokens >= 1_000) {
		return `${(tokens / 1_000).toFixed(1)}K`;
	}
	return `${Math.round(tokens)}`;
}

function describeState(
	tokens: number,
	thresholdTokens: number,
	compacting: boolean,
	armed: boolean,
	blocked: boolean,
): string {
	if (compacting) {
		return "compaction in flight";
	}
	if (tokens > thresholdTokens) {
		if (blocked) {
			return "over threshold, nothing to compact yet, waiting for usage to cross again";
		}
		return armed
			? "over threshold, compacts on the next settled run"
			: "over threshold, waiting for usage to fall back below it to rearm";
	}
	return "below threshold, armed";
}

export default function piAutoCompact(pi: ExtensionAPI): void {
	let armed = true;
	let compacting = false;
	let blocked = false;

	const reset = () => {
		armed = true;
		compacting = false;
		blocked = false;
	};

	const rearm = () => {
		armed = true;
		blocked = false;
	};

	const handleCompactionError = (error: Error, ui: ExtensionContext["ui"] | undefined) => {
		compacting = false;

		if (isSoftCompactionError(error)) {
			// Pi has no cut point, which on a small context window means there is
			// nothing older than keepRecentTokens to summarize. This is an expected
			// outcome rather than a failure, so it is not reported as an error.
			// Pi renders its own error for the attempt regardless, so the crossing is
			// marked satisfied instead of retried to keep that to one message.
			armed = false;
			blocked = true;
			return;
		}

		armed = true;
		blocked = false;
		ui?.notify(`Auto-compaction failed: ${error.message}`, "error");
	};

	pi.on("session_start", reset);
	pi.on("session_shutdown", reset);
	pi.on("model_select", rearm);

	pi.on("session_compact", () => {
		compacting = false;
		armed = false;
		blocked = false;
	});

	pi.on("session_compact_failed", () => {
		compacting = false;
		armed = true;
	});

	pi.registerCommand("auto-compact-status", {
		description: "Show current context usage and the active auto-compaction threshold",
		handler: async (_args, ctx) => {
			const usage = ctx.getContextUsage();
			if (!usage || usage.tokens === null) {
				notify(ctx, "Auto-compact: context usage is not known yet.", "info");
				return;
			}

			const policy = getCompactionPolicy(usage.contextWindow);
			const percent = usage.percent ?? (usage.tokens / usage.contextWindow) * 100;
			const thresholdPercent = (policy.thresholdTokens / usage.contextWindow) * 100;
			const deferred = policy.thresholdTokens >= usage.contextWindow;
			const state = deferred
				? "below the safety floor, left to Pi's native policy"
				: describeState(usage.tokens, policy.thresholdTokens, compacting, armed, blocked);

			const summary = [
				`Auto-compact: ${formatTokens(usage.tokens)} of ${formatTokens(usage.contextWindow)} (${formatPercent(percent)})`,
				`threshold ${formatTokens(policy.thresholdTokens)} (${formatPercent(thresholdPercent)}, ${policy.tier} tier)`,
				state,
			].join(" | ");

			notify(ctx, summary, "info");
		},
	});

	pi.on("agent_settled", (_event, ctx) => {
		const usage = ctx.getContextUsage();
		if (!usage || usage.tokens === null) {
			return;
		}

		const thresholdTokens = getCompactionPolicy(usage.contextWindow).thresholdTokens;
		if (usage.tokens <= thresholdTokens) {
			rearm();
			return;
		}

		if (!armed || compacting) {
			return;
		}

		// isIdle() is false while an agent run, compaction, or branch summary is in
		// progress. Pi exposes no other way to detect a compaction it started itself,
		// and starting a second one would abort and orphan the first.
		if (!ctx.isIdle()) {
			return;
		}

		const percent = usage.percent ?? (usage.tokens / usage.contextWindow) * 100;
		const ui = ctx.hasUI ? ctx.ui : undefined;
		compacting = true;
		notify(ctx, `Context usage reached ${formatPercent(percent)}; compacting automatically.`, "info");

		try {
			ctx.compact({
				onComplete: () => {
					compacting = false;
					armed = false;
					blocked = false;
				},
				onError: (error) => handleCompactionError(error, ui),
			});
		} catch (error) {
			handleCompactionError(error instanceof Error ? error : new Error(String(error)), ui);
		}
	});
}
