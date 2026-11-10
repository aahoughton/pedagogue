import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { decide, type Sandbox } from "./permissions.ts";

const root = mkdtempSync(join(tmpdir(), "pedagogy-perm-test-"));
const cwd = join(root, "project");
const scratchDir = join(root, "scratch");
mkdirSync(join(cwd, "src"), { recursive: true });
mkdirSync(scratchDir);
writeFileSync(join(cwd, "src/a.ts"), "x");
writeFileSync(join(root, "secret"), "x");
symlinkSync(join(root, "secret"), join(cwd, "link"));
symlinkSync(root, join(cwd, "up"));
const sandbox: Sandbox = { cwd, scratchDir, toolPrefix: "mcp__tour__" };

const allowed = (tool: string, input: Record<string, unknown>) =>
	decide(sandbox, tool, input).allow;

test("the tour's own tools are always allowed", () => {
	assert.equal(allowed("mcp__tour__show_code", { path: "/etc/passwd" }), true);
	assert.equal(allowed("mcp__other__thing", {}), false);
});

test("reads are allowed inside the tour directory and the scratch directory", () => {
	assert.equal(allowed("Read", { file_path: join(cwd, "src/a.ts") }), true);
	assert.equal(allowed("Read", { file_path: "src/a.ts" }), true);
	assert.equal(allowed("Read", { file_path: join(scratchDir, "notes") }), true);
	assert.equal(allowed("Grep", { pattern: "x" }), true);
	assert.equal(allowed("Glob", { pattern: "*", path: join(cwd, "src") }), true);
});

test("reads outside are refused, including through .. and symlinks", () => {
	assert.equal(allowed("Read", { file_path: join(root, "secret") }), false);
	assert.equal(allowed("Read", { file_path: "../secret" }), false);
	assert.equal(allowed("Read", { file_path: join(cwd, "link") }), false);
	assert.equal(allowed("Read", { file_path: join(cwd, "up/secret") }), false);
	assert.equal(allowed("Grep", { pattern: "x", path: "/" }), false);
	assert.equal(allowed("Read", { file_path: `${cwd}-sibling/a` }), false);
});

test("writes are allowed only in the scratch directory", () => {
	assert.equal(
		allowed("Write", { file_path: join(scratchDir, "new/ex.ts") }),
		true,
	);
	assert.equal(allowed("Edit", { file_path: join(cwd, "src/a.ts") }), false);
	assert.equal(
		allowed("Write", { file_path: join(cwd, "up/scratch/../x") }),
		false,
	);
});

test("other tools and calls without a usable path are refused with a reason", () => {
	const bash = decide(sandbox, "Bash", { command: "ls" });
	assert.deepEqual(bash, {
		allow: false,
		reason: "Bash is not available in a tour.",
	});
	assert.equal(allowed("Read", { file_path: 7 }), false);
});
