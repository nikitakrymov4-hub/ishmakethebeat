"""Verify character-revision WAVs and create reversible listening gain matches.

Run with the bundled Python (numpy); requires ffmpeg and ffprobe on PATH.
No EQ, compression, limiting, time changes or source overwrites are performed.
Use --check-ready to list missing render outputs without decoding any audio.
"""
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import hashlib
import json
import math
from pathlib import Path
import re
import subprocess
import sys

import numpy as np

ROOT=Path(__file__).resolve().parents[1]
BASE=ROOT/"deliverables/character"
REPORT=BASE/"verification/audio-measurements.json"
GAINS=BASE/"comparison/matching-gains.json"
RATE=44100

# Output names are distinct across groups even where one source participates
# twice: a stage comparison and a reverse comparison have different targets.
GROUPS=[
    ("accepted-versus-ensemble",[("baseline/full.wav","comparison/accepted-matched.wav"),("comparison/full.wav","comparison/ensemble-matched.wav")]),
    ("ensemble-stages",[(f"comparison/{n}.wav",f"comparison/{n}-matched.wav") for n in ["ensemble-only","ensemble-drums","full"]]),
    ("reverse-pickup",[("comparison/full-without-reverse.wav","comparison/full-without-reverse-matched.wav"),("comparison/full.wav","comparison/full-reverse-matched.wav")]),
    ("principal-lead",[(f"comparison/{n}.wav",f"comparison/{n}-matched.wav") for n in ["lead-dry","lead-treated"]]),
    ("hat-treatments",[(f"comparison/{n}.wav",f"comparison/{n}-matched.wav") for n in ["hat-dry","hat-echo-motion","hat-grain-phase"]]),
    ("palette-shortlist",[(f"comparison/palette-{n}.wav",f"comparison/palette-{n}-matched.wav") for n in ["north-round","north-pitched","stash-pocket"]]),
    ("direct-loop-stages",[(f"loop/{n}.wav",f"loop/{n}-matched.wav") for n in ["loop-only","loop-drums","full-excerpt"]]),
]
DIFFERENCES=[
    ("reverse-pickup","comparison/full-without-reverse.wav","comparison/full.wav"),
    ("lead-processing","comparison/lead-dry.wav","comparison/lead-treated.wav"),
    ("hat-echo-motion","comparison/hat-dry.wav","comparison/hat-echo-motion.wav"),
    ("hat-grain-phase","comparison/hat-dry.wav","comparison/hat-grain-phase.wav"),
    ("hat-treatment-contrast","comparison/hat-echo-motion.wav","comparison/hat-grain-phase.wav"),
]


def dump(path,obj):
    path.parent.mkdir(parents=True,exist_ok=True)
    path.write_text(json.dumps(obj,indent=2,allow_nan=False))


def db(value):
    return None if value<=0 else float(20*math.log10(value))


def rel(path):
    return str(path.relative_to(ROOT))


def run(args):
    return subprocess.check_output(args)


def probe(path):
    return json.loads(run(["ffprobe","-v","error","-show_entries","format=duration:stream=codec_name,sample_rate,channels,bits_per_raw_sample,bits_per_sample,duration_ts,time_base","-of","json",str(path)]))


def decode(path):
    return np.frombuffer(run(["ffmpeg","-v","error","-i",str(path),"-f","f32le","-"]),dtype="<f4")


def loudness(path):
    p=subprocess.run(["ffmpeg","-hide_banner","-nostats","-i",str(path),"-af","ebur128=peak=true:framelog=verbose","-f","null","-"],stdout=subprocess.DEVNULL,stderr=subprocess.PIPE,text=True,check=True)
    number=r"(-?(?:\d+(?:\.\d+)?|inf))"
    integrated=re.findall(r"I:\s*"+number+r"\s+LUFS",p.stderr)
    peaks=re.findall(r"Peak:\s*"+number+r"\s+dBFS",p.stderr)
    if not integrated or not peaks:
        raise AssertionError(f"Could not parse FFmpeg EBU summary for {path}")
    i,t=float(integrated[-1]),float(peaks[-1])
    return (i if math.isfinite(i) else None,t if math.isfinite(t) else None)


def project(folder):
    path=BASE/folder/"project.ish.json"
    return json.loads(path.read_text()) if path.exists() else None


def expected():
    needed={source for _,entries in GROUPS for source,_ in entries}
    needed.update([f"baseline/{n}.wav" for n in ["full","melody","bass","drums"]])
    needed.update([f"generated/{n}.wav" for n in ["WOVEN-127","VELVET-304","COPPER-892","supplied-midi"]])
    for folder in ["original","loop"]:
        needed.update([f"{folder}/project.ish.json",f"{folder}/full.wav",f"{folder}/headroom.wav"])
        p=project(folder)
        if p:
            roles={t["id"] for t in p["candidates"][p["selected"]]["tracks"]}
            roles.update(c["role"] for c in p.get("clips",[]))
            roles.add("fx")
            if p.get("tagEnabled"):
                roles.add("tag")
            needed.update(f"{folder}/stem-{role}.wav" for role in roles)
    return sorted(needed)


def intentional_silence(path):
    if not path.name.startswith("stem-"):
        return False
    p=project(path.parent.name)
    if not p:
        return False
    role=path.stem.removeprefix("stem-")
    tracks=p["candidates"][p["selected"]]["tracks"]
    track=next((t for t in tracks if t["id"]==role),None)
    if track:
        return not track.get("notes") or bool(track.get("mute"))
    if role=="tag":
        return not p.get("tagEnabled")
    if role in ["loop","resample"]:
        return not any(c["role"]==role and c.get("gain",1)>0 for c in p.get("clips",[]))
    return False


def measure(path):
    meta=probe(path)
    stream=meta["streams"][0]
    codec=stream["codec_name"]
    rate=int(stream["sample_rate"])
    channels=int(stream["channels"])
    bits=int(stream.get("bits_per_raw_sample") or stream.get("bits_per_sample") or 0)
    assert codec=="pcm_s24le",f"{rel(path)} codec {codec}"
    assert (rate,channels,bits)==(44100,2,24),f"{rel(path)} expected 44.1kHz stereo 24-bit"
    x=decode(path)
    assert len(x)%channels==0,f"{rel(path)} partial frame"
    frames=len(x)//channels
    time_base=stream.get("time_base","1/44100").split("/")
    if "duration_ts" in stream:
        probe_frames=round(int(stream["duration_ts"])*int(time_base[0])/int(time_base[1])*rate)
        assert frames==probe_frames,f"{rel(path)} decoded/probed frame mismatch"
    finite=int(np.count_nonzero(~np.isfinite(x)))
    peak=float(np.max(np.abs(x)))
    rms=float(np.sqrt(np.sum(x*x,dtype=np.float64)/max(1,len(x))))
    clipped=int(np.count_nonzero(np.abs(x)>=1-1/2**23))
    near=int(np.count_nonzero(np.abs(x)>=.99999))
    assert finite==0,f"{rel(path)} has non-finite samples"
    assert clipped==0,f"{rel(path)} has {clipped} full-scale samples"
    allowed=intentional_silence(path)
    assert rms>1e-7 or allowed,f"{rel(path)} unexpectedly silent"
    integrated,true_peak=loudness(path)
    tails={}
    for duration in [.01,.05,.25,1.0]:
        tail=x[-min(len(x),round(rate*channels*duration)):]
        tail_rms=float(np.sqrt(np.sum(tail*tail,dtype=np.float64)/max(1,len(tail))))
        tails[f"last{round(duration*1000)}msRms"]=tail_rms
        tails[f"last{round(duration*1000)}msRmsDb"]=db(tail_rms)
    row={"file":rel(path),"sha256":hashlib.file_digest(path.open("rb"),"sha256").hexdigest(),"bytes":path.stat().st_size,"codec":codec,"sampleRate":rate,"channels":channels,"bits":bits,"frames":frames,"duration":frames/rate,"lufs":integrated,"truePeakDb":true_peak,"samplePeak":peak,"samplePeakDb":db(peak),"rms":rms,"rmsDb":db(rms),"nonfiniteSamples":finite,"fullScaleSamples":clipped,"nearFullScaleSamples":near,"intentionalEmptyStem":allowed,"silent":rms<=1e-7,"firstFrame":x[:channels].astype(float).tolist(),"lastFrame":x[-channels:].astype(float).tolist(),"tail":tails}
    print(f"{path.relative_to(BASE)}: {frames/rate:.3f}s | {integrated} LUFS | {true_peak} dBTP"+(" | intentional empty stem" if row["silent"] else ""),flush=True)
    return row


def difference(label,a,b):
    first,second=decode(BASE/a),decode(BASE/b)
    assert first.shape==second.shape,f"{label}: frame counts differ"
    raw=second-first
    a_energy=float(np.sum(first*first,dtype=np.float64))
    scalar=float(np.sum(first*second,dtype=np.float64)/max(a_energy,1e-20))
    residual=second-first*scalar
    raw_rms=float(np.sqrt(np.mean(raw.astype(float)**2)))
    residual_rms=float(np.sqrt(np.mean(residual.astype(float)**2)))
    second_rms=float(np.sqrt(np.mean(second.astype(float)**2)))
    assert residual_rms>max(1e-8,second_rms*1e-5),f"{label}: sources are identical apart from linear gain"
    return {"id":label,"first":a,"second":b,"changedSamples":int(np.count_nonzero(raw)),"rawDifferenceRms":raw_rms,"rawDifferenceRmsDb":db(raw_rms),"bestFitLinearScalar":scalar,"residualAfterLinearGainRms":residual_rms,"residualAfterLinearGainDb":db(residual_rms),"differentBeyondLinearGain":True}


def full_checks(rows):
    byfile={r["file"]:r for r in rows}
    checks={"allMeasuredWavs24Bit44100Stereo":True,"allFinite":True,"noFullScaleSamples":True,"completeBeats":{},"alignedStems":{}}
    for folder in ["original","loop"]:
        p=project(folder)
        full=byfile[rel(BASE/folder/"full.wav")]
        assert 90<=full["duration"]<=150,f"{folder} full beat outside90–150seconds"
        bars=sum(s["bars"] for s in p["sections"])
        score_seconds=bars*4*60/p["settings"]["bpm"]
        expected_frames=math.ceil((score_seconds+4)*RATE)
        assert full["frames"]==expected_frames,f"{folder} four-second tail/grid frame count mismatch"
        stems=[r for r in rows if Path(r["file"]).parent.name==folder and Path(r["file"]).name.startswith("stem-")]
        assert stems and all(r["frames"]==full["frames"] for r in stems),f"{folder} stem frame mismatch"
        headroom=byfile[rel(BASE/folder/"headroom.wav")]
        assert headroom["frames"]==full["frames"],f"{folder} headroom frame mismatch"
        checks["completeBeats"][folder]={"bars":bars,"bpm":p["settings"]["bpm"],"scoreSeconds":score_seconds,"tailSeconds":4,"frames":full["frames"],"duration":full["duration"],"within90To150Seconds":True}
        checks["alignedStems"][folder]={"count":len(stems),"frames":full["frames"],"allStartAtTickZeroAndSameLength":True,"intentionalEmpty":[Path(r["file"]).name for r in stems if r["silent"]]}
    return checks


def matches(rows):
    byfile={r["file"]:r for r in rows}
    groups=[]
    for name,entries in GROUPS:
        sources=[byfile[rel(BASE/source)] for source,_ in entries]
        assert all(r["lufs"] is not None and not r["silent"] for r in sources),f"{name} contains silent/unmeasurable input"
        target=-23.0
        # Isolated parts receive useful listening gain. Each source's measured
        # true peak caps the shared target, so the same linear operation can
        # safely boost a quiet part without any limiter, EQ or dynamics.
        for r in sources:
            if r["truePeakDb"] is not None:
                target=min(target,r["lufs"]-1.2-r["truePeakDb"])
        group={"id":name,"targetLUFS":target,"headroomCeilingDbTP":-1.2,"method":"Linear gain only; -23 LUFS target, lowered jointly if any source would exceed -1.2dBTP. Reversible boosts/attenuation, with no EQ, dynamics or source overwrite.","entries":[]}
        for (source,output),original in zip(entries,sources):
            gain_db=target-original["lufs"]
            gain=10**(gain_db/20)
            assert gain>0 and math.isfinite(gain)
            destination=BASE/output
            temp=destination.with_name(destination.stem+".tmp.wav")
            subprocess.run(["ffmpeg","-v","error","-y","-i",str(BASE/source),"-map_metadata","-1","-af",f"volume={gain:.15g}","-c:a","pcm_s24le","-ar","44100","-ac","2",str(temp)],check=True)
            temp.replace(destination)
            matched=measure(destination)
            assert matched["frames"]==original["frames"],f"{output} changed length"
            assert abs(matched["lufs"]-target)<=.25,f"{output} loudness mismatch"
            assert matched["truePeakDb"] is None or matched["truePeakDb"]<=-1.0,f"{output} true-peak headroom mismatch"
            rows.append(matched)
            group["entries"].append({"source":source,"sourceSHA256":original["sha256"],"output":output,"outputSHA256":matched["sha256"],"originalLUFS":original["lufs"],"matchedLUFS":matched["lufs"],"gainDb":gain_db,"linearGain":gain,"inverseLinearGain":1/gain,"matchedTruePeakDbTP":matched["truePeakDb"],"framesUnchanged":True})
        groups.append(group)
    return {"version":1,"rawSourcesRetained":True,"quantization":"Listening copies are24-bit PCM; inverse gain is reversible apart from final PCM quantization.","groups":groups}


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check-ready",action="store_true")
    parser.add_argument("--workers",type=int,default=3)
    parser.add_argument("--measure-only",action="store_true",help="Measure/check raw sources without writing matched copies")
    args=parser.parse_args()
    missing=[name for name in expected() if not (BASE/name).is_file()]
    if missing:
        print("Waiting for render files:\n"+"\n".join(missing))
        return 2
    if args.check_ready:
        print("All expected source renders and project metadata are present. No audio decoded.")
        return 0
    files=sorted(p for p in BASE.rglob("*.wav") if not p.stem.endswith("-matched") and not p.name.endswith(".tmp.wav"))
    with ThreadPoolExecutor(max_workers=max(1,min(6,args.workers))) as pool:
        rows=list(pool.map(measure,files))
    checks=full_checks(rows)
    differences=[difference(*item) for item in DIFFERENCES]
    gain_report=None if args.measure_only else matches(rows)
    if gain_report:
        dump(GAINS,gain_report)
    rows.sort(key=lambda r:r["file"])
    dump(REPORT,{"version":1,"createdUTC":datetime.now(timezone.utc).isoformat(),"runtime":{"python":sys.executable,"numpy":np.__version__,"ffmpeg":run(["ffmpeg","-version"]).decode().splitlines()[0]},"scope":"All raw character-revision WAVs, retained accepted export, and the matched copies created by this run. Signal checks do not establish musical quality or subjective audition.","files":rows,"checks":checks,"differences":differences,"matchingGains":rel(GAINS) if gain_report else None})
    print(f"Verified {len(rows)} WAVs; two complete beats and aligned stem groups. Report: {rel(REPORT)}")
    if gain_report:
        print(f"Wrote {len(gain_report['groups'])} reversible listening groups: {rel(GAINS)}")
    return 0


if __name__=="__main__":
    raise SystemExit(main())
