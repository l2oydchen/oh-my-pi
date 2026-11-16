import type { FetchImpl } from "../../types";
import type { OAuthProviderUnion } from "../registry";

export type OAuthCredentials = {
	refresh: string;
	access: string;
	expires: number;
	enterpriseUrl?: string;
	projectId?: string;
	email?: string;
	accountId?: string;
	apiEndpoint?: string;
	/**
	 * Organization/workspace the token is scoped to (e.g. an Anthropic org
	 * UUID or canonical Factory org ID). Lets one account email hold
	 * credentials for multiple subscriptions.
	 */
	orgId?: string;
	/** Human-readable organization name for display (may embed the email). */
	orgName?: string;
	/**
	 * Account residency region (e.g. `"eu"`), when the provider is
	 * region-partitioned. Captured at login; refreshed identity may update it
	 * when the account migrates, while failed lookups preserve the stored value.
	 * Residency selects the API host, not inference eligibility.
	 */
	region?: string;
	/** Factory organization inference scope, independent of account residency. */
	inferenceRegion?: "global" | "eu" | "us";
	/** WorkOS selected organization; never used as a Factory API organization header. */
	activeOrganizationId?: string;
	/**
	 * Epoch ms of the interactive login that minted this grant. Set by
	 * `AuthStorage.oauth.login`; token refreshes preserve it. Providers with an
	 * absolute grant lifetime (Anthropic expires the whole refresh-token
	 * family ~30 days after authorization regardless of rotation) use it to
	 * surface re-login deadlines before the grant dies.
	 */
	authorizedAt?: number;
	/** Locally registered ChatGPT OAuth grant. Access tokens remain opaque. */
	authMode?: "chatgpt-siwc";
	registrationId?: string;
	registrationGeneration?: number;
	clientId?: string;
	hostId?: string;
	issuer?: string;
	subject?: string;
	scopes?: string[];
	idToken?: string;
	authorizationNonce?: string;
	earliestRefreshAt?: number;
	/** A rotated response checkpointed before identity validation completes. Never used for inference. */
	pendingRotation?: OAuthTokenResponse;
};

/** A parsed, untrusted token response. Persisting it does not establish identity. */
export interface OAuthTokenResponse {
	access?: string;
	refresh?: string;
	expires?: number;
	idToken?: string;
	scopes: string[];
	earliestRefreshAt?: number;
}

/** Non-secret registration context prepared by the local credential service. */
export interface OAuthRegistrationContext {
	registrationId: string;
	generation: number;
	hostId: string;
	clientId?: string;
	issuer?: string;
	subject?: string;
	email?: string;
	idToken?: string;
	intent?: "connect" | "reconnect" | "enablePlanUsage";
}

/** A verified identity can be saved even when the user did not grant plan usage. */
export interface OAuthRegistrationLoginResult {
	kind: "registered-oauth";
	registration: OAuthRegistrationContext & { clientId: string; issuer: string; subject: string };
	identity: OAuthTokenResponse & { idToken: string; authorizationNonce: string };
	credentials?: OAuthCredentials;
}

export type OAuthLoginResult = OAuthCredentials | OAuthRegistrationLoginResult | string;

export interface OAuthRefreshContext {
	/** Durable CAS checkpoint under the current refresh lease, before verification/network work. */
	checkpoint(response: OAuthTokenResponse): Promise<void>;
}

export type OAuthProvider = OAuthProviderUnion;

export type OAuthProviderId = OAuthProvider | (string & {});

export type OAuthPrompt = {
	message: string;
	placeholder?: string;
	allowEmpty?: boolean;
	/** Request masked entry from interactive hosts. Hosts that cannot hide input must reject the prompt. */
	secret?: boolean;
};

export type OAuthAuthInfo = {
	/**
	 * Browser launch URL. Usually the authorization URL; flows containing
	 * sensitive identity hints provide a private loopback launcher instead.
	 * Suitable for browser launch, OSC 8 hyperlinks, and an unmodified copy.
	 */
	url: string;
	/**
	 * Short loopback URL that 302-redirects to the authorization URL. Provided by flows
	 * that host the redirect on the same callback server they already run
	 * ({@link OAuthCallbackFlow}). UIs SHOULD prefer this as the copy target
	 * so viewport truncation cannot corrupt OAuth query parameters. Undefined
	 * for flows without a loopback callback server (device code, paste-code
	 * providers with fixed non-loopback redirects, etc.).
	 */
	launchUrl?: string;
	instructions?: string;
};

export interface OAuthProviderInfo {
	id: OAuthProviderId;
	name: string;
	available: boolean;
	/**
	 * Provider id the login stores credentials under, when it differs from `id`
	 * (e.g. `openai-codex-device` ⇒ `openai-codex`). Lets callers map a login
	 * entry back to the model provider it authenticates.
	 */
	storeCredentialsAs?: string;
}

/** Sign-in URL and accepted cookies for an isolated, host-owned browser. */
export type OAuthBrowserSessionRequest = {
	url: string;
	/** Cookie names in preference order; return the first non-empty matching value. */
	cookieNames: readonly string[];
};

export interface OAuthController {
	onAuth?(info: OAuthAuthInfo): void;
	onProgress?(message: string): void;
	/** Request pasted callback input; stop any visible prompt when `signal` aborts. */
	onManualCodeInput?(signal?: AbortSignal): Promise<string>;
	onPrompt?(prompt: OAuthPrompt): Promise<string>;
	/** Complete browser login and return one matching cookie value privately. Reject on cancellation or failure. */
	onBrowserSession?(request: OAuthBrowserSessionRequest, signal?: AbortSignal): Promise<string>;
	signal?: AbortSignal;
	fetch?: FetchImpl;
	/** Internal: created by AuthStorage for registered, local-only OAuth providers. */
	registration?: OAuthRegistrationContext;
}

export interface OAuthLoginCallbacks extends OAuthController {
	onAuth: (info: OAuthAuthInfo) => void;
	onPrompt: (prompt: OAuthPrompt) => Promise<string>;
}

export interface OAuthProviderInterface {
	readonly id: OAuthProviderId;
	readonly name: string;
	readonly sourceId?: string;
	login(callbacks: OAuthLoginCallbacks): Promise<OAuthLoginResult>;
	/** Refresh a stored grant; the signal bounds provider network work to refresh ownership. */
	refreshToken?(credentials: OAuthCredentials, signal?: AbortSignal, context?: OAuthRefreshContext): Promise<OAuthCredentials>;
	getApiKey?(credentials: OAuthCredentials): string;
	/** Store resulting OAuth credentials under a different provider id. */
	readonly storeCredentialsAs?: string;
}
