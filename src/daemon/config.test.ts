import assert from "node:assert/strict";
import { test } from "node:test";
import { allowedHosts, ConfigError, readConfig } from "./config.ts";

test("refuses to start without a credential", () => {
	assert.throws(() => readConfig({}), ConfigError);
	assert.throws(
		() => readConfig({ ANTHROPIC_API_KEY: "", CLAUDE_CODE_OAUTH_TOKEN: "" }),
		/Neither ANTHROPIC_API_KEY nor CLAUDE_CODE_OAUTH_TOKEN is set/,
	);
});

test("runs tutors on an API key or on a subscription token", () => {
	assert.deepEqual(readConfig({ ANTHROPIC_API_KEY: "k" }).credential, {
		kind: "apiKey",
		value: "k",
	});
	assert.deepEqual(
		readConfig({ ANTHROPIC_API_KEY: "", CLAUDE_CODE_OAUTH_TOKEN: "t" })
			.credential,
		{ kind: "subscriptionToken", value: "t" },
	);
});

test("refuses to start with both an API key and a subscription token", () => {
	assert.throws(
		() => readConfig({ ANTHROPIC_API_KEY: "k", CLAUDE_CODE_OAUTH_TOKEN: "t" }),
		/both set/,
	);
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
		PEDAGOGUE_HOST: "127.0.0.1, 100.64.0.7",
		PEDAGOGUE_PORT: "5000",
		PEDAGOGUE_PUBLIC_URL: "http://desk.tailnet.ts.net:5000",
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
		() => readConfig({ ANTHROPIC_API_KEY: "k", PEDAGOGUE_PORT: "http" }),
		/not a port/,
	);
	assert.throws(
		() => readConfig({ ANTHROPIC_API_KEY: "k", PEDAGOGUE_PUBLIC_URL: "desk" }),
		/not a URL/,
	);
});
