import { EnvFileError, envFilePath, loadEnvFile } from "../env-file.ts";
import { readBuild } from "./build.ts";
import { ClaudeDriver } from "./claude-driver.ts";
import { allowedHosts, ConfigError, readConfig } from "./config.ts";
import { createApp, listen, ROOT } from "./server.ts";
import { WalkthroughStore } from "./store.ts";

let config: ReturnType<typeof readConfig>;
try {
	const loaded = loadEnvFile(process.env);
	console.log(
		loaded
			? `pedagogue: settings from ${loaded}`
			: `pedagogue: no settings file at ${envFilePath(process.env)}, using the environment`,
	);
	config = readConfig(process.env);
} catch (error) {
	if (!(error instanceof ConfigError || error instanceof EnvFileError)) {
		throw error;
	}
	console.error(`pedagogue: ${error.message}`);
	process.exit(2);
}

console.log(
	config.credential.kind === "apiKey"
		? "pedagogue: tutors run on an API key"
		: "pedagogue: tutors run on a Claude subscription token",
);

const store = new WalkthroughStore(config.dataDir);
try {
	const moved = await store.adoptOldNames();
	if (moved) console.log(`pedagogue: moved saved data out of ${moved}`);
} catch (error) {
	console.error(
		`pedagogue: ${error instanceof Error ? error.message : String(error)}`,
	);
	process.exit(2);
}
const { records, problems } = await store.loadAll();
for (const problem of problems) {
	console.error(`pedagogue: skipped a saved walkthrough: ${problem}`);
}
console.log(
	`pedagogue: ${records.length} saved walkthroughs in ${config.dataDir}`,
);

const app = createApp({
	driver: new ClaudeDriver({
		credential: config.credential,
		model: config.model,
	}),
	store,
	records,
	idleMs: config.idleMs,
	publicUrl: config.publicUrl,
	allowedHosts: allowedHosts(config),
	build: readBuild(ROOT),
});

for (const host of config.hosts) {
	try {
		await listen(app, host, config.port);
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		console.error(
			`pedagogue: cannot listen on ${host}:${config.port}: ${reason}`,
		);
		process.exit(1);
	}
	console.log(`pedagogue: listening on http://${host}:${config.port}`);
}
console.log(`pedagogue: walkthrough links use ${config.publicUrl}`);

let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.on(signal, () => {
		if (stopping) return;
		stopping = true;
		app.close().finally(() => process.exit(0));
	});
}
