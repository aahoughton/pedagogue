import assert from "node:assert/strict";
import { test } from "node:test";
import { excerpt, formatRanges, lineCount, toRanges } from "./lines.ts";

test("toRanges merges adjacent lines and keeps gaps", () => {
	assert.deepEqual(toRanges([9, 3, 4, 5, 4]), [
		{ start: 3, end: 5 },
		{ start: 9, end: 9 },
	]);
	assert.deepEqual(toRanges([]), []);
});

test("formatRanges writes single lines without a dash", () => {
	assert.equal(
		formatRanges([
			{ start: 3, end: 5 },
			{ start: 9, end: 9 },
		]),
		"3-5,9",
	);
});

test("excerpt numbers lines and marks the gap between ranges", () => {
	const text = "a\nb\nc\nd\ne\n";
	assert.equal(
		excerpt(text, [
			{ start: 1, end: 2 },
			{ start: 5, end: 5 },
		]),
		"1\ta\n2\tb\n...\n5\te",
	);
});

test("lineCount ignores a trailing newline", () => {
	assert.equal(lineCount(""), 0);
	assert.equal(lineCount("a"), 1);
	assert.equal(lineCount("a\n"), 1);
	assert.equal(lineCount("a\nb"), 2);
});
