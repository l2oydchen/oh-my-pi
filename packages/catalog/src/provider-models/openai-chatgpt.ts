import { providerEntry } from "../compat/providers";
import { fetchOpenAIChatGPTModels } from "../discovery/openai-chatgpt";
import type { ModelManagerOptions } from "../model-manager";
import { resolveModelCacheProviderId } from "./cache-provider-id";
import type { ModelManagerConfig } from "./descriptor-types";

/** Account discovery without API-key or Codex catalog seeds. */
export function openaiChatGPTModelManagerOptions(
	config: ModelManagerConfig = {},
): ModelManagerOptions<"openai-responses"> {
	const { apiKey, registrationId } = config;
	return {
		providerId: "openai-chatgpt",
		staticModels: [],
		cacheProviderId: resolveModelCacheProviderId("openai-chatgpt", config),
		dynamicModelsAuthoritative: providerEntry("openai-chatgpt")?.dynamicModelsAuthoritative === true,
		...(registrationId
			? {
					fetchDynamicModels: () =>
						apiKey
							? fetchOpenAIChatGPTModels({
									apiKey,
									registrationId,
									baseUrl: config.baseUrl,
									fetch: config.fetch,
								})
							: Promise.resolve(null),
				}
			: undefined),
	};
}
