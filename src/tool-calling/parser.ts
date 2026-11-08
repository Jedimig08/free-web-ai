/**
 * Extract Bash code blocks from a web model's text response.
 *
 * The model is instructed to emit shell commands inside fenced code blocks
 * labelled `bash`. This parser extracts those commands in order and removes
 * only those blocks, preserving any surrounding prose and any other code
 * blocks (text, json, unlabelled, etc.).
 */

export interface BashExtraction {
	/** Commands extracted from bash-fenced blocks, in document order. */
	commands: string[];
	/** Assistant text with bash-fenced blocks removed. */
	content: string;
}

const BASH_FENCE_REGEX =
	/^[ \t]*(`{3,}|~{3,})[ \t]*bash(?:[ \t][^\r\n]*)?\r?\n([\s\S]*?)^[ \t]*\1[ \t]*$/gim;

function cleanContent(text: string): string {
	return text
		.replace(/[ \t]+\r?\n/g, "\n")
		.replace(/(\r?\n){3,}/g, "\n\n")
		.trim();
}

export function extractBashBlocks(text: string): BashExtraction {
	const commands: string[] = [];

	for (const match of text.matchAll(BASH_FENCE_REGEX)) {
		const command = (match[2] ?? "").trim();
		if (command) commands.push(command);
	}

	const content = cleanContent(text.replace(BASH_FENCE_REGEX, ""));

	return { commands, content };
}

export function hasBashBlock(text: string): boolean {
	return extractBashBlocks(text).commands.length > 0;
}
