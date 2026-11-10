import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { FakeDriver } from "../daemon/fake-driver.ts";
import { createApp, listen } from "../daemon/server.ts";
import { TourStore } from "../daemon/store.ts";
import { parseArgs, startTour, UsageError } from "./start-tour.ts";

test("parseArgs defaults to the current directory and resolves --cwd against it", () => {
	assert.deepEqual(parseArgs(["explain x"], "/work"), {
		cwd: "/work",
		brief: "explain x",
	});
	assert.deepEqual(parseArgs(["--cwd", "sub", "-"], "/work"), {
		cwd: "/work/sub",
		brief: "-",
	});
});

test("parseArgs rejects a missing brief, extra words and unknown options", () => {
	assert.throws(() => parseArgs([], "/work"), UsageError);
	assert.throws(() => parseArgs(["a", "b"], "/work"), UsageError);
	assert.throws(() => parseArgs(["--port", "1", "a"], "/work"), UsageError);
	assert.throws(() => parseArgs(["a", "--cwd"], "/work"), UsageError);
});

test("startTour returns the daemon's link and passes on its errors", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pedagogue-cli-test-"));
	const driver = new FakeDriver();
	const app = createApp({
		driver,
		store: new TourStore(join(dir, "data")),
		publicUrl: "http://desk.example:4270",
		allowedHosts: ["127.0.0.1"],
		build: { version: "0.0.0" },
	});
	const { server, port } = await listen(app, "127.0.0.1", 0);
	after(() => {
		void app.close();
		server.close();
	});
	const daemon = `http://127.0.0.1:${port}`;

	const url = await startTour(daemon, { cwd: dir, brief: "explain x" });
	assert.match(url, /^http:\/\/desk\.example:4270\/tours\/[a-z0-9]+$/);
	assert.deepEqual(driver.sessions[0]?.received, ["explain x"]);

	await assert.rejects(
		startTour(daemon, { cwd: join(dir, "nope"), brief: "x" }),
		/no such directory/,
	);
});

test("startTour says how to start the daemon when none is listening", async () => {
	await assert.rejects(
		startTour("http://127.0.0.1:1", { cwd: "/", brief: "x" }),
		/no pedagogue daemon at http:\/\/127\.0\.0\.1:1/,
	);
});
