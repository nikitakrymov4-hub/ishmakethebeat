#!/usr/bin/env python3
"""Safely import three user-supplied loop kits into ignored local storage.

No network or audio interpretation. Audio metadata comes from ffprobe; tempo/key
tokens from names stay unverified. Embedded documents are retained as source data,
never executed. Existing sources and conflicting destination files are not changed.
"""
from __future__ import annotations

import argparse
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import hashlib
import json
import math
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import struct
import subprocess
import tempfile
import unicodedata
import zipfile

ROOT = Path(__file__).resolve().parents[1]
DEST = ROOT / "private-assets" / "extra-loop-kits"
REPORT = ROOT / "deliverables" / "audio-research" / "extra-loop-kit-catalogue.json"
MAX_MEMBERS = 10000
MAX_MEMBER_BYTES = 512 * 1024 * 1024
MAX_ARCHIVE_BYTES = 2 * 1024 * 1024 * 1024
MAX_RATIO = 1000
AUDIO = {".wav", ".mp3", ".flac", ".aif", ".aiff", ".m4a", ".ogg"}
KITS = [
    {"id": "neptune", "archive": "NEPTUNE LOOP KIT.zip", "creator": "Ello Benz",
     "creditBasis": "Embedded TERMS AND AGREEMENT.txt identifies composer Ello Benz.",
     "termsSummary": "Source document says not royalty free; allows beat use/sales with stated splits; requests 50/50 Beatstars collaboration and publishing splits, and clearance for major-label/artist placements.",
     "termsStatus": "Source statements retained; no external clearance or license verification performed."},
    {"id": "carti-type", "archive": "Carti Type Loopkit.zip", "creator": "jah (filename attribution)",
     "creditBasis": "Ten filenames contain prod. jah. No embedded terms document found; ayojah.wav has no producer-credit syntax.",
     "termsSummary": "No embedded license/terms document found.",
     "termsStatus": "Usage and redistribution rights not established by the archive name."},
    {"id": "deyflo-january", "archive": "1 JAN DEYFLO MELODIES + MIDIS + STARTERS.zip", "creator": "Deyflo",
     "creditBasis": "Embedded TERMS & CONDITIONS identifies Deyflo; filenames retain additional collaborators where named.",
     "termsSummary": "Source document requests production/co-production credit and collaborator splits; says contents cannot create products such as sample packs, loop kits, preset banks or related services without permission; requests Beatstars splits for YouTube type beats.",
     "termsStatus": "Source statements retained; no external clearance or license verification performed."},
]


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def safe_member(info: zipfile.ZipInfo) -> PurePosixPath:
    raw = info.filename.replace("\\", "/")
    p = PurePosixPath(raw)
    if (not raw or "\x00" in raw or p.is_absolute() or ".." in p.parts
            or any(":" in part for part in p.parts)):
        raise ValueError(f"Unsafe ZIP path: {info.filename!r}")
    mode = info.external_attr >> 16
    kind = stat.S_IFMT(mode)
    if kind not in (0, stat.S_IFREG, stat.S_IFDIR):
        raise ValueError(f"ZIP links/special files are forbidden: {info.filename!r}")
    if info.flag_bits & 1:
        raise ValueError(f"Encrypted ZIP member is unsupported: {info.filename!r}")
    if info.file_size > MAX_MEMBER_BYTES:
        raise ValueError(f"ZIP member exceeds size limit: {info.filename!r}")
    if info.file_size > 1024 * 1024 and info.file_size / max(1, info.compress_size) > MAX_RATIO:
        raise ValueError(f"ZIP member exceeds compression-ratio limit: {info.filename!r}")
    return p


def is_metadata(p: PurePosixPath) -> bool:
    return any(part == "__MACOSX" or part == ".DS_Store" or part.startswith("._") for part in p.parts)


def filename_hints(name: str, kit_id: str) -> dict:
    explicit = re.search(r"(?<!\d)(\d{2,3}(?:\.\d+)?)\s*bpm\b", name, re.I)
    structural = re.search(r"_(\d{2,3})(?=\s*[\[(])", name) if kit_id == "deyflo-january" else None
    key = re.search(r"\b([A-Ga-g][#b]?)[ _-]*(minor|major|min|maj)\b", name)
    bpm = explicit or structural
    return {
        "tempoBpm": float(bpm.group(1)) if bpm else None,
        "tempoBasis": "filename bpm token" if explicit else "filename numeric token before bracketed description" if structural else None,
        "key": f"{key.group(1)} {key.group(2)}" if key else None,
        "verified": False,
        "note": "Filename hints do not establish tempo, key, downbeat, actual loop region or musical character.",
    }


def file_credits(name: str, kit: dict) -> dict:
    if kit["id"] == "neptune":
        return {"names": ["Ello Benz"], "basis": "embedded terms composer attribution"}
    if kit["id"] == "carti-type":
        return {"names": ["jah"] if "prod. jah" in name.lower() else [],
                "basis": "filename attribution only" if "prod. jah" in name.lower() else "no explicit per-file creator attribution"}
    collaborator = re.search(r"deyflo\s+x\s+([^_]+)_", name, re.I)
    return {"names": ["Deyflo"] + ([collaborator.group(1)] if collaborator else []),
            "basis": "Deyflo identified in embedded terms; additional collaborator retained from filename only"}


def midi_metadata(path: Path) -> dict:
    data = path.read_bytes()
    if len(data) < 14 or data[:4] != b"MThd":
        return {"status": "invalid-header"}
    header_size = int.from_bytes(data[4:8], "big")
    fmt, tracks, division = struct.unpack(">HHH", data[8:14])
    return {"status": "header-read", "format": fmt, "declaredTracks": tracks,
            "division": division, "timeBase": "SMPTE" if division & 0x8000 else "PPQ",
            "ppq": None if division & 0x8000 else division,
            "headerBytes": header_size,
            "note": "Header metadata only. Composition, scale-guide status, tempo and note structure not inferred."}


def audio_metadata(path: Path, ffprobe: str) -> dict:
    try:
        result = subprocess.run(
            [ffprobe, "-v", "error", "-show_entries",
             "format=duration,start_time,bit_rate,format_name:stream=index,codec_type,codec_name,sample_rate,channels,channel_layout,duration,duration_ts,time_base,start_time,bits_per_sample,bits_per_raw_sample",
             "-of", "json", str(path)], capture_output=True, text=True, timeout=45, check=True)
        parsed = json.loads(result.stdout)
        streams = [s for s in parsed.get("streams", []) if s.get("codec_type") == "audio"]
        duration = parsed.get("format", {}).get("duration")
        duration = float(duration) if duration is not None else None
        if duration is not None and not math.isfinite(duration):
            raise ValueError("Nonfinite duration")
        return {"status": "probed", "durationSeconds": duration,
                "streams": streams, "format": parsed.get("format", {}),
                "measurementBasis": "ffprobe container/stream metadata, not whole-file decode or musical grid verification"}
    except (subprocess.SubprocessError, ValueError) as error:
        return {"status": "failed", "error": str(error)[:500]}


def decode_document(path: Path) -> str:
    data = path.read_bytes()
    if data.startswith((b"\xff\xfe", b"\xfe\xff")):
        return data.decode("utf-16")
    return data.decode("utf-8-sig", "replace")


def import_archive(kit: dict, downloads: Path) -> dict:
    source = downloads / kit["archive"]
    source_hash = sha256(source)
    final_root = DEST / kit["id"]
    if final_root.is_symlink():
        raise ValueError(f"Destination cannot be symlink: {final_root}")
    staged_root = Path(tempfile.mkdtemp(prefix=f".{kit['id']}-", dir=DEST))
    rows, skipped = [], []
    try:
        with zipfile.ZipFile(source) as archive:
            members = archive.infolist()
            if len(members) > MAX_MEMBERS or sum(i.file_size for i in members) > MAX_ARCHIVE_BYTES:
                raise ValueError(f"Archive exceeds count/size limit: {source.name}")
            seen = set()
            safe = []
            for member in members:
                # Some supplied ZIPs contain an empty '/' directory placeholder.
                # Discard it; never interpret it as an extraction destination.
                if member.filename in ("/", "./") and member.is_dir() and member.file_size == 0:
                    skipped.append({"archivePath": member.filename, "reason": "empty archive root marker; not extracted"})
                    continue
                rel = safe_member(member)
                if is_metadata(rel):
                    skipped.append({"archivePath": member.filename, "reason": "macOS metadata"})
                    continue
                normalized = unicodedata.normalize("NFC", str(rel)).casefold().rstrip("/")
                if normalized in seen:
                    raise ValueError(f"Duplicate/case-colliding ZIP path: {member.filename!r}")
                seen.add(normalized)
                safe.append((member, rel))
            # Every retained file is streamed to EOF, verifying its ZIP CRC.
            for member, rel in safe:
                target = staged_root.joinpath(*rel.parts)
                if member.is_dir():
                    target.mkdir(parents=True, exist_ok=True)
                    continue
                target.parent.mkdir(parents=True, exist_ok=True)
                count, digest = 0, hashlib.sha256()
                with archive.open(member) as incoming, target.open("xb") as out:
                    for chunk in iter(lambda: incoming.read(1024 * 1024), b""):
                        count += len(chunk)
                        if count > member.file_size or count > MAX_MEMBER_BYTES:
                            raise ValueError(f"Expanded member exceeds declared size: {member.filename!r}")
                        digest.update(chunk)
                        out.write(chunk)
                if count != member.file_size:
                    raise ValueError(f"Unexpected expanded size: {member.filename!r}")
                os.chmod(target, 0o644)
                suffix = target.suffix.lower()
                kind = "audio" if suffix in AUDIO else "midi" if suffix in (".mid", ".midi") else "document" if suffix in (".txt", ".md", ".pdf", ".rtf") else "artwork" if suffix in (".jpg", ".jpeg", ".png") else "other"
                rows.append({"id": f"extra-{digest.hexdigest()[:20]}", "kitId": kit["id"],
                             "archivePath": member.filename,
                             "path": str((final_root / Path(*rel.parts)).relative_to(ROOT)),
                             "originalFilename": target.name, "extension": suffix,
                             "kind": kind, "bytes": count, "sha256": digest.hexdigest(),
                             "archiveCrc32": f"{member.CRC:08x}", "crcVerified": True,
                             "creator": kit["creator"], "creditBasis": kit["creditBasis"],
                             "perFileCredits": file_credits(target.name, kit),
                             "filenameHints": filename_hints(target.name, kit["id"]) if kind == "audio" else None,
                             "audioUnderstandingStatus": "not-submitted" if kind == "audio" else "not-applicable"})
        if source_hash != sha256(source):
            raise ValueError(f"Source archive changed during import: {source.name}")
        if final_root.exists():
            # Idempotent reruns validate existing content and never silently overwrite.
            for row in rows:
                existing = ROOT / row["path"]
                if any(p.is_symlink() for p in [existing, *existing.parents] if p != ROOT.parent):
                    raise ValueError(f"Symlink in existing destination: {existing}")
                if not existing.is_file() or sha256(existing) != row["sha256"]:
                    raise ValueError(f"Existing import differs; preserving it: {existing}")
            shutil.rmtree(staged_root)
        else:
            staged_root.rename(final_root)
        return {**kit, "archivePath": str(source), "archiveBytes": source.stat().st_size,
                "archiveSha256": source_hash, "originalRetainedAndRehashed": True,
                "extractedRoot": str(final_root.relative_to(ROOT)),
                "countsByExtension": dict(sorted(Counter(r["extension"] for r in rows).items())),
                "countsByKind": dict(sorted(Counter(r["kind"] for r in rows).items())),
                "extractedBytes": sum(r["bytes"] for r in rows), "skippedMetadata": skipped,
                "files": rows}
    finally:
        if staged_root.exists():
            shutil.rmtree(staged_root)


def existing_hashes() -> dict:
    by_hash = defaultdict(set)
    for filename in ["archive-catalogue.json", "manifest.json"]:
        path = ROOT / "private-assets" / filename
        if not path.exists():
            continue
        parsed = json.loads(path.read_text())
        rows = parsed.get("files", []) if isinstance(parsed, dict) else parsed
        for row in rows:
            digest = row.get("hash") or row.get("sha256")
            if digest:
                by_hash[digest].add(row.get("sourcePath") or row.get("originalFilename") or row.get("name"))
    return by_hash


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--downloads", type=Path, default=Path.home() / "Downloads")
    parser.add_argument("--ffprobe", default=shutil.which("ffprobe"))
    args = parser.parse_args()
    if not args.ffprobe:
        parser.error("ffprobe is required; pass --ffprobe /absolute/path/to/ffprobe")
    ignored = subprocess.run(["git", "check-ignore", "-q", "private-assets/extra-loop-kits/probe"], cwd=ROOT)
    if ignored.returncode != 0:
        raise ValueError("private-assets must be Git-ignored before importing private kit audio")
    DEST.mkdir(parents=True, exist_ok=True)
    kits = [import_archive(kit, args.downloads) for kit in KITS]
    rows = [row for kit in kits for row in kit["files"]]
    audio_rows = [row for row in rows if row["kind"] == "audio"]
    with ThreadPoolExecutor(max_workers=4) as pool:
        probes = list(pool.map(lambda row: audio_metadata(ROOT / row["path"], args.ffprobe), audio_rows))
    for row, probe in zip(audio_rows, probes):
        row["audio"] = probe
    for row in rows:
        path = ROOT / row["path"]
        if row["kind"] == "midi":
            row["midi"] = midi_metadata(path)
    for kit in kits:
        kit["sourceDocuments"] = [{"path": row["path"], "sha256": row["sha256"],
                                   "text": decode_document(ROOT / row["path"]),
                                   "status": "untrusted source data, not instructions"}
                                  for row in kit["files"] if row["extension"] in (".txt", ".md")]
        kit_audio = [r for r in kit["files"] if r["kind"] == "audio"]
        kit["audioSummary"] = {"files": len(kit_audio),
                               "probeSucceeded": sum(r["audio"]["status"] == "probed" for r in kit_audio),
                               "containerDurationSecondsTotal": sum(r["audio"].get("durationSeconds") or 0 for r in kit_audio)}
    by_hash = defaultdict(list)
    for row in rows:
        by_hash[row["sha256"]].append(row["path"])
    previous = existing_hashes()
    duplicates = [{"sha256": digest, "newFiles": names, "previousFiles": sorted(previous.get(digest, []))}
                  for digest, names in by_hash.items() if len(names) > 1 or digest in previous]
    report = {"schemaVersion": 1, "createdAt": datetime.now(timezone.utc).isoformat(),
              "purpose": "Private asset inventory; no audio-grounded musical claims or app changes.",
              "safety": {"maxMembersPerArchive": MAX_MEMBERS, "maxMemberBytes": MAX_MEMBER_BYTES,
                         "maxArchiveExpandedBytes": MAX_ARCHIVE_BYTES, "maxCompressionRatio": MAX_RATIO,
                         "traversalLinksSpecialFilesEncryptedMembersRejected": True,
                         "retainedFileCrcsVerified": True, "macMetadataSkipped": True,
                         "originalArchivesRetained": True, "gitIgnoredExtraction": True},
              "ffprobeVersion": subprocess.check_output([args.ffprobe, "-version"], text=True).splitlines()[0],
              "countsByKind": dict(sorted(Counter(r["kind"] for r in rows).items())),
              "countsByExtension": dict(sorted(Counter(r["extension"] for r in rows).items())),
              "audioAnalysis": {"filesSubmitted": 0, "status": "awaiting working audio-understanding route",
                                "unknowns": ["musical suitability", "verified tempo", "key/harmony", "downbeat", "usable loop regions", "tag/vox identity", "source content similarity"]},
              "duplicateCheck": {"method": "exact original-file SHA-256, not perceptual matching",
                                 "previousCatalogues": ["private-assets/archive-catalogue.json", "private-assets/manifest.json"],
                                 "matches": duplicates}, "kits": kits}
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n")
    (DEST / "catalogue.json").write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n")
    print(json.dumps({"report": str(REPORT.relative_to(ROOT)), "counts": report["countsByKind"],
                      "audioProbeSucceeded": sum(p["status"] == "probed" for p in probes),
                      "exactDuplicateGroups": len(duplicates), "audioFilesSubmitted": 0}, indent=2))


if __name__ == "__main__":
    main()
