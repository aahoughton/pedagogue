import { realpathSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";

const READ_TOOLS = new Set(["Read", "Glob", "Grep"]);
const WRITE_TOOLS = new Set(["Write", "Edit"]);

export type Decision = { allow: true } | { allow: false; reason: string };

export interface Sandbox {
	/** Directory the tutor explains. Readable. */
	cwd: string;
	/** Readable and writable. */
	scratchDir: string;
	/** Prefix of the walkthrough's own tools, for example "mcp__walkthrough__". */
	toolPrefix: string;
}

/**
 * Decides whether a tutor may make a tool call: the walkthrough's own tools always,
 * reads inside the walkthrough directory or the scratch directory, writes inside the
 * scratch directory, nothing else. Paths are compared after resolving symlinks,
 * so a link inside the walkthrough directory cannot lead out of it.
 */
export function decide(
	sandbox: Sandbox,
	toolName: string,
	input: Record<string, unknown>,
): Decision {
	if (toolName.startsWith(sandbox.toolPrefix)) return { allow: true };

	const reading = READ_TOOLS.has(toolName);
	if (!reading && !WRITE_TOOLS.has(toolName)) {
		return {
			allow: false,
			reason: `${toolName} is not available in a walkthrough.`,
		};
	}
	// Read, Write and Edit name a file; Glob and Grep name a directory to
	// search, which defaults to the working directory.
	const named = input.file_path ?? input.path ?? sandbox.cwd;
	if (typeof named !== "string") {
		return { allow: false, reason: `${toolName} was called without a path.` };
	}
	const target = canonical(resolve(sandbox.cwd, named));
	const roots = reading
		? [sandbox.cwd, sandbox.scratchDir]
		: [sandbox.scratchDir];
	if (roots.some((root) => isInside(canonical(root), target))) {
		return { allow: true };
	}
	return {
		allow: false,
		reason: reading
			? `${named} is outside the walkthrough directory. A walkthrough reads only ${sandbox.cwd} and its scratch directory.`
			: `${named} is not writable. A walkthrough writes only to ${sandbox.scratchDir}.`,
	};
}

/** Resolves symlinks in the longest existing prefix of a path. */
function canonical(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		const parent = dirname(path);
		if (parent === path) return path;
		return resolve(canonical(parent), path.slice(parent.length + 1));
	}
}

function isInside(dir: string, path: string): boolean {
	return path === dir || path.startsWith(dir + sep);
}
