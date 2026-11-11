/**
 * Dynamic tool prompt generation from OpenAI function definitions.
 *
 * The web model cannot emit native OpenAI tool calls, so we teach it a
 * convention instead: write a fenced code block labelled `bash` containing the
 * shell command to run. The gateway converts those blocks into native tool
 * calls before returning them to the client.
 */

import type { ToolDefinition } from "../openai/types.ts";

function toolDefsForPrompt(tools: ToolDefinition[]): string {
	return JSON.stringify(
		tools.map((t) => ({
			name: t.function.name,
			description: t.function.description || "",
			parameters: t.function.parameters || {},
		})),
		null,
		2,
	);
}

function findBashTool(tools: ToolDefinition[]): ToolDefinition | undefined {
	return (
		tools.find((t) => t.function.name.toLowerCase() === "bash") ??
		tools.find((t) => /bash/i.test(t.function.name))
	);
}

function bashToolDefinitionForPrompt(tools: ToolDefinition[]): string {
	const bash = findBashTool(tools);
	if (!bash) return "";
	return JSON.stringify(
		{
			name: bash.function.name,
			description: bash.function.description || "",
			parameters: bash.function.parameters || {},
		},
		null,
		2,
	);
}

const BASH_EXAMPLE = [
	"For example, to list the files in the current directory:",
	"",
	"```bash",
	"ls -la",
	"```",
].join("\n");

const ANTI_HALLUCINATION_RULES = [
	"- Never describe, simulate or invent command output.",
	"- Never claim a command was run unless you wrote a bash block for it.",
	"- If you need a fact about the machine, reply with the bash block and nothing else.",
	"- The tools run on the user's real machine, not inside a sandbox or container.",
];

export function buildToolPrompt(tools: ToolDefinition[], forceUse = false): string {
	const defs = toolDefsForPrompt(tools);
	const bashDef = bashToolDefinitionForPrompt(tools);

	const forceHint = forceUse
		? bashDef
			? "\n\nIMPORTANT: You MUST call the Bash tool in this response. Do NOT answer with plain text."
			: "\n\nIMPORTANT: You MUST use one of the tools above. Do NOT answer with plain text."
		: "";

	const lines = ["You have access to the following tools.", ""];

	if (bashDef) {
		lines.push(
			"To call the Bash tool, reply with a fenced code block labelled bash. Put the exact shell command inside the block. You may write normal prose before or after the block. Use one bash block per command.",
			"",
			BASH_EXAMPLE,
			"",
			"Rules:",
			"- The opening fence must be followed by the label `bash` (for example, ```bash).",
			"- Put only the command inside the block. Do not include command output.",
			"- If no tool is needed, answer normally without a bash block.",
			...ANTI_HALLUCINATION_RULES,
			"",
			"Bash tool definition:",
			bashDef,
			"",
		);
	}

	lines.push("All available tools:", defs);

	return `${lines.join("\n")}${forceHint}\n\n`;
}
