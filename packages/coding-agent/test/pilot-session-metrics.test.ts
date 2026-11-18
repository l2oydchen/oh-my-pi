import { expect, test } from "bun:test";
import * as typebox from "@oh-my-pi/omptype/typebox";
import { TempDir } from "@oh-my-pi/pi-utils";
import pilot, { type SubagentMetrics } from "../examples/pilot-chatgpt/pilot-session-metrics";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "../src/extensibility/extensions/types";

// Numeric usage fixtures only: no model requests or large prompts.
test("Pilot reports live capacity, clears stale percentages, and preserves rotation and compaction transitions", async () => {
	await using temp = await TempDir.create("@pilot-context-");
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
	let tool: ToolDefinition | undefined;
	let latest: SubagentMetrics | undefined;
	let usage = { tokens: 235_982, contextWindow: 872_000, percent: 0 };
	const api = {
		typebox,
		on(name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) {
			handlers.set(name, handler);
		},
		appendEntry(_type: string, data: SubagentMetrics) {
			latest = data;
		},
		registerTool(definition: ToolDefinition) {
			tool = definition;
		},
	} as unknown as ExtensionAPI;
	const child = {
		agent: { kind: "sub", id: "0-Reviewer", name: "reviewer", parentId: "Main" },
		sessionManager: {
			getSessionFile: () => temp.join("root", "reviewer.jsonl"),
			getHeader: () => ({ parentSession: temp.join("root.jsonl") }),
			getSessionId: () => "child",
			getEntries: () => [],
		},
		getContextUsage: () => usage,
	} as unknown as ExtensionContext;
	const main = {
		agent: { kind: "main", id: "Main" },
		sessionManager: { getSessionFile: () => temp.join("root.jsonl") },
	} as unknown as ExtensionContext;
	pilot(api);
	const emit = async (name: string, event: unknown = {}) => {
		const handler = handlers.get(name);
		if (!handler) throw new Error(`Missing handler: ${name}`);
		await handler(event, child);
	};
	await emit("turn_end");
	expect(latest).toMatchObject({
		contextTokens: 235_982,
		contextWindow: 872_000,
		contextPercent: 27.06,
		shouldRotate: false,
	});
	if (!tool) throw new Error("Missing Pilot status tool");
	const result = await tool.execute("status", {}, undefined, undefined, main);
	expect(result.details).toMatchObject({
		count: 1,
		subagents: [{ contextWindow: 872_000, contextPercent: 27.06, compacted: false }],
	});

	usage = { tokens: 349_000, contextWindow: 872_000, percent: 0 };
	await emit("turn_end");
	expect(latest?.rotateReasons).toEqual(["context_percent_exceeded_40"]);
	usage = { tokens: 400_001, contextWindow: 2_000_000, percent: 0 };
	await emit("turn_end");
	expect(latest?.rotateReasons).toEqual(["context_tokens_exceeded_400k"]);
	usage = { tokens: 400_001, contextWindow: 0, percent: 0 };
	await emit("turn_end");
	expect(latest).toMatchObject({ contextWindow: null, contextPercent: null, shouldRotate: true });
	usage = { tokens: 0, contextWindow: 872_000, percent: 0 };
	await emit("turn_end");
	expect(latest).toMatchObject({ contextTokens: 0, contextPercent: 0, shouldRotate: false });

	for (let timestamp = 1; timestamp <= 5; timestamp++) {
		const event = { message: { role: "user", content: "[PILOT-BATCH] fixture", timestamp } };
		await emit("message_start", event);
		await emit("message_start", event); // duplicate delivery must not double-count
	}
	expect(latest).toMatchObject({ calls: 5, rotateReasons: ["calls_reached_5"] });
	await emit("auto_compaction_end", { aborted: true });
	expect(latest?.compacted).toBe(false);
	await emit("auto_compaction_end", { result: {} });
	expect(latest).toMatchObject({ compacted: true, rotateReasons: ["calls_reached_5", "compacted_once"] });
});
