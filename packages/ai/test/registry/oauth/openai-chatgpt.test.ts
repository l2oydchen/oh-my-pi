import { beforeAll, describe, expect, test } from "bun:test";
import { exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";
import {
	ChatGPTPlanAccessDisabled,
	OpenAIChatGPTFlow,
	parseEarliestRefreshAt,
	refreshOpenAIChatGPT,
	revokeOpenAIChatGPT,
	verifyChatGPTIdentity,
} from "../../../src/registry/oauth/openai-chatgpt";
import type {
	OAuthAuthInfo,
	OAuthCredentials,
	OAuthRegistrationContext,
	OAuthTokenResponse,
} from "../../../src/registry/oauth/types";
import type { FetchImpl } from "../../../src/types";

const ISSUER = "https://auth.openai.com";
const CLIENT = "registered-fixture";
const SCOPE = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
const DISCOVERY = {
	issuer: ISSUER,
	authorization_endpoint: `${ISSUER}/api/accounts/authorize`,
	token_endpoint: `${ISSUER}/api/accounts/oauth/token`,
	revocation_endpoint: `${ISSUER}/api/accounts/oauth/revoke`,
	jwks_uri: `${ISSUER}/.well-known/jwks.json`,
};
const registration: OAuthRegistrationContext = {
	registrationId: "registration-fixture",
	generation: 0,
	hostId: "urn:uuid:2f4d3706-124e-42eb-98d8-d5e8dfc29264",
};
let privateKey: CryptoKey;
let publicJwk: JWK;

beforeAll(async () => {
	const pair = await generateKeyPair("RS256");
	privateKey = pair.privateKey;
	publicJwk = { ...(await exportJWK(pair.publicKey)), kid: "fixture", alg: "RS256", use: "sig" };
});

function identity(overrides: Record<string, unknown> = {}): Promise<string> {
	const now = Math.floor(Date.now() / 1_000);
	return new SignJWT({
		iss: ISSUER,
		aud: CLIENT,
		sub: "subject-fixture",
		iat: now,
		exp: now + 3_600,
		nonce: "nonce-fixture",
		email: "fixture@example.com",
		...overrides,
	})
		.setProtectedHeader({ alg: "RS256", kid: "fixture" })
		.sign(privateKey);
}

function fixture(token: () => Promise<unknown> = async () => ({})): {
	fetch: FetchImpl;
	requests: { url: string; form: URLSearchParams }[];
} {
	const requests: { url: string; form: URLSearchParams }[] = [];
	return {
		requests,
		fetch: async (input, init) => {
			const url = String(input);
			requests.push({ url, form: new URLSearchParams(String(init?.body ?? "")) });
			if (url.endsWith("/.well-known/openid-configuration")) return Response.json(DISCOVERY);
			if (url.endsWith("/.well-known/jwks.json")) return Response.json({ keys: [publicJwk] });
			if (url === DISCOVERY.token_endpoint) return Response.json(await token());
			throw new Error(`Unexpected fixture request: ${url}`);
		},
	};
}

async function credential(): Promise<OAuthCredentials> {
	return {
		access: "opaque-access-old",
		refresh: "refresh-old",
		expires: 0,
		authMode: "chatgpt-siwc",
		registrationId: registration.registrationId,
		registrationGeneration: 1,
		hostId: registration.hostId,
		clientId: CLIENT,
		issuer: ISSUER,
		subject: "subject-fixture",
		idToken: await identity(),
		authorizationNonce: "nonce-fixture",
		scopes: SCOPE.split(" "),
	};
}

describe("ChatGPT identity verification", () => {
	test("verifies an RS256 signature and matching issuer, audience, nonce and subject", async () => {
		const network = fixture();
		expect(
			await verifyChatGPTIdentity(
				await identity(),
				{ clientId: CLIENT, nonce: "nonce-fixture", requireNonce: true },
				network.fetch,
			),
		).toEqual({ issuer: ISSUER, subject: "subject-fixture", email: "fixture@example.com" });
	});

	test.each([
		{ iss: "https://untrusted.example" },
		{ aud: "another-client" },
		{ nonce: "another-nonce" },
		{ exp: 1 },
		{ sub: "another-subject" },
		{ aud: [CLIENT, "another-client"], azp: "another-client" },
	])("rejects mismatched identity claims %j", async overrides => {
		await expect(
			verifyChatGPTIdentity(
				await identity(overrides),
				{
					clientId: CLIENT,
					nonce: "nonce-fixture",
					requireNonce: true,
					subject: "subject-fixture",
				},
				fixture().fetch,
			),
		).rejects.toThrow();
	});

	test("rejects tampered signatures", async () => {
		const parts = (await identity()).split(".");
		parts[2] = Buffer.from("not-a-signature").toString("base64url");
		await expect(
			verifyChatGPTIdentity(
				parts.join("."),
				{ clientId: CLIENT, nonce: "nonce-fixture", requireNonce: true },
				fixture().fetch,
			),
		).rejects.toThrow();
	});
});

describe("ChatGPT authorization", () => {
	test("keeps identity hints behind the private loopback launcher and ignores forged callback errors", async () => {
		let nonce = "";
		const network = fixture(async () => ({
			access_token: "opaque-access",
			refresh_token: "refresh",
			expires_in: 3_600,
			scope: SCOPE,
			id_token: await identity({ nonce }),
		}));
		const ready = Promise.withResolvers<OAuthAuthInfo>();
		const abort = new AbortController();
		const flow = new OpenAIChatGPTFlow({
			registration: {
				...registration,
				clientId: CLIENT,
				subject: "subject-fixture",
				idToken: "private-identity-hint",
			},
			fetch: network.fetch,
			onAuth: ready.resolve,
			signal: AbortSignal.any([abort.signal, AbortSignal.timeout(5_000)]),
		});
		flow.preferredPort = 0;
		const login = flow.login();
		void login.catch(() => undefined);
		try {
			const info = await ready.promise;
			if (!info.launchUrl) throw new Error("Expected a private browser launcher");
			expect(info.url).toBe(info.launchUrl);
			expect(JSON.stringify(info)).not.toContain("private-identity-hint");
			const launch = await fetch(info.url, { redirect: "manual" });
			const authorization = new URL(launch.headers.get("Location") ?? "");
			expect(authorization.searchParams.get("id_token_hint")).toBe("private-identity-hint");
			expect(launch.headers.get("Cache-Control")).toBe("no-store");
			expect((await fetch(`${new URL(info.url).origin}/launch`, { redirect: "manual" })).status).toBe(404);
			nonce = authorization.searchParams.get("nonce") ?? "";
			const redirect = authorization.searchParams.get("redirect_uri");
			const state = authorization.searchParams.get("state");
			if (!redirect || !state) throw new Error("missing authorization parameters");
			expect((await fetch(`${redirect}?error=access_denied&state=forged`)).status).toBe(500);
			expect((await fetch(`${redirect}?code=fixture&state=${encodeURIComponent(state)}`)).status).toBe(200);
			expect((await login).credentials?.clientId).toBe(CLIENT);
		} finally {
			abort.abort();
			await login.catch(() => undefined);
		}
	});

	test("registers with the durable host and binds issued client ID to token exchange", async () => {
		let nonce = "";
		const network = fixture(async () => ({
			access_token: "opaque-access",
			refresh_token: "refresh",
			expires_in: 3_600,
			scope: SCOPE,
			id_token: await identity({ nonce }),
		}));
		const flow = new OpenAIChatGPTFlow({ registration, fetch: network.fetch });
		const redirect = "http://127.0.0.1:45678/auth/callback";
		const url = new URL((await flow.generateAuthUrl("state-fixture", redirect)).url);
		nonce = url.searchParams.get("nonce") ?? "";
		expect(url.searchParams.get("client_id")).toBe("dynamic_agent_client");
		expect(url.searchParams.get("ext_agent_host_id")).toBe(registration.hostId);
		expect(url.searchParams.get("agent_name_hint")).toBe("oh-my-pi");
		expect(url.searchParams.get("code_challenge_method")).toBe("S256");
		const callback = flow.validateCallback(
			new URL(`${redirect}?code=code-fixture&state=state-fixture&client_id=${CLIENT}`),
			"state-fixture",
		);
		const result = await flow.exchangeToken(callback.code, callback.state, redirect, callback);
		expect(result.credentials?.access).toBe("opaque-access");
		expect(result.registration.clientId).toBe(CLIENT);
		const form = network.requests.find(request => request.url === DISCOVERY.token_endpoint)?.form;
		expect(form?.get("client_id")).toBe(CLIENT);
		expect(form?.get("redirect_uri")).toBe(redirect);
		expect(form?.get("resource")).toBe("https://api.openai.com/v1");
		expect(form?.has("client_secret")).toBe(false);
	});

	test("reuses a saved client, accepts an omitted callback client ID, and requests consent explicitly", async () => {
		const flow = new OpenAIChatGPTFlow({
			fetch: fixture().fetch,
			registration: {
				...registration,
				clientId: CLIENT,
				subject: "subject-fixture",
				intent: "enablePlanUsage",
				idToken: "prior-id-token",
			},
		});
		const redirect = "http://127.0.0.1:1455/auth/callback";
		const url = new URL((await flow.generateAuthUrl("state", redirect)).url);
		expect(url.searchParams.get("client_id")).toBe(CLIENT);
		expect(url.searchParams.has("agent_name_hint")).toBe(false);
		expect(url.searchParams.get("prompt")).toBe("consent");
		expect(url.searchParams.get("id_token_hint")).toBe("prior-id-token");
		expect(flow.validateCallback(new URL(`${redirect}?code=code&state=state`), "state").clientId).toBe(CLIENT);
		expect(() =>
			flow.validateCallback(new URL(`${redirect}?code=code&state=state&client_id=other`), "state"),
		).toThrow("client ID");
		expect(flow.parseManualCallback("code", "state", redirect)).toBeNull();
		expect(flow.parseManualCallback(`${redirect}?code=code`, "state", redirect)).toBeNull();
		expect(
			flow.parseManualCallback("http://localhost:1455/auth/callback?code=code&state=state", "state", redirect),
		).toBeNull();
	});

	test("preserves validated sign-in with only an ID token when plan scope is absent", async () => {
		let nonce = "";
		const network = fixture(async () => ({ scope: "openid profile email", id_token: await identity({ nonce }) }));
		const flow = new OpenAIChatGPTFlow({ registration, fetch: network.fetch });
		const redirect = "http://127.0.0.1:1455/auth/callback";
		nonce = new URL((await flow.generateAuthUrl("state", redirect)).url).searchParams.get("nonce") ?? "";
		const result = await flow.exchangeToken("code", "state", redirect, {
			code: "code",
			state: "state",
			clientId: CLIENT,
		});
		expect(result.credentials).toBeUndefined();
		expect(result.identity.access).toBeUndefined();
		expect(result.identity.refresh).toBeUndefined();
		expect(result.registration.subject).toBe("subject-fixture");
	});
});

describe("ChatGPT rotating refresh", () => {
	test("checkpoints before identity verification and recovers without spending the old refresh token again", async () => {
		const current = await credential();
		let checkpoint: OAuthTokenResponse | undefined;
		let unavailable = true;
		const network = fixture(async () => ({
			access_token: "opaque-new",
			refresh_token: "refresh-new",
			expires_in: 3_600,
			id_token: await identity(),
			scope: SCOPE,
		}));
		const fetchImpl: FetchImpl = async (input, init) => {
			if (String(input) === DISCOVERY.jwks_uri && unavailable) {
				expect(checkpoint?.refresh).toBe("refresh-new");
				throw new Error("temporary key service failure");
			}
			return network.fetch(input, init);
		};
		const context = {
			checkpoint: async (response: OAuthTokenResponse) => {
				checkpoint = response;
			},
		};
		await expect(refreshOpenAIChatGPT(current, undefined, context, fetchImpl)).rejects.toThrow(
			"temporary key service",
		);
		unavailable = false;
		const result = await refreshOpenAIChatGPT(
			{ ...current, pendingRotation: checkpoint },
			undefined,
			context,
			fetchImpl,
		);
		expect(result.refresh).toBe("refresh-new");
		expect(result.access).toBe("opaque-new");
		expect(result.pendingRotation).toBeUndefined();
		expect(network.requests.filter(request => request.url === DISCOVERY.token_endpoint)).toHaveLength(1);
	});

	test("preserves omitted scope and refresh token, but transitions when direct scope is removed", async () => {
		const current = await credential();
		const context = { checkpoint: async (_response: OAuthTokenResponse) => {} };
		const retained = await refreshOpenAIChatGPT(
			current,
			undefined,
			context,
			fixture(async () => ({ access_token: "new", expires_in: 3_600 })).fetch,
		);
		expect(retained.refresh).toBe(current.refresh);
		expect(retained.scopes).toEqual(current.scopes);
		await expect(
			refreshOpenAIChatGPT(
				current,
				undefined,
				context,
				fixture(async () => ({ scope: "openid", id_token: await identity() })).fetch,
			),
		).rejects.toBeInstanceOf(ChatGPTPlanAccessDisabled);
	});

	test("does not mint before earliest_refresh_at or outside durable ownership", async () => {
		const current = await credential();
		const network = fixture();
		await expect(refreshOpenAIChatGPT(current, undefined, undefined, network.fetch)).rejects.toThrow("ownership");
		await expect(
			refreshOpenAIChatGPT(
				{ ...current, earliestRefreshAt: Date.now() + 60_000 },
				undefined,
				{ checkpoint: async () => {} },
				network.fetch,
			),
		).rejects.toThrow("refresh window");
		expect(network.requests).toHaveLength(0);
		expect(parseEarliestRefreshAt(1_800_000_000)).toBe(1_800_000_000_000);
		expect(parseEarliestRefreshAt("2027-01-01T00:00:00Z")).toBe(Date.parse("2027-01-01T00:00:00Z"));
	});

	test("revokes with the issued client and accepts an empty successful body", async () => {
		let attempts = 0;
		const fetchImpl: FetchImpl = async (input, init) => {
			if (String(input).endsWith("openid-configuration")) return Response.json(DISCOVERY);
			expect(String(input)).toBe(DISCOVERY.revocation_endpoint);
			const form = new URLSearchParams(String(init?.body));
			expect(form.get("client_id")).toBe(CLIENT);
			expect(form.get("token")).toBe("latest-refresh");
			return new Response(null, { status: ++attempts === 1 ? 503 : 200 });
		};
		expect(await revokeOpenAIChatGPT(CLIENT, "latest-refresh", undefined, fetchImpl)).toBe(true);
		expect(attempts).toBe(2);
	});
});
