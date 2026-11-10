import assert from "node:assert/strict";
import { test } from "node:test";
import {
	compressLines,
	languageFor,
	paneForPath,
	parseLineLink,
	splitHighlightedLines,
} from "./lines.js";

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

test("parseLineLink reads one line or a range and rejects other links", () => {
	assert.deepEqual(parseLineLink("cmd/hub.go#L12"), {
		path: "cmd/hub.go",
		start: 12,
		end: 12,
	});
	assert.deepEqual(parseLineLink("./cmd/hub.go#L12-L20"), {
		path: "cmd/hub.go",
		start: 12,
		end: 20,
	});
	assert.deepEqual(parseLineLink("a%20b.go#L3-9"), {
		path: "a b.go",
		start: 3,
		end: 9,
	});
	assert.equal(parseLineLink("https://example.com/x.go#L3"), undefined);
	assert.equal(parseLineLink("cmd/hub.go"), undefined);
	assert.equal(parseLineLink("cmd/hub.go#L9-L3"), undefined);
	assert.equal(parseLineLink("#L3"), undefined);
});

test("paneForPath prefers an exact path and accepts an unambiguous suffix", () => {
	const panes = [
		{ kind: "code", path: "cmd/hub.go" },
		{ kind: "code", path: "cmd/a/util.go" },
		{ kind: "code", path: "cmd/b/util.go" },
		{ kind: "markdown" },
	];
	assert.equal(paneForPath(panes, "cmd/hub.go"), panes[0]);
	assert.equal(paneForPath(panes, "hub.go"), panes[0]);
	assert.equal(paneForPath(panes, "util.go"), undefined);
	assert.equal(paneForPath(panes, "a/util.go"), panes[1]);
	assert.equal(paneForPath(panes, "missing.go"), undefined);
});
