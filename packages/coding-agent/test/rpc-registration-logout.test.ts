import { expect, test, vi } from "bun:test";
import * as path from "node:path";
import { SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
import { isRecord, readJsonl, TempDir } from "@oh-my-pi/pi-utils";
import * as piUtils from "@oh-my-pi/pi-utils";

test("RPC lists and removes an identity-only registration without requiring a credential id", async () => {
	await using temp = await TempDir.create("@rpc-registration-");
	const agentDir = temp.join("agent");
	const store = await SqliteAuthCredentialStore.open(path.join(agentDir, "agent.db"));
	const installId = vi
		.spyOn(piUtils, "getPersistentInstallId")
		.mockReturnValue("2f4d3706-124e-42eb-98d8-d5e8dfc29264");
	try {
		store.saveOAuthRegistrationLogin("openai-chatgpt", {
			kind: "registered-oauth",
			registration: {
				registrationId: "identity-only",
				generation: 1,
				hostId: "urn:uuid:2f4d3706-124e-42eb-98d8-d5e8dfc29264",
				clientId: "fixture-client",
				issuer: "https://auth.openai.com",
				subject: "fixture-subject",
			},
			identity: { idToken: "fixture-id", authorizationNonce: "fixture-nonce", scopes: ["openid"] },
		});
	} finally {
		installId.mockRestore();
		store.close();
	}
	const child = Bun.spawn(
		[
			process.execPath,
			path.join(import.meta.dir, "../src/cli.ts"),
			"--mode",
			"rpc",
			"--provider",
			"anthropic",
			"--model",
			"claude-sonnet-4-5",
		],
		{
			cwd: temp.path(),
			env: {
				...process.env,
				USERPROFILE: temp.join("home"),
				HOME: temp.join("home"),
				PI_CODING_AGENT_DIR: agentDir,
				OMP_CODING_AGENT_DIR: agentDir,
				PI_PROFILE: "default",
				OMP_PROFILE: "default",
				CI: "true",
				PI_NO_TITLE: "1",
			},
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
			timeout: 20_000,
		},
	);
	const stderr = new Response(child.stderr).text();
	const send = async (frame: object) => {
		child.stdin.write(`${JSON.stringify(frame)}\n`);
		await child.stdin.flush();
	};
	const responses = new Map<string, Record<string, unknown>>();
	try {
		await send({ id: "before", type: "get_logout_accounts", providerId: "openai-chatgpt" });
		for await (const frame of readJsonl<unknown>(child.stdout)) {
			if (!isRecord(frame) || frame.type !== "response" || typeof frame.id !== "string") continue;
			responses.set(frame.id, frame);
			if (frame.id === "before")
				await send({
					id: "ambiguous",
					type: "logout",
					providerId: "openai-chatgpt",
					credentialId: 1,
					registrationId: "identity-only",
				});
			else if (frame.id === "ambiguous")
				await send({ id: "logout", type: "logout", providerId: "openai-chatgpt", registrationId: "identity-only" });
			else if (frame.id === "logout")
				await send({ id: "after", type: "get_logout_accounts", providerId: "openai-chatgpt" });
			else if (frame.id === "after") break;
		}
	} finally {
		child.stdin.end();
		child.kill();
		await child.exited;
	}
	if (!responses.has("after")) throw new Error(`RPC fixture did not finish: ${await stderr}`);
	await stderr;
	expect(responses.get("before")).toMatchObject({
		success: true,
		data: { accounts: [expect.objectContaining({ registrationId: "identity-only" })] },
	});
	expect(responses.get("ambiguous")).toMatchObject({ success: false });
	expect(responses.get("logout")).toMatchObject({ success: true, data: { remoteRevoked: true } });
	expect(responses.get("after")).toMatchObject({ success: true, data: { accounts: [] } });
}, 30_000);
