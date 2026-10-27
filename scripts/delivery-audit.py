#!/usr/bin/env python3
"""Audit actual delivery checkpoints without modifying audio.

Usage: python delivery-audit.py CHECKPOINT [CHECKPOINT ...] --output audit.json
Use --qa-fixture only for infrastructure fixtures, never a finished-beat claim.
Requires NumPy and FFmpeg; bundled workspace Python is supported.
"""
from __future__ import annotations
import argparse
import base64
from datetime import datetime, timezone
import hashlib
import json
import math
import os
from pathlib import Path
import shutil
import subprocess
import zipfile
from delivery_contract import delivery_contract

os.environ["OMP_NUM_THREADS"] = "1"
os.environ["OPENBLAS_NUM_THREADS"] = "1"
import numpy as np

FFMPEG = shutil.which("ffmpeg") or "/opt/homebrew/bin/ffmpeg"
FFPROBE = shutil.which("ffprobe") or "/opt/homebrew/bin/ffprobe"


def sha(path):
    with Path(path).open("rb") as file:
        return hashlib.file_digest(file, "sha256").hexdigest()


def number(value):
    try:
        value = float(value)
        return value if math.isfinite(value) else None
    except (TypeError, ValueError):
        return None


def safe_file(directory, name):
    path = (directory / name).resolve()
    if Path(name).name != name or path.parent != directory.resolve():
        raise ValueError(f"Unsafe checkpoint output name: {name}")
    return path


def probe(path):
    result = json.loads(subprocess.check_output([FFPROBE, "-v", "error", "-select_streams", "a:0",
        "-show_entries", "stream=codec_name,sample_rate,channels,duration_ts,time_base,bits_per_raw_sample", "-of", "json", str(path)]))["streams"][0]
    numerator, denominator = map(int, result["time_base"].split("/"))
    rate = int(result["sample_rate"])
    exact_frames = int(result["duration_ts"]) * numerator * rate / denominator
    if exact_frames != int(exact_frames):
        raise ValueError("Nonintegral frame count in delivery audio")
    return {"sampleRate": rate, "channels": int(result["channels"]), "frames": int(exact_frames),
        "durationSeconds": exact_frames / rate, "codec": result["codec_name"], "bits": int(result.get("bits_per_raw_sample") or 0)}


def decode(path, channels):
    raw = subprocess.check_output([FFMPEG, "-v", "error", "-nostdin", "-threads", "1", "-i", str(path),
        "-map", "0:a:0", "-f", "f32le", "-c:a", "pcm_f32le", "-"])
    return np.frombuffer(raw, dtype="<f4").reshape(-1, channels)


def metrics(path, metadata):
    pcm = decode(path, metadata["channels"])
    if len(pcm) != metadata["frames"] or not np.isfinite(pcm).all():
        raise ValueError("Invalid decoded sample data")
    peak = float(np.max(abs(pcm)))
    rms = float(np.sqrt(np.mean(pcm.astype(np.float64)**2)))
    result = subprocess.run([FFMPEG, "-hide_banner", "-nostdin", "-threads", "1", "-filter_threads", "1", "-i", str(path),
        "-af", "loudnorm=I=-20:TP=-2:LRA=11:print_format=json", "-f", "null", "-"], capture_output=True, text=True, check=True)
    raw = json.JSONDecoder().raw_decode(result.stderr[result.stderr.rfind("{"):])[0]
    return {"integratedLUFS": number(raw["input_i"]), "loudnessRangeLU": number(raw["input_lra"]),
        "truePeakDbTP": number(raw["input_tp"]), "gatingThresholdLUFS": number(raw["input_thresh"]),
        "samplePeakLinear": peak, "samplePeakDbFS": 20*math.log10(peak) if peak else None,
        "rmsLinear": rms, "digitalSilence": peak == 0,
        "decodedFloat32SHA256": hashlib.sha256(pcm.tobytes()).hexdigest(),
        "rawInputMeasurement": {k:v for k,v in raw.items() if k.startswith("input_")}}


def difference(actual, expected, tolerance):
    delta = actual.astype(np.float64) - expected
    maximum = float(np.max(abs(delta)))
    return {"maximumAbsoluteError": maximum, "rmsError": float(np.sqrt(np.mean(delta**2))),
        "tolerance": tolerance, "withinTolerance": maximum <= tolerance}


def reconstruction(directory, rows, gain):
    by_name = {r["name"]: r for r in rows if r.get("audio") and r.get("hashMatches") and r.get("aligned")}
    required = ["headroom.wav", "instrumental-headroom.wav", "stem-fx.wav", "stem-fx-instrumental.wav"]
    dry = [r for r in by_name.values() if r["name"].startswith("stem-") and r["name"].endswith("-dry.wav")]
    if not dry or any(name not in by_name for name in required):
        return {"status": "unavailable", "reason": "Missing aligned, hash-verified headroom/FX/dry files"}
    first = by_name["headroom.wav"]["audio"]
    shape = (first["frames"], first["channels"])
    full = np.zeros(shape, dtype=np.float64)
    instrumental = np.zeros(shape, dtype=np.float64)
    vocal_peaks = {}
    for row in dry:
        data = decode(directory / row["name"], first["channels"])
        full += data
        if row.get("tap") in ("tag", "vox"):
            vocal_peaks[row["tap"]] = float(np.max(abs(data)))
        else:
            instrumental += data
    full += decode(directory / "stem-fx.wav", first["channels"])
    instrumental += decode(directory / "stem-fx-instrumental.wav", first["channels"])
    full *= gain; instrumental *= gain
    # Independent WebAudio renders and each24bit file introduce small rounding differences.
    tolerance = max(2e-6, (len(dry)+3) * 2**-23)
    actual_full = decode(directory / "headroom.wav", first["channels"])
    check_full = difference(actual_full, full, tolerance)
    actual_instrumental = decode(directory / "instrumental-headroom.wav", first["channels"])
    check_instrumental = difference(actual_instrumental, instrumental, tolerance)
    vocal_delta = difference(actual_full.astype(np.float64)-actual_instrumental,
        full-instrumental, tolerance*2)
    return {"status": "measured", "dryStemCount": len(dry), "masterLinearGainAssumption": gain,
        "headroomFromDryAndFullFx": check_full, "instrumentalFromNonvocalDryAndInstrumentalFx": check_instrumental,
        "vocalDryPlusReturnDifference": vocal_delta, "vocalDrySamplePeaks": vocal_peaks,
        "scope": "Checks stem algebra and vocal-version difference. A shared renderer routing bug could affect all outputs; this is not independent proof of perceptual absence of vocals or musical quality. Nonlinear listening masters are deliberately not summed."}


def audit(checkpoint_path, fixture, min_seconds, gain):
    directory = checkpoint_path.parent
    checkpoint = json.loads(checkpoint_path.read_text())
    errors, warnings, rows = [], [], []
    if checkpoint.get("status") != "complete": errors.append("Checkpoint is not complete")
    identity = checkpoint.get("identity", {})
    fmt = identity.get("format", {})
    project_path = directory / "project.ish.json"
    project = json.loads(project_path.read_text()) if project_path.is_file() else {}
    contract = delivery_contract(checkpoint, project)
    errors.extend(contract["errors"])
    expected_names = contract["requiredNames"]
    actual_names = [x["name"] for x in checkpoint.get("outputs", [])]
    if len(actual_names) != len(set(actual_names)): errors.append("Duplicate output names")
    for missing in sorted(expected_names - set(actual_names)): errors.append(f"Missing checkpoint output: {missing}")
    for output in checkpoint.get("outputs", []):
        path = safe_file(directory, output["name"])
        row = {"name": output["name"], "tap": output.get("tap"), "instrumentalOnly": output.get("instrumentalOnly", False), "exists": path.is_file()}
        if not path.is_file(): errors.append(f"Missing file: {path.name}"); rows.append(row); continue
        digest = sha(path)
        row.update({"sha256": digest, "hashMatches": digest == output.get("sha256"), "bytes": path.stat().st_size})
        if not row["hashMatches"]: errors.append(f"Hash mismatch: {path.name}")
        if output.get("bytes") != row["bytes"]: errors.append(f"Byte count mismatch: {path.name}")
        if path.suffix.lower() == ".wav":
            metadata = probe(path); row["audio"] = metadata
            row["aligned"] = all(metadata[k] == fmt.get(k) for k in ("frames", "sampleRate", "channels")) and metadata["frames"] == output.get("frames")
            if not row["aligned"]: errors.append(f"Frame/rate/channel mismatch: {path.name}")
            row["measurement"] = metrics(path, metadata)
            if row["measurement"]["samplePeakLinear"] >= 1: warnings.append(f"Full-scale samples in {path.name}")
            true_peak = row["measurement"]["truePeakDbTP"]
            if true_peak is not None and true_peak >= 0: warnings.append(f"Measured true peak >=0dBTP in {path.name}")
        rows.append(row)
        print(json.dumps({"job": identity.get("jobId"), "audited": path.name}), flush=True)
    settings = project.get("settings", {})
    bpm = settings.get("bpm", 0)
    bars = sum(s["bars"] for s in project.get("sections", [])) if project.get("arrangement") else 8
    music_seconds = bars * 240 / bpm if bpm > 0 else None
    render_seconds = fmt.get("frames",0)/max(1,fmt.get("sampleRate",44100))
    if music_seconds is None: errors.append("Invalid project tempo")
    elif render_seconds + 1/max(1,fmt.get("sampleRate",44100)) < music_seconds + 4:
        errors.append("Rendered audio is shorter than project music plus the engine's minimum4s tail")
    source_hash = identity.get("sourceSha256")
    if not project or sha(project_path) != source_hash: errors.append("Saved project does not match checkpoint source hash")
    if music_seconds is not None and music_seconds < min_seconds and not fixture: errors.append(f"Musical duration {music_seconds:.3f}s is below required {min_seconds}s")
    declared_music = checkpoint.get("provenance", {}).get("project", {}).get("musicDurationSeconds")
    if declared_music is not None and abs(declared_music-music_seconds) > 1/max(1,fmt.get("sampleRate",44100)): errors.append("Project length differs from render provenance")
    assets, credits = [], []
    referenced = {t["instrument"] for t in project.get("candidates", [{}])[project.get("selected", 0)].get("tracks", []) if t.get("notes") and not t.get("mute")}
    referenced |= {c["assetId"] for c in project.get("clips", [])}
    referenced |= {v["assetId"] for v in project.get("vocalEvents", [])}
    if project.get("tagAsset"): referenced.add(project["tagAsset"])
    for asset in project.get("assets", []):
        data = asset.get("data", "")
        embedded_hash = None
        if data.startswith("data:") and ";base64," in data:
            raw = base64.b64decode(data.split(",",1)[1], validate=True); embedded_hash = hashlib.sha256(raw).hexdigest()
        matches = embedded_hash == asset.get("hash") if asset.get("hash") else None
        if matches is False: errors.append(f"Embedded asset hash mismatch: {asset['id']}")
        if asset["id"] in referenced and embedded_hash is None: errors.append(f"Referenced asset is not embedded: {asset['id']}")
        assets.append({"id":asset["id"], "name":asset.get("name"), "sha256":embedded_hash, "declaredHashMatches":matches, "referencedInStoredScore":asset["id"] in referenced,
            "source":asset.get("source"), "sourceId":asset.get("sourceId"), "creditOrLicense":asset.get("license")})
    for kind in ("clips", "vocalEvents"):
        for item in project.get(kind, []):
            provenance = {k:v for k,v in item.get("provenance", {}).items() if k != "sourceScore"}
            credits.append({"kind":kind, "id":item.get("id"), "assetId":item.get("assetId"), "name":item.get("name"), "provenance":provenance})
    portable = {"status":"missing"}
    archive = directory / "portable-project.zip"
    if archive.is_file():
        with zipfile.ZipFile(archive) as z:
            if sum(i.file_size for i in z.infolist()) > 2_000_000_000: raise ValueError("Portable archive exceeds audit size guard")
            bad_crc = z.testzip()
            portable = {"status":"checked", "crcFailure":bad_crc, "embeddedProjectMatches":json.loads(z.read("project.json")) == project,
                "midiMatches":hashlib.sha256(z.read("score.mid")).hexdigest() == sha(directory/"score.mid")}
            if bad_crc or not portable["embeddedProjectMatches"] or not portable["midiMatches"]: errors.append("Portable archive consistency failed")
    else: errors.append("Portable archive missing")
    if contract["mode"] == "mixes":
        stems = {"status": "not_requested", "scope": "Explicit mixes mode: no dry/FX stem reconstruction or instrumental-only vocal-routing check performed."}
    else:
        stems = reconstruction(directory, rows, gain)
        if stems["status"] != "measured": errors.append("Stem reconstruction unavailable")
        else:
            for key in ("headroomFromDryAndFullFx", "instrumentalFromNonvocalDryAndInstrumentalFx", "vocalDryPlusReturnDifference"):
                if not stems[key]["withinTolerance"]: errors.append(f"Stem reconstruction failed: {key}")
    vocal_issues = checkpoint.get("provenance", {}).get("vocalIssues", [])
    if vocal_issues: errors.append("Renderer reported unresolved vocal events")
    counts = checkpoint.get("provenance", {}).get("roleEventCounts", {})
    for role, peak in stems.get("vocalDrySamplePeaks", {}).items():
        if not counts.get(role) and peak > 2**-23: errors.append(f"Unexpected {role} signal with zero scheduled events")
        if counts.get(role) and peak == 0: warnings.append(f"Scheduled {role} events produced a silent dry stem")
    for row in rows:
        if row.get("exists") and sha(directory/row["name"]) != row["sha256"]: errors.append(f"File changed during audit: {row['name']}")
    return {"checkpoint":{"path":str(checkpoint_path),"sha256":sha(checkpoint_path)}, "jobId":identity.get("jobId"), "runId":identity.get("runId"),
        "status":"passed" if not errors else "failed", "deliveryMode":contract["mode"], "verificationScope":contract["scope"], "qaFixtureOnly":fixture, "errors":errors, "warnings":warnings,
        "project":{"title":project.get("title"), "seed":settings.get("seed"), "bpm":bpm, "sourceKind":project.get("sourceKind"), "bars":bars,
            "musicDurationSeconds":music_seconds, "renderDurationSeconds":render_seconds, "retainedTailSeconds":render_seconds-music_seconds if music_seconds is not None else None, "sourceSha256":source_hash,
            "tagEnabled":project.get("tagEnabled",False), "voxEnabled":project.get("voxEnabled",True), "storedVocalEvents":len(project.get("vocalEvents",[])),
            "scheduledTagEvents":counts.get("tag",0), "scheduledVoxEvents":counts.get("vox",0)},
        "files":rows, "stemConsistency":stems, "portableArchive":portable, "assets":assets, "sourceCredits":credits,
        "musicalApproval":"not assessed; measurements and consistency do not establish a finished or convincing beat"}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("checkpoints", nargs="+", type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--qa-fixture", action="store_true")
    parser.add_argument("--min-music-seconds", type=float, default=90)
    parser.add_argument("--headroom-gain", type=float, default=.73, help="Recorded engine's linear headroom master gain")
    args = parser.parse_args()
    if args.output.resolve() in [x.resolve() for x in args.checkpoints]: parser.error("Output cannot overwrite a checkpoint")
    result = {"schemaVersion":1,"createdAt":datetime.now(timezone.utc).isoformat(),"script":{"path":str(Path(__file__).resolve()),"sha256":sha(__file__)},
        "method":{"ffmpeg":subprocess.check_output([FFMPEG,"-version"],text=True).splitlines()[0],
            "officialMeasurementDocumentation":"https://ffmpeg.org/ffmpeg-filters.html#loudnorm",
            "loudness":"FFmpeg loudnorm input measurements (BS.1770/EBU gated integrated LUFS and LRA); null for undefined/silent measurements.",
            "truePeak":"FFmpeg loudnorm input true-peak estimate using internal192kHz oversampling, reported to0.01dB. This is an intersample estimate, not the native sample maximum.",
            "samplePeak":"Maximum absolute native decoded float32 PCM value; exact for24bit PCM sources. RMS computed in float64.",
            "processing":"Read-only measurement and comparisons; no normalized audio is written; files processed sequentially; no artist-wide loudness target imposed."},
        "jobs":[audit(p.resolve(),args.qa_fixture,args.min_music_seconds,args.headroom_gain) for p in args.checkpoints]}
    result["status"] = "passed" if all(j["status"] == "passed" for j in result["jobs"]) else "failed"
    args.output.parent.mkdir(parents=True,exist_ok=True)
    args.output.write_text(json.dumps(result,indent=2,ensure_ascii=False,allow_nan=False)+"\n")
    print(json.dumps({"status":result["status"],"jobs":len(result["jobs"]),"output":str(args.output.resolve())}))
    raise SystemExit(0 if result["status"] == "passed" else 1)


if __name__ == "__main__": main()
