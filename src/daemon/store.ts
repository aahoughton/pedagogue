import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TourRecord } from "./tour.ts";

/** Something that can be saved: a tour, or a stand-in for one in tests. */
export interface Saveable {
	readonly id: string;
	record(): TourRecord;
}

/**
 * Keeps each tour in `<dataDir>/tours/<id>/tour.json`. Saves are debounced, so
 * a burst of changes costs one write, and written to a temporary file first, so
 * a crash never leaves a half-written tour.
 */
export class TourStore {
	readonly #dir: string;
	readonly #delayMs: number;
	readonly #timers = new Map<string, NodeJS.Timeout>();
	readonly #dirty = new Map<string, Saveable>();
	readonly #writes = new Map<string, Promise<void>>();

	constructor(dataDir: string, options: { delayMs?: number } = {}) {
		this.#dir = join(dataDir, "tours");
		this.#delayMs = options.delayMs ?? 300;
	}

	/** Where a tour's tutor may write files. */
	scratchDir(id: string): string {
		return join(this.#dir, id, "scratch");
	}

	/** Saves the tour soon. Calling it again before then does not add a write. */
	schedule(tour: Saveable): void {
		this.#dirty.set(tour.id, tour);
		if (this.#timers.has(tour.id)) return;
		const timer = setTimeout(() => void this.#write(tour.id), this.#delayMs);
		timer.unref();
		this.#timers.set(tour.id, timer);
	}

	/** Writes everything that is waiting and resolves once it is on disk. */
	async flush(): Promise<void> {
		for (const id of [...this.#dirty.keys()]) void this.#write(id);
		await Promise.all(this.#writes.values());
	}

	#write(id: string): Promise<void> {
		clearTimeout(this.#timers.get(id));
		this.#timers.delete(id);
		const tour = this.#dirty.get(id);
		this.#dirty.delete(id);
		if (!tour) return this.#writes.get(id) ?? Promise.resolve();
		const record = tour.record();
		const previous = this.#writes.get(id) ?? Promise.resolve();
		const next = previous.then(async () => {
			const dir = join(this.#dir, id);
			await mkdir(dir, { recursive: true });
			const temporary = join(dir, "tour.json.tmp");
			await writeFile(temporary, JSON.stringify(record));
			await rename(temporary, join(dir, "tour.json"));
		});
		const settled = next.catch((error: unknown) => {
			console.error(`pedagogue: could not save tour ${id}: ${message(error)}`);
		});
		this.#writes.set(id, settled);
		return settled;
	}

	/**
	 * Reads every saved tour. A tour that cannot be read is skipped and named in
	 * `problems`; it is left on disk untouched.
	 */
	async loadAll(): Promise<{ records: TourRecord[]; problems: string[] }> {
		const records: TourRecord[] = [];
		const problems: string[] = [];
		const ids = await readdir(this.#dir).catch(() => [] as string[]);
		for (const id of ids) {
			const file = join(this.#dir, id, "tour.json");
			let text: string;
			try {
				text = await readFile(file, "utf8");
			} catch {
				continue; // a scratch directory whose tour was never saved
			}
			try {
				const record = JSON.parse(text) as TourRecord;
				if (record.version !== 1 || record.state?.id !== id) {
					throw new Error("not a version 1 tour record for this directory");
				}
				records.push(record);
			} catch (error) {
				problems.push(`${file}: ${message(error)}`);
			}
		}
		return { records, problems };
	}
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
