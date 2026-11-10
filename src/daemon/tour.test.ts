import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { FakeDriver, type FakeSession } from "./fake-driver.ts";
import { InputError, Tour, type TourEvent } from "./tour.ts";

async function openTour(): Promise<{
	tour: Tour;
	agent: FakeSession;
	events: TourEvent[];
	cwd: string;
}> {
	const root = mkdtempSync(join(tmpdir(), "pedagogue-test-"));
	const cwd = join(root, "project");
	mkdirSync(cwd);
	writeFileSync(join(cwd, "a.txt"), "one\ntwo\nthree\nfour\nfive\n");
	writeFileSync(join(root, "secret.txt"), "outside\n");
	symlinkSync(join(root, "secret.txt"), join(cwd, "link.txt"));
	const driver = new FakeDriver();
	const tour = await Tour.open({
		id: "t1",
		cwd,
		scratchDir: join(root, "scratch"),
		brief: "Explain a.txt\nmore detail",
		driver,
	});
	const events: TourEvent[] = [];
	tour.subscribe((event) => events.push(event));
	const agent = driver.sessions[0] as FakeSession;
	return { tour, agent, events, cwd };
}

test("a new tour hands the brief to the tutor and titles itself from its first line", async () => {
	const { tour, agent } = await openTour();
	assert.deepEqual(agent.received, ["Explain a.txt\nmore detail"]);
	assert.equal(tour.state.title, "Explain a.txt");
	assert.equal(tour.state.status, "working");
});

test("a subscriber gets a snapshot first, then events that rebuild the state", async () => {
	const { tour, agent, events } = await openTour();
	assert.equal(events[0]?.type, "snapshot");
	await agent.call("show_code", {
		path: "a.txt",
		highlights: [{ start: 2, end: 3 }],
		note: "look here",
	});
	await agent.emit({ type: "text", text: "Notice line two." });
	await agent.emit({ type: "turn_end", status: "completed" });

	const pane = tour.state.panes[0];
	assert.equal(pane?.kind, "code");
	assert.equal(
		pane?.kind === "code" && pane.text,
		"one\ntwo\nthree\nfour\nfive\n",
	);
	assert.equal(tour.state.focus, "code:a.txt");
	assert.equal(tour.state.status, "waiting");
	assert.deepEqual(
		events.slice(1).map((e) => e.type),
		["pane", "focus", "item", "status"],
	);
});

test("show_code refuses missing files, files outside the directory, and bad ranges", async () => {
	const { agent } = await openTour();
	await assert.rejects(
		agent.call("show_code", { path: "nope.txt" }),
		/no such file: nope.txt/,
	);
	await assert.rejects(
		agent.call("show_code", { path: "../secret.txt" }),
		/outside the tour directory/,
	);
	await assert.rejects(
		agent.call("show_code", { path: "link.txt" }),
		/outside the tour directory/,
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
	const { tour, agent } = await openTour();
	await agent.call("show_code", { path: "a.txt" });
	await agent.emit({ type: "turn_end", status: "completed" });

	tour.input({
		type: "message",
		text: "why these?",
		selection: { paneId: "code:a.txt", lines: [5, 2, 1] },
	});

	assert.equal(
		agent.received.at(-1),
		'<selection path="a.txt" lines="1-2,5">\n1\tone\n2\ttwo\n...\n5\tfive\n</selection>\nwhy these?',
	);
	assert.equal(tour.state.status, "working");
	const item = tour.state.transcript.at(-1);
	assert.deepEqual(item?.kind === "learner" && item.selection, {
		path: "a.txt",
		ranges: [
			{ start: 1, end: 2 },
			{ start: 5, end: 5 },
		],
	});
});

test("a selection outside the file or on a missing pane is rejected", async () => {
	const { tour, agent } = await openTour();
	await agent.call("show_code", { path: "a.txt" });
	assert.throws(
		() =>
			tour.input({
				type: "message",
				text: "?",
				selection: { paneId: "code:a.txt", lines: [6] },
			}),
		InputError,
	);
	assert.throws(
		() =>
			tour.input({
				type: "message",
				text: "?",
				selection: { paneId: "code:b.txt", lines: [1] },
			}),
		InputError,
	);
	assert.equal(agent.received.length, 1);
});

test("a quiz is answered once and the answer goes to the tutor", async () => {
	const { tour, agent } = await openTour();
	await agent.call("ask_quiz", {
		question: "What is 1+1?",
		choices: ["2", "3"],
	});
	const quiz = tour.state.transcript.at(-1);
	assert.equal(quiz?.kind, "quiz");

	tour.input({ type: "answer", quizId: quiz?.id as string, text: "2" });
	assert.equal(
		agent.received.at(-1),
		'<quiz_answer question="What is 1+1?">\n2\n</quiz_answer>',
	);
	const answered = tour.state.transcript.at(-1);
	assert.equal(answered?.kind === "quiz" && answered.answer, "2");
	assert.throws(
		() => tour.input({ type: "answer", quizId: quiz?.id as string, text: "3" }),
		/already answered/,
	);
});

test("set_outline tracks the current step and rejects one past the end", async () => {
	const { tour, agent } = await openTour();
	await agent.call("set_outline", { steps: ["a", "b"], current: 2 });
	assert.deepEqual(tour.state.outline, ["a", "b"]);
	assert.equal(tour.state.step, 1);
	await assert.rejects(
		agent.call("set_outline", { steps: ["a"], current: 2 }),
		/current is 2 but there are 1 steps/,
	);
});

test("closing a pane moves focus to the last remaining pane", async () => {
	const { tour, agent } = await openTour();
	await agent.call("show_markdown", { id: "m", title: "M", markdown: "# hi" });
	await agent.call("show_html", { id: "h", title: "H", html: "<p>hi</p>" });
	await agent.call("close_pane", { id: "html:h" });
	assert.deepEqual(
		tour.state.panes.map((p) => p.id),
		["md:m"],
	);
	assert.equal(tour.state.focus, "md:m");
	await assert.rejects(
		agent.call("close_pane", { id: "html:h" }),
		/no such pane/,
	);
});

test("a failed turn tells the learner and leaves the tour usable", async () => {
	const { tour, agent } = await openTour();
	await agent.emit({
		type: "turn_end",
		status: "failed",
		error: "error_max_turns",
	});
	const item = tour.state.transcript.at(-1);
	assert.match(item?.kind === "notice" ? item.text : "", /error_max_turns/);
	assert.equal(tour.state.status, "waiting");
	tour.input({ type: "message", text: "go on" });
	assert.equal(agent.received.at(-1), "go on");
});

test("interrupt reaches the tutor; a closed tour refuses input", async () => {
	const { tour, agent } = await openTour();
	tour.input({ type: "interrupt" });
	assert.equal(agent.interrupts, 1);
	tour.close();
	assert.equal(agent.closed, true);
	assert.equal(tour.state.status, "closed");
	assert.throws(() => tour.input({ type: "message", text: "hi" }), /ended/);
});

test("a tutor that dies closes the tour with the error", async () => {
	const { tour, agent } = await openTour();
	await agent.emit({ type: "closed", error: "process exited" });
	assert.equal(tour.state.status, "closed");
	assert.equal(tour.state.error, "process exited");
});

test("a diagram that fails to draw is reported to the tutor once per showing", async () => {
	const { tour, agent } = await openTour();
	await agent.call("show_diagram", {
		id: "flow",
		title: "Flow",
		mermaid: "graph TD; A--",
	});
	const pane = tour.state.panes[0];
	assert.deepEqual(pane, {
		id: "diagram:flow",
		kind: "diagram",
		title: "Flow",
		mermaid: "graph TD; A--",
	});
	const before = agent.received.length;

	tour.input({
		type: "pane_error",
		paneId: "diagram:flow",
		message: "Parse error on line 1",
	});
	tour.input({
		type: "pane_error",
		paneId: "diagram:flow",
		message: "Parse error on line 1",
	});
	tour.input({ type: "pane_error", paneId: "diagram:gone", message: "x" });
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
	tour.input({
		type: "pane_error",
		paneId: "diagram:flow",
		message: "still broken",
	});
	assert.equal(agent.received.length, before + 2);
});

test("streamed text grows one transcript item and settles on the final text", async () => {
	const { tour, agent, events } = await openTour();
	await agent.emit({ type: "activity", label: "Reading a.txt" });
	assert.equal(tour.state.activity, "Reading a.txt");

	await agent.emit({ type: "text_delta", id: "m1:0", text: "Line " });
	await agent.emit({ type: "text_delta", id: "m1:0", text: "two" });
	const growing = tour.state.transcript.at(-1);
	assert.deepEqual(growing, {
		id: growing?.id,
		kind: "tutor",
		text: "Line two",
		streaming: true,
	});
	assert.equal(tour.state.activity, "Writing");

	await agent.emit({ type: "text", id: "m1:0", text: "Line two." });
	assert.equal(tour.state.transcript.length, 1);
	assert.deepEqual(tour.state.transcript[0], {
		id: growing?.id,
		kind: "tutor",
		text: "Line two.",
	});
	assert.deepEqual(
		events.slice(1).map((e) => e.type),
		["activity", "activity", "item", "item_delta", "item"],
	);
});

test("a message cut off mid-stream is settled when the turn ends", async () => {
	const { tour, agent } = await openTour();
	await agent.emit({ type: "activity", label: "Thinking" });
	await agent.emit({ type: "text_delta", id: "m1:0", text: "Half a sen" });
	await agent.emit({ type: "turn_end", status: "interrupted" });
	assert.deepEqual(tour.state.transcript.at(-1), {
		id: "t1",
		kind: "tutor",
		text: "Half a sen",
	});
	assert.equal(tour.state.activity, undefined);
	assert.equal(tour.state.status, "waiting");
});

test("a second question is refused while one is open", async () => {
	const { tour, agent } = await openTour();
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
		tour.state.transcript.filter((i) => i.kind === "quiz").length,
		1,
	);

	const quiz = tour.state.transcript[0];
	tour.input({ type: "answer", quizId: quiz?.id as string, text: "yes" });
	await agent.call("ask_quiz", { question: "Second?" });
	assert.equal(
		tour.state.transcript.filter((i) => i.kind === "quiz").length,
		2,
	);
});

test("a message sent instead of an answer skips the open question", async () => {
	const { tour, agent } = await openTour();
	await agent.call("ask_quiz", { question: "Why?" });
	const quiz = tour.state.transcript[0];

	tour.input({ type: "message", text: "next" });
	assert.equal(agent.received.at(-1), '<quiz_skipped question="Why?" />\nnext');
	const skipped = tour.state.transcript[0];
	assert.equal(skipped?.kind === "quiz" && skipped.skipped, true);
	assert.throws(
		() =>
			tour.input({ type: "answer", quizId: quiz?.id as string, text: "late" }),
		/skipped/,
	);
	await agent.call("ask_quiz", { question: "Another?" });
});

async function tick(): Promise<void> {
	await new Promise((resolve) => setImmediate(resolve));
}

test("a restored tour is dormant and wakes its tutor with the saved conversation", async () => {
	const { tour, agent } = await openTour();
	await agent.call("show_code", { path: "a.txt" });
	await agent.emit({ type: "text_delta", id: "m:0", text: "Half" });
	const record = JSON.parse(JSON.stringify(tour.record()));
	assert.equal(record.resumeToken, agent.resumeToken);

	const driver = new FakeDriver();
	const restored = Tour.restore(record, { driver, scratchDir: "/tmp/scratch" });
	assert.equal(restored.awake, false);
	assert.equal(driver.sessions.length, 0);
	assert.equal(restored.state.status, "waiting");
	assert.deepEqual(restored.state.transcript, [
		{ id: "t1", kind: "tutor", text: "Half" },
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
	const { tour, agent } = await openTour();
	await agent.call("set_outline", { steps: ["One", "Two"], current: 2 });
	await agent.call("show_code", {
		path: "a.txt",
		highlights: [{ start: 2, end: 3 }],
	});
	await agent.emit({ type: "text", text: "Look at line two." });
	await agent.call("ask_quiz", { question: "Why?" });
	await agent.emit({ type: "turn_end", status: "completed" });

	const driver = new FakeDriver();
	const restored = Tour.restore(tour.record(), {
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
	const tour = await Tour.open({
		id: "t1",
		cwd: root,
		scratchDir: join(root, "scratch"),
		brief: "x",
		driver,
		idleMs: 20,
	});
	const first = driver.sessions[0] as FakeSession;
	await first.emit({ type: "turn_end", status: "completed" });
	assert.equal(tour.awake, true);
	await new Promise((resolve) => setTimeout(resolve, 60));
	assert.equal(tour.awake, false);
	assert.equal(first.closed, true);
	assert.equal(tour.state.status, "waiting");

	tour.input({ type: "message", text: "back" });
	await tick();
	assert.equal(driver.sessions[1]?.options.resumeToken, first.resumeToken);
	assert.deepEqual(driver.sessions[1]?.received, ["back"]);
	tour.close();
});

test("a tutor that cannot start leaves a notice and the tour usable", async () => {
	const { tour } = await openTour();
	let fail = true;
	const driver = new FakeDriver();
	const flaky = {
		open: async (options: Parameters<FakeDriver["open"]>[0]) => {
			if (fail) throw new Error("spawn failed");
			return driver.open(options);
		},
	};
	const restored = Tour.restore(tour.record(), {
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

test("every change asks for a save, and closing ends the tour for good", async () => {
	const root = mkdtempSync(join(tmpdir(), "pedagogue-save-test-"));
	const driver = new FakeDriver();
	let saves = 0;
	const tour = await Tour.open({
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
	});
	assert.ok(saves > before);
	tour.close();
	const restored = Tour.restore(tour.record(), {
		driver,
		scratchDir: "/tmp/scratch",
	});
	assert.equal(restored.state.status, "closed");
	assert.throws(() => restored.input({ type: "message", text: "hi" }), /ended/);
});
