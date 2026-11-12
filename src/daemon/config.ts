import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_PORT = 4270;

/** What tutors authenticate with: an API key or a Claude subscription token. */
export interface Credential {
	kind: "apiKey" | "subscriptionToken";
	value: string;
}

export interface Config {
	credential: Credential;
	/** Addresses to listen on. */
	hosts: string[];
	port: number;
	publicUrl: string;
	dataDir: string;
	/** How long a tutor may wait for the learner before its process is stopped. */
	idleMs: number;
	model?: string;
}

export class ConfigError extends Error {}

/**
 * Reads the daemon's configuration from environment variables, which main.ts
 * fills from the env file first (see env-file.ts):
 *
 * - ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN (exactly one required): what
 *   every tutor runs on. The first is an Anthropic API key; the second is a
 *   Claude subscription token printed by `claude setup-token`. An empty value
 *   counts as unset.
 * - PEDAGOGUE_HOST: comma-separated addresses to listen on. Default 127.0.0.1.
 *   Add the machine's tailnet address to reach tours from another machine.
 * - PEDAGOGUE_PORT: default 4270.
 * - PEDAGOGUE_PUBLIC_URL: base URL put in the links handed out for tours.
 *   Default http://<first host>:<port>.
 * - PEDAGOGUE_DATA_DIR: default $XDG_DATA_HOME/pedagogue or ~/.local/share/pedagogue.
 * - PEDAGOGUE_IDLE_MINUTES: how long a tutor waits for the learner before its
 *   process is stopped; the next message wakes it. Default 15.
 * - PEDAGOGUE_MODEL: model for tutors. Default: the Agent SDK's default.
 */
export function readConfig(env: NodeJS.ProcessEnv): Config {
	const credential = readCredential(env);
	const hosts = (env.PEDAGOGUE_HOST ?? "127.0.0.1")
		.split(",")
		.map((host) => host.trim())
		.filter(Boolean);
	if (hosts.length === 0)
		throw new ConfigError("PEDAGOGUE_HOST names no address");

	const port = env.PEDAGOGUE_PORT ? Number(env.PEDAGOGUE_PORT) : DEFAULT_PORT;
	if (!Number.isInteger(port) || port < 1 || port > 65535) {
		throw new ConfigError(
			`PEDAGOGUE_PORT is not a port: ${env.PEDAGOGUE_PORT}`,
		);
	}

	const publicUrl = env.PEDAGOGUE_PUBLIC_URL ?? `http://${hosts[0]}:${port}`;
	if (!URL.canParse(publicUrl)) {
		throw new ConfigError(`PEDAGOGUE_PUBLIC_URL is not a URL: ${publicUrl}`);
	}

	const dataDir =
		env.PEDAGOGUE_DATA_DIR ??
		join(env.XDG_DATA_HOME ?? join(homedir(), ".local/share"), "pedagogue");

	const idleMinutes = env.PEDAGOGUE_IDLE_MINUTES
		? Number(env.PEDAGOGUE_IDLE_MINUTES)
		: 15;
	if (!(idleMinutes > 0)) {
		throw new ConfigError(
			`PEDAGOGUE_IDLE_MINUTES is not a positive number: ${env.PEDAGOGUE_IDLE_MINUTES}`,
		);
	}

	return {
		credential,
		hosts,
		port,
		publicUrl,
		dataDir,
		idleMs: idleMinutes * 60_000,
		model: env.PEDAGOGUE_MODEL,
	};
}

function readCredential(env: NodeJS.ProcessEnv): Credential {
	const apiKey = env.ANTHROPIC_API_KEY;
	const token = env.CLAUDE_CODE_OAUTH_TOKEN;
	if (apiKey && token) {
		throw new ConfigError(
			"ANTHROPIC_API_KEY and CLAUDE_CODE_OAUTH_TOKEN are both set. Tutors run on one of them; remove the other from the settings file or the environment and start again.",
		);
	}
	if (apiKey) return { kind: "apiKey", value: apiKey };
	if (token) return { kind: "subscriptionToken", value: token };
	throw new ConfigError(
		"Neither ANTHROPIC_API_KEY nor CLAUDE_CODE_OAUTH_TOKEN is set. Tutors run on an API key or a Claude subscription token; put one in the settings file or the environment and start again.",
	);
}

/** Hostnames requests may be addressed to: every listen address and the public URL's host. */
export function allowedHosts(config: Config): string[] {
	const names = new Set([...config.hosts, new URL(config.publicUrl).hostname]);
	if (config.hosts.includes("127.0.0.1")) names.add("localhost");
	return [...names];
}
