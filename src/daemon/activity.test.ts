import assert from "node:assert/strict";
import { test } from "node:test";
import { activityLabel } from "./activity.ts";

const label = (tool: string, input: Record<string, unknown> = {}) =>
	activityLabel(tool, input, "mcp__walkthrough__");

test("file tools name the file, not its directory", () => {
	assert.equal(label("Read", { file_path: "/a/b/hub.go" }), "Reading hub.go");
	assert.equal(
		label("Write", { file_path: "/s/notes.md" }),
		"Writing notes.md",
	);
	assert.equal(label("Read"), "Reading");
});

test("searches show the pattern, clipped when long", () => {
	assert.equal(
		label("Grep", { pattern: "handlePoll" }),
		"Searching for handlePoll",
	);
	assert.equal(label("Glob", { pattern: "**/*.go" }), "Looking for **/*.go");
	assert.equal(
		label("Grep", { pattern: "x".repeat(60) }).length,
		"Searching for ".length + 40,
	);
});

test("the walkthrough's own tools and unknown tools get general labels", () => {
	assert.equal(
		label("mcp__walkthrough__show_code", { path: "a" }),
		"Updating the display",
	);
	assert.equal(label("mcp__walkthrough__ask_quiz"), "Writing a question");
	assert.equal(label("Bash", { command: "ls" }), "Working");
});
