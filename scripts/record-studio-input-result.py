#!/usr/bin/env python3
"""Manifest-driven wrapper for observed browser results. No browser/model access.

Example: --kind broad --id culture-google-002 --prefix google-studio-broad002
Requires exact saved request-dom/response/response-dom/PNG files and the observer's
model/settings/time/context metadata. Existing proof files are never replaced.
"""
import argparse
import importlib.util
import json
from pathlib import Path
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "deliverables/audio-research"


def preserve(path, text):
    if path.exists():
        if path.read_text() != text:
            raise ValueError("Existing evidence differs; choose a new prefix/attempt: " + str(path))
    else:
        with path.open("x") as f:
            f.write(text)


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--kind", choices=["broad", "detail", "audition", "current"], required=True)
    p.add_argument("--id", required=True, help="Prepared manifest ID; current uses full")
    p.add_argument("--prefix", required=True, help="Basename before -request-dom.txt / -response.txt / -response-dom.txt / -response.png")
    p.add_argument("--attempt", default="1")
    p.add_argument("--observed-at", required=True)
    p.add_argument("--prior-context", required=True)
    p.add_argument("--model-label", required=True)
    p.add_argument("--model-id")
    p.add_argument("--thinking", required=True)
    p.add_argument("--audio-tokens", type=int, help="Only the observed UI audio-token count; omit if unavailable or failed")
    p.add_argument("--max-output-tokens", type=int, default=4096)
    p.add_argument("--temperature", type=float)
    p.add_argument("--top-p", type=float)
    p.add_argument("--media-resolution", default="Default")
    p.add_argument("--input-manifest", type=Path, help="Alternate prepared records manifest for audition inputs or chunks manifest for broad inputs")
    p.add_argument("--note", default="")
    p.add_argument("--response-file", type=Path, help="Explicit saved text, e.g. exact UI error when model response is empty")
    p.add_argument("--prompt-file", type=Path, help="Use the observer's exact saved submitted prompt")
    p.add_argument("--evidence", action="append", type=Path, default=[], help="Additional exact UI evidence, such as an expanded settings DOM; may repeat")
    p.add_argument("--execution-status", default="response_observed", choices=["response_observed", "error_observed", "incomplete"])
    args = p.parse_args()
    if not re.fullmatch(r"[A-Za-z0-9_-]+", args.prefix + args.attempt):
        p.error("Use simple filenames for prefix and attempt")
    proof = OUT / "proofs" / f"{args.prefix}-proof-attempt{args.attempt}.json"
    if proof.exists():
        p.error("Immutable proof exists; choose a new attempt")
    stem = OUT / args.prefix
    request = Path(str(stem) + "-request-dom.txt")
    evidence = [request, Path(str(stem) + "-response-dom.txt"), Path(str(stem) + "-response.png"), *args.evidence]
    response = args.response_file or Path(str(stem) + "-response.txt")
    for path in [*evidence, response]:
        if not path.is_file():
            p.error("Missing completed evidence: " + str(path))
    dom = request.read_text()
    prompt_area = dom.split('  - textbox "Enter a prompt":')[-1]
    prompt = args.prompt_file.read_text() if args.prompt_file else next(
        (line[len("    - text: "):] for line in prompt_area.splitlines() if line.startswith("    - text: ")), None)
    if not prompt:
        p.error("Exact prompt not found in saved request DOM; do not guess")
    if not args.prompt_file and prompt.startswith('"'):
        prompt = json.loads(prompt)
    original = json.loads((OUT / "album-source.json").read_text())
    source, source_hash, source_sr, source_total = original["path"], original["sha256"], original["decodedSampleRate"], original["decodedFrames"]
    extra = []
    basis = "Decoded original album PCM frame zero; original unchanged"
    if args.kind == "broad":
        plan_path = args.input_manifest or OUT / "google-studio-album-plan-v1.json"
        plan = json.loads(plan_path.read_text())
        row = next(r for r in plan["chunks"] if r["id"] == args.id)
        clip, clip_hash = row["clip"]["path"], row["clip"]["sha256"]
        start, end = row["sourceStartFrame"], row["sourceEndFrameExclusive"]
        evidence.append(plan_path)
    elif args.kind == "detail":
        manifest = OUT / "detailed-v1-inputs.json"
        row = next(r for r in json.loads(manifest.read_text())["records"] if r["id"] == args.id)
        clip, clip_hash = row["audioPath"], row["audioSHA256"]
        start, end = row["source"]["start_frame"], row["source"]["end_frame_exclusive"]
        extra = ["--input-manifest", str(manifest), "--input-id", args.id]
    else:
        if args.kind == "current":
            report = json.loads((OUT / "current/render-report.json").read_text())
            row = next(r for r in report["outputs"] if r["name"] == args.id + ".wav")
            clip, clip_hash = str((OUT / "current" / row["name"]).resolve()), row["sha256"]
            evidence += [OUT / "current/render-report.json", OUT / "current/extra-audit.json"]
            basis = "Actual diagnostic render timeline; section and retained tail documented in render report"
        else:
            manifest = args.input_manifest or OUT / "auditions-v1-inputs.json"
            row = next(r for r in json.loads(manifest.read_text())["records"] if r["id"] == args.id)
            if "preferredUpload" in row:
                clip, clip_hash = row["preferredUpload"]["path"], row["preferredUpload"]["sha256"]
            else:
                clip, clip_hash = row["audioPath"], row["audioSHA256"]
            extra = ["--input-manifest", str(manifest), "--input-id", args.id]
            basis = "Prepared audition file timeline, including any artificial gaps; original-source mappings/processing embedded under inputProvenance"
        data = json.loads(subprocess.check_output(["ffprobe", "-v", "error", "-select_streams", "a:0", "-show_entries",
            "stream=sample_rate,duration_ts,time_base", "-of", "json", clip], text=True))["streams"][0]
        source_sr = int(data["sample_rate"])
        # MP3 container duration may lie between PCM frames; never truncate it
        # and mislabel the result as an exact decoded frame count.
        spec = importlib.util.spec_from_file_location("studio_proof_recorder", ROOT / "scripts/record-studio-audio-proof.py")
        recorder = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(recorder)
        channel_probe = recorder.probe(Path(clip), "ffprobe")["streams"][0]
        source_total = recorder.decoded_pcm_record(Path(clip), channel_probe["channels"])["frames"]
        source, source_hash, start, end = clip, clip_hash, 0, source_total
    duration = (end - start) / source_sr
    prompt_file, settings_file = args.prompt_file or Path(str(stem) + "-prompt.txt"), Path(str(stem) + "-settings.json")
    if not args.prompt_file:
        preserve(prompt_file, prompt + "\n")
    settings = {"thinkingLevel": args.thinking, "maximumOutputTokens": args.max_output_tokens,
        "mediaResolution": args.media_resolution, "apiKeySelection": "No API key selected",
        "tools": {"structuredOutputs": False, "codeExecution": False, "functionCalling": False,
                  "googleSearchGrounding": False, "googleMapsGrounding": False, "urlContext": False},
        "settingsBasis": "Coordinating browser observer; use saved DOM where expanded. No hidden settings inferred.",
        "priorContext": args.prior_context, "temperature": args.temperature,
        "temperatureObservation": "Observer-reported" if args.temperature is not None else "Not asserted",
        "topP": args.top_p, "systemInstructions": None,
        "systemInstructionsObservation": "Contents not asserted"}
    preserve(settings_file, json.dumps(settings, indent=2) + "\n")
    command = [sys.executable, str(ROOT / "scripts/record-studio-audio-proof.py"),
        "--source", source, "--source-sha256", source_hash, "--clip", clip, "--clip-sha256", clip_hash,
        "--source-start-frame", str(start), "--source-end-frame", str(end),
        "--source-sample-rate", str(source_sr), "--source-total-frames", str(source_total),
        "--source-coordinate-basis", basis, "--prompt", str(prompt_file), "--response", str(response),
        "--settings", str(settings_file), "--observed-model-label", args.model_label,
        "--observed-at", args.observed_at,
        "--execution-status", args.execution_status, "--output", str(proof),
        "--observer-note", f"Coordinating CUA observer reports actual prepared input {args.id}, duration{duration}s, and saved browser outcome. Timestamp has UI minute precision. Prior context: {args.prior_context} {args.note} Recorder performs no inference.", *extra]
    if args.model_id:
        command += ["--observed-model-id", args.model_id]
    if args.audio_tokens is not None:
        command += ["--observed-audio-tokens", str(args.audio_tokens)]
    for path in evidence:
        command += ["--evidence", str(path)]
    subprocess.run(command, check=True)
    subprocess.run([sys.executable, str(ROOT / "scripts/aggregate-studio-audio-proofs.py"),
                    "--sync-attempts", "--sync-status"], check=True)


if __name__ == "__main__":
    main()
