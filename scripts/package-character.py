"""Package the actual local sound-character renders for private listening review."""
from pathlib import Path
import html
import json
import zipfile

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "deliverables" / "character"
GROUPS = [
 ("Accepted melody · before / after", [
  ("Preserved baseline · matched", "comparison/accepted-matched.wav"),
  ("Coordinated ensemble · same melody, matched", "comparison/ensemble-matched.wav")]),
 ("Hear the production enter · matched stages", [
  ("Melodic ensemble", "comparison/ensemble-only-matched.wav"),
  ("Ensemble + drums", "comparison/ensemble-drums-matched.wav"),
  ("Ensemble + drums + bass + pickup", "comparison/full-matched.wav")]),
 ("One original reverse pickup · matched", [
  ("Without the reversed source region", "comparison/full-without-reverse-matched.wav"),
  ("With the rendered / reversed / trimmed pickup", "comparison/full-reverse-matched.wav")]),
 ("Foreground lead · dry / processed", [
  ("Lead dry", "comparison/lead-dry-matched.wav"),
  ("Lead + automated stereo echo", "comparison/lead-treated-matched.wav")]),
 ("Hat identity · same sample and notes, matched", [
  ("Dry hat", "comparison/hat-dry-matched.wav"),
  ("Short echo / motion", "comparison/hat-echo-motion-matched.wav"),
  ("Grain / phase", "comparison/hat-grain-phase-matched.wav")]),
 ("Three sample combinations · exact same score, matched", [
  ("North round · Jazzfeezy / Clap2 / Lex", "comparison/palette-north-round-matched.wav"),
  ("North pitched · Plugg / RnB / HIHATS3", "comparison/palette-north-pitched-matched.wav"),
  ("Stash pocket · Classic Frus / Perc40 clap / hat", "comparison/palette-stash-pocket-matched.wav")]),
 ("Complete original-score instrumental", [("Woven glass · accepted melody · 1:48", "original/full.wav")]),
 ("Three additional original generated seeds", [(s, f"generated/{s}.wav") for s in ["WOVEN-127", "VELVET-304", "COPPER-892"]]),
 ("Direct supplied loop · matched production stages", [
  ("@lilfrus LOOP10 + source tag", "loop/loop-only-matched.wav"),
  ("Source + authored drums", "loop/loop-drums-matched.wav"),
  ("Source + drums + sparse provisional bass", "loop/full-excerpt-matched.wav")]),
 ("Complete supplied-loop production", [("@lilfrus LOOP10 · credited source · 1:43", "loop/full.wav")]),
 ("Supplied MIDI composition · imported, not generated", [("Cool Piano Thing · 146 notes · silent scale guide", "generated/supplied-midi.wav")]),
]
PROJECTS = [
 ("Accepted baseline", "baseline/accepted-project.ish.zip"),
 ("Same-phrase ensemble", "comparison/ensemble-project.ish.zip"),
 ("Full original project", "original/project.ish.zip"),
 ("Full supplied-loop project", "loop/project.ish.zip"),
 *[(s, f"generated/{s}.ish.zip") for s in ["WOVEN-127", "VELVET-304", "COPPER-892"]],
 ("Imported MIDI + silent guide", "generated/supplied-midi-and-silent-guide.ish.zip"),
]

def page(stems=True):
    sections = []
    for title, items in GROUPS:
        rows = "".join(f'<article><p>{html.escape(label)}</p><audio controls preload="metadata" aria-label="{html.escape(label)}" src="{file}"></audio><a href="{file}" download>WAV</a></article>' for label, file in items)
        sections.append(f'<section><h2>{html.escape(title)}</h2>{rows}</section>')
    links = " · ".join(f'<a href="{file}" download>{html.escape(label)}</a>' for label, file in PROJECTS)
    stemlinks = '<p>Aligned stems: <a href="original/aligned-stems.zip">original score</a> · <a href="loop/aligned-stems.zip">supplied-loop production</a></p>' if stems else '<p>Aligned stems are delivered separately from this listening pack.</p>'
    return f'''<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ishmakethebeat · sound character review</title><style>body{{font:16px/1.55 system-ui;background:#111b17;color:#d9e4d4;max-width:1000px;margin:auto;padding:32px 20px}}h1{{font-size:38px;line-height:1.15}}h2{{font-size:21px}}a{{color:#b8d99c}}section{{padding:20px 0;border-top:1px solid #344536}}article{{margin:18px 0;background:#1a2920;border-radius:8px;padding:14px}}article p{{margin:0 0 8px}}audio{{width:90%;vertical-align:middle}}small,.muted{{color:#9eae99}}</style></head><body><small>ISHMAKETHEBEAT · PRIVATE SOUND CHARACTER REVISION</small><h1>Hear what changed.</h1><p>The same 28-note melody, with a new ensemble and production. Comparisons match at −23 LUFS using reversible gain.</p><p>Start with the pair below, then explore the parts and both complete beats. These are candidates for your listening review.</p>{''.join(sections)}<section><h2>Editable portable projects</h2><p>{links}</p>{stemlinks}<p><a href="asset-list.json">Source/credit manifest</a> · <a href="REVISION.md">Changes & evidence</a> · <a href="comparison/matching-gains.json">Reversible listening gains</a></p><small>Loop10 uses actual @lilfrus audio from the supplied stash and preserves USE TAG!! with the creator-labelled tag at the opening. Its Cminor/E♭major estimate, downbeat and sparse bass placements need listening confirmation. Original-score and direct-loop projects are distinct. Imported scale guides are silent. Source kit redistribution rights remain unverified; this pack is for private review.</small></section><script>document.querySelectorAll('audio').forEach(a=>a.addEventListener('play',()=>document.querySelectorAll('audio').forEach(b=>{{if(b!==a)b.pause()}})))</script></body></html>'''

def main():
    required = {f for _, items in GROUPS for _, f in items} | {f for _, f in PROJECTS}
    required |= {"asset-list.json", "comparison/matching-gains.json", "verification/audio-measurements.json", "verification/project-integrity.json", "verification/character-audio.json", "verification/lifecycle.json", "verification/browser-workflow.json"}
    for f in required:
        assert (OUT / f).is_file() and (OUT / f).stat().st_size > 0, f"Missing {f}"
    (OUT / "REVISION.md").write_text((ROOT / "docs" / "CHARACTER-REVISION.md").read_text().replace("../deliverables/character/listen.html", "listen.html"))
    (OUT / "listen.html").write_text(page())
    for folder in ["original", "loop"]:
        files = sorted((OUT / folder).glob("stem-*.wav"))
        assert files, folder
        with zipfile.ZipFile(OUT / folder / "aligned-stems.zip", "w", zipfile.ZIP_DEFLATED, compresslevel=4) as z:
            for p in files: z.write(p, p.name)
            z.writestr("STEMS.txt", "44.1kHz stereo 24-bit PCM; every stem starts at score tick0 and includes4s tail. Tracks are post instrument/filter/insert/fader, pre master gain/protection. Shared echo/modulation/room is isolated in stem-fx.wav. Silent source-loop upper stems are intentional. MIDI contains notes, not source loop/reverse audio; use the portable project for complete playback.\n")
        with zipfile.ZipFile(OUT / folder / "aligned-stems.zip") as z: assert z.testzip() is None
    with zipfile.ZipFile(OUT / "listening-pack.zip", "w", zipfile.ZIP_DEFLATED, compresslevel=4) as z:
        for f in sorted(required): z.write(OUT / f, f)
        z.writestr("listen.html", page(False))
        z.write(OUT / "REVISION.md", "REVISION.md")
        z.writestr("START HERE.txt", "Unpack this archive and open listen.html in your browser. No dev server needed for listening. Import the .ish.zip files into the running local studio to edit scores, original source samples, effects, source regions and reverse operations. Aligned stem ZIPs are separate deliverables.\n")
    with zipfile.ZipFile(OUT / "listening-pack.zip") as z: assert z.testzip() is None
    info = {"listeningPackBytes":(OUT/"listening-pack.zip").stat().st_size,"audioFiles":len([f for f in required if f.endswith('.wav')]),"projects":len(PROJECTS),"stemCounts":{f:len(list((OUT/f).glob('stem-*.wav'))) for f in ['original','loop']}}
    (OUT/"verification"/"package-report.json").write_text(json.dumps(info,indent=2))
    print(json.dumps(info,indent=2))

if __name__ == "__main__": main()
