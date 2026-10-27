#!/usr/bin/env python3
"""Private research client for NVIDIA's actual music-audio demo. No ML packages.

Uploads audio bytes, submits its server-recognized FileData, and records full
SSE/response evidence. Does not label HTTP success, uploads, or queueing as
successful audio understanding. The demo is a research tool, not an app runtime.
"""
import argparse
import datetime as dt
import hashlib
import json
import mimetypes
import os
from pathlib import Path
import re
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid
import wave

ROOT = Path(__file__).resolve().parents[1]
BASE = "https://nvidia-music-flamingo.hf.space"
MODEL = "nvidia/music-flamingo-2601-hf"
EXPECTED_APP = "43b34a9b5a304788b257ee2c9438ff86f62378b5"
ROUTES = {
    "music-flamingo": {"space": "nvidia/music-flamingo", "host": BASE, "model": MODEL,
                       "revision": EXPECTED_APP, "api": "infer", "cap": 1200},
    "audio-flamingo-next": {"space": "nvidia/audio-flamingo-next",
                       "host": "https://nvidia-audio-flamingo-next.hf.space",
                       "model": "nvidia/audio-flamingo-next-hf",
                       "revision": "608b7f76fd67963ec144e636137d6bf4a18421ed", "api": "infer", "cap": 1800},
    "qwen-captioner": {"space": "Qwen/Qwen3-Omni-Captioner-Demo",
                       "host": "https://qwen-qwen3-omni-captioner-demo.hf.space",
                       "model": "Qwen/Qwen3-Omni-30B-A3B-Captioner",
                       "revision": "dd2e2b8ba617b1046a53f5928cceb59a03863b51", "api": "on_submit", "cap": 30},
}


def now():
    return dt.datetime.now(dt.timezone.utc).isoformat()


def sha(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def save(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(path.suffix + ".tmp")
    temp.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n")
    temp.replace(path)


def audio_info(path, ffprobe):
    try:
        with wave.open(str(path), "rb") as handle:
            return {"duration_seconds": handle.getnframes() / handle.getframerate(),
                    "sample_rate": handle.getframerate(), "channels": handle.getnchannels(),
                    "frames": handle.getnframes(), "sample_width": handle.getsampwidth()}
    except (wave.Error, EOFError):
        result = subprocess.run([ffprobe, "-v", "error", "-show_entries",
                                 "format=duration:stream=sample_rate,channels,codec_name",
                                 "-of", "json", str(path)], check=True, capture_output=True, text=True)
        data = json.loads(result.stdout)
        stream = next((x for x in data["streams"] if "sample_rate" in x), {})
        return {"duration_seconds": float(data["format"]["duration"]), **stream}


def audit_response_timestamps(text, duration):
    """Audit explicit clip-relative times; never pretend to validate the music.

    This catches impossibilities such as a sixty-second event in a thirty-second
    input. A pass means only that recognized timestamps are within bounds.
    """
    mentions = []
    # Bracketed seconds ranges, optionally with s/sec labels: [0.00–9.70].
    range_pattern = r"\[\s*(\d+(?:\.\d+)?)\s*(?:s(?:ec(?:onds?)?)?)?\s*[-–—]\s*(\d+(?:\.\d+)?)\s*(?:s(?:ec(?:onds?)?)?)?\s*\]"
    for match in re.finditer(range_pattern, text, re.IGNORECASE):
        mentions.append({"text": match.group(0), "start_seconds": float(match.group(1)),
                         "end_seconds": float(match.group(2)), "offset": match.start()})
    # mm:ss(.fraction) timestamps. Do not interpret arbitrary prose numbers as time.
    for match in re.finditer(r"(?<![\d:])(\d{1,3}):([0-5]\d(?:\.\d+)?)(?![\d:])", text):
        value = 60 * int(match.group(1)) + float(match.group(2))
        mentions.append({"text": match.group(0), "time_seconds": value, "offset": match.start()})
    for match in re.finditer(r"\b(\d+(?:\.\d+)?)\s*(?:seconds?|secs?)\b", text, re.IGNORECASE):
        mentions.append({"text": match.group(0), "time_seconds": float(match.group(1)), "offset": match.start()})
    out_of_bounds = []
    invalid_order = []
    for mention in mentions:
        values = [v for k, v in mention.items() if k in ("start_seconds", "end_seconds", "time_seconds")]
        if any(value > duration + 0.05 for value in values):
            out_of_bounds.append(mention)
        if mention.get("start_seconds", 0) > mention.get("end_seconds", float("inf")):
            invalid_order.append(mention)
    flagged = bool(out_of_bounds or invalid_order)
    return {"version": 1, "timestamp_basis": "clip-relative", "submitted_duration_seconds": duration,
            "recognized_time_mentions": mentions, "out_of_bounds": out_of_bounds,
            "reversed_ranges": invalid_order,
            "status": "flagged_unreliable_timeline" if flagged else "timestamp_bounds_pass_only",
            "usable_as_confirmed_musical_findings": False,
            "limitation": "Only recognized numeric timestamp bounds were checked. Even a pass does not validate timbre, rhythm, events, vocals, mix or other musical claims. Corroboration is required."}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--audio", type=Path)
    parser.add_argument("--source", type=Path, help="Original unmodified source, required for inference")
    parser.add_argument("--start", type=float, help="Exact clip start in source seconds")
    parser.add_argument("--end", type=float, help="Exact clip end in source seconds")
    parser.add_argument("--prompt-file", type=Path)
    parser.add_argument("--provider", choices=tuple(ROUTES), default="music-flamingo")
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--probe", action="store_true", help="Read-only provider probe; no audio upload")
    parser.add_argument("--ffprobe", default="ffprobe")
    parser.add_argument("--timeout", type=float, default=360, help="SSE job deadline in seconds")
    parser.add_argument("--hf-token-env", help="Optional explicitly selected environment name; never logged")
    parser.add_argument("--expected-app-sha", help="Defaults to the inspected revision for the selected provider")
    parser.add_argument("--preprocessing", help="Optional description of local transforms applied before submission")
    args = parser.parse_args()
    route = ROUTES[args.provider]
    base, model_id, api = route["host"], route["model"], route["api"]
    caption_only = args.provider == "qwen-captioner"
    args.expected_app_sha = args.expected_app_sha or route["revision"]
    args.out = args.out.resolve()
    if args.out.exists():
        parser.error("Output already exists; choose a fresh proof filename to preserve prior evidence")
    if not args.probe and any(x is None for x in (args.audio, args.source, args.start, args.end)):
        parser.error("Inference requires --audio --source --start --end")
    if not args.probe and not caption_only and args.prompt_file is None:
        parser.error("This provider requires --prompt-file")
    if caption_only and args.prompt_file is not None:
        parser.error("Qwen Captioner accepts audio only; omit --prompt-file")
    token = os.environ.get(args.hf_token_env, "") if args.hf_token_env else ""
    if args.hf_token_env and not token:
        parser.error("The selected token environment variable is not configured")
    proof = {"created_at": now(), "provider": "Qwen official Hugging Face Space" if caption_only else "NVIDIA official Hugging Face Space",
             "space": route["space"], "endpoint": base,
             "model": model_id, "status": "preparing", "successful_audio_execution": False,
             "authentication": "explicit environment credential" if token else "anonymous",
             "events": [], "scope": "private noncommercial research only"}

    def redact(value):
        return value.replace(token, "[REDACTED]") if token and isinstance(value, str) else value

    def request(url, data=None, content_type=None, timeout=45):
        headers = {"User-Agent": "ishmakethebeat-audio-research/1.0"}
        # Credentials only go to these two explicitly selected official hosts.
        if token and url.startswith((base + "/", "https://huggingface.co/")):
            headers["Authorization"] = "Bearer " + token
        if content_type:
            headers["Content-Type"] = content_type
        return urllib.request.urlopen(urllib.request.Request(url, data=data, headers=headers), timeout=timeout)

    def get_json(url):
        with request(url) as response:
            return json.load(response)

    def post_json(url, value):
        with request(url, json.dumps(value).encode(), "application/json") as response:
            return json.load(response)

    save(args.out, proof)
    try:
        space = get_json("https://huggingface.co/api/spaces/" + route["space"])
        proof["space_revision"] = space["sha"]
        proof["runtime"] = space.get("runtime")
        if space["sha"] != args.expected_app_sha:
            raise RuntimeError("Public demo revision changed; review its implementation before using --expected-app-sha")
        model = get_json("https://huggingface.co/api/models/" + model_id)
        proof["model_hub_revision_at_request"] = model.get("sha")
        proof["model_revision_caveat"] = ("Public Qwen demo forwards actual uploaded audio to DashScope model alias qwen3-omni-30b-a3b-captioner using its server's credentials. Exact hosted weight revision is not exposed; Hub SHA is reference metadata only."
                                           if caption_only else "Public demo loads MODEL_ID without revision. Hub SHA observed, not attested by running inference server.")
        evidence = ROOT / "private-assets/audio-research/provider-evidence" / space["sha"]
        evidence.mkdir(parents=True, exist_ok=True)
        for filename in ("app.py", "requirements.txt"):
            with request("https://huggingface.co/spaces/" + route["space"] + "/raw/" + space["sha"] + "/" + filename) as response:
                payload = response.read()
            (evidence / filename).write_bytes(payload)
            proof.setdefault("provider_source_sha256", {})[filename] = hashlib.sha256(payload).hexdigest()
        app = (evidence / "app.py").read_text()
        expected_model_text = 'model="qwen3-omni-30b-a3b-captioner"' if caption_only else 'MODEL_ID = "' + model_id + '"'
        if expected_model_text not in app:
            raise RuntimeError("Unexpected model in verified demo source")
        config = get_json(base + "/config")
        prefix = config["api_prefix"]
        info = get_json(base + prefix + "/info")
        if "/" + api not in info.get("named_endpoints", {}):
            raise RuntimeError("Expected inference endpoint absent")
        save(evidence / "space.json", space)
        save(evidence / "api-info.json", info)
        save(evidence / "config.json", config)
        proof["gradio_version"] = config.get("version")
        proof["request_options"] = ({"temperature": 0.6, "top_p": 0.95, "top_k": 20,
                                      "prompt": None, "note": "Official demo defaults; audio-only model does not accept a prompt"}
                                     if caption_only else {"max_new_tokens": 4096, "repetition_penalty": 1.2,
                                    "note": "Fixed by verified server code; other decoding options use server model defaults"})
        proof["preprocessing"] = args.preprocessing or ("Clip supplied as-is. Gradio Audio filepath is passed to DashScope. Exact hosted resampling/downmix is not exposed; preserve original stereo and do not infer width from captions."
                                                       if caption_only else "Clip supplied as-is; provider decodes/downmixes to mono 16 kHz.")
        proof["model_audio_limits"] = ({"client_cap_seconds": 30, "basis": "Official model best-practice recommendation, not a demonstrated server hard limit", "input_count": 1}
                                       if caption_only else {"sample_rate": 16000, "channels": 1,
                                       "window_seconds": 30, "cap_seconds": route["cap"]})
        if args.probe:
            proof["status"] = "provider_probe_complete_no_audio_submitted"
            return 0
        source, clip = args.source.resolve(), args.audio.resolve()
        clip_info = audio_info(clip, args.ffprobe)
        duration = clip_info["duration_seconds"]
        if not 0 < duration <= route["cap"] + 0.001:
            raise ValueError("Clip exceeds positive-duration provider/client limit of " + str(route["cap"]) + " seconds")
        if args.start < 0 or args.end <= args.start or abs(duration - (args.end - args.start)) > 0.15:
            raise ValueError("Source range does not match actual submitted clip duration within0.15seconds")
        proof["source"] = {"filename": source.name, "sha256": sha(source), "bytes": source.stat().st_size,
                           "clip_start_seconds": args.start, "clip_end_seconds": args.end}
        proof["submitted_audio"] = {"filename": clip.name, "sha256": sha(clip), "bytes": clip.stat().st_size, **clip_info}
        prompt = args.prompt_file.read_text() if args.prompt_file else None
        proof["prompt"] = prompt
        proof["status"] = "uploading_actual_audio_bytes"
        save(args.out, proof)
        boundary = "ish-audio-" + uuid.uuid4().hex
        mime = mimetypes.guess_type(clip.name)[0] or "application/octet-stream"
        # Neutral transport filename avoids title/artist cues; original filename is kept only in local proof.
        upload_name = "audio-" + proof["submitted_audio"]["sha256"][:16] + clip.suffix
        head = ('--' + boundary + '\r\nContent-Disposition: form-data; name="files"; filename="' + upload_name +
                '"\r\nContent-Type: ' + mime + '\r\n\r\n').encode()
        payload = head + clip.read_bytes() + ('\r\n--' + boundary + '--\r\n').encode()
        with request(base + prefix + "/upload", payload, "multipart/form-data; boundary=" + boundary, 120) as response:
            upload = json.load(response)
        if not isinstance(upload, list) or len(upload) != 1 or not isinstance(upload[0], str):
            raise RuntimeError("Unexpected upload response: " + repr(upload))
        filedata = {"path": upload[0], "orig_name": upload_name, "mime_type": mime,
                    "meta": {"_type": "gradio.FileData"}}
        proof["uploaded_file"] = filedata
        proof["submitted_request"] = {"data": [filedata, 0.6, 0.95, 20] if caption_only else [filedata, "", prompt]}
        proof["status"] = "uploaded_not_yet_analyzed"
        save(args.out, proof)
        queued = post_json(base + prefix + "/call/" + api, proof["submitted_request"])
        event_id = queued.get("event_id")
        if not isinstance(event_id, str) or not re.fullmatch(r"[a-zA-Z0-9_-]+", event_id):
            raise RuntimeError("Unexpected job response: " + repr(queued))
        proof["event_id"] = event_id
        proof["status"] = "queued"
        save(args.out, proof)
        print(json.dumps({"status": "queued", "proof": str(args.out), "duration_seconds": duration}), flush=True)
        started = time.monotonic()
        event_type, event_data = "message", []
        with request(base + prefix + "/call/" + api + "/" + event_id, timeout=45) as response:
            for raw in response:
                if time.monotonic() - started > args.timeout:
                    raise TimeoutError("Job deadline reached; queue may still be executing, no automatic resubmit")
                line = raw.decode("utf-8").rstrip("\r\n")
                if line.startswith("event:"):
                    event_type = line[6:].strip()
                elif line.startswith("data:"):
                    event_data.append(line[5:].lstrip())
                elif not line and event_data:
                    raw_data = "\n".join(event_data)
                    try:
                        data = json.loads(raw_data)
                    except json.JSONDecodeError:
                        data = raw_data
                    proof["events"].append({"at": now(), "event": event_type, "data": data})
                    event_data = []
                    save(args.out, proof)
                    if event_type == "error":
                        raise RuntimeError("Provider SSE error: " + repr(data))
                    if event_type == "complete":
                        text = data[0] if isinstance(data, list) and data else ""
                        proof["returned_response"] = text
                        if not isinstance(text, str) or not text.strip() or "❌" in text or (not caption_only and not text.startswith("✅ Using audio file")):
                            raise RuntimeError("Provider did not return a successful audio-file analysis: " + str(text))
                        response_body = text.strip() if caption_only else text.split("\n\n", 1)[-1].strip()
                        if len(response_body) < 20:
                            raise RuntimeError("Provider response had no substantive model output")
                        proof["status"] = "completed"
                        proof["successful_audio_execution"] = True
                        proof["content_reliability"] = audit_response_timestamps(response_body, duration)
                        proof["judgment_caveat"] = "Execution proven; musical assertions remain model judgments requiring corroboration. Provider preprocessing is not evidence of preserved stereo width."
                        return 0
        raise RuntimeError("SSE ended without complete/error event; no successful analysis")
    except urllib.error.HTTPError as error:
        proof["status"] = "failed_http"
        proof["error"] = {"type": type(error).__name__, "code": error.code,
                          "message": redact(error.read(16000).decode("utf-8", "replace"))}
        return 2
    except (TimeoutError, socket.timeout) as error:
        proof["status"] = "timed_out"
        proof["error"] = {"type": type(error).__name__, "message": redact(str(error))}
        return 2
    except Exception as error:
        proof["status"] = "failed"
        proof["error"] = {"type": type(error).__name__, "message": redact(str(error))}
        return 2
    finally:
        proof["finished_at"] = now()
        save(args.out, proof)
        print(json.dumps({"status": proof["status"], "successful_audio_execution": proof["successful_audio_execution"],
                          "proof": str(args.out), "error": proof.get("error")}), flush=True)


if __name__ == "__main__":
    sys.exit(main())
