#!/usr/bin/env python3
"""Read actual PCM and the engine score to corroborate arrangement/tail assertions.
No audio is altered. Gated RMS and score events do not establish perceived quality.
"""
from __future__ import annotations
import argparse
from collections import Counter
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path
import subprocess

os.environ['OMP_NUM_THREADS'] = '1'
os.environ['OPENBLAS_NUM_THREADS'] = '1'
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
NODE = Path('/Users/nikitakrymov/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node')
spec = importlib.util.spec_from_file_location('delivery_audit', ROOT/'scripts/delivery-audit.py')
audit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit)


def db(value):
    return 20*math.log10(value) if value > 0 else None


def level(data):
    if not len(data):
        return {'frames':0, 'rmsDbFS':None, 'peakDbFS':None, 'digitalSilence':True}
    square = np.mean(data.astype(np.float64)**2, axis=1)
    rms = float(np.sqrt(np.mean(square)))
    peak = float(np.max(abs(data)))
    return {'frames':len(data), 'rmsDbFS':db(rms), 'peakDbFS':db(peak), 'digitalSilence':peak == 0}


def section_level(data, rate, start, end):
    first, last = max(0, round(start*rate)), min(len(data), round(end*rate))
    part = data[first:last]
    result = {'sourceFrames':[first,last], **level(part)}
    gate_size = max(1, round(rate*.01))
    count = len(part)//gate_size
    if count:
        power = np.mean(part[:count*gate_size].astype(np.float64).reshape(count,gate_size,-1)**2,axis=(1,2))
        result['tenMsRMSGate'] = {}
        for threshold in [-40,-60,-80]:
            active = np.flatnonzero(power > 10**(threshold/10))
            result['tenMsRMSGate'][str(threshold)] = {
                'activeWindowCount':len(active), 'windowCount':count,
                'activeFraction':len(active)/count,
                'firstActiveWindowStartSeconds':(first+int(active[0])*gate_size)/rate if len(active) else None,
                'lastActiveWindowEndSeconds':(first+(int(active[-1])+1)*gate_size)/rate if len(active) else None,
            }
    return result


def tail(data, rate):
    peaks = np.max(abs(data),axis=1)
    result = {}
    for label, threshold in [('digitalZero',0),('minus100dBFS',1e-5),('minus80dBFS',1e-4),('minus60dBFS',.001),('minus40dBFS',.01)]:
        active = np.flatnonzero(peaks > threshold)
        last = int(active[-1]) if len(active) else None
        first_quiet = last+1 if last is not None else 0
        result[label] = {'amplitudeThreshold':threshold,'lastAboveThresholdFrame':last,
            'lastAboveThresholdTimeSeconds':last/rate if last is not None else None,
            'trailingAtOrBelowThresholdFrames':len(data)-first_quiet,
            'trailingAtOrBelowThresholdSeconds':(len(data)-first_quiet)/rate}
    return result


def get_score(project_path):
    code = '''import fs from "node:fs";
import {score} from "./src/engine/score.ts";
const p = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
process.stdout.write(JSON.stringify(score(p)));'''
    return json.loads(subprocess.check_output([str(NODE),'--import','tsx','--input-type=module','-e',code,str(project_path)],cwd=ROOT,text=True))


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('directory',type=Path)
    parser.add_argument('--output',type=Path,required=True)
    args=parser.parse_args()
    directory=args.directory.resolve()
    project_path=directory/'project.ish.json'
    checkpoint_path=directory/'checkpoint.json'
    if args.output.suffix.lower() != '.json' or args.output.resolve() in {project_path, checkpoint_path}:
        parser.error('Output must be a separate JSON report, never source project/checkpoint/audio.')
    project=json.loads(project_path.read_text())
    checkpoint=json.loads(checkpoint_path.read_text())
    outputs={o['name']:o for o in checkpoint.get('outputs',[])}
    bpm=project['settings']['bpm']; seconds_per_tick=60/bpm/480
    events=get_score(project_path)
    sections=[]; tick=0
    source_sections=project['sections'] if project['arrangement'] else [{'id':'loop','kind':'hook','name':'Loop','bars':8}]
    for sec in source_sections:
        end=tick+sec['bars']*1920
        section_events=[e for e in events if tick <= e['tick'] < end]
        sections.append({**sec,'ticks':[tick,end],'startSeconds':tick*seconds_per_tick,'endSeconds':end*seconds_per_tick,
            'scoreEventCounts':dict(Counter(e['role'] for e in section_events)),
            'scoreRoles':{role:{'onsetsSeconds':[e['tick']*seconds_per_tick for e in section_events if e['role']==role],
                'gatedEndSeconds':[(e['tick']+e['duration'])*seconds_per_tick for e in section_events if e['role']==role]}
                for role in sorted({e['role'] for e in section_events})}})
        tick=end
    music_seconds=tick*seconds_per_tick
    tracks=project['candidates'][project['selected']]['tracks']
    note_summary={}
    for track in tracks:
        notes=track['notes']
        if not notes: continue
        times=sorted(set(n['tick'] for n in notes))
        note_summary[track['id']]={'notesInStoredPattern':len(notes),'glides':[{'tick':n['tick'],'duration':n['duration'],'glide':n['glide']} for n in notes if n.get('glide')],
            'durationTicksRange':[min(n['duration'] for n in notes),max(n['duration'] for n in notes)],
            'successiveOnsetDeltaTicksHistogram':dict(Counter(b-a for a,b in zip(times,times[1:]))),
            'trackGain':track['volume'],'instrument':track['instrument']}
    comparison_ranges=[('modelClaim43to54',43,54),('modelClaim104to115',104,115),('modelClaimStopsAt114',114,None),('lastSecondBeforeMusicEnd',music_seconds-1,music_seconds),('allocatedEffectTail',music_seconds,None)]
    rows=[]
    paths=[directory/'mix.wav']+sorted(directory.glob('stem-*-dry.wav'))
    for path in paths:
        before=audit.sha(path); meta=audit.probe(path); data=audit.decode(path,meta['channels'])
        if len(data)!=meta['frames']: raise ValueError('Frame decoding mismatch')
        bins=[]
        for start in range(0,len(data),round(meta['sampleRate']*.5)):
            end=min(len(data),start+round(meta['sampleRate']*.5))
            bins.append({'startSeconds':start/meta['sampleRate'],'endSeconds':end/meta['sampleRate'],**level(data[start:end])})
        row={'name':path.name,'sha256':before,'checkpointHashMatches':before==outputs.get(path.name,{}).get('sha256'),
            'audio':meta,'overall':level(data),'tail':tail(data,meta['sampleRate']),
            'sections':[{k:sec[k] for k in ['id','name','kind','startSeconds','endSeconds']} |
                section_level(data,meta['sampleRate'],sec['startSeconds'],sec['endSeconds']) for sec in sections],
            'comparisonRanges':[{ 'name':name,'startSeconds':start,'endSeconds':end or meta['durationSeconds'],
                **section_level(data,meta['sampleRate'],start,end or meta['durationSeconds'])} for name,start,end in comparison_ranges],
            'halfSecondTimeline':bins}
        if path.name=='mix.wav':
            row['loudness']=audit.metrics(path,meta)
            row['last100Ms']=level(data[-round(meta['sampleRate']*.1):])
            row['lastFrameSamples']=data[-1].tolist()
            row['lastAdjacentFrameStepPeak']=float(np.max(abs(data[-1]-data[-2])))
        if before!=audit.sha(path): raise ValueError(f'File changed: {path}')
        rows.append(row)
        print(json.dumps({'measured':path.name,'frames':meta['frames']}),flush=True)
        del data
    source_hashes={item['path']:item['sha256'] for item in checkpoint.get('provenance',{}).get('engine',{}).get('sourceFiles',[])}
    score_code={name:{'sha256':audit.sha(ROOT/name),'matchesRenderSnapshot':audit.sha(ROOT/name)==source_hashes.get(name)} for name in ['src/engine/score.ts','src/engine/schema.ts']}
    result={'schemaVersion':1,'createdAt':datetime.now(timezone.utc).isoformat(),
        'method':{'nativePCM':'FFmpeg float32 decode retaining source sample rate and channel count; no normalization/resampling/edits.',
            'levels':'Stereo mean square RMS; maximum absolute sample peak. Null dB means exact zero. Independent 10ms nonoverlapping RMS windows measure threshold occupancy; final partial window omitted from gate counts, retained in RMS.',
            'tail':'Last native frame where any channel exceeds stated amplitude. Digital silence requires every remaining sample exactly zero. Thresholds are numerical, not audibility tests.',
            'score':'Actual imported engine score(project), with current score/schema hashes checked against checkpoint source snapshot. Event onsets/gates are scheduled intentions; sample/FX tails can extend.',
            'interpretation':'Not audio-language hearing or musical quality assessment. Energy changes can corroborate presence/dropouts; equal RMS cannot establish unchanged timbre/rhythm, and a lower kick RMS does not prove perceptual masking.'},
        'script':{'path':str(Path(__file__).resolve()),'sha256':audit.sha(__file__)},
        'checkpoint':{'path':str(checkpoint_path),'sha256':audit.sha(checkpoint_path),'status':checkpoint.get('status'),'outputsAtSnapshot':len(outputs)},
        'project':{'path':str(project_path),'sha256':audit.sha(project_path),'matchesCheckpoint':audit.sha(project_path)==checkpoint['identity']['sourceSha256'],
            'title':project['title'],'bpm':bpm,'musicDurationSeconds':music_seconds,'bars':tick/1920},
        'scoreImplementation':score_code,'sections':sections,'storedPatternNotes':note_summary,
        'audioFiles':rows,'unavailablePlannedAudio':[x['name'] for x in checkpoint['identity']['renderPlan'] if not (directory/x['name']).is_file()]}
    args.output.parent.mkdir(parents=True,exist_ok=True)
    args.output.write_text(json.dumps(result,indent=2)+'\n')
    print(json.dumps({'saved':str(args.output),'files':len(rows)}))

if __name__=='__main__':main()
