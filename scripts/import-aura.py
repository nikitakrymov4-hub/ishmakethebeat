#!/usr/bin/env python3
"""Import a known user-supplied Aura ZIP once; no installation or network.

ZIP validation and CRC pass finish BEFORE extraction. Only genuine PCM WAV
files enter a fresh ignored 0700 directory; originals remain byte-identical.
Pitch analysis is a separate offline step; no musical octave is assumed here.
"""
from pathlib import Path, PurePosixPath
from collections import Counter
import hashlib, json, os, stat, struct, subprocess, tempfile, unicodedata, zipfile

ROOT = Path(__file__).resolve().parents[1]
SOURCE = Path.home() / 'Downloads/Echo+Sound+Works+-+Aura+One+Shots.zip'
DEST = ROOT / 'private-assets/aura'
EXPECTED_HASH = '0b5926c25a9aa1df67732586a348456d4d47b0e7bb30b9ab801229b76ca8c0ae'
MAX_MEMBER = 15_000_000
MAX_TOTAL = 200_000_000
MAX_ENTRIES = 256

def sha(path):
    h = hashlib.sha256()
    with path.open('rb') as f:
        for block in iter(lambda: f.read(1024*1024), b''): h.update(block)
    return h.hexdigest()

def member_path(item):
    raw = item.orig_filename
    if not raw or raw != item.filename or '\x00' in raw or '\\' in raw:
        raise ValueError('Unsafe ZIP name')
    parts = raw.rstrip('/').split('/')
    if raw.startswith('/') or any(not p or p in ('.', '..') or ':' in p or any(ord(c)<32 for c in p) for p in parts):
        raise ValueError('Unsafe ZIP path: ' + repr(raw))
    mode = item.external_attr >> 16
    kind = stat.S_IFMT(mode)
    if kind not in (0, stat.S_IFREG, stat.S_IFDIR) or (kind == stat.S_IFDIR) != item.is_dir() and kind != 0:
        raise ValueError('Non-regular member: ' + raw)
    if item.flag_bits & 1 or item.compress_type not in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED):
        raise ValueError('Encrypted or unsupported compression')
    if not 0 <= item.file_size <= MAX_MEMBER or item.file_size / max(1,item.compress_size) > 200:
        raise ValueError('Member size/ratio exceeds limit')
    return PurePosixPath(*parts)

def metadata(p):
    return any(s == '__MACOSX' or s == '.DS_Store' or s.startswith('._') for s in p.parts)

def validate_archive(z):
    entries = z.infolist()
    if len(entries)>MAX_ENTRIES or sum(e.file_size for e in entries)>MAX_TOTAL:
        raise ValueError('Archive size/entry limit exceeded')
    seen = {}; genuine=[]; skipped=[]
    for item in entries:
        p = member_path(item)
        key = unicodedata.normalize('NFC',str(p)).casefold()
        if key in seen: raise ValueError('Duplicate/case-normalized collision')
        seen[key] = item.is_dir()
        if item.is_dir() or metadata(p): skipped.append(item.filename)
        elif p.suffix.lower() == '.wav': genuine.append((item,p))
        else: raise ValueError('Unexpected non-audio content; inspect before proceeding')
    for key in seen:
        parents=key.split('/')[:-1]
        for i in range(1,len(parents)+1):
            parent='/'.join(parents[:i])
            if parent in seen and not seen[parent]: raise ValueError('File/directory collision')
    # Read ALL members, including metadata, to EOF: zipfile checks CRC and overlap.
    for item in entries:
        count=0
        with z.open(item) as src:
            for block in iter(lambda:src.read(1024*1024), b''):
                count+=len(block)
                if count>item.file_size: raise ValueError('Declared expansion exceeded')
        if count != item.file_size: raise ValueError('Declared expansion mismatch')
    return genuine, skipped

def wav_info(data):
    if len(data)<44 or data[:4]!=b'RIFF' or data[8:12]!=b'WAVE' or struct.unpack_from('<I',data,4)[0]+8 != len(data):
        raise ValueError('Invalid RIFF/WAVE')
    offset=12; fmt=None; frames=None; pcm_bytes=0
    while offset+8<=len(data):
        name,size=struct.unpack_from('<4sI',data,offset); start=offset+8
        if start+size>len(data): raise ValueError('Invalid WAV chunk')
        if name==b'fmt ':
            if fmt is not None or size<16: raise ValueError('Invalid fmt')
            fmt=struct.unpack_from('<HHIIHH',data,start)
        if name==b'data':
            if pcm_bytes: raise ValueError('Duplicate audio chunk')
            pcm_bytes=size
        offset=start+size+(size%2)
    if not fmt or not pcm_bytes: raise ValueError('Missing audio/fmt')
    code,channels,rate,byte_rate,align,bits=fmt
    if code!=1 or channels not in (1,2) or rate not in (22050,32000,44100,48000,88200,96000) or bits not in (16,24,32) or align!=channels*bits//8 or byte_rate!=rate*align or pcm_bytes%align:
        raise ValueError('Unsupported or inconsistent PCM WAV')
    frames=pcm_bytes//align
    if not 0<frames/rate<=30: raise ValueError('One-shot duration outside bound')
    return {'sampleRate':rate,'channels':channels,'bitsPerSample':bits,'frames':frames,'duration':frames/rate,'format':'PCM WAV'}

def category(name):
    prefix=name.removeprefix('ESW Aura ').split(' - ')[0].strip()
    return {'Key':'Keys','Keys':'Keys','Inst':'Instruments','Bell':'Instruments','Brass':'Instruments','808':'Bass / 808','Bass':'Bass / 808'}.get(prefix,prefix)

def main():
    if SOURCE.is_symlink() or not SOURCE.is_file(): raise ValueError('ZIP must be a regular original file')
    if SOURCE.stat().st_size!=129038590 or sha(SOURCE)!=EXPECTED_HASH: raise ValueError('Original ZIP differs')
    if DEST.exists() or DEST.is_symlink(): raise ValueError('Fresh destination required; existing data preserved')
    if DEST.parent.is_symlink(): raise ValueError('Private parent cannot be a symlink')
    if subprocess.run(['git','check-ignore','-q','private-assets/aura/probe'],cwd=ROOT).returncode: raise ValueError('Bank must be Git ignored')
    with zipfile.ZipFile(SOURCE) as z:
        genuine, skipped=validate_archive(z)
        if len(genuine)!=101: raise ValueError('Unexpected source count')
        # Staging is never promoted on failure; retained privately for diagnosis.
        stage=Path(tempfile.mkdtemp(prefix='.aura-stage-',dir=DEST.parent)); stage.chmod(0o700)
        (stage/'audio').mkdir(mode=0o700)
        rows=[]
        for item,p in genuine:
            data=z.read(item); digest=hashlib.sha256(data).hexdigest(); audio=wav_info(data)
            target=stage/'audio'/p.name
            with target.open('xb') as out: out.write(data)
            target.chmod(0o600)
            rows.append({'id':'aura-'+digest[:20], 'originalFilename':p.name,'archiveMember':item.filename,
                         'file':'audio/'+p.name,'bytes':len(data),'sha256':digest,'archiveCRC32':f'{item.CRC:08x}',
                         'crcVerified':True,'category':category(p.name),'categoryBasis':'filename token only',
                         **audio,'pitch':{'status':'manual_root_required','rootMidi':None,'confidence':0,
                         'sourcePitchClass':'C','sourceOctave':None,'method':'Not analyzed yet'}})
        if len({r['id'] for r in rows})!=len(rows): raise ValueError('Duplicate audio content; inspect')
        manifest={'version':1,'id':'aura','name':'Echo Sound Works — Aura','privateLocalOnly':True,
          'source':{'archiveName':SOURCE.name,'archiveSha256':EXPECTED_HASH,'archiveBytes':SOURCE.stat().st_size,
          'productUrl':'https://www.echosoundworks.com/aura-one-shots','licenseUrl':'https://www.echosoundworks.com/copyright-policy',
          'licenseCheckedAt':'2026-10-16','embeddedLicenseDocuments':0,
          'licenseSummary':'Licensed original user may use samples in original commercial/noncommercial music. No raw sharing, repackaging, sample-pack or competing-plugin redistribution. Private local use only; app redistribution not authorized.',
          'pitchStatement':'Vendor says tuned to C; octave unspecified. All estimates are numerical, not ear validation.'},
          'validation':{'allEntries':len(z.infolist()),'allEntriesCRCVerified':True,'expandedAllBytes':sum(i.file_size for i in z.infolist()),
          'audioCount':len(rows),'audioBytes':sum(r['bytes'] for r in rows),'skippedCount':len(skipped),'skippedMembers':skipped},
          'files':sorted(rows,key=lambda r:(r['category'],r['originalFilename']))}
        (stage/'manifest.json').write_text(json.dumps(manifest,indent=2,allow_nan=False)+'\n'); (stage/'manifest.json').chmod(0o600)
        if sha(SOURCE)!=EXPECTED_HASH: raise ValueError('ZIP changed during ingestion')
        stage.rename(DEST)
        print(json.dumps({'destination':str(DEST),'audioCount':len(rows),'categories':Counter(r['category'] for r in rows),'audioBytes':sum(r['bytes'] for r in rows),'archivePreserved':True}))

if __name__=='__main__': main()
