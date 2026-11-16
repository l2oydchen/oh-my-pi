import { describe, expect, it } from "bun:test";
import type { AuthStorage, OAuthRegistrationSummary } from "@oh-my-pi/pi-ai";
import { oauthRegistrationLoginChoices } from "@oh-my-pi/pi-coding-agent/session/oauth-registration-choices";
import { listLogoutAccounts, logoutRegistration } from "@oh-my-pi/pi-coding-agent/slash-commands/helpers/logout";

function registration(
	registrationId: string,
	options: Partial<OAuthRegistrationSummary> = {},
): OAuthRegistrationSummary {
	return {
		registrationId,
		provider: "openai-chatgpt",
		clientId: `client-${registrationId}`,
		issuer: "https://auth.openai.com",
		subject: `subject-${registrationId}`,
		email: "same@example.com",
		label: "same@example.com",
		status: "signed_in",
		planAccess: "enabled",
		...options,
	};
}

describe("registration login selection", () => {
	it("starts the first sign-in as a new registration", () => {
		const choices = oauthRegistrationLoginChoices([]);
		expect(choices).toHaveLength(1);
		expect(choices[0]?.options).toEqual({ registration: { kind: "new" }, intent: "connect" });
	});

	it("keeps same-email registrations separate and enables usage only for identity-only sign-ins", () => {
		const choices = oauthRegistrationLoginChoices([
			registration("registration-one", { planAccess: "disabled" }),
			registration("registration-two"),
		]);
		expect(choices[0]?.label).not.toBe(choices[1]?.label);
		expect(choices[0]?.options).toEqual({
			registration: { kind: "existing", registrationId: "registration-one" },
			intent: "enablePlanUsage",
		});
		expect(choices[1]?.options).toEqual({
			registration: { kind: "existing", registrationId: "registration-two" },
			intent: "reconnect",
		});
		expect(choices.at(-1)?.options.registration).toEqual({ kind: "new" });
	});

	it("reuses a signed-out registration and leaves an in-progress logout alone", () => {
		const choices = oauthRegistrationLoginChoices([
			registration("saved", { status: "signed_out", planAccess: "disabled" }),
			registration("pending", { status: "signing_out" }),
		]);
		expect(choices).toHaveLength(2);
		expect(choices[0]?.options).toEqual({
			registration: { kind: "existing", registrationId: "saved" },
			intent: "reconnect",
		});
	});

	it("logs out an identity-only registration through revoke and preserves a remote failure result", async () => {
		let saved = registration("identity-only", { planAccess: "disabled" });
		const calls: string[] = [];
		const authStorage = {
			credentials: { reload: async () => {}, list: () => [] },
			keys: { source: () => undefined, describe: () => undefined },
			oauth: {
				identity: () => undefined,
				registrations: () => [saved],
				logoutRegistration: async (provider: string, registrationId: string) => {
					calls.push(`revoke:${provider}:${registrationId}`);
					saved = { ...saved, status: "signed_out" };
					return { remoteRevoked: false };
				},
			},
		} as unknown as AuthStorage;
		const session = {
			sessionId: "session",
			modelRegistry: {
				authStorage,
				refreshProvider: async (provider: string, strategy: string) => {
					calls.push(`refresh:${provider}:${strategy}`);
				},
			},
			refreshScopedModels: async () => {
				calls.push("scoped-models");
			},
		} as unknown as Parameters<typeof logoutRegistration>[0];
		const accounts = await listLogoutAccounts(authStorage, "openai-chatgpt", "session");
		expect(accounts).toHaveLength(1);
		expect(accounts[0]?.registrationId).toBe("identity-only");
		expect(accounts[0]?.credentialId).toBeUndefined();
		expect(await logoutRegistration(session, "openai-chatgpt", "identity-only")).toMatchObject({
			removed: true,
			remoteRevoked: false,
		});
		expect(calls).toEqual([
			"revoke:openai-chatgpt:identity-only",
			"refresh:openai-chatgpt:online",
			"scoped-models",
		]);
		expect(await listLogoutAccounts(authStorage, "openai-chatgpt", "session")).toEqual([]);
	});
});
