import type { ProviderDefinition } from "../types.ts";
import { loginCopilotWeb } from "./auth.ts";
import { CopilotWebClient } from "./client.ts";

export const definition: ProviderDefinition = {
	id: "copilot-web",
	name: "Copilot Web",
	// Matches the redesigned Copilot picker on copilot.com
	// (Auto / Quick response / Think deeper).
	models: [
		{ id: "copilot-auto", name: "Copilot Auto" },
		{ id: "copilot-quick", name: "Copilot Quick Response" },
		{ id: "copilot-think-deeper", name: "Copilot Think Deeper" },
	],
	factory: (credentials) => new CopilotWebClient(credentials as any),
	loginFn: loginCopilotWeb,
};
