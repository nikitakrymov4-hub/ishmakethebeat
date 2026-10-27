#!/usr/bin/env python3
"""Prepare three anonymous24-second excerpts with reversible constant LUFS gain.

No model is invoked. --output-dir must be new and under private-assets (or /tmp
for a tooling test). Keep answer-key.private.json out of model prompts/uploads.
"""
from __future__ import annotations
import argparse
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path
import random
import subprocess
import tempfile

os.environ['OMP_NUM_THREADS']='1'
os.environ['OPENBLAS_NUM_THREADS']='1'
import numpy as np
ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('delivery_audit',ROOT/'scripts/delivery-audit.py')
audit=importlib.util.module_from_spec(spec);spec.loader.exec_module(audit)
RATE=44100


def encode(data,path,codec):
    args=[audit.FFMPEG,'-v','error','-nostdin','-threads','1','-f','f32le','-ar',str(RATE),'-ac','2','-i','-',
          '-map_metadata','-1','-c:a',codec]
    if codec=='flac':args+=['-sample_fmt','s32','-bits_per_raw_sample','24']
    args+=['-n',str(path)]
    subprocess.run(args,input=np.asarray(data,dtype='<f4').tobytes(),check=True)


def measure(path):
    run=subprocess.run([audit.FFMPEG,'-hide_banner','-nostdin','-threads','1','-filter_threads','1','-i',str(path),
        '-af','loudnorm=I=-24:TP=-1:LRA=11:print_format=json','-f','null','-'],capture_output=True,text=True,check=True)
    raw=json.JSONDecoder().raw_decode(run.stderr[run.stderr.rfind('{'):])[0]
    values={name:audit.number(raw[key]) for name,key in [('integratedLUFS','input_i'),('loudnessRangeLU','input_lra'),('truePeakDbTP','input_tp')]}
    if values['integratedLUFS'] is None or values['truePeakDbTP'] is None:
        raise ValueError('Silent/undefined loudness cannot be level matched')
    return values


def extract(path,start,seconds):
    meta=audit.probe(path)
    if meta['channels']!=2:raise ValueError('Use original stereo sources; channel conversion is not implicit')
    first=round(start*meta['sampleRate']);count=round(seconds*meta['sampleRate']);last=first+count
    if first<0 or last>meta['frames']:raise ValueError('Requested clip extends outside source')
    filters=f'atrim=start_sample={first}:end_sample={last},asetpts=PTS-STARTPTS'
    if meta['sampleRate']!=RATE:filters+=f',aresample={RATE}'
    raw=subprocess.check_output([audit.FFMPEG,'-v','error','-nostdin','-threads','1','-i',str(path),'-map','0:a:0',
        '-af',filters,'-c:a','pcm_f32le','-f','f32le','-'])
    data=np.frombuffer(raw,dtype='<f4').reshape(-1,2)
    if len(data)!=round(seconds*RATE) or not np.isfinite(data).all():raise ValueError('Decoded clip frame count/nonfinite mismatch')
    return data,meta,first,last


def gain_for(source_lufs,target_lufs,source_true_peak):
    gain_db=target_lufs-source_lufs
    if source_true_peak+gain_db > -1:
        raise ValueError('Requested common LUFS target exceeds the -1dBTP guard; choose a lower common --target-lufs. No limiter/individual peak normalization is applied.')
    return gain_db,10**(gain_db/20)


def main():
    p=argparse.ArgumentParser(description=__doc__)
    for name in ['before','after','reference']:
        p.add_argument('--'+name,type=Path,required=True)
        p.add_argument('--'+name+'-start',type=float,required=True,help='Seconds from original decoded frame zero, explicitly selected comparable main passage')
    p.add_argument('--seconds',type=float,default=24)
    p.add_argument('--target-lufs',type=float,default=-24)
    p.add_argument('--seed',type=int,required=True)
    p.add_argument('--output-dir',type=Path,required=True)
    args=p.parse_args()
    if not 20<=args.seconds<=45:p.error('Use20–45s clips; default24s')
    if not -60<=args.target_lufs<=-12:p.error('Target outside supported comparison range')
    directory=args.output_dir.resolve()
    allowed=[ROOT/'private-assets',Path('/private/tmp'),Path('/tmp').resolve()]
    if not any(directory.is_relative_to(base.resolve()) for base in allowed):p.error('Private output directory must be under project private-assets or temporary directory')
    if directory.exists():p.error('Output directory exists; choose a fresh run directory')
    source_records=[]
    with tempfile.TemporaryDirectory(prefix='ish-blind-prepare-',dir='/private/tmp') as temp:
        temp=Path(temp)
        for role in ['before','after','reference']:
            path=getattr(args,role).resolve(strict=True);before_hash=audit.sha(path)
            data,meta,first,last=extract(path,getattr(args,role+'_start'),args.seconds)
            raw_path=temp/(role+'-raw.wav');encode(data,raw_path,'pcm_f32le')
            measured=measure(raw_path)
            gain_db,gain=gain_for(measured['integratedLUFS'],args.target_lufs,measured['truePeakDbTP'])
            scaled=data.astype(np.float64)*gain
            if np.max(abs(scaled))>=1:raise ValueError('Gain would clip native samples')
            normalized=temp/(role+'-matched.wav');encode(scaled,normalized,'pcm_s24le')
            after=measure(normalized)
            if abs(after['integratedLUFS']-args.target_lufs)>.06:raise ValueError('Result missed common LUFS target by >0.06LU; no automatic dynamic correction')
            if after['truePeakDbTP'] > -1:raise ValueError('Measured matched true peak exceeds guard')
            rendered=audit.decode(normalized,2)
            error=float(np.max(abs(rendered.astype(np.float64)-scaled)))
            if error>2**-23+1e-7:raise ValueError('24bit conversion error exceeds quantization allowance')
            if audit.sha(path)!=before_hash:raise ValueError('Original changed during extraction')
            source_records.append({'identity':role,'original':{'path':str(path),'sha256':before_hash,**meta},
                'region':{'startFrame':first,'endFrameExclusive':last,'sampleRate':meta['sampleRate'],'startSeconds':first/meta['sampleRate'],'endSeconds':last/meta['sampleRate']},
                'rawExcerptPCMFloat32SHA256':hashlib.sha256(data.tobytes()).hexdigest(),
                'gain':{'constantDb':gain_db,'constantLinear':gain,'inverseDb':-gain_db,'inverseLinear':1/gain,'purpose':'Reversible level comparison only; no dynamics/limiter/EQ/fades.'},
                'beforeMeasurement':measured,'afterMeasurement':after,'max24bitQuantizationError':error,
                'resampling':'None' if meta['sampleRate']==RATE else f'Explicit FFmpeg swresample native{meta["sampleRate"]} to{RATE}; stereo channels preserved',
                'temporaryMatchedPath':str(normalized)})
            del data,scaled,rendered
        random.Random(args.seed).shuffle(source_records)
        directory.mkdir(parents=True)
        public=[];private=[]
        for label,row in zip('ABC',source_records):
            wav=directory/(label+'.wav');flac=directory/(label+'.flac')
            wav.write_bytes(Path(row.pop('temporaryMatchedPath')).read_bytes())
            data=audit.decode(wav,2);encode(data,flac,'flac');back=audit.decode(flac,2)
            if not np.array_equal(data,back):raise ValueError('FLAC companion does not preserve exact24bit PCM')
            pcm_hash=hashlib.sha256(data.tobytes()).hexdigest()
            record={'id':'blind-'+label,'label':label,'audioPath':str(wav),'audioSHA256':audit.sha(wav),
                'preferredUpload':{'path':str(flac),'sha256':audit.sha(flac),'bytes':flac.stat().st_size},
                'frames':len(data),'durationSeconds':len(data)/RATE,'sampleRate':RATE,'channels':2,
                'decodedFloat32SHA256':pcm_hash,'commonTargetLUFS':args.target_lufs,'measurement':row['afterMeasurement'],
                'processing':'Single constant gain, common sample rate,24bit encoding; no EQ/dynamics/fades. Source mapping withheld from blind request; see private answer key after assessment.'}
            public.append(record);private.append({'label':label,**row,'output':record})
        prompt=(f'Three separate audio attachments A, B and C each contain {args.seconds:g} seconds of music. All use reversible constant gain to approximately {args.target_lufs:g} LUFS; no limiter or dynamic normalization was applied. '
                'Compare only the actual attached audio. For each label, describe the melody texture and register, bass articulation, kick versus bass clarity, clap/snare impact, hat spacing/texture, dry versus ambient balance and the interaction of these parts. '
                'Some recordings may have lead vocals while others are instrumentals: distinguish those voices from embedded tags and account for masking; do not penalize an instrumental for lacking a rapper. '
                'Then state the most concrete production differences and at most two shortcomings supported by the audio, with approximate within-clip locations if clear. It is acceptable to report no reliable difference. '
                'Do not guess artist, source, chronological version, exact notes/presets, or which is intended to be better. No numerical quality scores. Do not infer a whole-song arrangement or ending from these excerpts. '
                'Channel preprocessing may prevent reliable stereo-width claims. Keep observations, uncertain interpretations and possible changes separate. Under500words.\n')
        (directory/'blind-prompt.txt').write_text(prompt)
        common={'schemaVersion':1,'createdAt':datetime.now(timezone.utc).isoformat(),'script':{'path':str(Path(__file__).resolve()),'sha256':audit.sha(__file__)},
            'protocol':{'targetLUFS':args.target_lufs,'durationSeconds':args.seconds,'measurement':'FFmpeg loudnorm input values; true peak internal192kHz estimate, reported0.01dB; output discarded.',
                'gainOnly':True,'sourceSelection':'Explicit caller-selected comparable main passages; builder does not infer musical alignment or listen.',
                'noModelExecution':True,'promptPath':str(directory/'blind-prompt.txt')}}
        (directory/'blind-inputs.json').write_text(json.dumps({**common,'records':public},indent=2)+'\n')
        (directory/'answer-key.private.json').write_text(json.dumps({**common,'doNotUpload':'Private identity/processing mapping; withhold from blind evaluator until response preserved.','randomization':{'seed':args.seed,'algorithm':'Python random.Random(seed).shuffle of before,after,reference; labelA/B/C after shuffle'},'records':private},indent=2)+'\n')
    print(json.dumps({'prepared':str(directory),'anonymousInputManifest':str(directory/'blind-inputs.json'),'prompt':str(directory/'blind-prompt.txt'),'files':3,'modelExecuted':False}))

if __name__=='__main__':main()
