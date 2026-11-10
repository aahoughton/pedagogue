import assert from "node:assert/strict";
import { test } from "node:test";
import { compressLines, languageFor, splitHighlightedLines } from "./lines.js";

test("splitHighlightedLines reopens a span that crosses a line break", () => {
	const html = 'a <span class="c">/* one\ntwo */</span> b\nc';
	assert.deepEqual(splitHighlightedLines(html), [
		'a <span class="c">/* one</span>',
		'<span class="c">two */</span> b',
		"c",
	]);
});

test("splitHighlightedLines handles nested spans and blank lines", () => {
	const html = '<span class="a"><span class="b">x\n\ny</span></span>';
	assert.deepEqual(splitHighlightedLines(html), [
		'<span class="a"><span class="b">x</span></span>',
		'<span class="a"><span class="b"></span></span>',
		'<span class="a"><span class="b">y</span></span>',
	]);
});

test("splitHighlightedLines yields one line per source line", () => {
	assert.equal(splitHighlightedLines("a\nb\nc").length, 3);
	assert.deepEqual(splitHighlightedLines(""), [""]);
});

test("compressLines sorts, dedupes and joins runs", () => {
	assert.equal(compressLines([9, 3, 4, 5, 4]), "3-5,9");
	assert.equal(compressLines([7]), "7");
});

test("languageFor maps extensions and well-known names", () => {
	assert.equal(languageFor("src/a/b.ts"), "typescript");
	assert.equal(languageFor("Makefile"), "makefile");
	assert.equal(languageFor("LICENSE"), undefined);
	assert.equal(languageFor("x.unknown"), undefined);
});
