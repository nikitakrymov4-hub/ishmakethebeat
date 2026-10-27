#!/usr/bin/env python3
"""Audit rendered PCM and summarize audio requests without inventing acceptance.

Raw provider proofs, source audio, and the broad-pass plan are read only. A
successful request contributes execution coverage, never validated findings by
default. Acceptance requires a separate hash-bound semantic review and explicit
validated source ranges. Requires NumPy; FFmpeg measures the two diagnostic mixes.
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import math
import re
import shutil
import subprocess
import wave
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "deliverables/audio-research"
CURRENT = OUT / "current"


def sha(path):
    with path.open("rb") as f:
        return hashlib.file_digest(f, "sha256").hexdigest()


def write(path, data):
    temp = path.with_suffix(path.suffix + ".preparing")
    temp.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n")
    temp.replace(path)


def read(path):
    return json.loads(path.read_text())


def relative(path):
    return str(path.relative_to(ROOT))


def load_timestamp_auditor():
    path = ROOT / "scripts/analyze-music-flamingo.py"
    spec = importlib.util.spec_from_file_location("audio_proof_client", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.audit_response_timestamps


def union(intervals):
    merged = []
    for start, end in sorted(intervals):
        if end <= start:
            continue
        if merged and start <= merged[-1][1]:
            merged[-1][1] = max(merged[-1][1], end)
        else:
            merged.append([start, end])
    return merged


def interval_seconds(intervals):
    return sum(end - start for start, end in union(intervals))


def overlap(interval, previous):
    start, end = interval
    return sum(max(0, min(end, b) - max(start, a)) for a, b in union(previous))


def pcm24(path):
    with wave.open(str(path), "rb") as w:
        p = w.getparams()
        if p.nchannels != 2 or p.sampwidth != 3 or p.framerate != 44100:
            raise ValueError(f"Unexpected PCM format: {path.name}: {p}")
        b = np.frombuffer(w.readframes(p.nframes), dtype=np.uint8).reshape(-1, 3)
    n = b[:, 0].astype(np.int32) | b[:, 1].astype(np.int32) << 8 | b[:, 2].astype(np.int32) << 16
    n = np.where(n & 0x800000, n - 0x1000000, n)
    return n.astype(np.float64).reshape(-1, 2) / 8388608, p


def difference(a, b):
    d = a - b
    return {"maxAbsoluteSampleDifference": float(np.max(np.abs(d))),
            "rmsSampleDifference": float(np.sqrt(np.mean(d * d)))}


def mix_measurement(path):
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        return {"status": "unavailable", "reason": "ffmpeg not found"}
    result = subprocess.run([ffmpeg, "-hide_banner", "-i", str(path), "-af",
                             "loudnorm=I=-23:TP=-1:LRA=7:print_format=json", "-f", "null", "-"],
                            capture_output=True, text=True, check=True)
    measurement = json.loads(re.findall(r"\{[\s\S]*?\}", result.stderr)[-1])
    return {"integratedLUFS": float(measurement["input_i"]), "truePeakDbTP": float(measurement["input_tp"]),
            "loudnessRangeLU": float(measurement["input_lra"]), "rawInputMeasurement": measurement,
            "method": "FFmpeg loudnorm input EBU R128 and oversampled true-peak measurement; no audio output or modification"}


def score_boundary_audit():
    bundled = Path.home() / ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node"
    node = str(bundled) if bundled.is_file() else shutil.which("node")
    if not node:
        raise RuntimeError("Node.js is required to verify the actual score boundaries")
    program = r"""
import fs from 'node:fs';
import {score} from './src/engine/score.ts';
import {BAR} from './src/engine/schema.ts';
const source=JSON.parse(fs.readFileSync('deliverables/character/original/project.ish.json','utf8'));
const derived=JSON.parse(fs.readFileSync('deliverables/audio-research/current/project.ish.json','utf8'));
const section=derived.sections[0];
const index=source.sections.findIndex(s=>s.id===section.id);
if(index<0) throw new Error('Derived section absent from source');
const offset=source.sections.slice(0,index).reduce((n,s)=>n+s.bars*BAR,0);
const original=score(source).filter(e=>e.id.startsWith(`${section.id}-`)).map(e=>({...e,tick:e.tick-offset}));
const fresh=score(derived);
const chokes=[],other=[];
for(let i=0;i<Math.max(original.length,fresh.length);i++) {
  const a=original[i],b=fresh[i];
  if(!a || !b) {other.push({index:i,reason:'Missing counterpart'}); continue;}
  const {chokeAfter:oldChoke,...oldRest}=a;
  const {chokeAfter:newChoke,...newRest}=b;
  if(oldChoke!==newChoke) chokes.push({eventId:a.id,role:a.role,oldChokeAfterTicks:oldChoke??null,newChokeAfterTicks:newChoke??null});
  if(JSON.stringify(oldRest)!==JSON.stringify(newRest)) other.push({index:i,old:a,fresh:b});
}
console.log(JSON.stringify({sourceMainEventCount:original.length,derivedEventCount:fresh.length,sourceStartTicks:offset,allOtherEventFieldsIdentical:other.length===0,changedTerminalChokes:chokes,otherDifferences:other}));
"""
    result = subprocess.run([node, "--import", "tsx", "--input-type=module"], input=program,
                            cwd=ROOT, check=True, capture_output=True, text=True)
    audit = json.loads(result.stdout)
    if not audit["allOtherEventFieldsIdentical"]:
        raise ValueError(f"Unexpected score rewrite: {audit['otherDifferences']}")
    return audit


def audit_current():
    report = read(CURRENT / "render-report.json")
    source = read(ROOT / report["source"]["url"].lstrip("/"))
    derived = read(CURRENT / "project.ish.json")
    files, audio = [], {}
    expected_frames = math.ceil((16 * 4 * 60 / derived["settings"]["bpm"] + 4) * 44100)
    expected_names = {item["name"] for item in report["outputs"]}
    actual_names = {p.name for p in CURRENT.glob("*.wav")}
    if actual_names != expected_names:
        raise ValueError(f"Render files differ from report: extra {actual_names-expected_names}, missing {expected_names-actual_names}")
    for item in report["outputs"]:
        path = CURRENT / item["name"]
        samples, params = pcm24(path)
        digest = sha(path)
        if digest != item["sha256"] or params.nframes != expected_frames or not np.isfinite(samples).all():
            raise ValueError(f"Render integrity failure: {path}")
        peak = float(np.max(np.abs(samples)))
        if peak >= 1:
            raise ValueError(f"PCM clips: {path}")
        audio[path.name] = samples
        files.append({"name": path.name, "sha256": digest, "bytes": path.stat().st_size,
                      "frames": params.nframes, "durationSeconds": params.nframes / params.framerate,
                      "sampleRate": params.framerate, "channels": params.nchannels, "pcmBits": params.sampwidth * 8,
                      "finite": True, "samplePeak": peak, "rms": float(np.sqrt(np.mean(samples ** 2))),
                      "nonzeroSamples": int(np.count_nonzero(samples)),
                      "nearFullScaleSamples": int(np.count_nonzero(np.abs(samples) >= .999)),
                      "lastSecondPeak": float(np.max(np.abs(samples[-44100:]))),
                      "matchesRenderHash": True})
    groups = {"melody": ["melody", "pad", "answer", "keys", "bridge", "pedal", "resample"],
              "bass": ["bass"], "drums": ["kick", "clap", "hat", "open", "perc"]}
    group_checks = []
    for group, roles in groups.items():
        diff = difference(sum(audio[f"role-{role}-dry.wav"] for role in roles), audio[f"{group}-dry.wav"])
        group_checks.append({"group": group, "roles": roles, **diff})
    dry = sum(audio[f"{group}-dry.wav"] for group in groups)
    headroom_check = difference((dry + audio["shared-fx.wav"]) * .73, audio["headroom.wav"])
    fx_check = difference(sum(audio[f"{group}-fx-only.wav"] for group in groups), audio["shared-fx.wav"])
    checks = group_checks + [headroom_check, fx_check]
    if any(item["maxAbsoluteSampleDifference"] > 1e-6 for item in checks):
        raise ValueError(f"Stem reconstruction exceeds 1e-6 tolerance: {checks}")
    unchanged_fields = ["candidates", "assets", "clips", "settings", "tagEnabled", "tagAsset", "selected"]
    field_checks = {key: source.get(key) == derived.get(key) for key in unchanged_fields}
    if not all(field_checks.values()):
        raise ValueError(f"Derived project unexpectedly changed source fields: {field_checks}")
    engine_checks = [{**item, "matchesCurrentFile": sha(ROOT / item["path"]) == item["sha256"]}
                     for item in report["engine"]["sourceFiles"]]
    snapshot = hashlib.sha256(json.dumps(report["engine"]["sourceFiles"], separators=(",", ":")).encode()).hexdigest()
    audit = {"schemaVersion": 1, "auditedAt": datetime.now(timezone.utc).isoformat(),
             "renderReport": {"path": relative(CURRENT / "render-report.json"), "sha256": sha(CURRENT / "render-report.json")},
             "status": "passed", "wavCount": len(files), "allAlignedFrames": expected_frames,
             "durationSeconds": expected_frames / 44100, "files": files,
             "intentionalSilence": {"bass-fx-only.wav": "Saved bass has no routed wet return; its dry bass stem contains signal."},
             "groupDryChecks": group_checks, "premasterReconstruction": {"formula": "(melody-dry + bass-dry + drums-dry + shared-fx) * 0.73", **headroom_check},
             "fxReconstruction": {"formula": "melody-fx-only + bass-fx-only + drums-fx-only", **fx_check},
             "comparisonToleranceAbsoluteSample": 1e-6,
             "projectUnchangedFieldChecks": field_checks,
             "sourceProjectHashMatches": sha(ROOT / report["source"]["url"].lstrip("/")) == report["source"]["sha256"],
             "derivedProjectHashMatches": sha(CURRENT / "project.ish.json") == report["project"]["sha256"],
             "engineSourceChecks": engine_checks, "engineSnapshotHashMatches": snapshot == report["engine"]["snapshotSha256"],
             "mixMeasurements": {name: mix_measurement(CURRENT / name) for name in ["full.wav", "headroom.wav"]},
             "boundaryAudit": {"basis": "Independent current score() comparison of saved source main-section events and derived 16-bar project, after subtracting the source section offset.",
                 **score_boundary_audit(),
                 "startContext": "Fresh main section begins at time zero with empty voices/FX. The older bars 5–20 crop begins after four introduction bars and includes intro release/FX carryover.",
                 "endContext": "With no following section, final bass/hat have no following-section choke. Existing gated duration remains unchanged; natural releases and final hat tail can differ. Four seconds of export tail are retained.",
                 "clipPhase": "Original main section ID and section-relative reverse clip positions are retained. Notes, assets, envelopes and recipes are unchanged."},
             "limitations": "Technical integrity and render provenance only; these tests do not validate musical quality or model hearing."}
    write(CURRENT / "extra-audit.json", audit)
    return audit


def summarize():
    source = read(OUT / "album-source.json")
    plan = read(OUT / "album-coverage-plan.json")
    reviews_path = OUT / "semantic-reviews.json"
    reviews = read(reviews_path).get("reviews", []) if reviews_path.exists() else []
    review_map = {item["proofPath"]: item for item in reviews}
    audit_timestamps = load_timestamp_auditor()
    requests, probes, invalid = [], [], []
    for path in sorted((OUT / "proofs").glob("*.json")):
        try:
            data = read(path)
        except (json.JSONDecodeError, OSError) as error:
            invalid.append({"path": relative(path), "error": str(error), "counted": False})
            continue
        digest = sha(path)
        original = data.get("source") or {}
        source_hash = original.get("sha256") or data.get("sourceSHA256")
        source_range = [original.get("clip_start_seconds"), original.get("clip_end_seconds")]
        if source_range[0] is None:
            source_range = data.get("sourceRangeSeconds")
        if not source_hash:
            probes.append({"proofPath": relative(path), "proofSha256": digest, "provider": data.get("provider"),
                           "model": data.get("model") or data.get("requestedModel"), "status": data.get("status"),
                           "countsAsAudioExecution": False})
            continue
        submitted = data.get("submitted_audio") or {}
        submitted_duration = submitted.get("duration_seconds", data.get("submittedDurationSeconds"))
        response = data.get("returned_response") or data.get("responseText") or ""
        executed = bool(response) and (bool(data.get("successful_audio_execution")) or (
            data.get("status") == "success" and submitted_duration is not None))
        submitted_request = bool(data.get("submitted_request")) or data.get("submittedDurationSeconds") is not None
        if not submitted_request:
            submitted_duration = None
        review = review_map.get(relative(path))
        review_hash_matches = bool(review and review.get("proofSha256") == digest)
        semantic_status = review.get("status") if review_hash_matches else "unreviewed"
        semantic = review if review_hash_matches else {"status": "unreviewed", "reason": "No matching explicit semantic review; execution is not acceptance."}
        timeline = audit_timestamps(response, submitted_duration) if response and submitted_duration else None
        if timeline and timeline.get("status") == "flagged_unreliable_timeline" and semantic_status == "unreviewed":
            semantic = {"status": "rejected_automatic_timeline", "reason": "Response refers to events outside submitted duration; not usable as confirmed musical findings."}
            semantic_status = semantic["status"]
        is_album = source_hash == source["sha256"]
        interval = None
        cap = (data.get("model_audio_limits") or {}).get("cap_seconds")
        if executed and source_range and submitted_duration is not None:
            start, end = source_range
            if start is not None and end is not None and start >= 0 and end >= start:
                length = min(end - start, submitted_duration, cap if cap is not None else submitted_duration)
                interval = [start, start + length]
                if is_album and interval[1] > source["decodedDurationSeconds"] + .001:
                    interval = None
        validated = []
        if executed and semantic_status == "accepted" and semantic.get("evidence") and interval:
            for a, b in semantic.get("validatedSourceRangesSeconds", []):
                if interval[0] <= a < b <= interval[1]:
                    validated.append([a, b])
        requests.append({"proofPath": relative(path), "proofSha256": digest, "provider": data.get("provider"),
            "model": data.get("model") or data.get("modelVersion") or data.get("requestedModel"),
            "providerSpaceRevision": data.get("space_revision"), "status": data.get("status"),
            "sourceSha256": source_hash, "sourceFilename": original.get("filename") or data.get("sourceFilename"),
            "sourceRangeSeconds": source_range, "isAlbumSource": is_album,
            "submittedAudio": {"filename": submitted.get("filename") or data.get("clipFilename"),
                "sha256": submitted.get("sha256") or data.get("clipSHA256"),
                "bytes": submitted.get("bytes") or data.get("audioByteCount"),
                "durationSeconds": submitted_duration, "sampleRate": submitted.get("sample_rate"), "channels": submitted.get("channels")},
            "audioRequestSubmitted": submitted_request, "successfulAudioExecution": executed,
            "executionIntervalSeconds": interval, "modelLimits": data.get("model_audio_limits"),
            "preprocessing": data.get("preprocessing") or data.get("preprocessingCaveat"),
            "error": data.get("error"), "finishedAt": data.get("finished_at"),
            "contentReliability": {"clientAudit": data.get("content_reliability"), "independentTimestampAudit": timeline,
                "semanticReview": semantic, "matchingHashBoundReview": review_hash_matches,
                "validatedSourceRangesSeconds": validated, "usableAsConfirmedMusicalFindings": bool(validated)},
            "responseRetainedInRawProof": bool(response), "coverageChunkId": data.get("coverageChunkId")})
    previous, executed_intervals, validated_intervals = [], [], []
    for request in requests:
        if not request["isAlbumSource"]:
            continue
        interval = request["executionIntervalSeconds"]
        request["overlapWithEarlierExecutedAlbumRequestsSeconds"] = overlap(interval, previous) if interval else 0
        if interval:
            previous.append(interval)
            executed_intervals.append(interval)
        validated_intervals.extend(request["contentReliability"]["validatedSourceRangesSeconds"])
    executed_union = union(executed_intervals)
    validated_union = union(validated_intervals)
    total = source["decodedDurationSeconds"]
    processed_seconds, validated_seconds = interval_seconds(executed_union), interval_seconds(validated_union)
    broad_chunks = [{**chunk, "relatedBroadRequestProofs": [r["proofPath"] for r in requests if r["coverageChunkId"] == chunk["id"]]}
                    for chunk in plan["chunks"]]
    manifest = {"schemaVersion": 1, "generatedAt": datetime.now(timezone.utc).isoformat(),
        "source": source, "status": "partial_execution_no_complete_album_claim",
        "coverageDefinitions": {
            "executed": "Union of source intervals whose actual uploaded/inline audio request returned a successful model response, bounded by submitted duration and explicit provider cap. Does not attest perfect attention or musical correctness.",
            "validated": "Explicit source ranges accepted by a separate semantic review bound to the immutable proof SHA256, with corroborating evidence. Successful inference and timestamp-bound passes alone never count.",
            "broadPlan": "The 38 planned chronological chunks remain a plan. Two separate 30-second diagnostic excerpts do not complete any broad-pass request."},
        "executedAlbumIntervalsSeconds": executed_union, "executedAlbumUniqueSeconds": processed_seconds,
        "executedAlbumPercent": 100 * processed_seconds / total,
        "validatedAlbumIntervalsSeconds": validated_union, "validatedAlbumUniqueSeconds": validated_seconds,
        "validatedAlbumPercent": 100 * validated_seconds / total,
        "albumSecondsWithoutSuccessfulExecution": total - processed_seconds,
        "albumSecondsWithoutValidatedFindings": total - validated_seconds,
        "counts": {"providerProbeRecords": len(probes), "audioRequestOrPreflightRecords": len(requests),
            "successfulAudioExecutionsAllSources": sum(r["successfulAudioExecution"] for r in requests),
            "successfulAlbumAudioExecutions": sum(r["successfulAudioExecution"] and r["isAlbumSource"] for r in requests),
            "semanticallyRejectedResponses": sum(r["contentReliability"]["semanticReview"]["status"].startswith("rejected") for r in requests),
            "successfulReviewedUnverifiedResponses": sum(r["successfulAudioExecution"] and r["contentReliability"]["semanticReview"]["status"] == "unverified" for r in requests),
            "successfulUnreviewedResponses": sum(r["successfulAudioExecution"] and r["contentReliability"]["semanticReview"]["status"] == "unreviewed" for r in requests)},
        "broadPass": {"planPath": relative(OUT / "album-coverage-plan.json"), "planSha256": sha(OUT / "album-coverage-plan.json"),
            "plannedChunks": broad_chunks, "planFileModifiedBySummary": False},
        "requests": requests, "providerProbes": probes, "unreadableProofs": invalid,
        "rawProofFilesModified": False,
        "note": "Reliability failures are evidence about the model route, not findings about TDF music or the quality of the current beat. No production rewrite is justified by these rejected descriptions."}
    write(OUT / "album-coverage-manifest.json", manifest)
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--skip-current-audit", action="store_true", help="Refresh only proof/coverage status")
    args = parser.parse_args()
    audit = None if args.skip_current_audit else audit_current()
    manifest = summarize()
    print(json.dumps({"renderAudit": audit and {"status": audit["status"], "wavCount": audit["wavCount"], "frames": audit["allAlignedFrames"],
                    "headroomMaxError": audit["premasterReconstruction"]["maxAbsoluteSampleDifference"]},
        "coverageManifest": str(OUT / "album-coverage-manifest.json"),
        "executedAlbumSeconds": manifest["executedAlbumUniqueSeconds"], "executedAlbumPercent": manifest["executedAlbumPercent"],
        "validatedAlbumSeconds": manifest["validatedAlbumUniqueSeconds"], "counts": manifest["counts"]}, indent=2))


if __name__ == "__main__":
    main()
