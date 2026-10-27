#!/usr/bin/env python3
"""Prepare traceable local-model inputs; no inference or musical ranking.

Original samples stay untouched. Reels retain every source frame, followed by
declared silence; they are research comparisons, never generated compositions.
"""
from __future__ import annotations
import hashlib
import json
from pathlib import Path
import subprocess
import sys

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "deliverables/audio-research"
PRIVATE = ROOT / "private-assets/audio-research/auditions-v1"
MODEL = "mlx-community/MOSS-Music-8B-Thinking-8bit"
FFMPEG = "/opt/homebrew/bin/ffmpeg"
FFPROBE = "/opt/homebrew/bin/ffprobe"


def sha(path):
    with Path(path).open("rb") as f:
        return hashlib.file_digest(f, "sha256").hexdigest()


def write_new(path, value):
    with path.open("x") as f:
        f.write(json.dumps(value, indent=2, ensure_ascii=False) + "\n")


def decode(path):
    probe = json.loads(subprocess.check_output([
        FFPROBE, "-v", "error", "-select_streams", "a:0", "-show_entries",
        "stream=sample_rate,channels", "-of", "json", str(path)
    ]))["streams"][0]
    native_rate, channels = int(probe["sample_rate"]), int(probe["channels"])
    raw = subprocess.check_output([FFMPEG, "-v", "error", "-i", str(path),
        "-map", "0:a:0", "-f", "f32le", "-c:a", "pcm_f32le", "-"])
    a = np.frombuffer(raw, dtype="<f4").reshape(-1, channels)
    if not a.size or not np.isfinite(a).all():
        raise ValueError(f"Empty or nonfinite input: {path}")
    meta = {"path": str(path), "sha256": sha(path), "sampleRate": native_rate,
            "channels": channels, "frames": len(a), "durationSeconds": len(a) / native_rate,
            "decodedFloat32SHA256": hashlib.sha256(raw).hexdigest()}
    pcm = subprocess.check_output([FFMPEG, "-v", "error", "-i", str(path),
        "-map", "0:a:0", "-ar", "44100", "-ac", "2", "-f", "f32le", "-c:a", "pcm_f32le", "-"])
    return np.frombuffer(pcm, dtype="<f4").reshape(-1, 2).copy(), meta


def wav(path, data):
    if path.exists():
        raw = subprocess.check_output([FFMPEG, "-v", "error", "-i", str(path),
            "-f", "f32le", "-c:a", "pcm_f32le", "-"])
        if raw != data.astype("<f4").tobytes():
            raise ValueError(f"Existing preparation differs: {path}")
        return
    subprocess.run([FFMPEG, "-v", "error", "-nostdin", "-f", "f32le", "-ar", "44100",
        "-ac", "2", "-i", "-", "-c:a", "pcm_f32le", str(path)], input=data.astype("<f4").tobytes(), check=True)


def measure(path):
    p = subprocess.run([FFMPEG, "-hide_banner", "-nostdin", "-i", str(path),
        "-af", "loudnorm=I=-20:TP=-2:LRA=11:print_format=json", "-f", "null", "-"], capture_output=True, text=True, check=True)
    return json.JSONDecoder().raw_decode(p.stderr[p.stderr.rfind("{"):])[0]


def main():
    if PRIVATE.exists() and "--resume" not in sys.argv:
        raise SystemExit("Refusing to overwrite auditions-v1; choose a new preparation version.")
    PRIVATE.mkdir(parents=True, exist_ok=True)
    inventory = json.loads((OUT / "local-input-inventory.json").read_text())
    by_id = {x["id"]: x for x in inventory["inventory"]}
    queue = inventory["candidateQueue"]
    requests, records = [], []

    def request(identifier, path, prompt, metadata):
        prompt_path = PRIVATE / f"{identifier}-prompt.txt"
        prompt_path.write_text(prompt + "\n")
        proof = OUT / "proofs" / f"{identifier}-local-moss-8bit-v1.json"
        if proof.exists():
            raise ValueError(f"Proof exists: {proof}")
        requests.append({"id": identifier, "arguments": [
            "--model", MODEL, "--audio", str(path), "--prompt-file", str(prompt_path),
            "--proof", str(proof), "--max-tokens", "2048", "--cache-limit-mib", "256"]})
        records.append({"id": identifier, "audioPath": str(path), "audioSHA256": sha(path),
                        "promptPath": str(prompt_path), "proofPath": str(proof),
                        "status": "prepared_not_submitted", **metadata})

    loop_prompt = ("Describe the actual musical parts in this audio, in at most 170 words. "
        "What is the dominant melodic sound, its register/envelope, and how do supporting parts interact with it? "
        "Are there bass, drums, or human voices? Does the phrase repeat, and do layers enter or leave? "
        "Describe changes only when audible. Distinguish short vocal punctuation from sustained lead performance. "
        "Do not guess artist, song, source filename, preset, exact notes, key, BPM or lyrics. "
        "Do not assume the excerpt boundary is a song beginning/ending. Mark uncertainty.")
    for index, item in enumerate(x for x in queue if x["tier"] in (1, 5)):
        source = ROOT / item["path"]
        if sha(source) != item["sha256"]:
            raise ValueError(f"Source hash changed: {source}")
        data, meta = decode(source)
        # All primary stash loops are complete; long extra sources are explicitly partial screens.
        end = len(data) if item["tier"] == 1 or len(data) <= 60 * 44100 else 45 * 44100
        clip = PRIVATE / f"loop-screen-{index + 1:02d}.wav"
        wav(clip, data[:end])
        request(f"loop-screen-{index + 1:02d}", clip, loop_prompt,
                {"kind": "loop-screen", "source": meta,
                 "sourceRangeSeconds": [0, end / 44100], "completeSource": end == len(data),
                 "processing": "Stereo 44.1 kHz float32 derivative; no gain, fade, pitch or timing change.",
                 "sourceCredit": by_id.get(item["id"], {}).get("credit"),
                 "selectionBasis": item.get("selectionBasis"), "gridAndHarmony": "not yet verified"})

    # Separate short source classes; a filename category is not a sonic judgment.
    groups = {
        "support-vox": [x for x in queue if x["tier"] == 2],
        "culture-vox": [x for x in queue if x["tier"] == 3 and "/vox/" in x["path"].lower()],
        "culture-bass": [x for x in queue if x["tier"] == 3 and "/808/" in x["path"]],
        "culture-kicks": [x for x in queue if x["tier"] == 3 and "/Kicks/" in x["path"]],
        "palette-one-shots": [x for x in queue if x["tier"] == 4],
    }
    for group, items in groups.items():
        for block in range(0, len(items), 4):
            identifier = f"reel-{group}-{block // 4 + 1:02d}"
            pieces, mapping, at = [], [], 0
            for item in items[block:block + 4]:
                source = ROOT / item["path"]
                if sha(source) != item["sha256"]:
                    raise ValueError(f"Source hash changed: {source}")
                data, meta = decode(source)
                peak = float(np.max(np.abs(data)))
                gain = min(1.0, 0.89 / peak) if peak else 1.0
                pieces.extend([data * gain, np.zeros((44100, 2), np.float32)])
                mapping.append({"index": len(mapping) + 1, "source": meta,
                    "startSeconds": at / 44100, "endSeconds": (at + len(data)) / 44100,
                    "sourceRangeSeconds": [0, meta["durationSeconds"]],
                    "gainDb": float(20 * np.log10(gain)), "inverseGainDb": float(-20 * np.log10(gain)),
                    "credit": by_id.get(item["id"], {}).get("credit")})
                at += len(data) + 44100
            clip = PRIVATE / f"{identifier}.wav"
            data = np.concatenate(pieces)
            if len(data) > 120 * 44100:
                raise ValueError("Research reel exceeds explicit 120-second guard")
            wav(clip, data)
            ranges = "; ".join(f"item {m['index']}: {m['startSeconds']:.3f}–{m['endSeconds']:.3f} seconds" for m in mapping)
            prompt = (f"This is a research reel of separate audio items with one second of silence after each: {ranges}. "
                "For each item, describe its actual sound, attack/decay, pitch movement or repetition, and audible effects. "
                "Distinguish human speech, pitched vocal sound, percussion and electronic tones when possible. "
                "Do not invent a beat, artist, exact note, tempo, plugin or lyric. Do not rank loudness as quality. "
                "If an item is too short or ambiguous, say so. Limit the entire response to 200 words.")
            request(identifier, clip, prompt, {"kind": "indexed-one-shot-reel", "items": mapping,
                "durationSeconds": len(data) / 44100, "processing": "Every source frame once, stereo 44.1 kHz float32; explicit one-second gaps; only per-item reversible attenuation if peak exceeds 0.89. No musical arrangement."})

    for item in json.loads((OUT / "wider-catalogue-inputs.json").read_text())["recordings"]:
        request("wider-" + item["id"], Path(item["source"]["path"]), loop_prompt,
                {"kind": "wider-catalogue-preview", "source": item["source"], "range": item["range"], "creditBasis": item["creditBasis"]})

    # A/B comparison of 24-second excerpts: unknown source labels in the model prompt.
    # All constituents receive constant attenuation to -20 LUFS; no dynamics processing.
    inputs = [("current", OUT / "current/full.wav"),
              ("ref45", ROOT / "private-assets/audio-research/culture-reference-0045-0075-stereo.wav"),
              ("ref1200", ROOT / "private-assets/audio-research/culture-reference-1200-1230-stereo.wav")]
    matched = {}
    for label, source in inputs:
        data, meta = decode(source)
        data = data[:24 * 44100]
        raw = PRIVATE / f"comparison-{label}-raw.wav"
        wav(raw, data)
        measurement = measure(raw)
        gain_db = -20 - float(measurement["input_i"])
        if gain_db > 0:
            raise ValueError("Comparison preparation expects attenuation only")
        data *= 10 ** (gain_db / 20)
        output = PRIVATE / f"comparison-{label}-matched.wav"
        wav(output, data)
        matched[label] = (data, {"source": meta, "sourceRangeSeconds": [0, 24],
            "rawMeasurement": measurement, "gainDb": gain_db, "inverseGainDb": -gain_db,
            "matchedPath": str(output), "matchedSHA256": sha(output), "matchedMeasurement": measure(output)})
    for number, labels in enumerate((("ref45", "current"), ("current", "ref1200")), 1):
        clip = PRIVATE / f"comparison-pair-{number}.wav"
        wav(clip, np.concatenate([matched[labels[0]][0], np.zeros((2 * 44100, 2), np.float32), matched[labels[1]][0]]))
        prompt = ("Compare excerpt A (0–24 seconds) with excerpt B (26–50 seconds). The two-second gap is artificial. "
            "They have been matched in integrated playback loudness by constant gain. Focus on the musical backing: "
            "dominant melodic timbre and density, bass articulation, drum transients and spacing, and how the parts interact. "
            "Account for one excerpt possibly containing a rapper and the other being instrumental. Do not treat missing rap as a production defect. "
            "Describe up to three concrete audible differences and any interference or excessive repetition; do not assume one is newer or better. "
            "No exact tempo/key/preset guesses or lyrics. Give uncertainty; at most 220 words.")
        request(f"comparison-pair-{number}", clip, prompt,
            {"kind": "neutral-label-comparison", "labelMap": {"A": labels[0], "B": labels[1]},
             "items": [matched[x][1] for x in labels], "targetLUFS": -20,
             "processing": "24-second stereo excerpts, attenuation only, two-second silent separator. Original sources unchanged; no limiter or pitch/timing treatment."})

    for label in ("melody", "bass", "drums"):
        source = OUT / "current" / f"{label}-dry.wav"
        if not source.exists():
            # Actual diagnostic filenames remain the source of truth.
            candidates = list((OUT / "current").glob(f"*{label}*dry*.wav"))
            if len(candidates) != 1:
                raise ValueError(f"Cannot resolve current stem {label}: {candidates}")
            source = candidates[0]
        prompt = ("Describe the actual sounds in this isolated stem and how their attacks, lengths, repetition and gaps interact. "
            "Are there discernible changes in articulation or overlapping tones? Describe any audible harshness, click, muddiness or excessive effect tail only if present. "
            "An isolated stem cannot establish its level in the full mix. Do not invent missing accompaniment or vocals. "
            "Do not guess exact notes, tempo, key or plugins. At most 160 words, separating audible observation from uncertainty.")
        request(f"current-stem-{label}", source, prompt, {"kind": "actual-current-app-dry-stem", "sourceSHA256": sha(source)})

    write_new(OUT / "auditions-v1-inputs.json", {"schemaVersion": 1, "records": records, "status": "prepared_not_submitted"})
    write_new(OUT / "auditions-v1-batch.json", {"requests": requests, "model": MODEL, "status": "prepared_not_submitted", "serialExecution": True})
    print(json.dumps({"requests": len(requests), "prepared": str(PRIVATE), "inferenceRun": False}))


if __name__ == "__main__":
    main()
