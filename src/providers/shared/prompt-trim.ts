export const PROMPT_TRIM_MARKER =
	"\n\n[... earlier conversation truncated to fit the provider limit ...]\n\n";

const MAX_HEAD_CHARS = 40_000;

/**
 * Keep the beginning (system/tool instructions) and the most recent part of
 * the prompt, dropping the middle when the provider rejects oversized input.
 */
export function trimPromptToFit(prompt: string, maxChars: number): string {
	if (maxChars <= 0 || prompt.length <= maxChars) return prompt;

	const marker = PROMPT_TRIM_MARKER;
	if (maxChars <= marker.length + 200) {
		return prompt.slice(-maxChars);
	}

	const headChars = Math.min(Math.floor(maxChars / 2), MAX_HEAD_CHARS);
	const tailChars = Math.max(0, maxChars - headChars - marker.length);
	return `${prompt.slice(0, headChars)}${marker}${prompt.slice(-tailChars)}`;
}
