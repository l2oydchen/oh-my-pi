import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import { Database } from "bun:sqlite";
import * as piUtils from "@oh-my-pi/pi-utils";
import { AuthStorage, oauthAccountKey, SqliteAuthCredentialStore, type OAuthCredential } from "../src/auth-storage";
import { serializeCredential } from "../src/auth/sqlite-credential-store";
import { ChatGPTPlanAccessDisabled } from "../src/registry/oauth/openai-chatgpt";
import type { OAuthRegistrationLoginResult, OAuthTokenResponse } from "../src/registry/oauth/types";

const PROVIDER = "openai-chatgpt";
const INSTALL = "2f4d3706-124e-42eb-98d8-d5e8dfc29264";
const REGISTRATION = "registration-fixture";

function loginResult(generation = 1, plan = true): OAuthRegistrationLoginResult {
	const registration = {
		registrationId: REGISTRATION,
		generation,
		hostId: `urn:uuid:${INSTALL}`,
		clientId: "registered-client",
		issuer: "https://auth.openai.com",
		subject: "fixture-subject",
		email: "fixture@example.com",
	};
	const identity = {
		idToken: "fixture-id-token",
		scopes: plan ? ["openid", "chatgpt.tokens.use.direct"] : ["openid"],
		authorizationNonce: "fixture-nonce",
	};
	return {
		kind: "registered-oauth",
		registration,
		identity,
		credentials: plan
			? {
					authMode: "chatgpt-siwc",
					registrationId: REGISTRATION,
					registrationGeneration: generation,
					clientId: registration.clientId,
					hostId: registration.hostId,
					issuer: registration.issuer,
					subject: registration.subject,
					email: registration.email,
					access: "old-access",
					refresh: "old-refresh",
					expires: Date.now() + 3_600_000,
					...identity,
				}
			: undefined,
	};
}

describe("local ChatGPT registration lifecycle", () => {
	let db: Database;
	let store: SqliteAuthCredentialStore;
	let auth: AuthStorage;

	beforeEach(() => {
		vi.spyOn(piUtils, "getPersistentInstallId").mockReturnValue(INSTALL);
		db = new Database(":memory:");
		store = new SqliteAuthCredentialStore(db);
		auth = new AuthStorage(store);
	});

	afterEach(() => {
		auth.close();
		vi.restoreAllMocks();
	});

	function savedCredential(): { id: number; credential: OAuthCredential } {
		const row = store.getOAuthRegistrationCredential(PROVIDER, REGISTRATION);
		if (!row || row.credential.type !== "oauth") throw new Error("missing fixture grant");
		return { id: row.id, credential: row.credential };
	}

	test("retains a validated identity without synthetic empty OAuth tokens", async () => {
		store.saveOAuthRegistrationLogin(PROVIDER, loginResult(1, false));
		await auth.credentials.reload();
		expect(store.listAuthCredentials(PROVIDER)).toEqual([]);
		expect(auth.oauth.registrations(PROVIDER)).toMatchObject([
			{ status: "signed_in", planAccess: "disabled", clientId: "registered-client" },
		]);
		expect(JSON.stringify(auth.oauth.registrations(PROVIDER))).not.toContain("fixture-id-token");
		expect(await auth.keys.get(PROVIDER)).toBeUndefined();
		store.saveOAuthRegistrationLogin(PROVIDER, loginResult(2));
		expect(savedCredential().credential.registrationGeneration).toBe(2);
		expect(store.listOAuthRegistrations(PROVIDER)[0]?.identity).toBeUndefined();
	});

	test("keeps plan OAuth isolated from API-key overrides while ordinary OpenAI API keys still work", async () => {
		store.saveOAuthRegistrationLogin(PROVIDER, loginResult());
		await auth.credentials.reload();
		auth.keys.setRuntime(PROVIDER, "wrong-plan-api-key");
		auth.keys.setConfig(PROVIDER, "wrong-plan-config-key");
		auth.keys.setRuntime("openai", "ordinary-api-key");
		expect(await auth.keys.peek(PROVIDER)).toBe("old-access");
		expect(await auth.keys.get(PROVIDER)).toBe("old-access");
		expect(await auth.keys.get("openai")).toBe("ordinary-api-key");
		await expect(
			auth.keys.getWithCredential(PROVIDER, undefined, { baseUrl: "https://proxy.example/v1" }),
		).rejects.toThrow("api.openai.com/v1");
	});

	test("uses a still-valid access token until the provider permits proactive refresh", async () => {
		const login = loginResult();
		if (!login.credentials) throw new Error("missing fixture credentials");
		login.credentials.expires = Date.now() + 30_000;
		login.credentials.earliestRefreshAt = Date.now() + 15_000;
		store.saveOAuthRegistrationLogin(PROVIDER, login);
		await auth.credentials.reload();
		const request = vi.spyOn(globalThis, "fetch");
		expect(await auth.keys.get(PROVIDER)).toBe("old-access");
		expect(request).not.toHaveBeenCalled();
	});

	test("keeps same-email registrations distinct and honors an existing account pin for discovery and inference", async () => {
		store.saveOAuthRegistrationLogin(PROVIDER, loginResult());
		const other = loginResult();
		other.registration = {
			...other.registration,
			registrationId: "second-registration",
			clientId: "second-client",
			subject: "second-subject",
		};
		if (!other.credentials) throw new Error("missing fixture credentials");
		other.credentials = {
			...other.credentials,
			registrationId: "second-registration",
			clientId: "second-client",
			subject: "second-subject",
			access: "second-access",
		};
		store.saveOAuthRegistrationLogin(PROVIDER, other);
		expect(store.listAuthCredentials(PROVIDER)).toHaveLength(2);
		await auth.credentials.reload();
		const accounts = auth.oauth.accounts(PROVIDER);
		expect(accounts.map(oauthAccountKey)).toEqual([REGISTRATION, "second-registration"]);
		const second = accounts[1];
		if (!second) throw new Error("missing second fixture account");
		expect(auth.sessions.pin(PROVIDER, "session", second.credentialId)).toBe(true);
		expect(
			await auth.keys.getWithCredential(PROVIDER, "session", { accountIds: [REGISTRATION, "second-registration"] }),
		).toMatchObject({
			apiKey: "second-access",
			credentialId: second.credentialId,
			oauthIdentity: { registrationId: "second-registration" },
		});
		expect(await auth.oauth.accessById(PROVIDER, second.credentialId)).toMatchObject({
			ok: true,
			accessToken: "second-access",
			registrationId: "second-registration",
		});
		expect(
			await auth.limits.markReached(PROVIDER, "session", {
				credentialId: second.credentialId,
				retryAfterMs: 60_000,
			}),
		).toEqual({ switched: false });
		expect((await auth.keys.getWithCredential(PROVIDER, "session"))?.apiKey).toBe("second-access");
	});

	test("keeps the issued client across logout while deleting all stored grant secrets", () => {
		store.saveOAuthRegistrationLogin(PROVIDER, loginResult());
		const firstId = savedCredential().id;
		store.beginOAuthRegistrationLogout(PROVIDER, REGISTRATION);
		store.finishOAuthRegistrationLogout(PROVIDER, REGISTRATION, 1);
		expect(store.listAuthCredentials(PROVIDER)).toEqual([]);
		expect(db.query("SELECT data FROM auth_credentials").all()).toEqual([]);
		const retained = store.listOAuthRegistrations(PROVIDER)[0];
		expect(retained).toMatchObject({
			clientId: "registered-client",
			status: "signed_out",
			planAccess: "disabled",
			generation: 2,
		});
		expect(retained?.identity).toBeUndefined();
		store.saveOAuthRegistrationLogin(PROVIDER, loginResult(3));
		expect(savedCredential().id).toBeGreaterThan(firstId);
		expect(savedCredential().credential.clientId).toBe("registered-client");
	});

	test("rejects an authorization finishing after logout advanced the registration generation", () => {
		store.saveOAuthRegistrationLogin(PROVIDER, loginResult());
		const staleLogin = loginResult(2);
		store.beginOAuthRegistrationLogout(PROVIDER, REGISTRATION);
		store.finishOAuthRegistrationLogout(PROVIDER, REGISTRATION, 1);
		expect(() => store.saveOAuthRegistrationLogin(PROVIDER, staleLogin)).toThrow("changed");
		expect(store.listAuthCredentials(PROVIDER)).toEqual([]);
	});

	test("advances the refresh CAS after checkpoint and clears pending state on verified finalization", async () => {
		store.saveOAuthRegistrationLogin(PROVIDER, loginResult());
		const initial = savedCredential();
		const tokens: OAuthTokenResponse = {
			access: "new-access",
			refresh: "new-refresh",
			expires: Date.now() + 3_600_000,
			scopes: ["chatgpt.tokens.use.direct"],
		};
		const result = await auth.oauth.refreshStored(PROVIDER, {
			credentialId: initial.id,
			credentialFromRow: row => row,
			forceRefresh: true,
			refresh: async (current, _signal, context) => {
				if (!context) throw new Error("missing durable checkpoint context");
				await context.checkpoint(tokens);
				expect(savedCredential().credential.pendingRotation?.refresh).toBe("new-refresh");
				return {
					...current,
					access: "new-access",
					refresh: "new-refresh",
					expires: tokens.expires ?? 0,
					scopes: tokens.scopes,
				};
			},
		});
		expect(result.refreshed).toBe(true);
		expect(savedCredential().credential).toMatchObject({
			access: "new-access",
			refresh: "new-refresh",
			registrationGeneration: 1,
		});
		expect(savedCredential().credential.pendingRotation).toBeUndefined();
	});

	test("retains the checkpoint after post-exchange verification fails", async () => {
		store.saveOAuthRegistrationLogin(PROVIDER, loginResult());
		const initial = savedCredential();
		await expect(
			auth.oauth.refreshStored(PROVIDER, {
				credentialId: initial.id,
				credentialFromRow: row => row,
				forceRefresh: true,
				refresh: async (_current, _signal, context) => {
					if (!context) throw new Error("missing durable checkpoint context");
					await context.checkpoint({ refresh: "new-refresh", scopes: ["chatgpt.tokens.use.direct"] });
					throw new Error("JWKS unavailable");
				},
			}),
		).rejects.toThrow("JWKS unavailable");
		expect(savedCredential().credential.pendingRotation?.refresh).toBe("new-refresh");
		expect(savedCredential().credential.expires).toBe(0);
		expect(await auth.keys.peek(PROVIDER, { includeExpired: true })).toBeUndefined();
		const snapshot = JSON.stringify(auth.credentials.snapshot());
		expect(snapshot).not.toContain("new-refresh");
		expect(snapshot).not.toContain("fixture-id-token");
	});

	test("downgrades a refreshed identity when plan scope is removed", async () => {
		store.saveOAuthRegistrationLogin(PROVIDER, loginResult());
		const initial = savedCredential();
		const tokens: OAuthTokenResponse = {
			idToken: "renewed-identity",
			refresh: "identity-refresh",
			scopes: ["openid"],
		};
		await auth.oauth.refreshStored(PROVIDER, {
			credentialId: initial.id,
			credentialFromRow: row => row,
			forceRefresh: true,
			refresh: async (_current, _signal, context) => {
				if (!context) throw new Error("missing durable checkpoint context");
				await context.checkpoint(tokens);
				throw new ChatGPTPlanAccessDisabled(tokens);
			},
		});
		expect(store.listAuthCredentials(PROVIDER)).toEqual([]);
		expect(auth.oauth.registrations(PROVIDER)[0]).toMatchObject({ status: "signed_in", planAccess: "disabled" });
		expect(store.listOAuthRegistrations(PROVIDER)[0]?.identity?.refresh).toBe("identity-refresh");
	});

	test("allows the current refresh checkpoint during logout, then revokes its latest token without resurrecting access", async () => {
		store.saveOAuthRegistrationLogin(PROVIDER, loginResult());
		const initial = savedCredential();
		const started = Promise.withResolvers<void>();
		const proceed = Promise.withResolvers<void>();
		const revoked: Array<string | null> = [];
		vi.spyOn(globalThis, "fetch").mockImplementation(
			Object.assign(
				async (input: string | URL | Request, init?: RequestInit) => {
					if (String(input).endsWith("openid-configuration"))
						return Response.json({
							issuer: "https://auth.openai.com",
							authorization_endpoint: "https://auth.openai.com/api/accounts/authorize",
							token_endpoint: "https://auth.openai.com/api/accounts/oauth/token",
							revocation_endpoint: "https://auth.openai.com/api/accounts/oauth/revoke",
							jwks_uri: "https://auth.openai.com/.well-known/jwks.json",
						});
					revoked.push(new URLSearchParams(String(init?.body)).get("token"));
					return new Response(null, { status: 200 });
				},
				{ preconnect: fetch.preconnect },
			),
		);
		const refreshing = auth.oauth.refreshStored(PROVIDER, {
			credentialId: initial.id,
			credentialFromRow: row => row,
			forceRefresh: true,
			refresh: async (current, _signal, context) => {
				started.resolve();
				await proceed.promise;
				if (!context) throw new Error("missing durable checkpoint context");
				await context.checkpoint({
					refresh: "latest-refresh",
					access: "latest-access",
					expires: Date.now() + 3_600_000,
					scopes: ["chatgpt.tokens.use.direct"],
				});
				return { ...current, refresh: "latest-refresh", access: "latest-access", expires: Date.now() + 3_600_000 };
			},
		});
		await started.promise;
		const signingOut = auth.oauth.logoutRegistration(PROVIDER, REGISTRATION);
		expect(store.listOAuthRegistrations(PROVIDER)[0]?.status).toBe("signing_out");
		proceed.resolve();
		await refreshing;
		expect(await signingOut).toEqual({ remoteRevoked: true });
		expect(revoked).toEqual(["latest-refresh"]);
		expect(store.listAuthCredentials(PROVIDER)).toEqual([]);
		expect(db.query("SELECT data FROM auth_credentials").all()).toEqual([]);
		const serialized = serializeCredential(PROVIDER, initial.credential);
		if (!serialized) throw new Error("missing fixture serialization");
		expect(store.tryUpdateAuthCredentialIfMatches(initial.id, serialized.data, initial.credential)).toBe(false);
	});

	test("removes unusable refresh-token secrets and retains the registration for reconnect", () => {
		store.saveOAuthRegistrationLogin(PROVIDER, loginResult());
		const current = savedCredential();
		const serialized = serializeCredential(PROVIDER, current.credential);
		if (!serialized) throw new Error("missing fixture serialization");
		expect(store.tryDisableAuthCredentialIfMatches(current.id, serialized.data, "invalid_grant")).toBe(true);
		expect(db.query("SELECT data FROM auth_credentials").all()).toEqual([]);
		expect(auth.oauth.registrations(PROVIDER)[0]).toMatchObject({
			clientId: "registered-client",
			status: "reauth_required",
		});
	});

	test("a dead grant finishing during logout cannot replace the requested signed-out state", () => {
		store.saveOAuthRegistrationLogin(PROVIDER, loginResult());
		const current = savedCredential();
		const serialized = serializeCredential(PROVIDER, current.credential);
		if (!serialized) throw new Error("missing fixture serialization");
		store.beginOAuthRegistrationLogout(PROVIDER, REGISTRATION);
		expect(store.tryDisableAuthCredentialIfMatches(current.id, serialized.data, "invalid_grant")).toBe(true);
		store.finishOAuthRegistrationLogout(PROVIDER, REGISTRATION, 1);
		expect(auth.oauth.registrations(PROVIDER)[0]).toMatchObject({ status: "signed_out" });
	});

	test("does not steal an expired refresh lease during logout, and still clears locally on cancellation", async () => {
		store.saveOAuthRegistrationLogin(PROVIDER, loginResult());
		store.tryAcquireCredentialRefreshLease(savedCredential().id, "stalled-owner", Date.now() - 1);
		const acquire = vi.spyOn(store, "tryAcquireCredentialRefreshLease");
		expect(await auth.oauth.logoutRegistration(PROVIDER, REGISTRATION, AbortSignal.abort())).toEqual({
			remoteRevoked: false,
		});
		expect(acquire).not.toHaveBeenCalled();
		expect(store.listAuthCredentials(PROVIDER)).toEqual([]);
		expect(auth.oauth.registrations(PROVIDER)[0]?.status).toBe("signed_out");
	});
});
