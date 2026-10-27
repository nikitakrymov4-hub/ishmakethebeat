#!/usr/bin/env python3
"""Assemble three local, original speech candidates without revealing text in the prompt."""
import hashlib
import io
import json
import math
from pathlib import Path
import wave

ROOT = Path(__file__).resolve().parents[1]
PRIVATE = ROOT / "private-assets/audio-research/identity-tag"
OUT = PRIVATE / "revision-v1"


def sha(data):
    return hashlib.sha256(data).hexdigest()


def write_once(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        if path.read_bytes() != data:
            raise ValueError(f"Preserved output already differs: {path}")
        return
    with path.open("xb") as handle:
        handle.write(data)


# The label order deliberately differs from chronological generation order.
specs = [
    ("A", OUT / "ishh-daniel-155.wav", "Ishh make the beat.", 155, OUT / "ishh-daniel-155.aiff"),
    ("B", PRIVATE / "ishmakethebeat-daniel-original.wav", "Ish make the beat.", 178, PRIVATE / "ishmakethebeat-daniel-dry-local-2.aiff"),
    ("C", OUT / "ish-comma-daniel-155.wav", "Ish, make the beat.", 155, OUT / "ish-comma-daniel-155.aiff"),
]
items, pieces, gaps = [], [], []
position = 0
for index, (label, path, text, rate, aiff) in enumerate(specs):
    encoded = path.read_bytes()
    with wave.open(io.BytesIO(encoded), "rb") as wav:
        metadata = (wav.getframerate(), wav.getnchannels(), wav.getsampwidth())
        if metadata != (22050, 1, 3):
            raise ValueError(f"Native format changed; do not silently resample: {path}: {metadata}")
        frames = wav.getnframes()
        pcm = wav.readframes(frames)
    if len(pcm) != frames * 3 or frames < 22050 // 2:
        raise ValueError(f"Empty, short or incomplete speech source: {path}")
    samples = [int.from_bytes(pcm[n:n + 3], "little", signed=True) / 8388608 for n in range(0, len(pcm), 3)]
    peak = max(abs(value) for value in samples)
    if peak == 0:
        raise ValueError("Speech synthesis produced empty audio")
    items.append({
        "label": label, "sourcePath": str(path.relative_to(ROOT)), "sourceSHA256": sha(encoded),
        "sourceBytes": len(encoded), "originalAIFFPath": str(aiff.relative_to(ROOT)),
        "originalAIFFSHA256": sha(aiff.read_bytes()), "sourceTextForProvenanceOnly": text,
        "generator": {"tool": "/usr/bin/say", "voice": "Daniel", "wordsPerMinute": rate,
            "kind": "installed local macOS synthetic voice; original requested text"},
        "sourceRangeFrames": [0, frames], "sourceRangeSeconds": [0, frames / 22050],
        "reelRangeFrames": [position, position + frames],
        "reelRangeSeconds": [position / 22050, (position + frames) / 22050],
        "sampleRate": 22050, "channels": 1, "bitsPerSample": 24, "frames": frames,
        "durationSeconds": frames / 22050, "pcmSHA256": sha(pcm),
        "samplePeak": peak, "rms": math.sqrt(sum(value * value for value in samples) / frames),
        "processing": "AIFF to native-rate mono 24-bit PCM WAV; no gain, trim, time, pitch or effects changes.",
        "status": "prepared_for_fresh_intelligibility_test_not_selected",
    })
    pieces.append(pcm)
    position += frames
    if index < len(specs) - 1:
        pieces.append(bytes(22050 * 3))
        gaps.append({"rangeFrames": [position, position + 22050],
                     "rangeSeconds": [position / 22050, position / 22050 + 1], "kind": "exact-zero one-second artificial gap"})
        position += 22050

reel = io.BytesIO()
with wave.open(reel, "wb") as wav:
    wav.setnchannels(1)
    wav.setsampwidth(3)
    wav.setframerate(22050)
    wav.writeframes(b"".join(pieces))
reel_path = OUT / "speech-comparison-01.wav"
write_once(reel_path, reel.getvalue())
with wave.open(str(reel_path), "rb") as wav:
    actual = wav.readframes(wav.getnframes())
    assert wav.getnframes() == position
for item in items:
    start, end = item["reelRangeFrames"]
    assert sha(actual[start * 3:end * 3]) == item["pcmSHA256"]
for gap in gaps:
    start, end = gap["rangeFrames"]
    assert not any(actual[start * 3:end * 3])

ranges = "; ".join(f"{item['label']}: {item['reelRangeSeconds'][0]:.6f}–{item['reelRangeSeconds'][1]:.6f} seconds" for item in items)
prompt = f"""Listen to the actual attached audio. It contains three separate short speech excerpts: {ranges}. Exactly one second of artificial silence separates each item. The labels do not indicate quality or preference.

For each item independently, transcribe only the words or syllables you can actually hear. Mark unclear syllables as uncertain and provide alternate readings if needed. Do not infer an intended phrase from an earlier conversation or a similar item. Then describe audible pace, pauses, consonant clarity and delivery, with confidence. State which, if any, is easiest to understand and identify the exact segment causing uncertainty. Do not identify the speaker, voice preset, gender or producer. The requested text is intentionally not supplied. This is an intelligibility check, not a request to praise a revision.
"""
prompt_path = OUT / "speech-comparison-01-neutral-prompt.txt"
write_once(prompt_path, prompt.encode())
record = {"schemaVersion": 1, "id": "identity-speech-revision-v1", "status": "prepared_not_submitted_not_selected",
    "originalCandidateUnchanged": True, "reel": {"path": str(reel_path.relative_to(ROOT)),
        "sha256": sha(reel.getvalue()), "bytes": len(reel.getvalue()), "sampleRate": 22050,
        "channels": 1, "bitsPerSample": 24, "frames": position, "durationSeconds": position / 22050},
    "prompt": {"path": str(prompt_path.relative_to(ROOT)), "sha256": sha(prompt.encode()), "containsTargetText": False},
    "items": items, "artificialGaps": gaps,
    "audit": "All source PCM bytes are unchanged and exactly match recorded reel frame ranges; both one-second gaps are exact zero. Source synthesis is successful and nonempty, but pronunciation/intelligibility are not inferred from signal measurements.",
    "selection": "No candidate chosen or applied to any project. Fresh audio analysis and musical context check pending."}
record_bytes = (json.dumps(record, indent=2) + "\n").encode()
record_path = ROOT / "deliverables/audio-research/identity-speech-revision-v1.json"
write_once(record_path, record_bytes)
write_once(OUT / "provenance.json", record_bytes)
print(json.dumps({"reel": record["reel"], "prompt": record["prompt"],
    "items": [{k: item[k] for k in ("label", "durationSeconds", "reelRangeSeconds", "sourceSHA256", "samplePeak")} for item in items],
    "metadata": str(record_path.relative_to(ROOT))}, indent=2))
