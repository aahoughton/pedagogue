/**
 * An unbounded queue readable as an async iterable by one consumer. Values pushed
 * before the consumer asks are kept in order; `end` finishes the iteration once the
 * queue drains.
 */
export class Channel<T> implements AsyncIterable<T> {
	readonly #queue: T[] = [];
	#waiting: ((result: IteratorResult<T>) => void) | undefined;
	#ended = false;

	push(value: T): void {
		if (this.#ended) return;
		if (this.#waiting) {
			const resolve = this.#waiting;
			this.#waiting = undefined;
			resolve({ value, done: false });
		} else {
			this.#queue.push(value);
		}
	}

	end(): void {
		this.#ended = true;
		if (this.#waiting) {
			const resolve = this.#waiting;
			this.#waiting = undefined;
			resolve({ value: undefined, done: true });
		}
	}

	[Symbol.asyncIterator](): AsyncIterator<T> {
		return {
			next: () => {
				const value = this.#queue.shift();
				if (value !== undefined) {
					return Promise.resolve({ value, done: false });
				}
				if (this.#ended) {
					return Promise.resolve({ value: undefined, done: true });
				}
				return new Promise((resolve) => {
					this.#waiting = resolve;
				});
			},
		};
	}
}
