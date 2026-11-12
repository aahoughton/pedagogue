import {
	mkdir,
	readdir,
	readFile,
	rename,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import type { WalkthroughRecord } from "./walkthrough.ts";

/** Something that can be saved: a walkthrough, or a stand-in for one in tests. */
export interface Saveable {
	readonly id: string;
	record(): WalkthroughRecord;
}

/**
 * Keeps each walkthrough in `<dataDir>/walkthroughs/<id>/walkthrough.json`. Saves are debounced, so
 * a burst of changes costs one write, and written to a temporary file first, so
 * a crash never leaves a half-written walkthrough.
 */
export class WalkthroughStore {
	readonly #dir: string;
	readonly #delayMs: number;
	readonly #timers = new Map<string, NodeJS.Timeout>();
	readonly #dirty = new Map<string, Saveable>();
	readonly #writes = new Map<string, Promise<void>>();

	constructor(dataDir: string, options: { delayMs?: number } = {}) {
		this.#dir = join(dataDir, "walkthroughs");
		this.#delayMs = options.delayMs ?? 300;
	}

	/**
	 * Moves data saved under the names used before walkthroughs were called
	 * that (`tours/<id>/tour.json`) to the current ones. Call it before
	 * `loadAll`. Returns the directory it moved, or undefined when there was
	 * nothing to move. Refuses to choose when both directories exist.
	 */
	async adoptOldNames(): Promise<string | undefined> {
		const old = join(dirname(this.#dir), "tours");
		if (!(await exists(old))) return undefined;
		if (await exists(this.#dir)) {
			throw new Error(
				`both ${old} and ${this.#dir} exist; move what you want to keep into ${this.#dir} and remove ${old}`,
			);
		}
		for (const id of await readdir(old)) {
			const record = join(old, id, "tour.json");
			if (await exists(record)) {
				await rename(record, join(old, id, "walkthrough.json"));
			}
		}
		await rename(old, this.#dir);
		return old;
	}

	/** Where a walkthrough's tutor may write files. */
	scratchDir(id: string): string {
		return join(this.#dir, id, "scratch");
	}

	/** Saves the walkthrough soon. Calling it again before then does not add a write. */
	schedule(walkthrough: Saveable): void {
		this.#dirty.set(walkthrough.id, walkthrough);
		if (this.#timers.has(walkthrough.id)) return;
		const timer = setTimeout(
			() => void this.#write(walkthrough.id),
			this.#delayMs,
		);
		timer.unref();
		this.#timers.set(walkthrough.id, timer);
	}

	/** Writes everything that is waiting and resolves once it is on disk. */
	async flush(): Promise<void> {
		for (const id of [...this.#dirty.keys()]) void this.#write(id);
		await Promise.all(this.#writes.values());
	}

	/**
	 * Deletes a walkthrough's saved record and its scratch directory. A save that is
	 * waiting is dropped; the caller must not schedule the walkthrough again.
	 */
	async remove(id: string): Promise<void> {
		clearTimeout(this.#timers.get(id));
		this.#timers.delete(id);
		this.#dirty.delete(id);
		await this.#writes.get(id);
		this.#writes.delete(id);
		await rm(join(this.#dir, id), { recursive: true, force: true });
	}

	#write(id: string): Promise<void> {
		clearTimeout(this.#timers.get(id));
		this.#timers.delete(id);
		const walkthrough = this.#dirty.get(id);
		this.#dirty.delete(id);
		if (!walkthrough) return this.#writes.get(id) ?? Promise.resolve();
		const record = walkthrough.record();
		const previous = this.#writes.get(id) ?? Promise.resolve();
		const next = previous.then(async () => {
			const dir = join(this.#dir, id);
			await mkdir(dir, { recursive: true });
			const temporary = join(dir, "walkthrough.json.tmp");
			await writeFile(temporary, JSON.stringify(record));
			await rename(temporary, join(dir, "walkthrough.json"));
		});
		const settled = next.catch((error: unknown) => {
			console.error(
				`pedagogue: could not save walkthrough ${id}: ${message(error)}`,
			);
		});
		this.#writes.set(id, settled);
		return settled;
	}

	/**
	 * Reads every saved walkthrough. A walkthrough that cannot be read is skipped and named in
	 * `problems`; it is left on disk untouched.
	 */
	async loadAll(): Promise<{
		records: WalkthroughRecord[];
		problems: string[];
	}> {
		const records: WalkthroughRecord[] = [];
		const problems: string[] = [];
		const ids = await readdir(this.#dir).catch(() => [] as string[]);
		for (const id of ids) {
			const file = join(this.#dir, id, "walkthrough.json");
			let text: string;
			try {
				text = await readFile(file, "utf8");
			} catch {
				continue; // a scratch directory whose walkthrough was never saved
			}
			try {
				const record = JSON.parse(text) as WalkthroughRecord;
				if (record.version !== 1 || record.state?.id !== id) {
					throw new Error(
						"not a version 1 walkthrough record for this directory",
					);
				}
				records.push(record);
			} catch (error) {
				problems.push(`${file}: ${message(error)}`);
			}
		}
		return { records, problems };
	}
}

async function exists(path: string): Promise<boolean> {
	return (await stat(path).catch(() => undefined)) !== undefined;
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
