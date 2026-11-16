import { describe, expect, test } from "bun:test";
import type { OAuthAccessResolution } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { Model } from "@oh-my-pi/pi-catalog/types";
import {
	mergeRegisteredOAuthCatalogs,
	resolveRegisteredOAuthDiscoveryAccounts,
} from "../src/config/model-provider-discovery";
import type { OAuthCredential } from "../src/session/auth-storage";

const provider = "openai-chatgpt";

function credential(registrationId: string): OAuthCredential {
	return {
		type: "oauth",
		registrationId,
		email: "same@example.com",
		access: `${registrationId}-old-token`,
		refresh: `${registrationId}-refresh`,
		expires: 1,
	};
}

function access(registrationId: string): OAuthAccessResolution {
	return {
		ok: true,
		registrationId,
		email: "same@example.com",
		apiKey: `${registrationId}-token`,
		accessToken: `${registrationId}-token`,
	};
}

function model(id: string, registrationId: string): Model {
	return buildModel({
		id,
		name: id,
		api: "openai-responses",
		provider,
		baseUrl: "https://api.openai.com/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: null,
		maxTokens: null,
		accountAccess: { [registrationId]: {} },
	});
}

describe("registered OAuth model discovery", () => {
	test("resolves same-email registrations separately and keeps transient failures cache-only", async () => {
		const credentials = [
			credential("registration-a"),
			credential("registration-b"),
			{ ...credential("pending"), pendingRotation: { scopes: [] } },
			{ ...credential("legacy"), registrationId: undefined },
		];
		const resolutions: OAuthAccessResolution[] = [
			access("registration-a"),
			{ ok: false, error: "Temporary refresh failure" },
			access("pending"),
			{ ok: true, apiKey: "legacy-token", accessToken: "legacy-token", email: "same@example.com" },
		];
		const accounts = await resolveRegisteredOAuthDiscoveryAccounts(
			{
				credentials: { all: () => ({ [provider]: credentials }) },
				oauth: { accessAll: async () => resolutions },
			},
			provider,
			false,
		);
		expect(accounts).toEqual([
			{ registrationId: "registration-a", accessToken: "registration-a-token" },
			{ registrationId: "registration-b", accessToken: undefined },
		]);
	});

	test("offline hydration never refreshes or exposes an expired token to discovery", async () => {
		const accounts = await resolveRegisteredOAuthDiscoveryAccounts(
			{
				credentials: {
					all: () => ({ [provider]: [credential("registration-a"), credential("registration-b")] }),
				},
				oauth: {
					accessAll: async () => {
						throw new Error("Offline hydration must not refresh OAuth");
					},
				},
			},
			provider,
			true,
		);
		expect(accounts).toEqual([
			{ registrationId: "registration-a", accessToken: undefined },
			{ registrationId: "registration-b", accessToken: undefined },
		]);
	});

	test("does not restore a registration removed while credentials are resolving", async () => {
		let credentials = [credential("registration-a"), credential("registration-b")];
		const accounts = await resolveRegisteredOAuthDiscoveryAccounts(
			{
				credentials: { all: () => ({ [provider]: credentials }) },
				oauth: {
					accessAll: async () => {
						credentials = [credential("registration-b")];
						return [access("registration-a"), access("registration-b")];
					},
				},
			},
			provider,
			false,
		);
		expect(accounts).toEqual([{ registrationId: "registration-b", accessToken: "registration-b-token" }]);
	});

	test("unions rosters by registration and removes logged-out account entitlements", () => {
		const catalogs = [
			[model("a-only", "registration-a"), model("common", "registration-a")],
			[model("common", "registration-b"), model("b-only", "registration-b")],
		];
		const combined = mergeRegisteredOAuthCatalogs(catalogs, new Set(["registration-a", "registration-b"]));
		expect(combined.map(entry => entry.id)).toEqual(["a-only", "common", "b-only"]);
		expect(combined[1]?.accountAccess).toEqual({ "registration-a": {}, "registration-b": {} });

		// Discovery may have started before logout; publication must only retain B.
		const afterLogout = mergeRegisteredOAuthCatalogs(catalogs, new Set(["registration-b"]));
		expect(afterLogout.map(entry => entry.id)).toEqual(["common", "b-only"]);
		for (const entry of afterLogout) expect(Object.keys(entry.accountAccess ?? {})).toEqual(["registration-b"]);
		expect(mergeRegisteredOAuthCatalogs(catalogs, new Set())).toEqual([]);
	});
});
