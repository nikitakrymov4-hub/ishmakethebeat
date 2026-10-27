import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { parseMidi } from "midi-file";

const base = "private-assets/stash-kit";
async function filesAt(dir) {
  return (await Promise.all((await fs.readdir(dir, { withFileTypes: true })).map(async e => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? await filesAt(p) : [p];
  }))).flat();
}
const files = await filesAt(base), midis = [], presets = [];
for (const source of files.filter(p => p.toLowerCase().endsWith(".mid"))) {
  const raw = await fs.readFile(source), midi = parseMidi(raw);
  const ppq = midi.header.ticksPerBeat;
  if (!ppq) throw new Error(`Unsupported SMPTE MIDI ${source}`);
  const factor = 480 / ppq, notes = [], names = [], tempos = [], meters = [];
  let unmatchedOff = 0, unmatchedOn = 0, sourceEnd = 0;
  for (const track of midi.tracks) {
    const pending = new Map();
    let tick = 0;
    for (const e of track) {
      tick += e.deltaTime;
      if (e.type === "trackName") names.push(e.text);
      if (e.type === "setTempo") tempos.push({ tick: tick * factor, bpm: 60e6 / e.microsecondsPerBeat });
      if (e.type === "timeSignature") meters.push({ tick: tick * factor, numerator: e.numerator, denominator: e.denominator });
      if (e.type === "noteOn" && e.velocity > 0) {
        const k = `${e.channel}:${e.noteNumber}`, queue = pending.get(k) ?? [];
        queue.push({ tick: tick * factor, pitch: e.noteNumber, velocity: e.velocity / 127 });
        pending.set(k, queue);
      }
      if (e.type === "noteOff" || e.type === "noteOn" && !e.velocity) {
        const k = `${e.channel}:${e.noteNumber}`, on = pending.get(k)?.shift();
        if (!on) { unmatchedOff++; continue; }
        const duration = tick * factor - on.tick;
        notes.push({ id: `supplied-${notes.length}`, ...on, duration });
        sourceEnd = Math.max(sourceEnd, tick * factor);
      }
    }
    for (const queue of pending.values()) unmatchedOn += queue.length;
  }
  notes.sort((a,b) => a.tick - b.tick || a.pitch - b.pitch);
  const guide = source.includes("/Scales/"), pitches = [...new Set(notes.map(n => n.pitch))].sort((a,b) => a-b);
  const row = {
    source, originalFilename:path.basename(source), hash:createHash("sha256").update(raw).digest("hex"),
    classification:guide ? "scale-guide" : "composed-phrase", sourcePPQ:ppq, targetPPQ:480,
    tempos, meters, trackNames:names, noteCount:notes.length, sourceEndTick:sourceEnd,
    sourceLengthBeats:sourceEnd / 480, pitchRange:[Math.min(...pitches),Math.max(...pitches)],
    pitchClasses:[...new Set(pitches.map(p=>p%12))].sort((a,b)=>a-b),
    positiveDurations:notes.every(n=>n.duration>0), unmatchedOn, unmatchedOff,
    playbackEnabled:!guide, notes,
  };
  if (guide) row.guide = { name:path.basename(source,".mid"), pitches, mask:row.pitchClasses, playbackEnabled:false };
  else {
    row.barNoteCounts = Array.from({length:8},(_,i)=>notes.filter(n=>n.tick>=i*1920&&n.tick<(i+1)*1920).length);
    row.provenance = "Editable supplied composition; not generated from scratch. A major / F-sharp minor pitch collection, tonic unverified. Track-name Xpand!2 is metadata, not an embedded instrument.";
    await fs.writeFile("private-assets/supplied-phrase.json",JSON.stringify(row,null,2));
  }
  midis.push(row);
}
for (const source of files.filter(p => p.endsWith(".fst"))) {
  const raw=await fs.readFile(source);
  const ascii=raw.toString("latin1").match(/[\x20-\x7e]{5,}/g)??[];
  const utf16=raw.toString("utf16le").match(/[\x20-\x7e]{5,}/g)??[];
  const utf16Odd=raw.subarray(1).toString("utf16le").match(/[\x20-\x7e]{5,}/g)??[];
  const strings=[...new Set([...ascii,...utf16,...utf16Odd])];
  presets.push({source,originalFilename:path.basename(source),hash:createHash("sha256").update(raw).digest("hex"),bytes:raw.length,
    moduleReferences:strings.filter(s=>/Fruity|Distructor|Effector|HalfTime|Parametric|Love Philter|Flangus|Convolver|Chorus|Reeverb|Soft Clipper|Squeeze/i.test(s)),
    legibleStrings:strings.filter(s=>s.length<200).slice(0,100),
    limitation:"Legible module references only. Exact parameter values, active/bypass state, order and routing are unverified. Browser cannot run FL effect-state files."});
}
await fs.writeFile("private-assets/stash-midi-catalogue.json",JSON.stringify(midis,null,2));
await fs.writeFile("private-assets/scale-guides.json",JSON.stringify(midis.filter(m=>m.classification==="scale-guide").map(({notes,...m})=>m),null,2));
await fs.writeFile("private-assets/stash-preset-evidence.json",JSON.stringify(presets,null,2));
console.log(JSON.stringify({midis:midis.length,guides:midis.filter(m=>m.classification==="scale-guide").length,presets:presets.length,phrase:(()=>{const {notes,...p}=midis.find(m=>m.classification==="composed-phrase");return p;})(),presetSummary:presets.map(({originalFilename,moduleReferences})=>({originalFilename,moduleReferences}))},null,2));
