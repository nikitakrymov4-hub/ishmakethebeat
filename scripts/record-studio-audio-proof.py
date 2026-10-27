#!/usr/bin/env python3
"""Archive observed AI Studio browser execution. This script never invokes a model.

Requires saved exact response, prompt, UI settings and evidence. Hashes the actual
audio, validates duration against source-frame selection, and refuses overwrites.
The observer's execution assertion is kept distinct from semantic validation.
"""
from __future__ import annotations
import argparse
import datetime as dt
from fractions import Fraction
import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess
import sys


def digest(path):
    h = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def file_record(path, expected=None):
    path = path.resolve(strict=True)
    actual = digest(path)
    if expected is not None and actual != expected.lower():
        raise ValueError("SHA256 mismatch: " + str(path))
    return {"path": str(path), "filename": path.name, "sha256": actual,
            "bytes": path.stat().st_size}


def probe(path, ffprobe):
    return json.loads(subprocess.check_output([
        ffprobe, "-v", "error", "-select_streams", "a:0", "-show_entries",
        "stream=codec_name,sample_rate,channels,bits_per_raw_sample,bits_per_sample,duration_ts,time_base,duration:format=duration",
        "-of", "json", str(path)], text=True))


def decoded_pcm_record(path, channels, ffmpeg="ffmpeg"):
    """Count actual native-rate decoded frames, including compressed-file padding handling."""
    command = [ffmpeg, "-v", "error", "-i", str(path), "-map", "0:a:0",
               "-f", "f32le", "-acodec", "pcm_f32le", "-"]
    total, checksum = 0, hashlib.sha256()
    with subprocess.Popen(command, stdout=subprocess.PIPE) as process:
        for block in iter(lambda: process.stdout.read(1024 * 1024), b""):
            total += len(block)
            checksum.update(block)
        if process.wait() != 0:
            raise ValueError("Audio decode failed: " + str(path))
    frame_bytes = 4 * int(channels)
    if total % frame_bytes:
        raise ValueError("Decoded PCM ends within a sample frame")
    return {"frames": total // frame_bytes, "float32SHA256": checksum.hexdigest(),
            "method": "FFmpeg native-rate native-channel float32 decode, streamed byte count; no resampling or gain"}


def snapshot(file, directory, label):
    source = Path(file["path"])
    target = directory / (label + "-" + source.name)
    data = source.read_bytes()
    if hashlib.sha256(data).hexdigest() != file["sha256"]:
        raise ValueError("Evidence changed during recording: " + str(source))
    with target.open("xb") as handle:
        handle.write(data)
    return {**file, "path": str(target.resolve()), "originalPath": str(source)}


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--source", type=Path, required=True)
    p.add_argument("--source-sha256", required=True)
    p.add_argument("--clip", type=Path, required=True)
    p.add_argument("--clip-sha256", required=True)
    p.add_argument("--source-start-frame", type=int, required=True)
    p.add_argument("--source-end-frame", type=int, required=True, help="Exclusive")
    p.add_argument("--source-sample-rate", type=int, required=True)
    p.add_argument("--source-total-frames", type=int)
    p.add_argument("--source-coordinate-basis", default="Decoded PCM frame zero; source not altered")
    p.add_argument("--input-manifest", type=Path, help="Optional prepared-input provenance JSON")
    p.add_argument("--input-id", help="Exact records[].id in --input-manifest")
    p.add_argument("--prompt", type=Path, required=True)
    p.add_argument("--response", type=Path, required=True)
    p.add_argument("--settings", type=Path, required=True, help="JSON of observed UI values only")
    p.add_argument("--evidence", type=Path, action="append", required=True)
    p.add_argument("--observed-model-label", required=True)
    p.add_argument("--observed-model-id", help="Only if visibly exposed in the UI")
    p.add_argument("--observed-ui-duration", type=float)
    p.add_argument("--observed-audio-tokens", type=int)
    p.add_argument("--execution-status", choices=["response_observed", "error_observed", "incomplete"], required=True)
    p.add_argument("--observed-at", required=True, help="ISO8601 with timezone, from observer; not inferred")
    p.add_argument("--observer-note", required=True, help="How upload and completion were observed; mention chat context")
    p.add_argument("--output", type=Path, required=True)
    p.add_argument("--ffprobe", default=shutil.which("ffprobe") or "ffprobe")
    p.add_argument("--ffmpeg", default=shutil.which("ffmpeg") or "ffmpeg")
    args = p.parse_args()
    try:
        if args.output.exists():
            raise ValueError("Proof already exists; use a new attempt filename")
        observed = dt.datetime.fromisoformat(args.observed_at.replace("Z", "+00:00"))
        if observed.tzinfo is None:
            raise ValueError("--observed-at requires timezone")
        for value in [args.source_sha256, args.clip_sha256]:
            if not re.fullmatch(r"[a-fA-F0-9]{64}", value):
                raise ValueError("Expected a full SHA256")
        if not 0 <= args.source_start_frame < args.source_end_frame or args.source_sample_rate <= 0:
            raise ValueError("Invalid frame range/sample rate")
        if args.source_total_frames is not None and args.source_end_frame > args.source_total_frames:
            raise ValueError("Selection exceeds original source frames")
        source = file_record(args.source, args.source_sha256)
        clip = file_record(args.clip, args.clip_sha256)
        source_data = probe(args.source, args.ffprobe)
        if int(source_data["streams"][0]["sample_rate"]) != args.source_sample_rate:
            raise ValueError("Source sample rate differs from frame-coordinate rate")
        source_duration = float(source_data["format"]["duration"])
        if args.source_end_frame / args.source_sample_rate > source_duration + 1 / args.source_sample_rate:
            raise ValueError("Selection exceeds probed source duration")
        source["probe"] = source_data
        data = probe(args.clip, args.ffprobe)
        stream = data["streams"][0]
        clip_rate = int(stream["sample_rate"])
        decoded = decoded_pcm_record(args.clip, stream["channels"], args.ffmpeg)
        duration = Fraction(decoded["frames"], clip_rate)
        expected = Fraction(args.source_end_frame - args.source_start_frame, args.source_sample_rate)
        tolerance = Fraction(1, clip_rate) + Fraction(1, args.source_sample_rate)
        if abs(duration - expected) > tolerance:
            raise ValueError(f"Clip duration {float(duration)} differs from selected source range {float(expected)}")
        if args.observed_ui_duration is not None and abs(args.observed_ui_duration - float(duration)) > 1.01:
            raise ValueError("Visible UI duration differs by more than rounded-second tolerance")
        prompt = args.prompt.read_text(encoding="utf-8")
        response = args.response.read_text(encoding="utf-8")
        settings = json.loads(args.settings.read_text(encoding="utf-8"))
        if not prompt.strip() or not response.strip() or not isinstance(settings, dict):
            raise ValueError("Prompt/response must be nonempty and settings must be an object")
        evidence = [file_record(path) for path in args.evidence]
        provenance = None
        if bool(args.input_manifest) != bool(args.input_id):
            raise ValueError("Use --input-manifest and --input-id together")
        if args.input_manifest:
            candidates = [row for row in json.loads(args.input_manifest.read_text())["records"]
                          if row["id"] == args.input_id]
            prepared_hash = (candidates[0].get("audioSHA256") or
                             candidates[0].get("preferredUpload", {}).get("sha256")) if len(candidates) == 1 else None
            if prepared_hash != clip["sha256"]:
                raise ValueError("Prepared input ID or audio hash mismatch")
            provenance = {"manifest": file_record(args.input_manifest), "record": candidates[0]}
        clip.update({"probe": data, "durationSeconds": float(duration),
                     "decodedFramesAtClipRate": decoded["frames"], "decodedPCM": decoded,
                     "sampleRate": clip_rate, "channels": stream["channels"]})
        record = {
            "schemaVersion": 1, "recordedAt": dt.datetime.now(dt.timezone.utc).isoformat(),
            "observedAt": args.observed_at, "provider": "Google AI Studio",
            "route": "interactive_browser_file_upload", "scriptInvokedModel": False,
            "model": {"observedUILabel": args.observed_model_label,
                      "observedUIIdentifier": args.observed_model_id,
                      "backendVersion": None, "backendVersionExposed": False},
            "source": source, "clip": clip,
            "sourceRange": {"startFrame": args.source_start_frame,
                            "endFrameExclusive": args.source_end_frame,
                            "sampleRate": args.source_sample_rate,
                            "startSeconds": args.source_start_frame / args.source_sample_rate,
                            "endSeconds": args.source_end_frame / args.source_sample_rate,
                            "timestampBasis": args.source_coordinate_basis},
            "inputProvenance": provenance,
            "submittedDurationSeconds": float(duration),
            "observedUIDurationSeconds": args.observed_ui_duration,
            "observedUIAudioTokens": args.observed_audio_tokens,
            "request": {"prompt": prompt, "promptFile": file_record(args.prompt),
                        "observedUISettings": settings, "settingsFile": file_record(args.settings)},
            "response": {"text": response, "file": file_record(args.response)},
            "evidence": evidence, "executionStatus": args.execution_status,
            "executionBasis": args.observer_note,
            "semanticValidation": {"status": "unreviewed", "validatedClaims": []},
            "limitations": ["This recorder archives browser evidence; it neither uploads audio nor performs inference.",
                "Hashes bind supplied local files; browser upload identity depends on the saved UI evidence and observer record.",
                "A returned response does not validate its musical claims or prove complete attention to every moment.",
                "Model identifier is a visible UI label, not a hidden backend version or pinned checkpoint.",
                "Google documents combining audio channels; no stereo-width findings are validated here."],
        }
        # Exclusive creation is intentional: never silently rewrite an earlier attempt.
        args.output.parent.mkdir(parents=True, exist_ok=True)
        bundle = args.output.parent / (args.output.stem + ".evidence")
        bundle.mkdir(exist_ok=False)
        record["request"]["promptFile"] = snapshot(record["request"]["promptFile"], bundle, "prompt")
        record["request"]["settingsFile"] = snapshot(record["request"]["settingsFile"], bundle, "settings")
        record["response"]["file"] = snapshot(record["response"]["file"], bundle, "response")
        record["evidence"] = [snapshot(file, bundle, f"evidence-{index:02d}")
                              for index, file in enumerate(record["evidence"], 1)]
        if record["inputProvenance"]:
            record["inputProvenance"]["manifest"] = snapshot(record["inputProvenance"]["manifest"], bundle, "input-manifest")
        record["evidencePreservation"] = "Exclusive per-attempt evidence snapshots; originalPath records acquisition location. Source audio remains hash-bound in its original location."
        with args.output.open("x", encoding="utf-8") as handle:
            json.dump(record, handle, indent=2, ensure_ascii=False)
            handle.write("\n")
        print(json.dumps({"proof": str(args.output.resolve()), "sha256": digest(args.output),
                          "executionStatus": args.execution_status, "semanticValidation": "unreviewed",
                          "durationSeconds": float(duration)}))
    except (ValueError, OSError, subprocess.CalledProcessError, KeyError, IndexError) as exc:
        p.exit(1, f"Cannot record proof: {exc}\n")


if __name__ == "__main__":
    main()
