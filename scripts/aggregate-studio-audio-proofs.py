#!/usr/bin/env python3
"""Aggregate saved browser evidence without promoting responses to findings.

Direct album clips and mapped components of comparison files count only after a
response_observed proof passes local hash checks. Overlapping ranges are unioned.
The immutable preparation plan and original proofs are never rewritten.
"""
from __future__ import annotations
import argparse
import datetime as dt
import hashlib
import json
from pathlib import Path
from fractions import Fraction

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "deliverables/audio-research"


def digest(path):
    h = hashlib.sha256()
    with Path(path).open("rb") as f:
        for b in iter(lambda: f.read(1024 * 1024), b""):
            h.update(b)
    return h.hexdigest()


def union(ranges):
    result = []
    for start, end in sorted(ranges):
        if result and start <= result[-1][1]:
            result[-1][1] = max(end, result[-1][1])
        else:
            result.append([start, end])
    return result


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--proof-directory", type=Path, default=OUT / "proofs")
    p.add_argument("--plan", type=Path, default=OUT / "google-studio-album-plan-v1.json")
    p.add_argument("--reviews", type=Path, default=OUT / "google-studio-semantic-reviews.json")
    p.add_argument("--output", type=Path, default=OUT / "google-studio-coverage.json")
    p.add_argument("--sync-attempts", action="store_true", help="Append newly recorded attempts; preserve earlier UI failures")
    p.add_argument("--sync-status", action="store_true", help="Refresh only the Google checkpoint paragraph in STATUS.md")
    args = p.parse_args()
    plan = json.loads(args.plan.read_text())
    album = plan["source"]
    sr, total = album["decodedSampleRate"], album["decodedFrames"]
    mappings = {album["sha256"]: (0, total)}
    for clip in json.loads((OUT / "reference-clips.json").read_text()):
        if clip["sourceSha256"] == album["sha256"]:
            mappings[clip["sha256"]] = (clip["sourceStartFrame"], clip["sourceStartFrame"] + clip["frames"])
    for chunk in plan["chunks"]:
        mappings[chunk["clip"]["sha256"]] = (chunk["sourceStartFrame"], chunk["sourceEndFrameExclusive"])
    records, ranges, hashes = [], [], {}

    def checked(file):
        path = file["path"]
        if path not in hashes:
            hashes[path] = digest(path)
        if hashes[path] != file["sha256"]:
            raise ValueError("Hash mismatch: " + path)

    def mapped(hash_value, start_seconds, end_seconds):
        if hash_value not in mappings:
            return None
        base, limit = mappings[hash_value]
        begin = base + round(Fraction(str(start_seconds)) * sr)
        end = base + round(Fraction(str(end_seconds)) * sr)
        if not base <= begin < end <= limit:
            raise ValueError("Mapped component range exceeds known source")
        return [begin, end]

    for path in sorted(args.proof_directory.glob("*.json")):
        try:
            proof = json.loads(path.read_text())
        except json.JSONDecodeError:
            # Other local workers may be writing unrelated provider records.
            continue
        if proof.get("route") != "interactive_browser_file_upload":
            continue
        row = {"proofPath": str(path.resolve()), "proofSHA256": digest(path),
               "observedAt": proof.get("observedAt"), "executionStatus": proof.get("executionStatus"),
               "integrity": "verified", "albumRangesFrames": [],
               "attemptedAlbumRangesFrames": [],
               "submittedDurationSeconds": proof.get("submittedDurationSeconds"),
               "semanticReviewStatus": "unreviewed"}
        try:
            if proof.get("route") != "interactive_browser_file_upload":
                raise ValueError("Unexpected route")
            for file in [proof["source"], proof["clip"], proof["request"]["promptFile"],
                         proof["request"]["settingsFile"], proof["response"]["file"], *proof["evidence"]]:
                checked(file)
            selection = proof["sourceRange"]
            direct = mapped(proof["source"]["sha256"], selection["startSeconds"], selection["endSeconds"])
            if direct:
                row["attemptedAlbumRangesFrames"].append(direct)
            if proof.get("executionStatus") == "response_observed":
                if direct:
                    row["albumRangesFrames"].append(direct)
                provenance = proof.get("inputProvenance")
                if provenance:
                    prepared = provenance["record"]
                    prepared_hash = prepared.get("audioSHA256") or prepared.get("preferredUpload", {}).get("sha256")
                    if prepared_hash != proof["clip"]["sha256"]:
                        raise ValueError("Composite metadata does not identify submitted clip")
                    # Only this established two-part/whole-file schema maps here.
                    # Other montage types remain executed without inferred album coverage.
                    if prepared.get("kind") == "neutral-label-comparison":
                        for item in prepared["items"]:
                            checked(item["source"])
                            region = mapped(item["source"]["sha256"], *item["sourceRangeSeconds"])
                            if region:
                                row["albumRangesFrames"].append(region)
                    elif prepared.get("source") and prepared.get("sourceRangeSeconds"):
                        checked(prepared["source"])
                        region = mapped(prepared["source"]["sha256"], *prepared["sourceRangeSeconds"])
                        if region:
                            row["albumRangesFrames"].append(region)
                ranges.extend(row["albumRangesFrames"])
        except (OSError, KeyError, ValueError) as exc:
            row["integrity"] = "failed"
            row["integrityError"] = str(exc)
            row["albumRangesFrames"] = []
            row["attemptedAlbumRangesFrames"] = []
        records.append(row)

    reviews = json.loads(args.reviews.read_text()) if args.reviews.exists() else {"reviews": []}
    review_errors, accepted_ranges, accepted_claims = [], [], []
    for review in reviews.get("reviews", []):
        row = next((r for r in records if r["proofSHA256"] == review.get("proofSHA256")), None)
        if not row or row["integrity"] != "verified" or row["executionStatus"] != "response_observed":
            review_errors.append("Review has no intact successful proof: " + str(review.get("proofSHA256")))
            continue
        row["semanticReviewStatus"] = "claim_scoped_review_recorded"
        for claim in review.get("claims", []):
            if claim.get("status") == "corroborated" and claim.get("basis"):
                accepted_claims.append({"proofSHA256": row["proofSHA256"], **claim})
        # Full-range acceptance must be explicitly declared with a basis; a few
        # corroborated claims never automatically validate a whole audio interval.
        for accepted in review.get("acceptedAlbumRanges", []):
            begin, end = accepted.get("startFrame", -1), accepted.get("endFrameExclusive", -1)
            if (accepted.get("sourceSHA256") == album["sha256"] and accepted.get("basis")
                    and any(a <= begin < end <= b for a, b in row["albumRangesFrames"])):
                accepted_ranges.append([begin, end])
            else:
                review_errors.append("Rejected unsupported accepted range for " + row["proofPath"])
    executed = union(ranges)
    accepted = union(accepted_ranges)
    successful = [r for r in records if r["integrity"] == "verified" and r["executionStatus"] == "response_observed"]
    chunks = []
    for c in plan["chunks"]:
        proofs = [r["proofPath"] for r in successful if
                  any(a <= c["sourceStartFrame"] and b >= c["sourceEndFrameExclusive"] for a, b in r["albumRangesFrames"])]
        attempts = [r for r in records if r["integrity"] == "verified" and
                    any(a <= c["sourceStartFrame"] and b >= c["sourceEndFrameExclusive"] for a, b in r["attemptedAlbumRangesFrames"])]
        status = ("response_observed_unvalidated" if proofs else
                  attempts[-1]["executionStatus"] if attempts else "prepared_unsubmitted")
        chunks.append({"id": c["id"], "sourceStartFrame": c["sourceStartFrame"],
                       "sourceEndFrameExclusive": c["sourceEndFrameExclusive"],
                       "status": status, "proofs": proofs,
                       "attempts": [{"proofPath": r["proofPath"], "status": r["executionStatus"]} for r in attempts]})
    result = {"schemaVersion": 1, "generatedAt": dt.datetime.now(dt.timezone.utc).isoformat(),
              "sourceSHA256": album["sha256"], "sampleRate": sr, "sourceFrames": total,
              "preparationPlan": {"path": str(args.plan.resolve()), "sha256": digest(args.plan)},
              "observedSuccessfulResponses": len(successful), "observedFailuresOrIncomplete": len(records) - len(successful),
              "totalSubmittedAudioSecondsForSuccessfulResponses": sum(r["submittedDurationSeconds"] for r in successful),
              "executedAlbumRangesFrames": executed,
              "executedUniqueAlbumSeconds": sum(b - a for a, b in executed) / sr,
              "completedBroadChunks": sum(bool(c["proofs"]) for c in chunks), "plannedBroadChunks": len(chunks),
              "validatedAlbumRangesFrames": accepted,
              "validatedUniqueAlbumSeconds": sum(b - a for a, b in accepted) / sr,
              "acceptedClaims": accepted_claims, "reviewErrors": review_errors,
              "proofs": records, "broadChunks": chunks,
              "scope": "Execution means a saved browser response with intact local evidence. It is not a semantic judgment or proof of complete attention. Composite silence/app audio is not album coverage. Accepted claims and explicitly accepted ranges require separate hash-bound review records.",
              "initialFailures": "See google-ai-studio-attempts.json; earlier UI failures are preserved there."}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    temporary = args.output.with_suffix(args.output.suffix + ".tmp")
    temporary.write_text(json.dumps(result, indent=2) + "\n")
    temporary.replace(args.output)
    if args.sync_attempts:
        path = OUT / "google-ai-studio-attempts.json"
        attempts = json.loads(path.read_text())
        for row in records:
            if row["integrity"] != "verified":
                continue
            proof_path = Path(row["proofPath"])
            relative = str(proof_path.relative_to(OUT))
            if any(a.get("proof") == relative for a in attempts["attempts"]):
                continue
            proof = json.loads(proof_path.read_text())
            attempts["attempts"].append({"model": proof["model"]["observedUIIdentifier"] or proof["model"]["observedUILabel"],
                "thinking": proof["request"]["observedUISettings"].get("thinkingLevel"),
                "status": row["executionStatus"], "observedAt": row["observedAt"],
                "submittedDurationSeconds": row["submittedDurationSeconds"],
                "uiAudioTokens": proof.get("observedUIAudioTokens"), "proof": relative,
                "proofSHA256": row["proofSHA256"], "semanticValidation": row["semanticReviewStatus"],
                "context": proof["request"]["observedUISettings"].get("priorContext")})
        attempts["successfulAudioExecution"] = bool(successful)
        attempts["returnedMusicalAnalysis"] = [str(Path(r["proofPath"]).relative_to(OUT)) for r in successful]
        attempts["updatedAt"] = result["generatedAt"]
        attempts["limitation"] = "Earlier failures are retained. Browser audio execution sometimes succeeds and sometimes returns opaque errors. Musical claims require separate review; no hidden backend version attestation or paid API key is claimed. See google-studio-coverage.json and hash-bound semantic reviews."
        temp = path.with_suffix(".json.tmp")
        temp.write_text(json.dumps(attempts, indent=2) + "\n")
        temp.replace(path)
    if args.sync_status:
        path = OUT / "STATUS.md"
        lines = path.read_text().splitlines()
        replacement = (f"Google checkpoint: **{len(successful)} successful browser audio responses**, representing "
            f"**{result['totalSubmittedAudioSecondsForSuccessfulResponses']:.3f} submitted seconds** and "
            f"**{result['executedUniqueAlbumSeconds']:.3f} unique album seconds**. "
            f"**{result['completedBroadChunks']}/{len(chunks)} Google broad clips executed; "
            f"{result['validatedUniqueAlbumSeconds']:.3f} album seconds fully validated.** "
            "Failed/incomplete requests are excluded. Specific conflicting claims and the rejected current-render ending claim remain in separate reviews. "
            "[Broad/focused conflict review](../../docs/audio-research/google-broad001-conflict-review.md) · "
            "[Current control review](../../docs/audio-research/google-current-control-review.md) · "
            "[Live aggregation](./google-studio-coverage.json).")
        if sum(line.startswith("Google checkpoint:") for line in lines) != 1:
            raise ValueError("Expected one Google checkpoint paragraph; leave STATUS edits to the coordinator")
        path.write_text("\n".join(replacement if line.startswith("Google checkpoint:") else line for line in lines) + "\n")
    print(json.dumps({k: result[k] for k in ["observedSuccessfulResponses", "executedUniqueAlbumSeconds", "completedBroadChunks", "validatedUniqueAlbumSeconds", "reviewErrors"]}))


if __name__ == "__main__":
    main()
