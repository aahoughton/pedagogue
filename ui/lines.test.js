import assert from "node:assert/strict";
import { test } from "node:test";
import {
	ago,
	buildLabel,
	clampInputHeight,
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

test("buildLabel names the version, the commit and uncommitted changes", () => {
	assert.equal(buildLabel({ version: "0.9.0" }), "pedagogue 0.9.0");
	assert.equal(
		buildLabel({ version: "0.9.0", sha: "8b9f67b", dirty: false }),
		"pedagogue 0.9.0 (8b9f67b)",
	);
	assert.equal(
		buildLabel({ version: "0.9.0", sha: "8b9f67b", dirty: true }),
		"pedagogue 0.9.0 (8b9f67b*)",
	);
});

test("ago rounds down to minutes, hours, then days", () => {
	const now = Date.parse("2026-11-10T12:00:00Z");
	assert.equal(ago("2026-11-10T11:59:30Z", now), "just now");
	assert.equal(ago("2026-11-10T12:00:05Z", now), "just now");
	assert.equal(ago("2026-11-10T11:48:00Z", now), "12m ago");
	assert.equal(ago("2026-11-10T09:01:00Z", now), "2h ago");
	assert.equal(ago("2026-11-08T11:00:00Z", now), "2d ago");
});

test("clampInputHeight keeps a height the side panel has room for", () => {
	assert.equal(clampInputHeight(200, 900), 200);
	assert.equal(clampInputHeight(180.6, 900), 181);
});

test("clampInputHeight stops at two lines and at half the side panel", () => {
	assert.equal(clampInputHeight(10, 900), 64);
	assert.equal(clampInputHeight(800, 900), 450);
});

test("clampInputHeight prefers the minimum in a panel too short for both", () => {
	assert.equal(clampInputHeight(300, 80), 64);
});

test("clampInputHeight rejects a height that is not a number", () => {
	assert.equal(clampInputHeight(Number.NaN, 900), undefined);
	assert.equal(clampInputHeight(Number("tall"), 900), undefined);
});
