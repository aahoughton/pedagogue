import assert from "node:assert/strict";
import { test } from "node:test";
import { tutorEnv } from "./claude-driver.ts";

const daemonEnv = {
	PATH: "/usr/bin",
	ANTHROPIC_API_KEY: "stale-key",
	ANTHROPIC_AUTH_TOKEN: "stale-bearer",
	CLAUDE_CODE_OAUTH_TOKEN: "stale-token",
};

test("a tutor on an API key gets that key and no other credential", () => {
	assert.deepEqual(tutorEnv(daemonEnv, { kind: "apiKey", value: "k" }), {
		PATH: "/usr/bin",
		ANTHROPIC_API_KEY: "k",
	});
});

test("a tutor on a subscription token gets that token and no other credential", () => {
	assert.deepEqual(
		tutorEnv(daemonEnv, { kind: "subscriptionToken", value: "t" }),
		{ PATH: "/usr/bin", CLAUDE_CODE_OAUTH_TOKEN: "t" },
	);
});
