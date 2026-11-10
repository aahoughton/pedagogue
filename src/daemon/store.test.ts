import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { TourStore } from "./store.ts";
import type { TourRecord } from "./tour.ts";

function record(id: string, title: string): TourRecord {
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
	const store = new TourStore(dir, { delayMs: 10 });
	let title = "first";
	let reads = 0;
	const tour = {
		id: "aaaa1111",
		record: () => {
			reads += 1;
			return record("aaaa1111", title);
		},
	};
	store.schedule(tour);
	store.schedule(tour);
	title = "latest";
	store.schedule(tour);
	await store.flush();
	assert.equal(reads, 1);

	const loaded = await new TourStore(dir).loadAll();
	assert.deepEqual(loaded.problems, []);
	assert.equal(loaded.records[0]?.state.title, "latest");
	assert.deepEqual(readdirSync(join(dir, "tours", "aaaa1111")), ["tour.json"]);
});

test("a save after the delay happens without a flush", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pedagogue-store-test-"));
	const store = new TourStore(dir, { delayMs: 5 });
	store.schedule({ id: "bbbb2222", record: () => record("bbbb2222", "t") });
	await new Promise((resolve) => setTimeout(resolve, 50));
	assert.equal((await new TourStore(dir).loadAll()).records.length, 1);
});

test("unreadable tours are reported and skipped; bare scratch directories are ignored", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pedagogue-store-test-"));
	const store = new TourStore(dir);
	store.schedule({ id: "good0001", record: () => record("good0001", "good") });
	await store.flush();
	mkdirSync(join(dir, "tours", "bad00001"));
	writeFileSync(join(dir, "tours", "bad00001", "tour.json"), "{ not json");
	mkdirSync(join(dir, "tours", "wrong001"));
	writeFileSync(
		join(dir, "tours", "wrong001", "tour.json"),
		JSON.stringify(record("other", "x")),
	);
	mkdirSync(join(dir, "tours", "scratch1", "scratch"), { recursive: true });

	const { records, problems } = await store.loadAll();
	assert.deepEqual(
		records.map((r) => r.state.id),
		["good0001"],
	);
	assert.equal(problems.length, 2);
	assert.match(problems.join("\n"), /bad00001\/tour\.json/);
	assert.match(problems.join("\n"), /wrong001\/tour\.json: not a version 1/);
});

test("an empty data directory has no tours", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pedagogue-store-test-"));
	assert.deepEqual(await new TourStore(dir).loadAll(), {
		records: [],
		problems: [],
	});
});
