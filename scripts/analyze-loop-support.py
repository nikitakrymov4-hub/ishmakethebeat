#!/usr/bin/env python3
"""Sequential CPU-only timing/pitch-class support for supplied loop sources.

No model, musical ranking, source edits, engine changes, or verified beat/key claims.
Extends the existing prepare-sound-character-assets.py peak-chroma/grid approach.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
import math
import os
from pathlib import Path
import re
import subprocess
import sys
import time

# These affect this process only. The active model process and system limits are untouched.
os.environ["OMP_NUM_THREADS"] = "1"
os.environ["OPENBLAS_NUM_THREADS"] = "1"
os.environ["VECLIB_MAXIMUM_THREADS"] = "1"
import numpy as np
import scipy
from scipy.ndimage import uniform_filter1d
from scipy.signal import find_peaks

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "deliverables/audio-research"
RATE = 11025
FFT = "/opt/homebrew/bin/ffmpeg"
NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
MAJOR = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
MINOR = np.array([6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])


def sha(path):
    with Path(path).open("rb") as f:
        return hashlib.file_digest(f, "sha256").hexdigest()


def write(path, value):
    temporary = path.with_suffix(path.suffix + ".preparing")
    temporary.write_text(json.dumps(value, indent=2, ensure_ascii=False, allow_nan=False) + "\n")
    temporary.replace(path)


def decode(record):
    source = record["source"]
    command = [FFT, "-v", "error", "-nostdin", "-threads", "1", "-filter_threads", "1", "-i", source["path"], "-map", "0:a:0"]
    if source["channels"] == 2:
        command += ["-af", "pan=mono|c0=0.5*c0+0.5*c1"]
    elif source["channels"] != 1:
        raise ValueError("Unexpected multichannel source; define an explicit downmix first")
    command += ["-ar", str(RATE), "-ac", "1", "-c:a", "pcm_f32le", "-f", "f32le", "-"]
    raw = subprocess.check_output(command)
    audio = np.frombuffer(raw, dtype="<f4")
    if not np.isfinite(audio).all() or not len(audio):
        raise ValueError("Invalid PCM")
    return audio, {"command": command, "sampleRate": RATE, "channels": 1, "frames": len(audio),
        "durationSeconds": len(audio) / RATE, "float32SHA256": hashlib.sha256(raw).hexdigest(),
        "nativeDurationDifferenceSeconds": len(audio) / RATE - source["durationSeconds"],
        "processing": "Full original source, stereo arithmetic mean where applicable, FFmpeg resampling to11025Hz; no gain normalization."}


def normalized_acf(values):
    x = np.asarray(values, dtype=np.float64)
    if x.ndim == 1: x = x[:, None]
    x = x - x.mean(axis=0)
    size = len(x)
    nfft = 1 << (2 * size - 1).bit_length()
    spectrum = np.fft.rfft(x, n=nfft, axis=0)
    numerator = np.fft.irfft((spectrum * spectrum.conj()).sum(axis=1), n=nfft)[:size]
    energy = np.concatenate([[0.0], np.cumsum((x * x).sum(axis=1))])
    lags = np.arange(size)
    denominator = np.sqrt(np.maximum(1e-24, energy[size - lags] * (energy[size] - energy[lags])))
    return np.clip(numerator / denominator, -1, 1)


def onset_features(audio):
    n, hop = 1024, 128
    window = np.hanning(n)
    bins = np.fft.rfftfreq(n, 1 / RATE)
    mask = (bins >= 60) & (bins <= 5000)
    flux, times, previous = [], [], None
    for start in range(0, len(audio) - n + 1, hop):
        magnitude = np.log1p(np.abs(np.fft.rfft(audio[start:start+n] * window))[mask] * 10)
        flux.append(float(np.maximum(magnitude - previous, 0).mean()) if previous is not None else 0)
        times.append((start + n / 2) / RATE)
        previous = magnitude
    flux = np.array(flux)
    onset = np.maximum(0, flux - uniform_filter1d(flux, 43, mode="nearest") * .75)
    peaks, _ = find_peaks(onset, distance=max(1, round(.05 * RATE / hop)),
        height=max(float(onset.max()) * .06, float(np.median(onset)) + 2 * float(np.median(abs(onset - np.median(onset))))))
    return np.array(times), onset, peaks, hop / RATE


def tempo_candidates(onset, step, limit=6):
    ac = normalized_acf(onset)
    lo, hi = math.ceil(60 / 220 / step), min(len(ac) - 2, math.floor(60 / 50 / step))
    peaks, _ = find_peaks(ac[lo:hi+1], distance=2)
    candidates = []
    for lag in sorted(peaks + lo, key=lambda i: ac[i], reverse=True):
        if ac[lag] < .03: continue
        denominator = ac[lag-1] - 2 * ac[lag] + ac[lag+1]
        fraction = .5 * (ac[lag-1] - ac[lag+1]) / denominator if abs(denominator) > 1e-12 else 0
        period = (lag + np.clip(fraction, -.5, .5)) * step
        bpm = 60 / period
        if any(abs(bpm - c["bpm"]) < 1.5 for c in candidates): continue
        candidates.append({"bpm": round(float(bpm), 3), "onsetCorrelation": round(float(ac[lag]), 5),
            "halfDoubleAlternativesBpm": [round(float(bpm / 2), 3), round(float(bpm * 2), 3)]})
        if len(candidates) == limit: break
    return candidates, ac


def filename_tempo(name):
    for expression, basis in [(r"(?i)(\d{2,3})\s*bpm", "explicit filename BPM token"),
        (r"\((\d{2,3})\)", "parenthesized filename number"), (r"_(\d{2,3})\s*[\[(]", "filename number before description")]:
        found = re.search(expression, name)
        if found: return {"bpm": int(found.group(1)), "basis": basis, "verified": False}
    return None


def grid_check(times, weights, bpm, duration):
    if len(times) > 256:
        best = np.argsort(weights)[-256:]; times, weights = times[best], weights[best]
    quarter = 60 / bpm; sixteenth = quarter / 4
    phases = np.linspace(0, sixteenth, 128, endpoint=False)
    distance = abs((times[:, None] - phases[None, :] + sixteenth / 2) % sixteenth - sixteenth / 2)
    deviations = (distance * weights[:, None]).sum(axis=0) / max(1e-12, weights.sum())
    best = int(np.argmin(deviations)); phase = phases[best]
    # Accent phases under an explicit4/4 hypothesis. These cannot identify the musical first beat.
    bar = quarter * 4; accents = []
    for index in range(16):
        candidate = float((phase + index * sixteenth) % bar)
        d = abs((times - candidate + bar / 2) % bar - bar / 2)
        support = float((weights * np.exp(-.5 * (d / max(.025, sixteenth * .22)) ** 2)).sum() / max(1e-12, weights.sum()))
        accents.append({"phaseSecondsFromSourceZero": round(candidate, 5), "periodSecondsAssuming4_4": round(bar, 5), "relativeOnsetSupport": round(support, 5)})
    accents.sort(key=lambda x: x["relativeOnsetSupport"], reverse=True)
    return {"bpmHypothesis": round(bpm, 3), "sixteenthProxyPhaseSeconds": round(float(phase), 6),
        "weightedGridDeviationSeconds": round(float(deviations[best]), 6),
        "deviationAsFractionOfSixteenth": round(float(deviations[best] / sixteenth), 5),
        "accentPhaseCandidates": accents[:4], "wholeFileBarsAssuming4_4": round(duration / bar, 5),
        "wholeFileMinusNearestBarSeconds": round(duration - round(duration / bar) * bar, 5),
        "downbeatVerified": False, "meterAssumption": "4/4 only for numerical candidate display; not inferred"}


def chroma_features(audio):
    # Same8192/1024 peak-chroma settings and profiles as prepare-sound-character-assets.py.
    n, hop = 8192, 1024
    frequencies = np.fft.rfftfreq(n, 1 / RATE)
    bins = np.flatnonzero((frequencies >= 75) & (frequencies < 2200))
    midi = 69 + 12 * np.log2(frequencies[bins] / 440)
    near = abs(midi - np.rint(midi)) < .42
    pitch_classes = np.rint(midi).astype(int) % 12
    window = np.hanning(n)
    times, chroma, bands, rms = [], [], [], []
    band_masks = [(frequencies >= a) & (frequencies < b) for a, b in [(30,100),(100,250),(250,600),(600,1500),(1500,3000),(3000,5000)]]
    for start in range(0, len(audio)-n+1, hop):
        part = audio[start:start+n]
        spectrum = np.abs(np.fft.rfft(part * window))
        mag = spectrum[bins]
        peaks = (mag > spectrum[bins-1]) & (mag >= spectrum[bins+1]) & (mag > max(1e-10, float(mag.max()) * .025))
        values = np.bincount(pitch_classes, weights=mag ** .75 * peaks * near, minlength=12)
        chroma.append(values / max(1e-12, values.sum()))
        band = np.array([np.sum(spectrum[mask] ** 2) for mask in band_masks])
        bands.append(band / max(1e-12, band.sum()))
        rms.append(float(np.sqrt(np.mean(part.astype(np.float64) ** 2))))
        times.append((start + n / 2) / RATE)
    return np.array(times), np.array(chroma), np.array(bands), np.array(rms), hop / RATE


def key_candidates(chroma, count=4):
    average = chroma.mean(axis=0) if chroma.ndim == 2 else chroma
    if not np.any(average) or np.std(average) < 1e-10: return []
    ranked = []
    for tonic in range(12):
        for mode, profile in [("major", MAJOR), ("minor", MINOR)]:
            ranked.append({"tonic": NAMES[tonic], "mode": mode,
                "profileCorrelation": round(float(np.corrcoef(average, np.roll(profile, tonic))[0,1]), 5)})
    return sorted(ranked, key=lambda r: r["profileCorrelation"], reverse=True)[:count]


def repeat_and_changes(times, chroma, bands, rms, onset_times, onset):
    step = 1024 / RATE
    activity_floor = max(1e-7, float(rms.max()) * .01)
    active = rms >= activity_floor
    level = 20 * np.log10(np.maximum(rms, activity_floor))
    features = np.column_stack([chroma, bands, level / 40, np.interp(times, onset_times, onset)])
    active_features = features[active] if active.any() else features
    deviations = active_features.std(axis=0); deviations[deviations < 1e-5] = 1
    z = (features - active_features.mean(axis=0)) / deviations
    z[~active] = 0
    ac = normalized_acf(z)
    lo, hi = math.ceil(2 / step), min(len(times) // 2, math.floor(60 / step))
    indices, _ = find_peaks(ac[lo:hi+1], distance=max(1, round(.4 / step)))
    repetitions = []
    for lag in sorted(indices + lo, key=lambda i: ac[i], reverse=True):
        if ac[lag] < .2: continue
        period = lag * step
        if any(abs(period - c["periodSeconds"]) < max(.5, period * .05) for c in repetitions): continue
        best_score, best_start = -1, 0
        for start in range(0, len(z) - 2 * lag + 1, max(1, round(.5 / step))):
            if min(active[start:start+lag].mean(), active[start+lag:start+2*lag].mean()) < .8:
                continue
            a, b = z[start:start+lag], z[start+lag:start+2*lag]
            a = a-a.mean(axis=0); b = b-b.mean(axis=0)
            similarity = float(np.sum(a*b) / max(1e-12, np.linalg.norm(a)*np.linalg.norm(b)))
            if similarity > best_score: best_score, best_start = similarity, start
        if best_score < .2:
            continue
        region_start = max(0, float(times[best_start] - 8192 / RATE / 2))
        repetitions.append({"periodSeconds": round(period, 5), "featureAutocorrelation": round(float(ac[lag]), 5),
            "candidateAdjacentRegionsSeconds": [[round(region_start,5),round(region_start+period,5)],[round(region_start+period,5),round(region_start+2*period,5)]],
            "bestAdjacentFeatureSimilarity": round(best_score, 5), "regionVerified": False})
        if len(repetitions) == 3: break
    width = max(2, round(1.5 / step)); changes = []
    spectral_features = np.column_stack([chroma, bands])
    for i in range(width, len(times)-width):
        if max(active[i-width:i].mean(), active[i:i+width].mean()) < .2:
            continue
        a = np.mean(spectral_features[i-width:i], axis=0)
        b = np.mean(spectral_features[i:i+width], axis=0)
        spectral_distance = 1 - float(a@b / max(1e-12, np.linalg.norm(a)*np.linalg.norm(b)))
        db_change = float(level[i:i+width].mean() - level[i-width:i].mean())
        novelty = .7 * spectral_distance + .3 * min(1, abs(db_change)/12)
        changes.append((float(times[i]), novelty, db_change, spectral_distance))
    selected = []
    if changes:
        values = np.array([r[1] for r in changes]); threshold = max(.12, float(np.percentile(values, 90)), float(np.median(values) + 2.5*np.median(abs(values-np.median(values)))))
        for row in sorted(changes, key=lambda r:r[1], reverse=True):
            if row[1] < threshold: break
            if all(abs(row[0]-r["timeSeconds"]) >= 4 for r in selected):
                selected.append({"timeSeconds": round(row[0],3), "noveltyProxy": round(row[1],5), "levelChangeDb": round(row[2],3), "spectralDistance": round(row[3],5)})
            if len(selected) == 6: break
    return repetitions, sorted(selected, key=lambda r:r["timeSeconds"])


def level_support(audio):
    size = round(.05 * RATE)
    count = len(audio) // size
    rms = np.sqrt(np.mean(audio[:count*size].reshape(count,size).astype(np.float64)**2, axis=1))
    db = 20*np.log10(np.maximum(rms, 1e-12))
    threshold = max(-60., float(db.max())-40)
    active = np.flatnonzero(db >= threshold)
    first = active[0]*size/RATE if len(active) else None
    end = min(len(audio)/RATE, (active[-1]+1)*size/RATE) if len(active) else None
    return {"windowSeconds": size/RATE, "thresholdDbFS": round(threshold,3),
        "firstActiveWindowSeconds": first, "lastActiveWindowEndSeconds": end,
        "leadingQuietSeconds": first, "trailingQuietSeconds": len(audio)/RATE-end if end is not None else len(audio)/RATE,
        "lastHalfSecondRmsDbFS": round(float(20*np.log10(max(1e-12,np.sqrt(np.mean(audio[-round(RATE*.5):].astype(float)**2))))),3),
        "interpretation": "Thresholded mono activity only; quiet reverb, stereo cancellation or musical rests can resemble silence/tails."}


def native_tail_check(source, levels):
    """Check a proposed quiet interval independently before the mono analysis downmix."""
    if levels["trailingQuietSeconds"] <= .25 or levels["lastActiveWindowEndSeconds"] is None:
        return None
    start_frame = round(levels["lastActiveWindowEndSeconds"] * source["sampleRate"])
    command = [FFT, "-v", "error", "-nostdin", "-threads", "1", "-filter_threads", "1", "-i", source["path"],
        "-map", "0:a:0", "-af", f"atrim=start_sample={start_frame}", "-c:a", "pcm_f32le", "-f", "f32le", "-"]
    raw = subprocess.check_output(command)
    channels = source["channels"]
    samples = np.frombuffer(raw, dtype="<f4").reshape(-1, channels)
    rms = np.sqrt(np.mean(samples.astype(np.float64)**2, axis=0))
    peak = np.max(abs(samples), axis=0)
    return {"nativeSampleRate": source["sampleRate"], "channels": channels, "startFrame": start_frame,
        "frames": len(samples), "rangeSeconds": [start_frame / source["sampleRate"], (start_frame + len(samples)) / source["sampleRate"]],
        "rmsDbFSPerChannel": [round(float(20*np.log10(max(1e-12,x))),3) for x in rms],
        "samplePeakDbFSPerChannel": [round(float(20*np.log10(max(1e-12,x))),3) for x in peak],
        "exactlyZeroPerChannel": [bool(x == 0) for x in peak], "reportedDbFloor": -240,
        "command": command, "float32SHA256": hashlib.sha256(raw).hexdigest(),
        "interpretation": "Original channels/sample rate, no downmix or gain change; interval starts at the 50ms mono activity estimate. Level evidence only, not permission to discard tails."}


def analyze(record):
    started = time.perf_counter();source = record["source"];path = Path(source["path"])
    if sha(path) != source["sha256"]: raise ValueError(f"Source hash mismatch: {path}")
    audio, preprocessing = decode(record)
    onset_times, onset, peaks, onset_step = onset_features(audio)
    tempos, ac = tempo_candidates(onset, onset_step)
    hint = filename_tempo(path.name)
    # Fold rhythmic equivalents into100–200 solely to avoid reporting only half/double duplicates.
    grids = []
    for candidate in tempos:
        bpm = candidate["bpm"]
        while bpm < 100: bpm *= 2
        while bpm > 200: bpm /= 2
        if all(abs(bpm-x["bpm"]) > 2 for x in grids): grids.append({"bpm":bpm,"basis":"onset autocorrelation family"})
        if len(grids) == 3: break
    if hint:
        grids.append({"bpm":hint["bpm"],"basis":"filename hypothesis only, tested separately even when close to an independent candidate"})
    checks = [{**grid_check(onset_times[peaks], np.sqrt(onset[peaks]), x["bpm"], source["durationSeconds"]),"basis":x["basis"]} for x in grids] if len(peaks) else []
    times, chroma, bands, rms, step = chroma_features(audio)
    active = rms >= max(1e-7,float(rms.max())*.01)
    average = chroma[active].mean(axis=0) if active.any() else chroma.mean(axis=0)
    keys = key_candidates(average)
    tonal_segments = []
    for start in np.arange(0,source["durationSeconds"],8):
        region = (times>=start)&(times<start+8)&active
        if region.sum() < 3: continue
        summary = chroma[region].mean(axis=0)
        tonal_segments.append({"rangeSeconds":[float(start),min(float(start+8),source["durationSeconds"])],
            "topPitchClasses":[NAMES[i] for i in np.argsort(summary)[::-1][:4]],"keyCandidates":key_candidates(summary,2)})
    repeats, changes = repeat_and_changes(times,chroma,bands,rms,onset_times,onset)
    tempo_segments = []
    for start in np.arange(0,source["durationSeconds"],16):
        region=(onset_times>=start)&(onset_times<start+16)
        if region.sum()*onset_step < 8: continue
        candidates,_ = tempo_candidates(onset[region],onset_step,3)
        tempo_segments.append({"rangeSeconds":[float(start),min(float(start+16),source["durationSeconds"])],"candidates":candidates})
    for repeat in repeats:
        repeat["candidateAdjacentSourceFrames"]=[[round(a*source["sampleRate"]),round(b*source["sampleRate"])] for a,b in repeat["candidateAdjacentRegionsSeconds"]]
    levels=level_support(audio)
    levels["nativeChannelTailCheck"] = native_tail_check(source, levels)
    flags=[]
    if not record["completeSource"]: flags.append("Numerical analysis extends beyond the prepared 45-second model screen; later content has not thereby been heard by a model.")
    if source["durationSeconds"] > 60: flags.append("Long source: do not treat the full file as a single short loop.")
    if changes: flags.append("Feature/level changes warrant region inspection; chord changes and effects can mimic section boundaries.")
    if levels["trailingQuietSeconds"] > .25: flags.append("Measured quiet tail; retain source while selecting a region.")
    if keys and len(keys)>1 and keys[0]["profileCorrelation"]-keys[1]["profileCorrelation"] < .1: flags.append("Top key profiles are close; tonic/mode is especially ambiguous.")
    if not tempos or tempos[0]["onsetCorrelation"] < .25: flags.append("Weak rhythmic periodicity; automatic tempo is especially uncertain.")
    source_hash_after = sha(path)
    return {"id":record["id"],"source":source,"sourceCredit":record.get("sourceCredit"),"auditionPreparedRangeSeconds":record["sourceRangeSeconds"],
        "fullOriginalSourceAnalyzed":True,"preprocessing":preprocessing,"filenameTempoHypothesis":hint,
        "onsets":{"detectedCount":len(peaks),"firstCandidateTimesSeconds":[round(float(t),5) for t in onset_times[peaks][:24]],
            "timestampResolutionSeconds":onset_step,"windowSeconds":1024/RATE,"timingCaveat":"Centered spectral-flux proxies; roughly46ms window half-width plus source envelopes, not exact note onsets."},
        "tempo":{"rankedPeriodicityCandidates":tempos,"gridHypothesisChecks":checks,"sixteenSecondWindows":tempo_segments,"tempoVerified":False},
        "harmonic":{"method":"Inherited local-peak chroma/profile method; no fundamental or chord transcription.",
            "averagePitchClassSalience":{NAMES[i]:round(float(x),5) for i,x in enumerate(average)},"rankedKeyCandidates":keys,
            "topTwoProfileMargin":round(keys[0]["profileCorrelation"]-keys[1]["profileCorrelation"],5) if len(keys)>1 else None,
            "eightSecondWindows":tonal_segments,"keyVerified":False,"harmonyVerified":False},
        "regions":{"repetitionCandidates":repeats,"changeCandidates":changes,"multipleSectionsVerified":False,
            "levelAndTailSupport":levels,"regionInterpretation":"Feature similarity and changes identify inspection candidates, not confirmed phrase/section boundaries or seamless loop cuts."},
        "uncertainties":flags,"sourceHashAfter":source_hash_after,"sourceUnchanged":source_hash_after==source["sha256"],"cpuSecondsWall":round(time.perf_counter()-started,3)}


def self_test():
    # Known signal fixtures test units/lag indexing, not musical accuracy on real recordings.
    audio=np.zeros(RATE*20,dtype=np.float32)
    rng=np.random.default_rng(4)
    for i,t in enumerate(np.arange(.2,19.9,.4)):
        at=round(t*RATE);audio[at:at+110]+=rng.standard_normal(110)*np.exp(-np.arange(110)/20)*(1 if i%4==0 else .6)
    _,onset,_,step=onset_features(audio);tempos,_=tempo_candidates(onset,step)
    assert any(min(abs(c['bpm']-150),abs(c['bpm']*2-150),abs(c['bpm']/2-150))<2 for c in tempos),tempos
    t=np.arange(RATE*4)/RATE;tone=sum(np.sin(2*np.pi*hz*t) for hz in [261.6256,329.6276,391.9954]).astype(np.float32)*.15
    _,chroma,_,_,_=chroma_features(tone);top=set(np.argsort(chroma.mean(axis=0))[-3:]);assert top=={0,4,7},top
    return {"known150BpmImpulseFamilyFound":True,"knownC_E_GPeakClassesFound":True,"note":"Unit/lag/spectral-bin sanity checks only; no guarantee of real-loop tempo/key accuracy."}


def report(data):
    lines=["CPU-only loop timing and harmonic support. All20 complete original sources were processed sequentially; this does not constitute model listening or musical selection. Original source hashes are unchanged. No engine state, tuning, notes or assets were modified.",
        "", "The existing calibration score is an authored fixture, not evidence of source tempo. The earlier loop10 path uses a155BPM filename/duration hypothesis and provisional chroma. This pass reuses its peak-chroma/profile method, adds independent onset-period candidates, and keeps filename tempo separate. It does not promote the earlier downbeat or C-minor estimate to verified facts.",
        "", "| Input / source | Full seconds; model-prepared range | Leading tempo candidates / filename hint | Repetition candidates, seconds | Leading key profiles | Region/tail notes |", "|---|---|---|---|---|---|"]
    for row in data["sources"]:
        hints=row["filenameTempoHypothesis"];tempos=row["tempo"]["rankedPeriodicityCandidates"]
        tempo=", ".join(f"{x['bpm']:.1f}" for x in tempos[:3]) or "weak/none"
        keys=" / ".join(f"{x['tonic']} {x['mode']} ({x['profileCorrelation']:.2f})" for x in row["harmonic"]["rankedKeyCandidates"][:2]) or "unresolved"
        repeats=", ".join(f"{x['periodSeconds']:.2f} ({x['featureAutocorrelation']:.2f})" for x in row["regions"]["repetitionCandidates"][:2]) or "none above threshold"
        changes=", ".join(f"{x['timeSeconds']:.1f}" for x in row["regions"]["changeCandidates"][:3]) or "none above threshold"
        tail=row["regions"]["levelAndTailSupport"]["trailingQuietSeconds"]
        a,b=row['auditionPreparedRangeSeconds'];name=Path(row['source']['path']).name.replace('|','/')
        lines.append(f"| {row['id']}: {name} | {row['source']['durationSeconds']:.3f}; {a:.0f}–{b:.3f}s | {tempo}; hint {hints['bpm'] if hints else 'none'} | {repeats} | {keys} | Change proxies {changes}s; quiet tail {tail:.3f}s |")
    long_tails = [r for r in data["sources"] if r["regions"]["levelAndTailSupport"]["trailingQuietSeconds"] > 10]
    close_keys = sum(r["harmonic"]["topTwoProfileMargin"] is not None and r["harmonic"]["topTwoProfileMargin"] < .1 for r in data["sources"])
    lines += ["", "Useful inspection priorities from these measurements:", "",
        "- The three Carti sources contain exact-zero stereo intervals after approximately 25.99s, 25.79s and 12.79s respectively; all files last about 47.76s. The intervals were checked at the original sample rate in both channels. Their full file lengths must not be treated as phrase lengths.",
        "- NEPTUNE spacey has a measured 29.98s trailing quiet region beginning near 143.73s. Original-channel RMS is about −90.5dBFS there; this differs from the exact-zero Carti intervals. Quiet boundaries use a 50ms activity window, so they remain candidate trim positions.",
        "- LOOP2 and LOOP7 are 85.50s and 72.85s, with several strong level/feature changes. Inspect separate source regions before choosing repeat points. Later regions in the five long extra-kit sources extend beyond the prepared 45s model screens.",
        "- LOOP10 independently produces a 77.43 / 154.85 BPM rhythmic family, while its 12.3871s full duration fits 32 quarter notes at the separate filename hypothesis of 155 BPM. This supports trying that grid; onset phase and musical first beat still need audition. Its C-minor and E♭-major profile correlations remain close (0.711 / 0.689).",
        f"- {close_keys} of 20 sources have less than 0.10 correlation separating their two leading key profiles. These measurements cannot choose bass harmony reliably by themselves.",
        "", "Tempo numbers are onset-period hypotheses, with half/double alternatives and local16-second checks in the JSON. Grid phases are modulo an assumed4/4 bar and are not downbeats. Dense subdivisions, syncopation and slow envelope changes can win the autocorrelation instead of the beat.",
        "", "Repetition numbers are lags in pitch-class/band/level/onset features, not automatically usable loop lengths. JSON includes adjacent source regions and native-frame candidates for later audition. Chord repetitions can resemble a repeated arrangement; a high feature match does not guarantee a click-free waveform join. Change proxies may be chord changes, sound-design motion or effects rather than new sections.",
        "", "Pitch-class salience comes from local spectral peaks; overtones, mixed voices, pitch bends and tuning can confuse it. Major/minor profile correlations are not probabilities, chord roots or verified tonic. Eight-second windows expose disagreements; relative keys often remain close. No bass notes should be selected solely from these values.",
        "", "The JSON retains source/decoded hashes, complete-source duration versus prepared-model coverage, method settings, onsets, candidate phases, half/double tempi, regional pitch-class/key candidates, repetition/change proxies and measured quiet tails. Sources longer than their prepared45-second screens need additional model/human audition before their later regions can inform production. No musical winner is chosen."]
    text="\n".join(lines)+"\n"
    for a,b in [("All20","All 20"),("loop10","loop10"),("a155BPM","a 155 BPM"),("local16","local 16"),("assumed4/4","assumed 4/4"),("prepared45","prepared 45")]:text=text.replace(a,b)
    return text


def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument("--self-test",action="store_true");args=parser.parse_args()
    sanity=self_test()
    if args.self_test: print(json.dumps(sanity));return
    manifest_path=OUT/"auditions-v1-inputs.json";manifest=json.loads(manifest_path.read_text());records=[r for r in manifest['records'] if r['kind']=='loop-screen'];assert len(records)==20
    results=[]
    for record in records:
        row=analyze(record);results.append(row)
        print(json.dumps({"id":row['id'],"seconds":row['source']['durationSeconds'],"cpuWallSeconds":row['cpuSecondsWall'],"sourceUnchanged":row['sourceUnchanged']}),flush=True)
    output={"schemaVersion":1,"createdAt":datetime.now(timezone.utc).isoformat(),"status":"numerical_support_only_no_verified_grid_or_key",
        "inputManifest":{"path":str(manifest_path),"sha256":sha(manifest_path)},"script":{"path":str(Path(__file__).resolve()),"sha256":sha(Path(__file__))},
        "runtime":{"python":sys.version.split()[0], "numpy":np.__version__, "scipy":scipy.__version__,
            "ffmpeg":subprocess.check_output([FFT,"-version"],text=True).splitlines()[0],
            "cpuOnly":True,"sequentialSources":True,"threadLimit":1,"gpuModelLoaded":False},"sanityChecks":sanity,
        "methods":{"onset":"11025Hz mono,1024-sample Hann frame,128 hop, positive log spectral flux60–5000Hz; local baseline suppression; >=50ms-separated peaks.",
            "tempo":"Overlap-energy normalized autocorrelation of onset proxy,50–220BPM lag search; local peak interpolation and half/double alternatives. Filename BPM never selects autocorrelation peaks.",
            "grid":"At most256 strongest onset proxies fitted to a sixteenth grid; accent phase ranking under explicit4/4 assumption. Phase is not a downbeat.",
            "chroma":"Same8192 Hann/1024 hop at11025Hz,75–2200Hz local peaks,2.5% amplitude threshold,within0.42 semitone of12TET,amplitude^0.75, Krumhansl-profile correlation as existing asset script.",
            "repetition":"Normalized feature autocorrelation of 12 pitch-class, 6 band-share, level and onset dimensions; inactive frames below -40dB relative RMS are zeroed; lags 2–60s with >=2 repeats; at most 3 peaks and best adjacent candidate regions with >=80% active frames per region.",
            "changes":"Adjacent 1.5s mean chroma/band cosine distance plus level change; at least one side has >=20% active frames; level is floored at relative -40dB; strong sparse candidates separated by 4s. Quiet-tail support uses 50ms RMS below max(-60dBFS,loudest window-40dB)."},
        "limitations":["No audio-language model or human audition in this measurement pass.","Mono/resampled analysis cannot establish stereo or original high-frequency texture.","Onsets, tempo, meter/downbeats, musical phrase boundaries and keys remain unverified.","Full source numerical coverage is distinct from prepared/model-submitted coverage.","No automatic musical ranking or app/asset changes."],"sources":results}
    write(OUT/'loop-numerical-support-v1.json',output)
    (ROOT/'docs/audio-research/loop-numerical-support.md').write_text(report(output))
    print(json.dumps({"sources":len(results),"allSourceHashesUnchanged":all(r['sourceUnchanged'] for r in results),"output":str(OUT/'loop-numerical-support-v1.json')}))


if __name__ == '__main__': main()
