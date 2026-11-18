import { expect, test, vi } from "bun:test";
import { Database } from "bun:sqlite";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
import { Agent } from "@oh-my-pi/pi-agent-core";
import * as piUtils from "@oh-my-pi/pi-utils";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import { AgentSession } from "../src/session/agent-session";
import { SessionManager } from "../src/session/session-manager";
import { cfgExtendedContext, cfgCompactionModelThresholds } from "../src/session/context-settings";
import { resolveModelCompactionSettings } from "../src/session/model-compaction-threshold";
import { resolveThresholdTokens, shouldCompact } from "@oh-my-pi/pi-agent-core/compaction";

test("SIWC discovery rejects custom endpoints and carries account capacity into session usage and compaction", async () => {
	await using temp = await piUtils.TempDir.create("@chatgpt-discovery-config-");
	const installation = "2f4d3706-124e-42eb-98d8-d5e8dfc29264";
	const installId = vi.spyOn(piUtils, "getPersistentInstallId").mockReturnValue(installation);
	const store = new SqliteAuthCredentialStore(new Database(":memory:"));
	const auth = new AuthStorage(store);
	try {
		const registration = {
			registrationId: "registration-a",
			generation: 1,
			hostId: `urn:uuid:${installation}`,
			clientId: "issued-client",
			issuer: "https://auth.openai.com",
			subject: "subject-a",
		};
		store.saveOAuthRegistrationLogin("openai-chatgpt", {
			kind: "registered-oauth",
			registration,
			identity: {
				idToken: "verified-fixture",
				authorizationNonce: "nonce",
				scopes: ["chatgpt.tokens.use.direct"],
			},
			credentials: {
				registrationId: registration.registrationId,
				clientId: registration.clientId,
				hostId: registration.hostId,
				issuer: registration.issuer,
				subject: registration.subject,
				registrationGeneration: 1,
				authMode: "chatgpt-siwc",
				access: "registration-token",
				refresh: "registration-refresh",
				expires: Date.now() + 3_600_000,
				scopes: ["chatgpt.tokens.use.direct"],
				idToken: "verified-fixture",
				authorizationNonce: "nonce",
			},
		});
		await auth.credentials.reload();
		const modelsPath = temp.join("models.yml");
		await Bun.write(
			modelsPath,
			JSON.stringify({
				providers: {
					"openai-chatgpt": {
						api: "openai-responses",
						auth: "oauth",
						baseUrl: "https://proxy.example/v1",
						discovery: { type: "openai-models-list" },
					},
					openai: { apiKey: "ordinary-api-key" },
				},
			}),
		);
		const calls: string[] = [];
		let contextWindow = 272_000;
		let maxContextWindow = 872_000;
		const settings = Settings.isolated({});
		const registry = new ModelRegistry(auth, modelsPath, {
			settings,
			cacheDbPath: temp.join("models.db"),
			fetch: async (input, init) => {
				calls.push(String(input));
				expect(String(input)).toBe("https://api.openai.com/v1/models");
				expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer registration-token");
				return Response.json({
					models: [
						{
							slug: "gpt-6.2-astra",
							display_name: "Astra",
							visibility: "list",
							context_window: contextWindow,
							max_context_window: maxContextWindow,
						},
					],
				});
			},
		});
		expect(registry.getError()?.message).toContain("providers.openai-chatgpt.discovery");
		expect(registry.getError()?.message).toContain("Custom discovery is not supported");
		expect(registry.getDiscoverableProviders()).not.toContain("openai-chatgpt");
		await registry.refreshProvider("openai-chatgpt", "online");
		expect(calls).toEqual(["https://api.openai.com/v1/models"]);
		const selected = () => {
			const model = registry.find("openai-chatgpt", "gpt-6.2-astra");
			if (!model) throw new Error("Expected discovered Astra");
			return model;
		};
		expect(selected().accountAccess).toEqual({ "registration-a": {} });
		expect(selected().contextWindow).toBe(272_000);
		expect(await auth.keys.get("openai")).toBe("ordinary-api-key");

		cfgExtendedContext.override(settings, true);
		await registry.reapplyModelPolicies();
		expect(selected().contextWindow).toBe(872_000);
		expect(calls).toHaveLength(1); // cached capacity survives an offline rebuild
		const target = selected();
		const session = new AgentSession({
			agent: new Agent({
				initialState: {
					model: target,
					systemPrompt: ["Test"],
					tools: [],
					messages: [
						{
							role: "assistant",
							content: [{ type: "text", text: "fixture" }],
							api: target.api,
							provider: target.provider,
							model: target.id,
							timestamp: 1,
							stopReason: "stop",
							usage: {
								input: 235_982,
								output: 1,
								cacheRead: 0,
								cacheWrite: 0,
								totalTokens: 235_983,
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
							},
						},
					],
				},
			}),
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: registry,
		});
		try {
			expect(session.getContextUsage()).toEqual({
				tokens: 235_982,
				contextWindow: 872_000,
				percent: (235_982 / 872_000) * 100,
			});
		} finally {
			await session.dispose();
		}
		cfgCompactionModelThresholds.override(settings, { "openai-chatgpt/*": "f500000" });
		const policy = resolveModelCompactionSettings(settings, selected());
		expect(resolveThresholdTokens(selected().contextWindow!, policy)).toBe(500_000);
		expect(shouldCompact(500_000, selected().contextWindow!, policy)).toBe(false);
		expect(shouldCompact(500_001, selected().contextWindow!, policy)).toBe(true);
		expect(
			resolveModelCompactionSettings(settings, { provider: "openai", id: "gpt-6.2-astra" }).thresholdTokens,
		).not.toBe(500_000);

		// Explicit local windows must not turn the account's 872K allowance into 1M.
		await Bun.write(
			modelsPath,
			JSON.stringify({
				providers: {
					"openai-chatgpt": { modelOverrides: { "gpt-6.2-astra": { contextWindow: 1_000_000 } } },
					openai: { apiKey: "ordinary-api-key" },
				},
			}),
		);
		await registry.reapplyModelPolicies();
		expect(selected().contextWindow).toBe(872_000);

		// A new server limit replaces cached capacity and still clamps overrides.
		contextWindow = 200_000;
		maxContextWindow = 640_000;
		await registry.refreshProvider("openai-chatgpt", "online");
		expect(selected().contextWindow).toBe(640_000);
		expect(calls).toHaveLength(2);

		// The account's disk cache remains, but logout removes its runtime slice.
		store.beginOAuthRegistrationLogout("openai-chatgpt", "registration-a");
		store.finishOAuthRegistrationLogout("openai-chatgpt", "registration-a", 1);
		await auth.credentials.reload();
		await registry.refreshProvider("openai-chatgpt", "offline");
		expect(registry.find("openai-chatgpt", "gpt-6.2-astra")).toBeUndefined();
		expect(calls).toHaveLength(2);
	} finally {
		auth.close();
		installId.mockRestore();
	}
});
