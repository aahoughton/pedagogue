import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export class EnvFileError extends Error {}

/** $PEDAGOGUE_ENV_FILE, or pedagogue/env under $XDG_CONFIG_HOME (default ~/.config). */
export function envFilePath(env: NodeJS.ProcessEnv): string {
	return (
		env.PEDAGOGUE_ENV_FILE ??
		join(env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "pedagogue", "env")
	);
}

/**
 * Loads KEY=value settings from the env file into `process.env`. Variables that
 * are already set keep their value. Returns the path loaded, or undefined when
 * the default file does not exist. A file named by PEDAGOGUE_ENV_FILE must exist.
 * The file can hold a credential, so one that other users can read is refused.
 */
export function loadEnvFile(env: NodeJS.ProcessEnv): string | undefined {
	const path = envFilePath(env);
	if (!existsSync(path)) {
		if (env.PEDAGOGUE_ENV_FILE) {
			throw new EnvFileError(`PEDAGOGUE_ENV_FILE does not exist: ${path}`);
		}
		return undefined;
	}
	if (statSync(path).mode & 0o077) {
		throw new EnvFileError(
			`${path} is readable by other users. Run: chmod 600 ${path}`,
		);
	}
	process.loadEnvFile(path);
	return path;
}
