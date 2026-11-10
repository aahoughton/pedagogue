import { EnvFileError, envFilePath, loadEnvFile } from "../env-file.ts";
import { ClaudeDriver } from "./claude-driver.ts";
import { allowedHosts, ConfigError, readConfig } from "./config.ts";
import { createApp, listen } from "./server.ts";
import { TourStore } from "./store.ts";

let config: ReturnType<typeof readConfig>;
try {
	const loaded = loadEnvFile(process.env);
	console.log(
		loaded
			? `pedagogy: settings from ${loaded}`
			: `pedagogy: no settings file at ${envFilePath(process.env)}, using the environment`,
	);
	config = readConfig(process.env);
} catch (error) {
	if (!(error instanceof ConfigError || error instanceof EnvFileError)) {
		throw error;
	}
	console.error(`pedagogy: ${error.message}`);
	process.exit(2);
}

const store = new TourStore(config.dataDir);
const { records, problems } = await store.loadAll();
for (const problem of problems) {
	console.error(`pedagogy: skipped a saved tour: ${problem}`);
}
console.log(`pedagogy: ${records.length} saved tours in ${config.dataDir}`);

const app = createApp({
	driver: new ClaudeDriver({ apiKey: config.apiKey, model: config.model }),
	store,
	records,
	idleMs: config.idleMs,
	publicUrl: config.publicUrl,
	allowedHosts: allowedHosts(config),
});

for (const host of config.hosts) {
	try {
		await listen(app, host, config.port);
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		console.error(
			`pedagogy: cannot listen on ${host}:${config.port}: ${reason}`,
		);
		process.exit(1);
	}
	console.log(`pedagogy: listening on http://${host}:${config.port}`);
}
console.log(`pedagogy: tour links use ${config.publicUrl}`);

let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.on(signal, () => {
		if (stopping) return;
		stopping = true;
		app.close().finally(() => process.exit(0));
	});
}
