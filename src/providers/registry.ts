import { getCredentials } from "./auth-store.ts";
import type { ModelInfo, ProviderDefinition, WebProviderClient } from "./types.ts";

let definition: ProviderDefinition | null = null;

async function getDefinition(): Promise<ProviderDefinition> {
    if (!definition) {
        definition = (await import("./chatgpt/index.ts")).definition;
    }
    return definition;
}

const clientCache = new Map<string, WebProviderClient>();

export function evictProviderClient(providerId: string): void {
    const client = clientCache.get(providerId);
    if (client) {
        client.close?.().catch(() => {});
        clientCache.delete(providerId);
    }
}

export async function getProviderClient(
    providerId: string,
): Promise<WebProviderClient | null> {
    if (providerId !== "chatgpt-web") return null;
    const cached = clientCache.get(providerId);
    if (cached) return cached;

    const credentials = getCredentials(providerId);
    if (!credentials) return null;

    const def = await getDefinition();
    const client = def.factory(credentials);
    await client.init();
    clientCache.set(providerId, client);
    return client;
}

export async function resolveModelToProvider(model: string): Promise<string | null> {
    const normalized = model.trim().toLowerCase();
    const modelId = normalized.includes("/")
        ? normalized.split("/").pop()!
        : normalized;

    const def = await getDefinition();
    const aliases = [
        "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna",
        "gpt-5", "gpt-4o", "gpt-4"
    ];

    if (
        def.models.some((m) => m.id.toLowerCase() === modelId) ||
        aliases.includes(modelId)
    ) {
        return "chatgpt-web";
    }

    return null;
}

export async function getClientForModel(
    model: string,
): Promise<WebProviderClient | null> {
    const provider = await resolveModelToProvider(model);
    return provider ? getProviderClient(provider) : null;
}

export async function listAllModels(): Promise<ModelInfo[]> {
    const def = await getDefinition();
    return getCredentials("chatgpt-web") ? def.models : [];
}

export async function listProviderDefinitions(): Promise<ProviderDefinition[]> {
    return [await getDefinition()];
}

export function clearProviderCache(providerId: string): void {
    const client = clientCache.get(providerId);
    client?.close?.().catch(() => {});
    clientCache.delete(providerId);
}

export async function checkAllSessions(): Promise<
    Record<string, { valid: boolean; reason?: string }>
> {
    const results: Record<string, { valid: boolean; reason?: string }> = {};

    await Promise.all([...clientCache.entries()].map(async ([id, client]) => {
        if (!client.checkSession) {
            results[id] = { valid: true, reason: "unchecked" };
            return;
        }
        try {
            results[id] = await Promise.race([
                client.checkSession(),
                new Promise<{ valid: false; reason: string }>((resolve) =>
                    setTimeout(
                        () => resolve({ valid: false, reason: "session check timed out" }),
                        10000,
                    )
                ),
            ]);
        } catch (error) {
            results[id] = {
                valid: false,
                reason: error instanceof Error ? error.message : String(error),
            };
        }
    }));

    return results;
}
