import fs from "node:fs";
import crypto from "node:crypto";
import {loadAuraPalette} from "../src/io/aura-bank";
import {newAuraProject} from "../src/engine/aura-writing";
import {defaultSettings} from "../src/engine/profiles";
import {getPrivatePalette} from "../src/engine/culture";
import {score,totalTicks} from "../src/engine/score";
import {seconds,clone} from "../src/engine/schema";
import {validateProject} from "../src/io/persistence";
import {exportMidi} from "../src/io/midi";
const out="deliverables/aura-originals-20261016",qa="qa-artifacts/aura-originals-20261016";
const localFetch=(async(url:string|URL|Request)=>{const path=decodeURIComponent(String(url)).slice(1);return fs.existsSync(path)?new Response(new Uint8Array(fs.readFileSync(path))):new Response("missing",{status:404});}) as typeof fetch;
const variants=[{id:"daybreak",seed:"AURA-DAWN-137",key:5,palette:"piano-wind",direction:"cascade",feel:"interrupted"},{id:"nightline",seed:"AURA-NEON-284",key:1,palette:"synth-strings",direction:"angular",feel:"pulse"}] as const;
const rows=[];
for(const v of variants){
 const bank=await loadAuraPalette(v.palette,[],localFetch);
 const p=newAuraProject({...defaultSettings(),seed:v.seed,key:v.key,bpm:150,mode:"minor"},{version:1,palette:v.palette,direction:v.direction,feel:v.feel},bank.selection,[...bank.assets,...getPrivatePalette()]);
 p.title=v.id+" · original Aura draft";p.created="2026-10-17T01:34:00.000Z";
 const preview=clone(p);preview.title=v.id+" · 16-bar audition";preview.sections=[{id:"preview-main",name:"16-bar main / reply",bars:16,kind:"hook"}];
 for(const [suffix,project] of [["full",p],["preview",preview]] as const){
  validateProject(project);const name=v.id+"-"+suffix;
  fs.writeFileSync(out+"/"+name+".ish.json",JSON.stringify(project),{flag:"wx"});fs.writeFileSync(out+"/"+name+".mid",exportMidi(project),{flag:"wx"});
  const events=score(project);const notes=project.candidates[0].tracks.map(t=>({role:t.id,instrument:t.instrument,volume:t.volume,pan:t.pan,notes:t.notes}));
  fs.writeFileSync(qa+"/"+name+"-score.json",JSON.stringify(events),{flag:"wx"});
  rows.push({name,writing:project.auraOriginal,seed:v.seed,key:v.key,bpm:150,bars:project.sections.reduce((a,s)=>a+s.bars,0),musicalSeconds:seconds(totalTicks(project),150),tailSeconds:4,notes,sections:project.sections,scoreEvents:events.length,scoreSha256:crypto.createHash("sha256").update(JSON.stringify(events)).digest("hex"),sources:project.assets.map(({data,...a})=>a)});
 }
}
fs.writeFileSync(out+"/writing-and-source-manifest.json",JSON.stringify(rows,null,2),{flag:"wx"});
console.log(rows.map(r=>({name:r.name,music:r.musicalSeconds,events:r.scoreEvents})));
