import { expect, test } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { trace } from "@opentelemetry/api";
import { AgentRunCollector, aggregateAgentRunSummaries, type AgentRunSummary } from "../src/run-collector";

function recordRun(hasUnpricedUsage: boolean, totalTokens: number, costUsd: number): AgentRunSummary {
	const collector = new AgentRunCollector();
	const model = buildModel({
		id: "gpt-6.1-sol",
		name: "GPT-6.1 Sol",
		api: "openai-responses",
		provider: hasUnpricedUsage ? "openai-chatgpt" : "openai",
		baseUrl: "https://api.openai.com/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: null,
		maxTokens: null,
	});
	const span = trace.getTracer("unpriced-usage-test").startSpan("chat");
	const message: AssistantMessage = {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		stopReason: "stop",
		timestamp: 1,
		usage: {
			input: totalTokens,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens,
			cost: { input: costUsd, output: 0, cacheRead: 0, cacheWrite: 0, total: costUsd },
			...(hasUnpricedUsage ? { hasUnpricedUsage: true } : {}),
		},
	};
	collector.beginChat(span, { stepNumber: 1, model });
	collector.endChat(span, message, { costUsd, costUnavailableReason: undefined });
	span.end();
	return collector.snapshot({ stepCount: 1 }).summary;
}

test("run aggregation keeps known API dollars and token counts beside unpriced plan usage", () => {
	const api = recordRun(false, 11, 0.75);
	const chatGPT = recordRun(true, 7, 0);
	expect(api.usage.hasUnpricedUsage).toBeUndefined();
	expect(chatGPT.usage.hasUnpricedUsage).toBe(true);
	const aggregate = aggregateAgentRunSummaries([api, chatGPT, recordRun(false, 3, 0.25)]);
	expect(aggregate.usage.totalTokens).toBe(21);
	expect(aggregate.cost.estimatedUsd).toBe(1);
	expect(aggregate.usage.hasUnpricedUsage).toBe(true);
	expect(JSON.parse(JSON.stringify(aggregate)).usage.hasUnpricedUsage).toBe(true);
});
