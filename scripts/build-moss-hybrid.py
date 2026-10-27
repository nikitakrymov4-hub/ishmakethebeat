#!/usr/bin/env python3
"""Build one auditable local MOSS 4-bit LM / 8-bit adapter experiment.

Copies verified safetensor payload bytes; never imports MLX, loads a model,
dequantizes/requantizes a tensor, accesses the network, or changes either source.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path
import shutil
import struct
import tempfile
from datetime import datetime, timezone

ROOT = Path(__file__).resolve().parents[1]
MODEL_ID = "local/ish-moss-thinking4-adapters8-experiment-v1"
DIRECTORY = "MOSS-Music-8B-Thinking-4bit-adapters8-local-v1"
SOURCES = {
    "4bit": {"id": "mlx-community/MOSS-Music-8B-Thinking-4bit",
        "revision": "b14123a419b6254b92d9e55b8a5b6f7285e05c70",
        "directory": "MOSS-Music-8B-Thinking-4bit",
        "sha256": "17560d5e601103ec84981673692f69602ed78ffeea07b522d731649cc9711a44"},
    "8bit": {"id": "mlx-community/MOSS-Music-8B-Thinking-8bit",
        "revision": "7b2c41e689a46bbd7b395619ce9fd96041ff984c",
        "directory": "MOSS-Music-8B-Thinking-8bit",
        "sha256": "6da829b420899501d03c72658eac3850875b98e299ac712e42588c6eae126cda"},
}
ASSETS = ["generation_config.json", "preprocessor_config.json", "added_tokens.json",
          "special_tokens_map.json", "tokenizer_config.json", "vocab.json", "merges.txt"]
PREFIXES = ("audio_adapter.", "deepstack_audio_merger_list.")
CHUNK = 8 * 1024 * 1024


def digest(path):
    h = hashlib.sha256()
    with path.open("rb") as f:
        for data in iter(lambda: f.read(CHUNK), b""):
            h.update(data)
    return h.hexdigest()


def save(path, data):
    path.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n")


def header(path):
    with path.open("rb") as f:
        size = struct.unpack("<Q", f.read(8))[0]
        if not 0 < size < 16 * 1024 * 1024:
            raise ValueError("Unexpected safetensors header size")
        entries = json.loads(f.read(size))
    entries.pop("__metadata__", None)
    cursor = 0
    for key, entry in sorted(entries.items(), key=lambda kv: kv[1]["data_offsets"][0]):
        start, end = entry["data_offsets"]
        width = {"BF16": 2, "U32": 4, "F32": 4}.get(entry["dtype"])
        if width is None or start != cursor or end-start != width*math.prod(entry["shape"]):
            raise ValueError(f"Invalid tensor layout: {key}")
        cursor = end
    if 8 + size + cursor != path.stat().st_size:
        raise ValueError("Safetensors payload size mismatch")
    return entries, 8 + size


def copy_tensor(source, offset, length, out=None):
    source.seek(offset)
    h = hashlib.sha256()
    remaining = length
    while remaining:
        data = source.read(min(CHUNK, remaining))
        if not data:
            raise ValueError("Truncated tensor payload")
        h.update(data)
        if out is not None:
            out.write(data)
        remaining -= len(data)
    return h.hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--models-dir", type=Path,
        default=ROOT / "private-assets/audio-research/models")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    destination = args.output or args.models_dir / DIRECTORY
    if destination.exists():
        parser.error("Output exists; preserving it. Choose a fresh output path.")
    paths, headers, bases, configs = {}, {}, {}, {}
    for kind, source in SOURCES.items():
        folder = args.models_dir / source["directory"]
        paths[kind] = folder / "model.safetensors"
        if digest(paths[kind]) != source["sha256"]:
            raise ValueError(f"Source checkpoint SHA256 mismatch: {kind}")
        headers[kind], bases[kind] = header(paths[kind])
        configs[kind] = json.loads((folder / "config.json").read_text())
    if set(headers["4bit"]) != set(headers["8bit"]):
        raise ValueError("Source checkpoints have different tensor names")
    c4, c8 = dict(configs["4bit"]), dict(configs["8bit"])
    c4.pop("quantization"); c8.pop("quantization")
    if c4 != c8:
        raise ValueError("Source architectures differ")
    selected = sorted(k for k in headers["4bit"] if k.startswith(PREFIXES))
    modules = sorted(k.removesuffix(".scales") for k in selected if k.endswith(".scales"))
    if len(selected) != 36 or len(modules) != 12:
        raise ValueError("Unexpected adapter module/tensor count")
    for module in modules:
        if {f"{module}.{suffix}" for suffix in ("weight", "scales", "biases")} - set(selected):
            raise ValueError(f"Incomplete quantized module: {module}")
    config = configs["4bit"]
    overrides = {module: {"bits": 8, "group_size": 64, "mode": "affine"} for module in modules}
    config["quantization"].update(overrides)
    new_header, cursor, tensor_map = {}, 0, {}
    for key in sorted(headers["4bit"]):
        kind = "8bit" if key in selected else "4bit"
        entry = headers[kind][key]
        size = entry["data_offsets"][1] - entry["data_offsets"][0]
        new_header[key] = {"dtype": entry["dtype"], "shape": entry["shape"],
                           "data_offsets": [cursor, cursor + size]}
        tensor_map[key] = {"source": kind, "source_offsets": entry["data_offsets"],
                           "bytes": size}
        cursor += size
    new_header["__metadata__"] = {"format": "mlx", "derived_model_id": MODEL_ID,
        "experiment": "4bit Thinking LM with exact 8bit audio and DeepStack adapter tensors"}
    encoded = json.dumps(new_header, separators=(",", ":"), sort_keys=True).encode()
    encoded += b" " * ((-len(encoded)) % 8)
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=destination.name + "-building-", dir=destination.parent) as temporary:
        stage = Path(temporary)
        with paths["4bit"].open("rb") as f4, paths["8bit"].open("rb") as f8:
            handles = {"4bit": f4, "8bit": f8}
            # Shared bf16 encoder/norm tensors must agree before any derived model is accepted.
            shared = []
            for key, entry in headers["4bit"].items():
                module = key.rsplit(".", 1)[0]
                if entry["dtype"] == "BF16" and f"{module}.scales" not in headers["4bit"]:
                    shared.append(key)
            for key in shared:
                hashes = []
                for kind in ("4bit", "8bit"):
                    a, b = headers[kind][key]["data_offsets"]
                    hashes.append(copy_tensor(handles[kind], bases[kind] + a, b-a))
                if hashes[0] != hashes[1]:
                    raise ValueError(f"Source full-precision tensor differs: {key}")
            with (stage / "model.safetensors").open("wb") as out:
                out.write(struct.pack("<Q", len(encoded))); out.write(encoded)
                for key, item in tensor_map.items():
                    kind = item["source"]; start = item["source_offsets"][0]
                    item["sha256"] = copy_tensor(handles[kind], bases[kind] + start, item["bytes"], out)
        # Independently reread the produced file, validating all boundaries and tensor bytes.
        output_header, output_base = header(stage / "model.safetensors")
        with (stage / "model.safetensors").open("rb") as check:
            for key, item in tensor_map.items():
                a, b = output_header[key]["data_offsets"]
                if copy_tensor(check, output_base+a, b-a) != item["sha256"]:
                    raise ValueError(f"Output tensor verification failed: {key}")
        save(stage / "config.json", config)
        for name in ASSETS:
            shutil.copyfile(args.models_dir / SOURCES["4bit"]["directory"] / name, stage / name)
        save(stage / "config-diff.json", {"source": SOURCES["4bit"],
            "added_quantization_module_overrides": overrides,
            "all_other_config_fields_unchanged": True})
        save(stage / "tensor-provenance.json", tensor_map)
        save(stage / "adapter-module-map.json", {"modules": modules, "tensor_names": selected,
            "default_quantization": {"bits": 4, "group_size": 64}, "overrides": overrides})
        (stage / "README.md").write_text(
            "# Local MOSS mixed-precision experiment\n\n"
            "This is an unvalidated local derived checkpoint, not an official OpenMOSS or MLX Community release. "
            "The language model is four-bit Thinking; its audio and three DeepStack adapters use the downloaded "
            "eight-bit Thinking tensors. The audio encoder is unchanged bf16. No tensors were requantized.\n\n"
            "Base model credit: OpenMOSS Team, https://huggingface.co/OpenMOSS-Team/MOSS-Music-8B-Thinking. "
            "Source conversions: mlx-community (see download-provenance.json). Source model cards declare Apache-2.0. "
            "This local research experiment has no accepted musical findings until neutral actual-audio controls pass.\n")
        files = {p.name: {"bytes": p.stat().st_size, "sha256": digest(p)} for p in stage.iterdir() if p.is_file()}
        proof = {"created_utc": datetime.now(timezone.utc).isoformat(), "model_id": MODEL_ID,
            "official_checkpoint": False, "experimental": True, "sources": SOURCES,
            "build_script_sha256": digest(Path(__file__)), "build_method": "stdlib streaming exact safetensor payload copy",
            "shared_full_precision_tensors_verified_identical": len(shared), "adapter_module_count": len(modules),
            "adapter_tensor_count": len(selected), "all_output_tensor_hashes_verified": True,
            "gpu_used": False, "inference_run": False, "semantic_validation": "not_run", "files": files}
        save(stage / "download-provenance.json", proof)
        # Rename only after integrity checks; no source model is modified.
        stage.rename(destination)
    print(json.dumps({"status": "built_not_inferred", "model_id": MODEL_ID,
        "directory": str(destination), "weights": files["model.safetensors"], "adapter_modules": len(modules)}))


if __name__ == "__main__":
    main()
