#!/usr/bin/env python3
"""Read-only signal evidence and exact short clips; no audio-model inference.

Requires NumPy/SciPy. Energy/transient proxies cannot establish instrument,
voice identity, timbre, production quality or model hearing.
"""
from pathlib import Path
import datetime as dt
import hashlib
import json
import subprocess
import numpy as np
from scipy.signal import butter, sosfiltfilt

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "deliverables/audio-research"
TARGET = ROOT / "private-assets/audio-research/beat03-adjudication-v1"


def digest(path):
    h = hashlib.sha256()
    with Path(path).open("rb") as handle:
        for b in iter(lambda: handle.read(1024 * 1024), b""):
            h.update(b)
    return h.hexdigest()


def db(value):
    return 20 * float(np.log10(value)) if value > 0 else None


def main():
    report_path = OUT / "beat03-signal-check-v1.json"
    if TARGET.exists() or report_path.exists():
        raise SystemExit("Preserve existing results; choose a new version before rerunning")
    manifest = OUT / "detailed-v1-inputs.json"
    row = next(r for r in json.loads(manifest.read_text())["records"] if r["id"] == "culture-detailed-beat-03")
    assert digest(row["audioPath"]) == row["audioSHA256"]
    assert digest(row["source"]["filename"]) == row["source"]["sha256"]
    raw = subprocess.check_output(["ffmpeg", "-v", "error", "-i", row["audioPath"], "-f", "f32le", "pipe:1"])
    samples = np.frombuffer(raw, dtype="<f4").reshape(-1, 2)
    sr = row["sampleRate"]
    assert samples.shape == (40 * sr, 2)
    bands = {"full": samples.astype(np.float64)}
    for name, low, high in [("low40_160Hz", 40, 160), ("mid160_2000Hz", 160, 2000), ("high2000_10000Hz", 2000, 10000)]:
        bands[name] = sosfiltfilt(butter(4, [low, high], btype="bandpass", fs=sr, output="sos"), samples, axis=0)
    hop = sr // 100
    # Stereo mean-square avoids phase cancellation from summing channels.
    envelopes = {name: np.sqrt(np.mean(data.reshape(-1, hop, 2) ** 2, axis=(1, 2))) for name, data in bands.items()}
    summaries = []
    for start, end in [(0, 10), (0, 21), (21, 31), (31, 40)]:
        section = {"clipRangeSeconds": [start, end], "sourceRangeSeconds": [705 + start, 705 + end], "bands": {}}
        for name, data in bands.items():
            part = data[start * sr:end * sr]
            env = envelopes[name][start * 100:end * 100]
            rms = float(np.sqrt(np.mean(part * part)))
            # Heuristic transient candidates: >6dB rise over prior50ms mean,
            # >-50dBFS window RMS and at least50ms from previous candidate.
            onsets, last = [], -10
            for i in range(5, len(env)):
                earlier = float(np.mean(env[i - 5:i]))
                if env[i] > 10 ** (-50 / 20) and env[i] > 2 * max(earlier, 1e-9) and i - last >= 5:
                    onsets.append(start + i / 100)
                    last = i
            section["bands"][name] = {"rms": rms, "rmsDbFS": db(rms), "peak": float(np.max(np.abs(part))),
                "envelopeP10DbFS": db(float(np.percentile(env, 10))), "envelopeP50DbFS": db(float(np.percentile(env, 50))),
                "envelopeP90DbFS": db(float(np.percentile(env, 90))), "transientCandidateClipTimes": onsets}
        summaries.append(section)
    TARGET.mkdir(parents=True)
    records = []
    for label, start, end in [("a", 0, 10), ("b", 21, 31), ("c", 31, 40)]:
        path = TARGET / f"probe-{label}-native-stereo.wav"
        data = samples[start * sr:end * sr].astype("<f4").tobytes()
        command = ["ffmpeg", "-v", "error", "-nostdin", "-n", "-f", "f32le", "-ar", str(sr), "-ac", "2",
                   "-i", "pipe:0", "-map_metadata", "-1", "-c:a", "pcm_f32le", str(path)]
        subprocess.run(command, input=data, check=True, capture_output=True)
        decoded = subprocess.check_output(["ffmpeg", "-v", "error", "-i", str(path), "-f", "f32le", "pipe:1"])
        assert decoded == data
        prompt_path = TARGET / f"probe-{label}-prompt.txt"
        prompt_path.write_text(f"Analyze only this attached {end-start}-second audio. Describe the main audible sounds. Are there sustained low-frequency tones, short low-frequency impacts, and repeated sharp upper-frequency attacks? Are human voices clearly present, absent, or uncertain? Describe changes only if clear. Avoid genre, artist, instrument-preset or exact processing guesses, lyrics, stereo-width claims, and invented timings. Say uncertain when needed. At most150 words.\n")
        records.append({"id": f"beat03-probe-{label}", "kind": "short-contradiction-check",
            "audioPath": str(path), "audioSHA256": digest(path), "promptPath": str(prompt_path), "promptSHA256": digest(prompt_path),
            "sampleRate": sr, "channels": 2, "frames": (end - start) * sr, "durationSeconds": end - start,
            "source": {"path": row["source"]["filename"], "sha256": row["source"]["sha256"],
                       "startFrame": (705 + start) * sr, "endFrameExclusive": (705 + end) * sr},
            "sourceRangeSeconds": [705 + start, 705 + end],
            "parentClip": {"path": row["audioPath"], "sha256": row["audioSHA256"], "rangeSeconds": [start, end]},
            "processing": "Exact float32 PCM selection from verified native stereo source excerpt; no gain/filter/fade/resample/pitch change.",
            "decodedFloat32SHA256": hashlib.sha256(data).hexdigest(), "exactDecodedSliceVerified": True,
            "status": "prepared_unsubmitted"})
    report = {"schemaVersion": 1, "generatedAt": dt.datetime.now(dt.timezone.utc).isoformat(),
        "sourceClip": {"path": row["audioPath"], "sha256": row["audioSHA256"], "sampleRate": sr, "channels": 2},
        "method": "Native decoded PCM, stereo mean-square energy; fourth-order Butterworth bands applied with zero-phase forward/reverse filtering for measurement only.10ms envelope. No audio output modified. No model invoked.",
        "transientHeuristic": "10ms RMS >-50dBFS and >6dB over prior50ms mean, separated by50ms; candidates can be synths/voices or edits, not necessarily drums. Lack of candidates does not prove lack of rhythm.",
        "scope": "Tests gross energy/attack differences only. Cannot identify drums, bass instruments, voices, subjective heaviness or prove model hearing. Band energy may include synth/pad harmonics and vocal energy. Exact boundaries are model claims, not independently discovered here.",
        "summaries": summaries, "envelopeStepSeconds": .01,
        "envelopes": {name: [float(x) for x in env] for name, env in envelopes.items()}}
    report_path.write_text(json.dumps(report, indent=2) + "\n")
    inputs = {"schemaVersion": 1, "generatedAt": report["generatedAt"], "records": records,
              "status": "prepared_unsubmitted", "inferenceRun": False, "signalReport": str(report_path)}
    (OUT / "beat03-adjudication-v1-inputs.json").write_text(json.dumps(inputs, indent=2) + "\n")
    print(json.dumps({"report": str(report_path), "summary": [
        {"range": r["sourceRangeSeconds"], "rmsDbFS": {k: v["rmsDbFS"] for k, v in r["bands"].items()},
         "transientCandidates": {k: len(v["transientCandidateClipTimes"]) for k, v in r["bands"].items()}}
        for r in summaries], "clips": records}, indent=2))


if __name__ == "__main__":
    main()
