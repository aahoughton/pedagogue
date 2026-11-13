import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const launcher = join(repo, "bin", "pedagogue-daemon");
const SYSTEM_PATH = "/usr/bin:/bin";

test("pedagogue-daemon runs the daemon through mise from the repository root", () => {
	const fakeBin = mkdtempSync(join(tmpdir(), "pedagogue-launcher-"));
	const fakeMise = join(fakeBin, "mise");
	writeFileSync(fakeMise, '#!/bin/sh\npwd -P\necho "$@"\n');
	chmodSync(fakeMise, 0o755);

	const result = spawnSync(launcher, [], {
		cwd: tmpdir(),
		env: { PATH: `${fakeBin}:${SYSTEM_PATH}` },
		encoding: "utf8",
	});

	assert.equal(result.status, 0, result.stderr);
	assert.deepEqual(result.stdout.trimEnd().split("\n"), [
		realpathSync(repo),
		"exec -- node src/daemon/main.ts",
	]);
});

test("pedagogue-daemon says so and exits 2 when mise is not on PATH", () => {
	const result = spawnSync(launcher, [], {
		env: { PATH: SYSTEM_PATH },
		encoding: "utf8",
	});

	assert.equal(result.status, 2);
	assert.equal(
		result.stderr,
		`pedagogue: mise not found on PATH (${SYSTEM_PATH})\n`,
	);
	assert.equal(result.stdout, "");
});
