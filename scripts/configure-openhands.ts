#!/usr/bin/env bun
/**
 * Configure OpenHands Agent Canvas for free-web-ai.
 *
 * Creates (or reuses) an LLM profile that points the built-in OpenHands agent
 * at the local free-web-ai gateway, then registers the installed OpenCode CLI
 * as an ACP agent profile. OpenHands stays the control plane; OpenCode is
 * available from Settings > Agent whenever its coding workflow is useful.
 *
 * Called by scripts/install-ubuntu.sh with the OpenHands agent-server running.
 */

const OPENHANDS_URL = required("OPENHANDS_URL").replace(/\/+$/, "");
const OPENHANDS_API_KEY = required("OPENHANDS_API_KEY");
const OPENCODE_BIN = required("OPENCODE_BIN");
const GATEWAY_BASE_URL = required("GATEWAY_BASE_URL");
const GATEWAY_API_KEY = required("GATEWAY_API_KEY");
const FORCE = process.env.OPENHANDS_RECONFIGURE === "1";

const LLM_PROFILE = "free-web-ai";
const ACP_PROFILE = "opencode";

type Json = Record<string, unknown>;

function required(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`${name} is required`);
	return value;
}

async function request(method: string, path: string, body?: Json): Promise<Json> {
	const response = await fetch(`${OPENHANDS_URL}${path}`, {
		method,
		headers: {
			"Content-Type": "application/json",
			"X-Session-API-Key": OPENHANDS_API_KEY,
		},
		body: body ? JSON.stringify(body) : undefined,
	});

	const text = await response.text();
	let data: Json = {};
	if (text.trim()) {
		try {
			data = JSON.parse(text) as Json;
		} catch {
			data = { raw: text };
		}
	}
	if (!response.ok) {
		throw new Error(`${method} ${path} failed (${response.status}): ${text}`);
	}
	return data;
}

async function main(): Promise<void> {
	const llmProfiles = await request("GET", "/api/profiles");
	const llmNames = profileNames(llmProfiles, "profiles");
	const llmExists = llmNames.includes(LLM_PROFILE);

	if (!llmExists || FORCE) {
		await request("POST", `/api/profiles/${LLM_PROFILE}`, {
			llm: {
				model: "openai/chatgpt-auto",
				base_url: GATEWAY_BASE_URL,
				api_key: GATEWAY_API_KEY,
			},
			include_secrets: true,
		});
		console.log(`  LLM profile '${LLM_PROFILE}' configured.`);
	} else {
		console.log(`  LLM profile '${LLM_PROFILE}' already exists.`);
	}

	if (llmProfiles.active_profile !== LLM_PROFILE || FORCE) {
		await request("POST", `/api/profiles/${LLM_PROFILE}/activate`);
		console.log(`  LLM profile '${LLM_PROFILE}' activated.`);
	}

	// The first list call seeds OpenHands' default OpenHands agent profile from
	// the active LLM profile. Do this before adding the ACP profile so the
	// default control-plane agent is not skipped.
	const agentProfiles = await request("GET", "/api/agent-profiles");
	const agentNames = profileNames(agentProfiles, "profiles");
	const acpExists = agentNames.includes(ACP_PROFILE);

	if (!acpExists || FORCE) {
		await request("POST", `/api/agent-profiles/${ACP_PROFILE}`, {
			name: ACP_PROFILE,
			agent_kind: "acp",
			acp_server: "opencode",
			acp_command: OPENCODE_BIN,
			acp_args: ["acp"],
			acp_model: null,
		});
		console.log(`  ACP profile '${ACP_PROFILE}' configured.`);
	} else {
		console.log(`  ACP profile '${ACP_PROFILE}' already exists.`);
	}

	const finalProfiles = await request("GET", "/api/agent-profiles");
	console.log(
		`  Agent profiles: ${profileNames(finalProfiles, "profiles").join(", ") || "(none)"}`,
	);
}

function profileNames(payload: Json, key: string): string[] {
	const entries = payload[key];
	if (!Array.isArray(entries)) return [];
	return entries
		.map((entry) =>
			typeof entry === "object" && entry !== null && "name" in entry
				? String((entry as Json).name)
				: "",
		)
		.filter(Boolean);
}

main().catch((error) => {
	console.error(`[openhands] ${error instanceof Error ? error.message : String(error)}`);
	process.exit(1);
});
