#!/usr/bin/env python3
"""Prepare actual isolated audio controls. This script never invokes a model."""
from pathlib import Path
from datetime import datetime, timezone
import hashlib
import json
import os
import random
import subprocess

os.environ['OPENBLAS_NUM_THREADS'] = '1'
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
HERE = ROOT / 'private-assets/audio-research/input-challenge-v1'
DELIVERY = ROOT / 'deliverables/benchmark-delivery/night-wire-v3-production-post-yield/night-wire'
RATE, START, END = 44100, 15 * 44100, 35 * 44100
FFMPEG = '/opt/homebrew/bin/ffmpeg'


def sha(path):
    with Path(path).open('rb') as f:
        return hashlib.file_digest(f, 'sha256').hexdigest()


def decode(path, crop=False):
    args = [FFMPEG, '-v', 'error', '-nostdin', '-threads', '1', '-i', str(path)]
    if crop:
        args += ['-af', f'atrim=start_sample={START}:end_sample={END}']
    raw = subprocess.check_output(args + ['-f', 'f32le', '-c:a', 'pcm_f32le', '-'])
    data = np.frombuffer(raw, dtype='<f4').reshape(-1, 2).copy()
    if not np.isfinite(data).all():
        raise ValueError('Nonfinite PCM')
    return data


def write_json(path, data):
    with path.open('x') as f:
        json.dump(data, f, indent=2)
        f.write('\n')


checkpoint_path = DELIVERY / 'checkpoint.json'
checkpoint = json.loads(checkpoint_path.read_text())
assert checkpoint['status'] == 'complete'
outputs = {r['name']: r for r in checkpoint['outputs']}
truth_path = ROOT / 'private-assets/audio-research/strict-controls-v1/control-ground-truth.private.json'
synthetic_truth = json.loads(truth_path.read_text())
synthetic = Path(synthetic_truth['files']['24bit']['path'])
assert sha(synthetic) == synthetic_truth['files']['24bit']['sha256']
specs = [
    {'kind': 'v3_drum_dry_sum', 'stems': ['kick', 'clap', 'hat', 'open', 'perc']},
    {'kind': 'v3_bass_dry', 'stems': ['bass']},
    {'kind': 'v3_source_loop_dry', 'stems': ['loop']},
    {'kind': 'existing_synthetic_nonmusic_and_silence', 'stems': []},
]
random.Random(2026101602).shuffle(specs)
labels = ['K4', 'R8', 'V2', 'Z6']
prompt = ('Describe only what is actually audible in this one attached recording. '
          'Describe distinct sound layers and changes only when clearly present. '
          'Give approximate time ranges for any sound entrances, endings, quiet or silent intervals. '
          'Do not assume this is a song or that sound continues throughout. '
          'Do not guess artist, genre, exact notes, tempo or presets. '
          'If you hear speech, distinguish clear words from uncertain voice-like timbre; do not invent words. '
          'State uncertainty and avoid filling missing layers from expectations. '
          'Use only this audio, not earlier examples. Under 180 words.\n')
prompt_path = HERE / 'neutral-prompt.txt'
with prompt_path.open('x') as f:
    f.write(prompt)
records, truth = [], []
for label, spec in zip(labels, specs):
    target = HERE / f'{label}.wav'
    components = []
    if spec['stems']:
        signal = np.zeros((END - START, 2), dtype=np.float64)
        for role in spec['stems']:
            path = DELIVERY / f'stem-{role}-dry.wav'
            expected = outputs[path.name]
            assert sha(path) == expected['sha256']
            item = decode(path, crop=True)
            assert item.shape == signal.shape
            signal += item
            components.append({'path': str(path), 'sha256': expected['sha256'], 'role': role,
                               'sourceRangeFrames': [START, END], 'sourceRangeSeconds': [15, 35],
                               'sourceTotalFrames': expected['frames'], 'sampleRate': RATE,
                               'channels': 2, 'linearGain': 1})
        assert np.max(abs(signal)) < 1
        subprocess.run([FFMPEG, '-v', 'error', '-nostdin', '-n', '-f', 'f64le', '-ar', str(RATE),
                        '-ac', '2', '-i', '-', '-map_metadata', '-1', '-c:a', 'pcm_s24le',
                        '-fflags', '+bitexact', '-flags:a', '+bitexact', str(target)],
                       input=signal.astype('<f8').tobytes(), check=True)
        actual = decode(target)
        error = float(np.max(abs(actual - signal)))
        assert error <= 2**-23 + 1e-9
        processing = ('Exact native15–35s source slices; unity summing of listed dry stems in float64; '
                      '24bit quantization only. No normalization, filtering, fade, resampling or new audio.')
        reuse = False
    else:
        # The existing20s synthetic fixture already supplies tones, bursts and exact silence.
        # Hard-linking gives it a neutral label without duplicating or regenerating its audio bytes.
        os.link(synthetic, target)
        actual = decode(target)
        assert len(actual) == END - START
        for start, end in synthetic_truth['requiredExactZeroRangesFrames']:
            assert np.count_nonzero(actual[start:end]) == 0
        assert sha(target) == sha(synthetic)
        components = [{'path': str(synthetic), 'sha256': sha(synthetic), 'sourceRangeFrames': [0, len(actual)],
                       'sourceRangeSeconds': [0, 20], 'sampleRate': RATE, 'channels': 2}]
        error = 0.0
        processing = 'Byte-identical hard link to existing20s synthetic fixture; no new signal synthesis or processing.'
        reuse = True
    record = {'id': f'challenge-{label}', 'label': label, 'audioPath': str(target), 'audioSHA256': sha(target),
              'preferredUpload': {'path': str(target), 'sha256': sha(target), 'bytes': target.stat().st_size},
              'frames': len(actual), 'sampleRate': RATE, 'channels': 2, 'durationSeconds': len(actual) / RATE,
              'promptPath': str(prompt_path), 'promptSHA256': sha(prompt_path), 'status': 'prepared_not_submitted'}
    records.append(record)
    truth.append({'label': label, 'kind': spec['kind'], 'components': components,
                  'processing': processing, 'reusedExistingAudio': reuse,
                  'maximumDifferenceFromIntendedPCM': error,
                  'decodedFloat32SHA256': hashlib.sha256(actual.astype('<f4').tobytes()).hexdigest(),
                  'samplePeak': float(np.max(abs(actual))), 'rms': float(np.sqrt(np.mean(actual.astype(np.float64)**2))),
                  'syntheticGroundTruth': synthetic_truth if reuse else None})
    # Rehash all originals after use. No submitted-source file is modified.
    for component in components:
        assert sha(component['path']) == component['sha256']

public = {'schemaVersion': 1, 'createdAt': datetime.now(timezone.utc).isoformat(),
          'status': 'prepared_not_submitted', 'inferenceRun': False, 'records': records,
          'submissionInstructions': 'Submit one audio file and the same neutral prompt in a fresh context. Do not submit private mappings or preparation code. Preserve answers before examining the private key. These are diagnostic controls, not quality comparisons.'}
write_json(ROOT / 'deliverables/audio-research/input-challenge-v1-inputs.json', public)
private = {'schemaVersion': 1, 'privateAnswerKey': True, 'doNotSubmitToModel': True,
           'randomization': {'seed': 2026101602, 'algorithm': 'Python Random.shuffle followed by K4/R8/V2/Z6 labels'},
           'checkpoint': {'path': str(checkpoint_path), 'sha256': sha(checkpoint_path)},
           'scoreWindow': {'path': str(HERE / 'score-window.private.json'), 'sha256': sha(HERE / 'score-window.private.json')},
           'records': truth,
           'reviewRules': ['Check broad source-role recognition without requiring an exact sample or instrument name.',
                           'Synthetic fixture has exact5–10s and15–20s silence and no speech/music bed; hallucinated continuing accompaniment or words fail this control.',
                           'Dry stem isolation excludes other app roles and wet sends; tone names/subjective quality remain uncertain.',
                           'The supplied loop can contain multiple baked-in textures. Its filename/source identity is not proof of each audible constituent.',
                           'Successful requests prove execution only. Consistent responses across these distinct controls are required before trusting fine musical assertions.'],
           'preparedNotHeard': True}
write_json(HERE / 'ground-truth.private.json', private)
print(json.dumps({'manifest': 'deliverables/audio-research/input-challenge-v1-inputs.json',
                  'privateKey': str(HERE / 'ground-truth.private.json'),
                  'files': [{'label': r['label'], 'path': r['audioPath'], 'sha256': r['audioSHA256'], 'duration': r['durationSeconds']} for r in records],
                  'privateMapping': [{'label': r['label'], 'kind': r['kind'], 'peak': r['samplePeak']} for r in truth]}, indent=2))
