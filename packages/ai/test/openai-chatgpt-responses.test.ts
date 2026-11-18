import { describe, expect, it, spyOn } from "bun:test";
import { type as schemaType } from "@oh-my-pi/omptype";
import * as envApiKeys from "@oh-my-pi/pi-ai/env-api-key";
import { getProviderDefinition } from "@oh-my-pi/pi-ai/registry";
import { streamSimple } from "@oh-my-pi/pi-ai/stream";
import { applyOpenAIChatGPTRequestContract } from "@oh-my-pi/pi-ai/providers/openai-chatgpt-contract";
import {
	buildParams,
	streamOpenAIResponses,
	type OpenAIResponsesOptions,
} from "@oh-my-pi/pi-ai/providers/openai-responses";
import { OpenAIResponsesTransportSessions } from "@oh-my-pi/pi-ai/providers/openai-responses-session";
import type { ResponseCreateParamsBase } from "@oh-my-pi/pi-ai/providers/openai-responses-wire";
import type {
	Api,
	Context,
	FetchImpl,
	Model,
	ProviderSessionState,
	Tool,
	ToolResultMessage,
} from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { endpoint, sse, textEvents, type ResponsesWireEvent } from "./fixtures/openai-responses-server";

function makeModel(): Model<"openai-responses"> {
	const model = buildModel({
		api: "openai-responses",
		provider: "openai-chatgpt",
		baseUrl: "https://api.openai.com/v1",
		id: "gpt-5-mini",
		name: "ChatGPT test model",
		input: ["text", "image"],
		reasoning: true,
		contextWindow: 128_000,
		maxTokens: 16_384,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	});
	return {
		...model,
		applyPatchToolType: "freeform",
		compat: { ...model.compat, responsesRequestContract: "chatgpt" },
	};
}

const readTool: Tool = {
	name: "read",
	description: "Read a local file",
	parameters: schemaType({ path: "string" }),
};
const patchTool: Tool = {
	name: "edit",
	customWireName: "apply_patch",
	description: "Apply a local patch",
	parameters: schemaType({ input: "string" }),
	customFormat: { syntax: "regex", definition: ".*" },
};
const firstUser = { role: "user" as const, content: "Read notes.txt and update it.", timestamp: 1 };
const context: Context = {
	systemPrompt: ["Work on the local files."],
	messages: [firstUser],
	tools: [readTool, patchTool],
};

function toolTurnEvents(): ResponsesWireEvent[] {
	const read = {
		type: "function_call",
		id: "fc_read",
		call_id: "call_read",
		name: "read",
		arguments: '{"path":"notes.txt"}',
		status: "completed",
	};
	const patch = {
		type: "custom_tool_call",
		id: "ct_patch",
		call_id: "call_patch",
		name: "apply_patch",
		input: "*** Begin Patch\n*** End Patch",
		status: "completed",
	};
	return [
		{ type: "response.created", response: { id: "resp_tools" } },
		{ type: "response.output_item.added", output_index: 0, item: { ...read, arguments: "", status: "in_progress" } },
		{ type: "response.function_call_arguments.delta", output_index: 0, item_id: read.id, delta: read.arguments },
		{ type: "response.output_item.done", output_index: 0, item: read },
		{ type: "response.output_item.added", output_index: 1, item: { ...patch, input: "", status: "in_progress" } },
		{ type: "response.custom_tool_call_input.delta", output_index: 1, item_id: patch.id, delta: patch.input },
		{ type: "response.output_item.done", output_index: 1, item: patch },
		{
			type: "response.completed",
			response: {
				id: "resp_tools",
				status: "completed",
				output: [read, patch],
				usage: { input_tokens: 9, output_tokens: 5, total_tokens: 14 },
			},
		},
	];
}

describe("Sign in with ChatGPT Responses contract", () => {
	it("validates configured routes before selecting an API sender", () => {
		const valid = makeModel();
		const validate = getProviderDefinition("openai-chatgpt")?.validateModel;
		expect(validate).toBeDefined();
		expect(() => validate?.(valid)).not.toThrow();
		expect(getProviderDefinition("openai")?.validateModel).toBeUndefined();
		const invalid: Array<[Model<Api>, string]> = [
			[{ ...valid, api: "openai-completions", compat: undefined }, "openai-responses API"],
			[{ ...valid, api: "google-vertex", compat: undefined }, "openai-responses API"],
			[{ ...valid, baseUrl: "https://other.example/v1" }, "https://api.openai.com/v1"],
			[{ ...valid, compat: undefined }, "responsesRequestContract"],
			[{ ...valid, compat: { ...valid.compat, responsesRequestContract: undefined } }, "responsesRequestContract"],
		];
		let fetchCount = 0;
		for (const [model, reason] of invalid) {
			expect(() =>
				streamSimple(model, context, {
					apiKey: "chatgpt-access-token",
					fetch: async () => {
						fetchCount++;
						return sse(textEvents("Unexpected", "resp_unexpected"));
					},
				}),
			).toThrow(reason);
		}
		expect(fetchCount).toBe(0);
	});

	it.each(["temperature", "topP"] as const)(
		"preserves explicit %s for contract validation in the shared dispatcher",
		async option => {
			let fetchCount = 0;
			const result = await streamSimple(makeModel(), context, {
				apiKey: "chatgpt-access-token",
				[option]: 0.5,
				fetch: async () => {
					fetchCount++;
					return sse(textEvents("Unexpected", "resp_unexpected"));
				},
			}).result();
			expect(result.stopReason).toBe("error");
			expect(result.errorMessage).toContain(option);
			expect(fetchCount).toBe(0);
		},
	);

	it("replays both function and custom tool turns over HTTP without storage or persistent anchors", async () => {
		const requests: Array<Record<string, unknown>> = [];
		const headers: Headers[] = [];
		const fetch: FetchImpl = async (url, init) => {
			expect(String(url)).toBe("https://api.openai.com/v1/responses");
			requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
			headers.push(new Headers(init?.headers));
			return sse(requests.length === 1 ? toolTurnEvents() : textEvents("Updated notes.", "resp_final"));
		};
		const providerSessionState = new Map<string, ProviderSessionState>();
		const options: OpenAIResponsesOptions = {
			apiKey: "chatgpt-access-token",
			sessionId: "chatgpt-tool-session",
			providerSessionState,
			statefulResponses: true,
			maxTokens: 8192,
			maxTokensExplicit: false,
			fetch,
		};
		try {
			const first = await streamOpenAIResponses(makeModel(), context, options).result();
			expect(first.stopReason).toBe("toolUse");
			expect(first.usage).toMatchObject({ input: 9, output: 5, totalTokens: 14, hasUnpricedUsage: true });
			const calls = first.content.filter(block => block.type === "toolCall");
			expect(calls).toMatchObject([
				{ name: "read", arguments: { path: "notes.txt" } },
				{
					name: "apply_patch",
					arguments: { input: "*** Begin Patch\n*** End Patch" },
					customWireName: "apply_patch",
				},
			]);
			const results: ToolResultMessage[] = calls.map(call => ({
				role: "toolResult",
				toolCallId: call.id,
				toolName: call.name,
				content: [{ type: "text", text: call.name === "read" ? "Original notes" : "Patch applied" }],
				isError: false,
				timestamp: 2,
			}));
			const second = await streamOpenAIResponses(
				makeModel(),
				{ ...context, messages: [firstUser, first, ...results] },
				options,
			).result();
			expect(second.stopReason).toBe("stop");
			expect(second.usage).toMatchObject({ input: 5, output: 3, totalTokens: 8, hasUnpricedUsage: true });
			expect(second.content).toMatchObject([{ type: "text", text: "Updated notes." }]);
			expect(requests).toHaveLength(2);
			for (const request of requests) {
				expect(request).toMatchObject({ store: false, stream: true });
				expect(request.previous_response_id).toBeUndefined();
				expect(request.max_output_tokens).toBeUndefined();
				expect(request.tools).toBeUndefined();
				expect((request.input as Array<Record<string, unknown>>)[0]).toMatchObject({
					type: "additional_tools",
					role: "developer",
					tools: [
						{ type: "function", name: "read" },
						{ type: "custom", name: "apply_patch" },
					],
				});
			}
			const history = requests[1]!.input as Array<Record<string, unknown>>;
			expect(JSON.stringify(history)).toContain(firstUser.content);
			expect(history).toContainEqual(
				expect.objectContaining({ type: "function_call", call_id: "call_read", name: "read" }),
			);
			expect(history).toContainEqual(
				expect.objectContaining({ type: "custom_tool_call", call_id: "call_patch", name: "apply_patch" }),
			);
			expect(history).toContainEqual(
				expect.objectContaining({ type: "function_call_output", call_id: "call_read", output: "Original notes" }),
			);
			expect(history).toContainEqual(
				expect.objectContaining({
					type: "custom_tool_call_output",
					call_id: "call_patch",
					output: "Patch applied",
				}),
			);
			expect(headers.map(header => header.get("authorization"))).toEqual([
				"Bearer chatgpt-access-token",
				"Bearer chatgpt-access-token",
			]);
		} finally {
			for (const state of providerSessionState.values()) state.close();
		}
	});

	it("keeps exact local tool choices and hosted web search declarations", () => {
		const { params } = buildParams(
			makeModel(),
			context,
			{ toolChoice: { type: "function", name: "read" } },
			undefined,
		);
		expect(params.tool_choice).toEqual({ type: "function", name: "read" });
		params.tools = [{ type: "web_search" }];
		applyOpenAIChatGPTRequestContract(params);
		expect(params.tools).toEqual([{ type: "web_search" }]);
		expect(params.input?.filter(item => item.type === "additional_tools")).toHaveLength(1);
	});

	it("keeps local computer execution available through a function tool", () => {
		const computer: Tool = {
			name: "computer",
			description: "Operate the local desktop",
			parameters: schemaType({ action: "string" }),
			native: { type: "computer" },
		};
		const { params } = buildParams(makeModel(), { ...context, tools: [computer] }, undefined, undefined);
		expect(params.input?.[0]).toMatchObject({
			type: "additional_tools",
			tools: [{ type: "function", name: "computer" }],
		});
	});

	it.each([
		["temperature", { temperature: 0.5 }],
		["topP", { topP: 0.9 }],
		["maxTokens", { maxTokens: 1024 }],
		["storeResponses", { storeResponses: true }],
	] as const)("explains an explicitly unsupported %s option", (field, options) => {
		expect(() => buildParams(makeModel(), context, options, undefined)).toThrow(field);
	});

	it.each([
		["metadata", { metadata: { label: "caller" } }],
		["previous_response_id", { previous_response_id: "resp_external", input: [] }],
		["max_output_tokens", { max_output_tokens: 1024 }],
		["computer", { tools: [{ type: "computer" }] }],
		["tool_search", { input: [{ type: "additional_tools", role: "developer", tools: [{ type: "tool_search" }] }] }],
	] as const)("rejects unsupported %s in extraBody", (field, extraBody) => {
		expect(() => buildParams(makeModel(), context, { extraBody }, undefined)).toThrow(field);
	});

	it.each(["mutate", "replace"] as const)("checks a %s payload hook before sending", async mode => {
		let fetchCount = 0;
		const result = await streamOpenAIResponses(makeModel(), context, {
			apiKey: "chatgpt-access-token",
			onPayload: payload => {
				const body = payload as Record<string, unknown>;
				if (mode === "replace") return { ...body, stream: false };
				body.store = true;
			},
			fetch: async () => {
				fetchCount++;
				return sse(textEvents("Unexpected", "resp_unexpected"));
			},
		}).result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain(mode === "replace" ? "stream" : "store");
		expect(fetchCount).toBe(0);
	});

	it("does not read API-key fallback when an OAuth token was not resolved", async () => {
		const envKey = spyOn(envApiKeys, "getEnvApiKey").mockReturnValue("unrelated-api-key");
		let fetchCount = 0;
		try {
			const result = await streamOpenAIResponses(makeModel(), context, {
				fetch: async () => {
					fetchCount++;
					return sse(textEvents("Unexpected", "resp_unexpected"));
				},
			}).result();
			expect(result.stopReason).toBe("error");
			expect(result.errorMessage).toContain("OAuth access token");
			expect(envKey).not.toHaveBeenCalled();
			expect(fetchCount).toBe(0);
		} finally {
			envKey.mockRestore();
		}
	});

	it.each(["Authorization", "authorization", "aUtHoRiZaTiOn"])("rejects another credential in %s", async name => {
		let fetchCount = 0;
		const result = await streamOpenAIResponses(makeModel(), context, {
			apiKey: "chatgpt-access-token",
			headers: { [name]: "Bearer unrelated-api-key" },
			fetch: async () => {
				fetchCount++;
				return sse(textEvents("Unexpected", "resp_unexpected"));
			},
		}).result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("selected OAuth access token");
		expect(result.errorMessage).not.toContain("unrelated-api-key");
		expect(fetchCount).toBe(0);
	});

	it("does not send the OAuth bearer to a different base URL", async () => {
		let fetchCount = 0;
		const result = await streamOpenAIResponses({ ...makeModel(), baseUrl: "https://other.example/v1" }, context, {
			apiKey: "chatgpt-access-token",
			fetch: async () => {
				fetchCount++;
				return sse(textEvents("Unexpected", "resp_unexpected"));
			},
		}).result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("https://api.openai.com/v1");
		expect(fetchCount).toBe(0);
	});

	it.each(["failed", "eof"] as const)("does not report success after text followed by %s", async terminal => {
		const events = textEvents("Partial answer", "resp_partial").slice(0, -1);
		if (terminal === "failed") {
			events.push({
				type: "response.failed",
				response: {
					id: "resp_partial",
					status: "failed",
					error: { code: "server_error", message: "Generation failed" },
				},
			});
		}
		let fetchCount = 0;
		const result = await streamOpenAIResponses(makeModel(), context, {
			apiKey: "chatgpt-access-token",
			fetch: async () => {
				fetchCount++;
				return sse(events);
			},
		}).result();
		expect(result.stopReason).toBe("error");
		expect(result.content).toMatchObject([{ type: "text", text: "Partial answer" }]);
		expect(fetchCount).toBe(1);
	});

	it("keeps WebSocket continuation inside the authenticated connection", async () => {
		const wire = endpoint();
		const transports = new OpenAIResponsesTransportSessions();
		const scope = {
			url: `http://127.0.0.1:${wire.server.port}/v1/responses`,
			modelId: "gpt-5-mini",
			sessionId: "chatgpt-ws",
		};
		const signal = new AbortController().signal;
		const firstBody: ResponseCreateParamsBase = {
			model: "gpt-5-mini",
			input: [{ role: "user", content: "Hello" }],
			tools: [{ type: "function", name: "read", parameters: { type: "object", properties: {} }, strict: false }],
		};
		applyOpenAIChatGPTRequestContract(firstBody);
		try {
			const lease = transports.acquire({
				scope,
				headers: { Authorization: "Bearer first-user" },
				connectTimeoutMs: 1000,
				retainConnection: true,
			});
			await lease.session.connection.connect(signal);
			for await (const _event of lease.session.events(firstBody, { signal, chain: true })) {
			}
			lease.release();
			const secondBody: ResponseCreateParamsBase = {
				...firstBody,
				input: [
					...firstBody.input!,
					{
						type: "message",
						id: "msg_resp_1",
						role: "assistant",
						status: "completed",
						content: [{ type: "output_text", text: "WS", annotations: [] }],
					},
					{ role: "user", content: "Continue" },
				],
			};
			applyOpenAIChatGPTRequestContract(secondBody);
			const secondLease = transports.acquire({
				scope,
				headers: { Authorization: "Bearer first-user" },
				connectTimeoutMs: 1000,
				retainConnection: true,
			});
			await secondLease.session.connection.connect(signal);
			for await (const _event of secondLease.session.events(secondBody, { signal, chain: true })) {
			}
			secondLease.release();
			expect(wire.requests[1]?.body.previous_response_id).toBe("resp_1");
			expect(wire.requests[1]?.body.input).toEqual([{ role: "user", content: "Continue" }]);
			expect(wire.requests[1]?.connection).toBe(wire.requests[0]?.connection);
			const changedLease = transports.acquire({
				scope,
				headers: { Authorization: "Bearer second-user" },
				connectTimeoutMs: 1000,
				retainConnection: true,
			});
			await changedLease.session.connection.connect(signal);
			for await (const _event of changedLease.session.events(secondBody, { signal, chain: true })) {
			}
			changedLease.release();
			expect(wire.requests[2]?.body.previous_response_id).toBeUndefined();
			expect(wire.requests[2]?.body.input).toEqual(secondBody.input);
			expect(wire.requests[2]?.connection).not.toBe(wire.requests[1]?.connection);
		} finally {
			transports.close();
			await wire.server.stop(true);
		}
	});
});
