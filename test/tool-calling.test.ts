import { describe, expect, test } from "bun:test";
import type { ChatMessage, ToolDefinition } from "../src/openai/types.ts";
import {
	buildPromptFromMessages,
	parseToolResponse,
	resolveEffectiveTools,
} from "../src/tool-calling/converter.ts";
import { extractBashBlocks, hasBashBlock } from "../src/tool-calling/parser.ts";

const BASH_TOOL: ToolDefinition = {
	type: "function",
	function: {
		name: "bash",
		description: "Run a shell command",
		parameters: {
			type: "object",
			properties: {
				command: { type: "string" },
				description: { type: "string" },
				timeout: { type: "number" },
			},
			required: ["command", "description"],
		},
	},
};

const READ_TOOL: ToolDefinition = {
	type: "function",
	function: {
		name: "read",
		description: "Read a file",
		parameters: {
			type: "object",
			properties: { path: { type: "string" } },
			required: ["path"],
		},
	},
};

function bash(...commands: string[]): string {
	return commands.map((command) => `\`\`\`bash\n${command}\n\`\`\``).join("\n\n");
}

describe("extractBashBlocks", () => {
	test("extracts a single bash block", () => {
		const result = extractBashBlocks(`I will list the files.\n\n${bash("ls -la")}\n\nDone.`);
		expect(result.commands).toEqual(["ls -la"]);
		expect(result.content).toContain("I will list the files.");
		expect(result.content).toContain("Done.");
		expect(result.content).not.toContain("ls -la");
	});

	test("combines multiple bash blocks in order", () => {
		const text = `${bash("echo one")}\nbetween\n${bash("echo two")}\n${bash("echo three")}`;
		const result = extractBashBlocks(text);
		expect(result.commands).toEqual(["echo one", "echo two", "echo three"]);
	});

	test("preserves text surrounding commands", () => {
		const text = `Before the command.\n\n${bash("pwd")}\n\nAfter the command.`;
		const result = extractBashBlocks(text);
		expect(result.content).toBe("Before the command.\n\nAfter the command.");
	});

	test("ignores text-labelled blocks", () => {
		const text = "```text\nls -la\n```";
		const result = extractBashBlocks(text);
		expect(result.commands).toEqual([]);
		expect(result.content).toContain("ls -la");
	});

	test("ignores json-labelled blocks", () => {
		const text = '```json\n{"command":"ls"}\n```';
		const result = extractBashBlocks(text);
		expect(result.commands).toEqual([]);
		expect(result.content).toContain('"command":"ls"');
	});

	test("ignores unlabelled blocks", () => {
		const text = "```\nls -la\n```";
		const result = extractBashBlocks(text);
		expect(result.commands).toEqual([]);
		expect(result.content).toContain("ls -la");
	});

	test("ignores inline code", () => {
		const result = extractBashBlocks("Run `ls -la` to see the files.");
		expect(result.commands).toEqual([]);
		expect(result.content).toBe("Run `ls -la` to see the files.");
	});

	test("ignores empty bash blocks", () => {
		expect(extractBashBlocks("```bash\n\n```").commands).toEqual([]);
	});

	test("supports tilde fences and label case-insensitively", () => {
		expect(extractBashBlocks("~~~BASH\npwd\n~~~").commands).toEqual(["pwd"]);
	});

	test("hasBashBlock reflects extraction", () => {
		expect(hasBashBlock(bash("ls"))).toBe(true);
		expect(hasBashBlock("plain text")).toBe(false);
	});
});

describe("resolveEffectiveTools", () => {
	test("auto and undefined return all tools", () => {
		expect(resolveEffectiveTools([BASH_TOOL, READ_TOOL], "auto").tools).toHaveLength(2);
		expect(resolveEffectiveTools([BASH_TOOL, READ_TOOL], undefined).tools).toHaveLength(2);
	});

	test("none returns no tools", () => {
		const result = resolveEffectiveTools([BASH_TOOL], "none");
		expect(result.tools).toHaveLength(0);
		expect(result.forceUse).toBe(false);
	});

	test("required keeps tools and forces use", () => {
		const result = resolveEffectiveTools([BASH_TOOL], "required");
		expect(result.tools).toHaveLength(1);
		expect(result.forceUse).toBe(true);
	});

	test("specific function filters to that tool", () => {
		const result = resolveEffectiveTools([BASH_TOOL, READ_TOOL], {
			type: "function",
			function: { name: "bash" },
		});
		expect(result.tools.map((t) => t.function.name)).toEqual(["bash"]);
		expect(result.forceUse).toBe(true);
	});
});

describe("buildPromptFromMessages", () => {
	test("describes the bash block convention and not tool_json", () => {
		const messages: ChatMessage[] = [{ role: "user", content: "List files" }];
		const { prompt, hasTools } = buildPromptFromMessages(messages, [BASH_TOOL]);

		expect(hasTools).toBe(true);
		expect(prompt).toContain("```bash");
		expect(prompt).toContain('"bash"');
		expect(prompt).not.toContain("tool_json");
	});

	test("tool_choice none disables tools", () => {
		const messages: ChatMessage[] = [{ role: "user", content: "List files" }];
		const { prompt, hasTools } = buildPromptFromMessages(messages, [BASH_TOOL], "none");
		expect(hasTools).toBe(false);
		expect(prompt).not.toContain("Available tools:");
	});

	test("tool_choice required adds a force hint", () => {
		const messages: ChatMessage[] = [{ role: "user", content: "List files" }];
		const { prompt } = buildPromptFromMessages(messages, [BASH_TOOL], "required");
		expect(prompt).toContain("MUST call the Bash tool");
	});

	test("formats previous bash tool calls as bash blocks", () => {
		const messages: ChatMessage[] = [
			{ role: "user", content: "List files" },
			{
				role: "assistant",
				tool_calls: [
					{
						id: "call_1",
						type: "function",
						function: { name: "bash", arguments: '{"command":"ls","description":"List files"}' },
					},
				],
			},
			{ role: "tool", tool_call_id: "call_1", content: "file1.txt" },
		];
		const { prompt } = buildPromptFromMessages(messages, [BASH_TOOL]);

		expect(prompt).toContain("```bash\nls\n```");
		expect(prompt).toContain("<tool_result");
		expect(prompt).toContain("file1.txt");
		expect(prompt).not.toContain("tool_json");
	});
});

describe("parseToolResponse", () => {
	test("converts a bash block into a native tool call", () => {
		const result = parseToolResponse(bash("ls -la"), [BASH_TOOL]);

		expect(result.finishReason).toBe("tool_calls");
		expect(result.content).toBeNull();
		expect(result.toolCalls).toHaveLength(1);
		expect(result.toolCalls?.[0]?.type).toBe("function");
		expect(result.toolCalls?.[0]?.function.name).toBe("bash");
		expect(result.toolCalls?.[0]?.id).toMatch(/^call_[a-f0-9]+$/);

		const args = JSON.parse(result.toolCalls?.[0]?.function.arguments ?? "{}");
		expect(args.command).toBe("ls -la");
		expect(args.description).toBe("Run: ls -la");
	});

	test("converts multiple bash blocks into ordered tool calls", () => {
		const result = parseToolResponse(bash("echo one", "echo two"), [BASH_TOOL]);

		expect(result.toolCalls).toHaveLength(2);
		expect(result.toolCalls?.map((c) => JSON.parse(c.function.arguments).command)).toEqual([
			"echo one",
			"echo two",
		]);
	});

	test("preserves prose around bash blocks", () => {
		const result = parseToolResponse(
			`I will check the directory now.\n\n${bash("ls")}\n\nThat should show the files.`,
			[BASH_TOOL],
		);

		expect(result.finishReason).toBe("tool_calls");
		expect(result.content).toBe("I will check the directory now.\n\nThat should show the files.");
	});

	test("returns stop when no bash tool was supplied", () => {
		const text = bash("ls");
		const result = parseToolResponse(text, [READ_TOOL]);

		expect(result.finishReason).toBe("stop");
		expect(result.toolCalls).toBeUndefined();
		expect(result.content).toBe(text);
	});

	test("returns stop when tool_choice is none", () => {
		const text = bash("ls");
		const result = parseToolResponse(text, [BASH_TOOL], "none");

		expect(result.finishReason).toBe("stop");
		expect(result.toolCalls).toBeUndefined();
		expect(result.content).toBe(text);
	});

	test("returns stop when tool_choice selects a non-bash tool", () => {
		const text = bash("ls");
		const result = parseToolResponse(text, [BASH_TOOL, READ_TOOL], {
			type: "function",
			function: { name: "read" },
		});

		expect(result.finishReason).toBe("stop");
		expect(result.toolCalls).toBeUndefined();
	});

	test("builds valid arguments from the bash tool schema", () => {
		const tool: ToolDefinition = {
			type: "function",
			function: {
				name: "Bash",
				parameters: {
					type: "object",
					properties: {
						command: { type: "string" },
						description: { type: "string" },
						timeout: { type: "number" },
					},
					required: ["command"],
				},
			},
		};

		const result = parseToolResponse(bash("printf 'hello\\nworld'"), [tool]);
		const args = JSON.parse(result.toolCalls?.[0]?.function.arguments ?? "{}");

		expect(result.toolCalls?.[0]?.function.name).toBe("Bash");
		expect(args).toEqual({
			command: "printf 'hello\\nworld'",
			description: "Run: printf 'hello\\nworld'",
		});
	});

	test("does not re-parse tool results from previous history", () => {
		const messages: ChatMessage[] = [
			{ role: "user", content: "List files" },
			{
				role: "assistant",
				tool_calls: [
					{
						id: "call_1",
						type: "function",
						function: { name: "bash", arguments: '{"command":"ls","description":"List files"}' },
					},
				],
			},
			{ role: "tool", tool_call_id: "call_1", content: "file1.txt" },
		];
		const { prompt } = buildPromptFromMessages(messages, [BASH_TOOL]);

		const result = parseToolResponse("The listing is complete.", [BASH_TOOL]);
		expect(prompt).toContain("```bash\nls\n```");
		expect(result.finishReason).toBe("stop");
		expect(result.toolCalls).toBeUndefined();
	});

	test("returns plain text unchanged when there are no bash blocks", () => {
		const result = parseToolResponse("Nothing to do here.", [BASH_TOOL]);
		expect(result.finishReason).toBe("stop");
		expect(result.content).toBe("Nothing to do here.");
		expect(result.toolCalls).toBeUndefined();
	});
});
