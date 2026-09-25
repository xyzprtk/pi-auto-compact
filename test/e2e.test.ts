import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const piCli = fileURLToPath(
	new URL("../node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js", import.meta.url),
);
const extensionPath = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const providerPath = fileURLToPath(new URL("./fixtures/mock-provider.ts", import.meta.url));

function readRequest(request: IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		let body = "";
		request.setEncoding("utf8");
		request.on("data", (chunk: string) => {
			body += chunk;
		});
		request.on("end", () => resolve(body));
		request.on("error", reject);
	});
}

function writeCompletion(response: ServerResponse, content: string): void {
	response.writeHead(200, {
		"content-type": "text/event-stream",
		"cache-control": "no-cache",
		connection: "keep-alive",
	});

	const chunks = [
		{
			id: "chatcmpl-test",
			object: "chat.completion.chunk",
			created: 0,
			model: "mock-test",
			choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }],
		},
		{
			id: "chatcmpl-test",
			object: "chat.completion.chunk",
			created: 0,
			model: "mock-test",
			choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
			usage: { prompt_tokens: 64, completion_tokens: 8, total_tokens: 72 },
		},
	];

	for (const chunk of chunks) {
		response.write(`data: ${JSON.stringify(chunk)}\n\n`);
	}
	response.end("data: [DONE]\n\n");
}

async function runPiAgainstMockProvider(): Promise<{ code: number | null; output: string; requests: unknown[] }> {
	const requests: unknown[] = [];
	const server = createServer(async (request, response) => {
		requests.push(JSON.parse(await readRequest(request)));
		writeCompletion(response, requests.length === 1 ? "Initial response." : "## Goal\n\nSummarize the test conversation.");
	});

	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") {
		throw new Error("Mock provider did not bind to a TCP port");
	}

	const projectDir = await mkdtemp(join(tmpdir(), "pi-auto-compact-e2e-"));
	await mkdir(join(projectDir, ".pi"), { recursive: true });
	await writeFile(
		join(projectDir, ".pi", "settings.json"),
		JSON.stringify({ compaction: { keepRecentTokens: 5 } }),
	);

	const child = spawn(
		process.execPath,
		[
			piCli,
			"--no-extensions",
			"--no-skills",
			"--no-prompt-templates",
			"--no-themes",
			"--no-context-files",
			"--no-builtin-tools",
			"--no-session",
			"--approve",
			"--mode",
			"rpc",
			"--system-prompt",
			"Reply briefly.",
			"--provider",
			"mock",
			"--model",
			"mock-test",
			"-e",
			extensionPath,
			"-e",
			providerPath,
		],
		{
			cwd: projectDir,
			env: {
				...process.env,
				PI_AUTO_COMPACT_TEST_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
				PI_OFFLINE: "1",
			},
			stdio: ["pipe", "pipe", "pipe"],
		},
	);

	let output = "";
	let stdoutBuffer = "";
	let finished = false;
	const finish = () => {
		if (finished) {
			return;
		}
		finished = true;
		child.stdin.end();
	};

	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	child.stdout.on("data", (chunk: string) => {
		output += chunk;
		stdoutBuffer += chunk;
		const lines = stdoutBuffer.split(/\r?\n/);
		stdoutBuffer = lines.pop() ?? "";
		for (const line of lines) {
			try {
				const event = JSON.parse(line) as { type?: string };
				if (event.type === "compaction_end") {
					finish();
				}
			} catch {
				// Pi can write non-JSON diagnostics to stdout; ignore those lines.
			}
		}
	});
	child.stderr.on("data", (chunk: string) => {
		output += chunk;
	});

	child.stdin.write(`${JSON.stringify({ id: "prompt-1", type: "prompt", message: "A".repeat(120) })}\n`);

	const code = await new Promise<number | null>((resolve, reject) => {
		const timeout = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error(`Pi timed out. Output:\n${output}`));
		}, 20_000);
		child.once("error", reject);
		child.once("exit", (exitCode) => {
			clearTimeout(timeout);
			resolve(exitCode);
		});
	});

	await new Promise<void>((resolve, reject) => {
		server.close((error) => (error ? reject(error) : resolve()));
	});
	await rm(projectDir, { recursive: true, force: true });

	return { code, output, requests };
}

describe("pi-auto-compact end to end", () => {
	it("loads through Pi and compacts after the first settled response", async () => {
		const { code, output, requests } = await runPiAgainstMockProvider();
		const events = output
			.split(/\r?\n/)
			.filter(Boolean)
			.flatMap((line) => {
				try {
					return [JSON.parse(line) as { type?: string }];
				} catch {
					return [];
				}
			});

		expect(code, output).toBe(0);
		expect(requests, output).toHaveLength(2);
		expect(events.some((event) => event.type === "compaction_start")).toBe(true);
		expect(events.some((event) => event.type === "compaction_end")).toBe(true);
	});
});
