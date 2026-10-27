#!/usr/bin/env python3
"""Prepare real, traceable audio inputs; does not analyze musical content.

Requires ffmpeg/ffprobe and NumPy. Original audio and app renders are read only.
All timestamps are relative to decoded PCM after FFmpeg handles MP3 delay/padding.
This writes a coverage PLAN, never evidence that a provider processed the album.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
import shutil
import subprocess
import wave
from datetime import datetime, timezone
from fractions import Fraction
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
PRIVATE = ROOT / "private-assets/audio-research"
OUT = ROOT / "deliverables/audio-research"
FFMPEG = shutil.which("ffmpeg")
FFPROBE = shutil.which("ffprobe")


def run(args):
    return subprocess.run(args, check=True, capture_output=True, text=True)


def digest(path):
    h = hashlib.sha256()
    with path.open("rb") as f:
        for part in iter(lambda: f.read(1024 * 1024), b""):
            h.update(part)
    return h.hexdigest()


def save(name, data):
    (OUT / name).write_text(json.dumps(data, indent=2) + "\n")


def file_record(path):
    return {"path": str(path), "sha256": digest(path), "bytes": path.stat().st_size}


def decoded_frames(source, sr, channels):
    # Stream and count actual decoded float PCM without retaining a large copy.
    proc = subprocess.Popen(
        [FFMPEG, "-v", "error", "-i", str(source), "-map", "0:a:0",
         "-ar", str(sr), "-ac", str(channels), "-c:a", "pcm_f32le", "-f", "f32le", "pipe:1"],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    )
    size = 0
    while part := proc.stdout.read(1024 * 1024):
        size += len(part)
    stderr = proc.stderr.read().decode()
    if proc.wait():
        raise RuntimeError(stderr)
    if size % (4 * channels):
        raise ValueError("Incomplete PCM frame")
    return size // (4 * channels)


def cut_reference(source, out, start_frame, frames):
    temporary = out.with_name(out.stem + ".preparing.wav")
    run([FFMPEG, "-hide_banner", "-v", "error", "-y", "-i", str(source),
         "-map", "0:a:0", "-af",
         f"atrim=start_sample={start_frame}:end_sample={start_frame + frames},asetpts=PTS-STARTPTS",
         "-c:a", "pcm_s24le", str(temporary)])
    if out.exists() and digest(out) == digest(temporary):
        temporary.unlink()
    else:
        temporary.replace(out)


def read_wav_range(path, start, count):
    with wave.open(str(path), "rb") as w:
        params = w.getparams()
        if params.sampwidth != 3 or params.nchannels != 2 or params.framerate != 44100:
            raise ValueError(f"Unexpected source PCM: {path}: {params}")
        if start + count > params.nframes:
            raise ValueError(f"Source too short: {path}")
        w.setpos(start)
        raw = w.readframes(count)
    b = np.frombuffer(raw, dtype=np.uint8).reshape(-1, 3)
    values = b[:, 0].astype(np.int32) | (b[:, 1].astype(np.int32) << 8) | (b[:, 2].astype(np.int32) << 16)
    values = np.where(values & 0x800000, values - 0x1000000, values)
    return values.astype(np.float64).reshape(-1, 2) / 8388608.0, params, raw


def write_wav(path, samples, sr=44100):
    if not np.isfinite(samples).all() or np.max(np.abs(samples)) >= 1:
        raise ValueError(f"Non-finite or clipping grouped stem: {path}")
    q = np.rint(samples * 8388608).astype(np.int32).reshape(-1)
    b = np.stack((q & 255, (q >> 8) & 255, (q >> 16) & 255), axis=1).astype(np.uint8)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(3)
        w.setframerate(sr)
        w.writeframes(b.tobytes())


def loudness(path):
    result = run([FFMPEG, "-hide_banner", "-i", str(path), "-af",
                  "loudnorm=I=-23:TP=-1:LRA=7:print_format=json", "-f", "null", "-"])
    raw = json.loads(re.findall(r"\{[\s\S]*?\}", result.stderr)[-1])
    return {"integratedLUFS": float(raw["input_i"]), "truePeakDbTP": float(raw["input_tp"]),
            "loudnessRangeLU": float(raw["input_lra"]), "rawFFmpegInputMeasurement": raw}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--album", type=Path, default=Path.home() / "Downloads/TDF - CULTURE [FULL ALBUM] (SEAMLESS TRANSITIONS).mp3")
    args = parser.parse_args()
    if not FFMPEG or not FFPROBE:
        raise RuntimeError("Install FFmpeg including ffprobe before running")
    PRIVATE.mkdir(parents=True, exist_ok=True)
    OUT.mkdir(parents=True, exist_ok=True)
    album = args.album.resolve()
    probe = json.loads(run([FFPROBE, "-v", "error", "-show_entries",
                           "format=duration,size,format_name:stream=codec_name,sample_rate,channels,channel_layout,duration,start_time",
                           "-of", "json", str(album)]).stdout)
    stream = probe["streams"][0]
    sr, channels = int(stream["sample_rate"]), stream["channels"]
    if channels != 2:
        raise ValueError("Expected original stereo reference")
    frames = decoded_frames(album, sr, channels)
    duration = frames / sr
    source = {**file_record(album), "probe": probe, "decodedFrames": frames,
              "decodedSampleRate": sr, "decodedChannels": channels, "decodedDurationSeconds": duration,
              "timestampBasis": "Decoded PCM starting at frame 0 after FFmpeg handles any encoder delay/padding metadata; container timing is reported separately.",
              "originalPreserved": True, "downmixOrResample": False,
              "ffmpegVersion": run([FFMPEG, "-version"]).stdout.splitlines()[0]}
    save("album-source.json", source)
    print(f"Decoded album duration: {duration:.9f}s; SHA-256: {source['sha256']}", flush=True)

    refs = []
    for start in [45, 1200]:
        out = PRIVATE / f"culture-reference-{start:04d}-{start+30:04d}-stereo.wav"
        cut_reference(album, out, start * sr, 30 * sr)
        refs.append({**file_record(out), "sourceSha256": source["sha256"], "sourceStartSeconds": start,
                     "sourceEndSeconds": start + 30, "sourceStartFrame": start * sr, "frames": 30 * sr,
                     "durationSeconds": 30, "sampleRate": sr, "channels": channels, "pcmBits": 24,
                     "selectionBasis": "Two separated file positions only; their musical content has not yet been assessed.",
                     "audioUnderstandingStatus": "unsubmitted"})
    save("reference-clips.json", refs)

    chunk_length, overlap = 120 * sr, 5 * sr
    chunks, start, number = [], 0, 1
    while start < frames:
        end = min(start + chunk_length, frames)
        chunks.append({"id": f"culture-broad-{number:03d}", "sourceStartFrame": start, "sourceEndFrameExclusive": end,
                       "sourceStartSeconds": start / sr, "sourceEndSeconds": end / sr,
                       "plannedDurationSeconds": (end - start) / sr,
                       "overlapWithPreviousSeconds": 0 if number == 1 else overlap / sr,
                       "submittedDurationSeconds": None, "provider": None, "model": None,
                       "status": "unsubmitted", "responsePath": None, "failure": None})
        if end == frames:
            break
        start = end - overlap
        number += 1
    save("album-coverage-plan.json", {"schemaVersion": 1, "source": source,
         "status": "plan_only_no_model_requests_yet", "plannedUniqueCoverageSeconds": duration,
         "successfulUniqueCoverageSeconds": 0, "nominalChunkSeconds": 120, "nominalOverlapSeconds": 5,
         "note": "Adapt these planned boundaries to the selected provider's actual limits before submitting. This file is not a completed coverage claim.",
         "chunks": chunks})

    original = ROOT / "deliverables/character/original"
    project_path = original / "project.ish.json"
    p = json.loads(project_path.read_text())
    bpm = Fraction(str(p["settings"]["bpm"]))
    # Bars 5–20 are the saved project's contiguous 16-bar main section.
    start_exact = Fraction(4 * 4 * 60, 1) / bpm
    end_exact = Fraction(20 * 4 * 60, 1) / bpm
    first = round(start_exact * 44100)
    last = round(end_exact * 44100)
    count = last - first
    mix, params, raw = read_wav_range(original / "full.wav", first, count)
    mix_out = PRIVATE / "current-original-bars05-20-full.wav"
    with wave.open(str(mix_out), "wb") as w:
        w.setparams(params._replace(nframes=count))
        w.writeframes(raw)
    # Shared effects cannot be assigned back to their sources from exported sums.
    groups = {"melody-dry": ["melody", "pad", "answer", "keys", "bridge", "pedal", "resample"],
              "bass-dry": ["bass"], "drums-dry": ["kick", "clap", "hat", "open", "perc"], "shared-fx": ["fx"]}
    output_groups, sums = [], []
    for name, roles in groups.items():
        sources = [original / f"stem-{role}.wav" for role in roles]
        values = sum((read_wav_range(path, first, count)[0] for path in sources), np.zeros_like(mix))
        out = PRIVATE / f"current-original-bars05-20-{name}.wav"
        write_wav(out, values)
        sums.append(values)
        output_groups.append({"group": name, **file_record(out), "sourceFiles": [file_record(path) for path in sources],
                              "includedRoles": roles, "gainAppliedDb": 0, "samplePeak": float(np.max(np.abs(values)))})
    headroom, _, _ = read_wav_range(original / "headroom.wav", first, count)
    reconstructed = sum(sums) * 0.73
    discrepancy = reconstructed - headroom
    excerpt = {"schemaVersion": 1, "createdAt": datetime.now(timezone.utc).isoformat(),
               "sourceProject": file_record(project_path), "sourceFullMix": file_record(original / "full.wav"),
               "projectTitle": p["title"], "seed": p["settings"]["seed"], "selectedCandidate": p["selected"],
               "bpm": float(bpm), "barsInclusive": [5, 20], "barCount": 16, "beatsPerBar": 4,
               "nominalStartSeconds": float(start_exact), "nominalEndSeconds": float(end_exact),
               "sourceStartFrame": first, "sourceEndFrameExclusive": last,
               "sourceStartSeconds": first / 44100, "sourceEndSeconds": last / 44100,
               "durationSeconds": count / 44100, "frames": count, "sampleRate": 44100, "channels": 2, "pcmBits": 24,
               "fullMix": file_record(mix_out), "groups": output_groups,
               "provenance": "Cropped prior genuine app OfflineAudioContext renders. Full mix copied sample-for-sample; groups are linear sums of aligned dry stems. No new music synthesized.",
               "renderFreshness": "Existing frozen current original render; this preparation step does not claim a newly executed app render.",
               "stemTap": "Post instrument/filter/insert/fader, before master 0.73 gain and protection. Shared returns are separate shared-fx. Current original master adds 4 dB listening gain and nonlinear protection.",
               "sumVerification": {"method": "sum of source dry role stems plus source FX, multiplied by graph headroom gain 0.73, compared with actual headroom.wav",
                                   "maxAbsoluteSampleDifference": float(np.max(np.abs(discrepancy))),
                                   "rmsSampleDifference": float(np.sqrt(np.mean(discrepancy ** 2))),
                                   "note": "Separately rendered nonlinear/float graph paths and independent PCM quantization can differ; this metric is reported rather than assuming exact master reconstruction."},
               "tagVox": {"available": False, "tagEnabled": p.get("tagEnabled"),
                          "reason": "This saved original project has no enabled producer tag or sampled vox events. No silent or invented tag stem was created."},
               "audioUnderstandingStatus": "unsubmitted"}
    save("current-app-excerpt.json", excerpt)

    # Diagnostic level matching uses the quietest measured mix, with attenuation
    # only. This is not a production target or a claim about artist-wide loudness.
    comparisons = [Path(r["path"]) for r in refs] + [mix_out]
    measurements = [loudness(path) for path in comparisons]
    target = min(m["integratedLUFS"] for m in measurements)
    matches = []
    for path, measure in zip(comparisons, measurements):
        gain_db = target - measure["integratedLUFS"]
        out = path.with_name(path.stem + "-matched.wav")
        run([FFMPEG, "-hide_banner", "-v", "error", "-y", "-i", str(path),
             "-af", f"volume={gain_db:.9f}dB", "-c:a", "pcm_s24le", str(out)])
        matches.append({"source": file_record(path), "measurement": measure,
                        "matched": file_record(out), "gainDb": gain_db, "inverseGainDb": -gain_db,
                        "matchedMeasurement": loudness(out), "processing": "Constant linear gain only; stereo/rate/duration retained. Original source retained."})
    save("diagnostic-loudness-matching.json", {"targetIntegratedLUFS": target,
          "targetSelection": "Quietest of these three diagnostic mix excerpts; attenuation only, no limiter or dynamics.",
          "measurement": "FFmpeg loudnorm input EBU R128 measurement, including oversampled true peak; 0.1 dB printed precision.", "files": matches})
    print(json.dumps({"source": str(OUT / "album-source.json"), "referenceClips": refs,
                      "coveragePlanChunks": len(chunks), "appExcerpt": str(OUT / "current-app-excerpt.json"),
                      "headroomSumMaxError": excerpt["sumVerification"]["maxAbsoluteSampleDifference"],
                      "diagnosticTargetLUFS": target}, indent=2))


if __name__ == "__main__":
    main()
