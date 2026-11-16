import { expect, test, vi } from "bun:test";
import { Database } from "bun:sqlite";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
import * as piUtils from "@oh-my-pi/pi-utils";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";

test("rejects custom SIWC discovery without sending its token there or disabling the built-in roster", async () => {
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
		const registry = new ModelRegistry(auth, modelsPath, {
			settings: Settings.isolated({}),
			cacheDbPath: temp.join("models.db"),
			fetch: async (input, init) => {
				calls.push(String(input));
				expect(String(input)).toBe("https://api.openai.com/v1/models");
				expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer registration-token");
				return Response.json({ models: [{ slug: "gpt-5.5", display_name: "GPT-5.5", visibility: "list" }] });
			},
		});
		expect(registry.getError()?.message).toContain("providers.openai-chatgpt.discovery");
		expect(registry.getError()?.message).toContain("Custom discovery is not supported");
		expect(registry.getDiscoverableProviders()).not.toContain("openai-chatgpt");
		await registry.refreshProvider("openai-chatgpt", "online");
		expect(calls).toEqual(["https://api.openai.com/v1/models"]);
		expect(registry.find("openai-chatgpt", "gpt-5.5")?.accountAccess).toEqual({ "registration-a": {} });
		expect(await auth.keys.get("openai")).toBe("ordinary-api-key");

		// The account's disk cache remains, but logout removes its runtime slice.
		store.beginOAuthRegistrationLogout("openai-chatgpt", "registration-a");
		store.finishOAuthRegistrationLogout("openai-chatgpt", "registration-a", 1);
		await auth.credentials.reload();
		await registry.refreshProvider("openai-chatgpt", "offline");
		expect(registry.find("openai-chatgpt", "gpt-5.5")).toBeUndefined();
		expect(calls).toEqual(["https://api.openai.com/v1/models"]);
	} finally {
		auth.close();
		installId.mockRestore();
	}
});
