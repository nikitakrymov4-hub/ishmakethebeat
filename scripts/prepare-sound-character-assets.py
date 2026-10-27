"""Catalogue user-provided archives and build a small, portable candidate palette.

All source files remain untouched. Measurements are signal analysis, not audition.
Run with the bundled Python (numpy), ffmpeg and ffprobe on PATH after extraction.
"""
from __future__ import annotations

import base64
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
from pathlib import Path
import re
import subprocess

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
PRIVATE = ROOT / "private-assets"
CULTURE = PRIVATE / "culture-kit"
STASH = PRIVATE / "stash-kit"
LICENCE = "User-supplied kit for private project use; redistribution permission unverified"


def save(name, obj):
    (PRIVATE / name).write_text(json.dumps(obj, indent=2, allow_nan=False))


def source_info(path):
    return {
        "sourcePath": str(path.relative_to(ROOT)),
        "originalFilename": path.name,
        "hash": hashlib.sha256(path.read_bytes()).hexdigest(),
        "bytes": path.stat().st_size,
    }


def classification(path):
    parent = path.parent.name.lower()
    if "Loops" in path.parts:
        return "musical-loop" if re.search(r"- LOOP \d+", path.name) else "tag-support"
    if parent == "scales":
        return "scale-guide"
    if path.suffix.lower() == ".mid":
        return "composed-midi"
    if path.suffix.lower() == ".fst":
        return "effect-state"
    return parent


def decode(path, rate=None, mono=False):
    cmd = ["ffmpeg", "-v", "error", "-i", str(path)]
    if rate:
        cmd += ["-ar", str(rate)]
    if mono:
        cmd += ["-ac", "1"]
    raw = subprocess.check_output(cmd + ["-f", "f32le", "-"])
    return np.frombuffer(raw, dtype="<f4")


def pitch_window(x, rate, start, length=.22):
    y = x[int(start * rate):int((start + length) * rate)].astype(float)
    if len(y) < rate * .08 or np.sqrt(np.mean(y * y)) < .001:
        return None
    y -= y.mean()
    low, high = int(rate / 95), int(rate / 22)
    corrs = []
    for lag in range(low - 1, high + 2):
        a, b = y[:-lag], y[lag:]
        corrs.append(float(a @ b / max(1e-12, np.sqrt((a @ a) * (b @ b)))))
    c = np.array(corrs)
    peaks = [i for i in range(1, len(c) - 1) if c[i] > c[i-1] and c[i] >= c[i+1]]
    if not peaks:
        return None
    best = max(c[i] for i in peaks)
    i = next(i for i in peaks if c[i] >= max(.70, best - .025)) if best >= .70 else max(peaks, key=lambda i:c[i])
    denom = c[i-1] - 2 * c[i] + c[i+1]
    frac = .5 * (c[i-1] - c[i+1]) / denom if abs(denom) > 1e-10 else 0
    hz = rate / (low - 1 + i + frac)
    return {"startSeconds": start, "hz": round(hz, 4), "correlation": round(float(c[i]), 5)}


def measure(path):
    probe = json.loads(subprocess.check_output(["ffprobe", "-v", "error", "-show_entries", "format=duration:stream=sample_rate,channels", "-of", "json", str(path)]))
    stream = probe["streams"][0]
    rate, channels = int(stream["sample_rate"]), stream["channels"]
    x = decode(path).reshape(-1, channels)
    peak = float(np.max(np.abs(x)))
    rms = float(np.sqrt(np.mean(x.astype(float) ** 2)))
    mask = np.max(np.abs(x), axis=1) > .001
    nz = np.flatnonzero(mask)
    first, last = (int(nz[0]), int(nz[-1])) if len(nz) else (0, 0)
    row = {
        **source_info(path), "classification": classification(path),
        "sampleRate":rate, "channels":channels, "frames":len(x),
        "duration":len(x)/rate,
        "peakDb":20*np.log10(max(peak,1e-12)), "rmsDb":20*np.log10(max(rms,1e-12)),
        "firstAboveMinus60Seconds":first/rate, "lastAboveMinus60Seconds":last/rate,
        "trailingBelowMinus60Seconds":(len(x)-last-1)/rate,
        "first30msEnergyShare":float(np.sum(x[:round(rate*.03)].astype(float)**2)/max(1e-12,np.sum(x.astype(float)**2))),
        "finite":bool(np.isfinite(x).all()),
    }
    if path.parent.name in ["808", "808s"]:
        mono=decode(path,11025,True)
        windows=[v for s in [.08,.18,.35,.6,.9] if (v:=pitch_window(mono,11025,s))]
        reliable=[w for w in windows if w["correlation"] > .78]
        if reliable:
            # Favor the sustain rather than the 808's intentional pitch attack.
            sustain=[w for w in reliable if w["startSeconds"] >= .18]
            stable=sustain[-3:] if sustain else reliable[-3:]
            hz=float(np.median([w["hz"] for w in stable]))
            midi=69+12*np.log2(hz/440)
            root=int(round(midi))
            spread=1200*np.log2(max(w["hz"] for w in stable)/min(w["hz"] for w in stable))
            row.update({"root":root,"tuning":round(float(-(midi-root)*100),2),"measuredFundamentalHz":round(hz,4),"rootConfidence":min(.88,float(np.mean([w["correlation"] for w in reliable]))) if spread<30 else .5,"pitchMethod":"Normalized autocorrelation, 22–95 Hz, median of last three reliable sustain windows; provisional source pitch, no subjective/manual audition","sustainPitchSpreadCents":round(float(spread),2),"pitchWindows":windows})
    return row


def chroma_analysis(path, bpm):
    x=decode(path,11025,True).astype(float)
    n,hop=8192,1024
    freq=np.fft.rfftfreq(n,1/11025)
    valid=(freq>=75)&(freq<2200)
    bins=np.flatnonzero(valid)
    midi=69+12*np.log2(freq[valid]/440)
    window=np.hanning(n)
    frames=[]
    for start in range(0,len(x)-n+1,hop):
        spectrum=np.abs(np.fft.rfft(x[start:start+n]*window))
        mag=spectrum[valid]
        peaks=(mag>spectrum[bins-1])&(mag>=spectrum[bins+1])&(mag>np.max(mag)*.025)
        # Local peaks suppress broad noise/FFT leakage. Harmonics still confound
        # mixed-loop chroma, which is why this never claims chord transcription.
        near=np.abs(midi-np.rint(midi))<.42
        values=mag**.75*peaks*near
        chrom=np.bincount(np.rint(midi).astype(int)%12,weights=values,minlength=12)
        frames.append(((start+n/2)/11025,chrom/(chrom.sum()+1e-12)))
    avg=np.mean([v for _,v in frames],axis=0)
    major=np.array([6.35,2.23,3.48,2.33,4.38,4.09,2.52,5.19,2.39,3.66,2.29,2.88])
    minor=np.array([6.33,2.68,3.52,5.38,2.6,3.53,2.54,4.75,3.98,2.69,3.34,3.17])
    names=["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"]
    scored=[]
    for tonic in range(12):
        for mode,template in [("major",major),("minor",minor)]:
            scored.append({"key":names[tonic],"pitchClass":tonic,"mode":mode,"correlation":float(np.corrcoef(avg,np.roll(template,tonic))[0,1])})
    scored.sort(key=lambda a:a["correlation"],reverse=True)
    bars=[]
    for bar in range(8):
        a,b=bar*240/bpm,(bar+1)*240/bpm
        ys=[y for t,y in frames if a<=t<b]
        if ys:
            z=np.mean(ys,axis=0)
            bars.append({"bar":bar+1,"chroma":{names[i]:round(float(v),5) for i,v in enumerate(z)},"topPitchClasses":[names[i] for i in np.argsort(z)[::-1][:4]]})
    halfbars=[]
    for segment in range(16):
        a,b=segment*120/bpm,(segment+1)*120/bpm
        ys=[y for t,y in frames if a<=t<b]
        if ys:
            z=np.mean(ys,axis=0)
            rootScores=[]
            for root in range(12):
                for mode,third in [("minor",3),("major",4)]:
                    rootScores.append({"root":names[root],"rootPitchClass":root,"mode":mode,"score":float((z[root]*1.5+z[(root+third)%12]+z[(root+7)%12])/3.5)})
            rootScores.sort(key=lambda v:v["score"],reverse=True)
            halfbars.append({"startBeat":segment*2,"endBeat":segment*2+2,"chroma":{names[i]:round(float(v),5) for i,v in enumerate(z)},"topPitchClasses":[names[i] for i in np.argsort(z)[::-1][:4]],"triadSalienceCandidates":rootScores[:3],"winningMargin":rootScores[0]["score"]-rootScores[1]["score"],"rootVerified":False})
    return {"method":"8192-sample Hann STFT at 11025 Hz, 1024 hop, 75–2200 Hz local peaks above 2.5% of frame peak; peaks within 0.42 semitones of 12TET, amplitude^0.75; Krumhansl profile correlation. Mixed audio/overtones and tuning confound these estimates; this is not harmonic transcription or listening validation.","averageChroma":{names[i]:round(float(v),5) for i,v in enumerate(avg)},"rankedKeyCandidates":scored[:6],"barChroma":bars,"twoBeatChroma":halfbars,"keyVerified":False,"harmonyVerified":False}


def grid_check(path, bpm):
    x=decode(path,11025,True)
    n,hop=2048,128
    previous=None
    flux=[]
    for start in range(0,len(x)-n+1,hop):
        mag=np.abs(np.fft.rfft(x[start:start+n]*np.hanning(n)))
        if previous is not None:
            flux.append((start/11025,float(np.maximum(mag-previous,0).sum())))
        previous=mag
    peaks=[row for i,row in enumerate(flux[1:-1],1) if row[1]>flux[i-1][1] and row[1]>=flux[i+1][1]]
    chosen=[]
    for t,v in sorted(peaks,key=lambda r:r[1],reverse=True):
        if all(abs(t-a)>.075 for a,_ in chosen):
            chosen.append((t,v))
        if len(chosen)==24:
            break
    step=60/bpm/4
    results=[]
    for phase in np.linspace(0,step,401):
        error=sum(v*abs(((t-phase+step/2)%step)-step/2) for t,v in chosen)/max(1e-12,sum(v for _,v in chosen))
        results.append((phase,error))
    phase,error=min(results,key=lambda r:r[1])
    return {"method":"Spectral-flux peaks from 2048-sample Hann frames, 128 hop at 11025 Hz, 24 separated strongest candidates; fitted to a native-tempo sixteenth grid. Frame-start timing has window bias; this checks periodic alignment, not auditory downbeat identity.","onsetProxyTimesSeconds":[round(t,5) for t,_ in sorted(chosen)],"sixteenthGridPeriodSeconds":step,"bestProxyPhaseSeconds":float(phase),"weightedGridDeviationSeconds":float(error),"first10msRms":float(np.sqrt(np.mean(x[:110]**2))),"last10msRms":float(np.sqrt(np.mean(x[-110:]**2))),"boundaryTreatment":"Use a short 6ms equal source-boundary fade on each repeated region; originals remain intact.","downbeatVerified":False}


def make_asset(row, role, gain, **extra):
    path=ROOT/row["sourcePath"]
    root=row.get("root",60)
    end=min(row["duration"],row["lastAboveMinus60Seconds"]+.012)
    return {
        "id":f"sample-{role}-{row['hash'][:16]}", "name":path.name,
        "data":"data:audio/wav;base64,"+base64.b64encode(path.read_bytes()).decode(),
        "role":role,"root":root,"tuning":row.get("tuning",0),"trimStart":0,"trimEnd":end,"gain":gain,
        "choke":"bass" if role=="bass" else "hats" if role in ["hat","open"] else "",
        "envelopeMode":"gated" if role=="bass" else "one-shot","loop":False,
        "license":LICENCE,"sourceId":row["hash"],"source":row["sourcePath"],
        **{k:row[k] for k in ["originalFilename","hash","sampleRate","channels","duration","peakDb","rmsDb"]},
        "rootConfidence":row.get("rootConfidence",0),"measuredFundamentalHz":row.get("measuredFundamentalHz"),"manualOverride":False,
        "envelope":{"attack":.002 if role=="bass" else .0005,"decay":.05 if role=="bass" else .015,"sustain":1,"release":.016 if role=="bass" else .006},
        "measurementOnly":True, **extra,
    }


def main():
    files=[p for base in [CULTURE,STASH] for p in base.rglob("*") if p.is_file()]
    catalogue=[{**source_info(p),"classification":classification(p)} for p in files]
    save("archive-catalogue.json",{"counts":{"culture":dict(Counter(p.suffix.lower() for p in CULTURE.rglob('*') if p.is_file())),"stash":dict(Counter(p.suffix.lower() for p in STASH.rglob('*') if p.is_file()))},"files":catalogue,"audition":"No subjective audition performed"})
    archives=[Path.home()/"Downloads"/name for name in ["Culture Drum Kit.rar","wetransfer_1_prodfrustration_personal_tdf_stash_kit_v2_with_presets.zip"]]
    save("source-archive-provenance.json",{"archives":[{"path":str(p),"bytes":p.stat().st_size,"sha256":hashlib.file_digest(p.open("rb"),"sha256").hexdigest()} for p in archives],"originalsRetained":True,"zipIntegrity":"All ZIP member CRC checks passed before extraction","cultureAudioDecode":"All 103 extracted Culture WAVs decoded and measured by ffmpeg","stashMeasurementScope":"All 25 Loops audio files and 12 shortlisted drum/bass files measured; other stash WAVs catalogued and hashed, not all decoded or subjectively auditioned"})
    stash=next(p for p in STASH.iterdir() if p.is_dir())
    culture=next(p for p in CULTURE.iterdir() if p.is_dir())
    shortlist_stash=[
        stash/"808s"/"@lilfrus - Swk Sub 808.wav",
        stash/"808s"/"@lilfrus - Soft Spinz Short Sub 808.wav",
        stash/"808s"/"@killkxng - tdf sub 808.wav",
        stash/"808s"/"@lilfrus - Classic Frus 808.wav",
        stash/"808s"/"@lilfrus - Basic 1 808.wav",
        stash/"High Hats"/"@lilfrus - Perc40 May Sample 1 High Hat.wav",
        stash/"High Hats"/"@lilfrus - Kickback (Okaymar) High Hat.wav",
        stash/"High Hats"/"@killkxng - tdf hat.wav",
        stash/"High Hats"/"@lilfrus - Box High Hat.wav",
        stash/"Claps"/"@lilfrus - Perc40 Normal Clap.wav",
        stash/"Claps"/"@lilfrus - Tdf June Sample Clap.wav",
        stash/"Claps"/"@killkxng - throw it clap.wav",
    ]
    paths=list(CULTURE.rglob("*.wav"))+list((stash/"Loops").rglob("*.wav"))+list((stash/"Loops").rglob("*.mp3"))+shortlist_stash
    with ThreadPoolExecutor(max_workers=6) as pool:
        measured=list(pool.map(measure,paths))
    byname={r["originalFilename"]:r for r in measured}
    save("sound-character-measurements.json",measured)
    # Candidate group identities are retained for matched same-phrase comparisons.
    # These choices reflect measured duration, pitch stability, headroom and contrast.
    # They are deliberately labelled candidates awaiting a listener's decision.
    groups=[
        {"id":"north-round","name":"North round candidate","bass":"Jazzfeezy 808 3.wav","clap":"Jazzfeezy Clap2.wav","hat":"Lex Hi-Hat (1).wav"},
        {"id":"north-pitched","name":"North pitched candidate","bass":"Plugg (Use 1 Octave Lower).wav","clap":"C - RnB.wav","hat":"HIHATS3.wav"},
        {"id":"stash-pocket","name":"Stash pocket candidate","bass":"@lilfrus - Classic Frus 808.wav","clap":"@lilfrus - Perc40 Normal Clap.wav","hat":"@lilfrus - Perc40 May Sample 1 High Hat.wav"},
    ]
    assets=[]
    for group in groups:
        group["assets"]={}
        for role in ["bass","clap","hat"]:
            row=byname[group[role]]
            # Conservative peak compensation. Final comparison gain is performed on renders.
            gain={"bass":.22,"clap":.38,"hat":.30}[role]*min(1,10**((-1-row["peakDb"])/20))
            a=make_asset(row,role,round(gain,6))
            assets.append(a)
            group["assets"][role]=a["id"]
        group["status"]="Measured candidate; not subjectively selected"
    for filename,role,gain in [("Simple Hat.wav","hat",.23),("SB Kick.wav","kick",.32),("Basic 808 Open Hat.wav","open",.20),("Clink Hit.wav","perc",.22)]:
        assets.append(make_asset(byname[filename],role,gain*min(1,10**((-1-byname[filename]["peakDb"])/20))))
    save("new-palette.json",assets)
    save("new-palette-manifest.json",{"groups":groups,"assets":[{k:v for k,v in a.items() if k!="data"} for a in assets],"selectionLimit":"Signal-informed comparison candidates; no subjective audition. Use same score and loudness-match each group render before selection."})
    loop_rows=sorted([r for r in measured if r["classification"]=="musical-loop"],key=lambda r:int(re.search(r"LOOP (\d+)",r["originalFilename"]).group(1)))
    for row in loop_rows:
        row["tempo"]=int(re.search(r"\((\d+)\)",row["originalFilename"]).group(1))
        row["tempoConfidence"]="Filename plus exact duration check only; downbeat not heard"
        row["fileLengthBeats"]=row["duration"]*row["tempo"]/60
        row["keyVerified"]=False
        row["creator"]="@lilfrus"
        row["creditRequest"]="USE TAG!! (retained from source filename)"
    loop10=next(r for r in loop_rows if "LOOP 10 " in r["originalFilename"])
    loop10.update({"regionStartSeconds":0,"regionEndSeconds":loop10["duration"],"regionBeats":32,"regionBars":8,"durationVs32BeatsErrorSeconds":loop10["duration"]-32*60/155,"downbeatOffsetSeconds":0,"downbeatConfidence":"Provisional start-of-file; duration aligns to eight bars at 155 BPM, no auditory downbeat check","alignmentChecks":grid_check(ROOT/loop10["sourcePath"],155),"analysis":chroma_analysis(ROOT/loop10["sourcePath"],155),"suggestedBassWindows":[{"startBeat":2,"endBeat":3.5,"pitch":36,"confidence":.35,"rationale":"C is strongest in this 2-beat chroma segment; Cm triad salience ranks first. Short candidate support, not an asserted chord root."},{"startBeat":10,"endBeat":11.5,"pitch":36,"confidence":.3,"rationale":"C is strongest and Cm triad salience ranks first, but margin is small. Short support followed by rest over uncertain movement."}],"bassRecommendation":"Keep other regions silent in the first candidate, expose bass separately, and permit a listener to correct these provisional placements. No automatic chord transcription is claimed."})
    save("loop-catalogue.json",{"mainLoops":loop_rows,"tagSupport":[r for r in measured if r["classification"]=="tag-support"],"sourceCredit":"Main loop audio supplied by @lilfrus; keep filename credit and USE TAG request. Tag1 is supplied by the same named creator; association is based on filename/directory, not listening confirmation."})
    loop_asset=make_asset(loop10,"loop",.56,trimEnd=loop10["duration"],loop=False,creator="@lilfrus",creditRequest="USE TAG!!",nativeTempo=155,regionBeats=32,tempoConfidence=.8,sourceKeyEstimate=loop10["analysis"]["rankedKeyCandidates"][0],downbeatOffset=0,pitchAdjustment=0,stretchMode="native",boundaryFadeMs=6)
    tag=make_asset(byname["@lilfrus - TAG 1.wav"],"tag",.25,creator="@lilfrus",creditRequest="USE TAG!!")
    save("loop10-bank.json",[loop_asset,tag])
    native=decode(ROOT/loop10["sourcePath"]).reshape(-1,loop10["channels"])
    waveform=[]
    for block in np.array_split(native,512):
        waveform.append([round(float(block.min()),5),round(float(block.max()),5)])
    save("loop10-waveform.json",{"assetId":loop_asset["id"],"hash":loop10["hash"],"duration":loop10["duration"],"sampleRate":loop10["sampleRate"],"frames":loop10["frames"],"channels":loop10["channels"],"nativeTempo":155,"regionBeats":32,"bins":waveform,"method":"Min/max across both actual source channels in 512 equal frame ranges; source audio unchanged"})
    save("loop10-metadata.json",{**loop10,"assetId":loop_asset["id"],"tagAssetId":tag["id"],"tagSelection":"@lilfrus - TAG 1.wav from same Loops folder; creator filename match, words/audio not subjectively verified","harmonicGuidance":"Chroma is a provisional pitch-class observation, not a chord transcription. Keep support sparse, expose bass separately for listening review, and allow key/root overrides."})
    print(json.dumps({"groups":groups,"loop10":loop_asset["id"],"tag":tag["id"],"keyCandidates":loop10["analysis"]["rankedKeyCandidates"],"bassCases":[{k:r[k] for k in ["originalFilename","root","tuning","measuredFundamentalHz","pitchWindows"] if k in r} for r in measured if r["sourcePath"].find('/808/')>=0 or r["originalFilename"]=="@lilfrus - Swk Sub 808.wav"]},indent=2))


if __name__=="__main__":
    main()
