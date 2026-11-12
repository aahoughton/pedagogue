import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { FakeDriver, type FakeSession } from "./fake-driver.ts";
import {
	InputError,
	Walkthrough,
	type WalkthroughEvent,
} from "./walkthrough.ts";

async function openWalkthrough(): Promise<{
	walkthrough: Walkthrough;
	agent: FakeSession;
	events: WalkthroughEvent[];
	cwd: string;
}> {
	const root = mkdtempSync(join(tmpdir(), "pedagogue-test-"));
	const cwd = join(root, "project");
	mkdirSync(cwd);
	writeFileSync(join(cwd, "a.txt"), "one\ntwo\nthree\nfour\nfive\n");
	writeFileSync(join(root, "secret.txt"), "outside\n");
	symlinkSync(join(root, "secret.txt"), join(cwd, "link.txt"));
	const driver = new FakeDriver();
	const walkthrough = await Walkthrough.open({
		id: "t1",
		cwd,
		scratchDir: join(root, "scratch"),
		brief: "Explain a.txt\nmore detail",
		driver,
	});
	const events: WalkthroughEvent[] = [];
	walkthrough.subscribe((event) => events.push(event));
	const agent = driver.sessions[0] as FakeSession;
	return { walkthrough, agent, events, cwd };
}

test("a new walkthrough hands the brief to the tutor and titles itself from its first line", async () => {
	const { walkthrough, agent } = await openWalkthrough();
	assert.deepEqual(agent.received, ["Explain a.txt\nmore detail"]);
	assert.equal(walkthrough.state.title, "Explain a.txt");
	assert.equal(walkthrough.state.status, "working");
});

test("a subscriber gets a snapshot first, then events that rebuild the state", async () => {
	const { walkthrough, agent, events } = await openWalkthrough();
	assert.equal(events[0]?.type, "snapshot");
	await agent.call("show_code", {
		path: "a.txt",
		highlights: [{ start: 2, end: 3 }],
		note: "look here",
	});
	await agent.emit({ type: "text", text: "Notice line two." });
	await agent.emit({ type: "turn_end", status: "completed" });

	const pane = walkthrough.state.panes[0];
	assert.equal(pane?.kind, "code");
	assert.equal(
		pane?.kind === "code" && pane.text,
		"one\ntwo\nthree\nfour\nfive\n",
	);
	assert.equal(walkthrough.state.focus, "code:a.txt");
	assert.equal(walkthrough.state.status, "waiting");
	assert.deepEqual(
		events.slice(1).map((e) => e.type),
		["pane", "focus", "item", "status"],
	);
});

test("show_code refuses missing files, files outside the directory, and bad ranges", async () => {
	const { agent } = await openWalkthrough();
	await assert.rejects(
		agent.call("show_code", { path: "nope.txt" }),
		/no such file: nope.txt/,
	);
	await assert.rejects(
		agent.call("show_code", { path: "../secret.txt" }),
		/outside the walkthrough directory/,
	);
	await assert.rejects(
		agent.call("show_code", { path: "link.txt" }),
		/outside the walkthrough directory/,
	);
	await assert.rejects(
		agent.call("show_code", {
			path: "a.txt",
			highlights: [{ start: 4, end: 9 }],
		}),
		/highlight 4-9 does not fit a.txt, which has 5 lines/,
	);
});

test("a message with a selection reaches the tutor with the selected lines", async () => {
	const { walkthrough, agent } = await openWalkthrough();
	await agent.call("show_code", { path: "a.txt" });
	await agent.emit({ type: "turn_end", status: "completed" });

	walkthrough.input({
		type: "message",
		text: "why these?",
		selection: { paneId: "code:a.txt", lines: [5, 2, 1] },
	});

	assert.equal(
		agent.received.at(-1),
		'<selection path="a.txt" lines="1-2,5">\n1\tone\n2\ttwo\n...\n5\tfive\n</selection>\nwhy these?',
	);
	assert.equal(walkthrough.state.status, "working");
	const item = walkthrough.state.transcript.at(-1);
	assert.deepEqual(item?.kind === "learner" && item.selection, {
		path: "a.txt",
		ranges: [
			{ start: 1, end: 2 },
			{ start: 5, end: 5 },
		],
	});
});

test("a selection outside the file or on a missing pane is rejected", async () => {
	const { walkthrough, agent } = await openWalkthrough();
	await agent.call("show_code", { path: "a.txt" });
	assert.throws(
		() =>
			walkthrough.input({
				type: "message",
				text: "?",
				selection: { paneId: "code:a.txt", lines: [6] },
			}),
		InputError,
	);
	assert.throws(
		() =>
			walkthrough.input({
				type: "message",
				text: "?",
				selection: { paneId: "code:b.txt", lines: [1] },
			}),
		InputError,
	);
	assert.equal(agent.received.length, 1);
});

test("a quiz is answered once and the answer goes to the tutor", async () => {
	const { walkthrough, agent } = await openWalkthrough();
	await agent.call("ask_quiz", {
		question: "What is 1+1?",
		choices: ["2", "3"],
	});
	const quiz = walkthrough.state.transcript.at(-1);
	assert.equal(quiz?.kind, "quiz");

	walkthrough.input({ type: "answer", quizId: quiz?.id as string, text: "2" });
	assert.equal(
		agent.received.at(-1),
		'<quiz_answer question="What is 1+1?">\n2\n</quiz_answer>',
	);
	const answered = walkthrough.state.transcript.at(-1);
	assert.equal(answered?.kind === "quiz" && answered.answer, "2");
	assert.throws(
		() =>
			walkthrough.input({
				type: "answer",
				quizId: quiz?.id as string,
				text: "3",
			}),
		/already answered/,
	);
});

const NAME = { title: "Line counting", summary: "How a.txt is counted." };

test("the tutor names the walkthrough with its first outline", async () => {
	const { walkthrough, agent } = await openWalkthrough();
	const brief = walkthrough.state.title;
	const events: WalkthroughEvent[] = [];
	walkthrough.subscribe((event) => events.push(event));
	await assert.rejects(
		agent.call("set_outline", { steps: ["a"] }),
		/no name yet: call set_outline again with title and summary/,
	);
	await assert.rejects(
		agent.call("set_outline", {
			steps: ["a"],
			title: "x".repeat(41),
			summary: "s",
		}),
		/title is 41 characters; give 1 to 40/,
	);
	assert.equal(walkthrough.state.title, brief);
	assert.deepEqual(walkthrough.state.outline, []);

	await agent.call("set_outline", { steps: ["a"], ...NAME });
	assert.equal(walkthrough.state.title, "Line counting");
	assert.equal(walkthrough.state.summary, "How a.txt is counted.");
	assert.deepEqual(
		events.filter((event) => event.type === "title"),
		[{ type: "title", ...NAME }],
	);

	// Later calls keep the name unless they give a new one.
	await agent.call("set_outline", { steps: ["a", "b"] });
	assert.equal(walkthrough.state.title, "Line counting");
	await agent.call("set_outline", { steps: ["a"], title: " Word counting " });
	assert.equal(walkthrough.state.title, "Word counting");
	assert.equal(walkthrough.state.summary, "How a.txt is counted.");
});

test("set_outline tracks the current step and rejects one past the end", async () => {
	const { walkthrough, agent } = await openWalkthrough();
	await agent.call("set_outline", { steps: ["a", "b"], current: 2, ...NAME });
	assert.deepEqual(walkthrough.state.outline, ["a", "b"]);
	assert.equal(walkthrough.state.step, 1);
	await assert.rejects(
		agent.call("set_outline", { steps: ["a"], current: 2 }),
		/current is 2 but there are 1 steps/,
	);
});

test("closing a pane moves focus to the last remaining pane", async () => {
	const { walkthrough, agent } = await openWalkthrough();
	await agent.call("show_markdown", { id: "m", title: "M", markdown: "# hi" });
	await agent.call("show_html", { id: "h", title: "H", html: "<p>hi</p>" });
	await agent.call("close_pane", { id: "html:h" });
	assert.deepEqual(
		walkthrough.state.panes.map((p) => p.id),
		["md:m"],
	);
	assert.equal(walkthrough.state.focus, "md:m");
	await assert.rejects(
		agent.call("close_pane", { id: "html:h" }),
		/no such pane/,
	);
});

test("a failed turn tells the learner and leaves the walkthrough usable", async () => {
	const { walkthrough, agent } = await openWalkthrough();
	await agent.emit({
		type: "turn_end",
		status: "failed",
		error: "error_max_turns",
	});
	const item = walkthrough.state.transcript.at(-1);
	assert.match(item?.kind === "notice" ? item.text : "", /error_max_turns/);
	assert.equal(walkthrough.state.status, "waiting");
	walkthrough.input({ type: "message", text: "go on" });
	assert.equal(agent.received.at(-1), "go on");
});

test("interrupt reaches the tutor; a closed walkthrough refuses input", async () => {
	const { walkthrough, agent } = await openWalkthrough();
	walkthrough.input({ type: "interrupt" });
	assert.equal(agent.interrupts, 1);
	walkthrough.close();
	assert.equal(agent.closed, true);
	assert.equal(walkthrough.state.status, "closed");
	assert.throws(
		() => walkthrough.input({ type: "message", text: "hi" }),
		/ended/,
	);
});

test("a tutor that dies closes the walkthrough with the error", async () => {
	const { walkthrough, agent } = await openWalkthrough();
	await agent.emit({ type: "closed", error: "process exited" });
	assert.equal(walkthrough.state.status, "closed");
	assert.equal(walkthrough.state.error, "process exited");
});

test("a diagram that fails to draw is reported to the tutor once per showing", async () => {
	const { walkthrough, agent } = await openWalkthrough();
	await agent.call("show_diagram", {
		id: "flow",
		title: "Flow",
		mermaid: "graph TD; A--",
	});
	const pane = walkthrough.state.panes[0];
	assert.deepEqual(pane, {
		id: "diagram:flow",
		kind: "diagram",
		title: "Flow",
		mermaid: "graph TD; A--",
	});
	const before = agent.received.length;

	walkthrough.input({
		type: "pane_error",
		paneId: "diagram:flow",
		message: "Parse error on line 1",
	});
	walkthrough.input({
		type: "pane_error",
		paneId: "diagram:flow",
		message: "Parse error on line 1",
	});
	walkthrough.input({
		type: "pane_error",
		paneId: "diagram:gone",
		message: "x",
	});
	assert.equal(agent.received.length, before + 1);
	assert.match(
		agent.received.at(-1) ?? "",
		/<pane_error pane="diagram:flow">\nParse error on line 1/,
	);

	await agent.call("show_diagram", {
		id: "flow",
		title: "Flow",
		mermaid: "graph TD; A--",
	});
	walkthrough.input({
		type: "pane_error",
		paneId: "diagram:flow",
		message: "still broken",
	});
	assert.equal(agent.received.length, before + 2);
});

test("streamed text grows one transcript item and settles on the final text", async () => {
	const { walkthrough, agent, events } = await openWalkthrough();
	await agent.emit({ type: "activity", label: "Reading a.txt" });
	assert.equal(walkthrough.state.activity, "Reading a.txt");

	await agent.emit({ type: "text_delta", id: "m1:0", text: "Line " });
	await agent.emit({ type: "text_delta", id: "m1:0", text: "two" });
	const growing = walkthrough.state.transcript.at(-1);
	assert.deepEqual(growing, {
		id: growing?.id,
		at: growing?.at,
		kind: "tutor",
		text: "Line two",
		streaming: true,
	});
	assert.equal(walkthrough.state.activity, "Writing");

	await agent.emit({ type: "text", id: "m1:0", text: "Line two." });
	assert.equal(walkthrough.state.transcript.length, 1);
	assert.deepEqual(walkthrough.state.transcript[0], {
		id: growing?.id,
		at: growing?.at,
		kind: "tutor",
		text: "Line two.",
	});
	assert.deepEqual(
		events.slice(1).map((e) => e.type),
		["activity", "activity", "item", "item_delta", "item"],
	);
});

test("a message cut off mid-stream is settled when the turn ends", async () => {
	const { walkthrough, agent } = await openWalkthrough();
	await agent.emit({ type: "activity", label: "Thinking" });
	await agent.emit({ type: "text_delta", id: "m1:0", text: "Half a sen" });
	await agent.emit({ type: "turn_end", status: "interrupted" });
	assert.deepEqual(walkthrough.state.transcript.at(-1), {
		id: "t1",
		at: walkthrough.state.transcript.at(-1)?.at,
		kind: "tutor",
		text: "Half a sen",
	});
	assert.equal(walkthrough.state.activity, undefined);
	assert.equal(walkthrough.state.status, "waiting");
});

test("a second question is refused while one is open", async () => {
	const { walkthrough, agent } = await openWalkthrough();
	await agent.call("ask_quiz", { question: "First?" });
	await assert.rejects(
		agent.call("ask_quiz", { question: "First?" }),
		/already open and unanswered: "First\?"/,
	);
	await assert.rejects(
		agent.call("ask_quiz", { question: "Second?" }),
		/already open/,
	);
	assert.equal(
		walkthrough.state.transcript.filter((i) => i.kind === "quiz").length,
		1,
	);

	const quiz = walkthrough.state.transcript[0];
	walkthrough.input({
		type: "answer",
		quizId: quiz?.id as string,
		text: "yes",
	});
	await agent.call("ask_quiz", { question: "Second?" });
	assert.equal(
		walkthrough.state.transcript.filter((i) => i.kind === "quiz").length,
		2,
	);
});

test("a message sent instead of an answer skips the open question", async () => {
	const { walkthrough, agent } = await openWalkthrough();
	await agent.call("ask_quiz", { question: "Why?" });
	const quiz = walkthrough.state.transcript[0];

	walkthrough.input({ type: "message", text: "next" });
	assert.equal(agent.received.at(-1), '<quiz_skipped question="Why?" />\nnext');
	const skipped = walkthrough.state.transcript[0];
	assert.equal(skipped?.kind === "quiz" && skipped.skipped, true);
	assert.throws(
		() =>
			walkthrough.input({
				type: "answer",
				quizId: quiz?.id as string,
				text: "late",
			}),
		/skipped/,
	);
	await agent.call("ask_quiz", { question: "Another?" });
});

test("transcript items carry the time they were added and the snapshot the walkthrough's start", async () => {
	const before = Date.now();
	const { walkthrough, agent, events } = await openWalkthrough();
	await agent.emit({ type: "text", text: "Hello." });
	walkthrough.input({ type: "message", text: "hi" });
	const after = Date.now();

	const times = walkthrough.state.transcript.map((item) =>
		Date.parse(item.at ?? ""),
	);
	assert.equal(times.length, 2);
	for (const time of times) assert.ok(time >= before && time <= after);

	const snapshot = events[0];
	assert.equal(snapshot?.type, "snapshot");
	assert.equal(
		snapshot?.type === "snapshot" && snapshot.createdAt,
		walkthrough.record().createdAt,
	);
});

test("a walkthrough saved before items had times still loads", async () => {
	const { walkthrough, agent } = await openWalkthrough();
	await agent.emit({ type: "text", text: "Hello." });
	const record = JSON.parse(JSON.stringify(walkthrough.record()));
	for (const item of record.state.transcript) delete item.at;

	const restored = Walkthrough.restore(record, {
		driver: new FakeDriver(),
		scratchDir: "/tmp/scratch",
	});
	assert.deepEqual(restored.state.transcript, [
		{ id: "t1", kind: "tutor", text: "Hello." },
	]);
	restored.input({ type: "message", text: "go on" });
	assert.ok(restored.state.transcript[1]?.at);
});

async function tick(): Promise<void> {
	await new Promise((resolve) => setImmediate(resolve));
}

test("a restored walkthrough is dormant and wakes its tutor with the saved conversation", async () => {
	const { walkthrough, agent } = await openWalkthrough();
	await agent.call("show_code", { path: "a.txt" });
	await agent.emit({ type: "text_delta", id: "m:0", text: "Half" });
	const record = JSON.parse(JSON.stringify(walkthrough.record()));
	assert.equal(record.resumeToken, agent.resumeToken);

	const driver = new FakeDriver();
	const restored = Walkthrough.restore(record, {
		driver,
		scratchDir: "/tmp/scratch",
	});
	assert.equal(restored.awake, false);
	assert.equal(driver.sessions.length, 0);
	assert.equal(restored.state.status, "waiting");
	assert.deepEqual(restored.state.transcript, [
		{
			id: "t1",
			at: record.state.transcript[0].at,
			kind: "tutor",
			text: "Half",
		},
	]);
	assert.equal(restored.state.panes.length, 1);

	restored.input({ type: "message", text: "where were we?" });
	await tick();
	const woken = driver.sessions[0] as FakeSession;
	assert.equal(woken.options.resumeToken, agent.resumeToken);
	assert.deepEqual(woken.received, ["where were we?"]);
	assert.equal(restored.state.transcript.at(-1)?.id, "t2");

	await woken.call("show_code", {
		path: "a.txt",
		highlights: [{ start: 1, end: 1 }],
	});
	await woken.emit({ type: "turn_end", status: "completed" });
	assert.equal(restored.state.status, "waiting");
});

test("when the conversation cannot be restored a fresh tutor gets a recap and the message", async () => {
	const { walkthrough, agent } = await openWalkthrough();
	await agent.call("set_outline", {
		steps: ["One", "Two"],
		current: 2,
		...NAME,
	});
	await agent.call("show_code", {
		path: "a.txt",
		highlights: [{ start: 2, end: 3 }],
	});
	await agent.emit({ type: "text", text: "Look at line two." });
	await agent.call("ask_quiz", { question: "Why?" });
	await agent.emit({ type: "turn_end", status: "completed" });

	const driver = new FakeDriver();
	const restored = Walkthrough.restore(walkthrough.record(), {
		driver,
		scratchDir: "/tmp/scratch",
	});
	restored.input({ type: "message", text: "go on" });
	await tick();
	const stale = driver.sessions[0] as FakeSession;
	await stale.emit({ type: "closed", error: "No conversation found" });
	await tick();

	assert.equal(stale.closed, true);
	const fresh = driver.sessions[1] as FakeSession;
	assert.equal(fresh.options.resumeToken, undefined);
	assert.equal(fresh.received.length, 1);
	const message = fresh.received[0] as string;
	assert.match(
		message,
		/<original_brief>\nExplain a\.txt\nmore detail\n<\/original_brief>/,
	);
	assert.match(message, /2\. Two \(in progress\)/);
	assert.match(message, /code:a\.txt \(a\.txt, highlights 2-3\) \[in front\]/);
	assert.match(message, /Tutor: Look at line two\./);
	assert.match(message, /Tutor asked: Why\? \(skipped\)/);
	assert.match(message, /<quiz_skipped question="Why\?" \/>\ngo on$/);
	assert.ok(restored.state.transcript.some((i) => i.kind === "notice"));
	assert.equal(restored.record().resumeToken, fresh.resumeToken);

	// The fresh tutor failing is an ordinary failure, not another restart.
	await fresh.emit({ type: "turn_end", status: "failed", error: "boom" });
	assert.equal(driver.sessions.length, 2);
	assert.equal(restored.state.status, "waiting");
});

test("an idle tutor is put to sleep and the next message wakes it", async () => {
	const root = mkdtempSync(join(tmpdir(), "pedagogue-idle-test-"));
	const driver = new FakeDriver();
	const walkthrough = await Walkthrough.open({
		id: "t1",
		cwd: root,
		scratchDir: join(root, "scratch"),
		brief: "x",
		driver,
		idleMs: 20,
	});
	const first = driver.sessions[0] as FakeSession;
	await first.emit({ type: "turn_end", status: "completed" });
	assert.equal(walkthrough.awake, true);
	await new Promise((resolve) => setTimeout(resolve, 60));
	assert.equal(walkthrough.awake, false);
	assert.equal(first.closed, true);
	assert.equal(walkthrough.state.status, "waiting");

	walkthrough.input({ type: "message", text: "back" });
	await tick();
	assert.equal(driver.sessions[1]?.options.resumeToken, first.resumeToken);
	assert.deepEqual(driver.sessions[1]?.received, ["back"]);
	walkthrough.close();
});

test("a tutor that cannot start leaves a notice and the walkthrough usable", async () => {
	const { walkthrough } = await openWalkthrough();
	let fail = true;
	const driver = new FakeDriver();
	const flaky = {
		open: async (options: Parameters<FakeDriver["open"]>[0]) => {
			if (fail) throw new Error("spawn failed");
			return driver.open(options);
		},
	};
	const restored = Walkthrough.restore(walkthrough.record(), {
		driver: flaky,
		scratchDir: "/tmp/scratch",
	});
	restored.input({ type: "message", text: "hello" });
	await tick();
	const notice = restored.state.transcript.at(-1);
	assert.match(
		notice?.kind === "notice" ? notice.text : "",
		/could not start: spawn failed/,
	);
	assert.equal(restored.state.status, "waiting");

	fail = false;
	restored.input({ type: "message", text: "hello again" });
	await tick();
	assert.deepEqual(driver.sessions[0]?.received, ["hello again"]);
});

test("every change asks for a save, and closing ends the walkthrough for good", async () => {
	const root = mkdtempSync(join(tmpdir(), "pedagogue-save-test-"));
	const driver = new FakeDriver();
	let saves = 0;
	const walkthrough = await Walkthrough.open({
		id: "t1",
		cwd: root,
		scratchDir: join(root, "scratch"),
		brief: "x",
		driver,
		onChange: () => saves++,
	});
	const before = saves;
	await (driver.sessions[0] as FakeSession).call("set_outline", {
		steps: ["a"],
		...NAME,
	});
	assert.ok(saves > before);
	walkthrough.close();
	const restored = Walkthrough.restore(walkthrough.record(), {
		driver,
		scratchDir: "/tmp/scratch",
	});
	assert.equal(restored.state.status, "closed");
	assert.throws(() => restored.input({ type: "message", text: "hi" }), /ended/);
});
