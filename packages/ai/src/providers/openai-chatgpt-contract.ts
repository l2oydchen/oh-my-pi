import { isOpenAIChatGPTBaseUrl, OPENAI_CHATGPT_BASE_URL } from "@oh-my-pi/pi-catalog/wire/openai-chatgpt";
import { isRecord } from "@oh-my-pi/pi-utils";
import { ConfigurationError } from "../error";
import type { Api, Model, StreamOptions } from "../types";
import type { ResponseCreateParamsBase } from "./openai-responses-wire";

// The ChatGPT plan route shares Responses serialization and streaming, but not
// the API-key route's request contract. Keep this check after caller overrides.
// https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations
const UNSUPPORTED_FIELDS = [
	"background",
	"conversation",
	"max_output_tokens",
	"max_tool_calls",
	"metadata",
	"moderation",
	"multi_agent",
	"prompt",
	"prompt_cache_retention",
	"safety_identifier",
	"temperature",
	"top_logprobs",
	"top_p",
	"truncation",
	"user",
] as const;

const UNSUPPORTED_TOOLS = new Set([
	"image_generation",
	"file_search",
	"code_interpreter",
	"computer",
	"computer_use_preview",
	"mcp",
	"tool_search",
]);

function unsupported(field: string, source: string): never {
	throw new ConfigurationError(`Sign in with ChatGPT does not support ${field} in ${source}.`);
}

/** Validate the configured route before selecting an API-specific sender. */
export function validateOpenAIChatGPTModel(model: Model<Api>): void {
	if (model.api !== "openai-responses") {
		throw new ConfigurationError("Sign in with ChatGPT requires the openai-responses API.");
	}
	if (!isOpenAIChatGPTBaseUrl(model.baseUrl)) {
		throw new ConfigurationError(`Sign in with ChatGPT requires ${OPENAI_CHATGPT_BASE_URL}.`);
	}
	const compat = model.compat;
	if (!compat || !("responsesRequestContract" in compat) || compat.responsesRequestContract !== "chatgpt") {
		throw new ConfigurationError("Sign in with ChatGPT requires compat.responsesRequestContract: chatgpt.");
	}
}

/** Reject requests that would otherwise silently borrow API-key authentication. */
export function validateOpenAIChatGPTRequestSetup(
	apiKey: string,
	baseUrl: string | undefined,
	headers: Record<string, string>,
): void {
	if (!isOpenAIChatGPTBaseUrl(baseUrl ?? OPENAI_CHATGPT_BASE_URL)) {
		throw new ConfigurationError(`Sign in with ChatGPT requires ${OPENAI_CHATGPT_BASE_URL}.`);
	}
	const authorization = `Bearer ${apiKey}`;
	for (const [name, value] of Object.entries(headers)) {
		if (name.toLowerCase() !== "authorization") continue;
		if (value !== authorization) {
			throw new ConfigurationError("Sign in with ChatGPT Authorization must use the selected OAuth access token.");
		}
		// The generic setup may have added a differently cased default. Send one
		// header, even when a caller supplied the same bearer under another casing.
		delete headers[name];
	}
	headers.Authorization = authorization;
}

/** Omit generated defaults; explicit caller requests are checked separately. */
export function omitOpenAIChatGPTGeneratedFields(params: ResponseCreateParamsBase): void {
	for (const field of UNSUPPORTED_FIELDS) Reflect.deleteProperty(params, field);
	params.store = false;
	params.stream = true;
}

export function validateOpenAIChatGPTOptions(
	options:
		| (Pick<StreamOptions, "temperature" | "topP" | "maxTokens" | "storeResponses"> & {
				maxTokensExplicit?: boolean;
			})
		| undefined,
): void {
	if (options?.temperature !== undefined) unsupported("temperature", "options");
	if (options?.topP !== undefined) unsupported("topP (top_p)", "options");
	if (options?.maxTokens !== undefined && options.maxTokensExplicit !== false) {
		unsupported("maxTokens (max_output_tokens)", "options");
	}
	if (options?.storeResponses === true) unsupported("storeResponses: true", "options");
}

function validateTools(tools: unknown, source: string, topLevel: boolean): void {
	if (!Array.isArray(tools)) return;
	for (const tool of tools) {
		if (!isRecord(tool)) continue;
		if (
			(typeof tool.type === "string" && UNSUPPORTED_TOOLS.has(tool.type)) ||
			(topLevel && tool.type === "programmatic_tool_calling")
		) {
			unsupported(`tool ${String(tool.type)}`, source);
		}
		if (tool.type === "namespace" || tool.type === "allowed_tools") {
			validateTools(tool.tools, source, false);
		}
	}
}

/** Validate extraBody or a hook result before it can alter the route's semantics. */
export function validateOpenAIChatGPTOverrides(body: unknown, source: string): void {
	if (!isRecord(body)) throw new ConfigurationError(`Sign in with ChatGPT ${source} must be an object.`);
	for (const field of UNSUPPORTED_FIELDS) {
		if (body[field] !== undefined) unsupported(field, source);
	}
	// A caller-supplied anchor may accompany delta-only input. Removing only the
	// anchor could silently discard history. WS anchors are added later by the
	// authenticated connection, never by extraBody/onPayload.
	if (body.previous_response_id !== undefined) unsupported("previous_response_id", source);
	if (body.store !== undefined && body.store !== false) unsupported("store other than false", source);
	if (body.stream !== undefined && body.stream !== true) unsupported("stream other than true", source);
	validateTools(body.tools, source, true);
	validateTools([body.tool_choice], source, true);
	if (body.input !== undefined) {
		if (!Array.isArray(body.input)) {
			throw new ConfigurationError(`Sign in with ChatGPT input in ${source} must be an array with request history.`);
		}
		for (const item of body.input) {
			if (!isRecord(item)) continue;
			if (item.role === "system") unsupported("system input messages; use instructions or developer messages", source);
			if (item.type === "additional_tools") validateTools(item.tools, source, false);
			if (Array.isArray(item.content)) {
				for (const content of item.content) {
					if (isRecord(content) && (content.type === "input_audio" || content.type === "input_video")) {
						unsupported(String(content.type), source);
					}
				}
			}
		}
	}
}

/**
 * Idempotent final request shaping. Local tools retain their existing wire
 * names, strict schemas, custom grammars, choices, and call/result history.
 * Hosted web search remains in top-level tools and follows account/model policy.
 */
export function applyOpenAIChatGPTRequestContract(params: ResponseCreateParamsBase): void {
	validateOpenAIChatGPTOverrides(params, "request payload");
	if (!Array.isArray(params.input)) {
		throw new ConfigurationError("Sign in with ChatGPT input must be an array with request history.");
	}
	params.store = false;
	params.stream = true;
	const localTools = params.tools?.filter(tool => tool.type === "function" || tool.type === "custom");
	if (!localTools?.length) return;
	params.input = [{ type: "additional_tools", role: "developer", tools: localTools }, ...params.input];
	const remainingTools = params.tools?.filter(tool => tool.type !== "function" && tool.type !== "custom");
	if (remainingTools?.length) params.tools = remainingTools;
	else delete params.tools;
}
