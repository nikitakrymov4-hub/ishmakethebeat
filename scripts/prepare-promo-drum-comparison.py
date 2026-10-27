#!/usr/bin/env python3
"""Prepare aligned Promo dry-drum and bass+drum before/after excerpts.

Requires two completed delivery directories and a fresh output directory.
The fixed 24-second region starts at 8 bars of 145 BPM (13.241379310s).
Each summed group receives one reversible constant gain to -24 LUFS.
No model, renderer, EQ, limiter, channel conversion or resampling is invoked.
"""
from __future__ import annotations
import argparse
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
from pathlib import Path
import shutil
import tempfile

ROOT = Path(__file__).resolve().parents[1]
HELPER = ROOT / "scripts/build-blind-audio-comparison.py"
spec = importlib.util.spec_from_file_location("blind_comparison", HELPER)
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)
np, audit = helper.np, helper.audit
ROLES = ("kick", "clap", "hat", "open", "perc", "bass")
START = 8 * 240 / 145
SECONDS = 24
TARGET = -24


def read_group(directory):
    checkpoint_path = directory / "checkpoint.json"
    checkpoint_hash = audit.sha(checkpoint_path)
    checkpoint = json.loads(checkpoint_path.read_text())
    if checkpoint.get("status") != "complete":
        raise ValueError(f"Incomplete delivery: {directory}")
    expected = {row["name"]: row for row in checkpoint["outputs"]}
    fmt = checkpoint["identity"]["format"]
    if fmt.get("sampleRate") != helper.RATE or fmt.get("channels") != 2:
        raise ValueError("Both deliveries must be original stereo 44100 Hz; no implicit conversion")
    project_path = directory / "project.ish.json"
    project_hash = audit.sha(project_path)
    if project_hash != checkpoint["identity"].get("sourceSha256"):
        raise ValueError("Saved project differs from delivery checkpoint")
    project = json.loads(project_path.read_text())
    if project.get("settings", {}).get("bpm") != 145:
        raise ValueError("This fixed Promo comparison expects 145 BPM in both projects")
    drums = np.zeros((round(SECONDS * helper.RATE), 2), dtype=np.float64)
    bass = None
    sources = []
    for role in ROLES:
        path = directory / f"stem-{role}-dry.wav"
        digest = audit.sha(path)
        row = expected.get(path.name, {})
        if digest != row.get("sha256") or row.get("tap") != role:
            raise ValueError(f"Missing/mismatched checkpoint stem: {path}")
        data, meta, first, last = helper.extract(path, START, SECONDS)
        if any(meta[key] != fmt[key] for key in ("sampleRate", "channels", "frames")):
            raise ValueError(f"Stem not aligned with its delivery format: {path}")
        if (first, last) != (round(START * helper.RATE), round(START * helper.RATE) + round(SECONDS * helper.RATE)):
            raise ValueError("Extracted source frame alignment mismatch")
        if role == "bass":
            bass = data.astype(np.float64)
        else:
            drums += data
        sources.append({"role": role, "path": str(path), "sha256": digest, **meta,
            "region": {"startFrame": first, "endFrameExclusive": last,
                "startSeconds": first / helper.RATE, "endSeconds": last / helper.RATE},
            "excerptFloat32SHA256": hashlib.sha256(data.tobytes()).hexdigest()})
    if not np.isfinite(drums).all() or not np.isfinite(bass).all():
        raise ValueError("Nonfinite sum")
    record = {"directory": str(directory), "checkpoint": {"path": str(checkpoint_path), "sha256": checkpoint_hash},
        "project": {"path": str(project_path), "sha256": project_hash}, "format": fmt, "stems": sources}
    return {"drums": drums, "bass-drums": drums + bass}, record


def matched(data, name, temp):
    # Float WAV preserves values above unity while measuring the raw stem sum.
    raw = temp / f"{name}-raw.wav"
    helper.encode(data, raw, "pcm_f32le")
    before = helper.measure(raw)
    db, gain = helper.gain_for(before["integratedLUFS"], TARGET, before["truePeakDbTP"])
    scaled = data * gain
    if not np.isfinite(scaled).all() or np.max(np.abs(scaled)) >= 1:
        raise ValueError("Matched sum would clip or contain nonfinite samples")
    wav = temp / f"{name}.wav"
    helper.encode(scaled, wav, "pcm_s24le")
    after = helper.measure(wav)
    if abs(after["integratedLUFS"] - TARGET) > 0.06 or after["truePeakDbTP"] > -1:
        raise ValueError("Matched measurement failed -24 LUFS ±0.06 LU / -1 dBTP guard")
    decoded = audit.decode(wav, 2)
    if decoded.shape != scaled.shape or not np.isfinite(decoded).all():
        raise ValueError("Output shape/nonfinite check failed")
    error = float(np.max(np.abs(decoded.astype(np.float64) - scaled)))
    if error > 2**-23 + 1e-7:
        raise ValueError("24-bit conversion exceeds quantization allowance")
    flac = temp / f"{name}.flac"
    helper.encode(decoded, flac, "flac")
    if not np.array_equal(decoded, audit.decode(flac, 2)):
        raise ValueError("FLAC differs from exact 24-bit WAV PCM")
    return {"name": name, "includedRoles": list(ROLES[:-1] if name.endswith("-drums") and "bass-" not in name else ROLES),
        "frames": len(decoded), "durationSeconds": len(decoded) / helper.RATE,
        "sampleRate": helper.RATE, "channels": 2,
        "rawSumFloat64SHA256": hashlib.sha256(np.asarray(data, dtype="<f8").tobytes()).hexdigest(),
        "decodedOutputFloat32SHA256": hashlib.sha256(decoded.tobytes()).hexdigest(),
        "beforeMeasurement": before, "afterMeasurement": after,
        "gain": {"constantDb": db, "constantLinear": gain, "inverseDb": -db, "inverseLinear": 1 / gain},
        "max24bitQuantizationError": error,
        "files": [{"name": p.name, "sha256": audit.sha(p), "bytes": p.stat().st_size} for p in (wav, flac)]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--before-dir", type=Path, required=True)
    parser.add_argument("--after-dir", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()
    before_dir = args.before_dir.resolve(strict=True)
    after_dir = args.after_dir.resolve(strict=True)
    output = args.output_dir.resolve()
    if before_dir == after_dir:
        parser.error("Before and after must be distinct delivery directories")
    if output.exists():
        parser.error("Output directory must be fresh; originals and prior comparisons are never overwritten")
    if any(output.is_relative_to(source) or source.is_relative_to(output) for source in (before_dir, after_dir)):
        parser.error("Output must not contain or be inside either source delivery")
    output.parent.mkdir(parents=True, exist_ok=True)
    sources, records = [], []
    with tempfile.TemporaryDirectory(prefix=".promo-comparison-", dir=output.parent) as temporary:
        temp = Path(temporary)
        for label, directory in (("before", before_dir), ("after", after_dir)):
            groups, source = read_group(directory)
            if sources and any(source["format"][key] != sources[0]["format"][key] for key in ("sampleRate", "channels", "frames")):
                raise ValueError("Before/after full delivery frame counts differ; do not imply musical alignment")
            sources.append({"version": label, **source})
            for group, data in groups.items():
                records.append(matched(data, f"{label}-{group}", temp))
            del groups
        # Verify original bytes again after all extraction and measurement.
        for source in sources:
            for item in [source["checkpoint"], source["project"], *source["stems"]]:
                if audit.sha(item["path"]) != item["sha256"]:
                    raise ValueError("Source changed while preparing comparison")
        manifest = {"schemaVersion": 1, "createdAt": datetime.now(timezone.utc).isoformat(),
            "script": {"path": str(Path(__file__).resolve()), "sha256": audit.sha(__file__)},
            "importedHelper": {"path": str(HELPER), "sha256": audit.sha(HELPER)},
            "protocol": {"requestedStartSeconds": START, "seconds": SECONDS, "targetLUFS": TARGET,
                "sourceAlignment": "Identical decoded source frame range in aligned complete 145 BPM deliveries; no shift, resampling, channel conversion or per-stem normalization.",
                "processing": "Sum exported dry stems in float64, then one constant gain per version/group; 24-bit encoding only. No EQ, dynamics, fades or wet-return inclusion.",
                "measurement": "Imported FFmpeg loudnorm input measurements (output discarded); true-peak internal oversampling estimate, reported 0.01 dB.",
                "scope": "Reversible gain can be undone within documented quantization error. Dry taps retain sample-intrinsic ambience but omit shared effect returns. Frame alignment is mechanical, not a proof of correct musical downbeat or improvement.",
                "modelExecuted": False}, "sources": sources, "records": records}
        (temp / "comparison-manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
        (temp / "README.txt").write_text("Promo placement comparison: before/after dry drums and bass+drums.\n"
            "Each is the same 24-second source-frame region from approximately 13.241379 seconds, constant-gain matched to -24 LUFS.\n"
            "Dry drums = kick + clap + closed hat + open hat + percussion; bass+drums adds the dry bass stem.\n"
            "No melody, tag/vox or shared wet returns are included. Original sample ambience can remain.\n"
            "See comparison-manifest.json for source hashes, exact frame alignment, inverse gains and measured error.\n"
            "These labeled comparisons are for placement judgment, not independent blind evaluations.\n")
        output.mkdir()
        for name in [f["name"] for row in records for f in row["files"]] + ["comparison-manifest.json", "README.txt"]:
            shutil.copyfile(temp / name, output / name)
    print(json.dumps({"prepared": str(output), "comparisons": 4, "durationEachSeconds": SECONDS, "modelExecuted": False}))


if __name__ == "__main__":
    main()
