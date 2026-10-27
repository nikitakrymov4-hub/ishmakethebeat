#!/usr/bin/env python3
"""Import the supplied321 ZIP and prepare a bounded source audition; no inference.

Original audio is byte-preserved. Folder labels are provenance, not audible claims.
The separate bank is not installed into a project or default generator palette.
"""
from __future__ import annotations

import base64
from collections import Counter
from datetime import datetime, timezone
import hashlib
import html
import importlib.util
import json
import math
import os
from pathlib import Path
import random
import shutil
import subprocess
import tempfile
import unicodedata
import urllib.parse
import zipfile

os.environ["OPENBLAS_NUM_THREADS"] = "1"
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
SOURCE = Path.home() / "Downloads/321 drumkit.zip"
DEST = ROOT / "private-assets/321-drumkit"
OUT = ROOT / "deliverables/audio-research/kit321"
REEL = ROOT / "private-assets/audio-research/kit321-audition-v1"
FFMPEG, FFPROBE = "/opt/homebrew/bin/ffmpeg", "/opt/homebrew/bin/ffprobe"
module_spec = importlib.util.spec_from_file_location("safe_kit", ROOT / "scripts/import-extra-loop-kits.py")
safe = importlib.util.module_from_spec(module_spec)
module_spec.loader.exec_module(safe)


def sha(path):
    with Path(path).open("rb") as f:
        return hashlib.file_digest(f, "sha256").hexdigest()


def atomic_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_text(json.dumps(value, indent=2, ensure_ascii=False, allow_nan=False) + "\n")
    temporary.replace(path)


def decode(path, channels, rate=None):
    cmd = [FFMPEG, "-v", "error", "-nostdin", "-threads", "1", "-i", str(path)]
    if rate:
        cmd += ["-ar", str(rate)]
    cmd += ["-ac", str(channels), "-c:a", "pcm_f32le", "-f", "f32le", "-"]
    data = np.frombuffer(subprocess.check_output(cmd), dtype="<f4").reshape(-1, channels).copy()
    if not np.isfinite(data).all():
        raise ValueError(f"Nonfinite PCM: {path}")
    return data


def pitch_windows(path, duration):
    x = decode(path, 1, 11025).ravel().astype(np.float64)
    windows = []
    low, high = int(11025 / 150), int(11025 / 22)
    for start in [0.06, 0.2, 0.4, 0.7, 1.0, 1.5, 2.0]:
        if start + 0.24 > duration:
            continue
        y = x[round(start * 11025):round((start + 0.24) * 11025)]
        rms = float(np.sqrt(np.mean(y * y)))
        if rms < 0.001:
            continue
        y = y - y.mean()
        c = []
        for lag in range(low - 1, high + 2):
            a, b = y[:-lag], y[lag:]
            c.append(float(a @ b / max(1e-12, np.sqrt((a @ a) * (b @ b)))))
        peaks = [i for i in range(1, len(c)-1) if c[i] > c[i-1] and c[i] >= c[i+1]]
        if not peaks:
            continue
        best = max(c[i] for i in peaks)
        # Select the shortest credible repeating period; octave ambiguity remains explicit.
        i = next((i for i in peaks if c[i] >= max(0.85, best - 0.01)), max(peaks, key=lambda i: c[i]))
        den = c[i-1] - 2*c[i] + c[i+1]
        frac = 0.5*(c[i-1]-c[i+1])/den if abs(den) > 1e-12 else 0
        hz = 11025/(low-1+i+frac)
        windows.append({"startSeconds": start, "endSeconds": start+0.24,
                        "frequencyHz": hz, "correlation": c[i], "rmsDbFS": 20*math.log10(rms)})
    sustain = [w for w in windows if w["startSeconds"] >= 0.2 and w["correlation"] >= 0.95]
    result = {"method": "Normalized autocorrelation on a FFmpeg11025Hz mono copy;22–150Hz search,240ms windows. Supporting signal evidence only, not hearing or harmonic verification.",
              "windows": windows, "status": "manual_root_required", "rootConfidence": 0}
    if len(sustain) >= 2:
        hz = float(np.median([w["frequencyHz"] for w in sustain]))
        spread = 1200*math.log2(max(w["frequencyHz"] for w in sustain)/min(w["frequencyHz"] for w in sustain))
        midi = 69 + 12*math.log2(hz/440)
        result.update({"medianSustainHz": hz, "sustainSpreadCents": spread,
                       "candidateRootMidi": round(midi), "candidateFineCorrectionCents": -(midi-round(midi))*100})
        if spread < 15:
            result.update({"status": "numerical_sustain_estimate", "rootConfidence": 0.8})
    return result


def role_for(row):
    folder = row["sourceFolder"]
    if folder == "drums/eight o eights": return "bass"
    if folder == "drums/hats": return "open"
    if folder == "drums/kicks": return "kick"
    if folder == "drums/percussions": return "perc"
    if folder == "drums/Claps?":
        return "perc" if row["originalFilename"] == "my special percussion.wav" else "clap"
    return None


def main():
    if subprocess.run(["git", "check-ignore", "-q", "private-assets/321-drumkit/probe"], cwd=ROOT).returncode:
        raise ValueError("Private extraction must remain Git ignored")
    archive_hash = sha(SOURCE)
    DEST.parent.mkdir(parents=True, exist_ok=True)
    stage = Path(tempfile.mkdtemp(prefix=".321-import-", dir=DEST.parent))
    rows, skipped = [], []
    try:
        with zipfile.ZipFile(SOURCE) as z:
            entries = z.infolist()
            if len(entries) > safe.MAX_MEMBERS or sum(e.file_size for e in entries) > safe.MAX_ARCHIVE_BYTES:
                raise ValueError("Archive exceeds safety limits")
            seen = set()
            for item in entries:
                relative = safe.safe_member(item)
                if safe.is_metadata(relative):
                    skipped.append(item.filename)
                    continue
                key = unicodedata.normalize("NFC", str(relative)).casefold().rstrip("/")
                if key in seen: raise ValueError("Duplicate/case-colliding member")
                seen.add(key)
                target = stage.joinpath(*relative.parts)
                if item.is_dir():
                    target.mkdir(parents=True, exist_ok=True)
                    continue
                target.parent.mkdir(parents=True, exist_ok=True)
                count = 0
                with z.open(item) as source, target.open("xb") as destination:
                    for chunk in iter(lambda: source.read(1024*1024), b""):
                        count += len(chunk)
                        if count > item.file_size: raise ValueError("Expanded member exceeds declared size")
                        destination.write(chunk)
                if count != item.file_size: raise ValueError("Expanded size mismatch")
                target.chmod(0o644)
                rows.append({"id": f"kit321-{sha(target)[:20]}", "archiveMember": item.filename,
                             "path": str((DEST / Path(*relative.parts)).relative_to(ROOT)),
                             "originalFilename": relative.name, "sourceFolder": "/".join(relative.parts[1:-1]),
                             "bytes": count, "sha256": sha(target), "archiveCRC32": f"{item.CRC:08x}",
                             "crcVerified": True, "creator": "Unverified; no embedded creator/terms document",
                             "audioUnderstandingStatus": "not-submitted"})
        if DEST.is_symlink(): raise ValueError("Destination cannot be a symlink")
        if DEST.exists():
            for row in rows:
                path = ROOT / row["path"]
                if path.is_symlink() or not path.is_file() or sha(path) != row["sha256"]:
                    raise ValueError(f"Existing extraction differs; preserved: {path}")
            shutil.rmtree(stage)
        else:
            stage.rename(DEST)
    finally:
        if stage.exists(): shutil.rmtree(stage)

    assets = []
    for row in rows:
        path = ROOT / row["path"]
        probe = safe.audio_metadata(path, FFPROBE)
        if probe["status"] != "probed": raise ValueError(f"Probe failed: {path}")
        stream = probe["streams"][0]
        rate, channels = int(stream["sample_rate"]), stream["channels"]
        pcm = decode(path, channels)
        peak = float(np.max(abs(pcm)))
        active = np.flatnonzero(np.max(abs(pcm), axis=1) > .001)
        first, last = (int(active[0]), int(active[-1])) if len(active) else (None, None)
        duration = len(pcm)/rate
        row.update({"probe": probe, "sampleRate": rate, "channels": channels, "decodedFrames": len(pcm),
                    "durationSeconds": duration, "decodedFinite": True, "samplePeak": peak,
                    "samplePeakDbFS": 20*math.log10(max(peak, 1e-12)),
                    "rmsDbFS": 20*math.log10(max(float(np.sqrt(np.mean(pcm.astype(np.float64)**2))),1e-12)),
                    "firstAboveMinus60Seconds": first/rate if first is not None else None,
                    "lastAboveMinus60Seconds": last/rate if last is not None else None,
                    "trailingBelowMinus60Seconds": (len(pcm)-last-1)/rate if last is not None else duration,
                    "thresholdNote": "Absolute PCM threshold, not perceptual silence or recommended trim.",
                    "suggestedBankRole": role_for(row),
                    "roleBasis": "Provisional source-folder/filename routing only; no audible classification."})
        role = row["suggestedBankRole"]
        if role == "bass": row["pitchSupport"] = pitch_windows(path, duration)
        if role:
            pitch = row.get("pitchSupport", {})
            confident = pitch.get("status") == "numerical_sustain_estimate"
            mime = "mpeg" if path.suffix.lower() == ".mp3" else "wav"
            asset = {"id": f"sample-321-{role}-{row['sha256'][:16]}",
                     "name": f"321 · {path.name}", "originalFilename": path.name,
                     "data": f"data:audio/{mime};base64," + base64.b64encode(path.read_bytes()).decode(),
                     "role": role, "root": pitch["candidateRootMidi"] if confident else 60,
                     "tuning": pitch["candidateFineCorrectionCents"] if confident else 0,
                     "rootConfidence": pitch.get("rootConfidence", 0), "manualOverride": False,
                     "measuredFundamentalHz": pitch.get("medianSustainHz"), "trimStart": 0,
                     "trimEnd": duration, "duration": duration, "gain": .23 if role == "bass" else .45,
                     "choke": "bass" if role == "bass" else "hats" if role in ("hat","open") else "",
                     "envelopeMode": "gated" if role == "bass" else "one-shot", "loop": False,
                     "sourceId": row["path"], "source": f"User supplied321 drumkit.zip; archiveSHA256 {archive_hash}; member {row['archiveMember']}. Folder routing is unverified; original bytes retained.",
                     "hash": row["sha256"], "sampleRate": rate, "channels": channels,
                     "license": "User-supplied archive; creator, attribution requirements and usage terms not provided or verified. No redistribution license inferred."}
            assets.append(asset)

    OUT.mkdir(parents=True, exist_ok=True)
    REEL.mkdir(parents=True, exist_ok=True)
    drum_rows = [r for r in rows if r["suggestedBankRole"]]
    random.Random(32120261016).shuffle(drum_rows)
    pieces, events, cursor = [], [], 0
    rate = 44100
    for index, row in enumerate(drum_rows):
        original = decode(ROOT/row["path"], 2, rate)
        frames = min(len(original), round(2.5*rate))
        piece = original[:frames].copy()
        truncated = frames < len(original)
        if truncated:
            fade = round(.003*rate)
            piece[-fade:] *= np.linspace(1,0,fade,dtype=np.float32)[:,None]
        events.append({"label": chr(65+index), "reelStartSeconds": cursor/rate,
                       "reelEndSeconds": (cursor+frames)/rate, "reelRangeFrames": [cursor,cursor+frames],
                       "sourcePath": row["path"], "sourceSHA256": row["sha256"],
                       "sourceRangeSeconds": [0,frames/rate], "sourceTotalSeconds": row["durationSeconds"],
                       "sourceChannels": row["channels"], "sourceSampleRate": row["sampleRate"],
                       "sourceFolder": row["sourceFolder"], "originalFilename": row["originalFilename"],
                       "truncatedAt2_5Seconds": truncated,
                       "finalFadeSeconds": .003 if truncated else 0})
        pieces.extend([piece, np.zeros((rate,2),dtype=np.float32)])
        cursor += frames + rate
    signal = np.concatenate(pieces[:-1])
    peak = float(np.max(abs(signal)))
    gain = min(1, .95/max(peak,1e-12))
    signal *= gain
    reel = REEL / "audio-01.wav"
    if reel.exists(): raise ValueError("Reel already exists; preserve it instead of overwriting")
    command = [FFMPEG,"-v","error","-nostdin","-n","-f","f32le","-ar",str(rate),"-ac","2","-i","-",
               "-map_metadata","-1","-c:a","pcm_s24le","-fflags","+bitexact","-flags:a","+bitexact",str(reel)]
    subprocess.run(command,input=signal.astype('<f4').tobytes(),check=True)
    assert len(signal)/rate <= 45
    prompt = ("The attached recording contains separate short source examples with silence between them. "
              "For each labelled time range below, describe only the audible sound, its attack, decay, tonal/noisy quality, pitch movement if clearly present, and any repeat/echo. "
              "Distinguish embedded repetition from one hit. Do not infer artist, genre, exact preset, sample title, or rhythmic placement in a song. "
              "Do not invent a backing beat or continuous accompaniment. If you hear intelligible speech state only clear words; otherwise say uncertain. "
              "Keep each example to one or two sentences, with uncertainty.\n\n" +
              "\n".join(f"{e['label']}: {e['reelStartSeconds']:.6f}–{e['reelEndSeconds']:.6f} seconds" for e in events)+"\n")
    prompt_path = REEL/"neutral-prompt.txt"
    prompt_path.write_text(prompt)
    private = {"privateAnswerKey":True,"doNotSubmitToModel":True,"selection":"All nine source-folder drum assets, one occurrence each, deterministic shuffle. No ranking or suitability claim.",
               "events":events,"processing":{"rate":rate,"channels":2,"format":"24bitPCM",
               "globalLinearGain":gain,"globalGainDb":20*math.log10(gain),
               "resampling":"FFmpeg default only where source rate differs; mono duplicated into stereo",
               "gapsSeconds":1,"partialSourceEndFadeSeconds":.003,"effects":"None"},
               "originalSourcePostchecks":all(sha(ROOT/r["path"])==r["sha256"] for r in rows)}
    atomic_json(REEL/"source-key.private.json",private)
    record = {"schemaVersion":1,"createdAt":datetime.now(timezone.utc).isoformat(),"status":"prepared_not_submitted",
              "audioPath":str(reel),"audioSHA256":sha(reel),"durationSeconds":len(signal)/rate,
              "frames":len(signal),"sampleRate":rate,"channels":2,"bytes":reel.stat().st_size,
              "promptPath":str(prompt_path),"promptSHA256":sha(prompt_path),"exampleCount":len(events),
              "sourceKeyPath":str(REEL/"source-key.private.json"),
              "note":"Submit audio and neutral prompt only; filename mappings and folder labels stay private."}
    atomic_json(OUT/"audition-input.json",record)
    atomic_json(DEST/"drum-bank.json",assets)
    catalogue = {"schemaVersion":1,"createdAt":datetime.now(timezone.utc).isoformat(),
                 "archive":{"path":str(SOURCE),"sha256":archive_hash,"bytes":SOURCE.stat().st_size,
                            "originalRehashedUnchanged":sha(SOURCE)==archive_hash},
                 "extraction":{"path":str(DEST),"safePaths":True,"linksAndSpecialFilesRejected":True,
                               "retainedCRCsVerified":True,"macMetadataSkippedCount":len(skipped),
                               "skipped":skipped},"counts":{"audioFiles":len(rows),"byExtension":dict(Counter(Path(r['path']).suffix for r in rows)),
                               "bySourceFolder":dict(Counter(r['sourceFolder'] for r in rows)),
                               "embeddedTermsOrCreditDocuments":0,"drumBankAssets":len(assets)},
                 "classificationLimit":"Folders and filenames only, not music understanding. Tags may identify another producer; none installed or relabelled as ishmakethebeat.",
                 "bank":{"path":str(DEST/"drum-bank.json"),"sha256":sha(DEST/"drum-bank.json"),
                         "installedInApp":False,"automaticPaletteOrProjectChanges":False,
                         "unverifiedBassRootBehaviour":"Root confidence0 blocks pitched playback until manually confirmed; stable numerical estimates remain provisional."},
                 "files":rows,"reel":record}
    atomic_json(OUT/"catalogue.json",catalogue)
    cards = []
    for row in rows:
        url = "/" + "/".join(urllib.parse.quote(p,safe="") for p in row["path"].split("/"))
        cards.append(f"<article><h3>{html.escape(row['originalFilename'])}</h3><p>{html.escape(row['sourceFolder'])} · {row['durationSeconds']:.3f}s · {row['sampleRate']}Hz · {row['channels']}ch</p><audio controls preload='none' src='{html.escape(url)}'></audio><p><a href='{html.escape(url)}' download>Original audio</a></p></article>")
    (OUT/"listen.html").write_text("<!doctype html><html><meta charset='utf-8'><meta name='viewport' content='width=device-width,initial-scale=1'><title>321 kit source library</title><style>body{font:16px system-ui;background:#11131a;color:#edeaf4;max-width:1000px;margin:40px auto;padding:0 20px}main{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:16px}article{border:1px solid #353742;padding:16px;border-radius:12px}h3{font-size:16px;word-break:break-word}audio{width:100%}a{color:#cab1ff}p{line-height:1.5}</style><h1>321 kit · original source library</h1><p>34 original audio files. Folder labels are supplied metadata, not audition findings. Creator and usage terms were not supplied. Existing producer tags remain their original recordings; none is the ishmakethebeat identity. No project, default palette or drum pattern changed.</p><p><a href='catalogue.json'>Hashes and numerical metadata</a> · <a href='audition-input.json'>Prepared neutral drum audition</a></p><main>"+"".join(cards)+"</main></html>")
    print(json.dumps({"catalogue":str(OUT/"catalogue.json"),"library":str(OUT/"listen.html"),"bank":str(DEST/"drum-bank.json"),"reel":record,"bassSupport":[{"file":r["originalFilename"],"pitch":r["pitchSupport"]} for r in rows if "pitchSupport" in r]},indent=2))


if __name__ == "__main__": main()
