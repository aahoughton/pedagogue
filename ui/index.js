import { buildLabel } from "./lines.js";

const list = document.getElementById("tours");
const form = document.getElementById("start");
const errorBox = document.getElementById("error");

const STATUS = {
	working: "tutor working",
	waiting: "your turn",
	closed: "ended",
};

const TRASH_ICON =
	'<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 4h11M6 4V2.5h4V4M4 4l.6 9.5h6.8L12 4M6.5 6.5v4.5M9.5 6.5v4.5"/></svg>';

async function deleteTour(tour) {
	if (!confirm(`Delete "${tour.title}"? This cannot be undone.`)) return;
	errorBox.hidden = true;
	const response = await fetch(`/tours/${tour.id}`, { method: "DELETE" });
	if (!response.ok) {
		errorBox.textContent = (await response.json()).error;
		errorBox.hidden = false;
	}
	await refresh();
}

async function refresh() {
	const { tours } = await (await fetch("/tours")).json();
	if (tours.length === 0) {
		const empty = document.createElement("li");
		empty.className = "empty";
		empty.textContent = "No tours yet.";
		list.replaceChildren(empty);
		return;
	}
	list.replaceChildren(
		...tours.map((tour) => {
			const item = document.createElement("li");
			const entry = document.createElement("div");
			entry.className = "entry";
			const link = document.createElement("a");
			link.href = `/tours/${tour.id}`;
			link.textContent = tour.title;
			const meta = document.createElement("div");
			meta.className = "meta";
			const when = new Date(tour.updatedAt).toLocaleString(undefined, {
				dateStyle: "medium",
				timeStyle: "short",
			});
			meta.textContent = `${STATUS[tour.status]} \u00b7 ${when} \u00b7 ${tour.cwd}`;
			entry.append(link, meta);
			const remove = document.createElement("button");
			remove.type = "button";
			remove.className = "delete";
			remove.title = "Delete tour";
			remove.setAttribute("aria-label", `Delete tour: ${tour.title}`);
			remove.innerHTML = TRASH_ICON;
			remove.addEventListener("click", () => deleteTour(tour));
			item.append(entry, remove);
			return item;
		}),
	);
}

form.addEventListener("submit", async (event) => {
	event.preventDefault();
	errorBox.hidden = true;
	const data = new FormData(form);
	const response = await fetch("/tours", {
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
	location.href = `/tours/${body.id}`;
});

fetch("/about")
	.then((response) => response.json())
	.then((build) => {
		document.getElementById("build").textContent = buildLabel(build);
	});
refresh();
