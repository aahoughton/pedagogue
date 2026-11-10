import { buildLabel } from "./lines.js";

const list = document.getElementById("tours");
const form = document.getElementById("start");
const errorBox = document.getElementById("error");

const STATUS = {
	working: "tutor working",
	waiting: "your turn",
	closed: "ended",
};

async function refresh() {
	const { tours } = await (await fetch("/tours")).json();
	if (tours.length === 0) return;
	list.replaceChildren(
		...tours.map((tour) => {
			const item = document.createElement("li");
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
			item.append(link, meta);
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
