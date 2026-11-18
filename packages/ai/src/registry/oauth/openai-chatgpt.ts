/** OpenAI Sign in with ChatGPT, implemented from the published OAuth/OIDC protocol. */
import { createLocalJWKSet, jwtVerify, type JSONWebKeySet } from "jose";
import * as AIError from "../../error";
import type { FetchImpl } from "../../types";
import { OAuthCallbackFlow, type CallbackResult } from "./callback-server";
import { generatePKCE } from "./pkce";
import type {
	OAuthController,
	OAuthCredentials,
	OAuthRefreshContext,
	OAuthRegistrationContext,
	OAuthRegistrationLoginResult,
	OAuthTokenResponse,
} from "./types";

const ISSUER = "https://auth.openai.com";
const RESOURCE = "https://api.openai.com/v1";
const DYNAMIC_CLIENT = "dynamic_agent_client";
const DIRECT_SCOPE = "chatgpt.tokens.use.direct";
const SCOPES = ["openid", "profile", "email", "offline_access", "resource.invoke", DIRECT_SCOPE];
const DEAD_GRANT_CODES = new Set([
	"invalid_grant",
	"invalid_refresh_token",
	"token_expired",
	"refresh_token_expired",
	"refresh_token_invalidated",
	"refresh_token_reused",
]);

interface Endpoints {
	authorization: string;
	token: string;
	revocation: string;
	jwks: string;
}

/** Error codes are safe to surface; response bodies can contain credentials and are never included. */
export class ChatGPTTokenError extends Error {
	constructor(
		readonly code: string,
		readonly status: number,
	) {
		super(`ChatGPT OAuth token request failed (${code}, HTTP ${status})`);
		this.name = "ChatGPTTokenError";
	}
	get requiresReauthentication(): boolean {
		return DEAD_GRANT_CODES.has(this.code);
	}
}

/** Carries a verified identity transition to the store, without fabricating empty OAuth tokens. */
export class ChatGPTPlanAccessDisabled extends Error {
	constructor(readonly tokens: OAuthTokenResponse) {
		super("ChatGPT sign-in is retained, but plan usage is not authorized. Enable plan usage from login.");
		this.name = "ChatGPTPlanAccessDisabled";
	}
}

function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("ChatGPT OAuth returned an invalid JSON object");
	}
	return value as Record<string, unknown>;
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function trustedEndpoint(value: unknown): string {
	const endpoint = optionalString(value);
	if (!endpoint) throw new Error("ChatGPT discovery omitted an endpoint");
	const url = new URL(endpoint);
	if (url.origin !== ISSUER || url.username || url.password || url.hash) {
		throw new Error("ChatGPT discovery returned an untrusted endpoint");
	}
	return url.href;
}

async function endpoints(fetchImpl: FetchImpl, signal?: AbortSignal): Promise<Endpoints> {
	const response = await fetchImpl(`${ISSUER}/.well-known/openid-configuration`, { signal, redirect: "error" });
	if (!response.ok) throw new Error(`ChatGPT discovery failed (HTTP ${response.status})`);
	const data = object(await response.json());
	if (data.issuer !== ISSUER) throw new Error("ChatGPT discovery issuer did not match");
	return {
		authorization: trustedEndpoint(data.authorization_endpoint),
		token: trustedEndpoint(data.token_endpoint),
		revocation: trustedEndpoint(data.revocation_endpoint),
		jwks: trustedEndpoint(data.jwks_uri),
	};
}

/** OpenAI's numeric timestamp is Unix seconds; a textual timestamp is an ISO date. */
export function parseEarliestRefreshAt(value: unknown): number | undefined {
	const parsed = typeof value === "number" ? value * 1_000 : typeof value === "string" ? Date.parse(value) : NaN;
	return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

export function parseChatGPTTokenResponse(raw: unknown, previousScopes: readonly string[] = []): OAuthTokenResponse {
	const data = object(raw);
	if (
		data.token_type !== undefined &&
		(typeof data.token_type !== "string" || data.token_type.toLowerCase() !== "bearer")
	) {
		throw new Error("ChatGPT OAuth returned an unsupported token type");
	}
	if (data.scope !== undefined && typeof data.scope !== "string")
		throw new Error("ChatGPT OAuth returned invalid scopes");
	const expiresIn = data.expires_in;
	return {
		access: optionalString(data.access_token),
		refresh: optionalString(data.refresh_token),
		idToken: optionalString(data.id_token),
		expires:
			typeof expiresIn === "number" && Number.isFinite(expiresIn) && expiresIn > 0
				? Date.now() + expiresIn * 1_000
				: undefined,
		scopes:
			typeof data.scope === "string" ? [...new Set(data.scope.split(/\s+/).filter(Boolean))] : [...previousScopes],
		earliestRefreshAt: parseEarliestRefreshAt(data.earliest_refresh_at),
	};
}

async function exchange(
	endpoint: string,
	form: Record<string, string>,
	fetchImpl: FetchImpl,
	signal?: AbortSignal,
): Promise<unknown> {
	const response = await fetchImpl(endpoint, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
		body: new URLSearchParams(form),
		redirect: "error",
		signal,
	});
	let raw: unknown;
	try {
		raw = await response.json();
	} catch {
		throw new Error(`ChatGPT OAuth returned an unreadable response (HTTP ${response.status})`);
	}
	if (!response.ok) {
		const code = optionalString(object(raw).error);
		throw new ChatGPTTokenError(code && /^[a-z_]+$/.test(code) ? code : "token_request_failed", response.status);
	}
	return raw;
}

interface VerifiedIdentity {
	issuer: string;
	subject: string;
	email?: string;
}

/** Validate signatures and claims against keys from the fixed issuer, never token-supplied URLs. */
export async function verifyChatGPTIdentity(
	idToken: string,
	context: { clientId: string; nonce?: string; requireNonce: boolean; subject?: string },
	fetchImpl: FetchImpl = fetch,
	signal?: AbortSignal,
	knownEndpoints?: Endpoints,
): Promise<VerifiedIdentity> {
	const discovery = knownEndpoints ?? (await endpoints(fetchImpl, signal));
	const response = await fetchImpl(discovery.jwks, { signal, redirect: "error" });
	if (!response.ok) throw new Error(`ChatGPT identity keys could not be loaded (HTTP ${response.status})`);
	const jwks = object(await response.json());
	if (!Array.isArray(jwks.keys)) throw new Error("ChatGPT identity key set is invalid");
	const { payload } = await jwtVerify(idToken, createLocalJWKSet(jwks as unknown as JSONWebKeySet), {
		issuer: ISSUER,
		audience: context.clientId,
		algorithms: ["RS256"],
		requiredClaims: ["iss", "sub", "aud", "exp", "iat", ...(context.requireNonce ? ["nonce"] : [])],
		clockTolerance: 30,
	});
	if (
		typeof payload.sub !== "string" ||
		!payload.sub.trim() ||
		(context.subject !== undefined && payload.sub !== context.subject)
	) {
		throw new Error("ChatGPT sign-in returned a different account; add it as a separate account");
	}
	if (typeof payload.iat !== "number" || payload.iat > Date.now() / 1_000 + 30)
		throw new Error("ChatGPT identity was issued in the future");
	if ((context.requireNonce || payload.nonce !== undefined) && payload.nonce !== context.nonce) {
		throw new Error("ChatGPT identity nonce did not match");
	}
	if ((Array.isArray(payload.aud) && payload.aud.length > 1) || payload.azp !== undefined) {
		if (payload.azp !== context.clientId) throw new Error("ChatGPT identity authorized party did not match");
	}
	return { issuer: ISSUER, subject: payload.sub, email: optionalString(payload.email) };
}

function completeCredentials(
	tokens: OAuthTokenResponse,
	registration: OAuthRegistrationContext & { clientId: string; issuer: string; subject: string },
	nonce: string,
): OAuthCredentials | undefined {
	if (!tokens.scopes.includes(DIRECT_SCOPE)) return undefined;
	if (!tokens.access || !tokens.refresh || !tokens.expires) {
		throw new Error("ChatGPT plan authorization omitted renewable credentials; sign in again");
	}
	return {
		access: tokens.access,
		refresh: tokens.refresh,
		expires: tokens.expires,
		authMode: "chatgpt-siwc",
		registrationId: registration.registrationId,
		registrationGeneration: registration.generation,
		clientId: registration.clientId,
		hostId: registration.hostId,
		issuer: registration.issuer,
		subject: registration.subject,
		email: registration.email,
		scopes: tokens.scopes,
		idToken: tokens.idToken,
		authorizationNonce: nonce,
		earliestRefreshAt: tokens.earliestRefreshAt,
	};
}

export class OpenAIChatGPTFlow extends OAuthCallbackFlow<OAuthRegistrationLoginResult> {
	#context: OAuthRegistrationContext;
	#endpoints?: Endpoints;
	#verifier?: string;
	#nonce = crypto.randomUUID();
	issuedClientId?: string;

	constructor(controller: OAuthController) {
		super(controller, {
			preferredPort: 1455,
			callbackHostname: "127.0.0.1",
			callbackPath: "/auth/callback",
			privateAuthorizationUrl: true,
		});
		if (!controller.registration)
			throw new AIError.ConfigurationError("ChatGPT sign-in requires local credential storage");
		this.#context = controller.registration;
	}

	async generateAuthUrl(state: string, redirectUri: string): Promise<{ url: string }> {
		this.#endpoints = await endpoints(this.ctrl.fetch ?? fetch, this.ctrl.signal);
		const pkce = await generatePKCE();
		this.#verifier = pkce.verifier;
		const url = new URL(this.#endpoints.authorization);
		const values: Record<string, string> = {
			client_id: this.#context.clientId ?? DYNAMIC_CLIENT,
			redirect_uri: redirectUri,
			response_type: "code",
			response_mode: "query",
			scope: SCOPES.join(" "),
			resource: RESOURCE,
			state,
			nonce: this.#nonce,
			code_challenge: pkce.challenge,
			code_challenge_method: "S256",
			ext_agent_host_id: this.#context.hostId,
		};
		if (!this.#context.clientId) values.agent_name_hint = "oh-my-pi";
		if (this.#context.idToken) values.id_token_hint = this.#context.idToken;
		if (this.#context.email) values.login_hint = this.#context.email;
		if (this.#context.intent === "enablePlanUsage") values.prompt = "consent";
		for (const [key, value] of Object.entries(values)) url.searchParams.set(key, value);
		return { url: url.href };
	}

	override validateCallback(url: URL, expectedState: string): CallbackResult {
		const state = url.searchParams.get("state");
		if (state !== expectedState) throw new Error("ChatGPT callback state did not match");
		const code = url.searchParams.get("code");
		if (!code) throw new Error("ChatGPT callback omitted its authorization code");
		const returnedClientId = optionalString(url.searchParams.get("client_id"));
		if (!this.#context.clientId && !returnedClientId)
			throw new Error("ChatGPT callback omitted its registered client ID");
		if (this.#context.clientId && returnedClientId && returnedClientId !== this.#context.clientId) {
			throw new Error("ChatGPT callback client ID did not match the saved registration");
		}
		const clientId = this.#context.clientId ?? returnedClientId;
		if (!clientId || clientId === DYNAMIC_CLIENT) throw new Error("ChatGPT did not issue a registered client ID");
		this.issuedClientId = clientId;
		return { code, state, clientId };
	}

	override parseManualCallback(input: string, expectedState: string, redirectUri: string): CallbackResult | null {
		let url: URL;
		try {
			url = new URL(input.trim());
		} catch {
			return null;
		}
		const expected = new URL(redirectUri);
		if (
			url.origin !== expected.origin ||
			url.pathname !== expected.pathname ||
			url.hash ||
			url.searchParams.get("state") !== expectedState
		)
			return null;
		if (url.searchParams.has("error")) throw new Error("ChatGPT authorization was declined");
		return this.validateCallback(url, expectedState);
	}

	async exchangeToken(
		code: string,
		_state: string,
		redirectUri: string,
		callback?: CallbackResult,
	): Promise<OAuthRegistrationLoginResult> {
		const clientId = callback?.clientId;
		if (!clientId || !this.#endpoints || !this.#verifier)
			throw new Error("ChatGPT authorization context is incomplete");
		const fetchImpl = this.ctrl.fetch ?? fetch;
		const tokens = parseChatGPTTokenResponse(
			await exchange(
				this.#endpoints.token,
				{
					grant_type: "authorization_code",
					code,
					client_id: clientId,
					code_verifier: this.#verifier,
					redirect_uri: redirectUri,
					resource: RESOURCE,
				},
				fetchImpl,
				this.ctrl.signal,
			),
		);
		if (!tokens.idToken) throw new Error("ChatGPT authorization omitted its identity token");
		const identity = await verifyChatGPTIdentity(
			tokens.idToken,
			{
				clientId,
				nonce: this.#nonce,
				requireNonce: true,
				subject: this.#context.subject,
			},
			fetchImpl,
			this.ctrl.signal,
			this.#endpoints,
		);
		const registration = {
			...this.#context,
			...identity,
			email: identity.email ?? this.#context.email,
			clientId,
			generation: this.#context.generation + 1,
		};
		return {
			kind: "registered-oauth",
			registration,
			identity: { ...tokens, idToken: tokens.idToken, authorizationNonce: this.#nonce },
			credentials: completeCredentials(tokens, registration, this.#nonce),
		};
	}
}

export async function loginOpenAIChatGPT(controller: OAuthController): Promise<OAuthRegistrationLoginResult> {
	let flow = new OpenAIChatGPTFlow(controller);
	try {
		return await flow.login();
	} catch (error) {
		if (
			!(error instanceof ChatGPTTokenError) ||
			error.code !== "invalid_grant" ||
			!flow.issuedClientId ||
			!controller.registration
		)
			throw error;
		controller.onProgress?.("The authorization code expired. Opening a fresh sign-in with the same registration...");
		flow = new OpenAIChatGPTFlow({
			...controller,
			registration: { ...controller.registration, clientId: flow.issuedClientId },
		});
		return flow.login();
	}
}

export async function refreshOpenAIChatGPT(
	credentials: OAuthCredentials,
	signal?: AbortSignal,
	context?: OAuthRefreshContext,
	fetchImpl: FetchImpl = fetch,
): Promise<OAuthCredentials> {
	const { clientId, registrationId, hostId, issuer, subject, authorizationNonce } = credentials;
	if (!clientId || !registrationId || !hostId || issuer !== ISSUER || !subject || !authorizationNonce) {
		throw new AIError.ConfigurationError("ChatGPT registration is incomplete; sign in again");
	}
	if (!context) throw new AIError.ConfigurationError("ChatGPT refresh requires local durable refresh ownership");
	let tokens = credentials.pendingRotation;
	if (!tokens) {
		if (credentials.earliestRefreshAt !== undefined && Date.now() < credentials.earliestRefreshAt) {
			throw new Error("ChatGPT has not yet allowed this grant to refresh; retry after its refresh window opens");
		}
		const discovery = await endpoints(fetchImpl, signal);
		tokens = parseChatGPTTokenResponse(
			await exchange(
				discovery.token,
				{
					grant_type: "refresh_token",
					client_id: clientId,
					refresh_token: credentials.refresh,
					resource: RESOURCE,
				},
				fetchImpl,
				signal,
			),
			credentials.scopes,
		);
		tokens.refresh ??= credentials.refresh;
		// A rotating refresh token must survive a crash or a JWKS/network failure after the exchange.
		await context.checkpoint(tokens);
	}
	let email = credentials.email;
	if (tokens.idToken) {
		const identity = await verifyChatGPTIdentity(
			tokens.idToken,
			{ clientId, nonce: authorizationNonce, requireNonce: false, subject },
			fetchImpl,
			signal,
		);
		email = identity.email ?? email;
	}
	if (!tokens.scopes.includes(DIRECT_SCOPE)) throw new ChatGPTPlanAccessDisabled(tokens);
	const result = completeCredentials(
		{ ...tokens, idToken: tokens.idToken ?? credentials.idToken },
		{
			registrationId,
			generation: credentials.registrationGeneration ?? 0,
			hostId,
			clientId,
			issuer,
			subject,
			email,
		},
		authorizationNonce,
	);
	if (!result) throw new Error("ChatGPT plan authorization is unavailable");
	return { ...result, pendingRotation: undefined };
}

/** Revoke only at the trusted issuer; a failed remote revoke never prevents local logout. */
export async function revokeOpenAIChatGPT(
	clientId: string,
	refreshToken: string | undefined,
	signal?: AbortSignal,
	fetchImpl: FetchImpl = fetch,
): Promise<boolean> {
	if (!refreshToken) return true;
	const bounded = AbortSignal.any([AbortSignal.timeout(10_000), ...(signal ? [signal] : [])]);
	try {
		const discovery = await endpoints(fetchImpl, bounded);
		for (let attempt = 0; attempt < 2; attempt++) {
			try {
				const response = await fetchImpl(discovery.revocation, {
					method: "POST",
					headers: { "Content-Type": "application/x-www-form-urlencoded" },
					body: new URLSearchParams({
						token: refreshToken,
						token_type_hint: "refresh_token",
						client_id: clientId,
					}),
					signal: bounded,
					redirect: "error",
				});
				if (response.ok) return true;
				if (response.status < 500) return false;
			} catch {
				if (bounded.aborted) return false;
			}
		}
	} catch {
		return false;
	}
	return false;
}
