#!/bin/bash
set -e

PROFILE=/config/free-web-ai-profile
LOG=/config/chromium.log

mkdir -p "$PROFILE"
chown abc:abc "$PROFILE" 2>/dev/null || true

# Force remote debugging on in the persistent profile before the desktop
# starts. If this pref is false, Chromium ignores --remote-debugging-port.
python3 - "$PROFILE" <<'PY'
import json
import os
import sys

profile = sys.argv[1]
path = os.path.join(profile, "Local State")
data = {}
if os.path.exists(path):
    try:
        with open(path) as f:
            data = json.load(f)
    except Exception:
        data = {}
data.setdefault("devtools", {}).setdefault("remote_debugging", {})["allowed"] = True
with open(path, "w") as f:
    json.dump(data, f)
PY

chown abc:abc "$PROFILE/Local State" 2>/dev/null || true

# Clear locks from a previous container run. The upstream wrapper only clears
# the default profile, so the custom profile's locks can survive and make the
# next launch use a different profile.
rm -f "$PROFILE"/Singleton*

# Keep the browser log readable by the desktop user.
touch "$LOG" 2>/dev/null || true
chown abc:abc "$LOG" 2>/dev/null || true
