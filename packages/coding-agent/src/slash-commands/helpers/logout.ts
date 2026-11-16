import { getOAuthCredentialProvider } from "@oh-my-pi/pi-ai/oauth";
import type { OAuthRegistrationSummary } from "@oh-my-pi/pi-ai";
import type { AgentSession } from "../../session/agent-session";
import type { AuthStorage, OAuthAccountIdentity, StoredAuthCredential } from "../../session/auth-storage";
import { formatOAuthRegistrationLabel } from "../../session/oauth-registration-choices";

import type { LogoutAccount } from "@oh-my-pi/pi-tui/overlays/logout-account-selector";

interface LogoutAccountOptions {
	activeIdentity?: OAuthAccountIdentity;
	activeApiKey?: boolean;
}

function nonEmpty(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function oauthLabel(row: StoredAuthCredential): string {
	const credential = row.credential;
	if (credential.type !== "oauth") return `API key #${row.id}`;
	const base =
		nonEmpty(credential.email) ??
		nonEmpty(credential.accountId) ??
		nonEmpty(credential.projectId) ??
		nonEmpty(credential.enterpriseUrl) ??
		`OAuth credential #${row.id}`;
	// Two subscriptions (orgs) can share one email — the org is the only
	// user-visible way to tell which row a logout will remove.
	const org = nonEmpty(credential.orgName) ?? nonEmpty(credential.orgId);
	return org && org !== base ? `${base} (${org})` : base;
}

function oauthDetail(row: StoredAuthCredential, label: string): string {
	const credential = row.credential;
	if (credential.type === "api_key") return `stored API key #${row.id}`;
	const parts: string[] = [];
	const email = nonEmpty(credential.email);
	const accountId = nonEmpty(credential.accountId);
	const projectId = nonEmpty(credential.projectId);
	const enterpriseUrl = nonEmpty(credential.enterpriseUrl);
	if (email && email !== label) parts.push(email);
	if (accountId && accountId !== label) parts.push(`account ${accountId}`);
	if (projectId && projectId !== label) parts.push(`project ${projectId}`);
	if (enterpriseUrl && enterpriseUrl !== label) parts.push(enterpriseUrl);
	parts.push(`oauth #${row.id}`);
	return parts.join(" · ");
}

function oauthMatchesActiveIdentity(
	row: StoredAuthCredential,
	activeIdentity: OAuthAccountIdentity | undefined,
): boolean {
	if (!activeIdentity || row.credential.type !== "oauth") return false;
	const credential = row.credential;
	if (activeIdentity.registrationId !== undefined || credential.registrationId !== undefined) {
		return credential.registrationId !== undefined && credential.registrationId === activeIdentity.registrationId;
	}
	// The org GATES the base identity rather than replacing it: mismatched org
	// presence or different orgs never match — an org-scoped active session
	// must not preselect the bare-email legacy row, and a bare-email active
	// row must not mark org-scoped siblings active via the shared email. A
	// SHARED org still requires the base-identity match below: two Team seats
	// share one orgId yet own distinct rows. Only an org-only active identity
	// (no base identifiers recovered at all) matches on the org alone.
	if (activeIdentity.orgId !== undefined || credential.orgId !== undefined) {
		if (credential.orgId !== activeIdentity.orgId) return false;
		if (
			activeIdentity.accountId === undefined &&
			activeIdentity.email === undefined &&
			activeIdentity.projectId === undefined
		) {
			return true;
		}
	}
	// When both sides carry an email it decides: Codex Team seats share an
	// account id and Antigravity accounts share one Google project.
	if (activeIdentity.email !== undefined && credential.email !== undefined) {
		return credential.email === activeIdentity.email;
	}
	return (
		(activeIdentity.accountId !== undefined && credential.accountId === activeIdentity.accountId) ||
		(activeIdentity.projectId !== undefined && credential.projectId === activeIdentity.projectId)
	);
}

/** Identity-only sign-ins have no inference credential row, but still need logout. */
export function toLogoutRegistrationAccounts(
	provider: string,
	registrations: readonly OAuthRegistrationSummary[],
	activeIdentity?: OAuthAccountIdentity,
): LogoutAccount[] {
	return registrations
		.filter(registration => registration.status !== "signed_out")
		.map(registration => ({
			registrationId: registration.registrationId,
			provider,
			label: formatOAuthRegistrationLabel(registration),
			detail: registration.planAccess === "disabled" ? "identity sign-in · plan usage disabled" : "ChatGPT plan usage",
			type: "oauth",
			active: activeIdentity?.registrationId === registration.registrationId,
		}) satisfies LogoutAccount);
}

export function toLogoutAccounts(
	provider: string,
	credentials: StoredAuthCredential[],
	options: LogoutAccountOptions = {},
): LogoutAccount[] {
	return credentials
		.map(row => {
			const label = oauthLabel(row);
			const active =
				row.credential.type === "oauth"
					? oauthMatchesActiveIdentity(row, options.activeIdentity)
					: options.activeApiKey === true;
			return {
				credentialId: row.id,
				provider,
				label,
				detail: oauthDetail(row, label),
				type: row.credential.type,
				active,
			} satisfies LogoutAccount;
		})
		.sort((left, right) => {
			if (left.active !== right.active) return left.active ? -1 : 1;
			return left.label.localeCompare(right.label) || left.credentialId - right.credentialId;
		});
}

/** Stored accounts `/logout` can remove for `provider`, active first. Reloads the store to see other processes' changes. */
export async function listLogoutAccounts(
	authStorage: AuthStorage,
	loginProvider: string,
	sessionId: string,
): Promise<LogoutAccount[]> {
	const provider = getOAuthCredentialProvider(loginProvider);
	await authStorage.credentials.reload();
	const activeIdentity = authStorage.oauth.identity(provider, sessionId);
	const registrations = authStorage.oauth.registrations(provider);
	const registeredIds = new Set(registrations.map(registration => registration.registrationId));
	const credentials = authStorage.credentials.list(provider).filter(
		row =>
			row.credential.type !== "oauth" ||
			row.credential.registrationId === undefined ||
			!registeredIds.has(row.credential.registrationId),
	);
	const credentialsToLogout = toLogoutAccounts(provider, credentials, {
		activeIdentity,
		activeApiKey: authStorage.keys.source(provider)?.kind === "api_key",
	});
	return [...credentialsToLogout, ...toLogoutRegistrationAccounts(provider, registrations, activeIdentity)].sort(
		(left, right) => {
			if (left.active !== right.active) return left.active ? -1 : 1;
			return left.label.localeCompare(right.label);
		},
	);
}

/** Revoke this registration and clear its local secrets before refreshing models. */
export async function logoutRegistration(
	session: Pick<AgentSession, "modelRegistry" | "sessionId" | "refreshScopedModels">,
	loginProvider: string,
	registrationId: string,
): Promise<{ removed: boolean; remainingSource?: string; remoteRevoked?: boolean }> {
	const provider = getOAuthCredentialProvider(loginProvider);
	const modelRegistry = session.modelRegistry;
	const authStorage = modelRegistry.authStorage;
	await authStorage.credentials.reload();
	const registration = authStorage.oauth.registrations(provider).find(item => item.registrationId === registrationId);
	if (!registration || registration.status === "signed_out") return { removed: false };
	const { remoteRevoked } = await authStorage.oauth.logoutRegistration(provider, registrationId);
	await modelRegistry.refreshProvider(provider, "online");
	await session.refreshScopedModels();
	return { removed: true, remoteRevoked, remainingSource: authStorage.keys.describe(provider, session.sessionId) };
}

/**
 * Removes one stored credential and refreshes the provider's models.
 * `removed: false` means the credential was already gone; `remainingSource`
 * names the auth source that still authenticates the provider, if any.
 */
export async function logoutCredential(
	session: Pick<AgentSession, "modelRegistry" | "sessionId" | "refreshScopedModels">,
	loginProvider: string,
	credentialId: number,
): Promise<{ removed: boolean; remainingSource?: string; remoteRevoked?: boolean }> {
	const provider = getOAuthCredentialProvider(loginProvider);
	const modelRegistry = session.modelRegistry;
	const authStorage = modelRegistry.authStorage;
	// Reload so an id stored by another process is found, not reported missing.
	await authStorage.credentials.reload();
	const row = authStorage.credentials.list(provider).find(credential => credential.id === credentialId);
	if (row?.credential.type === "oauth" && row.credential.registrationId !== undefined) {
		return logoutRegistration(session, loginProvider, row.credential.registrationId);
	}
	if (!(await authStorage.credentials.removeById(provider, credentialId))) return { removed: false };
	// Provider-scoped online refresh so the removed credential's stale
	// endpoint/deployment models are invalidated deterministically; the
	// default all-provider `online-if-uncached` would reuse the fresh
	// authoritative cache row and keep showing models the credential
	// unlocked (#5780). Other providers are left untouched.
	await modelRegistry.refreshProvider(provider, "online");
	await session.refreshScopedModels();
	return { removed: true, remainingSource: authStorage.keys.describe(provider, session.sessionId) };
}
