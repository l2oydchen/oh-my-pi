import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, type OAuthCredential, REMOTE_REFRESH_SENTINEL, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
import {
	AuthBrokerClient,
	type AuthBrokerServerHandle,
	RemoteAuthCredentialStore,
	startAuthBroker,
} from "@oh-my-pi/pi-ai/auth-broker";
import * as piUtils from "@oh-my-pi/pi-utils";
import { removeWithRetries } from "../../utils/src/temp";

// MCP OAuth credentials extend the base OAuthCredential with refresh material
// (tokenUrl/clientId/clientSecret/resource) embedded so token refresh works for
// configs that carry no `auth` block. These extension fields MUST survive the
// broker upload + snapshot round-trip; the wire schemas previously dropped them
// (`.strict()` rejected unknown keys), so a broker-backed reauth reported
// success while the reloaded credential could no longer refresh.
const MCP_PROVIDER = "mcp_oauth:profile:default:https://mcp.example.com/sse?project_ref=abc";
const EXTRA_FIELDS = {
	tokenUrl: "https://mcp.example.com/oauth/token",
	clientId: "client-xyz",
	clientSecret: "client-secret-shhh",
	resource: "https://mcp.example.com/resource",
} as const;

function mintMcpOAuthCredential(): OAuthCredential {
	const base: OAuthCredential = {
		type: "oauth",
		access: "access-mcp",
		refresh: "refresh-mcp",
		expires: Date.now() + 60_000,
	};
	return { ...base, ...EXTRA_FIELDS };
}

describe("auth-broker preserves extra OAuth credential fields", () => {
	let tempDir = "";
	let serverStore: SqliteAuthCredentialStore | undefined;
	let serverStorage: AuthStorage | undefined;
	let handle: AuthBrokerServerHandle | undefined;
	let remote: RemoteAuthCredentialStore | undefined;
	let clientStorage: AuthStorage | undefined;
	const token = "extra-fields-bearer";

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "auth-broker-extra-fields-"));
		serverStore = await SqliteAuthCredentialStore.open(path.join(tempDir, "broker.db"));
		serverStorage = new AuthStorage(serverStore);
		await serverStorage.credentials.reload();
		handle = startAuthBroker({
			storage: serverStorage,
			bind: "127.0.0.1:0",
			bearerTokens: [token],
			disableRefresher: true,
		});
		// Long-poll (no SSE) keeps the round-trip deterministic for assertions.
		remote = new RemoteAuthCredentialStore({
			client: new AuthBrokerClient({ url: handle.url, token }),
			streamSnapshots: false,
		});
		clientStorage = new AuthStorage(remote);
		await clientStorage.credentials.reload();
	});

	afterEach(async () => {
		clientStorage?.close();
		await handle?.close();
		serverStorage?.close();
		serverStore?.close();
		await removeWithRetries(tempDir);
		vi.restoreAllMocks();
	});

	test("keeps local plan credentials in OMP while excluding broker snapshots and mutations", async () => {
		const provider = "openai-chatgpt";
		const installId = "2f4d3706-124e-42eb-98d8-d5e8dfc29264";
		vi.spyOn(piUtils, "getPersistentInstallId").mockReturnValue(installId);
		const registration = {
			registrationId: "local-registration",
			generation: 1,
			hostId: `urn:uuid:${installId}`,
			clientId: "local-client",
			issuer: "https://auth.openai.com",
			subject: "local-subject",
		};
		const identity = {
			idToken: "local-identity-token",
			scopes: ["chatgpt.tokens.use.direct"],
			authorizationNonce: "local-nonce",
		};
		serverStore!.saveOAuthRegistrationLogin(provider, {
			kind: "registered-oauth",
			registration,
			identity,
			credentials: {
				...registration,
				...identity,
				registrationGeneration: 1,
				authMode: "chatgpt-siwc",
				access: "local-plan-access",
				refresh: "local-plan-refresh",
				expires: Date.now() + 60_000,
			},
		});
		await serverStorage!.credentials.reload();
		const local = serverStorage!.credentials.snapshot().credentials.find(entry => entry.provider === provider);
		expect(local?.credential.type === "oauth" && local.credential.access).toBe("local-plan-access");
		expect(JSON.stringify(local)).not.toContain("local-identity-token");
		const client = new AuthBrokerClient({ url: handle!.url, token });
		const result = await client.fetchSnapshot();
		if (result.status !== 200) throw new Error("expected snapshot");
		expect(result.snapshot.credentials.some(entry => entry.provider === provider)).toBe(false);
		for (const action of ["refresh", "disable"]) {
			const response = await fetch(`${handle!.url}/v1/credential/${local!.id}/${action}`, {
				method: "POST",
				headers: { Authorization: `Bearer ${token}` },
			});
			expect(response.status).toBe(403);
		}
		expect(serverStorage!.credentials.list(provider)).toHaveLength(1);
	});

	test("rejects local plan uploads at both the client and server boundaries", async () => {
		const credential: OAuthCredential = {
			type: "oauth",
			access: "never-export-access",
			refresh: "never-export-refresh",
			expires: Date.now() + 60_000,
		};
		let outboundRequests = 0;
		const client = new AuthBrokerClient({
			url: handle!.url,
			token,
			fetchImpl: Object.assign(
				async () => {
					outboundRequests++;
					return new Response(null, { status: 500 });
				},
				{ preconnect: fetch.preconnect },
			),
		});
		await expect(client.uploadCredential("openai-chatgpt", credential)).rejects.toThrow("local OMP");
		expect(outboundRequests).toBe(0);
		const response = await fetch(`${handle!.url}/v1/credential`, {
			method: "POST",
			headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
			body: JSON.stringify({ provider: "openai-chatgpt", credential }),
		});
		expect(response.status).toBe(403);
		expect(serverStorage!.credentials.list("openai-chatgpt")).toHaveLength(0);
	});

	test("broker set -> get round-trips tokenUrl/clientId/clientSecret/resource", async () => {
		await clientStorage!.credentials.set(MCP_PROVIDER, mintMcpOAuthCredential());

		// Upload path (writableAuthCredentialSchema): the broker persisted the full
		// credential — the real refresh token plus every MCP extension field.
		const persisted = serverStore!.getOAuth(MCP_PROVIDER) as Record<string, unknown> | null;
		expect(persisted).not.toBeNull();
		expect(persisted).toMatchObject({ ...EXTRA_FIELDS, access: "access-mcp", refresh: "refresh-mcp" });

		// Snapshot path (snapshotResponseSchema -> remoteOauthCredentialSchema): a
		// fresh client reads the extension fields back; only `refresh` is redacted
		// to the broker sentinel (the existing, intentional design).
		const snapshotResult = await new AuthBrokerClient({ url: handle!.url, token }).fetchSnapshot();
		if (snapshotResult.status !== 200) throw new Error("expected snapshot");
		const entry = snapshotResult.snapshot.credentials.find(candidate => candidate.provider === MCP_PROVIDER);
		expect(entry).toBeDefined();
		const credential = entry!.credential as Record<string, unknown>;
		expect(credential.type).toBe("oauth");
		expect(credential).toMatchObject(EXTRA_FIELDS);
		expect(credential.refresh).toBe(REMOTE_REFRESH_SENTINEL);

		// Upload-response path (credentialUploadResponseSchema): the client's local
		// view from `set()` carries the extension fields too.
		const localView = remote!.listAuthCredentials(MCP_PROVIDER);
		expect(localView).toHaveLength(1);
		expect(localView[0].credential as unknown as Record<string, unknown>).toMatchObject(EXTRA_FIELDS);
	});
});
