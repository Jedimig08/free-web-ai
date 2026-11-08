/**
 * Converts between the OpenAI tool protocol and web-model text conventions.
 *
 * Flow:
 * 1. buildPromptFromMessages: converts OpenAI tools + messages into one prompt
 * 2. parseToolResponse: converts Bash code blocks in the response into native
 *    OpenAI tool calls
 * 3. resolveEffectiveTools: enforces tool_choice semantics
 */

import type {
	AssistantMessage,
	ChatMessage,
	ToolCallOutput,
	ToolChoice,
	ToolDefinition,
	ToolMessage,
} from "../openai/types.ts";
import { extractBashBlocks } from "./parser.ts";
import { buildToolPrompt } from "./prompt.ts";

export interface ConvertedPrompt {
	prompt: string;
	/** Whether tools are active after applying tool_choice */
	hasTools: boolean;
}

interface JsonSchema {
	type?: string;
	properties?: Record<string, JsonSchema>;
	required?: string[];
}

function extractTextContent(content: string | { type: string; text?: string }[]): string {
	if (typeof content === "string") return content;
	return content
		.filter((p) => p.type === "text")
		.map((p) => p.text ?? "")
		.join("");
}

function findBashTool(tools: ToolDefinition[]): ToolDefinition | undefined {
	return (
		tools.find((t) => t.function.name.toLowerCase() === "bash") ??
		tools.find((t) => /bash/i.test(t.function.name))
	);
}

function commandFromArguments(raw: string): string {
	try {
		const parsed = JSON.parse(raw) as { command?: unknown };
		if (typeof parsed.command === "string") return parsed.command;
	} catch {
		// Fall through to the raw string.
	}
	return raw;
}

function formatAssistantMsg(msg: AssistantMessage): string | null {
	if (msg.tool_calls && msg.tool_calls.length > 0) {
		const calls = msg.tool_calls.map((tc) => {
			if (tc.function.name.toLowerCase() === "bash") {
				const command = commandFromArguments(tc.function.arguments);
				return ["```bash", command, "```"].join("\n");
			}
			return `[Called ${tc.function.name} with arguments: ${tc.function.arguments}]`;
		});
		const prose = msg.content ? `${msg.content}\n` : "";
		return `Assistant: ${prose}[Called tools]\n${calls.join("\n")}`;
	}
	return msg.content ? `Assistant: ${msg.content}` : null;
}

function formatToolResult(msg: ToolMessage): string {
	return [`<tool_result tool_call_id="${msg.tool_call_id}">`, msg.content, "</tool_result>"].join(
		"\n",
	);
}

function formatMessage(msg: ChatMessage): string | null {
	switch (msg.role) {
		case "system":
		case "developer":
			return `System: ${msg.content}`;

		case "user":
			return `Human: ${extractTextContent(msg.content)}`;

		case "assistant":
			return formatAssistantMsg(msg as AssistantMessage);

		case "tool":
			return formatToolResult(msg as ToolMessage);

		// Legacy OpenAI "function" role → treat same as "tool"
		default: {
			const legacy = msg as any;
			if (legacy.role === "function" && typeof legacy.content === "string") {
				return formatToolResult({
					role: "tool",
					tool_call_id: legacy.name ?? "unknown",
					content: legacy.content,
				});
			}
			return null;
		}
	}
}

/**
 * Resolve effective tools list based on tool_choice.
 *
 * - "none" → no tools (empty list)
 * - "auto" / undefined → all tools
 * - "required" → all tools + force hint
 * - { function: { name } } → single specified tool only
 */
export function resolveEffectiveTools(
	tools: ToolDefinition[] | undefined,
	toolChoice: ToolChoice | undefined,
): { tools: ToolDefinition[]; forceUse: boolean } {
	if (!tools || tools.length === 0) return { tools: [], forceUse: false };

	if (toolChoice === "none") return { tools: [], forceUse: false };

	if (toolChoice === "required") return { tools, forceUse: true };

	if (typeof toolChoice === "object" && toolChoice.type === "function") {
		const target = toolChoice.function.name;
		const filtered = tools.filter((t) => t.function.name === target);
		return { tools: filtered, forceUse: filtered.length > 0 };
	}

	// "auto" or undefined
	return { tools, forceUse: false };
}

/**
 * Build a single prompt string from OpenAI messages + tools for the web model.
 */
export function buildPromptFromMessages(
	messages: ChatMessage[],
	tools?: ToolDefinition[],
	toolChoice?: ToolChoice,
): ConvertedPrompt {
	const effective = resolveEffectiveTools(tools, toolChoice);
	const hasTools = effective.tools.length > 0;
	const parts: string[] = [];

	if (hasTools) {
		parts.push(buildToolPrompt(effective.tools, effective.forceUse));
	}

	for (const msg of messages) {
		const formatted = formatMessage(msg);
		if (formatted) parts.push(formatted);
	}

	// When the last message contains tool results, add a continuation hint
	const lastMsg = messages[messages.length - 1];
	const endsWithToolResult = lastMsg?.role === "tool" || (lastMsg as any)?.role === "function";
	if (endsWithToolResult) {
		parts.push("Please answer the user's question based on the tool results above.");
	}

	return { prompt: parts.join("\n\n"), hasTools };
}

function describeCommand(command: string): string {
	const firstLine =
		command
			.split(/\r?\n/)
			.map((line) => line.trim())
			.find((line) => line.length > 0) ?? "shell command";
	const cleaned = firstLine.replace(/^\$\s*/, "");
	return `Run: ${cleaned}`.slice(0, 100);
}

function defaultValue(schema: JsonSchema | undefined): unknown {
	switch (schema?.type) {
		case "string":
			return "";
		case "number":
		case "integer":
			return 0;
		case "boolean":
			return false;
		case "array":
			return [];
		case "object":
			return {};
		default:
			return null;
	}
}

function buildBashArguments(tool: ToolDefinition, command: string): Record<string, unknown> {
	const schema = (tool.function.parameters ?? {}) as JsonSchema;
	const properties = schema.properties ?? {};
	const required = schema.required ?? [];
	const args: Record<string, unknown> = {};

	args.command = command;

	if (properties.description) {
		args.description = describeCommand(command);
	}

	for (const key of required) {
		if (key in args) continue;
		args[key] = defaultValue(properties[key]);
	}

	return args;
}

/**
 * Convert Bash code blocks in the model's response into native tool calls.
 * If no Bash tool was requested, the response is returned unchanged.
 */
export function parseToolResponse(
	text: string,
	requestedTools?: ToolDefinition[],
	toolChoice?: ToolChoice,
): {
	content: string | null;
	toolCalls: ToolCallOutput[] | undefined;
	finishReason: "stop" | "tool_calls";
} {
	const effective = resolveEffectiveTools(requestedTools, toolChoice);
	const bashTool = findBashTool(effective.tools);

	if (!bashTool) {
		return { content: text, toolCalls: undefined, finishReason: "stop" };
	}

	const { commands, content } = extractBashBlocks(text);
	if (commands.length === 0) {
		return { content: text, toolCalls: undefined, finishReason: "stop" };
	}

	const toolCalls: ToolCallOutput[] = commands.map((command) => ({
		id: `call_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`,
		type: "function" as const,
		function: {
			name: bashTool.function.name,
			arguments: JSON.stringify(buildBashArguments(bashTool, command)),
		},
	}));

	const prose = content.trim();

	return { content: prose ? prose : null, toolCalls, finishReason: "tool_calls" };
}
