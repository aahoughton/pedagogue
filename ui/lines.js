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

/**
 * Reads a link to lines of a file, written the way GitHub does:
 * "src/hub.go#L12" or "src/hub.go#L12-L20" (the second L is optional).
 * Returns undefined for any other link.
 */
export function parseLineLink(href) {
	const match = /^([^#?]+)#L(\d+)(?:-L?(\d+))?$/.exec(href);
	if (!match || /^[a-z][a-z0-9+.-]*:/i.test(match[1])) return undefined;
	const start = Number(match[2]);
	const end = Number(match[3] ?? match[2]);
	if (start < 1 || end < start) return undefined;
	let path = match[1];
	try {
		path = decodeURIComponent(path);
	} catch {}
	return { path: path.replace(/^\.?\//, ""), start, end };
}

/**
 * The code pane a path refers to: an exact match on the pane's path, or else
 * the only pane whose path ends with it (so "hub.go" finds "cmd/hub.go").
 */
export function paneForPath(panes, path) {
	const code = panes.filter((pane) => pane.kind === "code");
	const exact = code.find((pane) => pane.path === path);
	if (exact) return exact;
	const suffix = code.filter((pane) => pane.path.endsWith(`/${path}`));
	return suffix.length === 1 ? suffix[0] : undefined;
}

/**
 * The daemon's name for the titlebar, from what GET /about returns:
 * "pedagogue 0.9.0 (8b9f67b)", with "*" after a commit that had uncommitted
 * changes, and no parentheses when the daemon is not a git checkout.
 */
export function buildLabel(build) {
	const commit = build.sha ? ` (${build.sha}${build.dirty ? "*" : ""})` : "";
	return `pedagogue ${build.version}${commit}`;
}

/** How long before `now` (milliseconds) an ISO time was: "just now", "5m ago", "3h ago", "2d ago". */
export function ago(iso, now) {
	const minutes = Math.floor((now - Date.parse(iso)) / 60_000);
	if (minutes < 1) return "just now";
	if (minutes < 60) return `${minutes}m ago`;
	if (minutes < 60 * 24) return `${Math.floor(minutes / 60)}h ago`;
	return `${Math.floor(minutes / (60 * 24))}d ago`;
}

/** The shortest the composer's input gets: two lines of text, in pixels. */
const MIN_INPUT_HEIGHT = 64;

/**
 * The height in pixels to give the composer's input when the learner asks for
 * `height` in a side panel `sideHeight` tall: no shorter than two lines and no
 * taller than half the panel, so the conversation stays in view. Returns
 * undefined when `height` is not a number.
 */
export function clampInputHeight(height, sideHeight) {
	if (!Number.isFinite(height)) return undefined;
	const max = Math.max(MIN_INPUT_HEIGHT, Math.floor(sideHeight / 2));
	return Math.min(max, Math.max(MIN_INPUT_HEIGHT, Math.round(height)));
}

/** Frames in one cycle of the favicon shown while the tutor works. */
export const FAVICON_FRAMES = 3;

/**
 * The tab icon as SVG source: a speech bubble holding three dots. While the
 * tutor works, the dot numbered `frame` is raised and the others dimmed, so
 * stepping `frame` animates it. Waiting shows the three dots at rest. Any
 * other status (ended, reconnecting) greys the bubble.
 */
export function faviconSvg(status, frame = 0) {
	const working = status === "working";
	const fill = working || status === "waiting" ? "#2f6feb" : "#8a93a3";
	const dots = [4.5, 8, 11.5]
		.map((cx, index) => {
			const active = working && index === frame % FAVICON_FRAMES;
			const cy = active ? 5.4 : 6.9;
			const opacity = working && !active ? 0.5 : 1;
			return `<circle cx="${cx}" cy="${cy}" r="1.35" fill="#fff" opacity="${opacity}"/>`;
		})
		.join("");
	return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path fill="${fill}" d="M4 1h8a3 3 0 0 1 3 3v5.5a3 3 0 0 1-3 3H8l-4 3.2v-3.2a3 3 0 0 1-3-3V4a3 3 0 0 1 3-3z"/>${dots}</svg>`;
}

/** The favicon as a URL for a link element's href. */
export function faviconHref(status, frame = 0) {
	return `data:image/svg+xml,${encodeURIComponent(faviconSvg(status, frame))}`;
}
