#!/usr/bin/env python3
"""Read-only stereo diagnostics for existing audio; no inference or musical edits."""
from __future__ import annotations
import hashlib
import json
from pathlib import Path
import re
import subprocess
from datetime import datetime, timezone
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "deliverables/audio-research"
CURRENT = OUT / "current"
AUDITIONS = ROOT / "private-assets/audio-research/auditions-v1"
FFMPEG = "/opt/homebrew/bin/ffmpeg"
FFPROBE = "/opt/homebrew/bin/ffprobe"
NODE = "/Users/nikitakrymov/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node"
BANDS = [(0, 20), (20, 80), (80, 160), (160, 400), (400, 1200), (1200, 4000), (4000, 10000), (10000, 22050)]


def sha(path):
    with Path(path).open("rb") as f:
        return hashlib.file_digest(f, "sha256").hexdigest()


def db(value):
    return float(20 * np.log10(value)) if value > 1e-15 else None


def decode(path):
    probe = json.loads(subprocess.check_output([FFPROBE, "-v", "error", "-select_streams", "a:0", "-show_entries", "stream=sample_rate,channels,codec_name", "-of", "json", str(path)]))["streams"][0]
    pcm = subprocess.check_output([FFMPEG, "-v", "error", "-nostdin", "-i", str(path), "-map", "0:a:0", "-c:a", "pcm_f32le", "-f", "f32le", "-"])
    channels, rate = int(probe["channels"]), int(probe["sample_rate"])
    data = np.frombuffer(pcm, dtype="<f4").reshape(-1, channels)
    if channels != 2 or rate != 44100:
        raise ValueError(f"Unexpected source format: {path}, {probe}")
    return data, rate


def spectral(data, rate):
    count = len(data)
    fft = np.fft.rfft(data, axis=0)
    frequencies = np.fft.rfftfreq(count, 1 / rate)
    power = np.abs(fft) ** 2 / count ** 2
    power[1:-1] *= 2
    if count % 2:
        power[-1] *= 2
    combined = np.mean(power, axis=1)
    total = float(combined.sum())
    mid_power = np.abs((fft[:, 0] + fft[:, 1]) * .5) ** 2 / count ** 2
    side_power = np.abs((fft[:, 0] - fft[:, 1]) * .5) ** 2 / count ** 2
    for values in (mid_power, side_power):
        values[1:-1] *= 2
        if count % 2:
            values[-1] *= 2
    bands = []
    for low, high in BANDS:
        mask = (frequencies >= low) & (frequencies < high if high < rate / 2 else frequencies <= high)
        energy = float(combined[mask].sum())
        mid, side = float(mid_power[mask].sum()), float(side_power[mask].sum())
        bands.append({"hz": [low, high], "rmsDbFS": db(np.sqrt(energy)), "energyPercent": energy / total * 100 if total else 0,
                      "sideToMidDb": db(np.sqrt(side / mid)) if mid else None})
    return bands


def window_levels(data, rate):
    window = int(.4 * rate)
    count = len(data) // window
    levels = np.sqrt(np.mean(data[:count * window].astype(np.float64).reshape(count, window, 2) ** 2, axis=(1, 2)))
    log = 20 * np.log10(np.maximum(levels, 1e-15))
    p10, p50, p90 = np.percentile(log, [10, 50, 90])
    threshold = max(-120, float(np.max(log)) - 40)
    active = log[log > threshold]
    finite_level = lambda value: float(value) if value > -120 else None
    return {"windowSeconds": .4, "hopSeconds": .4, "numberOfWindows": count,
            "p10DbFS": finite_level(p10), "medianDbFS": finite_level(p50), "p90DbFS": finite_level(p90),
            "p90MinusP10Db": float(p90 - p10) if p10 > -120 else None,
            "windowsBelowMinus60DbFS": int((log < -60).sum()),
            "activeWindowThresholdDbFS": threshold, "activeWindows": len(active),
            "activeWindowP90MinusP10Db": float(np.percentile(active, 90) - np.percentile(active, 10)) if len(active) else None,
            "rmsDbFSByWindow": [round(float(value), 3) if value > -120 else None for value in log],
            "silenceHandling": "Values <=-120dBFS shown as null; no artificial 250+dB range from exact silence. Active windows exceed max(-120dBFS,loudest400msWindow-40dB)."}


def loudness(path, duration):
    cmd = [FFMPEG, "-hide_banner", "-nostdin", "-i", str(path), "-t", str(duration),
           "-af", "atrim=end=24,loudnorm=I=-23:TP=-1:LRA=11:print_format=json", "-f", "null", "-"]
    run = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, check=True)
    result = json.loads(re.findall(r"\{\s*\"input_i\".*?\}", run.stderr, re.S)[-1])
    return {"integratedLUFS": float(result["input_i"]), "truePeakDbTP": float(result["input_tp"]),
            "loudnessRangeLU": float(result["input_lra"]), "method": "FFmpeg loudnorm input measurement (192 kHz true-peak analysis), output discarded; no input normalization or file changes", "reportedPrecisionDb": .01}


def attack_candidates(data, rate):
    # Describe measurable rising-energy clusters only; these are not transcribed notes.
    hop = round(rate * .005)
    count = len(data) // hop
    envelope = np.sqrt(np.mean(data[:count * hop].astype(np.float64).reshape(count, hop, 2) ** 2, axis=(1, 2)))
    rising = np.maximum(0, np.diff(envelope, prepend=0))
    median = float(np.median(rising))
    mad = float(np.median(np.abs(rising - median)))
    threshold = max(float(rising.max()) * .08, median + 6 * mad, 1e-7)
    candidates = [i for i in range(1, count - 1) if rising[i] >= threshold and rising[i] >= rising[i - 1] and rising[i] > rising[i + 1] and envelope[i] >= envelope.max() * .01585]
    accepted = []
    separation = round(.03 * rate / hop)
    for i in sorted(candidates, key=lambda j: rising[j], reverse=True):
        if all(abs(i - j) >= separation for j in accepted):
            accepted.append(i)
    times = sorted(i * hop / rate for i in accepted)
    gaps = np.diff(times)
    return {"method": "5 ms nonoverlapping stereo RMS, positive envelope difference local maxima; threshold=max(8% maximum rise, median+6MAD,1e-7), energy>=-36dB relative max; strongest-first 30ms separation",
            "count": len(times), "timesSeconds": [round(t, 5) for t in times],
            "intervalMedianSeconds": float(np.median(gaps)) if len(gaps) else None,
            "intervalP10Seconds": float(np.percentile(gaps, 10)) if len(gaps) else None,
            "intervalP90Seconds": float(np.percentile(gaps, 90)) if len(gaps) else None,
            "limitation": "Attack candidates, not note counts or a beat tracker. Thresholding can merge rolls or include internal sample peaks; do not infer reference tempo/groove from these."}


def energy_bursts(data, rate):
    hop = round(rate * .005)
    window = round(rate * .02)
    energy = np.mean(data.astype(np.float64) ** 2, axis=1)
    cumulative = np.concatenate([[0], np.cumsum(energy)])
    starts = np.arange(0, len(data) - window + 1, hop)
    envelope = np.sqrt((cumulative[starts + window] - cumulative[starts]) / window)
    active = envelope >= max(float(envelope.max()) * .08, 1e-8)
    # Bridge sub-20ms holes caused by the waveform within a single hit.
    indices = np.flatnonzero(active)
    groups = np.split(indices, np.flatnonzero(np.diff(indices) > 4) + 1) if len(indices) else []
    times = [float(starts[g[0]]) / rate for g in groups if len(g)]
    gaps = np.diff(times)
    return {"method": "20ms stereo RMS windows / 5ms hop; activity above 8% max envelope; bridge holes <=20ms. Forward window can place reported start up to20ms early.",
            "count": len(times), "timesSeconds": [round(t, 5) for t in times],
            "intervalMedianSeconds": float(np.median(gaps)) if len(gaps) else None,
            "intervalP10Seconds": float(np.percentile(gaps, 10)) if len(gaps) else None,
            "intervalP90Seconds": float(np.percentile(gaps, 90)) if len(gaps) else None,
            "limitation": "Isolated kick/clap energy bursts only, not perceived rhythm or exact onset transcription. Thresholds can merge close hits."}


def measure(path, kind, matching=None):
    full, rate = decode(path)
    data = full[:24 * rate]
    if len(data) != 24 * rate:
        raise ValueError("Expected at least 24 seconds")
    rms = float(np.sqrt(np.mean(data.astype(np.float64) ** 2)))
    peak = float(np.abs(data).max())
    mid = (data[:, 0].astype(np.float64) + data[:, 1]) * .5
    side = (data[:, 0].astype(np.float64) - data[:, 1]) * .5
    mid_energy, side_energy = float(np.mean(mid ** 2)), float(np.mean(side ** 2))
    record = {"path": str(path), "sha256": sha(path), "kind": kind,
              "sourceFrames": len(full), "sourceDurationSeconds": len(full) / rate,
              "analysisRangeSeconds": [0, 24], "analysisFrames": len(data), "sampleRate": rate, "channels": 2,
              "samplePeakLinear": peak, "samplePeakDbFS": db(peak), "stereoRMSDbFS": db(rms),
              "crestDb": db(peak / rms) if rms else None,
              "samplesAtOrAboveFullScale": int((np.abs(data) >= 1).sum()),
              "bands": spectral(data, rate), "windowRMS": window_levels(data, rate),
              "stereo": {"midDefinition": "(L+R)/2", "sideDefinition": "(L-R)/2",
                         "midRMSDbFS": db(np.sqrt(mid_energy)), "sideRMSDbFS": db(np.sqrt(side_energy)),
                         "sideToMidDb": db(np.sqrt(side_energy / mid_energy)) if mid_energy else None,
                         "sideEnergyPercentOfMidPlusSide": side_energy / (side_energy + mid_energy) * 100 if mid_energy + side_energy else 0,
                         "leftRightCorrelation": float(np.corrcoef(data.T)[0, 1]) if rms else None}}
    if matching:
        record["matchingProvenance"] = matching
    if rms:
        record["loudness"] = loudness(path, 24)
    if kind == "isolated-drum-role":
        if path.name in ("role-kick-dry.wav", "role-clap-dry.wav"):
            record["energyBursts"] = energy_bursts(data, rate)
        elif path.name == "role-hat-dry.wav":
            record["risingEnergyCandidates"] = attack_candidates(data, rate)
        else:
            record["transientSpacing"] = "Not reported: internal sample ringing makes unvalidated envelope-peak counts ambiguous."
    return record


def main():
    plan_path = OUT / "auditions-v1-inputs.json"
    plan = json.loads(plan_path.read_text())
    jobs = plan.get("requests", plan.get("items", []))
    if not jobs:
        jobs = next(value for value in plan.values() if isinstance(value, list) and value and isinstance(value[0], dict) and "id" in value[0])
    matching = {}
    for job in jobs:
        if job.get("kind") == "neutral-label-comparison":
            for item in job["items"]:
                filename = Path(item["matchedPath"]).name
                matching[filename] = {k: item[k] for k in ("source", "sourceRangeSeconds", "gainDb", "inverseGainDb", "matchedSHA256")}
    measurements = []
    for path in sorted(AUDITIONS.glob("comparison-*-matched.wav")):
        provenance = matching[path.name]
        if sha(path) != provenance["matchedSHA256"]:
            raise ValueError(f"Matched input hash changed: {path}")
        measurements.append(measure(path, "matched-full-mix", provenance))
    for path in sorted(CURRENT.glob("*-dry.wav")):
        role = path.stem.removeprefix("role-").removesuffix("-dry")
        kind = "isolated-drum-role" if role in ("kick", "clap", "hat", "open", "perc") else "dry-group" if not path.name.startswith("role-") else "isolated-role"
        measurements.append(measure(path, kind))
    project_path = CURRENT / "project.ish.json"
    project = json.loads(project_path.read_text())
    assets = {a["id"]: a for a in project["assets"]}
    presets = {p["id"]: p for p in project.get("soundBank", {}).get("presets", [])}
    bank = json.loads(subprocess.check_output([NODE, "--import", "tsx", "--input-type=module", "-e",
        "import {PRESETS} from './src/audio/bank.ts'; console.log(JSON.stringify(PRESETS));"], cwd=ROOT, text=True))
    fallback_presets = {p["id"]: p for p in bank}
    tracks = []
    for t in project["candidates"][project["selected"]]["tracks"]:
        item = {k: t.get(k) for k in ("id", "instrument", "volume", "pan", "register", "mute", "solo", "effects")}
        notes = t["notes"]
        item["sourcePattern"] = {"noteCount": len(notes), "pitchRangeMidi": [min(n["pitch"] for n in notes), max(n["pitch"] for n in notes)] if notes else None,
                                 "velocityMinMedianMax": [float(f([n["velocity"] for n in notes])) for f in (np.min, np.median, np.max)] if notes else None,
                                 "durationTicksMinMedianMax": [float(f([n["duration"] for n in notes])) for f in (np.min, np.median, np.max)] if notes else None,
                                 "legatoNotes": sum(n.get("articulation") == "legato" for n in notes), "glideNotes": sum(bool(n.get("glide")) for n in notes)}
        a = assets.get(t["instrument"])
        if a:
            item["sample"] = {k: a.get(k) for k in ("name", "hash", "gain", "root", "tuning", "envelopeMode", "duration", "trimStart", "trimEnd", "sampleRate", "channels", "choke", "envelope")}
            item["nominalTrackTimesAssetGain"] = t["volume"] * a["gain"]
        else:
            item["resolvedPreset"] = presets.get(t["instrument"], fallback_presets.get(t["instrument"]))
            item["presetOrigin"] = "embedded project" if t["instrument"] in presets else "src/audio/bank.ts fallback; hash checked against render snapshot"
        tracks.append(item)
    report = json.loads((CURRENT / "render-report.json").read_text())
    snapshot = {x["path"]: x["sha256"] for x in report["engine"]["sourceFiles"]}
    paths = ["src/audio/graph.ts", "src/audio/character.ts", "src/audio/bank.ts", "src/audio/processing.ts", "src/engine/score.ts"]
    result = {"schemaVersion": 1, "createdAt": datetime.now(timezone.utc).isoformat(),
              "scope": "Supporting measurements of existing rendered stereo. No audio-language model run, hearing claim, perceptual diagnosis, production edit or universal target.",
              "inputManifest": {"path": str(plan_path), "sha256": sha(plan_path)},
              "methods": {"analysis": "First 24 seconds for all files, excluding current render tail; originals unchanged.",
                          "bands": "Exact full-window rFFT Parseval mean-square energy, stereo channel average, rectangular 24s window; bins split at documented boundaries. Boundary leakage is possible; no perceptual weighting.",
                          "rmsReference": "Full-scale sample amplitude 1.0; stereo RMS is sqrt(mean(L^2,R^2)); a full-scale sine is -3.01dBFS.",
                          "range": "400ms nonoverlapping RMS P90-P10 is a descriptive energy range, not loudness range. FFmpeg input LRA is reported separately and unstable on short excerpts.",
                          "stereo": "Computed from untouched stereo channels of the matched/dry files, never the ALM mono derivative. Energy width is not perceived spatial width.",
                          "truePeak": "FFmpeg loudnorm input_tp uses oversampled analysis, output discarded. Its I=-23/TP=-1 parameters are analyzer output settings, not adopted mastering targets.",
                          "dryLevels": "Dry taps retain source-track levels before common .73 master gain, listening gain and master processing; compare their relationships, not raw loudness to matched masters."},
              "project": {"path": str(project_path), "sha256": sha(project_path), "settings": project["settings"], "sections": project["sections"], "tagEnabled": project["tagEnabled"], "tracks": tracks},
              "codeAudit": [{"path": p, "currentSHA256": sha(ROOT / p), "renderSnapshotSHA256": snapshot.get(p), "unchangedSinceRender": sha(ROOT / p) == snapshot.get(p)} for p in paths],
              "measurements": measurements,
              "caveats": ["References contain lead rap and commercial mastering; current is instrumental. Midrange, crest, level movement and attack detection are not isolated beat-production comparisons.", "Two reference windows cannot establish one TDF production formula.", "No note pitches, source-instrument identities, musical quality, stereo perception or transcription are established by these statistics.", "Shared-FX summing and headroom reconstruction were not repeated; refer to existing current/extra-audit.json."]}
    destination = OUT / "current-numerical-comparison.json"
    destination.write_text(json.dumps(result, indent=2, allow_nan=False) + "\n")
    print(json.dumps({"saved": str(destination), "filesMeasured": len(measurements)}))


if __name__ == "__main__":
    main()
