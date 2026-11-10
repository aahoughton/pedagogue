import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import WebSocket from "ws";
import { FakeDriver, type FakeSession } from "./fake-driver.ts";
import { type App, createApp, listen } from "./server.ts";

const root = mkdtempSync(join(tmpdir(), "pedagogy-server-test-"));
writeFileSync(join(root, "a.txt"), "one\ntwo\n");
const driver = new FakeDriver();
const app: App = createApp({
	driver,
	dataDir: join(root, "data"),
	publicUrl: "http://desk.example:4270",
	allowedHosts: ["127.0.0.1"],
});
const { server, port } = await listen(app, "127.0.0.1", 0);
const base = `http://127.0.0.1:${port}`;
after(() => {
	app.close();
	server.close();
});

function post(body: unknown, headers: Record<string, string> = {}) {
	return fetch(`${base}/tours`, {
		method: "POST",
		headers: { "content-type": "application/json", ...headers },
		body: JSON.stringify(body),
	});
}

async function startTour(): Promise<{ id: string; agent: FakeSession }> {
	const response = await post({ cwd: root, brief: "Explain a.txt" });
	assert.equal(response.status, 201);
	const { id } = (await response.json()) as { id: string };
	return { id, agent: driver.sessions.at(-1) as FakeSession };
}

/** Opens a tour socket and collects its messages; `next` waits for the nth one. */
function open(id: string) {
	const socket = new WebSocket(`ws://127.0.0.1:${port}/tours/${id}/ws`);
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

test("starting a tour returns a link on the public URL and lists the tour", async () => {
	const response = await post({ cwd: root, brief: "Explain a.txt" });
	const body = (await response.json()) as { id: string; url: string };
	assert.equal(body.url, `http://desk.example:4270/tours/${body.id}`);
	assert.deepEqual(driver.sessions.at(-1)?.received, ["Explain a.txt"]);

	const list = (await (await fetch(`${base}/tours`)).json()) as {
		tours: Array<{ id: string; status: string }>;
	};
	assert.ok(list.tours.some((t) => t.id === body.id && t.status === "working"));
	assert.equal((await fetch(`${base}/tours/${body.id}`)).status, 200);
});

test("a tour cannot start in a missing directory or on a file", async () => {
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

test("several tours run side by side with separate agents and state", async () => {
	const one = await startTour();
	const two = await startTour();
	assert.notEqual(one.id, two.id);
	await one.agent.call("show_code", { path: "a.txt" });
	assert.equal(app.tours.get(one.id)?.state.panes.length, 1);
	assert.equal(app.tours.get(two.id)?.state.panes.length, 0);
});

test("a viewer sees the tutor's display changes and can reply", async () => {
	const { id, agent } = await startTour();
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

test("input the tour cannot use comes back as an error message", async () => {
	const { id } = await startTour();
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
	const { id } = await startTour();
	const before = driver.sessions.length;
	const foreign = await post(
		{ cwd: root, brief: "x" },
		{ origin: "http://evil.example" },
	);
	assert.equal(foreign.status, 403);
	assert.equal(driver.sessions.length, before);

	const rebound = await fetch(`http://localhost:${port}/tours`).catch(
		() => undefined,
	);
	if (rebound) assert.equal(rebound.status, 403);

	const socket = new WebSocket(`ws://127.0.0.1:${port}/tours/${id}/ws`, {
		origin: "http://evil.example",
	});
	const outcome = await new Promise<string>((resolve) => {
		socket.on("open", () => resolve("open"));
		socket.on("error", () => resolve("refused"));
	});
	assert.equal(outcome, "refused");
});

test("deleting a tour closes it and its agent", async () => {
	const { id, agent } = await startTour();
	const response = await fetch(`${base}/tours/${id}`, { method: "DELETE" });
	assert.equal(response.status, 200);
	assert.equal(agent.closed, true);
	assert.equal(app.tours.get(id)?.state.status, "closed");
	assert.equal((await fetch(`${base}/tours/zzzz`)).status, 404);
});

test("only the listed assets are served", async () => {
	assert.equal((await fetch(`${base}/assets/tour.js`)).status, 200);
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
