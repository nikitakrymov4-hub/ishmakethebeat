#!/usr/bin/env python3
"""Verify existing broad clips and prepare gated serial MOSS batches; never infer."""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
from fractions import Fraction
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import shutil
import subprocess

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "deliverables/audio-research"
CLIENT = ROOT / "scripts/analyze-local-audio.py"
PLAN = OUT / "album-coverage-plan.json"
PREPARED = OUT / "broad-run-manifest.json"
PROMPT = ROOT / "docs/audio-research/moss-broad-prompt.txt"
PYTHON = "/private/tmp/ish-audio-mlx-venv/bin/python"


def sha(path):
    with Path(path).open("rb") as handle:
        return hashlib.file_digest(handle, "sha256").hexdigest()


def write_new(path, value):
    with path.open("x") as handle:
        handle.write(json.dumps(value, indent=2, ensure_ascii=False) + "\n")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", default="mlx-community/MOSS-Music-8B-Thinking-8bit")
    parser.add_argument("--run-id", default="moss-8bit-attempt1",
                        help="New unique run name; existing manifests and proofs are never overwritten")
    parser.add_argument("--max-tokens", type=int, default=2048)
    args = parser.parse_args()
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,79}", args.run_id):
        parser.error("run-id must be a short lowercase letters/digits/hyphens identifier")
    if args.max_tokens < 1:
        parser.error("max-tokens must be positive")
    spec = importlib.util.spec_from_file_location("local_audio_manifest_registry", CLIENT)
    client = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(client)  # Registry/stdlib only: no model loading or inference.
    if args.model not in client.MODEL_REGISTRY:
        parser.error("model is not registered in analyze-local-audio.py")
    ffmpeg, ffprobe = shutil.which("ffmpeg"), shutil.which("ffprobe")
    if not ffmpeg or not ffprobe:
        parser.error("ffmpeg and ffprobe are required")
    paths = {kind: OUT / f"{args.run_id}-broad-{kind}.json"
             for kind in ("pilot", "remaining", "input-audit")}
    summaries = {kind: OUT / f"{args.run_id}-broad-{kind}-execution.json"
                 for kind in ("pilot", "remaining")}
    for path in [*paths.values(), *summaries.values()]:
        if path.exists():
            parser.error(f"Refusing existing output: {path}; choose a new run-id")
    plan_sha, prepared_sha = sha(PLAN), sha(PREPARED)
    plan, prepared = json.loads(PLAN.read_text()), json.loads(PREPARED.read_text())
    if prepared["planSHA256"] != plan_sha or len(plan["chunks"]) != 38:
        raise ValueError("Unexpected or changed original 38-chunk plan")
    source = plan["source"]
    if source["sha256"] != sha(source["path"]) or source["sha256"] != prepared["source"]["sha256"]:
        raise ValueError("Original album hash does not match its recorded source")
    clips = {item["id"]: item for item in prepared["chunks"]}
    prompt = PROMPT.read_text().strip()
    if not prompt:
        raise ValueError("Broad prompt is empty")
    records, requests, seen_proofs = [], [], set()
    source_rate = source["decodedSampleRate"]
    tolerance = Fraction(1, 16000)
    for chunk in plan["chunks"]:
        known = clips[chunk["id"]]
        for key in ("sourceStartFrame", "sourceEndFrameExclusive", "sourceStartSeconds", "sourceEndSeconds"):
            if known[key] != chunk[key]:
                raise ValueError(f"Prepared clip disagrees with original plan: {chunk['id']} {key}")
        clip = known["clip"]
        path = Path(clip["path"]).resolve(strict=True)
        digest = sha(path)
        if digest != clip["sha256"] or path.stat().st_size != clip["bytes"]:
            raise ValueError(f"Prepared clip changed: {path}")
        probe = json.loads(subprocess.check_output([
            ffprobe, "-v", "error", "-select_streams", "a:0", "-show_entries",
            "stream=sample_rate,channels,codec_name,duration_ts,time_base,bits_per_raw_sample",
            "-of", "json", str(path)
        ]))["streams"][0]
        rate, channels = int(probe["sample_rate"]), int(probe["channels"])
        if rate != 16000 or channels != 2 or probe["codec_name"] != "flac":
            raise ValueError(f"Unexpected prepared clip format: {path}")
        # Actual full decoder output, not the rounded container-duration string.
        command = [ffmpeg, "-v", "error", "-nostdin", "-i", str(path), "-map", "0:a:0",
                   "-f", "s16le", "-c:a", "pcm_s16le", "-"]
        pcm = subprocess.check_output(command)
        if len(pcm) % (channels * 2):
            raise ValueError(f"Incomplete decoded PCM frame: {path}")
        frames = len(pcm) // (channels * 2)
        decoded_duration = Fraction(frames, rate)
        source_duration = Fraction(chunk["sourceEndFrameExclusive"] - chunk["sourceStartFrame"], source_rate)
        delta = decoded_duration - source_duration
        if abs(delta) > tolerance:
            raise ValueError(f"Actual decoded duration outside one 16 kHz sample: {path}, delta={float(delta)}")
        if Fraction(int(probe["duration_ts"])) * Fraction(probe["time_base"]) != decoded_duration:
            raise ValueError(f"Header and actual decoded duration disagree: {path}")
        proof = OUT / "proofs" / f"{chunk['id']}-local-{args.run_id}.json"
        if proof in seen_proofs or proof.exists():
            raise ValueError(f"Proof output exists or repeats: {proof}; use a new run-id")
        seen_proofs.add(proof)
        arguments = ["--audio", str(path), "--source", source["path"],
                     "--source-start", str(chunk["sourceStartSeconds"]),
                     "--source-end", str(chunk["sourceEndSeconds"]),
                     "--prompt-file", str(PROMPT), "--proof", str(proof),
                     "--model", args.model, "--coverage-chunk-id", chunk["id"],
                     "--max-tokens", str(args.max_tokens), "--temperature", "1.0",
                     "--top-p", "1.0", "--top-k", "50", "--min-p", "0.0",
                     "--seed", "20261016", "--max-duration", "120",
                     "--prefill-step-size", "256", "--encoder-batch-size", "2"]
        requests.append({"id": chunk["id"], "arguments": arguments})
        records.append({
            "id": chunk["id"], "sourceStartFrame": chunk["sourceStartFrame"],
            "sourceEndFrameExclusive": chunk["sourceEndFrameExclusive"],
            "sourceSampleRate": source_rate,
            "sourceRangeSeconds": [chunk["sourceStartSeconds"], chunk["sourceEndSeconds"]],
            "overlapWithPreviousSeconds": chunk["overlapWithPreviousSeconds"],
            "file": str(path), "sha256": digest, "bytes": path.stat().st_size,
            "actualDecodedFrames": frames, "sampleRate": rate, "channels": channels,
            "decodedPCMFormat": "signed little-endian 16-bit stereo",
            "decodedPCMSHA256": hashlib.sha256(pcm).hexdigest(),
            "actualDecodedDurationSeconds": float(decoded_duration),
            "sourceDurationSeconds": float(source_duration),
            "durationDifferenceSeconds": float(delta),
            "durationDifferenceWithinOne16kSample": True,
            "probe": probe, "decoderCommand": command,
            "proofPath": str(proof), "status": "prepared_unsubmitted",
        })
        del pcm
    if sha(PLAN) != plan_sha or sha(PREPARED) != prepared_sha:
        raise ValueError("Plan or prepared metadata changed during verification; rerun")
    common = {
        "schemaVersion": 1, "preparedAt": datetime.now(timezone.utc).isoformat(),
        "runId": args.run_id, "status": "prepared_unsubmitted", "serialExecution": True,
        "source": source, "plan": {"path": str(PLAN), "sha256": plan_sha, "unchanged": True},
        "preparedClipsManifest": {"path": str(PREPARED), "sha256": prepared_sha},
        "model": args.model, "registeredModel": client.MODEL_REGISTRY[args.model],
        "client": {"path": str(CLIENT), "sha256AtPreparation": sha(CLIENT)},
        "prompt": {"path": str(PROMPT), "sha256": sha(PROMPT), "text": prompt},
        "inputAudit": str(paths["input-audit"]),
        "authorizationGate": "Prepared only. Parent must first accept the contrast controls, then authorize this one-clip pilot. The remaining batch requires a separate decision after reviewing pilot input coverage, output, and runtime.",
        "caveat": "Prepared clip coverage is not model execution or validated musical coverage. Stereo 16 kHz FLACs are resampled/requantized derivatives; the MOSS client then averages channels. Original stereo MP3 is unchanged. Mono model input cannot establish stereo width or detailed high-frequency texture.",
    }
    audit = {**common, "durationToleranceSeconds": float(tolerance), "verification": {
        "allClipHashesMatch": True, "all38ClipsFullyDecoded": True,
        "allDurationDifferencesWithinTolerance": True,
        "maximumAbsoluteDurationDifferenceSeconds": max(abs(r["durationDifferenceSeconds"]) for r in records),
        "actualDecodedDurationTotalIncludingOverlapSeconds": sum(r["actualDecodedDurationSeconds"] for r in records),
        "plannedUniqueSourceCoverageSeconds": source["decodedDurationSeconds"],
        "successfulAudioExecutions": 0, "validatedUniqueCoverageSeconds": 0,
        "ffmpegVersion": subprocess.check_output([ffmpeg, "-version"], text=True).splitlines()[0],
    }, "clips": records}
    write_new(paths["input-audit"], audit)
    for kind, selected in (("pilot", requests[:1]), ("remaining", requests[1:])):
        manifest = {**common, "batchRole": kind, "requestCount": len(selected), "requests": selected,
                    "executionCommand": [PYTHON, str(CLIENT), "batch", "--manifest", str(paths[kind]),
                                         "--summary", str(summaries[kind])]}
        write_new(paths[kind], manifest)
    print(json.dumps({"preparedManifests": {key: str(value) for key, value in paths.items()},
                      "requests": {"pilot": 1, "remaining": 37},
                      "maximumAbsoluteDurationDifferenceSeconds": audit["verification"]["maximumAbsoluteDurationDifferenceSeconds"],
                      "inferenceSubmitted": False}, indent=2))


if __name__ == "__main__":
    main()
