#!/usr/bin/env python3
"""Union intact local eight-bit broad proofs and reviewed browser execution records.

No inference is run. Execution coverage is separate from musical validation.
The original plans and raw proofs are never altered.
"""
from pathlib import Path
from fractions import Fraction
import datetime as dt
import hashlib
import json

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "deliverables/audio-research"


def sha(path):
    h = hashlib.sha256()
    with Path(path).open("rb") as f:
        for block in iter(lambda: f.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def union(ranges):
    result = []
    for a, b in sorted(ranges):
        if result and a <= result[-1][1]:
            result[-1][1] = max(result[-1][1], b)
        else:
            result.append([a, b])
    return result


def main():
    source = json.loads((OUT / "album-source.json").read_text())
    sr, total = source["decodedSampleRate"], source["decodedFrames"]
    if sha(source["path"]) != source["sha256"]:
        raise ValueError("Original album hash mismatch")
    accepted, incomplete, errors = [], [], []
    for p in sorted((OUT / "proofs").glob("culture-broad-*-local-moss-8bit-attempt1.json")):
        d = json.loads(p.read_text())
        if d.get("status") != "success" or not d.get("successful_audio_execution"):
            incomplete.append({"proof": str(p), "sha256": sha(p), "savedStatus": d.get("status"),
                "note": "Not included. A saved running state does not establish current process liveness; see interruption record."})
            continue
        try:
            audit = d["model_input_audit"]
            if (d["source"]["sha256"] != source["sha256"] or
                    not all(audit.get(k) for k in ["duration_check_passed", "mel_frame_coverage_check_passed", "context_check_passed", "complete_decoded_waveform_passed"]) or
                    audit.get("truncation_detected") or not d.get("final_response", "").strip() or
                    d.get("generation", {}).get("reached_token_cap")):
                raise ValueError("Source, full-input audit, final response or generation completion failed")
            clip = d["submitted_audio"]
            if sha(clip["filename"]) != clip["sha256"]:
                raise ValueError("Submitted clip hash mismatch")
            a, b = [round(Fraction(str(d["source"][k])) * sr) for k in ["clip_start_seconds", "clip_end_seconds"]]
            if not 0 <= a < b <= total or abs((b-a)/sr - clip["duration_seconds"]) > 1/sr:
                raise ValueError("Source range and submitted duration disagree")
            accepted.append({"provider": "local MOSS eight-bit", "proof": str(p), "sha256": sha(p),
                "sourceRangesFrames": [[a, b]], "submittedDurationSeconds": clip["duration_seconds"],
                "semanticStatus": "provisional; no fully validated source interval"})
        except (OSError, KeyError, ValueError) as exc:
            errors.append({"proof": str(p), "error": str(exc)})
    google_path = OUT / "google-studio-coverage.json"
    google = json.loads(google_path.read_text())
    if google["sourceSHA256"] != source["sha256"]:
        raise ValueError("Google aggregate source mismatch")
    for row in google["proofs"]:
        if row["integrity"] != "verified" or row["executionStatus"] != "response_observed" or not row["albumRangesFrames"]:
            continue
        if sha(row["proofPath"]) != row["proofSHA256"]:
            errors.append({"proof": row["proofPath"], "error": "Google proof changed since integrity aggregation"})
            continue
        accepted.append({"provider": "Google AI Studio browser", "proof": row["proofPath"], "sha256": row["proofSHA256"],
            "sourceRangesFrames": row["albumRangesFrames"], "submittedDurationSeconds": row["submittedDurationSeconds"],
            "semanticStatus": row["semanticReviewStatus"]})
    intervals = union([r for record in accepted for r in record["sourceRangesFrames"]])
    gaps, cursor = [], 0
    for a, b in intervals:
        if a > cursor:
            gaps.append([cursor, a])
        cursor = max(cursor, b)
    if cursor < total:
        gaps.append([cursor, total])
    frames = sum(b-a for a,b in intervals)
    result = {"schemaVersion": 1, "generatedAt": dt.datetime.now(dt.timezone.utc).isoformat(),
        "sourceSHA256": source["sha256"], "sampleRate": sr, "sourceFrames": total,
        "sourceDurationSeconds": total/sr, "executedRangesFrames": intervals,
        "executedRangesSeconds": [[a/sr,b/sr] for a,b in intervals],
        "executedUniqueSeconds": frames/sr, "executedPercent": 100*frames/total,
        "uncoveredRangesFrames": gaps, "uncoveredRangesSeconds": [[a/sr,b/sr] for a,b in gaps],
        "completeExecutionCoverage": frames == total and not gaps,
        "validatedMusicalCoverageSeconds": 0,
        "semanticScope": "No whole album interval is accepted as fully validated. This file only unions completed audio requests, not reliable musical findings, model attention or uniform-provider analysis.",
        "googleIntegrityManifest": {"path":str(google_path),"sha256":sha(google_path)},
        "acceptedExecutionRecords": accepted, "incompleteLocalRecords": incomplete, "errors": errors,
        "rawProofsOrPlansModified": False}
    target=OUT/"combined-album-coverage.json"
    tmp=target.with_suffix(".json.tmp");tmp.write_text(json.dumps(result,indent=2)+"\n");tmp.replace(target)
    print(json.dumps({k:result[k] for k in ["executedUniqueSeconds","executedPercent","completeExecutionCoverage","uncoveredRangesSeconds","errors"]}))


if __name__ == "__main__":
    main()
