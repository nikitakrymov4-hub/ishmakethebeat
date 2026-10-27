#!/usr/bin/env python3
"""Build a local listening page from explicitly selected, completed deliveries.

python build-finished-listener.py --write-template listener-manifest.json
python build-finished-listener.py listener-manifest.json --output listen.html
All manifest paths are relative to the manifest file. Missing or mismatched
files are omitted and reported; no earlier render is substituted. The explicit
--allow-short-fixtures flag creates a QA page, never a finished-beat page.
"""
from __future__ import annotations
import argparse
from datetime import datetime, timezone
import hashlib
from html import escape
import json
import os
from pathlib import Path
from urllib.parse import quote
import wave
from delivery_contract import delivery_contract


def sha(path):
    with Path(path).open("rb") as f:
        return hashlib.file_digest(f,"sha256").hexdigest()


def url(path, output):
    return quote(os.path.relpath(path,output.parent),safe="/")


def duration(seconds):
    tenths=round(seconds*10)
    return f"{tenths//600}:{(tenths%600)/10:04.1f}"


def template():
    return {"schemaVersion":1,"title":"ishmakethebeat · Sample-based beats", "description":"Sample-based instrumentals, editable projects and full benchmark stems.", "minimumMusicSeconds":90,
        "entries":[{"id":name,"label":label,"kind":kind,"checkpoint":f"REPLACE_RUN/{name}/checkpoint.json","description":""} for name,label,kind in
            [("selected-direction","Selected direction","selected"),("benchmark-before","Before revision","before"),("benchmark-revised","Revised benchmark","revised"),
             ("seed-01","Generated example 1","seed"),("seed-02","Generated example 2","seed"),("seed-03","Generated example 3","seed")]],
        "links":[], "notes":"Complete checkpoints must match their explicit delivery mode. Selected direction and revised benchmark require complete mode; mixes mode examples do not claim stems or instrumental exports. Optional entry.audit must bind the exact checkpoint and pass. A before-only entry may use verifiedFiles:[{name:'mix.wav',sha256:'actual file digest'}] against an incomplete checkpoint; this shows only explicitly verified audio with an incomplete-delivery label. entry.creditLinks lists existing local credit/terms documents. Selected direction records the user's preferred foundation, not final musical approval."}


def checked_entry(entry, base, output, minimum, fixture):
    checkpoint_path = (base / entry["checkpoint"]).resolve()
    if not checkpoint_path.is_file(): return None,"checkpoint does not exist"
    c = json.loads(checkpoint_path.read_text())
    explicit_files = entry.get("verifiedFiles")
    comparison_only = explicit_files is not None
    if comparison_only and (entry.get("kind") != "before" or not isinstance(explicit_files,list) or not explicit_files):
        return None,"verifiedFiles requires a nonempty explicit before-comparison list"
    if not comparison_only and c.get("status") != "complete": return None,"checkpoint is incomplete"
    directory = checkpoint_path.parent
    identity = c.get("identity",{})
    project_path = directory / "project.ish.json"
    if not project_path.is_file() or sha(project_path) != identity.get("sourceSha256"):
        return None,"saved project hash is missing or mismatched"
    project = json.loads(project_path.read_text()); settings=project.get("settings",{})
    contract=delivery_contract(c,project)
    if contract["errors"]:return None,"; ".join(contract["errors"])
    if entry.get("deliveryMode") and entry["deliveryMode"]!=contract["mode"]:return None,"manifest deliveryMode differs from checkpoint"
    if entry.get("kind") in {"selected","revised"} and contract["mode"]!="complete":
        return None,("selected direction" if entry["kind"]=="selected" else "revised benchmark")+" requires full complete export mode"
    bars=sum(s["bars"] for s in project.get("sections",[])) if project.get("arrangement") else 8
    bpm=settings.get("bpm",0); seconds=bars*240/bpm if bpm>0 else 0
    if seconds < minimum and not fixture: return None,f"musical duration {seconds:.3f}s below {minimum}s; diagnostic renders excluded"
    files={};omitted=[]
    chosen={item.get("name"):item.get("sha256") for item in explicit_files} if comparison_only else None
    allowed_audio={"mix.wav","headroom.wav","instrumental.wav","instrumental-headroom.wav"}
    if chosen is not None and (len(chosen)!=len(explicit_files) or not set(chosen).issubset(allowed_audio)):
        return None,"before verifiedFiles must uniquely name listening/headroom audio versions"
    for item in c.get("outputs",[]):
        if chosen is not None and item["name"] not in chosen:continue
        name=item["name"];path=(directory/name).resolve()
        if Path(name).name != name or path.parent != directory: omitted.append(name);continue
        if path.is_file() and sha(path)==item.get("sha256") and path.stat().st_size==item.get("bytes") and (chosen is None or chosen[name]==item.get("sha256")):
            if path.suffix==".wav":
                try:
                    with wave.open(str(path),"rb") as wav:
                        actual={"frames":wav.getnframes(),"sampleRate":wav.getframerate(),"channels":wav.getnchannels(),"bitDepth":wav.getsampwidth()*8}
                    if any(actual[k]!=identity.get("format",{}).get(k) for k in actual) or actual["frames"]!=item.get("frames"):
                        omitted.append(name);continue
                except (wave.Error, EOFError):omitted.append(name);continue
            files[name]={"path":path,"item":item,"url":url(path,output)}
        else:omitted.append(name)
    if "mix.wav" not in files:return None,"listening mix missing or hash-mismatched"
    required=set(chosen) if comparison_only else contract["requiredNames"]
    if not required.issubset(files):return None,"required export files missing, changed or unaligned: "+", ".join(sorted(required-set(files)))
    audit_path=(base/entry["audit"]).resolve() if entry.get("audit") else None
    audit_job=None
    if audit_path and not audit_path.is_file():return None,"requested audit does not exist yet"
    if audit_path and audit_path.is_file():
        audit=json.loads(audit_path.read_text())
        audit_job=next((j for j in audit.get("jobs",[]) if j.get("checkpoint",{}).get("sha256")==sha(checkpoint_path)),None)
        if not audit_job:return None,"audit does not bind this exact checkpoint"
        if audit_job.get("status")!="passed":return None,"delivery audit failed"
        if audit_job.get("deliveryMode","complete")!=contract["mode"]:return None,"audit delivery mode mismatch"
    counts=c.get("provenance",{}).get("roleEventCounts",{})
    vocals=bool(counts.get("tag",0)+counts.get("vox",0))
    badge="QA fixture · not a finished beat" if fixture else ("Before comparison · incomplete export" if comparison_only and c.get("status")!="complete" else "Before comparison · verified audio only" if comparison_only else {"selected":"Selected direction","before":"Before revision","revised":"Revised benchmark","seed":"Additional generated example"}.get(entry.get("kind"),"Instrumental"))
    title=escape(entry.get("label") or project.get("title") or entry["id"])
    description=escape(entry.get("description", ""))
    fmt=identity.get("format",{})
    render_seconds=fmt.get("frames",0)/max(1,fmt.get("sampleRate",44100))
    tail_seconds=max(0,render_seconds-seconds)
    tags=[f"{duration(seconds)} music",f"{duration(render_seconds)} file ({tail_seconds:.1f}s render tail)",f"{bpm:g} BPM",f"Seed {settings.get('seed','—')}"]
    if project.get("sourceKind")=="supplied-loop":tags.append("Sample melody")
    card=[f'<article id="{escape(entry["id"],quote=True)}"><span class="badge">{escape(badge)}</span><h2>{title}</h2>',
        f'<p class="meta">{escape(" · ".join(tags))}</p>']
    if description:card.append(f'<p>{description}</p>')
    if entry.get("kind")=="selected":card.append('<p class="scope-note">Your closest foundation for further production. This selection is not final musical approval.</p>')
    if comparison_only:card.append('<p class="scope-note">Only the explicitly listed, hash-verified comparison audio is shown. This is not a completed delivery package.</p>')
    elif contract["mode"]=="mixes":card.append('<p class="scope-note">Listening mix, headroom mix and editable project. Separate stems and instrumental-only exports are not included for this example.</p>')
    vocal_label = "tags + vox" if counts.get("tag",0) and counts.get("vox",0) else "producer tag" if counts.get("tag",0) else "vox"
    names=[("mix.wav",f"Listening mix · {vocal_label}" if vocals else "Listening mix"),("instrumental.wav","Instrumental only"),
        ("headroom.wav","Mix with headroom"),("instrumental-headroom.wav","Instrumental with headroom")]
    for name,label in names:
        if name not in files:continue
        link=files[name]["url"]
        measurement=next((f["measurement"] for f in (audit_job or {}).get("files",[]) if f["name"]==name and f.get("measurement")),None)
        detail=""
        if measurement and measurement.get("integratedLUFS") is not None:
            detail=f'{measurement["integratedLUFS"]:.2f} LUFS · {measurement["truePeakDbTP"]:.2f} dBTP' if measurement.get("truePeakDbTP") is not None else f'{measurement["integratedLUFS"]:.2f} LUFS'
        card += [f'<div class="player"><div class="player-label"><strong>{escape(label)}</strong><span>{escape(detail)}</span><a href="{link}" download>Download WAV</a></div>',
            f'<audio controls preload="none" aria-label="{escape(label+": "+(entry.get("label") or entry["id"]),quote=True)}" src="{link}"></audio></div>']
    downloads=[]
    for name,label in [("portable-project.zip","Portable editable project"),("project.ish.json","Project JSON"),("score.mid","MIDI score"),("README.txt","Credits and delivery notes")]:
        if name in files:downloads.append(f'<a href="{files[name]["url"]}" download>{label}</a>')
    if audit_job:downloads.append(f'<a href="{url(audit_path,output)}">Audio measurements</a>')
    card.append('<div class="downloads">'+"".join(downloads)+'</div>')
    stems=[(name,file) for name,file in files.items() if name.startswith("stem-") and name.endswith(".wav")]
    if stems:
        card.append(f'<details><summary>Aligned stems · {len(stems)} files</summary><div class="stem-grid">')
        for name,file in stems:card.append(f'<a href="{file["url"]}" download>{escape(name.removeprefix("stem-").removesuffix(".wav").replace("-"," "))}</a>')
        card.append('</div></details>')
    credits=[]
    for clip in project.get("clips",[])+project.get("vocalEvents",[]):
        p=clip.get("provenance",{});credit=" · ".join(str(p.get(k)) for k in ("sourceName","creator","credit") if p.get(k))
        if credit and credit not in credits:credits.append(credit)
    if credits or entry.get("creditLinks"):
        card.append('<details><summary>Sources and credits</summary>')
        card.extend(f'<p>{escape(credit)}</p>' for credit in credits)
        for link in entry.get("creditLinks",[]):
            path=(base/link["path"]).resolve()
            if path.is_file():card.append(f'<p><a href="{url(path,output)}">{escape(link["label"])}</a></p>')
        card.append('</details>')
    card.append('</article>')
    return {"html":"\n".join(card),"id":entry["id"],"kind":entry.get("kind"),"badge":badge,"checkpoint":str(checkpoint_path),"checkpointStatus":c.get("status"),"deliveryMode":contract["mode"],"presentationScope":"verified_comparison_only" if comparison_only else contract["mode"],"musicSeconds":seconds,"omittedFiles":omitted,"audioFiles":len([n for n,_ in names if n in files]),"hasVocalEvents":vocals},None


def checked_comparison(config, base, output):
    manifest_path=(base/config["manifest"]).resolve()
    key_path=(base/config["answerKey"]).resolve()
    if not manifest_path.is_file() or not key_path.is_file():return None,"comparison provenance is missing"
    manifest=json.loads(manifest_path.read_text());key=json.loads(key_path.read_text())
    if not manifest.get("protocol",{}).get("gainOnly") or manifest["protocol"].get("targetLUFS") != -24:
        return None,"comparison must declare constant-gain matching at -24 LUFS"
    clips=config.get("clips",[])
    if len(clips)!=2 or {c.get("identity") for c in clips}!={"before","after"}:
        return None,"comparison requires exactly before and after; reference audio is not included"
    result=[]
    for item in clips:
        row=next((r for r in manifest.get("records",[]) if r["id"]==item["recordId"]),None)
        if row is None:return None,"comparison record ID is missing"
        original=next((r for r in key.get("records",[]) if r["label"]==row["label"]),None)
        if not original or original.get("identity")!=item["identity"]:return None,"private comparison mapping does not match label"
        if original["output"]["audioSHA256"]!=row["audioSHA256"]:return None,"comparison mapping hash mismatch"
        path=Path(row["audioPath"]).resolve()
        source=Path(original["original"]["path"]).resolve()
        if not path.is_file() or sha(path)!=row["audioSHA256"] or not source.is_file() or sha(source)!=original["original"]["sha256"]:
            return None,"comparison or original render hash mismatch"
        if abs(row.get("measurement",{}).get("integratedLUFS",0)+24)>.06:return None,"comparison measurement is not matched"
        with wave.open(str(path),"rb") as wav:
            if (wav.getnframes(),wav.getframerate(),wav.getnchannels(),wav.getsampwidth())!=(row["frames"],row["sampleRate"],row["channels"],3):
                return None,"comparison audio metadata mismatch"
        result.append({"label":item["label"],"identity":item["identity"],"path":str(path),"url":url(path,output),"sha256":row["audioSHA256"],
            "durationSeconds":row["durationSeconds"],"integratedLUFS":row["measurement"]["integratedLUFS"],"region":original["region"],"gainDb":original["gain"]["constantDb"]})
    if any(r["durationSeconds"]!=24 for r in result) or result[0]["region"]!=result[1]["region"]:
        return None,"comparison excerpts must share the same24-second render range"
    title=config.get("label","Compare at equal loudness")
    region=result[0]["region"]
    passage=f'{duration(region["startSeconds"]).removesuffix(".0")}–{duration(region["endSeconds"]).removesuffix(".0")}'
    card=[f'<article id="{escape(config["id"],quote=True)}"><span class="badge">Level-matched comparison</span><h2>{escape(title)}</h2>',
        f'<p>The same {passage} passage from both versions, each measured at −24.00 LUFS. Only constant playback gain was changed; no compression or limiting was added. Compare the production without the full master’s loudness difference.</p>']
    for row in result:
        card += [f'<div class="player"><div class="player-label"><strong>{escape(row["label"])}</strong><span>24.0s · {row["integratedLUFS"]:.2f} LUFS · constant gain {row["gainDb"]:+.2f} dB</span><a href="{row["url"]}" download>Download WAV</a></div>',
            f'<audio controls preload="none" aria-label="{escape(row["label"]+" at equal loudness",quote=True)}" src="{row["url"]}"></audio></div>']
    card.append('</article>')
    return {"html":"\n".join(card),"id":config["id"],"label":title,"presentationScope":"verified_constant_gain_comparison","audioFiles":2,"clips":result,
        "manifestSHA256":sha(manifest_path),"privateMappingSHA256":sha(key_path)},None


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("manifest",nargs="?",type=Path);parser.add_argument("--output",type=Path)
    parser.add_argument("--write-template",type=Path);parser.add_argument("--allow-short-fixtures",action="store_true")
    args=parser.parse_args()
    if args.write_template:
        args.write_template.parent.mkdir(parents=True,exist_ok=True)
        with args.write_template.open("x") as f:json.dump(template(),f,indent=2);f.write("\n")
        print(args.write_template.resolve());return
    if not args.manifest or not args.output:parser.error("manifest and --output are required")
    config=json.loads(args.manifest.read_text());base=args.manifest.resolve().parent;output=args.output.resolve()
    if output==args.manifest.resolve():parser.error("Output cannot overwrite input manifest")
    included=[];skipped=[];ids=set()
    for entry in config.get("entries",[]):
        if entry["id"] in ids:raise ValueError("Duplicate listener entry id")
        ids.add(entry["id"])
        result,reason=checked_entry(entry,base,output,config.get("minimumMusicSeconds",90),args.allow_short_fixtures)
        if result:included.append(result)
        else:skipped.append({"id":entry["id"],"reason":reason})
    if config.get("matchedComparison"):
        comparison=config["matchedComparison"]
        if comparison["id"] in ids:raise ValueError("Duplicate comparison entry id")
        result,reason=checked_comparison(comparison,base,output)
        if result:
            insert_at=next((i+1 for i,r in enumerate(included) if r["id"]==comparison.get("afterEntry")),len(included))
            included.insert(insert_at,result)
        else:skipped.append({"id":comparison["id"],"reason":reason})
    title="QA fixture listener" if args.allow_short_fixtures else config.get("title","ishmakethebeat")
    description="Infrastructure verification only. These files are not a finished-beat submission." if args.allow_short_fixtures else config.get("description","")
    nav="".join(f'<a href="#{escape(r["id"],quote=True)}">{escape(r.get("label") or next(e.get("label",r["id"]) for e in config["entries"] if e["id"]==r["id"]))}</a>' for r in included)
    content="\n".join(r.pop("html") for r in included) or '<p class="empty">No verified listening files are available in this manifest yet.</p>'
    links=[]
    for link in config.get("links",[]):
        path=(base/link["path"]).resolve()
        if path.is_file():links.append(f'<a href="{url(path,output)}">{escape(link["label"])}</a>')
    page='''<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>'''+escape(title)+'''</title>
<style>:root{color-scheme:dark;font:16px/1.55 ui-sans-serif,system-ui,sans-serif;background:#101117;color:#f1f1f5}*{box-sizing:border-box}body{max-width:1040px;margin:auto;padding:42px 24px 80px}header{padding-bottom:24px}h1{font-size:clamp(30px,5vw,46px);line-height:1.12;margin:10px 0 20px;letter-spacing:-.035em}h2{font-size:26px;line-height:1.2;margin:14px 0 8px}p{max-width:78ch;color:#d0d0db}a{color:#c5b5ff;text-decoration:none}a:hover{text-decoration:underline}a:focus-visible,audio:focus-visible,summary:focus-visible{outline:2px solid #dfd2ff;outline-offset:4px}nav,.downloads,.stem-grid{display:flex;flex-wrap:wrap;gap:12px 22px}nav{padding:8px 0 20px}article{background:#191b25;border:1px solid #353747;border-radius:18px;margin:24px 0;padding:26px;scroll-margin-top:24px}.badge{font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:#d6caff}.meta{font-size:14px;color:#aaaabb}.player{margin:18px 0}.player-label{display:flex;flex-wrap:wrap;align-items:center;gap:8px 16px;font-size:14px}.player-label span{color:#aaaabb;font-size:12px}.player-label a{margin-left:auto}audio{width:100%;margin-top:8px}.downloads{padding:14px 0;border-top:1px solid #353747;font-size:14px}details{border-top:1px solid #353747;padding:15px 0 0;margin-top:14px}summary{cursor:pointer;color:#d9d9e4}.stem-grid{padding:14px 0;font-size:14px}details p{font-size:13px;overflow-wrap:anywhere}.empty{padding:30px;background:#191b25;border-radius:14px}footer{margin-top:36px;font-size:13px;color:#aaaabb}@media(max-width:600px){body{padding:24px 14px 60px}article{padding:18px}.player-label a{margin-left:0}}</style>
<header><p class="badge">ishmakethebeat</p><h1>'''+escape(title)+'''</h1><p>'''+escape(description)+'''</p><nav>'''+nav+'''</nav></header><main>'''+content+'''</main><footer>'''+" · ".join(links)+'''</footer>
<script>document.addEventListener('play',event=>{if(event.target.tagName==='AUDIO'){document.querySelectorAll('audio').forEach(other=>{if(other!==event.target)other.pause()})}},true)</script></html>'''
    output.parent.mkdir(parents=True,exist_ok=True);output.write_text(page)
    result={"createdAt":datetime.now(timezone.utc).isoformat(),"manifest":{"path":str(args.manifest.resolve()),"sha256":sha(args.manifest)},
        "output":{"path":str(output),"sha256":sha(output)},"qaFixtureOnly":args.allow_short_fixtures,"included":included,"skipped":skipped}
    output.with_suffix(".build.json").write_text(json.dumps(result,indent=2)+"\n")
    print(json.dumps({"included":len(included),"skipped":skipped,"output":str(output)}))


if __name__=="__main__":main()
