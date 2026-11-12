import { basename } from "node:path";

/**
 * A few words for the learner about what a tutor's tool call is doing, such as
 * "Reading hub.go". `toolPrefix` marks the walkthrough's own display tools.
 */
export function activityLabel(
	toolName: string,
	input: Record<string, unknown>,
	toolPrefix: string,
): string {
	const text = (key: string): string | undefined => {
		const value = input[key];
		return typeof value === "string" && value ? value : undefined;
	};
	if (toolName.startsWith(toolPrefix)) {
		return toolName === `${toolPrefix}ask_quiz`
			? "Writing a question"
			: "Updating the display";
	}
	const file = text("file_path");
	switch (toolName) {
		case "Read":
			return file ? `Reading ${basename(file)}` : "Reading";
		case "Grep": {
			const pattern = text("pattern");
			return pattern ? `Searching for ${clip(pattern)}` : "Searching";
		}
		case "Glob": {
			const pattern = text("pattern");
			return pattern ? `Looking for ${clip(pattern)}` : "Looking for files";
		}
		case "Write":
		case "Edit":
			return file ? `Writing ${basename(file)}` : "Writing";
		default:
			return "Working";
	}
}

function clip(text: string): string {
	return text.length > 40 ? `${text.slice(0, 37)}...` : text;
}
