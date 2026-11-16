import type { OAuthLoginOptions, OAuthRegistrationSummary } from "@oh-my-pi/pi-ai";

/** Registrations can share an email; the stable suffix distinguishes them. */
export function formatOAuthRegistrationLabel(registration: OAuthRegistrationSummary): string {
	return `${registration.label || registration.email || "Saved account"} (${registration.registrationId})`;
}

export interface OAuthRegistrationLoginChoice {
	label: string;
	options: OAuthLoginOptions;
}

/** Shared by the existing terminal and in-session login pickers. */
export function oauthRegistrationLoginChoices(
	registrations: readonly OAuthRegistrationSummary[],
): OAuthRegistrationLoginChoice[] {
	const choices = registrations
		.filter(registration => registration.status !== "signing_out")
		.map(registration => {
			const enableUsage = registration.status === "signed_in" && registration.planAccess === "disabled";
			return {
				label: `${enableUsage ? "Enable plan usage" : "Reconnect"}: ${formatOAuthRegistrationLabel(registration)}`,
				options: {
					registration: { kind: "existing", registrationId: registration.registrationId },
					intent: enableUsage ? "enablePlanUsage" : "reconnect",
				},
			} satisfies OAuthRegistrationLoginChoice;
		});
	return [
		...choices,
		{
			label: "Sign in with another account",
			options: { registration: { kind: "new" }, intent: "connect" },
		},
	];
}
