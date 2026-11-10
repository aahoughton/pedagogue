import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { EnvFileError, envFilePath, loadEnvFile } from "./env-file.ts";

const dir = mkdtempSync(join(tmpdir(), "pedagogy-env-test-"));

test("the path comes from PEDAGOGY_ENV_FILE, then XDG_CONFIG_HOME, then ~/.config", () => {
	assert.equal(envFilePath({ PEDAGOGY_ENV_FILE: "/x/env" }), "/x/env");
	assert.equal(envFilePath({ XDG_CONFIG_HOME: "/cfg" }), "/cfg/pedagogy/env");
	assert.match(envFilePath({}), /\/\.config\/pedagogy\/env$/);
});

test("loads settings without replacing variables that are already set", () => {
	const file = join(dir, "env");
	writeFileSync(
		file,
		"PEDAGOGY_TEST_A=from-file\nPEDAGOGY_TEST_B=from-file\n",
		{
			mode: 0o600,
		},
	);
	process.env.PEDAGOGY_TEST_B = "from-shell";
	assert.equal(loadEnvFile({ PEDAGOGY_ENV_FILE: file }), file);
	assert.equal(process.env.PEDAGOGY_TEST_A, "from-file");
	assert.equal(process.env.PEDAGOGY_TEST_B, "from-shell");
});

test("a missing default file is fine; a missing named file is an error", () => {
	assert.equal(loadEnvFile({ XDG_CONFIG_HOME: join(dir, "none") }), undefined);
	assert.throws(
		() => loadEnvFile({ PEDAGOGY_ENV_FILE: join(dir, "nope") }),
		EnvFileError,
	);
});

test("refuses a file other users can read", () => {
	const file = join(dir, "open-env");
	writeFileSync(file, "PEDAGOGY_TEST_C=x\n");
	chmodSync(file, 0o644);
	assert.throws(() => loadEnvFile({ PEDAGOGY_ENV_FILE: file }), /chmod 600/);
	assert.equal(process.env.PEDAGOGY_TEST_C, undefined);
});
