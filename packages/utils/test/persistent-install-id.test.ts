import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { __resetInstallIdCacheForTests, getBaseConfigRoot, getInstallId, getPersistentInstallId } from "../src/dirs";

describe("persistent OAuth installation identity", () => {
	let directory = "";
	beforeEach(async () => {
		directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omp-persistent-identity-"));
		vi.spyOn(os, "homedir").mockReturnValue(directory);
		__resetInstallIdCacheForTests();
	});
	afterEach(async () => {
		vi.restoreAllMocks();
		__resetInstallIdCacheForTests();
		await fs.promises.rm(directory, { recursive: true, force: true });
	});

	test("reads back one durable identity across process-cache resets", async () => {
		const first = getPersistentInstallId();
		expect((await fs.promises.readFile(path.join(getBaseConfigRoot(), "install-id"), "utf8")).trim()).toBe(first);
		__resetInstallIdCacheForTests();
		expect(getPersistentInstallId()).toBe(first);
	});

	test("refuses the legacy in-memory fallback when persistence fails", () => {
		const failure = Object.assign(new Error("fixture write denied"), { code: "EACCES" });
		vi.spyOn(fs, "openSync").mockImplementation(() => { throw failure; });
		getInstallId();
		expect(() => getPersistentInstallId()).toThrow("fixture write denied");
	});

	test("does not replace a damaged persisted identity with a new OAuth host", async () => {
		const file = path.join(getBaseConfigRoot(), "install-id");
		await fs.promises.mkdir(path.dirname(file), { recursive: true });
		await fs.promises.writeFile(file, "damaged-id\n");
		expect(() => getPersistentInstallId()).toThrow("invalid");
		expect(await fs.promises.readFile(file, "utf8")).toBe("damaged-id\n");
	});
});
