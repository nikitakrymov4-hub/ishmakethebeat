#!/usr/bin/env python3
"""Send actual audio bytes to Gemini; retain an auditable, credential-free proof.

Python standard library + curl + ffprobe. No SDK or app runtime dependency.
Credentials: GEMINI_API_KEY or GOOGLE_API_KEY in this process's environment.
See docs/audio-research/SETUP.md. Does not infer success from HTTP 200 alone.
"""
import argparse
import base64
import datetime
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/interactions"
DEFAULT_PROMPT = """Analyze the actual attached music audio, not its filename. Do not identify an artist or transcribe lyrics. Give clip-relative timestamps for concrete events heard in the first, middle and final thirds. Describe melodic timbre/register/envelope and role interaction; drum attacks, spacing, rolls and gaps; bass articulation and interaction with kick/melody; foreground/background and dry/ambient balance; arrangement changes; and distinguish lead vocals from embedded tags, sampled vox and ad-libs. Say explicitly when an event/category is absent or uncertain. Separate direct audible observations from plausible interpretations and proposed production choices. Do not guess exact plugins, presets or sample identities. Audio may be downmixed by the provider: do not claim stereo pan/width precision. End with two specific events that distinguish this clip and important uncertainties. Avoid generic genre advice."""


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("audio", type=Path)
    parser.add_argument("--proof", type=Path, required=True)
    parser.add_argument("--source", type=Path)
    parser.add_argument("--source-start", type=float, default=0)
    parser.add_argument("--model", default="gemini-3.8-flash")
    parser.add_argument("--prompt-file", type=Path)
    parser.add_argument("--max-output-tokens", type=int, default=4096)
    parser.add_argument("--timeout", type=int, default=240)
    parser.add_argument("--key-file", type=Path, default=Path.home() / ".config/ishmakethebeat/gemini-api-key")
    parser.add_argument("--prepare-only", action="store_true", help="Validate actual-audio request without reading credentials or using the network")
    args = parser.parse_args()
    if args.proof.exists():
        parser.error("Proof already exists; choose a fresh filename to preserve evidence")
    clip = args.audio.resolve()
    source = (args.source or clip).resolve()
    raw = clip.read_bytes()
    duration = float(subprocess.check_output(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", str(clip)], text=True).strip())
    mime = {".wav": "audio/wav", ".mp3": "audio/mp3", ".flac": "audio/flac", ".m4a": "audio/mp4", ".ogg": "audio/ogg"}.get(clip.suffix.lower())
    if not mime:
        parser.error("Unsupported audio extension")
    prompt = args.prompt_file.read_text() if args.prompt_file else DEFAULT_PROMPT
    payload = {"model": args.model, "input": [{"type": "text", "text": prompt}, {"type": "audio", "data": base64.b64encode(raw).decode(), "mime_type": mime}], "store": False, "generation_config": {"temperature": 0.2, "max_output_tokens": args.max_output_tokens}}
    encoded = json.dumps(payload).encode()
    record = {"provider": "Google Gemini API", "endpoint": ENDPOINT, "requestedModel": args.model, "modelVersion": None, "atUTC": datetime.datetime.now(datetime.timezone.utc).isoformat(), "sourceFilename": source.name, "sourceSHA256": hashlib.file_digest(source.open("rb"), "sha256").hexdigest(), "sourceRangeSeconds": [args.source_start, args.source_start + duration], "clipFilename": clip.name, "clipSHA256": hashlib.sha256(raw).hexdigest(), "submittedDurationSeconds": None, "preparedDurationSeconds": duration, "audioByteCount": len(raw), "payloadByteCount": len(encoded), "requestOptions": {k: v for k, v in payload.items() if k != "input"}, "prompt": prompt, "audioTransport": "inline base64 audio bytes", "preprocessingCaveat": "Stereo original retained; Gemini documentation says multichannel input combined to single channel. No stereo-width conclusions from provider alone.", "status": "prepared", "response": None}
    args.proof.parent.mkdir(parents=True, exist_ok=True)
    def save():
        args.proof.write_text(json.dumps(record, indent=2) + "\n")
    if args.prepare_only:
        record.update(status="prepared_not_submitted", submittedDurationSeconds=None, credentialsRead=False, networkUsed=False)
        if len(encoded) >= 20_000_000:
            record.update(status="blocked", error="Inline request exceeds documented20MB limit. Prepare a shorter clip.")
        save()
        print(json.dumps({"proof": str(args.proof), "status": record["status"], "durationSeconds": duration, "payloadByteCount": len(encoded), "networkUsed": False}))
        return 0 if record["status"] == "prepared_not_submitted" else 2
    key = os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY")
    if not key and args.key_file.is_file():
        key = args.key_file.read_text().strip()
    if key and any(c in key for c in "\r\n"):
        parser.error("Invalid credential format; key must be a single line")
    if len(encoded) >= 20_000_000:
        record.update(status="blocked", error="Inline request exceeds documented 20 MB limit. Prepare a shorter clip.")
    elif not key:
        record.update(status="blocked", error="No GEMINI_API_KEY, GOOGLE_API_KEY or local key file is configured. No request sent.")
    else:
        # Keep key out of argv, output and saved proof. Private temporary header
        # file is deleted even on request errors; curl uses system trust roots.
        with tempfile.TemporaryDirectory(prefix="ish-audio-request-") as tmp:
            headers = Path(tmp) / "headers"
            headers.write_text("Content-Type: application/json\nx-goog-api-key: " + key + "\n")
            headers.chmod(0o600)
            response = Path(tmp) / "response.json"
            try:
                record["status"] = "submitted"
                record["submittedDurationSeconds"] = duration
                save()
                result = subprocess.run(["curl", "--silent", "--show-error", "--max-time", str(args.timeout), "--request", "POST", ENDPOINT, "--header", "@" + str(headers), "--data-binary", "@-", "--output", str(response), "--write-out", "%{http_code}"], input=encoded, capture_output=True)
                record["httpStatus"] = result.stdout.decode().strip()
                body = response.read_text() if response.exists() else ""
                body = body.replace(key, "[REDACTED]")
                try:
                    record["response"] = json.loads(body)
                except json.JSONDecodeError:
                    record["response"] = body
                record["transportExitCode"] = result.returncode
                record["transportError"] = result.stderr.decode().replace(key, "[REDACTED]")
                data = record["response"] if isinstance(record["response"], dict) else {}
                texts = [x.get("text", "") for x in data.get("outputs", []) if x.get("type") == "text"]
                text = data.get("output_text") or "\n".join(texts)
                record["responseText"] = text
                record["modelVersion"] = data.get("model_version") or data.get("model")
                record["status"] = "success" if result.returncode == 0 and record["httpStatus"].startswith("2") and text and data.get("status") == "completed" else "failed"
                record["judgmentCaveat"] = "Execution success is not proof of perceptual accuracy or complete attention; corroborate specific claims across clips."
            except Exception as exc:
                record.update(status="failed", error=str(exc).replace(key, "[REDACTED]"))
    save()
    print(json.dumps({"proof": str(args.proof), "status": record["status"], "httpStatus": record.get("httpStatus"), "error": record.get("error")}))
    return 0 if record["status"] == "success" else 2


if __name__ == "__main__":
    sys.exit(main())
