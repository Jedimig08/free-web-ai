import { describe, expect, test } from "bun:test";
import { PROMPT_TRIM_MARKER, trimPromptToFit } from "../src/providers/shared/prompt-trim.ts";

describe("trimPromptToFit", () => {
	test("leaves short prompts untouched", () => {
		const prompt = "short prompt";
		expect(trimPromptToFit(prompt, 100)).toBe(prompt);
	});

	test("trims long prompts while preserving head and tail", () => {
		const prompt = `HEAD-${"a".repeat(10_000)}-TAIL`;
		const trimmed = trimPromptToFit(prompt, 1_000);
		expect(trimmed.length).toBeLessThanOrEqual(1_000);
		expect(trimmed.startsWith("HEAD-")).toBe(true);
		expect(trimmed.endsWith("-TAIL")).toBe(true);
		expect(trimmed).toContain(PROMPT_TRIM_MARKER);
	});

	test("handles tiny limits without throwing", () => {
		const trimmed = trimPromptToFit("abcdef", 3);
		expect(trimmed).toBe("def");
	});
});
