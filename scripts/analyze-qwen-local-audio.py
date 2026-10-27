#!/usr/bin/env python3
"""Audited Qwen2-Audio MLX fallback with a verified official Whisper frontend.

The maintained MLX model's handwritten HTK frontend differs from its checkpoint's
Whisper configuration. This client uses the installed standard Transformers
WhisperFeatureExtractor, checks it against independent NumPy DSP, and rejects
inputs longer than 30 seconds before inference. No checkpoint Python is executed.
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import importlib.util
import json
import os
from pathlib import Path
import sys
import time
import types

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
MODEL = "mlx-community/Qwen2-Audio-7B-Instruct-4bit"
REVISION = "c65570002626f41b4dc08b7b54f42f99f3e82e7f"
WEIGHTS_SHA256 = "0967cde270ad62aa4824f0bbce283d0a2a6da2825ccf587640753c527d4174da"
MODEL_DIR = ROOT / "private-assets/audio-research/models/Qwen2-Audio-7B-Instruct-4bit"
MODEL_CACHE = {}
spec = importlib.util.spec_from_file_location("audited_audio_common", ROOT / "scripts/analyze-local-audio.py")
common = importlib.util.module_from_spec(spec)
spec.loader.exec_module(common)


def independent_numpy_mel(waveform):
    """Independent periodic-Hann FFT and continuous Slaney normalized triangles."""
    padded = np.pad(waveform.astype(np.float64), (0, 480000 - len(waveform)))
    padded = np.pad(padded, (200, 200), mode="reflect")
    frames = np.lib.stride_tricks.sliding_window_view(padded, 400)[::160]
    window = .5 - .5 * np.cos(2 * np.pi * np.arange(400) / 400)
    power = np.abs(np.fft.rfft(frames * window, axis=-1)) ** 2
    max_mel = 15 + np.log(8000 / 1000) / (np.log(6.4) / 27)
    points = np.linspace(0, max_mel, 130)
    hz = np.where(points >= 15, 1000 * np.exp((points - 15) * np.log(6.4) / 27), points * 200 / 3)
    frequencies = np.linspace(0, 8000, 201)
    lower = (frequencies[:, None] - hz[:-2]) / (hz[1:-1] - hz[:-2])
    upper = (hz[2:] - frequencies[:, None]) / (hz[2:] - hz[1:-1])
    filters = np.maximum(0, np.minimum(lower, upper)) * (2 / (hz[2:] - hz[:-2]))
    log_mel = np.log10(np.maximum(power @ filters, 1e-10)).T[:, :-1]
    log_mel = np.maximum(log_mel, log_mel.max() - 8)
    return ((log_mel + 4) / 4)[None].astype(np.float32)


def official_frontend(waveform, model_dir):
    from transformers import WhisperFeatureExtractor
    if len(waveform) > 480000:
        raise ValueError("Qwen2-Audio input exceeds 480000 samples / 30 seconds; split explicitly")
    extractor = WhisperFeatureExtractor.from_pretrained(str(model_dir), local_files_only=True)
    if (extractor.sampling_rate, extractor.n_fft, extractor.hop_length, extractor.feature_size, extractor.n_samples) != (16000, 400, 160, 128, 480000):
        raise ValueError("Unexpected checkpoint frontend configuration")
    # Disallow truncation. Zero padding is part of the checkpoint's fixed input shape.
    result = extractor(waveform, sampling_rate=16000, return_tensors="np", padding="max_length",
                       max_length=480000, truncation=False, return_attention_mask=True, do_normalize=False)
    features = np.asarray(result.input_features, dtype=np.float32)
    reference = independent_numpy_mel(waveform)
    if features.shape != (1, 128, 3000) or not np.isfinite(features).all():
        raise ValueError(f"Unexpected actual HF feature shape/data: {features.shape}")
    difference = np.abs(features - reference)
    max_difference = float(difference.max())
    if max_difference > 1e-5:
        raise ValueError(f"Independent frontend parity failed: max difference {max_difference}")
    return features, {
        "status": "passed", "actual_source_waveform_sha256": hashlib.sha256(waveform.astype("<f4").tobytes()).hexdigest(),
        "official_frontend": "Transformers WhisperFeatureExtractor (installed standard code, local checkpoint config)",
        "official_feature_shape": list(features.shape), "official_features_sha256": hashlib.sha256(features.astype("<f4").tobytes()).hexdigest(),
        "independent_reference": "NumPy float64 periodic Hann / centered reflect padding / FFT power / continuous Slaney normalized triangular filters / final-frame removal / Whisper log dynamic range",
        "independent_max_absolute_difference": max_difference, "independent_rms_difference": float(np.sqrt(np.mean(difference ** 2))),
        "tolerance": 1e-5, "observed_input_samples": len(waveform), "padded_samples": 480000 - len(waveform),
        "valid_mel_frames_from_attention_mask": int(np.asarray(result.attention_mask).sum()),
        "frontend_duration_cap_seconds": 30, "input_truncated": False,
    }


def main(argv=None, *, reuse_model=False):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--audio", type=Path, required=True)
    parser.add_argument("--source", type=Path)
    parser.add_argument("--source-start", type=float, default=0)
    parser.add_argument("--source-end", type=float)
    parser.add_argument("--prompt-file", type=Path, required=True)
    parser.add_argument("--proof", type=Path, required=True)
    parser.add_argument("--model-dir", type=Path, default=MODEL_DIR)
    parser.add_argument("--prepare-only", action="store_true")
    parser.add_argument("--max-tokens", type=int, default=512)
    parser.add_argument("--temperature", type=float, default=0)
    parser.add_argument("--top-p", type=float, default=1)
    parser.add_argument("--top-k", type=int, default=0)
    parser.add_argument("--seed", type=int, default=20261016)
    parser.add_argument("--coverage-chunk-id")
    args = parser.parse_args(argv)
    if args.proof.exists():
        parser.error("Proof already exists; choose a new path")
    if args.max_tokens < 1 or not np.isfinite(args.temperature) or args.temperature < 0 or not 0 < args.top_p <= 1 or args.top_k < 0 or args.seed < 0:
        parser.error("Invalid generation options")
    audio = args.audio.resolve(strict=True)
    source = (args.source or audio).resolve(strict=True)
    model_dir = args.model_dir.resolve(strict=True)
    prompt = args.prompt_file.read_text().strip()
    if not prompt:
        parser.error("Prompt must not be empty")
    os.environ["HF_HOME"] = str(ROOT / "private-assets/audio-research/models/hf-cache")
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["HF_HUB_DISABLE_IMPLICIT_TOKEN"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    proof = {
        "schema_version": 1, "provider": "local MLX Audio with standard HF Whisper frontend",
        "model": MODEL, "model_revision": REVISION, "status": "preparing", "started_at": common.now(),
        "source": {"filename": str(source), "sha256": common.sha(source), "clip_start_seconds": args.source_start, "clip_end_seconds": args.source_end},
        "submitted_audio": {"filename": str(audio), "sha256": common.sha(audio), "bytes": audio.stat().st_size},
        "request_options": {"prompt": prompt, "max_tokens": args.max_tokens, "temperature": args.temperature,
            "top_p": args.top_p, "top_k": args.top_k, "seed": args.seed, "prefill_step_size": 256,
            "trust_remote_code": False, "local_files_only": True, "frontend_override": "WhisperFeatureExtractor, checked against independent NumPy DSP"},
        "model_audio_limits": {"cap_seconds": 30, "cap_basis": "Checkpoint frontend 480000 samples at16000Hz; client rejects oversize input before model", "language_context_tokens": 8192},
        "runtime": {"python": sys.version.split()[0], "versions": {p: importlib.metadata.version(p) for p in ["mlx-audio", "mlx", "mlx-metal", "transformers", "numpy"]}},
        "successful_audio_execution": False, "submitted_request": False, "returned_response": "",
        "content_reliability": {"status": "unreviewed", "note": "Actual execution is not verified musical interpretation. Require contrast controls and corroboration."},
    }
    if args.coverage_chunk_id:
        proof["coverageChunkId"] = args.coverage_chunk_id
    common.write(args.proof, proof)
    try:
        waveform, preprocessing = common.decode_audio(audio)
        if len(waveform) > 480000 or preprocessing["native_duration_seconds"] > 30 + 1 / 16000:
            raise ValueError("Source exceeds30secondcap; no truncated model request submitted")
        native_duration = preprocessing["native_duration_seconds"]
        source_end = args.source_end if args.source_end is not None else args.source_start + native_duration
        if args.source_start < 0 or abs(source_end - args.source_start - native_duration) > 1 / 16000:
            raise ValueError("Source range does not match complete native clip")
        proof["source"]["clip_end_seconds"] = source_end
        proof["preprocessing"] = preprocessing
        proof["submitted_audio"].update({"duration_seconds": len(waveform) / 16000, "sample_rate": 16000, "channels": 1,
            "sample_count": len(waveform), "payload_type": "actual decoded float32 waveform array", "payload_sha256": preprocessing["model_float32_pcm_sha256"]})
        features, parity = official_frontend(waveform, model_dir)
        proof["frontend_numerical_parity"] = parity
        from transformers import AutoTokenizer
        tokenizer = AutoTokenizer.from_pretrained(str(model_dir), trust_remote_code=False, local_files_only=True)
        expected_prompt = tokenizer.apply_chat_template([
            {"role": "user", "content": "Audio 1: <|audio_bos|>" + "<|AUDIO|>" * 750 + "<|audio_eos|>\n" + prompt}
        ], tokenize=False, add_generation_prompt=True)
        expected_ids = tokenizer.encode(expected_prompt)
        if len(expected_ids) + args.max_tokens > 8192:
            raise ValueError("Prompt and output would exceed context; request rejected")
        proof["tokenizer_preflight"] = {"status": "passed", "class": type(tokenizer).__name__,
            "prompt_tokens": len(expected_ids), "audio_tokens": 750,
            "template": "checkpoint local ChatML template, Audio1 audio_bos/750AUDIO/audio_eos then text",
            "prompt_ids_sha256": hashlib.sha256(np.asarray(expected_ids, dtype="<i4").tobytes()).hexdigest(),
            "context_check_passed": True, "trust_remote_code": False}
        proof["model_input_audit"] = {"native_decoded_frames": preprocessing["native_decoded_frames"],
            "resampled_samples": len(waveform), "input_cap_samples": 480000,
            "zero_padding_samples": 480000 - len(waveform), "processed_mel_frames": 3000,
            "input_truncated": False, "all_input_samples_retained": True,
            "limitation": "The installed HF Qwen2AudioEncoder also ignores its input_features attention_mask. Frontend numerical parity does not prove complete MLX/HF graph parity or perceptual reliability. This client uses750audio-token positions; short-input equivalence is unvalidated. Actual input is retained without truncation."}
        if args.prepare_only:
            proof.update(status="prepared_not_submitted", finished_at=common.now())
            common.write(args.proof, proof)
            print(json.dumps({"proof": str(args.proof), "status": proof["status"], "frontend_parity": parity}))
            return
        if not (model_dir / "weights.safetensors").is_file():
            raise FileNotFoundError("Pinned Qwen weights are not downloaded")
        digest = common.sha(model_dir / "weights.safetensors")
        if digest != WEIGHTS_SHA256:
            raise ValueError("Qwen weights differ from pinned LFS SHA256")
        proof["model_files"] = {"weights.safetensors": {"sha256": digest, "bytes": (model_dir / "weights.safetensors").stat().st_size}}
        import mlx.core as mx
        from mlx_audio.stt import load
        from mlx_audio.stt.models.qwen2_audio.qwen2_audio import Model
        def safe_post_load(cls, model, path):
            model._processor = types.SimpleNamespace(tokenizer=tokenizer)
            enc = model.audio_tower
            enc._embed_positions = enc._embed_positions.astype(enc.conv1.weight.dtype)
            mx.eval(enc._embed_positions)
            return model
        Model.post_load_hook = classmethod(safe_post_load)
        proof["runtime"]["implementation_sha256"] = {"qwen2_audio.py": common.sha(Path(sys.modules[Model.__module__].__file__)), "client": common.sha(Path(__file__))}
        proof["status"] = "loading_local_model"
        common.write(args.proof, proof)
        cache_key = (str(model_dir), WEIGHTS_SHA256)
        if reuse_model and cache_key in MODEL_CACHE:
            model = MODEL_CACHE[cache_key]
            proof["runtime"]["loaded_model_reused"] = True
            print("Reusing loaded Qwen2-Audio checkpoint…", flush=True)
        else:
            MODEL_CACHE.clear()
            print("Loading pinned Qwen2-Audio model with verified HF frontend…", flush=True)
            model = load(model_dir, strict=True)
            if reuse_model:
                MODEL_CACHE[cache_key] = model
            proof["runtime"]["loaded_model_reused"] = False
        ids = model._build_prompt([750], prompt)
        if ids.tolist() != expected_ids:
            raise ValueError("Prompt tokenization differs from checkpoint tokenizer's ChatML template")
        if len(ids) + args.max_tokens > 8192:
            raise ValueError("Prompt and output would exceed context; request rejected")
        proof["model_input_audit"].update(prompt_tokens=len(ids), audio_tokens=750, prompt_template_checked=True)
        feature_calls = 0
        def verified_features(self, actual_audio):
            nonlocal feature_calls
            actual = np.asarray(actual_audio, dtype="<f4").reshape(-1)
            if hashlib.sha256(actual.tobytes()).hexdigest() != preprocessing["model_float32_pcm_sha256"]:
                raise ValueError("Actual model waveform differs from audited source payload")
            feature_calls += 1
            proof["model_input_audit"].update(actual_frontend_call_count=feature_calls,
                actual_waveform_sha256=preprocessing["model_float32_pcm_sha256"],
                float32_mel_sha256=parity["official_features_sha256"])
            proof.update(submitted_request=True, status="inference_running")
            common.write(args.proof, proof)
            return mx.array(features, dtype=self.audio_tower.conv1.weight.dtype), 750
        model._extract_features = types.MethodType(verified_features, model)
        mx.random.seed(args.seed)
        started = time.monotonic()
        result = model.generate(waveform, prompt=prompt, max_tokens=args.max_tokens, temperature=args.temperature,
            top_p=args.top_p, top_k=args.top_k, prefill_step_size=256)
        proof.update(status="success", successful_audio_execution=bool(result.text), returned_response=result.text,
            final_response=result.text, finished_at=common.now(), execution_seconds=time.monotonic() - started,
            generation={"generation_tokens": result.generation_tokens, "prompt_tokens": result.prompt_tokens,
                        "reached_token_cap": result.generation_tokens >= args.max_tokens, "generation_tps": result.generation_tps,
                        "mlx_peak_memory_bytes": mx.get_peak_memory()})
        common.write(args.proof, proof)
        print(json.dumps({"proof": str(args.proof), "status": "success", "response": result.text}, ensure_ascii=False))
    except Exception as error:
        proof.update(status="failed", finished_at=common.now(), error={"type": type(error).__name__, "message": str(error)})
        common.write(args.proof, proof)
        print(json.dumps({"proof": str(args.proof), "status": "failed", "error": proof["error"]}), file=sys.stderr)
        raise SystemExit(1)


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "batch":
        common.batch(sys.argv[2:], runner=main)
    else:
        main()
