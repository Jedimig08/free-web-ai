# Implement all-permissions-chatgpt

You are working in the `free-web-ai` repository on the `all-permissions-chatgpt` branch.

Transform the existing ChatGPT-only gateway so ChatGPT can control OpenCode through ordinary Bash code blocks instead of the current simulated JSON tool-calling format.

## Main objective

ChatGPT should generate normal Markdown Bash blocks, for example:

```bash
cd ~/free-web-ai
git status
bun test
```

The gateway must detect these blocks and convert them into genuine OpenAI-compatible tool calls that OpenCode can execute using its existing built-in Bash tool.

## 1. Change the prompt

Inspect `src/tool-calling/prompt.ts`.

Remove the instructions requiring ChatGPT to generate `tool_json` blocks.

Instead, instruct ChatGPT to:
- Use fenced `bash` blocks for commands it wants OpenCode to execute.
- Put sequential commands in the same Bash block.
- Use ordinary prose for explanations.
- Use `text`, `json` or other language labels for examples that must not execute.
- Never generate simulated JSON or XML tool calls.
- Produce no more than one Bash block per response where practical.

## 2. Replace the parser

Inspect `src/tool-calling/parser.ts`.

Implement reliable extraction of fenced Bash blocks.

Requirements:
- Only execute blocks explicitly labelled `bash`.
- Do not execute `text`, `json`, unlabelled blocks or inline code.
- Support multiple Bash blocks without losing their original order. Prefer combining them into one sequential Bash command when appropriate.
- Remove extracted blocks from the assistant's ordinary message content.
- Preserve text before and after the blocks.
- Do not execute anything inside the gateway.

## 3. Convert Bash blocks into real tool calls

Inspect `src/tool-calling/converter.ts`.

Replace the old `tool_json`/XML conversion path with Bash-block conversion.

Important:
- Use the actual `bash` tool definition supplied by OpenCode in the incoming `tools` array.
- Use its exact function name and inspect its parameter schema.
- Populate its command argument correctly.
- Return a valid OpenAI-compatible `tool_calls` response.
- Generate unique tool-call IDs.
- Do not invent tool names or argument schemas.
- Respect `tool_choice`.
- If no suitable Bash tool is supplied, leave the code block as ordinary content instead of generating an invalid tool call.

The Bash block must not remain in the assistant's ordinary content after being converted.

If ordinary explanatory text exists around the Bash block, preserve it.

## 4. Preserve the execution feedback loop

OpenCode must execute the returned tool call using its own built-in Bash tool.

After execution, OpenCode sends the tool result back to the gateway through the normal OpenAI tool-result message protocol.

The gateway must pass the result back to ChatGPT in the next prompt.

ChatGPT should then inspect the output and decide whether to:
- Generate another Bash block.
- Run tests or inspect more files.
- Fix an error.
- Give the user a final answer.

Do not build a separate shell execution engine.

## 5. Update chat completions

Inspect `src/openai/chat-completions.ts`.

Update both non-streaming and streaming response handling.

Requirements:
- Return genuine tool calls for extracted Bash blocks.
- Remove executed Bash blocks from visible assistant content.
- Preserve remaining assistant prose.
- Return the correct `finish_reason`.
- Preserve reasoning/thinking output.
- Support tool-result messages on subsequent requests.
- Avoid duplicate commands.

Keep the existing OpenAI-compatible API.

## 6. Tests

Update existing tests and add tests covering:

- Basic Bash block extraction.
- Multiple Bash blocks and their order.
- Removal of Bash blocks from assistant content.
- Preservation of surrounding prose.
- Non-executable `text`, `json` and unlabelled blocks.
- Correct Bash tool name and argument schema.
- Missing Bash tool definitions.
- `tool_choice: none`.
- Streaming tool-call responses.
- Non-streaming tool-call responses.
- Multiple rounds of tool execution and feedback.
- Normal assistant responses without tool calls.

## 7. Things NOT to build

Do not add:
- A Chrome extension.
- A clipboard watcher.
- A separate relay daemon.
- A second OpenCode server.
- Direct shell execution inside the gateway.
- A replacement for OpenCode's built-in tools.

The existing ChatGPT browser provider and authentication should remain.

## 8. Final verification

Run:

```bash
bun test
bun run typecheck
bun run build
```

Inspect the resulting changes and fix errors.

Do not push or commit automatically. Report the files changed, tests passed and any remaining problems.

Implement the changes, rather than merely describing a plan.

## 9. Installation (Ubuntu/Debian)

The branch ships a one-command installer that sets up Bun, OpenCode V2, Chromium,
the gateway, the OpenCode web UI and, in headless mode, the noVNC login page.
Run it as a normal user with sudo (not as root):

```bash
cd ~/free-web-ai
./scripts/install-ubuntu.sh
```

Common options:

| Option | Meaning |
| --- | --- |
| `--no-login` | Skip the interactive ChatGPT browser login |
| `--no-service` | Do not install or enable systemd user services |
| `--headless` | Force a virtual display and noVNC login page |
| `--frontpage` | Install and start the optional frontpage |
| `--frontpage-port PORT` | Frontpage port (default: `8080`) |

Relevant environment variables: `OPENCODE_WEB_PORT` (default `4096`),
`FREE_WEB_AI_NOVNC_PORT` (default `6080`), `TFG_PORT` (default `3456`) and
`FREE_WEB_AI_FRONTPAGE_PORT` (default `8080`).

After a successful install:

| Service | URL |
| --- | --- |
| OpenCode web UI | `http://<server>:4096` |
| noVNC login page | `http://<server>:6080/vnc.html?autoconnect=1&resize=scale` |
| Gateway API | `http://<server>:3456/v1` |
| Frontpage (optional) | `http://<server>:8080` |

### Optional frontpage

The frontpage is a standalone file in the repository (`frontpage/index.html`),
not embedded in the installer. It links the web UIs running on the machine
(OpenCode, noVNC and the gateway) and shows their reachability. It is installed
only when requested:

```bash
./scripts/install-ubuntu.sh --frontpage

# or opt in via the environment and use a custom port
FREE_WEB_AI_FRONTPAGE=1 ./scripts/install-ubuntu.sh --frontpage-port 8080
```

The installer copies the page to `~/.token-free-gateway/frontpage/` and writes
`frontpage.json` with the actual service ports, so custom ports are reflected
automatically. It is served by the `pi3b-frontpage.service` systemd user unit,
or by a background `python3 -m http.server` when systemd user services are not
available.

Manage it with:

```bash
systemctl --user status pi3b-frontpage.service
systemctl --user restart pi3b-frontpage.service
```
