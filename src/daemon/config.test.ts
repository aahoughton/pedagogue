import assert from "node:assert/strict";
import { test } from "node:test";
import { allowedHosts, ConfigError, readConfig } from "./config.ts";

test("refuses to start without an API key", () => {
	assert.throws(() => readConfig({}), ConfigError);
});

test("defaults to loopback on port 4270", () => {
	const config = readConfig({ ANTHROPIC_API_KEY: "k", HOME: "/home/u" });
	assert.deepEqual(config.hosts, ["127.0.0.1"]);
	assert.equal(config.publicUrl, "http://127.0.0.1:4270");
	assert.deepEqual(allowedHosts(config).sort(), ["127.0.0.1", "localhost"]);
});

test("listens on several addresses and allows the public URL's host", () => {
	const config = readConfig({
		ANTHROPIC_API_KEY: "k",
		PEDAGOGY_HOST: "127.0.0.1, 100.64.0.7",
		PEDAGOGY_PORT: "5000",
		PEDAGOGY_PUBLIC_URL: "http://desk.tailnet.ts.net:5000",
	});
	assert.deepEqual(config.hosts, ["127.0.0.1", "100.64.0.7"]);
	assert.deepEqual(allowedHosts(config).sort(), [
		"100.64.0.7",
		"127.0.0.1",
		"desk.tailnet.ts.net",
		"localhost",
	]);
});

test("rejects a bad port or public URL", () => {
	assert.throws(
		() => readConfig({ ANTHROPIC_API_KEY: "k", PEDAGOGY_PORT: "http" }),
		/not a port/,
	);
	assert.throws(
		() => readConfig({ ANTHROPIC_API_KEY: "k", PEDAGOGY_PUBLIC_URL: "desk" }),
		/not a URL/,
	);
});
