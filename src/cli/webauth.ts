import { loadConfig } from "../config.ts";
import { getStorePath, saveCredentials } from "../providers/auth-store.ts";
import { definition } from "../providers/chatgpt/index.ts";

async function isChromeReady(): Promise<boolean> {
    try {
        const response = await fetch(`${loadConfig().cdpUrl}/json/version`);
        return response.ok;
    } catch {
        return false;
    }
}

async function main() {
    console.log("\nChatGPT Bridge — Login\n");

    if (!(await isChromeReady())) {
        console.log("Opening ChatGPT browser...");
        const { startChrome } = await import("./chrome.ts");
        await startChrome();
    }

    console.log("Waiting for ChatGPT login...");

    const credentials = await definition.loginFn({
        onProgress: (message) => console.log(`> ${message}`),
        openUrl: async (url) => {
            console.log(`Opening: ${url}`);
            return true;
        },
    });

    if (!credentials || typeof credentials !== "object") {
        throw new Error("ChatGPT login did not return credentials.");
    }

    console.log("Saving credentials...");
    saveCredentials("chatgpt-web", credentials);
    console.log("\nChatGPT login successful!");
    console.log(`Credentials saved to ${getStorePath()}`);
    console.log("You can now start the gateway.");
    process.exit(0);
}

main().catch((error) => {
    console.error("Login failed:", error);
    process.exitCode = 1;
});
