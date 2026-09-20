import type { ProviderDefinition } from "../types.ts";
import type { DeepSeekWebCredentials } from "./auth.ts";
import { loginDeepseekWeb } from "./auth.ts";
import { DeepSeekWebClient } from "./client.ts";

export const definition: ProviderDefinition = {
	id: "deepseek-web",
	name: "DeepSeek Web",
	// DeepSeek collapsed its chat/reasoner models into a single model whose
	// reasoning is a collapsible (hideable) thinking span, so the provider now
	// exposes a single model id. Legacy `deepseek-chat` / `deepseek-reasoner`
	// ids still resolve to this provider (see registry legacy aliases).
	models: [{ id: "deepseek", name: "DeepSeek" }],
	factory: (credentials) => new DeepSeekWebClient(credentials as DeepSeekWebCredentials),
	loginFn: loginDeepseekWeb,
};
