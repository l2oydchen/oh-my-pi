import { beforeAll, describe, expect, it } from "bun:test";
import type { OAuthRegistrationSummary } from "@oh-my-pi/pi-ai";
import { LogoutAccountSelectorComponent } from "@oh-my-pi/pi-tui/overlays/logout-account-selector";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import type { StoredAuthCredential } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import {
	toLogoutAccounts,
	toLogoutRegistrationAccounts,
} from "@oh-my-pi/pi-coding-agent/slash-commands/helpers/logout";

beforeAll(async () => {
	await initTheme();
});

describe("LogoutAccountSelectorComponent", () => {
	it("starts on the active stored account and selects that credential", () => {
		const rows: StoredAuthCredential[] = [
			{
				id: 11,
				provider: "anthropic",
				disabledCause: null,
				credential: {
					type: "oauth",
					access: "access-a",
					refresh: "refresh-a",
					expires: Date.now() + 60_000,
					email: "a@example.com",
					accountId: "acct-a",
				},
			},
			{
				id: 12,
				provider: "anthropic",
				disabledCause: null,
				credential: {
					type: "oauth",
					access: "access-b",
					refresh: "refresh-b",
					expires: Date.now() + 60_000,
					email: "b@example.com",
					accountId: "acct-b",
				},
			},
		];
		const accounts = toLogoutAccounts("anthropic", rows, { activeIdentity: { accountId: "acct-b" } });
		const selected: number[] = [];
		const component = new LogoutAccountSelectorComponent(
			"Anthropic",
			accounts,
			account => {
				if (account.credentialId === undefined) throw new Error("Expected a stored credential");
				selected.push(account.credentialId);
			},
			() => {},
		);

		const rendered = component
			.render(100)
			.map(line => Bun.stripANSI(line))
			.join("\n");
		expect(rendered).toContain("b@example.com (active)");
		expect(rendered.indexOf("b@example.com")).toBeLessThan(rendered.indexOf("a@example.com"));

		component.handleInput("\n");

		expect(selected).toEqual([12]);
	});

	it("selects an identity-only registration by its real id without conflating a shared email", () => {
		const registrations: OAuthRegistrationSummary[] = ["registration-one", "registration-two"].map(id => ({
			registrationId: id,
			provider: "openai-chatgpt",
			clientId: `client-${id}`,
			issuer: "https://auth.openai.com",
			subject: id,
			email: "same@example.com",
			label: "same@example.com",
			status: "signed_in",
			planAccess: "disabled",
		}));
		const accounts = toLogoutRegistrationAccounts("openai-chatgpt", registrations, {
			registrationId: "registration-two",
			email: "same@example.com",
		});
		expect(accounts[0]?.active).toBe(false);
		expect(accounts[1]?.active).toBe(true);
		expect(accounts[0]?.label).not.toBe(accounts[1]?.label);
		expect(accounts.every(account => account.credentialId === undefined)).toBe(true);
		const selected: string[] = [];
		const component = new LogoutAccountSelectorComponent(
			"ChatGPT",
			accounts,
			account => {
				if (!account.registrationId) throw new Error("Expected a registration");
				selected.push(account.registrationId);
			},
			() => {},
		);
		component.handleInput("\n");
		expect(selected).toEqual(["registration-two"]);
	});
});
