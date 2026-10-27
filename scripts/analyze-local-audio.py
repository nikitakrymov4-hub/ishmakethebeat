#!/usr/bin/env python3
"""Run actual local music audio through pinned MOSS-Music/MLX with an audit proof.

An executed request is not semantic validation. Original audio is read only.
Use the isolated environment documented in docs/audio-research/local-audio-route.md.
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import json
import math
import os
from pathlib import Path
import platform
import re
import shutil
import subprocess
import sys
import time
from datetime import datetime, timezone

ROOT = Path(__file__).resolve().parents[1]
MODEL = "mlx-community/MOSS-Music-8B-Thinking-4bit"
MODEL_REGISTRY = {
    MODEL: {
        "revision": "b14123a419b6254b92d9e55b8a5b6f7285e05c70",
        "weights_sha256": "17560d5e601103ec84981673692f69602ed78ffeea07b522d731649cc9711a44",
        "directory": "MOSS-Music-8B-Thinking-4bit",
    },
    "rtikw/MOSS-Music-8B-Instruct-4bit": {
        "revision": "6b3e335a0e6ee62ea102d8d11521a7b435012618",
        "weights_sha256": "5e5cbf1f78e08250d6b2cf2b8bb4a1e982cbc29e5e2c2ff99cd2ae7eff539880",
        "directory": "MOSS-Music-8B-Instruct-4bit",
    },
    "mlx-community/MOSS-Music-8B-Thinking-8bit": {
        "revision": "7b2c41e689a46bbd7b395619ce9fd96041ff984c",
        "weights_sha256": "6da829b420899501d03c72658eac3850875b98e299ac712e42588c6eae126cda",
        "directory": "MOSS-Music-8B-Thinking-8bit",
    },
    "local/ish-moss-thinking4-adapters8-experiment-v1": {
        "revision": "local-adapter-precision-experiment-v1",
        "weights_sha256": "39881413701c6c72b7890e51f7048467a3d945711ccf339da5c7608dd693dc79",
        "directory": "MOSS-Music-8B-Thinking-4bit-adapters8-local-v1",
        "derivation": {
            "official_checkpoint": False, "experimental": True,
            "description": "Exact 4bit Thinking tensors with only audio/DeepStack adapters copied from 8bit Thinking; no requantization.",
            "build_script": "scripts/build-moss-hybrid.py",
            "sources": [
                {"model": "mlx-community/MOSS-Music-8B-Thinking-4bit",
                 "revision": "b14123a419b6254b92d9e55b8a5b6f7285e05c70",
                 "weights_sha256": "17560d5e601103ec84981673692f69602ed78ffeea07b522d731649cc9711a44"},
                {"model": "mlx-community/MOSS-Music-8B-Thinking-8bit",
                 "revision": "7b2c41e689a46bbd7b395619ce9fd96041ff984c",
                 "weights_sha256": "6da829b420899501d03c72658eac3850875b98e299ac712e42588c6eae126cda"},
            ],
        },
    },
}
MODEL_CACHE = {}
MODEL_FILE_AUDIT_CACHE = {}
DEFAULT_MODEL = "mlx-community/MOSS-Music-8B-Thinking-8bit"


def sha(path):
    with Path(path).open("rb") as handle:
        return hashlib.file_digest(handle, "sha256").hexdigest()


def audited_model_files(model_dir):
    """Hash once per unchanged file in this process, retaining explicit audit scope.

    Re-reading 10 GB of weights for every cached inference adds disk traffic and
    can evict model pages. This cache is never persisted across invocations.
    Any file identity, size, mtime or ctime change forces a fresh digest.
    """
    files, methods = {}, {}
    for name in ["config.json", "tokenizer_config.json", "model.safetensors"]:
        path = (model_dir / name).resolve(strict=True)
        before = path.stat()
        signature = (before.st_dev, before.st_ino, before.st_size,
                     before.st_mtime_ns, before.st_ctime_ns)
        cached = MODEL_FILE_AUDIT_CACHE.get(str(path))
        reused = cached is not None and cached[0] == signature
        if reused:
            digest, verified_at = cached[1], cached[2]
        else:
            digest, verified_at = sha(path), now()
            after = path.stat()
            if signature != (after.st_dev, after.st_ino, after.st_size,
                             after.st_mtime_ns, after.st_ctime_ns):
                raise ValueError(f"Model file changed during hashing: {name}")
            MODEL_FILE_AUDIT_CACHE[str(path)] = (signature, digest, verified_at)
        files[name] = {"sha256": digest, "bytes": before.st_size}
        methods[name] = {"sha256_computed_at": verified_at,
                         "reused_same_process_digest": reused,
                         "unchanged_file_identity_size_mtime_ctime": True}
    return files, methods


def write(path, record):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".preparing")
    temporary.write_text(json.dumps(record, indent=2, ensure_ascii=False) + "\n")
    temporary.replace(path)


def now():
    return datetime.now(timezone.utc).isoformat()


def memory_snapshot(mx):
    """Allocator counters, not process RSS; peak remains process-lifetime scoped."""
    return {"active_bytes": int(mx.get_active_memory()),
            "cache_bytes": int(mx.get_cache_memory()),
            "peak_active_bytes": int(mx.get_peak_memory())}


def program(name):
    executable = shutil.which(name)
    if executable is None:
        raise RuntimeError(f"{name} is required")
    return executable


def decode_audio(path):
    """Count actual decoded native frames, then downmix and resample explicitly."""
    import numpy as np
    ffmpeg, ffprobe = program("ffmpeg"), program("ffprobe")
    probe = json.loads(subprocess.check_output([
        ffprobe, "-v", "error", "-select_streams", "a:0", "-show_entries",
        "stream=sample_rate,channels,codec_name", "-of", "json", str(path)
    ]))["streams"][0]
    sample_rate, channels = int(probe["sample_rate"]), int(probe["channels"])
    native_bytes = subprocess.check_output([
        ffmpeg, "-v", "error", "-i", str(path), "-map", "0:a:0",
        "-f", "f32le", "-c:a", "pcm_f32le", "-"
    ])
    native_samples = len(native_bytes) // 4
    if native_samples % channels:
        raise ValueError("Decoded native PCM is not aligned to complete frames")
    frames = native_samples // channels
    # Arithmetic channel mean is declared explicitly, avoiding implicit channel weights.
    pan = "pan=mono|c0=" + "+".join(f"{1 / channels:.17g}*c{i}" for i in range(channels))
    pcm = subprocess.check_output([
        ffmpeg, "-v", "error", "-i", str(path), "-map", "0:a:0", "-af", pan,
        "-ar", "16000", "-ac", "1", "-f", "f32le", "-c:a", "pcm_f32le", "-"
    ])
    waveform = np.frombuffer(pcm, dtype="<f4").copy()
    if not waveform.size or not np.isfinite(waveform).all():
        raise ValueError("Empty or non-finite decoded audio")
    return waveform, {
        "input_codec": probe["codec_name"], "native_sample_rate": sample_rate,
        "native_channels": channels, "native_decoded_frames": frames,
        "native_decoded_samples_including_channels": native_samples,
        "native_duration_seconds": frames / sample_rate,
        "native_decoded_pcm_sha256": hashlib.sha256(native_bytes).hexdigest(),
        "model_sample_rate": 16000, "model_channels": 1,
        "model_sample_count": int(waveform.size), "model_duration_seconds": waveform.size / 16000,
        "model_float32_pcm_sha256": hashlib.sha256(pcm).hexdigest(),
        "downmix": "arithmetic mean of native channels", "downmix_filter": pan,
        "resampler": "FFmpeg default swresample at 16000 Hz", "gain_change_db": 0,
        "original_file_modified": False,
        "limitation": "Mono 16 kHz model input cannot substantiate original stereo width or fine upper-frequency texture.",
        "ffmpeg_version": subprocess.check_output([ffmpeg, "-version"], text=True).splitlines()[0],
    }


def main(argv=None, *, reuse_model=False):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--audio", type=Path, required=True, help="Actual already-cut clip, not a webpage")
    parser.add_argument("--source", type=Path, help="Original source whose file-relative timestamps are recorded")
    parser.add_argument("--source-start", type=float, default=0)
    parser.add_argument("--source-end", type=float)
    parser.add_argument("--prompt-file", type=Path, required=True)
    parser.add_argument("--proof", type=Path, required=True)
    parser.add_argument("--model", choices=MODEL_REGISTRY, default=DEFAULT_MODEL)
    parser.add_argument("--model-dir", type=Path, help="Local directory; weights must match the selected pinned model")
    parser.add_argument("--max-tokens", type=int, default=2048)
    parser.add_argument("--temperature", type=float, default=1.0, help="OpenMOSS demo default; zero explicitly enables greedy decoding")
    parser.add_argument("--top-p", type=float, default=1.0)
    parser.add_argument("--top-k", type=int, default=50)
    parser.add_argument("--min-p", type=float, default=0.0)
    parser.add_argument("--repetition-penalty", type=float, default=None, help="Optional MLX-supported experiment, not an asserted MOSS default")
    parser.add_argument("--repetition-context-size", type=int, default=100)
    parser.add_argument("--seed", type=int, default=20261016, help="Explicit MLX sampling seed recorded for reproducibility")
    parser.add_argument("--max-duration", type=float, default=120, help="Conservative integration guard; not claimed as a model limit")
    parser.add_argument("--prefill-step-size", type=int, default=256)
    parser.add_argument("--encoder-batch-size", type=int, default=2)
    parser.add_argument("--cache-limit-mib", type=int, default=256,
                        help="Cap unused MLX allocator cache; 0 disables caching. Does not raise memory or wired limits.")
    parser.add_argument("--coverage-chunk-id")
    parser.add_argument("--prepare-only", action="store_true", help="Decode and audit input without loading MLX/model")
    args = parser.parse_args(argv)
    registered = MODEL_REGISTRY[args.model]
    if args.model_dir is None:
        args.model_dir = ROOT / "private-assets/audio-research/models" / registered["directory"]
    if args.proof.exists():
        parser.error("Proof already exists; choose a new name to preserve prior executions")
    if args.max_tokens < 1 or args.prefill_step_size < 1 or args.encoder_batch_size < 1:
        parser.error("Token and batch limits must be positive")
    if args.cache_limit_mib < 0:
        parser.error("Cache limit must be nonnegative")
    if (not math.isfinite(args.temperature) or args.temperature < 0 or
            not 0 < args.top_p <= 1 or not 0 <= args.min_p <= 1 or args.top_k < 0 or
            args.repetition_context_size < 1 or args.seed < 0 or
            (args.repetition_penalty is not None and (not math.isfinite(args.repetition_penalty) or args.repetition_penalty <= 0))):
        parser.error("Invalid sampling options")
    audio = args.audio.resolve(strict=True)
    source = (args.source or audio).resolve(strict=True)
    prompt = args.prompt_file.read_text().strip()
    if not prompt:
        parser.error("Prompt must not be empty")
    proof = {
        "schema_version": 1, "provider": "local MLX Audio", "model": args.model,
        "model_revision": registered["revision"], "status": "preparing", "started_at": now(),
        "successful_audio_execution": False, "submitted_request": False,
        "source": {"filename": str(source), "sha256": sha(source),
                   "clip_start_seconds": args.source_start, "clip_end_seconds": args.source_end},
        "submitted_audio": {"filename": str(audio), "sha256": sha(audio), "bytes": audio.stat().st_size},
        "request_options": {"prompt": prompt, "max_tokens": args.max_tokens, "temperature": args.temperature,
                            "top_p": args.top_p, "top_k": args.top_k, "min_p": args.min_p,
                            "repetition_penalty": args.repetition_penalty,
                            "repetition_context_size": args.repetition_context_size, "seed": args.seed,
                            "strip_thinking": False, "enable_time_marker": True,
                            "prefill_step_size": args.prefill_step_size, "encoder_batch_size": args.encoder_batch_size,
                            "cache_limit_mib": args.cache_limit_mib,
                            "trust_remote_code": False, "local_files_only": True},
        "model_audio_limits": {"cap_seconds": args.max_duration,
            "cap_basis": "Explicit client safety guard; longer audio is rejected, never silently truncated. This is not an asserted upstream maximum."},
        "runtime": {"python": sys.version.split()[0], "platform": platform.platform(),
                    "versions": {name: importlib.metadata.version(name) for name in [
                        "mlx-audio", "mlx", "mlx-metal", "numpy", "transformers", "huggingface_hub", "safetensors"]}},
        "returned_response": "", "content_reliability": {"status": "unreviewed",
            "note": "Execution and full input coverage do not establish correct musical judgment. Separate contrast controls and corroboration are required."},
    }
    if "derivation" in registered:
        proof["model_derivation"] = registered["derivation"]
    if args.coverage_chunk_id:
        proof["coverageChunkId"] = args.coverage_chunk_id
    write(args.proof, proof)
    mx_runtime = None
    try:
        waveform, preprocessing = decode_audio(audio)
        duration = preprocessing["model_duration_seconds"]
        native_duration = preprocessing["native_duration_seconds"]
        if native_duration > args.max_duration + 1 / preprocessing["native_sample_rate"]:
            raise ValueError(f"Clip {native_duration:.6f}s exceeds explicit {args.max_duration}s guard; split it first")
        if abs(duration - native_duration) > 1 / 16000:
            raise ValueError("Decoded and resampled duration differ by more than one output sample")
        source_end = args.source_end if args.source_end is not None else args.source_start + native_duration
        if args.source_start < 0 or abs(source_end - args.source_start - native_duration) > 1 / 16000:
            raise ValueError("Source range must match the complete submitted clip duration")
        proof["source"]["clip_end_seconds"] = source_end
        proof["submitted_audio"].update({"duration_seconds": duration, "sample_rate": 16000, "channels": 1,
            "sample_count": len(waveform), "payload_type": "actual decoded float32 waveform array",
            "payload_sha256": preprocessing["model_float32_pcm_sha256"]})
        proof["preprocessing"] = preprocessing
        if args.prepare_only:
            proof.update(status="prepared_not_submitted", finished_at=now())
            write(args.proof, proof)
            print(json.dumps({"proof": str(args.proof), "status": proof["status"], "duration": duration}))
            return
        model_dir = args.model_dir.resolve(strict=True)
        if not (model_dir / "model.safetensors").is_file():
            raise FileNotFoundError("Pinned model.safetensors has not finished downloading")
        os.environ["HF_HOME"] = str(ROOT / "private-assets/audio-research/models/hf-cache")
        os.environ["HF_HUB_OFFLINE"] = "1"
        os.environ["HF_HUB_DISABLE_IMPLICIT_TOKEN"] = "1"
        os.environ["TRANSFORMERS_OFFLINE"] = "1"
        import mlx.core as mx
        mx_runtime = mx
        mx.synchronize()
        memory_before_policy = memory_snapshot(mx)
        cache_limit_bytes = args.cache_limit_mib * 1024 * 1024
        previous_cache_limit = mx.set_cache_limit(cache_limit_bytes)
        proof["runtime"]["memory_policy"] = {
            "cache_limit_mib": args.cache_limit_mib, "cache_limit_bytes": cache_limit_bytes,
            "previous_cache_limit_bytes": int(previous_cache_limit),
            "memory_limit_bytes": int(mx.get_memory_limit()),
            "memory_limit_changed": False, "wired_limit_changed": False,
            "peak_scope": "Process lifetime; not reset between serial batch requests.",
            "counter_scope": "MLX allocator counters, not process RSS or total system memory.",
            "cache_scope": "Unused reusable allocations only; does not cap active model or KV-cache tensors.",
            "clear_unused_cache_after_request": True,
        }
        proof["runtime"]["memory_snapshots"] = {"before_cache_policy": memory_before_policy}
        from mlx_audio.stt import load
        from mlx_audio.stt.models.moss_music.processor import MossMusicProcessor
        from transformers import AutoTokenizer
        # The installed processor's default is True. Use the standard local Qwen2
        # tokenizer with False explicitly; model-repository Python is never fetched.
        def local_tokenizer(self, path):
            return AutoTokenizer.from_pretrained(str(path), trust_remote_code=False,
                                                 local_files_only=True, use_fast=False)
        MossMusicProcessor._load_tokenizer = local_tokenizer
        proof["runtime"]["implementation_sha256"] = {
            str(path.name): sha(path) for path in Path(sys.modules[MossMusicProcessor.__module__].__file__).parent.glob("*.py")}
        proof["model_files"], proof["runtime"]["model_file_hash_audit"] = audited_model_files(model_dir)
        if proof["model_files"]["model.safetensors"]["sha256"] != registered["weights_sha256"]:
            raise ValueError("Model weights do not match the pinned checkpoint's verified LFS SHA256")
        proof["status"] = "loading_local_model"
        write(args.proof, proof)
        cache_key = (str(model_dir), registered["weights_sha256"])
        if reuse_model and cache_key in MODEL_CACHE:
            model, original_processor = MODEL_CACHE[cache_key]
            proof["runtime"]["loaded_model_reused"] = True
            print("Reusing loaded local MOSS-Music checkpoint…", flush=True)
        else:
            # Only one checkpoint remains resident during a serial batch.
            MODEL_CACHE.clear()
            print("Loading local MOSS-Music checkpoint…", flush=True)
            model = load(model_dir, strict=True)
            original_processor = model._ensure_processor()
            if reuse_model:
                MODEL_CACHE[cache_key] = (model, original_processor)
            proof["runtime"]["loaded_model_reused"] = False
        model.config.audio_config.conv_chunksize = args.encoder_batch_size
        context_limit = model.config.language_config.max_position_embeddings
        proof["model_audio_limits"]["language_context_tokens"] = context_limit
        proof["model_audio_limits"]["encoder_window_mel_frames"] = model.config.audio_config.n_window * 2

        class AuditedProcessor:
            def __getattr__(self, name):
                return getattr(original_processor, name)

            def __call__(self, **kwargs):
                processed = original_processor(**kwargs)
                actual_duration = processed.audio_durations[0]
                mel_frames = int(processed.audio_data_seqlens.tolist()[0])
                prompt_tokens = int(processed.input_ids.shape[0])
                if abs(actual_duration - duration) > 1 / 16000:
                    raise ValueError("Model processor duration does not match complete submitted waveform")
                if abs(mel_frames * .01 - duration) > .011:
                    raise ValueError("Model mel frames do not cover the submitted duration")
                if prompt_tokens + args.max_tokens > context_limit:
                    raise ValueError("Request exceeds model language context; no truncated request was made")
                import numpy as np
                actual_waveform_sha = hashlib.sha256(np.asarray(kwargs["audio"], dtype="<f4").tobytes()).hexdigest()
                if actual_waveform_sha != preprocessing["model_float32_pcm_sha256"]:
                    raise ValueError("Actual model processor waveform differs from the audited submitted payload")
                mel_sha = hashlib.sha256(np.asarray(processed.audio_data, dtype="<f4").tobytes()).hexdigest()
                proof["model_input_audit"] = {
                    "processed_duration_seconds": actual_duration, "processed_mel_frames": mel_frames,
                    "actual_processor_waveform_sha256": actual_waveform_sha, "processed_mel_sha256": mel_sha,
                    "audio_tokens": processed.token_lens, "prompt_tokens": prompt_tokens,
                    "complete_decoded_waveform_passed": True, "duration_check_passed": True,
                    "mel_frame_coverage_check_passed": True, "context_check_passed": True,
                    "truncation_detected": False,
                    "method": "Observed the actual processor call used by generate; complete mel sequence is encoded in consecutive windows with embedding-count validation in the maintained model code."}
                proof.update(status="inference_running", submitted_request=True)
                write(args.proof, proof)
                return processed

        model._processor = AuditedProcessor()
        mx.random.seed(args.seed)
        mx.synchronize()
        proof["runtime"]["memory_snapshots"]["before_generation"] = memory_snapshot(mx)
        write(args.proof, proof)
        print(f"Submitting {duration:.6f}s / {len(waveform)} actual mono PCM samples…", flush=True)
        started = time.monotonic()
        result = model.generate(waveform, prompt=prompt, max_tokens=args.max_tokens,
            temperature=args.temperature, top_p=args.top_p, top_k=args.top_k, min_p=args.min_p,
            repetition_penalty=args.repetition_penalty, repetition_context_size=args.repetition_context_size,
            strip_thinking=False, enable_time_marker=True,
            prefill_step_size=args.prefill_step_size)
        mx.synchronize()
        proof["runtime"]["memory_snapshots"]["after_generation"] = memory_snapshot(mx)
        raw_text = result.text
        final_text = re.sub(r"<think>[\s\S]*?</think>\s*", "", raw_text).strip()
        unclosed_thinking = "<think>" in raw_text and "</think>" not in raw_text
        proof.update(status="success", successful_audio_execution=bool(raw_text),
            returned_response=raw_text, final_response="" if unclosed_thinking else final_text,
            finished_at=now(), execution_seconds=time.monotonic() - started,
            generation={"prompt_tokens": result.prompt_tokens, "generation_tokens": result.generation_tokens,
                        "total_tokens": result.total_tokens, "generation_tps": result.generation_tps,
                        "reached_token_cap": result.generation_tokens >= args.max_tokens,
                        "thinking_unclosed": unclosed_thinking,
                        "mlx_peak_memory_bytes": mx.get_peak_memory()})
        if unclosed_thinking or result.generation_tokens >= args.max_tokens:
            proof["content_reliability"]["generation_warning"] = "Generation reached its limit or unfinished thinking; no complete final answer is assumed."
        write(args.proof, proof)
        print(json.dumps({"proof": str(args.proof), "status": proof["status"],
                          "seconds": proof["execution_seconds"], "final_response": proof["final_response"]}, ensure_ascii=False))
    except Exception as error:
        proof.update(status="failed", error={"type": type(error).__name__, "message": str(error)}, finished_at=now())
        write(args.proof, proof)
        print(json.dumps({"proof": str(args.proof), "status": "failed", "error": proof["error"]}), file=sys.stderr)
        raise SystemExit(1)
    finally:
        if mx_runtime is not None:
            try:
                mx_runtime.synchronize()
                snapshots = proof["runtime"].setdefault("memory_snapshots", {})
                snapshots["before_cache_clear"] = memory_snapshot(mx_runtime)
                mx_runtime.clear_cache()
                mx_runtime.synchronize()
                snapshots["after_cache_clear"] = memory_snapshot(mx_runtime)
                proof["runtime"]["cache_cleanup"] = {"status": "completed", "at": now()}
            except Exception as cleanup_error:
                proof["runtime"]["cache_cleanup"] = {
                    "status": "failed", "type": type(cleanup_error).__name__, "message": str(cleanup_error)}
            write(args.proof, proof)


def batch(argv, *, runner=None):
    """Serial execution only. Each manifest job supplies the ordinary CLI arguments."""
    parser = argparse.ArgumentParser(description="Reuse a local model for serial audited audio requests")
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--summary", type=Path, required=True)
    parser.add_argument("--continue-on-failure", action="store_true")
    args = parser.parse_args(argv)
    request_runner = runner or main
    if args.summary.exists():
        parser.error("Batch summary already exists; use a new path")
    document = json.loads(args.manifest.read_text())
    jobs = document["requests"]
    if not isinstance(jobs, list) or not jobs:
        parser.error("Manifest must contain a nonempty requests list")
    paths = set()
    for job in jobs:
        arguments = job.get("arguments")
        if not isinstance(arguments, list) or not all(isinstance(item, str) for item in arguments):
            parser.error("Every request needs an arguments array of CLI strings")
        if "--proof" not in arguments or arguments.index("--proof") == len(arguments) - 1:
            parser.error("Every request needs --proof and a unique new proof path")
        proof = Path(arguments[arguments.index("--proof") + 1]).resolve()
        if proof.exists() or proof in paths:
            parser.error(f"Proof path exists or is duplicated: {proof}")
        paths.add(proof)
    report = {"status": "running", "started_at": now(), "manifest": str(args.manifest.resolve()),
              "manifest_sha256": sha(args.manifest), "serial_execution": True,
              "planned_requests": len(jobs), "requests": [],
              "semantic_acceptance": "Not performed. Individual successful executions are unreviewed."}
    write(args.summary, report)
    for index, job in enumerate(jobs):
        arguments = job["arguments"]
        proof_path = Path(arguments[arguments.index("--proof") + 1])
        exit_code = 0
        try:
            request_runner(arguments, reuse_model=True)
        except SystemExit as error:
            exit_code = int(error.code or 0)
        proof = json.loads(proof_path.read_text()) if proof_path.exists() else {}
        report["requests"].append({"index": index, "id": job.get("id"), "proof": str(proof_path),
            "proof_sha256": sha(proof_path) if proof_path.exists() else None,
            "status": proof.get("status", "failed_before_proof"), "exit_code": exit_code,
            "successful_audio_execution": proof.get("successful_audio_execution", False),
            "final_answer_present": bool(proof.get("final_response")),
            "reached_token_cap": proof.get("generation", {}).get("reached_token_cap")})
        write(args.summary, report)
        if exit_code and not args.continue_on_failure:
            break
    report.update(status="finished" if len(report["requests"]) == len(jobs) else "stopped_on_failure", finished_at=now())
    write(args.summary, report)
    print(json.dumps({"batch_summary": str(args.summary), "status": report["status"], "completed_requests": len(report["requests"])}))


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "batch":
        batch(sys.argv[2:])
    else:
        main()
