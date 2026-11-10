export interface LineRange {
	/** 1-based, inclusive. */
	start: number;
	/** 1-based, inclusive. */
	end: number;
}

/** Collapses a set of 1-based line numbers into sorted, non-adjacent ranges. */
export function toRanges(lines: readonly number[]): LineRange[] {
	const sorted = [...new Set(lines)].sort((a, b) => a - b);
	const ranges: LineRange[] = [];
	for (const line of sorted) {
		const last = ranges.at(-1);
		if (last && line === last.end + 1) last.end = line;
		else ranges.push({ start: line, end: line });
	}
	return ranges;
}

/** "3-5,9" for [{3,5},{9,9}]. */
export function formatRanges(ranges: readonly LineRange[]): string {
	return ranges
		.map((r) => (r.start === r.end ? `${r.start}` : `${r.start}-${r.end}`))
		.join(",");
}

/**
 * The text of the given ranges with each line prefixed by its number. Separate
 * ranges are divided by a "..." line so the reader can see the gap.
 */
export function excerpt(text: string, ranges: readonly LineRange[]): string {
	const lines = text.split("\n");
	return ranges
		.map((range) =>
			lines
				.slice(range.start - 1, range.end)
				.map((line, i) => `${range.start + i}\t${line}`)
				.join("\n"),
		)
		.join("\n...\n");
}

export function lineCount(text: string): number {
	if (text === "") return 0;
	const count = text.split("\n").length;
	return text.endsWith("\n") ? count - 1 : count;
}
