import { validateOpenAIChatGPTModel } from "../providers/openai-chatgpt-contract";
import type { ProviderTransport } from "./build";

/** Keep configured models on the SIWC route before generic API dispatch. */
export const openAIChatGPTTransport: ProviderTransport = {
	validateModel: validateOpenAIChatGPTModel,
};
