import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const CONTEXT_THRESHOLD = 0.3;

function notify(ctx: ExtensionContext, message: string, type: "info" | "warning" | "error"): void {
	if (ctx.hasUI) {
		ctx.ui.notify(message, type);
	}
}

function formatPercent(percent: number): string {
	return `${percent.toFixed(1)}%`;
}

export default function piAutoCompact(pi: ExtensionAPI): void {
	let armed = true;
	let compacting = false;

	const reset = () => {
		armed = true;
		compacting = false;
	};

	const rearm = () => {
		armed = true;
	};

	const handleCompactionError = (error: Error, ui: ExtensionContext["ui"] | undefined) => {
		compacting = false;
		armed = true;
		ui?.notify(`Auto-compaction failed: ${error.message}`, "error");
	};

	pi.on("session_start", reset);
	pi.on("session_shutdown", reset);
	pi.on("model_select", rearm);

	pi.on("session_compact", () => {
		compacting = false;
		armed = false;
	});

	pi.on("session_compact_failed", () => {
		compacting = false;
		armed = true;
	});

	pi.on("agent_settled", (_event, ctx) => {
		const usage = ctx.getContextUsage();
		if (!usage || usage.tokens === null) {
			return;
		}

		if (usage.tokens <= usage.contextWindow * CONTEXT_THRESHOLD) {
			armed = true;
			return;
		}

		if (!armed || compacting) {
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
				},
				onError: (error) => handleCompactionError(error, ui),
			});
		} catch (error) {
			handleCompactionError(error instanceof Error ? error : new Error(String(error)), ui);
		}
	});
}
