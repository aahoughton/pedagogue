import { ago, buildLabel } from "./lines.js";

const list = document.getElementById("walkthroughs");
const form = document.getElementById("start");
const errorBox = document.getElementById("error");

const STATUS = {
	working: "tutor working",
	waiting: "your turn",
	closed: "ended",
};

const DATE_TIME = new Intl.DateTimeFormat(undefined, {
	dateStyle: "medium",
	timeStyle: "short",
});

const TRASH_ICON =
	'<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 4h11M6 4V2.5h4V4M4 4l.6 9.5h6.8L12 4M6.5 6.5v4.5M9.5 6.5v4.5"/></svg>';

async function deleteWalkthrough(walkthrough) {
	if (!confirm(`Delete "${walkthrough.title}"? This cannot be undone.`)) return;
	errorBox.hidden = true;
	const response = await fetch(`/walkthroughs/${walkthrough.id}`, {
		method: "DELETE",
	});
	if (!response.ok) {
		errorBox.textContent = (await response.json()).error;
		errorBox.hidden = false;
	}
	await refresh();
}

async function refresh() {
	const { walkthroughs } = await (await fetch("/walkthroughs")).json();
	if (walkthroughs.length === 0) {
		const empty = document.createElement("li");
		empty.className = "empty";
		empty.textContent = "No walkthroughs yet.";
		list.replaceChildren(empty);
		return;
	}
	list.replaceChildren(
		...walkthroughs.map((walkthrough) => {
			const item = document.createElement("li");
			const entry = document.createElement("div");
			entry.className = "entry";
			const link = document.createElement("a");
			link.href = `/walkthroughs/${walkthrough.id}`;
			link.textContent = walkthrough.title;
			link.title = walkthrough.summary;
			const meta = document.createElement("div");
			meta.className = "meta";
			const parts = [
				STATUS[walkthrough.status],
				`started ${DATE_TIME.format(new Date(walkthrough.createdAt))}`,
			];
			if (walkthrough.lastMessageAt) {
				parts.push(
					`last message ${ago(walkthrough.lastMessageAt, Date.now())}`,
				);
				meta.title = `Last message ${DATE_TIME.format(new Date(walkthrough.lastMessageAt))}`;
			}
			meta.textContent = parts.join(" \u00b7 ");
			const cwd = document.createElement("div");
			cwd.className = "meta";
			cwd.textContent = walkthrough.cwd;
			entry.append(link, meta, cwd);
			const remove = document.createElement("button");
			remove.type = "button";
			remove.className = "delete";
			remove.title = "Delete walkthrough";
			remove.setAttribute(
				"aria-label",
				`Delete walkthrough: ${walkthrough.title}`,
			);
			remove.innerHTML = TRASH_ICON;
			remove.addEventListener("click", () => deleteWalkthrough(walkthrough));
			item.append(entry, remove);
			return item;
		}),
	);
}

form.addEventListener("submit", async (event) => {
	event.preventDefault();
	errorBox.hidden = true;
	const data = new FormData(form);
	const response = await fetch("/walkthroughs", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ cwd: data.get("cwd"), brief: data.get("brief") }),
	});
	const body = await response.json();
	if (!response.ok) {
		errorBox.textContent = body.error;
		errorBox.hidden = false;
		return;
	}
	location.href = `/walkthroughs/${body.id}`;
});

fetch("/about")
	.then((response) => response.json())
	.then((build) => {
		document.getElementById("build").textContent = buildLabel(build);
	});
refresh();
