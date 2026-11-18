import { describe, expect, test } from "bun:test";
import { TempDir } from "@oh-my-pi/pi-utils";
import { buildModel } from "../src/build";
import { resolveResponsesWebSocketPreference } from "../src/compat/responses-websocket";
import { fetchOpenAIChatGPTModels, parseOpenAIChatGPTModelCards } from "../src/discovery/openai-chatgpt";
import { resolveProviderModels } from "../src/model-manager";
import { resolveModelCacheProviderId } from "../src/provider-models/cache-provider-id";
import { openaiChatGPTModelManagerOptions } from "../src/provider-models/openai-chatgpt";
import type { FetchImpl } from "../src/types";

describe("Sign in with ChatGPT model discovery", () => {
	test.each(["gpt-5.4", "gpt-5.3-codex"])("keeps account capacity instead of the %s API lineage patch", async id => {
		const specs = await fetchOpenAIChatGPTModels({
			apiKey: "fixture",
			registrationId: "r",
			fetch: async () =>
				Response.json({
					models: [
						{
							slug: id,
							display_name: id,
							visibility: "list",
							context_window: 200_000,
							max_context_window: 640_000,
						},
					],
				}),
		});
		if (!specs?.[0]) throw new Error("Missing discovered model");
		expect(buildModel(specs[0]).contextWindow).toBe(200_000);
	});
	test("preserves server context tiers through model construction without filling unknown output limits", async () => {
		const specs = await fetchOpenAIChatGPTModels({
			apiKey: "fixture",
			registrationId: "registration-a",
			fetch: async () =>
				Response.json({
					models: [
						{
							slug: "gpt-6.2-astra",
							display_name: "Astra",
							visibility: "list",
							context_window: 272_000,
							max_context_window: 872_000,
						},
						{
							slug: "gpt-6.2-sol",
							display_name: "Sol",
							visibility: "list",
							context_window: 500_000,
							max_context_window: 872_000,
						},
					],
				}),
		});
		expect(
			specs?.map(spec => {
				const model = buildModel(spec);
				return [model.contextWindow, model.maxContextWindow, model.maxTokens];
			}),
		).toEqual([
			[272_000, 872_000, null],
			[500_000, 872_000, null],
		]);
	});

	test.each([
		[{ context_window: 320_000 }, 320_000, undefined],
		[{ max_context_window: 640_000 }, 640_000, 640_000],
		[{ context_window: 900_000, max_context_window: 640_000 }, 640_000, 640_000],
		[{ context_window: "272000", max_context_window: 0 }, null, undefined],
		[{ context_window: -1, max_context_window: 1.5 }, null, undefined],
	])("handles incomplete or invalid capacity metadata %j", async (fields, expectedWindow, expectedMaximum) => {
		const specs = await fetchOpenAIChatGPTModels({
			apiKey: "fixture",
			registrationId: "r",
			fetch: async () =>
				Response.json({
					models: [{ slug: "gpt-6.2-astra", display_name: "Astra", visibility: "list", ...fields }],
				}),
		});
		expect(specs?.[0]?.contextWindow).toBe(expectedWindow);
		expect(specs?.[0]?.maxContextWindow).toBe(expectedMaximum);
	});
	test("uses the public endpoint and preserves the account's listed order without adding API models", async () => {
		const calls: Array<{ url: string; init?: RequestInit }> = [];
		const fetch: FetchImpl = async (input, init) => {
			calls.push({ url: String(input), init });
			return Response.json({
				models: [
					{ slug: "new-model", display_name: "New Model", visibility: "list" },
					{ slug: "hidden-model", display_name: "Hidden", visibility: "hide" },
					{ slug: "gpt-5.5", display_name: "GPT-5.5", visibility: "list" },
					{ slug: "new-model", display_name: "Duplicate", visibility: "list" },
				],
			});
		};
		const models = await fetchOpenAIChatGPTModels({
			apiKey: "account-token",
			registrationId: "registration-a",
			baseUrl: "https://api.openai.com/v1/",
			fetch,
		});
		expect(calls).toHaveLength(1);
		expect(calls[0]?.url).toBe("https://api.openai.com/v1/models");
		expect(calls[0]?.init).toMatchObject({
			method: "GET",
			headers: { Accept: "application/json", Authorization: "Bearer account-token" },
			redirect: "error",
		});
		expect(models?.map(model => [model.id, model.name])).toEqual([
			["new-model", "New Model"],
			["gpt-5.5", "GPT-5.5"],
		]);
		expect(models?.[0]).toMatchObject({
			provider: "openai-chatgpt",
			api: "openai-responses",
			contextWindow: null,
			maxTokens: null,
			accountAccess: { "registration-a": {} },
		});
	});

	test("distinguishes an empty entitlement roster from incompatible or failed discovery", async () => {
		expect(parseOpenAIChatGPTModelCards({ models: [] })).toEqual([]);
		expect(parseOpenAIChatGPTModelCards({ data: [{ id: "gpt-5.5" }] })).toBeNull();
		expect(
			parseOpenAIChatGPTModelCards({ models: [{ slug: "gpt-5.5", display_name: "GPT", visibility: null }] }),
		).toBeNull();
		const credentials = { apiKey: "account-token", registrationId: "registration-a" };
		expect(
			await fetchOpenAIChatGPTModels({ ...credentials, fetch: async () => new Response(null, { status: 401 }) }),
		).toEqual([]);
		expect(
			await fetchOpenAIChatGPTModels({ ...credentials, fetch: async () => new Response(null, { status: 503 }) }),
		).toBeNull();
		expect(
			await fetchOpenAIChatGPTModels({ ...credentials, fetch: async () => new Response("not JSON") }),
		).toBeNull();
		expect(
			await fetchOpenAIChatGPTModels({
				...credentials,
				fetch: async () => {
					throw new Error("offline");
				},
			}),
		).toBeNull();
	});

	test("does not send registration tokens to a backend, proxy, or modified public URL", async () => {
		let calls = 0;
		const fetch: FetchImpl = async () => {
			calls++;
			return Response.json({ models: [] });
		};
		for (const baseUrl of [
			"https://chatgpt.com/backend-api",
			"https://proxy.example/v1",
			"http://api.openai.com/v1",
			"https://user:password@api.openai.com/v1",
			"https://api.openai.com/v1?redirect=elsewhere",
		]) {
			expect(
				await fetchOpenAIChatGPTModels({ apiKey: "secret", registrationId: "registration-a", baseUrl, fetch }),
			).toBeNull();
		}
		expect(calls).toBe(0);
	});

	test("isolates registration caches, retains them across refresh, and prunes revoked models", async () => {
		await using temp = await TempDir.create("@chatgpt-roster-");
		let calls = 0;
		let empty = false;
		let status = 200;
		const fetch: FetchImpl = async () => {
			calls++;
			if (status !== 200) return new Response(null, { status });
			return Response.json({
				models: empty ? [] : [{ slug: "account-model", display_name: "Account Model", visibility: "list" }],
			});
		};
		const cacheDbPath = temp.join("models.db");
		const options = {
			...openaiChatGPTModelManagerOptions({ apiKey: "old-token", registrationId: "registration-a", fetch }),
			cacheDbPath,
		};
		const online = await resolveProviderModels(options, "online");
		expect(online.models.map(model => model.id)).toEqual(["account-model"]);
		expect(online.models[0]?.accountAccess).toEqual({ "registration-a": {} });

		const refreshed = {
			...openaiChatGPTModelManagerOptions({ apiKey: "new-token", registrationId: "registration-a", fetch }),
			cacheDbPath,
		};
		const fromCache = await resolveProviderModels(refreshed, "online-if-uncached");
		expect(fromCache.models.map(model => model.id)).toEqual(["account-model"]);
		expect(calls).toBe(1);

		const otherAccount = await resolveProviderModels(
			{
				...openaiChatGPTModelManagerOptions({ apiKey: "other-token", registrationId: "registration-b", fetch }),
				cacheDbPath,
			},
			"offline",
		);
		expect(otherAccount.models).toEqual([]);
		const unbound = await resolveProviderModels(
			{ ...openaiChatGPTModelManagerOptions({ apiKey: "new-token", fetch }), cacheDbPath },
			"online",
		);
		expect(unbound.models).toEqual([]);
		expect(calls).toBe(1);
		expect(options.cacheProviderId).not.toContain("old-token");
		expect(options.cacheProviderId).toBe(
			resolveModelCacheProviderId("openai-chatgpt", { registrationId: "registration-a", apiKey: "new-token" }),
		);

		status = 503;
		const unavailable = await resolveProviderModels(refreshed, "online");
		expect(unavailable.models.map(model => model.id)).toEqual(["account-model"]);
		expect(unavailable.stale).toBe(true);
		const cacheOnly = await resolveProviderModels(
			{ ...openaiChatGPTModelManagerOptions({ registrationId: "registration-a", fetch }), cacheDbPath },
			"online",
		);
		expect(cacheOnly.models.map(model => model.id)).toEqual(["account-model"]);
		expect(cacheOnly.stale).toBe(true);
		expect(calls).toBe(2);

		status = 401;
		expect((await resolveProviderModels(refreshed, "online")).models).toEqual([]);
		expect((await resolveProviderModels(refreshed, "offline")).models).toEqual([]);

		status = 200;
		empty = true;
		const removed = await resolveProviderModels(refreshed, "online");
		expect(removed.models).toEqual([]);
		expect(removed.stale).toBe(false);
	});

	test("applies the SIWC contract without inheriting API billing or unsupported transport capabilities", async () => {
		const specs = await fetchOpenAIChatGPTModels({
			apiKey: "account-token",
			registrationId: "registration-a",
			fetch: async () =>
				Response.json({ models: [{ slug: "gpt-6.1-sol", display_name: "GPT-6.1 Sol", visibility: "list" }] }),
		});
		const model = buildModel(specs![0]);
		expect(model).toMatchObject({
			reasoning: true,
			input: ["text", "image"],
			pricingStatus: "included",
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			supportsComputerUse: false,
			omitMaxOutputTokens: true,
			compat: {
				responsesRequestContract: "chatgpt",
				storeResponses: false,
				supportsConfigurationUpdate: false,
				supportsSteering: false,
				supportsSamplingParams: false,
				supportsLongPromptCacheRetention: false,
				supportsPromptCacheBreakpoints: false,
			},
		});
		expect(model.hostedImage).toBeUndefined();
		expect(model.imageModel).toBeUndefined();
		expect(resolveResponsesWebSocketPreference(model, true)).toBe(true);
		const apiModel = buildModel({ ...specs![0], provider: "openai" });
		expect(apiModel.compat.responsesRequestContract).toBeUndefined();
		expect(apiModel.compat.supportsConfigurationUpdate).toBe(true);
		expect(apiModel.supportsComputerUse).toBe(true);
	});
});
