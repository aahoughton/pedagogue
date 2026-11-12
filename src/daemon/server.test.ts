import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import WebSocket from "ws";
import { FakeDriver, type FakeSession } from "./fake-driver.ts";
import { type App, createApp, listen } from "./server.ts";
import { WalkthroughStore } from "./store.ts";

const root = mkdtempSync(join(tmpdir(), "pedagogue-server-test-"));
writeFileSync(join(root, "a.txt"), "one\ntwo\n");
const driver = new FakeDriver();
const store = new WalkthroughStore(join(root, "data"), { delayMs: 10 });
const app: App = createApp({
	driver,
	store,
	publicUrl: "http://desk.example:4270",
	allowedHosts: ["127.0.0.1"],
	build: { version: "1.2.3", sha: "abc1234", dirty: false },
});
const { server, port } = await listen(app, "127.0.0.1", 0);
const base = `http://127.0.0.1:${port}`;
after(() => {
	void app.close();
	server.close();
});

function post(body: unknown, headers: Record<string, string> = {}) {
	return fetch(`${base}/walkthroughs`, {
		method: "POST",
		headers: { "content-type": "application/json", ...headers },
		body: JSON.stringify(body),
	});
}

async function startWalkthrough(): Promise<{ id: string; agent: FakeSession }> {
	const response = await post({ cwd: root, brief: "Explain a.txt" });
	assert.equal(response.status, 201);
	const { id } = (await response.json()) as { id: string };
	return { id, agent: driver.sessions.at(-1) as FakeSession };
}

/** Opens a walkthrough socket and collects its messages; `next` waits for the nth one. */
function open(id: string) {
	const socket = new WebSocket(`ws://127.0.0.1:${port}/walkthroughs/${id}/ws`);
	const messages: Array<Record<string, unknown>> = [];
	const waiters: Array<() => void> = [];
	socket.on("message", (data) => {
		messages.push(JSON.parse(String(data)));
		for (const wake of waiters.splice(0)) wake();
	});
	return {
		socket,
		messages,
		async until(count: number) {
			while (messages.length < count) {
				await new Promise<void>((resolve) => waiters.push(resolve));
			}
		},
	};
}

test("starting a walkthrough returns a link on the public URL and lists the walkthrough", async () => {
	const response = await post({ cwd: root, brief: "Explain a.txt" });
	const body = (await response.json()) as { id: string; url: string };
	assert.equal(body.url, `http://desk.example:4270/walkthroughs/${body.id}`);
	assert.deepEqual(driver.sessions.at(-1)?.received, ["Explain a.txt"]);

	const list = (await (await fetch(`${base}/walkthroughs`)).json()) as {
		walkthroughs: Array<Record<string, string | undefined>>;
	};
	const listed = list.walkthroughs.find((t) => t.id === body.id);
	assert.equal(listed?.status, "working");
	assert.equal(listed?.title, "Explain a.txt");
	assert.equal(listed?.summary, "Explain a.txt");
	assert.equal(listed?.createdAt, app.walkthroughs.get(body.id)?.createdAt);
	assert.equal(listed?.lastMessageAt, undefined);
	assert.equal((await fetch(`${base}/walkthroughs/${body.id}`)).status, 200);
});

test("the daemon reports its build", async () => {
	const response = await fetch(`${base}/about`);
	assert.deepEqual(await response.json(), {
		version: "1.2.3",
		sha: "abc1234",
		dirty: false,
	});
});

test("a walkthrough cannot start in a missing directory or on a file", async () => {
	const missing = await post({ cwd: join(root, "nope"), brief: "x" });
	assert.equal(missing.status, 400);
	assert.match(
		((await missing.json()) as { error: string }).error,
		/no such directory/,
	);
	const file = await post({ cwd: join(root, "a.txt"), brief: "x" });
	assert.match(
		((await file.json()) as { error: string }).error,
		/not a directory/,
	);
	assert.equal((await post({ cwd: root })).status, 400);
});

test("several walkthroughs run side by side with separate agents and state", async () => {
	const one = await startWalkthrough();
	const two = await startWalkthrough();
	assert.notEqual(one.id, two.id);
	await one.agent.call("show_code", { path: "a.txt" });
	assert.equal(app.walkthroughs.get(one.id)?.state.panes.length, 1);
	assert.equal(app.walkthroughs.get(two.id)?.state.panes.length, 0);
});

test("a viewer sees the tutor's display changes and can reply", async () => {
	const { id, agent } = await startWalkthrough();
	const viewer = open(id);
	await viewer.until(1);
	assert.equal(viewer.messages[0]?.type, "snapshot");

	await agent.call("show_code", {
		path: "a.txt",
		highlights: [{ start: 1, end: 1 }],
	});
	await viewer.until(3);
	assert.deepEqual(
		viewer.messages.slice(1).map((m) => m.type),
		["pane", "focus"],
	);

	viewer.socket.send(
		JSON.stringify({
			type: "message",
			text: "why?",
			selection: { paneId: "code:a.txt", lines: [2] },
		}),
	);
	await viewer.until(4);
	assert.match(
		agent.received.at(-1) ?? "",
		/lines="2">\n2\ttwo\n<\/selection>\nwhy\?$/,
	);
	viewer.socket.close();
});

test("input the walkthrough cannot use comes back as an error message", async () => {
	const { id } = await startWalkthrough();
	const viewer = open(id);
	await viewer.until(1);
	viewer.socket.send(
		JSON.stringify({ type: "answer", quizId: "t99", text: "x" }),
	);
	viewer.socket.send("not json");
	await viewer.until(3);
	assert.deepEqual(viewer.messages.slice(1), [
		{ type: "error", message: "no such quiz: t99" },
		{ type: "error", message: "the daemon could not read that message" },
	]);
	viewer.socket.close();
});

test("requests for another host or from another origin are refused", async () => {
	const { id } = await startWalkthrough();
	const before = driver.sessions.length;
	const foreign = await post(
		{ cwd: root, brief: "x" },
		{ origin: "http://evil.example" },
	);
	assert.equal(foreign.status, 403);
	assert.equal(driver.sessions.length, before);

	const rebound = await fetch(`http://localhost:${port}/walkthroughs`).catch(
		() => undefined,
	);
	if (rebound) assert.equal(rebound.status, 403);

	const socket = new WebSocket(`ws://127.0.0.1:${port}/walkthroughs/${id}/ws`, {
		origin: "http://evil.example",
	});
	const outcome = await new Promise<string>((resolve) => {
		socket.on("open", () => resolve("open"));
		socket.on("error", () => resolve("refused"));
	});
	assert.equal(outcome, "refused");
});

test("deleting a walkthrough stops its agent and removes it for good", async () => {
	const { id, agent } = await startWalkthrough();
	const dir = join(root, "data", "walkthroughs", id);
	await store.flush();
	assert.equal(existsSync(join(dir, "walkthrough.json")), true);

	const response = await fetch(`${base}/walkthroughs/${id}`, {
		method: "DELETE",
	});
	assert.equal(response.status, 200);
	assert.equal(agent.closed, true);
	assert.equal((await fetch(`${base}/walkthroughs/${id}`)).status, 404);
	const { walkthroughs } = (await (
		await fetch(`${base}/walkthroughs`)
	).json()) as {
		walkthroughs: Array<{ id: string }>;
	};
	assert.equal(
		walkthroughs.some((walkthrough) => walkthrough.id === id),
		false,
	);
	// Closing the walkthrough changed it; that change must not save it back.
	await new Promise((resolve) => setTimeout(resolve, 50));
	await store.flush();
	assert.equal(existsSync(dir), false);

	const again = await fetch(`${base}/walkthroughs/${id}`, { method: "DELETE" });
	assert.equal(again.status, 404);
});

test("a delete from another origin is refused", async () => {
	const { id } = await startWalkthrough();
	const response = await fetch(`${base}/walkthroughs/${id}`, {
		method: "DELETE",
		headers: { origin: "http://evil.example" },
	});
	assert.equal(response.status, 403);
	assert.equal(app.walkthroughs.has(id), true);
});

test("only the listed assets are served", async () => {
	assert.equal((await fetch(`${base}/assets/walkthrough.js`)).status, 200);
	const icon = await fetch(`${base}/assets/favicon.svg`);
	assert.equal(icon.status, 200);
	assert.match(icon.headers.get("content-type") ?? "", /^image\/svg\+xml/);
	assert.equal((await fetch(`${base}/vendor/marked.js`)).status, 200);
	assert.equal((await fetch(`${base}/assets/../package.json`)).status, 404);
	assert.equal((await fetch(`${base}/package.json`)).status, 404);
	assert.equal(
		(await fetch(`${base}/vendor/mermaid/mermaid.esm.min.mjs`)).status,
		200,
	);
	assert.equal(
		(await fetch(`${base}/vendor/mermaid/package.json`)).status,
		404,
	);
	assert.equal(
		(
			await fetch(
				`${base}/vendor/mermaid/chunks/mermaid.esm.min/%2e%2e/%2e%2e/%2e%2e/package.json`,
			)
		).status,
		404,
	);
});

test("walkthroughs come back after a restart, dormant, and wake on input", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pedagogue-restart-test-"));
	writeFileSync(join(dir, "a.txt"), "one\ntwo\n");
	const firstDriver = new FakeDriver();
	const first = createApp({
		driver: firstDriver,
		store: new WalkthroughStore(join(dir, "data")),
		publicUrl: "http://desk.example:4270",
		allowedHosts: ["127.0.0.1"],
		build: { version: "1.2.3", sha: "abc1234", dirty: false },
	});
	const one = await listen(first, "127.0.0.1", 0);
	const created = await fetch(`http://127.0.0.1:${one.port}/walkthroughs`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ cwd: dir, brief: "Explain a.txt" }),
	});
	const { id } = (await created.json()) as { id: string };
	const agent = firstDriver.sessions[0] as FakeSession;
	await agent.call("show_code", { path: "a.txt" });
	await agent.emit({ type: "text", text: "Here is a.txt." });
	await first.close();
	one.server.close();
	assert.equal(agent.closed, true);

	const store = new WalkthroughStore(join(dir, "data"));
	const { records } = await store.loadAll();
	const secondDriver = new FakeDriver();
	const second = createApp({
		driver: secondDriver,
		store,
		records,
		publicUrl: "http://desk.example:4270",
		allowedHosts: ["127.0.0.1"],
		build: { version: "1.2.3", sha: "abc1234", dirty: false },
	});
	const two = await listen(second, "127.0.0.1", 0);
	after(async () => {
		await second.close();
		two.server.close();
	});

	const list = (await (
		await fetch(`http://127.0.0.1:${two.port}/walkthroughs`)
	).json()) as {
		walkthroughs: Array<{ id: string; status: string }>;
	};
	assert.deepEqual(
		list.walkthroughs.map((t) => [t.id, t.status]),
		[[id, "waiting"]],
	);
	assert.equal(secondDriver.sessions.length, 0);

	const socket = new WebSocket(
		`ws://127.0.0.1:${two.port}/walkthroughs/${id}/ws`,
	);
	const snapshot = await new Promise<{
		state: { panes: unknown[]; transcript: unknown[] };
	}>((resolve) =>
		socket.once("message", (data) => resolve(JSON.parse(String(data)))),
	);
	assert.equal(snapshot.state.panes.length, 1);
	assert.equal(snapshot.state.transcript.length, 1);

	socket.send(JSON.stringify({ type: "message", text: "and then?" }));
	await new Promise((resolve) => setTimeout(resolve, 50));
	assert.equal(
		secondDriver.sessions[0]?.options.resumeToken,
		agent.resumeToken,
	);
	assert.deepEqual(secondDriver.sessions[0]?.received, ["and then?"]);
	socket.close();
});

test("the list shows the tutor's name for a walkthrough and orders by the last message", async () => {
	const older = await startWalkthrough();
	const newer = await startWalkthrough();
	await older.agent.call("set_outline", {
		steps: ["a"],
		title: "Line counting",
		summary: "How a.txt is counted.",
	});
	await older.agent.emit({ type: "text", text: "Hello." });
	const { walkthroughs } = (await (
		await fetch(`${base}/walkthroughs`)
	).json()) as {
		walkthroughs: Array<Record<string, string | undefined>>;
	};
	const first = walkthroughs.find((t) => t.id === older.id);
	assert.equal(first?.title, "Line counting");
	assert.equal(first?.summary, "How a.txt is counted.");
	assert.equal(
		first?.lastMessageAt,
		app.walkthroughs.get(older.id)?.lastMessageAt,
	);
	assert.ok(first?.lastMessageAt);
	assert.ok(
		walkthroughs.findIndex((t) => t.id === older.id) <
			walkthroughs.findIndex((t) => t.id === newer.id),
	);
});

test("a link from before the rename leads to the walkthrough", async () => {
	const { id } = await startWalkthrough();
	const response = await fetch(`${base}/tours/${id}`, { redirect: "manual" });
	assert.equal(response.status, 308);
	assert.equal(response.headers.get("location"), `/walkthroughs/${id}`);
	assert.equal((await fetch(`${base}/tours/${id}`)).status, 200);
});
