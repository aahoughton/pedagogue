import { resolve } from "node:path";

export const USAGE = `usage: tour [--cwd <dir>] <brief>
       tour [--cwd <dir>] -        (read the brief from stdin)

Starts a tour on the pedagogy daemon and prints its link.

  --cwd <dir>   directory the tutor explains (default: current directory)

The daemon is reached at $PEDAGOGY_URL (default http://127.0.0.1:4270), which
can also be set in ~/.config/pedagogy/env.`;

export class UsageError extends Error {}

export interface Request {
	cwd: string;
	/** "-" means the brief comes from stdin. */
	brief: string;
}

export function parseArgs(args: string[], currentDir: string): Request {
	let cwd = currentDir;
	const rest: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const arg = args[i] as string;
		if (arg === "--cwd") {
			const value = args[++i];
			if (!value) throw new UsageError("--cwd needs a directory");
			cwd = resolve(currentDir, value);
		} else if (arg.startsWith("--")) {
			throw new UsageError(`unknown option: ${arg}`);
		} else {
			rest.push(arg);
		}
	}
	if (rest.length !== 1) {
		throw new UsageError("give the brief as one argument, or - for stdin");
	}
	return { cwd, brief: rest[0] as string };
}

/** Asks the daemon to start a tour and returns its link. */
export async function startTour(
	daemonUrl: string,
	request: Request,
): Promise<string> {
	let response: Response;
	try {
		response = await fetch(new URL("/tours", daemonUrl), {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(request),
		});
	} catch {
		throw new Error(
			`no pedagogy daemon at ${daemonUrl}. Start it (pnpm start in the pedagogy repo) or set PEDAGOGY_URL.`,
		);
	}
	const body = (await response.json()) as { url?: string; error?: string };
	if (!response.ok || !body.url) {
		throw new Error(body.error ?? `daemon answered ${response.status}`);
	}
	return body.url;
}
