import hljs from "/vendor/highlight.js";
import { marked } from "/vendor/marked.js";
import DOMPurify from "/vendor/purify.js";
import {
	ago,
	buildLabel,
	clampInputHeight,
	compressLines,
	FAVICON_FRAMES,
	faviconHref,
	languageFor,
	paneForPath,
	parseLineLink,
	splitHighlightedLines,
} from "./lines.js";

const $ = (id) => document.getElementById(id);
const tourId = location.pathname.split("/").pop();

/** Mirror of the daemon's TourState, rebuilt from a snapshot plus events. */
let state;
/** Lines the learner has marked: { paneId, lines: Set<number>, anchor: number }. */
let selection;
let socket;
/** When the tour started, as an ISO time. */
let createdAt;
/** The local day of the last message drawn, so a change of day gets a divider. */
let lastDay;

function connect() {
	const scheme = location.protocol === "https:" ? "wss" : "ws";
	socket = new WebSocket(`${scheme}://${location.host}/tours/${tourId}/ws`);
	socket.addEventListener("message", (message) =>
		apply(JSON.parse(message.data)),
	);
	socket.addEventListener("close", () => {
		if (state?.status === "closed") return;
		setStatus("reconnecting");
		setTimeout(connect, 1000);
	});
}

function send(input) {
	if (socket.readyState !== WebSocket.OPEN) {
		notice("Not connected to the daemon. Trying again shortly.");
		return false;
	}
	socket.send(JSON.stringify(input));
	return true;
}

function apply(event) {
	switch (event.type) {
		case "snapshot":
			state = event.state;
			createdAt = event.createdAt;
			selection = undefined;
			lastDay = undefined;
			document.title = `${state.title} - pedagogue`;
			$("title").textContent = state.title;
			$("title").title = `${state.title}\n${state.cwd}`;
			$("cwd").textContent = state.cwd;
			$("cwd").title = state.cwd;
			$("transcript").replaceChildren();
			for (const pane of [...document.querySelectorAll("#panes > .pane")])
				pane.remove();
			for (const pane of state.panes) renderPane(pane);
			for (const item of state.transcript) renderItem(item);
			renderTabs();
			renderOutline();
			renderSelection();
			setStatus(state.status, state.error);
			setActivity(state.activity);
			renderTimes();
			break;
		case "pane": {
			const index = state.panes.findIndex((p) => p.id === event.pane.id);
			if (index === -1) state.panes.push(event.pane);
			else state.panes[index] = event.pane;
			if (selection?.paneId === event.pane.id) clearSelection();
			renderPane(event.pane);
			renderTabs();
			break;
		}
		case "pane_closed":
			state.panes = state.panes.filter((p) => p.id !== event.id);
			if (state.focus === event.id) state.focus = state.panes.at(-1)?.id;
			if (selection?.paneId === event.id) clearSelection();
			paneElement(event.id)?.remove();
			renderTabs();
			break;
		case "focus":
			state.focus = event.id;
			renderTabs();
			scrollToHighlight(event.id);
			break;
		case "outline":
			state.outline = event.outline;
			state.step = event.step;
			renderOutline();
			break;
		case "item": {
			const index = state.transcript.findIndex((i) => i.id === event.item.id);
			if (index === -1) state.transcript.push(event.item);
			else state.transcript[index] = event.item;
			renderItem(event.item);
			renderTimes();
			break;
		}
		case "item_delta": {
			const item = state.transcript.find((i) => i.id === event.id);
			if (!item) break;
			item.text += event.text;
			renderItem(item);
			break;
		}
		case "activity":
			state.activity = event.label;
			setActivity(event.label);
			break;
		case "status":
			state.status = event.status;
			setStatus(event.status, event.error);
			break;
		case "error":
			notice(event.message);
			break;
	}
}

// Titlebar

const DATE_TIME = new Intl.DateTimeFormat(undefined, {
	dateStyle: "medium",
	timeStyle: "short",
});
const CLOCK = new Intl.DateTimeFormat(undefined, { timeStyle: "short" });
const DAY = new Intl.DateTimeFormat(undefined, {
	weekday: "short",
	month: "short",
	day: "numeric",
	year: "numeric",
});

/** Says when the tour started and how long ago its newest message arrived. */
function renderTimes() {
	if (!state) return;
	const parts = [`started ${DATE_TIME.format(new Date(createdAt))}`];
	const last = state.transcript.findLast((item) => item.at)?.at;
	if (last) parts.push(`last message ${ago(last, Date.now())}`);
	$("times").textContent = parts.join(" \u00b7 ");
	$("times").title = last ? DATE_TIME.format(new Date(last)) : "";
}
setInterval(renderTimes, 30_000);

fetch("/about")
	.then((response) => response.json())
	.then((build) => {
		$("build").textContent = buildLabel(build);
	});

// Status and outline

function setStatus(status, error) {
	const labels = {
		working: "Tutor is working",
		waiting: "Your turn",
		closed: error ? `Ended: ${error}` : "Ended",
		reconnecting: "Reconnecting",
	};
	const element = $("status");
	element.textContent = labels[status];
	element.className = `status ${status}`;
	$("stop").hidden = status !== "working";
	$("working").hidden = status !== "working";
	$("next").disabled = status !== "waiting";
	const closed = status === "closed";
	$("input").disabled = closed;
	$("send").disabled = closed;
	setFavicon(status);
}

let faviconTimer;

/**
 * Shows the status in the tab icon, stepping its frames while the tutor
 * works. Browsers slow timers in a background tab, so the animation runs
 * slower there; a change of status still shows at once.
 */
function setFavicon(status) {
	clearInterval(faviconTimer);
	const show = (frame) => {
		$("favicon").href = faviconHref(status, frame);
	};
	show(0);
	if (status !== "working") return;
	let frame = 0;
	faviconTimer = setInterval(() => {
		frame = (frame + 1) % FAVICON_FRAMES;
		show(frame);
	}, 400);
}

/** Says what the tutor is doing, next to the dots under the conversation. */
function setActivity(label) {
	$("activity").textContent = label
		? `${label}...`
		: "The tutor is working. You can type; it is read after this turn.";
}

/** Runs a change to the conversation and keeps it scrolled to the end if it was there. */
function keepAtEnd(change) {
	const transcript = $("transcript");
	const atEnd =
		transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight <
		80;
	change();
	if (atEnd) transcript.scrollTop = transcript.scrollHeight;
}

function renderOutline() {
	const list = $("outline");
	list.hidden = state.outline.length === 0;
	list.replaceChildren(
		...state.outline.map((title, index) => {
			const item = document.createElement("li");
			item.textContent = title;
			if (state.step !== undefined) {
				if (index === state.step) item.className = "current";
				else if (index < state.step) item.className = "done";
			}
			return item;
		}),
	);
}

// Panes

function paneElement(id) {
	return document.querySelector(`#panes > .pane[data-id="${CSS.escape(id)}"]`);
}

function renderTabs() {
	$("no-panes").hidden = state.panes.length > 0;
	$("tabs").replaceChildren(
		...state.panes.map((pane) => {
			const tab = document.createElement("button");
			tab.type = "button";
			tab.textContent = pane.title;
			tab.setAttribute("aria-selected", String(pane.id === state.focus));
			tab.addEventListener("click", () => {
				state.focus = pane.id;
				renderTabs();
			});
			return tab;
		}),
	);
	for (const element of document.querySelectorAll("#panes > .pane")) {
		element.hidden = element.dataset.id !== state.focus;
	}
}

function renderPane(pane) {
	const element = document.createElement("section");
	element.className = `pane ${pane.kind}`;
	element.dataset.id = pane.id;
	element.hidden = pane.id !== state.focus;
	if (pane.kind === "code") element.append(codeView(pane));
	else if (pane.kind === "markdown") {
		const body = document.createElement("div");
		body.innerHTML = renderMarkdown(pane.markdown);
		element.append(body);
	} else if (pane.kind === "diagram") {
		renderDiagram(pane, element);
	} else {
		const frame = document.createElement("iframe");
		// Scripts run in an opaque origin, and the policy below stops them
		// from loading or contacting anything outside the document itself.
		frame.sandbox = "allow-scripts";
		frame.srcdoc = `<meta http-equiv="Content-Security-Policy" content="default-src 'unsafe-inline' data: blob:">${pane.html}`;
		element.append(frame);
	}
	const existing = paneElement(pane.id);
	if (existing) existing.replaceWith(element);
	else $("panes").append(element);
	if (pane.id === state.focus) scrollToHighlight(pane.id);
}

let mermaidLoading;
let diagramCount = 0;

/** Mermaid is large, so it loads when the first diagram is shown. */
function loadMermaid() {
	mermaidLoading ??= import("/vendor/mermaid/mermaid.esm.min.mjs").then(
		({ default: mermaid }) => {
			const dark = matchMedia("(prefers-color-scheme: dark)").matches;
			mermaid.initialize({
				startOnLoad: false,
				securityLevel: "strict",
				theme: dark ? "dark" : "default",
			});
			return mermaid;
		},
	);
	return mermaidLoading;
}

async function renderDiagram(pane, element) {
	try {
		const mermaid = await loadMermaid();
		const { svg } = await mermaid.render(
			`diagram-${++diagramCount}`,
			pane.mermaid,
		);
		element.innerHTML = svg;
		// Mermaid caps the drawing at its natural width; let it fill the pane.
		element.querySelector("svg")?.style.removeProperty("max-width");
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const box = document.createElement("pre");
		box.className = "error";
		box.textContent = `This diagram could not be drawn. The tutor has been told.\n\n${message}`;
		element.replaceChildren(box);
		send({ type: "pane_error", paneId: pane.id, message });
	}
}

function codeView(pane) {
	const view = document.createElement("div");
	view.className = "code-view";
	const language = languageFor(pane.path);
	const text = pane.text.endsWith("\n") ? pane.text.slice(0, -1) : pane.text;
	const html =
		language && hljs.getLanguage(language)
			? hljs.highlight(text, { language, ignoreIllegals: true }).value
			: escapeHtml(text);
	const highlighted = new Set();
	for (const range of pane.highlights) {
		for (let n = range.start; n <= range.end; n++) highlighted.add(n);
	}
	const noteAfter = pane.note ? pane.highlights[0]?.end : undefined;

	splitHighlightedLines(html).forEach((lineHtml, index) => {
		const number = index + 1;
		const line = document.createElement("div");
		line.className = highlighted.has(number) ? "line highlight" : "line";
		line.dataset.line = String(number);
		const num = document.createElement("span");
		num.className = "num";
		num.textContent = String(number);
		const src = document.createElement("span");
		src.className = "src hljs";
		src.innerHTML = lineHtml || " ";
		line.append(num, src);
		view.append(line);
		if (number === noteAfter) view.append(noteView(pane.note));
	});
	if (pane.note && noteAfter === undefined) view.prepend(noteView(pane.note));

	view.addEventListener("mousedown", (event) => {
		const num = event.target.closest(".num");
		if (!num) return;
		event.preventDefault();
		pickLine(pane.id, Number(num.parentElement.dataset.line), event);
	});
	view.addEventListener("mouseover", (event) => {
		if (
			event.buttons !== 1 ||
			selection?.paneId !== pane.id ||
			!selection.dragging
		)
			return;
		const line = event.target.closest(".line");
		if (line) dragTo(Number(line.dataset.line));
	});
	return view;
}

function noteView(text) {
	const note = document.createElement("div");
	note.className = "note";
	note.textContent = text;
	return note;
}

function scrollToHighlight(paneId) {
	const target = paneElement(paneId)?.querySelector(".line.highlight");
	target?.scrollIntoView({ block: "center" });
}

// Selection: a plain click picks one line and a drag extends it to a range,
// Shift-click extends from the last picked line, Cmd/Ctrl-click toggles single
// lines into a set. All of them produce a set of line numbers.

function pickLine(paneId, line, event) {
	const same = selection?.paneId === paneId;
	if (event.metaKey || event.ctrlKey) {
		const lines = same ? selection.lines : new Set();
		if (lines.has(line)) lines.delete(line);
		else lines.add(line);
		selection = { paneId, lines, anchor: line };
	} else if (event.shiftKey && same) {
		for (const n of span(selection.anchor, line)) selection.lines.add(n);
	} else if (same && selection.lines.size === 1 && selection.lines.has(line)) {
		selection = undefined;
	} else {
		selection = {
			paneId,
			lines: new Set([line]),
			anchor: line,
			dragging: true,
		};
	}
	if (selection?.lines.size === 0) selection = undefined;
	renderSelection();
}

function dragTo(line) {
	selection.lines = new Set(span(selection.anchor, line));
	renderSelection();
}

function span(a, b) {
	const lines = [];
	for (let n = Math.min(a, b); n <= Math.max(a, b); n++) lines.push(n);
	return lines;
}

function clearSelection() {
	selection = undefined;
	renderSelection();
}

function renderSelection() {
	for (const line of document.querySelectorAll(".line.selected")) {
		line.classList.remove("selected");
	}
	const chip = $("selection");
	if (!selection) {
		chip.hidden = true;
		return;
	}
	const pane = paneElement(selection.paneId);
	for (const n of selection.lines) {
		pane?.querySelector(`.line[data-line="${n}"]`)?.classList.add("selected");
	}
	const path = state.panes.find((p) => p.id === selection.paneId)?.path ?? "";
	$("selection-label").textContent =
		`${path}:${compressLines([...selection.lines])}`;
	chip.hidden = false;
}

document.addEventListener("mouseup", () => {
	if (selection) selection.dragging = false;
});
$("selection-clear").addEventListener("click", clearSelection);

// Links. The tutor writes references to code as links such as
// "cmd/hub.go#L12-L20"; clicking one brings those lines to the middle of their
// pane. Other links open in a new tab so the tour stays put.

function jumpToLines({ path, start, end }) {
	const pane = paneForPath(state.panes, path);
	if (!pane) {
		notice(`${path} is not open in a pane. Ask the tutor to show it.`);
		return;
	}
	state.focus = pane.id;
	renderTabs();
	const element = paneElement(pane.id);
	const lines = [];
	for (let n = start; n <= end; n++) {
		const line = element.querySelector(`.line[data-line="${n}"]`);
		if (line) lines.push(line);
	}
	if (lines.length === 0) {
		notice(`${pane.path} has no line ${start}.`);
		return;
	}
	lines[Math.floor((lines.length - 1) / 2)].scrollIntoView({ block: "center" });
	for (const line of lines) {
		line.classList.remove("flash");
		void line.offsetWidth; // restart the animation on a repeated click
		line.classList.add("flash");
	}
}

for (const area of [$("transcript"), $("panes")]) {
	area.addEventListener("click", (event) => {
		const link = event.target.closest("a[href]");
		if (!link) return;
		const href = link.getAttribute("href");
		const target = parseLineLink(href);
		if (target) {
			event.preventDefault();
			jumpToLines(target);
		} else if (/^https?:/i.test(href)) {
			link.target = "_blank";
			link.rel = "noopener";
		} else {
			event.preventDefault();
		}
	});
}

// Transcript

function renderMarkdown(text) {
	return DOMPurify.sanitize(marked.parse(text));
}

function renderItem(item) {
	const element = document.createElement("div");
	element.className = `item ${item.kind}${item.streaming ? " streaming" : ""}`;
	element.dataset.id = item.id;
	if (item.kind === "tutor") {
		element.innerHTML = renderMarkdown(item.text);
	} else if (item.kind === "learner") {
		if (item.selection) {
			const sel = document.createElement("span");
			sel.className = "sel";
			sel.textContent = `${item.selection.path}:${item.selection.ranges
				.map((r) => (r.start === r.end ? r.start : `${r.start}-${r.end}`))
				.join(",")}`;
			element.append(sel);
		}
		element.append(item.text);
	} else if (item.kind === "notice") {
		element.textContent = item.text;
	} else {
		element.append(...quizView(item));
	}
	if (item.at) {
		const when = new Date(item.at);
		const at = document.createElement("time");
		at.className = "at";
		at.dateTime = item.at;
		at.textContent = CLOCK.format(when);
		at.title = DATE_TIME.format(when);
		element.append(at);
	}
	const transcript = $("transcript");
	const existing = transcript.querySelector(`.item[data-id="${item.id}"]`);
	if (!existing && item.at) {
		const day = DAY.format(new Date(item.at));
		if (day !== lastDay) {
			lastDay = day;
			const divider = document.createElement("div");
			divider.className = "day";
			divider.textContent = day;
			keepAtEnd(() => transcript.append(divider));
		}
	}
	if (existing) {
		keepAtEnd(() => existing.replaceWith(element));
	} else if (item.kind === "learner") {
		transcript.append(element);
		transcript.scrollTop = transcript.scrollHeight;
	} else {
		keepAtEnd(() => transcript.append(element));
	}
}

function quizView(quiz) {
	const question = document.createElement("div");
	question.className = "question";
	question.innerHTML = renderMarkdown(quiz.question);
	if (quiz.skipped) {
		const skipped = document.createElement("p");
		skipped.className = "answer";
		skipped.textContent = "Skipped";
		return [question, skipped];
	}
	if (quiz.answer !== undefined) {
		const answer = document.createElement("p");
		answer.className = "answer";
		answer.textContent = `You answered: ${quiz.answer}`;
		return [question, answer];
	}
	const answerWith = (text) => send({ type: "answer", quizId: quiz.id, text });
	if (quiz.choices.length > 0) {
		const choices = document.createElement("div");
		choices.className = "choices";
		for (const choice of quiz.choices) {
			const button = document.createElement("button");
			button.type = "button";
			button.textContent = choice;
			button.className = "choice";
			button.addEventListener("click", () => answerWith(choice));
			choices.append(button);
		}
		return [question, choices];
	}
	const form = document.createElement("form");
	form.className = "free";
	const field = document.createElement("input");
	field.placeholder = "Your answer";
	field.required = true;
	const button = document.createElement("button");
	button.type = "submit";
	button.textContent = "Answer";
	form.append(field, button);
	form.addEventListener("submit", (event) => {
		event.preventDefault();
		answerWith(field.value);
	});
	return [question, form];
}

function notice(text) {
	const element = document.createElement("div");
	element.className = "item notice";
	element.textContent = text;
	$("transcript").append(element);
	element.scrollIntoView({ block: "nearest" });
}

// Composer

$("composer").addEventListener("submit", (event) => {
	event.preventDefault();
	const input = $("input");
	const text = input.value.trim();
	if (!text) return;
	const message = { type: "message", text };
	if (selection) {
		message.selection = {
			paneId: selection.paneId,
			lines: [...selection.lines],
		};
	}
	if (send(message)) {
		input.value = "";
		clearSelection();
	}
});
$("input").addEventListener("keydown", (event) => {
	if (event.metaKey || event.ctrlKey) return;
	if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
		event.preventDefault();
		$("composer").requestSubmit();
	}
});
$("stop").addEventListener("click", () => send({ type: "interrupt" }));

// The handle on the composer's top edge sets the input's height. The browser
// keeps the height, so it applies to every tour until the learner resets it.
const HEIGHT_KEY = "pedagogue.inputHeight";

/** Gives the input the nearest height the side panel allows and returns it. */
function setInputHeight(height) {
	const allowed = clampInputHeight(height, $("side").clientHeight);
	if (allowed !== undefined) $("input").style.height = `${allowed}px`;
	announceInputHeight();
	return allowed;
}
function announceInputHeight() {
	$("resize").setAttribute("aria-valuenow", String($("input").offsetHeight));
}
function saveInputHeight(height) {
	if (height !== undefined) localStorage.setItem(HEIGHT_KEY, String(height));
}
function restoreInputHeight() {
	const saved = localStorage.getItem(HEIGHT_KEY);
	if (saved !== null) setInputHeight(Number(saved));
}
restoreInputHeight();
announceInputHeight();
// A smaller window lowers the limit; a larger one brings the saved height back.
window.addEventListener("resize", restoreInputHeight);

/** The drag under way: where it began ({ y, height }) and the last height it set. */
let drag;
$("resize").addEventListener("pointerdown", (event) => {
	if (event.button !== 0) return;
	event.preventDefault();
	drag = { y: event.clientY, height: $("input").offsetHeight };
	$("resize").setPointerCapture(event.pointerId);
	$("resize").classList.add("dragging");
});
$("resize").addEventListener("pointermove", (event) => {
	if (drag) drag.last = setInputHeight(drag.height + drag.y - event.clientY);
});
function endDrag() {
	if (!drag) return;
	saveInputHeight(drag.last);
	drag = undefined;
	$("resize").classList.remove("dragging");
}
$("resize").addEventListener("pointerup", endDrag);
$("resize").addEventListener("pointercancel", endDrag);
$("resize").addEventListener("dblclick", () => {
	localStorage.removeItem(HEIGHT_KEY);
	$("input").style.height = "";
	announceInputHeight();
});
$("resize").addEventListener("keydown", (event) => {
	const step = { ArrowUp: 16, ArrowDown: -16 }[event.key];
	if (!step) return;
	event.preventDefault();
	saveInputHeight(setInputHeight($("input").offsetHeight + step));
});

// Next is the one-click "that makes sense, go on". It leaves any draft and
// selection in the composer alone.
function next() {
	if ($("next").disabled) return;
	send({ type: "message", text: "next" });
}
$("next").addEventListener("click", next);
document.addEventListener("keydown", (event) => {
	if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
		event.preventDefault();
		next();
	}
});

function escapeHtml(text) {
	return text.replace(
		/[&<>]/g,
		(c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c],
	);
}

connect();
