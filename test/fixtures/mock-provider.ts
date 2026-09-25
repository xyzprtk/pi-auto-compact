import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function registerMockProvider(pi: ExtensionAPI): void {
	const baseUrl = process.env.PI_AUTO_COMPACT_TEST_BASE_URL;
	if (!baseUrl) {
		throw new Error("PI_AUTO_COMPACT_TEST_BASE_URL is required");
	}

	pi.registerProvider("mock", {
		name: "Mock",
		baseUrl,
		apiKey: "test-key",
		api: "openai-completions",
		models: [
			{
				id: "mock-test",
				name: "Mock Test",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128_000,
				maxTokens: 16,
			},
		],
	});
}
