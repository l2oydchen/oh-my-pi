import type { FetchImpl, ModelSpec } from "../types";
import { discoveryFetch, isRecord } from "../utils";
import { isOpenAIChatGPTBaseUrl, OPENAI_CHATGPT_BASE_URL } from "../wire/openai-chatgpt";

/** The documented fields of a Sign in with ChatGPT model card. */
export interface OpenAIChatGPTModelCard {
	slug: string;
	display_name: string;
	visibility: string;
}

export interface FetchOpenAIChatGPTModelsOptions {
	apiKey: string;
	/** Verified local registration that owns the supplied access token. */
	registrationId: string;
	baseUrl?: string;
	fetch?: FetchImpl;
	signal?: AbortSignal;
}

/** Preserve server order and show only explicitly listed models. */
export function parseOpenAIChatGPTModelCards(payload: unknown): OpenAIChatGPTModelCard[] | null {
	if (!isRecord(payload) || !Array.isArray(payload.models)) return null;
	const cards: OpenAIChatGPTModelCard[] = [];
	const seen = new Set<string>();
	for (const raw of payload.models) {
		if (
			!isRecord(raw) ||
			typeof raw.slug !== "string" ||
			!raw.slug.trim() ||
			typeof raw.display_name !== "string" ||
			typeof raw.visibility !== "string"
		) {
			return null;
		}
		if (raw.visibility !== "list") continue;
		const slug = raw.slug.trim();
		if (seen.has(slug)) continue;
		seen.add(slug);
		cards.push({ slug, display_name: raw.display_name.trim(), visibility: raw.visibility });
	}
	return cards;
}

/**
 * Discover the supplied registration's public-API roster. This is a different
 * envelope from API-key `/models`; neither that catalog nor Codex is a fallback.
 * `null` means discovery failed. An empty roster or rejected authorization
 * contributes no models, so another registration cannot inherit its roster.
 */
export async function fetchOpenAIChatGPTModels(
	options: FetchOpenAIChatGPTModelsOptions,
): Promise<ModelSpec<"openai-responses">[] | null> {
	if (!options.apiKey || !options.registrationId) return null;
	if (!isOpenAIChatGPTBaseUrl(options.baseUrl ?? OPENAI_CHATGPT_BASE_URL)) return null;

	let response: Response;
	try {
		response = await discoveryFetch(options.fetch)(`${OPENAI_CHATGPT_BASE_URL}/models`, {
			method: "GET",
			headers: { Accept: "application/json", Authorization: `Bearer ${options.apiKey}` },
			redirect: "error",
			signal: options.signal,
		});
	} catch {
		return null;
	}
	if (response.status === 401 || response.status === 403) return [];
	if (!response.ok) return null;

	let payload: unknown;
	try {
		payload = await response.json();
	} catch {
		return null;
	}
	const cards = parseOpenAIChatGPTModelCards(payload);
	if (cards === null) return null;
	return cards.map(card => ({
		id: card.slug,
		name: card.display_name || card.slug,
		api: "openai-responses",
		provider: "openai-chatgpt",
		baseUrl: OPENAI_CHATGPT_BASE_URL,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: null,
		maxTokens: null,
		accountAccess: { [options.registrationId]: {} },
	}));
}
