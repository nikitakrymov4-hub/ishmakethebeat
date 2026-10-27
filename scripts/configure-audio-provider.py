#!/usr/bin/env python3
"""Run yourself in Terminal: privately store an existing Gemini API credential.

No account creation, billing setup, network call or key-value output.
The file lives outside the Vite web root and is readable only by your user.
"""
import getpass
import os
from pathlib import Path

path = Path.home() / ".config/ishmakethebeat/gemini-api-key"
if path.exists():
    raise SystemExit(f"A credential file already exists at {path}; leaving it unchanged.")
key = getpass.getpass("Existing Gemini API key (hidden; never paste it in chat): ").strip()
if not key or any(c in key for c in "\r\n"):
    raise SystemExit("No valid single-line key supplied; nothing saved.")
path.parent.mkdir(parents=True, exist_ok=True)
path.parent.chmod(0o700)
fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(fd, "w") as handle:
    handle.write(key + "\n")
print(f"Credential saved privately to {path}. No audio request has been sent.")
