#!/usr/bin/env python3
"""Prepare anonymous, audited comparison inputs; no inference or music changes."""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
import math
import os
from pathlib import Path
import shutil
import subprocess

os.environ["OMP_NUM_THREADS"] = "1"
os.environ["OPENBLAS_NUM_THREADS"] = "1"
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "deliverables/audio-research"
PRIVATE = ROOT / "private-assets/audio-research/comparison-reels-v1"
FFMPEG = "/opt/homebrew/bin/ffmpeg"
RATE = 44100
GAP = RATE
LIMIT = 20 * RATE


def sha(path):
    with Path(path).open("rb") as f:
        return hashlib.file_digest(f, "sha256").hexdigest()


def pcm_hash(data):
    return hashlib.sha256(data.astype("<f4").tobytes()).hexdigest()


def write_json(path, data):
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False, allow_nan=False) + "\n")


def decode(path, start=0, end=None, resample=False):
    command = [FFMPEG, "-v", "error", "-nostdin", "-threads", "1", "-filter_threads", "1", "-i", str(path), "-map", "0:a:0"]
    filters = []
    if resample:
        filters.append("aresample=44100")
    if start or end is not None:
        filters.append(f"atrim=start_sample={start}" + (f":end_sample={end}" if end is not None else ""))
    if filters:
        command += ["-af", ",".join(filters)]
    command += ["-ac", "2", "-f", "f32le", "-c:a", "pcm_f32le", "-"]
    raw = subprocess.check_output(command)
    data = np.frombuffer(raw, dtype="<f4").reshape(-1, 2)
    if not len(data) or not np.isfinite(data).all():
        raise ValueError(f"Invalid audio: {path}")
    return data.copy()


def measure(path, end=None):
    filters = ([f"atrim=end_sample={end}"] if end is not None else []) + ["loudnorm=I=-20:TP=-2:LRA=11:print_format=json"]
    result = subprocess.run([FFMPEG, "-hide_banner", "-nostdin", "-threads", "1", "-filter_threads", "1", "-i", str(path),
        "-af", ",".join(filters), "-f", "null", "-"], capture_output=True, text=True, check=True)
    return json.JSONDecoder().raw_decode(result.stderr[result.stderr.rfind("{"):])[0]


def write_wav(path, data):
    subprocess.run([FFMPEG, "-v", "error", "-nostdin", "-f", "f32le", "-ar", str(RATE), "-ac", "2", "-i", "-",
        "-c:a", "pcm_f32le", str(path)], input=data.astype("<f4").tobytes(), check=True)
    readback = decode(path)
    if not np.array_equal(readback, data):
        raise ValueError(f"WAV readback differs: {path}")
    return {"path": str(path), "sha256": sha(path), "bytes": path.stat().st_size,
        "frames": len(readback), "sampleRate": RATE, "channels": 2, "durationSeconds": len(readback) / RATE,
        "decodedFloat32SHA256": pcm_hash(readback), "maximumReadbackError": 0.0}


def flac_companion(wav_path, data):
    path = wav_path.with_suffix(".flac")
    subprocess.run([FFMPEG, "-v", "error", "-nostdin", "-threads", "1", "-i", str(wav_path),
        "-c:a", "flac", "-sample_fmt", "s32", "-bits_per_raw_sample", "24", str(path)], check=True)
    readback = decode(path)
    if readback.shape != data.shape:
        raise ValueError("FLAC frame count changed")
    error = float(np.max(abs(readback - data)))
    if error > 2**-23 + 1e-9:
        raise ValueError(f"Unexpected FLAC quantization error: {error}")
    return {"path": str(path), "sha256": sha(path), "bytes": path.stat().st_size,
        "frames": len(readback), "sampleRate": RATE, "channels": 2, "durationSeconds": len(readback) / RATE,
        "decodedFloat32SHA256": pcm_hash(readback), "maximumDifferenceFromFloat32Wav": error,
        "processing": "24-bit PCM quantization, then lossless FLAC compression; no sample-rate, channel, timing, gain or dynamic-processing change. WAV is the exact float32 master."}


def save_reel(identifier, pieces, items, prompt, extra):
    joined = []
    gaps = []
    position = 0
    for index, (data, item) in enumerate(zip(pieces, items)):
        item.update({"label": chr(65 + index), "reelRangeFrames": [position, position + len(data)],
            "reelRangeSeconds": [position / RATE, (position + len(data)) / RATE], "renderedFloat32SHA256": pcm_hash(data)})
        joined.append(data)
        position += len(data)
        if index + 1 < len(pieces):
            joined.append(np.zeros((GAP, 2), np.float32))
            gaps.append({"rangeFrames": [position, position + GAP], "rangeSeconds": [position / RATE, (position + GAP) / RATE], "kind": "artificial_exact_zero"})
            position += GAP
    audio = np.concatenate(joined)
    path = PRIVATE / f"{identifier}.wav"
    wav = write_wav(path, audio)
    flac = flac_companion(path, audio)
    for item, data in zip(items, pieces):
        a, b = item["reelRangeFrames"]
        assert np.array_equal(audio[a:b], data)
    for gap in gaps:
        a, b = gap["rangeFrames"]
        assert np.count_nonzero(audio[a:b]) == 0
    ranges = "; ".join(f"{item['label']} {item['reelRangeSeconds'][0]:.5f}–{item['reelRangeSeconds'][1]:.5f}s" for item in items)
    text = f"This audio contains {len(items)} separate items: {ranges}. The one-second gaps BETWEEN items are artificial. Any silence inside a labeled range belongs to its source. Excerpts can stop mid-phrase; do not judge the hard excerpt cuts as source arrangement mistakes.\n\n" + prompt
    prompt_path = PRIVATE / f"{identifier}-prompt.txt"
    prompt_path.write_text(text + "\n")
    return {"id": identifier, "status": "prepared_not_submitted", "preferredUpload": flac,
        "float32Wav": wav, "promptPath": str(prompt_path), "promptSHA256": sha(prompt_path),
        "items": items, "artificialGaps": gaps, "frameAudit": "Every item and zero-gap maps to its recorded half-open frame range; float32 WAV readback is exact.", **extra}


def loop_inputs(records):
    prepared = []
    for record in records:
        source = record["source"]
        if source["sampleRate"] != RATE or source["channels"] != 2:
            raise ValueError("Current loop manifest expected native 44.1kHz stereo; explicit new handling required")
        if sha(source["path"]) != source["sha256"] or sha(record["audioPath"]) != record["audioSHA256"]:
            raise ValueError("Authoritative source/derivative hash changed")
        frames = min(LIMIT, source["frames"])
        data = decode(record["audioPath"], end=frames)
        original = decode(source["path"], end=frames)
        if not np.array_equal(data, original):
            raise ValueError("Existing loop derivative differs from freshly decoded source excerpt")
        measured = measure(record["audioPath"], frames)
        loudness = float(measured["input_i"])
        true_peak = float(measured["input_tp"])
        if not math.isfinite(loudness + true_peak):
            raise ValueError("Nonfinite loop loudness; use a separately documented level strategy")
        prepared.append({"record": record, "frames": frames, "measurement": measured, "rawPCMHash": pcm_hash(data)})
        print(json.dumps({"measured": record["id"], "seconds": frames / RATE}), flush=True)
    target = min([-20.0] + [min(float(x["measurement"]["input_i"]), float(x["measurement"]["input_i"]) - 2 - float(x["measurement"]["input_tp"])) for x in prepared])
    reels = []
    for block in range(0, len(prepared), 5):
        pieces, items = [], []
        for item in prepared[block:block + 5]:
            record = item["record"]; source = record["source"]
            data = decode(record["audioPath"], end=item["frames"])
            gain_db = target - float(item["measurement"]["input_i"])
            assert gain_db <= 1e-9
            gain = 10 ** (gain_db / 20)
            processed = data * gain
            pieces.append(processed)
            items.append({"auditionsInputId": record["id"], "source": source, "sourceCredit": record.get("sourceCredit"),
                "sourceRangeFrames": [0, item["frames"]], "sourceRangeSeconds": [0, item["frames"] / RATE],
                "wholeOriginalSourceIncluded": item["frames"] == source["frames"],
                "authoritativePreparedInput": {"path": record["audioPath"], "sha256": record["audioSHA256"], "selectedRangeFrames": [0, item["frames"]]},
                "rawSelectedFloat32SHA256": item["rawPCMHash"], "rawSourceToPreparedMaxError": 0.0,
                "gainDb": gain_db, "linearGain": gain, "inverseGainDb": -gain_db, "originalMeasurement": item["measurement"],
                "sourceCreditRequirementText": "USE TAG!!" if "USE TAG!!" in Path(source["path"]).name else None,
                "boundaryInterpretation": "First 20 seconds or complete shorter source; selection is mechanical and not an approved downbeat/loop region."})
        prompt = (f"The five source excerpts have been matched to approximately {target:.2f} integrated LUFS with constant attenuation only; no added effects, pitch change, layering or compression. "
            "Do not use louder as better. For each A–E, briefly describe the audible foreground timbre, register and envelope; supporting layers and harmonic density; any drums, bass or voices already baked into the source; and one audible repetition or change if present. "
            "Then compare the strengths and limitations of each as the single melodic foundation of a new instrumental, considering available space for separately written drums, bass and occasional vocal punctuation. "
            "Do not assume an unrelated existing melody would be stacked over it. Do not force a winner or infer artist, song, exact preset, key or BPM. "
            "Distinguish observation from uncertainty, and do not quote lyrics. Keep the answer under 450 words, indexed A–E.")
        reel = save_reel(f"loop-comparison-{block // 5 + 1:02d}", pieces, items, prompt,
            {"kind": "five-loop-comparison", "targetIntegratedLUFS": target, "sourceOrder": "Existing inventory order, no quality ranking or randomized order claim",
             "processing": "First 20s (or complete shorter source), native stereo 44.1kHz, constant per-item attenuation only, four 1s artificial gaps; no fades or musical arrangement."})
        reel["measurement"] = measure(reel["float32Wav"]["path"])
        if float(reel["measurement"]["input_tp"]) > -1:
            raise ValueError("Reel unexpectedly exceeds -1dBTP measurement guard")
        reels.append(reel)
    return reels


def support_input(identifier, records):
    pieces, items = [], []
    for record in records:
        if sha(record["audioPath"]) != record["audioSHA256"]:
            raise ValueError("Authoritative support reel changed")
        original_reel = decode(record["audioPath"])
        for item in record["items"]:
            source = item["source"]
            if sha(source["path"]) != source["sha256"]:
                raise ValueError("Support source changed")
            a, b = round(item["startSeconds"] * RATE), round(item["endSeconds"] * RATE)
            data = original_reel[a:b].copy()
            original = decode(source["path"], resample=True)
            original *= 10 ** (item["gainDb"] / 20)
            if original.shape != data.shape:
                raise ValueError("Support source frame mapping changed")
            delta = float(np.max(abs(original - data)))
            if delta > 2**-23:
                raise ValueError("Support source mapping/gain differs")
            # Prior preparation already used peak-safe attenuation. Preserve it exactly.
            if float(np.max(abs(data))) > .890001:
                raise ValueError("Prior support preparation exceeds known peak ceiling")
            pieces.append(data)
            items.append({"auditionsInputId": record["id"], "auditionsItemIndex": item["index"], "source": source, "sourceCredit": item.get("credit"),
                "sourceRangeFrames": [0, source["frames"]], "sourceRangeSeconds": [0, source["durationSeconds"]], "wholeOriginalSourceIncluded": True,
                "authoritativePreparedInput": {"path": record["audioPath"], "sha256": record["audioSHA256"], "selectedRangeFrames": [a, b]},
                "totalGainDb": item["gainDb"], "inverseGainDb": item["inverseGainDb"], "additionalGainDb": 0,
                "sourceReconstructionMaximumError": delta,
                "sourceProcessing": "Retains prior 44.1kHz stereo derivative and attenuation exactly. Native 48kHz sources were resampled; the native mono source was upmixed. Original metadata is retained."})
    prompt = ("Describe each labeled sound briefly, focusing on speech versus nonverbal vocal/electronic sound, attack/length, register or pitch motion, filtering, distortion, delay/repeats, reverb and perceived width only where audible. "
        "Say whether its event shape could support a pickup, short punctuation or a longer background response, and what might make placement difficult; these are possible uses, not an existing arrangement. "
        "Some sources may be another producer's tag: do not infer identity/ownership or treat it as a new producer identity. Do not guess artist, preset, exact notes or tempo. "
        "Do not invent lyrics; state uncertainty for very short or ambiguous items. Source levels have only been attenuated for peak safety and are not loudness matched. "
        "Use one short indexed row per item and at most 550 words overall.")
    return save_reel(identifier, pieces, items, prompt, {"kind": "supplied-tag-or-vox-reel",
        "processing": "Full existing source items with exact 1s gaps between them, retaining prior gain/resampling. No added musical placement or effects.",
        "selectionBasis": "All matching source items from the existing audited inventory, in existing order; no filename-based sonic classification beyond inventory grouping."})


def identity_input():
    provenance_path = ROOT / "private-assets/audio-research/identity-tag/provenance.json"
    provenance = json.loads(provenance_path.read_text())
    source = next(f for f in provenance["files"] if f["path"].endswith("-original.wav"))
    if sha(source["path"]) != source["sha256"]:
        raise ValueError("Identity source changed")
    output = PRIVATE / "identity-voice-dry.wav"
    shutil.copyfile(source["path"], output)
    assert sha(output) == source["sha256"]
    prompt = ("Listen to this short standalone recording. What short phrase is actually intelligible? If unclear, say so. Describe the voice's register, cadence, articulation and dry/ambient quality. "
        "Identify any audible cut, noise or effect only if present. There is no supplied music context: do not invent accompaniment or an existing tag placement. "
        "Give two possible treatment directions that preserve intelligibility, clearly labeled suggestions rather than audible effects. Under 140 words.")
    prompt_path = PRIVATE / "identity-voice-dry-prompt.txt"; prompt_path.write_text(prompt + "\n")
    return {"id": "identity-voice-dry", "kind": "original-spoken-identity-candidate", "status": "prepared_not_submitted",
        "preferredUpload": {"path": str(output), "sha256": sha(output), "bytes": output.stat().st_size,
            "durationSeconds": next(x["durationSeconds"] for x in provenance["attempts"] if x["status"].startswith("real_audio"))},
        "source": source, "provenance": {"path": str(provenance_path), "sha256": sha(provenance_path)},
        "promptPath": str(prompt_path), "promptSHA256": sha(prompt_path),
        "processing": "Byte-identical copy with anonymous upload filename. Original native mono format/rate, no new treatment. Identity text is absent from the analysis prompt."}


def main():
    parser = argparse.ArgumentParser(description=__doc__); parser.parse_args()
    if PRIVATE.exists():
        raise SystemExit("Refusing to overwrite comparison-reels-v1; use a new preparation version.")
    PRIVATE.mkdir(parents=True)
    manifest_path = OUT / "auditions-v1-inputs.json"
    manifest = json.loads(manifest_path.read_text())
    records = manifest["records"]
    loops = sorted((r for r in records if r["kind"] == "loop-screen"), key=lambda r: r["id"])
    assert len(loops) == 20
    reels = loop_inputs(loops)
    reels.append(identity_input())
    reels.append(support_input("supplied-support-voices", [r for r in records if r["id"].startswith("reel-support-vox-")]))
    reels.append(support_input("supplied-culture-voices", [r for r in records if r["id"].startswith("reel-culture-vox-")]))
    source_paths = {item["source"]["path"]: item["source"]["sha256"] for reel in reels for item in reel.get("items", [])}
    assert all(sha(path) == digest for path, digest in source_paths.items())
    result = {"schemaVersion": 1, "createdAt": datetime.now(timezone.utc).isoformat(), "status": "prepared_not_submitted",
        "authoritativeInputManifest": {"path": str(manifest_path), "sha256": sha(manifest_path)},
        "script": {"path": str(Path(__file__).resolve()), "sha256": sha(Path(__file__))},
        "records": reels, "sourceHashesUnchanged": True, "inferenceRun": False,
        "notes": ["Four separate five-item loop screens; only first 20s or shorter complete source, not full-source listening coverage.",
            "FLAC upload companions use 24-bit quantization; exact float32 WAV masters and readback error bounds are retained.",
            "Loudnorm was used only to measure; rendered loops receive constant attenuation, never loudnorm processing or amplification.",
            "Original producer attribution/tag requirements remain in source mapping; supplied identities are not relabeled ishmakethebeat.",
            "No original audio, project, musical score, engine tuning or saved proof was changed."]}
    write_json(OUT / "comparison-reels-v1-inputs.json", result)
    lines = ["Prepared comparison reels; no model submission or musical selection occurred in this step.", "",
        "Four loop reels use sources 01–05, 06–10, 11–15 and 16–20 in their existing order. Each uses the first 20s, except LOOP10, whose complete source is 12.387s. One second of exact-zero silence separates items. All loop sources are native 44.1kHz stereo; their selected PCM is checked against freshly decoded originals before attenuation.", "",
        "| Input | Duration | Items | Upload file | Prompt |", "|---|---:|---:|---|---|"]
    for reel in reels:
        upload = reel["preferredUpload"]
        lines.append(f"| {reel['id']} | {upload['durationSeconds']:.3f}s | {len(reel.get('items', [])) or 1} | `{Path(upload['path']).name}` | `{Path(reel['promptPath']).name}` |")
    lines += ["", "The private input directory is `private-assets/audio-research/comparison-reels-v1`. The full source/credit/hash/frame mapping and prompts are in `deliverables/audio-research/comparison-reels-v1-inputs.json`.", "",
        "Loop excerpts share an integrated-loudness target chosen conservatively from all 20 measurements. Constant attenuation is reversible; no dynamics processing was rendered. Short support sources preserve previous peak-safe attenuation and are not loudness matched. The identity voice is a byte-identical copy with an anonymous filename, distinct from other producers' supplied tags.", "",
        "The exact float32 stereo WAVs are retained. Smaller FLAC companions introduce only explicitly measured 24-bit PCM quantization before lossless compression, with identical frame counts. Boundary cuts and the one-second gaps are research formatting, not evidence of source arrangements. Source silence inside an item is retained, including the long quiet ending within the first 20s of one Carti candidate.", "",
        "Original files and source hashes are unchanged. These are pending inputs, not findings or a loop-quality ranking."]
    (ROOT / "docs/audio-research/comparison-reels.md").write_text("\n".join(lines) + "\n")
    print(json.dumps({"inputs": len(reels), "manifest": str(OUT / "comparison-reels-v1-inputs.json"), "inferenceRun": False}), flush=True)


if __name__ == "__main__":
    main()
