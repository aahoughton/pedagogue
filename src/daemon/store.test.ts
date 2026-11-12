import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { WalkthroughStore } from "./store.ts";
import type { WalkthroughRecord } from "./walkthrough.ts";

function record(id: string, title: string): WalkthroughRecord {
	return {
		version: 1,
		state: {
			id,
			cwd: "/x",
			title,
			status: "waiting",
			outline: [],
			panes: [],
			transcript: [],
		},
		brief: title,
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
	};
}

test("a burst of changes is saved once, with the latest state", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pedagogue-store-test-"));
	const store = new WalkthroughStore(dir, { delayMs: 10 });
	let title = "first";
	let reads = 0;
	const walkthrough = {
		id: "aaaa1111",
		record: () => {
			reads += 1;
			return record("aaaa1111", title);
		},
	};
	store.schedule(walkthrough);
	store.schedule(walkthrough);
	title = "latest";
	store.schedule(walkthrough);
	await store.flush();
	assert.equal(reads, 1);

	const loaded = await new WalkthroughStore(dir).loadAll();
	assert.deepEqual(loaded.problems, []);
	assert.equal(loaded.records[0]?.state.title, "latest");
	assert.deepEqual(readdirSync(join(dir, "walkthroughs", "aaaa1111")), [
		"walkthrough.json",
	]);
});

test("a save after the delay happens without a flush", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pedagogue-store-test-"));
	const store = new WalkthroughStore(dir, { delayMs: 5 });
	store.schedule({ id: "bbbb2222", record: () => record("bbbb2222", "t") });
	await new Promise((resolve) => setTimeout(resolve, 50));
	assert.equal((await new WalkthroughStore(dir).loadAll()).records.length, 1);
});

test("unreadable walkthroughs are reported and skipped; bare scratch directories are ignored", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pedagogue-store-test-"));
	const store = new WalkthroughStore(dir);
	store.schedule({ id: "good0001", record: () => record("good0001", "good") });
	await store.flush();
	mkdirSync(join(dir, "walkthroughs", "bad00001"));
	writeFileSync(
		join(dir, "walkthroughs", "bad00001", "walkthrough.json"),
		"{ not json",
	);
	mkdirSync(join(dir, "walkthroughs", "wrong001"));
	writeFileSync(
		join(dir, "walkthroughs", "wrong001", "walkthrough.json"),
		JSON.stringify(record("other", "x")),
	);
	mkdirSync(join(dir, "walkthroughs", "scratch1", "scratch"), {
		recursive: true,
	});

	const { records, problems } = await store.loadAll();
	assert.deepEqual(
		records.map((r) => r.state.id),
		["good0001"],
	);
	assert.equal(problems.length, 2);
	assert.match(problems.join("\n"), /bad00001\/walkthrough\.json/);
	assert.match(
		problems.join("\n"),
		/wrong001\/walkthrough\.json: not a version 1/,
	);
});

test("an empty data directory has no walkthroughs", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pedagogue-store-test-"));
	assert.deepEqual(await new WalkthroughStore(dir).loadAll(), {
		records: [],
		problems: [],
	});
});

test("removing a walkthrough deletes its directory and drops a waiting save", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pedagogue-store-test-"));
	const store = new WalkthroughStore(dir, { delayMs: 10 });
	const walkthrough = {
		id: "cccc3333",
		record: () => record("cccc3333", "gone"),
	};
	store.schedule(walkthrough);
	await store.flush();
	mkdirSync(store.scratchDir("cccc3333"), { recursive: true });
	writeFileSync(join(store.scratchDir("cccc3333"), "note.txt"), "x");

	store.schedule(walkthrough);
	await store.remove("cccc3333");
	await new Promise((resolve) => setTimeout(resolve, 30));
	await store.flush();
	assert.deepEqual(readdirSync(join(dir, "walkthroughs")), []);
	assert.deepEqual((await store.loadAll()).records, []);
});

test("data saved under the old names is moved and loads", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pedagogue-store-test-"));
	mkdirSync(join(dir, "tours", "dddd4444", "scratch"), { recursive: true });
	mkdirSync(join(dir, "tours", "eeee5555", "scratch"), { recursive: true });
	writeFileSync(
		join(dir, "tours", "dddd4444", "tour.json"),
		JSON.stringify(record("dddd4444", "old")),
	);
	const store = new WalkthroughStore(dir);
	assert.equal(await store.adoptOldNames(), join(dir, "tours"));
	assert.deepEqual(readdirSync(dir), ["walkthroughs"]);
	const { records, problems } = await store.loadAll();
	assert.deepEqual(problems, []);
	assert.deepEqual(
		records.map((r) => r.state.title),
		["old"],
	);
	assert.equal(await store.adoptOldNames(), undefined);

	mkdirSync(join(dir, "tours"));
	await assert.rejects(
		store.adoptOldNames(),
		/both .*tours and .*walkthroughs exist/,
	);
});
