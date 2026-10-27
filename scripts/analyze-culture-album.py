#!/usr/bin/env python3
"""Bounded, resumable broad-pass audio submission; never certifies musical claims.

Reads the immutable38-chunk coverage plan. Converts only selected chunks to
16 kHz stereo16-bit FLAC, preserving the source. Default work limit is1 chunk.
--prepare-only performs no network or credential lookup. Actual submission uses
analyze-gemini-audio.py; a validated reference/control pair is required first.
"""
from __future__ import annotations

import argparse
import base64
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "deliverables/audio-research"
PRIVATE = ROOT / "private-assets/audio-research/broad"
PROMPT = """Analyze this attached audio as a broad chronological survey only. Audio was converted to16 kHz stereo16-bit for efficient transport; the provider may combine channels. Do not make stereo-width or fine high-frequency mix claims. Do not identify an artist, transcribe lyrics, or guess exact presets/plugins. Describe the main musical textures and rhythm, important entrances/dropouts/returns/transitions, and whether voices are a continuous lead or brief embedded punctuation. Give approximate clip-relative times within the supplied duration for concrete changes; say when the texture is steady or a detail is uncertain. Separate observations from tentative interpretations. Identify promising short passages for detailed follow-up and potential tag/vox events without treating them all as the same event type. This is a survey, not a full production diagnosis. Keep the answer within900 words."""


def now():
    return dt.datetime.now(dt.timezone.utc).isoformat()


def digest(path):
    h = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def save(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n")
    temporary.replace(path)


def union_duration(ranges):
    last, total = 0.0, 0.0
    for start, end in sorted(ranges):
        total += max(0, end - max(last, start))
        last = max(last, end)
    return total


def prepare(source, chunk, ffmpeg, ffprobe):
    PRIVATE.mkdir(parents=True, exist_ok=True)
    target = PRIVATE / (chunk["id"] + "-16k-stereo-s16.flac")
    meta_path = target.with_suffix(".json")
    if target.exists():
        if not meta_path.exists():
            raise RuntimeError("Existing clip lacks metadata; inspect it before moving/removing it: " + str(target))
        meta = json.loads(meta_path.read_text())
        if (meta["sha256"] != digest(target) or meta["sourceSHA256"] != source["sha256"]
                or meta["sourceStartFrame"] != chunk["sourceStartFrame"]
                or meta["sourceEndFrameExclusive"] != chunk["sourceEndFrameExclusive"]):
            raise RuntimeError("Existing clip metadata/hash mismatch: " + str(target))
        return meta
    temporary = target.with_name(target.stem + ".preparing.flac")
    filters = (f"atrim=start_sample={chunk['sourceStartFrame']}:end_sample={chunk['sourceEndFrameExclusive']},"
               "asetpts=PTS-STARTPTS,aresample=16000")
    # Decode from source frame0, then exact sample trim. Avoid MP3 seek ambiguity.
    command = [ffmpeg, "-v", "error", "-nostdin", "-y", "-i", source["path"], "-map", "0:a:0",
               "-af", filters, "-ac", "2", "-ar", "16000", "-sample_fmt", "s16",
               "-c:a", "flac", "-compression_level", "5", str(temporary)]
    subprocess.run(command, check=True, capture_output=True)
    data = json.loads(subprocess.check_output([ffprobe, "-v", "error", "-show_entries",
                     "format=duration,size:stream=codec_name,sample_rate,channels,bits_per_raw_sample,duration_ts,time_base",
                     "-of", "json", str(temporary)], text=True))
    stream = data["streams"][0]
    duration = float(data["format"]["duration"])
    if (int(stream["sample_rate"]) != 16000 or stream["channels"] != 2
            or int(stream["bits_per_raw_sample"]) != 16
            or abs(duration - chunk["plannedDurationSeconds"]) > 1 / 16000 + 0.000001):
        raise RuntimeError("Converted clip shape/duration mismatch: " + repr(data))
    # Measure encoded size instead of merely assuming compressibility. PCM worst
    # case is7.68MB for120s, ~10.24MB base64, with ample20MB request headroom.
    raw = temporary.read_bytes()
    estimated_request = len(base64.b64encode(raw)) + len(PROMPT.encode()) + 100_000
    if estimated_request >= 20_000_000:
        raise RuntimeError("Converted clip is too large for an inline request")
    temporary.replace(target)
    meta = {"path": str(target), "sha256": digest(target), "bytes": len(raw),
            "sourceSHA256": source["sha256"], "sourceStartFrame": chunk["sourceStartFrame"],
            "sourceEndFrameExclusive": chunk["sourceEndFrameExclusive"],
            "sourceSampleRate": source["decodedSampleRate"],
            "sourceRangeSeconds": [chunk["sourceStartSeconds"], chunk["sourceEndSeconds"]],
            "durationSeconds": duration, "sampleRate": 16000, "channels": 2, "pcmBits": 16,
            "codec": "flac", "probe": data, "estimatedInlineRequestBytesWithMargin": estimated_request,
            "conversionCommand": command[:-1] + [str(target)], "preparedAt": now(),
            "caveat": "Broad context only. Lossless FLAC of a resampled/requantized signal, not the native source. Both channels retained; provider may downmix. Native detailed30s WAVs and full stereo source unchanged."}
    save(meta_path, meta)
    return meta


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-id", required=True, help="Stable run ID for resume; a new ID is required to retry failed requests")
    parser.add_argument("--plan", type=Path, default=OUT / "album-coverage-plan.json")
    parser.add_argument("--manifest", type=Path, default=OUT / "broad-run-manifest.json")
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--limit", type=int, default=1, help="Maximum new chunks this invocation; default1")
    group.add_argument("--all", action="store_true", help="Explicitly process all remaining planned chunks")
    parser.add_argument("--prepare-only", action="store_true", help="Local clips/manifest only; no network")
    parser.add_argument("--controls-reviewed", action="store_true", help="Assert reference and known-control responses were inspected and usable")
    parser.add_argument("--model", default="gemini-3.8-flash")
    parser.add_argument("--ffmpeg", default=shutil.which("ffmpeg") or "ffmpeg")
    parser.add_argument("--ffprobe", default=shutil.which("ffprobe") or "ffprobe")
    args = parser.parse_args()
    if not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}", args.run_id):
        parser.error("Use a short run ID containing letters, digits, underscore or hyphen")
    if args.limit < 1:
        parser.error("--limit must be positive")
    if not args.prepare_only and (sys.version_info < (3, 11) or not args.controls_reviewed):
        parser.error("Submission requires Python3.11+ and --controls-reviewed after successful inspected reference/control tests")
    plan = json.loads(args.plan.read_text())
    source = plan["source"]
    if digest(Path(source["path"])) != source["sha256"]:
        parser.error("Original source SHA differs from the coverage plan")
    plan_hash = digest(args.plan)
    if args.manifest.exists():
        manifest = json.loads(args.manifest.read_text())
        if manifest["planSHA256"] != plan_hash:
            parser.error("Plan changed; retain the existing manifest and inspect before proceeding")
    else:
        manifest = {"schemaVersion": 1, "createdAt": now(), "planPath": str(args.plan.resolve()),
                    "planSHA256": plan_hash, "source": source, "chunks": [
                        {**{k: c[k] for k in ["id", "sourceStartFrame", "sourceEndFrameExclusive",
                                             "sourceStartSeconds", "sourceEndSeconds", "overlapWithPreviousSeconds"]},
                         "clip": None, "attempts": [], "status": "unprepared"} for c in plan["chunks"]],
                    "caveat": "Execution coverage and prepared clips are not validated musical findings.",
                    "validatedUniqueCoverageSeconds": 0}
    prepared_count = submitted_count = 0
    limit = len(plan["chunks"]) if args.all else args.limit

    def checkpoint():
        successful = [c for c in manifest["chunks"] if any(a.get("status") == "success" for a in c["attempts"])]
        manifest["executionSuccessfulUniqueCoverageSeconds"] = union_duration(
            [(c["sourceStartSeconds"], c["sourceEndSeconds"]) for c in successful])
        manifest["executionSuccessfulChunks"] = len(successful)
        manifest["preparedChunks"] = sum(bool(c["clip"]) for c in manifest["chunks"])
        manifest["updatedAt"] = now()
        save(args.manifest, manifest)

    checkpoint()
    try:
        for chunk, record in zip(plan["chunks"], manifest["chunks"]):
            if any(a.get("status") == "success" for a in record["attempts"]):
                continue
            # Preparation can continue independently of failed inference.
            if args.prepare_only and record["clip"]:
                continue
            prior = next((a for a in record["attempts"] if a["runId"] == args.run_id), None)
            if prior and not args.prepare_only:
                proof_path = Path(prior["proofPath"])
                if proof_path.exists():
                    proof = json.loads(proof_path.read_text())
                    if (proof.get("sourceSHA256") != source["sha256"] or not record["clip"]
                            or proof.get("clipSHA256") != record["clip"]["sha256"]):
                        raise RuntimeError("Existing proof source/clip mismatch; inspect it manually")
                    prior["status"] = proof.get("status", "unknown")
                    prior["submittedDurationSeconds"] = proof.get("submittedDurationSeconds")
                    prior["modelVersion"] = proof.get("modelVersion")
                    record["status"] = "execution_success_unvalidated" if prior["status"] == "success" else "stopped_on_existing_failure_or_unknown"
                    checkpoint()
                    if prior["status"] == "success":
                        continue
                raise RuntimeError("Existing attempt is failed/incomplete. No automatic resubmit; inspect its proof and choose a new --run-id for an explicit retry")
            record["clip"] = prepare(source, chunk, args.ffmpeg, args.ffprobe)
            record["status"] = "prepared_unsubmitted"
            prepared_count += 1
            checkpoint()
            print(json.dumps({"chunk": chunk["id"], "status": record["status"], "bytes": record["clip"]["bytes"]}), flush=True)
            if not args.prepare_only:
                proof_path = OUT / "proofs" / (chunk["id"] + "-gemini-" + args.run_id + ".json")
                if proof_path.exists():
                    raise RuntimeError("Proof already exists without matching manifest attempt; refusing duplicate submission")
                prompt_path = PRIVATE / (chunk["id"] + "-prompt.txt")
                prompt_path.write_text(PROMPT + f"\nActual clip duration: {record['clip']['durationSeconds']:.6f}seconds. All times must stay inside this range.\n")
                attempt = {"runId": args.run_id, "requestedModel": args.model, "provider": "Google Gemini API",
                           "proofPath": str(proof_path), "status": "starting", "startedAt": now(),
                           "submittedDurationSeconds": None, "perceptualValidation": "not_reviewed"}
                record["attempts"].append(attempt)
                checkpoint()
                command = [sys.executable, str(ROOT / "scripts/analyze-gemini-audio.py"), record["clip"]["path"],
                           "--source", source["path"], "--source-start", str(chunk["sourceStartSeconds"]),
                           "--model", args.model, "--prompt-file", str(prompt_path), "--proof", str(proof_path)]
                env = dict(os.environ)
                env["PATH"] = str(Path(args.ffprobe).resolve().parent) + os.pathsep + env.get("PATH", "")
                result = subprocess.run(command, env=env, check=False)
                submitted_count += 1
                proof = json.loads(proof_path.read_text()) if proof_path.exists() else {}
                attempt.update(status=proof.get("status", "failed_without_proof"), finishedAt=now(),
                               exitCode=result.returncode, submittedDurationSeconds=proof.get("submittedDurationSeconds"),
                               modelVersion=proof.get("modelVersion"), error=proof.get("error"))
                record["status"] = "execution_success_unvalidated" if attempt["status"] == "success" else "stopped_on_failure"
                checkpoint()
                if result.returncode or attempt["status"] != "success":
                    raise RuntimeError("Stopped at first provider failure; inspect " + str(proof_path))
            if (prepared_count if args.prepare_only else submitted_count) >= limit:
                break
        return 0
    except Exception as error:
        manifest["lastStop"] = {"at": now(), "runId": args.run_id, "reason": str(error)}
        print(json.dumps({"status": "stopped", "reason": str(error)}), flush=True)
        return 2
    finally:
        checkpoint()
        print(json.dumps({"manifest": str(args.manifest), "preparedThisInvocation": prepared_count,
                          "attemptedThisInvocation": submitted_count, "networkRequested": not args.prepare_only,
                          "executionSuccessfulChunks": manifest["executionSuccessfulChunks"],
                          "validatedUniqueCoverageSeconds": manifest["validatedUniqueCoverageSeconds"]}), flush=True)


if __name__ == "__main__":
    sys.exit(main())
