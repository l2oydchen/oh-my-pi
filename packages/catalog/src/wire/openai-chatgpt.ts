/** Public API resource accepted by Sign in with ChatGPT access tokens. */
export const OPENAI_CHATGPT_BASE_URL = "https://api.openai.com/v1";

/** Keep account credentials on the public API resource they were issued for. */
export function isOpenAIChatGPTBaseUrl(baseUrl: string): boolean {
	try {
		const url = new URL(baseUrl);
		return (
			url.origin === "https://api.openai.com" &&
			url.pathname.replace(/\/+$/, "") === "/v1" &&
			!url.username &&
			!url.password &&
			!url.search &&
			!url.hash
		);
	} catch {
		return false;
	}
}
