// Pure helpers for the code pane. No DOM access, so the daemon's test run covers them.

const LANGUAGES = {
	c: "c",
	h: "c",
	cc: "cpp",
	cpp: "cpp",
	hpp: "cpp",
	cs: "csharp",
	css: "css",
	diff: "diff",
	go: "go",
	html: "xml",
	xml: "xml",
	svg: "xml",
	java: "java",
	js: "javascript",
	mjs: "javascript",
	cjs: "javascript",
	jsx: "javascript",
	json: "json",
	kt: "kotlin",
	lua: "lua",
	md: "markdown",
	php: "php",
	py: "python",
	rb: "ruby",
	rs: "rust",
	scss: "scss",
	sh: "bash",
	bash: "bash",
	zsh: "bash",
	sql: "sql",
	swift: "swift",
	toml: "ini",
	ini: "ini",
	ts: "typescript",
	tsx: "typescript",
	yaml: "yaml",
	yml: "yaml",
};

/** The highlight.js language for a file path, or undefined when unknown. */
export function languageFor(path) {
	const name = path.split("/").pop() ?? "";
	if (name === "Makefile") return "makefile";
	if (name === "Dockerfile") return "dockerfile";
	const dot = name.lastIndexOf(".");
	return dot === -1 ? undefined : LANGUAGES[name.slice(dot + 1).toLowerCase()];
}

/**
 * Splits highlight.js output into one HTML string per source line. A span that
 * crosses a line break (a block comment, a template string) is closed at the end
 * of each line and reopened on the next, so every line is well-formed by itself.
 */
export function splitHighlightedLines(html) {
	const lines = [];
	const open = [];
	let current = "";
	for (const [token] of html.matchAll(/<span[^>]*>|<\/span>|\n|[^<\n]+/g)) {
		if (token === "\n") {
			lines.push(current + "</span>".repeat(open.length));
			current = open.join("");
		} else {
			if (token === "</span>") open.pop();
			else if (token.startsWith("<span")) open.push(token);
			current += token;
		}
	}
	lines.push(current + "</span>".repeat(open.length));
	return lines;
}

/** "3-5,9" for [9, 3, 4, 5]. */
export function compressLines(lines) {
	const sorted = [...new Set(lines)].sort((a, b) => a - b);
	const parts = [];
	for (let i = 0; i < sorted.length; i++) {
		const start = sorted[i];
		while (sorted[i + 1] === sorted[i] + 1) i++;
		parts.push(start === sorted[i] ? `${start}` : `${start}-${sorted[i]}`);
	}
	return parts.join(",");
}
