import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Which copy of the daemon is running, for showing in the browser. */
export interface Build {
	version: string;
	/** Short commit of the daemon's checkout. Absent when `root` is not a git checkout. */
	sha?: string;
	/** True when the checkout had uncommitted changes. */
	dirty?: boolean;
}

/**
 * Reads the build of the daemon installed at `root`. Call it once at startup:
 * the daemon's code is fixed from then on, so a later commit must not change
 * the answer.
 */
export function readBuild(root: string): Build {
	const { version } = JSON.parse(
		readFileSync(join(root, "package.json"), "utf8"),
	) as { version: string };
	// Only a checkout rooted here counts; git would otherwise answer for an
	// enclosing repository.
	if (!existsSync(join(root, ".git"))) return { version };
	try {
		const git = (...args: string[]) =>
			execFileSync("git", ["-C", root, ...args], {
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
			}).trim();
		const sha = git("rev-parse", "--short", "HEAD");
		const dirty = git("status", "--porcelain") !== "";
		return { version, sha, dirty };
	} catch {
		return { version };
	}
}
