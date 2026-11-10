import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readBuild } from "./build.ts";

function project(): string {
	const root = mkdtempSync(join(tmpdir(), "pedagogue-build-test-"));
	writeFileSync(join(root, "package.json"), '{"version":"1.2.3"}');
	return root;
}

function git(root: string, ...args: string[]): string {
	return execFileSync(
		"git",
		[
			"-C",
			root,
			"-c",
			"user.name=t",
			"-c",
			"user.email=t@example.com",
			...args,
		],
		{ encoding: "utf8" },
	).trim();
}

test("a directory that is not a git checkout reports its version alone", () => {
	assert.deepEqual(readBuild(project()), { version: "1.2.3" });
});

test("a checkout reports its commit and whether it has uncommitted changes", () => {
	const root = project();
	git(root, "init", "-q");
	git(root, "add", ".");
	git(root, "commit", "-q", "-m", "one");
	const sha = git(root, "rev-parse", "--short", "HEAD");
	assert.deepEqual(readBuild(root), { version: "1.2.3", sha, dirty: false });

	writeFileSync(join(root, "new.txt"), "x");
	assert.deepEqual(readBuild(root), { version: "1.2.3", sha, dirty: true });
});

test("a checkout with no commit yet reports its version alone", () => {
	const root = project();
	git(root, "init", "-q");
	assert.deepEqual(readBuild(root), { version: "1.2.3" });
});
