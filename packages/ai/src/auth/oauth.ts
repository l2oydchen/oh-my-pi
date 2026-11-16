import { authPolicyFor } from "@oh-my-pi/pi-catalog/compat/auth";
import { getPersistentInstallId, prompt, untilAborted } from "@oh-my-pi/pi-utils";
import * as AIError from "../error";
import { getProviderDefinition, PASTE_CODE_LOGIN_PROVIDERS } from "../registry";
import { assertProviderEnabled, getOAuthProvider, loginRiskWarning } from "../registry/oauth";
import type { OAuthProviderId, OAuthRegistrationContext } from "../registry/oauth/types";
import { revokeOpenAIChatGPT } from "../registry/oauth/openai-chatgpt";
import { providerTypeKey } from "./blocks";
import type { SessionAffinity } from "./affinity";
import type { KeyOverrides } from "./cascade";
import type { AccountPolicies } from "./policy";
import type { CredentialPool } from "./pool";
import type { OAuthRefresher } from "./refresh";
import type { CredentialSelector } from "./select";
import { hasOAuthRegistrations, hasRefreshLeases, type AuthCredentialStore } from "./store";
import registrationPrompt from "./registration-prompt.md" with { type: "text" };
import type {
	AuthAccountPolicy,
	AuthApiKeyOptions,
	AuthCredentialSnapshotEntry,
	OAuthAccess,
	OAuthAccessResolution,
	OAuthAccountIdentity,
	OAuthAccountSummary,
	OAuthApi,
	OAuthCredential,
	OAuthLoginController,
	OAuthLoginIdentity,
	OAuthLoginOptions,
	OAuthRegistrationSummary,
	OAuthRefreshByIdOptions,
	StoredOAuthRefreshOptions,
	StoredOAuthRefreshResult,
} from "./types";

type StoredOAuthSelection = {
	credentialId: number;
	credential: OAuthCredential;
	index: number;
};

/** Dependencies used by the OAuth account operations. */
export interface OAuthAccountsDeps {
	store: AuthCredentialStore;
	pool: CredentialPool;
	overrides: KeyOverrides;
	policies: AccountPolicies;
	selector: CredentialSelector;
	affinity: SessionAffinity;
	refresher: OAuthRefresher;
}

/** OAuth login, per-account access resolution, and account listings. */
export class OAuthAccounts implements OAuthApi {
	#deps: OAuthAccountsDeps;

	constructor(deps: OAuthAccountsDeps) {
		this.#deps = deps;
	}

	/**
	 * Login to an OAuth provider. Resolves with the stored credential's
	 * identity slice (or `undefined` when nothing was stored) so callers can
	 * surface which account — and for Anthropic, which organization — the
	 * login registered.
	 */
	async login(
		provider: OAuthProviderId,
		ctrl: OAuthLoginController,
		options?: OAuthLoginOptions,
	): Promise<OAuthLoginIdentity | undefined> {
		// Only paste-code providers (fixed non-loopback redirect, e.g. GitLab Duo
		// Agent's vscode:// URI) get a default manual-code prompt. For loopback OAuth
		// providers an eager paste prompt adds noise to a flow that normally completes
		// through HTTP. Synthesizing the default only for paste-code providers is the
		// authoritative gate (it covers every caller, not
		// just the CLI); an explicit caller-supplied `onManualCodeInput` is still
		// honored for any provider as an escape hatch.
		const manualCodeInput = PASTE_CODE_LOGIN_PROVIDERS.has(provider)
			? (signal?: AbortSignal) =>
					untilAborted(signal, () =>
						ctrl.onPrompt({
							message: "Paste the authorization code (or full redirect URL):",
						}),
					)
			: undefined;
		// Built-in registry first, then runtime-registered extension providers.
		const def = getProviderDefinition(provider) ?? getOAuthProvider(provider);
		if (!def?.login) {
			throw new AIError.ConfigurationError(`Unknown OAuth provider: ${provider}`);
		}
		assertProviderEnabled(provider);
		const warning = loginRiskWarning(provider);
		if (warning !== undefined) {
			// No answer but an explicit "yes" starts a login the provider's own terms put at risk.
			const answer = await untilAborted(ctrl.signal, () =>
				ctrl.onPrompt({
					message: `⚠ ${def.name}: use at your own risk\n\n${warning}\n\nType "yes" to accept the risk and continue`,
					placeholder: "yes",
				}),
			);
			if (answer.trim().toLowerCase() !== "yes") throw new AIError.LoginCancelledError();
		}
		const registration = authPolicyFor(provider)?.registrationLogin
			? await this.#loginRegistrationContext(provider, ctrl, options)
			: undefined;
		const result = await def.login({
			onAuth: ctrl.onAuth,
			onProgress: ctrl.onProgress,
			onPrompt: ctrl.onPrompt,
			onManualCodeInput: ctrl.onManualCodeInput ?? manualCodeInput,
			onBrowserSession: ctrl.onBrowserSession,
			signal: ctrl.signal,
			fetch: ctrl.fetch,
			registration,
		});
		if (typeof result === "string") {
			// Some flows (e.g. ollama) return "" to signal that no key was entered.
			if (!result) {
				return undefined;
			}
			// `store-as` routes API-key logins too, not only OAuth credentials.
			await this.#deps.pool.storeLoginApiKey(def.storeCredentialsAs ?? provider, result);
			return { type: "api_key" };
		}
		if ("kind" in result && result.kind === "registered-oauth") {
			const store = this.#deps.store;
			if (!hasOAuthRegistrations(store)) {
				throw new AIError.ConfigurationError("ChatGPT sign-in requires local credential storage");
			}
			try {
				ctrl.signal?.throwIfAborted();
				store.saveOAuthRegistrationLogin(def.storeCredentialsAs ?? provider, result);
			} catch (error) {
				await revokeOpenAIChatGPT(
					result.registration.clientId,
					result.credentials?.refresh ?? result.identity.refresh,
					undefined,
					ctrl.fetch,
				);
				throw error;
			}
			await this.#deps.pool.reload();
			this.#deps.pool.reset(provider);
			return {
				type: "oauth",
				email: result.registration.email,
				registrationId: result.registration.registrationId,
				planAccess: result.credentials ? "enabled" : "disabled",
			};
		}
		// Stamp the interactive-login instant: providers with an absolute grant
		// lifetime (Anthropic) need it to surface re-login deadlines, and token
		// refreshes only ever merge over this credential without clearing it.
		const newCredential: OAuthCredential = {
			type: "oauth",
			...result,
			authorizedAt: Date.now(),
		};
		// Use pool.upsertOAuth to upsert the new credential.
		// Any legacy api_key rows from older versions will be cleaned up so they do not
		// shadow the new OAuth row, while preserving other active OAuth credentials.
		await this.#deps.pool.upsertOAuth(def.storeCredentialsAs ?? provider, newCredential);
		return {
			type: "oauth",
			email: newCredential.email,
			accountId: newCredential.accountId,
			orgId: newCredential.orgId,
			orgName: newCredential.orgName,
		};
	}

	async #loginRegistrationContext(
		provider: string,
		ctrl: OAuthLoginController,
		options?: OAuthLoginOptions,
	): Promise<OAuthRegistrationContext> {
		const store = this.#deps.store;
		if (!hasOAuthRegistrations(store)) {
			throw new AIError.ConfigurationError(
				"This provider requires credentials stored on this computer; remote authentication brokers are not supported",
			);
		}
		const hostId = `urn:uuid:${getPersistentInstallId().toLowerCase()}`;
		const registrations = store.listOAuthRegistrations(provider).filter(item => item.hostId === hostId);
		let registrationId = options?.registration?.kind === "existing" ? options.registration.registrationId : undefined;
		if (!options?.registration) {
			if (registrations.length === 1) registrationId = registrations[0].registrationId;
			else if (registrations.length > 1) {
				const answer = await untilAborted(ctrl.signal, () =>
					ctrl.onPrompt({
						message: prompt.render(registrationPrompt, {
							registrations: registrations.map((item, index) => ({ position: index + 1, label: item.label })),
						}),
					}),
				);
				const selection = Number(answer.trim());
				if (!/^\d+$/.test(answer.trim()) || selection < 0 || selection > registrations.length) {
					throw new AIError.LoginCancelledError("No ChatGPT registration selected");
				}
				registrationId = selection > 0 ? registrations[selection - 1].registrationId : undefined;
			}
		}
		if (!registrationId) return { registrationId: crypto.randomUUID(), generation: 0, hostId, intent: options?.intent };
		const registration = registrations.find(item => item.registrationId === registrationId);
		if (!registration) throw new AIError.ConfigurationError("ChatGPT registration was not found on this installation");
		if (registration.status === "signing_out") {
			throw new AIError.ConfigurationError("This ChatGPT account is signing out; finish logout before signing in again");
		}
		const stored = store.getOAuthRegistrationCredential(provider, registrationId)?.credential;
		return {
			registrationId,
			generation: registration.generation,
			hostId,
			clientId: registration.clientId,
			issuer: registration.issuer,
			subject: registration.subject,
			email: registration.email,
			idToken: stored?.type === "oauth" ? stored.idToken : registration.identity?.idToken,
			intent: options?.intent,
		};
	}

	registrations(provider: string): OAuthRegistrationSummary[] {
		const store = this.#deps.store;
		if (!hasOAuthRegistrations(store)) return [];
		return store.listOAuthRegistrations(provider).map(item => ({
			registrationId: item.registrationId,
			provider: item.provider,
			clientId: item.clientId,
			issuer: item.issuer,
			subject: item.subject,
			email: item.email,
			label: item.label,
			status: item.status,
			planAccess: item.planAccess,
			credentialId: item.credentialId,
		}));
	}

	async logoutRegistration(
		provider: string,
		registrationId: string,
		signal?: AbortSignal,
	): Promise<{ remoteRevoked: boolean }> {
		const store = this.#deps.store;
		if (!hasOAuthRegistrations(store)) {
			throw new AIError.ConfigurationError("Registered OAuth logout requires local credential storage");
		}
		const registration = store.beginOAuthRegistrationLogout(provider, registrationId);
		if (!registration) return { remoteRevoked: true };
		await this.#deps.pool.reload();
		this.#deps.pool.reset(provider);
		const owner = crypto.randomUUID();
		const credentialId = registration.credentialId;
		let acquired = credentialId === undefined;
		let remoteRevoked = false;
		try {
			if (credentialId !== undefined && hasRefreshLeases(store)) {
				const deadline = Date.now() + 65_000;
				do {
					// Do not steal an expired lease: a stalled owner may still be
					// receiving the rotated token. On timeout we clear locally and
					// report remote revocation as unconfirmed instead.
					if (store.getCredentialRefreshLeaseHolder(credentialId) === undefined) {
						acquired = store.tryAcquireCredentialRefreshLease(credentialId, owner, Date.now() + 15_000);
					}
					if (acquired || signal?.aborted) break;
					await Bun.sleep(100);
				} while (Date.now() < deadline);
			}
			// A current refresh owner may checkpoint after logout starts. Read its newest token only after ownership settles.
			const latest = store.getOAuthRegistrationCredential(provider, registrationId)?.credential;
			const refresh =
				latest?.type === "oauth" ? latest.pendingRotation?.refresh ?? latest.refresh : registration.identity?.refresh;
			remoteRevoked = await revokeOpenAIChatGPT(registration.clientId, refresh, signal);
			remoteRevoked &&= acquired;
		} finally {
			// Bump the generation and delete active/disabled token rows, while keeping the issued client ID.
			store.finishOAuthRegistrationLogout(provider, registrationId, registration.generation);
			if (credentialId !== undefined && hasRefreshLeases(store)) {
				store.releaseCredentialRefreshLease(credentialId, owner);
			}
			await this.#deps.pool.reload();
			this.#deps.pool.reset(provider);
		}
		return { remoteRevoked };
	}

	/**
	 * Resolve the OAuth credential for `provider`, refreshing through the same
	 * pipeline as API-key resolution but returning the refreshed
	 * {@link OAuthAccess} (raw access token + identity metadata) instead of
	 * the API-key bytes.
	 *
	 * Use this when the caller needs to inject identity headers alongside the
	 * bearer (Codex `chatgpt-account-id`, Google `project`, GitHub
	 * `enterpriseUrl`). For pure "give me the bytes for `Authorization`"
	 * scenarios, prefer API-key resolution.
	 *
	 * Returns `undefined` when no usable OAuth credential is available
	 * (none stored, or every one definitively failed to refresh) or
	 * runtime/config overrides have replaced OAuth with an explicit API key.
	 * Rejects with {@link AIError.OAuthRefreshUnavailableError} (transient,
	 * retryable) when a retryable refresh failure left no usable credential.
	 */
	async access(provider: string, sessionId?: string, options?: AuthApiKeyOptions): Promise<OAuthAccess | undefined> {
		// Runtime / config overrides intentionally short-circuit OAuth: when the
		// user has pinned an API key, they expect the OAuth identity to be
		// suppressed (same contract as account identity lookup). A session
		// restricted to an account pool never uses a runtime key.
		if (this.#deps.overrides.suppressesOAuth(provider, this.#deps.affinity.isRestricted(provider, sessionId))) {
			return undefined;
		}
		const resolved = await this.#deps.selector.resolveOAuth(provider, sessionId, options);
		if (!resolved) return undefined;
		const { credential, credentialId } = resolved;
		return {
			accessToken: credential.access,
			registrationId: credential.registrationId, clientId: credential.clientId, issuer: credential.issuer, subject: credential.subject,
			credentialId,
			accountId: credential.accountId,
			email: credential.email,
			projectId: credential.projectId,
			enterpriseUrl: credential.enterpriseUrl,
			apiEndpoint: credential.apiEndpoint,
			orgId: credential.orgId,
			orgName: credential.orgName,
			region: credential.region,
			inferenceRegion: credential.inferenceRegion,
		};
	}

	/** Stored OAuth credentials for `provider` in stable order, paired with their full-list index and row id. */
	#getStoredOAuthSelections(provider: string): StoredOAuthSelection[] {
		return this.#deps.pool
			.entries(provider)
			.map((entry, index) => ({
				credentialId: entry.id,
				credential: entry.credential,
				index,
			}))
			.filter((entry): entry is StoredOAuthSelection => entry.credential.type === "oauth");
	}

	/** Refresh one stored OAuth selection and shape it as an {@link OAuthAccessResolution}. */
	async #resolveStoredOAuthAccess(
		provider: string,
		selection: StoredOAuthSelection,
		providerKey: string,
		options: AuthApiKeyOptions | undefined,
	): Promise<OAuthAccessResolution> {
		try {
			// tryOAuth refreshes only expired tokens; it resyncs this row from the store after a forced re-mint.
			let index = selection.index;
			if (options?.forceRefresh) {
				await this.refresh(selection.credentialId, options.signal, {
					reuseRecentMint: options.refreshReason === "auth-recovery",
					reason: options.refreshReason,
					rejectedAccess: options.rejectedAccessToken,
				});
				// The refresh re-lists rows, so a concurrently removed row can shift this one's position.
				index = this.#deps.pool.entries(provider).findIndex(entry => entry.id === selection.credentialId);
				if (index === -1) throw new Error(`OAuth credential ${selection.credentialId} was removed during refresh`);
			}
			const resolved = await this.#deps.selector.tryOAuth(
				provider,
				{ credential: selection.credential, index },
				providerKey,
				undefined,
				options,
				{ checkUsage: false, allowBlocked: true, allowFallback: false },
			);
			if (!resolved) {
				return {
					ok: false,
					registrationId: selection.credential.registrationId,
					credentialId: selection.credentialId,
					accountId: selection.credential.accountId,
					email: selection.credential.email,
					projectId: selection.credential.projectId,
					enterpriseUrl: selection.credential.enterpriseUrl,
					orgId: selection.credential.orgId,
					orgName: selection.credential.orgName,
					error: "OAuth access unavailable",
				};
			}
			const { credential, apiKey } = resolved;
			return {
				ok: true,
				registrationId: credential.registrationId, clientId: credential.clientId, issuer: credential.issuer, subject: credential.subject,
				credentialId: selection.credentialId,
				accessToken: credential.access,
				apiKey,
				accountId: credential.accountId,
				email: credential.email,
				projectId: credential.projectId,
				enterpriseUrl: credential.enterpriseUrl,
				orgId: credential.orgId,
				orgName: credential.orgName,
				region: credential.region,
				inferenceRegion: credential.inferenceRegion,
			};
		} catch (error) {
			return {
				ok: false,
				registrationId: selection.credential.registrationId,
				credentialId: selection.credentialId,
				accountId: selection.credential.accountId,
				email: selection.credential.email,
				projectId: selection.credential.projectId,
				enterpriseUrl: selection.credential.enterpriseUrl,
				orgId: selection.credential.orgId,
				orgName: selection.credential.orgName,
				error: error instanceof Error ? error.message : String(error),
			};
		}
	}

	/**
	 * Read-only list of stored OAuth accounts for `provider` in stable storage
	 * order, WITHOUT refreshing any token. The array position (0-based) is the
	 * selector displayed by a "pick the Nth account" UI as `position + 1`.
	 *
	 * When `sessionId` is supplied, the session-sticky OAuth credential is marked
	 * `active`. No account is active before that session has resolved or pinned a
	 * credential.
	 */
	accounts(provider: string, sessionId?: string): OAuthAccountSummary[] {
		if (this.#deps.overrides.suppressesOAuth(provider, this.#deps.affinity.isRestricted(provider, sessionId))) {
			return [];
		}
		const sessionCredential = this.#deps.affinity.get(provider, sessionId);
		const activeCredentialId =
			sessionCredential?.type === "oauth"
				? this.#deps.pool.entries(provider)[sessionCredential.index]?.id
				: undefined;
		const activeLastUsedAtMs = activeCredentialId !== undefined ? sessionCredential?.lastUsedAtMs : undefined;
		return this.#getStoredOAuthSelections(provider).map((selection, position) => {
			const active = selection.credentialId === activeCredentialId;
			return {
				position,
				registrationId: selection.credential.registrationId, clientId: selection.credential.clientId,
				issuer: selection.credential.issuer, subject: selection.credential.subject,
				credentialId: selection.credentialId,
				accountId: selection.credential.accountId,
				email: selection.credential.email,
				projectId: selection.credential.projectId,
				enterpriseUrl: selection.credential.enterpriseUrl,
				orgId: selection.credential.orgId,
				orgName: selection.credential.orgName,
				active,
				...(active && activeLastUsedAtMs !== undefined ? { lastUsedAtMs: activeLastUsedAtMs } : {}),
			};
		});
	}

	/**
	 * Resolve every stored OAuth credential for `provider` independently.
	 *
	 * Refreshes credentials through the same broker/local path as
	 * {@link OAuthAccounts.access}, but does not rank, round-robin, or
	 * stop after the first usable account. Intended for diagnostics that must
	 * exercise each stored account exactly once.
	 */
	async accessAll(provider: string, options?: AuthApiKeyOptions): Promise<OAuthAccessResolution[]> {
		if (this.#deps.overrides.has(provider)) {
			return [];
		}
		const providerKey = providerTypeKey(provider, "oauth");
		return Promise.all(
			this.#getStoredOAuthSelections(provider).map(selection =>
				this.#resolveStoredOAuthAccess(provider, selection, providerKey, options),
			),
		);
	}

	/**
	 * Resolve one stored OAuth credential by its durable storage row id.
	 *
	 * Unlike the normal session resolver, this method never ranks, rotates, or
	 * falls back to sibling credentials. A generic forced refresh re-mints only the
	 * requested row; with `refreshReason: "auth-recovery"` it may instead reuse a
	 * still-usable recent mint of that row. Either way exact-account affinity holds
	 * for operations whose provenance and policy boundary are tied to one workspace.
	 *
	 * Returns `undefined` when the row does not exist for `provider` or an
	 * explicit runtime/config API-key override suppresses OAuth.
	 */
	async accessById(
		provider: string,
		credentialId: number,
		options?: AuthApiKeyOptions,
	): Promise<OAuthAccessResolution | undefined> {
		if (this.#deps.overrides.has(provider)) {
			return undefined;
		}
		const selection = this.#getStoredOAuthSelections(provider).find(
			candidate => candidate.credentialId === credentialId,
		);
		if (!selection) return undefined;
		const providerKey = providerTypeKey(provider, "oauth");
		return this.#resolveStoredOAuthAccess(provider, selection, providerKey, options);
	}

	/**
	 * Get the OAuth account identity for a provider, preferring the credential that
	 * is session-sticky for `sessionId`. This is a read-only lookup for display and
	 * metadata paths; it does not refresh tokens, rank usage, or advance selection.
	 */
	identity(provider: string, sessionId?: string): OAuthAccountIdentity | undefined {
		const preferred = this.#deps.affinity.activeOAuth(provider, sessionId);
		if (!preferred) return undefined;
		const identity: OAuthAccountIdentity = { registrationId: preferred.registrationId, clientId: preferred.clientId, issuer: preferred.issuer, subject: preferred.subject };
		if (typeof preferred.accountId === "string" && preferred.accountId.length > 0) {
			identity.accountId = preferred.accountId;
		}
		if (typeof preferred.email === "string" && preferred.email.length > 0) {
			identity.email = preferred.email;
		}
		if (typeof preferred.projectId === "string" && preferred.projectId.length > 0) {
			identity.projectId = preferred.projectId;
		}
		if (typeof preferred.orgId === "string" && preferred.orgId.length > 0) {
			identity.orgId = preferred.orgId;
		}
		if (typeof preferred.orgName === "string" && preferred.orgName.length > 0) {
			identity.orgName = preferred.orgName;
		}
		if (!identity.registrationId && !identity.accountId && !identity.email && !identity.projectId && !identity.orgId) return undefined;
		return identity;
	}

	/**
	 * Return the configured account policy matching an OAuth identity.
	 *
	 * This is a read-only diagnostics surface: it performs the same conjunctive
	 * selector match as routing and never refreshes, ranks, or mutates credentials.
	 */
	policy(provider: string, identity: OAuthAccountIdentity): AuthAccountPolicy | undefined {
		return this.#deps.policies.find(provider, identity);
	}

	/** Force-refresh one stored credential by its durable row id. */
	refresh(id: number, signal?: AbortSignal, options?: OAuthRefreshByIdOptions): Promise<AuthCredentialSnapshotEntry> {
		return this.#deps.refresher.refreshById(id, signal, options);
	}

	/** Refresh one stored OAuth credential through the durable ownership path. */
	refreshStored<T extends OAuthCredential = OAuthCredential>(
		provider: string,
		options: StoredOAuthRefreshOptions<T>,
	): Promise<StoredOAuthRefreshResult<T>> {
		return this.#deps.refresher.refreshStored(provider, options);
	}
}
