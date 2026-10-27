#!/usr/bin/env python3
"""Prepare a separate chronological Google browser plan; no inference or upload.

Decode the source once, retain 5s overlap, encode native-rate stereo 24-bit FLAC.
Source-frame coordinates are exact; original files and other manifests stay intact.
"""
from __future__ import annotations
import argparse
import datetime as dt
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]


def digest(path):
    h = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def write_new(path, value):
    with path.open("x", encoding="utf-8") as handle:
        json.dump(value, handle, indent=2, ensure_ascii=False)
        handle.write("\n")


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--source-manifest", type=Path, default=ROOT / "deliverables/audio-research/album-source.json")
    p.add_argument("--clip-directory", type=Path, default=ROOT / "private-assets/audio-research/google-broad-v1")
    p.add_argument("--manifest", type=Path, default=ROOT / "deliverables/audio-research/google-studio-album-plan-v1.json")
    p.add_argument("--start-seconds", type=int, default=0, help="Exact integer-second source start for a separate continuation plan")
    p.add_argument("--id-prefix", default="culture-google")
    p.add_argument("--ffmpeg", default=shutil.which("ffmpeg") or "ffmpeg")
    p.add_argument("--ffprobe", default=shutil.which("ffprobe") or "ffprobe")
    args = p.parse_args()
    if args.manifest.exists() or args.clip_directory.exists():
        p.error("Output already exists; preserve it and choose a new version/directory")
    source = json.loads(args.source_manifest.read_text())
    if digest(Path(source["path"])) != source["sha256"]:
        p.error("Source SHA256 mismatch")
    sr, channels, total = source["decodedSampleRate"], source["decodedChannels"], source["decodedFrames"]
    if channels != 2:
        p.error("Expected the original stereo source")
    start_frame = args.start_seconds * sr
    if not 0 <= start_frame < total:
        p.error("Start must be within the decoded source")
    if not args.id_prefix or any(c not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_" for c in args.id_prefix):
        p.error("ID prefix must contain only letters, digits, hyphens or underscores")
    stride, count, overlap, frame_bytes = 295 * sr, 300 * sr, 5 * sr, channels * 3
    args.clip_directory.mkdir(parents=True)
    args.manifest.parent.mkdir(parents=True, exist_ok=True)
    decode = [args.ffmpeg, "-v", "error", "-nostdin", "-i", source["path"], "-map", "0:a:0",
              "-af", f"atrim=start_sample={start_frame},asetpts=PTS-STARTPTS",
              "-ar", str(sr), "-ac", "2", "-c:a", "pcm_s24le", "-f", "s24le", "pipe:1"]
    records, pcm = [], bytearray()
    decoder = subprocess.Popen(decode, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        for index, start in enumerate(range(start_frame, total, stride), 1):
            end = min(total, start + count)
            needed = (end - start) * frame_bytes
            while len(pcm) < needed:
                block = decoder.stdout.read(min(1024 * 1024, needed - len(pcm)))
                if not block:
                    raise RuntimeError("Decoder ended before the declared source frame count")
                pcm.extend(block)
            name = f"{args.id_prefix}-{index:03d}-{start // sr:04d}-{end / sr:.3f}-native-stereo.flac"
            target = args.clip_directory / name
            command = [args.ffmpeg, "-v", "error", "-nostdin", "-n", "-f", "s24le", "-ar", str(sr), "-ac", "2",
                       "-i", "pipe:0", "-map_metadata", "-1", "-c:a", "flac", "-sample_fmt", "s32",
                       "-bits_per_raw_sample", "24", "-compression_level", "5", str(target)]
            subprocess.run(command, input=pcm, check=True, capture_output=True)
            info = json.loads(subprocess.check_output([args.ffprobe, "-v", "error", "-show_entries",
                "stream=codec_name,sample_rate,channels,bits_per_raw_sample,duration_ts,time_base:format=duration",
                "-of", "json", str(target)], text=True))
            stream = info["streams"][0]
            if (int(stream["sample_rate"]) != sr or stream["channels"] != 2 or
                    int(stream["bits_per_raw_sample"]) != 24 or int(stream["duration_ts"]) != end - start):
                raise RuntimeError("Encoded clip shape/frame count mismatch")
            record = {"id": f"{args.id_prefix}-{index:03d}", "sourceStartFrame": start,
                "sourceEndFrameExclusive": end, "sourceStartSeconds": start / sr,
                "sourceEndSeconds": end / sr, "overlapWithPreviousFrames": overlap if index > 1 else 0,
                "overlapWithPreviousSeconds": 5 if index > 1 else 0,
                "submittedDurationSeconds": None, "executionStatus": "prepared_unsubmitted", "proofs": [],
                "clip": {"path": str(target.resolve()), "sha256": digest(target), "bytes": target.stat().st_size,
                         "frames": end - start, "durationSeconds": (end - start) / sr,
                         "sampleRate": sr, "channels": 2, "pcmBits": 24, "codec": "flac",
                         "rawPCM24SHA256": hashlib.sha256(pcm).hexdigest(), "probe": info},
                "estimatedAudioTokensAt32PerSecond": (end - start) / sr * 32,
                "encodeCommand": command}
            write_new(target.with_suffix(".json"), record)
            records.append(record)
            print(json.dumps({"prepared": record["id"], "range": [start / sr, end / sr],
                              "bytes": record["clip"]["bytes"], "path": str(target)}), flush=True)
            if end == total:
                break
            del pcm[:stride * frame_bytes]
        if decoder.stdout.read(1):
            raise RuntimeError("Decoder produced more than the declared source frame count")
        stderr = decoder.stderr.read().decode("utf-8", errors="replace")
        if decoder.wait() != 0:
            raise RuntimeError("Decode failed: " + stderr)
        manifest = {"schemaVersion": 1, "createdAt": dt.datetime.now(dt.timezone.utc).isoformat(),
            "purpose": "Separate Google AI Studio corroborating broad-pass plan; preparation is not execution",
            "source": source, "sourceManifestSHA256": digest(args.source_manifest),
            "chunkSeconds": 300, "overlapSeconds": 5, "chunks": records,
            "preparedStartFrame": start_frame,
            "preparedUniqueCoverageFrames": total - start_frame, "preparedUniqueCoverageSeconds": (total - start_frame) / sr,
            "successfulExecutionUniqueCoverageSeconds": 0, "validatedMusicalCoverageSeconds": 0,
            "decodeCommand": decode,
            "preprocessing": "Native sample rate, stereo channels and timing retained; decoded PCM quantized to 24-bit and losslessly FLAC-encoded. No gain normalization or source modification.",
            "providerCaveat": "Official API docs say multichannel audio is combined to one channel and resolution downsampled. AI Studio browser limits/quota are observed separately; no stereo-width claims. Five-minute responses require follow-up for detailed passages.",
            "officialAudioDocumentation": "https://ai.google.dev/gemini-api/docs/audio",
            "documentationCheckedDate": "2026-10-16"}
        write_new(args.manifest, manifest)
        print(json.dumps({"manifest": str(args.manifest), "preparedChunks": len(records), "executedChunks": 0}))
    finally:
        if decoder.poll() is None:
            decoder.kill()
            decoder.wait()


if __name__ == "__main__":
    main()
