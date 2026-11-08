#!/usr/bin/env bash
set -euo pipefail

echo "=== ChatGPT Bridge + OpenCode repair ==="

python3 <<'PY'
import json
import os
import getpass
import shutil
import urllib.request
import urllib.error
from pathlib import Path
from datetime import datetime

home = Path.home()

# Read the gateway API key.
gateway_config = home / ".token-free-gateway" / "config.json"
key = ""

if gateway_config.exists():
    try:
        data = json.loads(gateway_config.read_text())
        key = data.get("apiKey", "")
    except Exception:
        pass

key = key or os.environ.get("TFG_API_KEY", "")

if not key:
    key = getpass.getpass(
        "Enter your existing ChatGPT Bridge API key (input hidden): "
    )

if not key:
    raise SystemExit("No API key supplied. Nothing changed.")

# Store the key privately.
config_dir = Path(
    os.environ.get("XDG_CONFIG_HOME", str(home / ".config"))
) / "opencode"

config_dir.mkdir(parents=True, exist_ok=True)
os.chmod(config_dir, 0o700)

key_file = config_dir / "chatgpt-bridge.key"
key_file.write_text(key.strip() + "\n")
os.chmod(key_file, 0o600)

# Load and preserve the existing OpenCode configuration.
config_file = config_dir / "opencode.json"
config = {}

if config_file.exists():
    try:
        config = json.loads(config_file.read_text())
    except json.JSONDecodeError:
        raise SystemExit(
            f"Cannot read {config_file} as JSON. No changes made."
        )

if not isinstance(config, dict):
    raise SystemExit("Invalid OpenCode configuration.")

# Remove only the earlier ChatGPT Bridge entry from the newer format.
new_providers = config.get("providers")
if isinstance(new_providers, dict):
    new_providers.pop("chatgpt-bridge", None)
    if not new_providers:
        config.pop("providers", None)

providers = config.setdefault("provider", {})

if not isinstance(providers, dict):
    raise SystemExit("The existing provider setting is invalid.")

providers["chatgpt-bridge"] = {
    "npm": "@ai-sdk/openai-compatible",
    "name": "ChatGPT Bridge",
    "options": {
        "baseURL": "http://127.0.0.1:3456/v1",
        "apiKey": "{file:~/.config/opencode/chatgpt-bridge.key}"
    },
    "models": {
        "chatgpt-auto": {
            "name": "ChatGPT Auto"
        },
        "chatgpt-think": {
            "name": "ChatGPT Think"
        }
    }
}

config["$schema"] = "https://opencode.ai/config.json"
config["model"] = "chatgpt-bridge/chatgpt-auto"

# Back up existing config.
if config_file.exists():
    backup = config_file.with_name(
        f"opencode.json.backup-{datetime.now():%Y%m%d-%H%M%S}"
    )
    shutil.copy2(config_file, backup)
    print(f"Backup saved: {backup}")

config_file.write_text(json.dumps(config, indent=2) + "\n")

print(f"OpenCode config updated: {config_file}")
print("API key stored with private file permissions.")

# Test the gateway credentials without displaying the key.
request = urllib.request.Request(
    "http://127.0.0.1:3456/v1/models",
    headers={"Authorization": "Bearer " + key.strip()}
)

try:
    with urllib.request.urlopen(request, timeout=8) as response:
        result = json.loads(response.read())
        print("\nAPI authentication successful!")
        for model in result.get("data", []):
            print("Model:", model.get("id"))
except urllib.error.HTTPError as error:
    raise SystemExit(
        f"Gateway returned HTTP {error.code}. "
        "Check that you entered the correct API key."
    )
except Exception as error:
    raise SystemExit(f"Could not reach the gateway: {error}")
PY

echo ""
echo "Starting OpenCode..."

if command -v opencode >/dev/null 2>&1; then
    exec opencode
else
    echo "OpenCode executable not found in PATH."
    exit 1
fi
