import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_PORT = 4270;

export interface Config {
	apiKey: string;
	/** Addresses to listen on. */
	hosts: string[];
	port: number;
	publicUrl: string;
	dataDir: string;
	model?: string;
}

export class ConfigError extends Error {}

/**
 * Reads the daemon's configuration from environment variables, which main.ts
 * fills from the env file first (see env-file.ts):
 *
 * - ANTHROPIC_API_KEY (required): the key every tutor runs on.
 * - PEDAGOGY_HOST: comma-separated addresses to listen on. Default 127.0.0.1.
 *   Add the machine's tailnet address to reach tours from another machine.
 * - PEDAGOGY_PORT: default 4270.
 * - PEDAGOGY_PUBLIC_URL: base URL put in the links handed out for tours.
 *   Default http://<first host>:<port>.
 * - PEDAGOGY_DATA_DIR: default $XDG_DATA_HOME/pedagogy or ~/.local/share/pedagogy.
 * - PEDAGOGY_MODEL: model for tutors. Default: the Agent SDK's default.
 */
export function readConfig(env: NodeJS.ProcessEnv): Config {
	const apiKey = env.ANTHROPIC_API_KEY;
	if (!apiKey) {
		throw new ConfigError(
			"ANTHROPIC_API_KEY is not set. Tutors run on an API key; put it in the settings file or the environment and start again.",
		);
	}
	const hosts = (env.PEDAGOGY_HOST ?? "127.0.0.1")
		.split(",")
		.map((host) => host.trim())
		.filter(Boolean);
	if (hosts.length === 0)
		throw new ConfigError("PEDAGOGY_HOST names no address");

	const port = env.PEDAGOGY_PORT ? Number(env.PEDAGOGY_PORT) : DEFAULT_PORT;
	if (!Number.isInteger(port) || port < 1 || port > 65535) {
		throw new ConfigError(`PEDAGOGY_PORT is not a port: ${env.PEDAGOGY_PORT}`);
	}

	const publicUrl = env.PEDAGOGY_PUBLIC_URL ?? `http://${hosts[0]}:${port}`;
	if (!URL.canParse(publicUrl)) {
		throw new ConfigError(`PEDAGOGY_PUBLIC_URL is not a URL: ${publicUrl}`);
	}

	const dataDir =
		env.PEDAGOGY_DATA_DIR ??
		join(env.XDG_DATA_HOME ?? join(homedir(), ".local/share"), "pedagogy");

	return { apiKey, hosts, port, publicUrl, dataDir, model: env.PEDAGOGY_MODEL };
}

/** Hostnames requests may be addressed to: every listen address and the public URL's host. */
export function allowedHosts(config: Config): string[] {
	const names = new Set([...config.hosts, new URL(config.publicUrl).hostname]);
	if (config.hosts.includes("127.0.0.1")) names.add("localhost");
	return [...names];
}
