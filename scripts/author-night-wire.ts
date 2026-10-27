import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { BAR, clone, isDrum, seconds } from "../src/engine/schema";
import type { Project, SampleAsset, VocalEvent } from "../src/engine/schema";
import { score, totalTicks, vocalEventIssues } from "../src/engine/score";
import { loopBeat } from "../src/io/loop-beat";
import { validateProject, missingAssets } from "../src/io/persistence";
import { renderDurationSeconds } from "../src/io/export";
import { parseDeliveryManifest } from "../src/io/delivery-plan";

// A frozen first-listen recipe. Further production revisions use another version/output tree.
const VERSION = "v1-before";
const CREATED = "2026-10-16T19:11:20.000Z";
const basePath = "deliverables/character/loop/project.ish.json";
const bankPath = "private-assets/loop10-bank.json";
const metadataPath = "private-assets/loop10-metadata.json";
const tagPath = "private-assets/audio-research/identity-tag/ishmakethebeat-daniel-original.wav";
const tagProvenancePath = "private-assets/audio-research/identity-tag/provenance.json";
const outputRoot = `deliverables/finished-beats/projects/${VERSION}`;
const reportRoot = `deliverables/finished-beats/authoring/${VERSION}`;
const sha = (v: Uint8Array | string) => createHash("sha256").update(v).digest("hex");
const pretty = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;
async function immutable(file: string, data: Uint8Array | string) {
  const bytes = Buffer.from(data);
  await fs.mkdir(path.dirname(file), { recursive: true });
  try { await fs.writeFile(file, bytes, { flag: "wx" }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (!(await fs.readFile(file)).equals(bytes)) throw new Error(`Refusing to change frozen artifact ${file}; use another version.`);
  }
}
function wavInfo(bytes: Buffer) {
  if (bytes.toString("ascii",0,4)!=="RIFF"||bytes.toString("ascii",8,12)!=="WAVE") throw new Error("Identity source is not WAV");
  let sampleRate=0, channels=0, blockAlign=0, frames=0;
  for(let at=12;at+8<=bytes.length;) {
    const tag=bytes.toString("ascii",at,at+4), size=bytes.readUInt32LE(at+4);
    if(at+8+size>bytes.length) throw new Error("Truncated WAV chunk");
    if(tag==="fmt ") { channels=bytes.readUInt16LE(at+10);sampleRate=bytes.readUInt32LE(at+12);blockAlign=bytes.readUInt16LE(at+20); }
    if(tag==="data") frames=size/blockAlign;
    at+=8+size+(size%2);
  }
  if(!sampleRate||!channels||!Number.isInteger(frames)||frames<=0) throw new Error("Invalid native WAV frame metadata");
  return { sampleRate, channels, frames, duration:frames/sampleRate };
}

const baseBytes=await fs.readFile(basePath), baseHash=sha(baseBytes);
const base=validateProject(JSON.parse(baseBytes.toString("utf8")));
const metadata=JSON.parse(await fs.readFile(metadataPath,"utf8"));
const sourceBytes=await fs.readFile(metadata.sourcePath);
const bank:SampleAsset[]=JSON.parse(await fs.readFile(bankPath,"utf8"));
const sourceAsset=bank.find(a=>a.role==="loop"&&a.hash===metadata.hash);
if(!sourceAsset||sha(sourceBytes)!==metadata.hash||!Buffer.from(sourceAsset.data.split(',')[1],'base64').equals(sourceBytes)) throw new Error("Loop original/bank/hash mismatch");
// Match the new native library-import path rather than applying the old asset's extra 0.56 gain.
const loopAsset:SampleAsset={...clone(sourceAsset),gain:1,root:60,tuning:0,envelopeMode:"gated",loop:false,envelope:{attack:.004,decay:.015,sustain:1,release:.006}};
const tagBytes=await fs.readFile(tagPath), tagHash=sha(tagBytes), tagInfo=wavInfo(tagBytes);
const tagProvenance=JSON.parse(await fs.readFile(tagProvenancePath,"utf8"));
if(!tagProvenance.files.some((f:{sha256:string})=>f.sha256===tagHash)) throw new Error("Identity source does not match its original speech provenance");
const identity:SampleAsset={id:`identity-ish-${tagHash.slice(0,16)}`,name:"ishmakethebeat · original spoken identity",originalFilename:path.basename(tagPath),data:`data:audio/wav;base64,${tagBytes.toString('base64')}`,role:"tag",root:60,tuning:0,trimStart:0,trimEnd:tagInfo.duration,duration:tagInfo.duration,gain:1,choke:"",envelopeMode:"one-shot",loop:false,license:"Original user-requested tag text; locally rendered using the installed macOS Daniel voice. No supplied producer identity is relabelled.",sourceId:tagPath,source:JSON.stringify(tagProvenance),hash:tagHash,sampleRate:tagInfo.sampleRate,channels:tagInfo.channels,rootConfidence:0};
const source={filename:metadata.originalFilename,path:metadata.sourcePath,sha256:metadata.hash,creator:"@lilfrus (source filename attribution)",creditBasis:"Supplied stash kit loop, credited @lilfrus in its original filename. USE TAG!! requirement retained; source producer-tag selection/placement still pending audition in this first-listen draft.",terms:sourceAsset.license+"; USE TAG!! requested by original source filename. This draft is not finalized or released.",filenameBpm:155,filenameKey:null};
const region={sourceStart:0,beats:32,nativeBpm:155};
const variants=[{id:"night-wire",title:"Night Wire",seed:"NIGHT-WIRE-01"},{id:"night-wire-seed02",title:"Night Wire · seed 02",seed:"NIGHT-WIRE-02"},{id:"night-wire-seed03",title:"Night Wire · seed 03",seed:"NIGHT-WIRE-03"},{id:"night-wire-seed04",title:"Night Wire · seed 04",seed:"NIGHT-WIRE-04"}];
const records=[];
for(const variant of variants) {
  const p:Project=loopBeat(base,loopAsset,source,region,{key:0,mode:"minor",seed:variant.seed});
  p.title=variant.title;
  p.created=CREATED;
  p.assets=[...p.assets.filter(a=>a.id!==identity.id),clone(identity)];
  p.settings.listeningGainDb=0;
  p.selected=0;
  for(const c of p.candidates) {
    // One reusable sparsity rule for every seed, driven by the auditioned loop's busy internal rhythm.
    // Keep written quarter/eighth-grid hats and omit the generated short roll embellishments.
    const hat=c.tracks.find(t=>t.id==="hat")!;
    hat.notes=hat.notes.filter(n=>n.tick%240===0 && n.duration>=32);
    c.metrics.reasons.push("First-listen production: busy supplied synth phrase is the sole melody; omit short hat-roll embellishments. C-minor support is a working basis, ambiguous relative to E-flat major.");
  }
  for(const clip of p.clips??[]) {
    clip.provenance.keyEstimate="Working C minor / E-flat major ambiguous; C-root/fifth bass basis for listening comparison, not verified harmony";
    clip.provenance.keyConfidence=0;
    clip.provenance.credit += "\nPending: audition and add the required source producer-credit tag. This first-listen version contains only the separately credited original ishmakethebeat tag.";
  }
  const intro=p.sections.find(s=>s.kind==="intro")!;
  const tag:VocalEvent={id:"ish-identity-pickup",name:"ishmakethebeat · original pickup",assetId:identity.id,role:"tag",enabled:true,placement:{kind:"section",sectionId:intro.id,tick:Math.max(0,intro.bars*BAR-BAR)},duration:BAR,sourceOffset:0,sourceDuration:tagInfo.duration,gain:.30,pan:0,pitch:-2,reverse:false,mode:"one-shot",fadeIn:.004,fadeOut:.035,filter:{highpass:180,lowpass:7500},effects:{delay:{division:.5,feedback:.16,wet:.12,cutoff:4200,pingPong:true},reverb:{wet:.06,decay:.55,preDelay:.018}},overlap:"choke-group",chokeGroup:"ish-identity",provenance:{sourceName:path.basename(tagPath),sourceHash:tagHash,creator:tagProvenance.creator,credit:"Original ishmakethebeat identity text, rendered locally by macOS say / Daniel / 178 words per minute. Separate from the loop author's identity. Musical treatment is an editable first-listen choice."}};
  p.tagAsset=undefined;p.tagEnabled=true;p.voxEnabled=false;p.vocalEvents=[tag];
  validateProject(p);
  const missing=missingAssets(p), issues=vocalEventIssues(p);
  if(missing.length||issues.length) throw new Error(`Unresolved project references: ${JSON.stringify({missing,issues})}`);
  const events=score(p);
  if(events.some(e=>!['loop','tag','bass'].includes(e.role)&&!isDrum(e.role))) throw new Error("Unexpected generated upper voice");
  const bytes=pretty(p), file=`${outputRoot}/${variant.id}.ish.json`;
  await immutable(file,bytes);
  const assets=p.assets.map(a=>{const data=Buffer.from(a.data.split(',')[1],'base64');if(a.hash&&sha(data)!==a.hash)throw new Error(`Embedded bytes changed: ${a.id}`);return{id:a.id,sha256:sha(data),bytes:data.length};});
  let offset=0;
  const sections=p.sections.map(s=>{const result={...s,startSeconds:seconds(offset,p.settings.bpm),endSeconds:seconds(offset+s.bars*BAR,p.settings.bpm)};offset+=s.bars*BAR;return result;});
  records.push({id:variant.id,title:variant.title,seed:variant.seed,projectPath:file,sha256:sha(bytes),bytes:Buffer.byteLength(bytes),musicDurationSeconds:seconds(totalTicks(p),p.settings.bpm),renderDurationSeconds:renderDurationSeconds(p),frames:Math.ceil(renderDurationSeconds(p)*44100),sections,clips:p.clips,tagEvent:tag,tagStartSeconds:seconds(tag.placement.tick,p.settings.bpm),tagSourceSeconds:tagInfo.duration,tagPlaybackSeconds:tagInfo.duration/2**(tag.pitch/12),support:candidateSummary(p),assets});
}
function candidateSummary(p:Project) { return p.candidates.map(c=>({id:c.id,groove:c.groove,roles:c.tracks.filter(t=>t.id==='bass'||isDrum(t.id)).map(t=>({role:t.id,instrument:t.instrument,assetName:p.assets.find(a=>a.id===t.instrument)?.name,volume:t.volume,notes:t.notes.length,noteSha256:sha(JSON.stringify(t.notes)),effects:t.effects}))})); }
for(const group of [{name:"night-wire-v1-before",records:[records[0]]},{name:"night-wire-seeds-v1",records:records.slice(1)},{name:"night-wire-all-v1",records}]) {
  const manifest={schemaVersion:1,runId:`${group.name}-delivery`,jobs:group.records.map(r=>({id:r.id,projectUrl:`/${r.projectPath}`,expectedSha256:r.sha256}))};
  parseDeliveryManifest(Buffer.from(pretty(manifest)));
  await immutable(`deliverables/finished-beats/${group.name}-manifest.json`,pretty(manifest));
}
const dependencies=[basePath,bankPath,metadataPath,tagPath,tagProvenancePath,"src/io/loop-beat.ts","src/io/loop-foundation.ts","scripts/author-night-wire.ts","deliverables/audio-research/google-studio-loop-reel02-pro-controlled-response.txt"];
const dependencyHashes=await Promise.all(dependencies.map(async file=>({path:file,sha256:sha(await fs.readFile(file))})));
if(sha(await fs.readFile(basePath))!==baseHash)throw new Error("Original palette project changed during authoring");
await immutable(`${reportRoot}/authoring-record.json`,pretty({schemaVersion:1,status:"first_listen_draft_render_and_revision_pending",createdAt:CREATED,version:VERSION,basePalette:{path:basePath,sha256:baseHash},basis:{actualAudioResponse:"deliverables/audio-research/google-studio-loop-reel02-pro-controlled-response.txt",excerpt:"E",selectedLoop:metadata.sourcePath,interpretation:"Buzzy mid-high sequenced synth with fast attack/quick decay and dense internal rhythm; no additional upper melody. Response is a model observation, not perfect judgment.",workingKey:"C minor; numerical evidence ambiguous with E-flat major; unverified",sourceProducerTag:"USE TAG!! retained; source tag/vox selection pending audition"},dependencies:dependencyHashes,records,browserRendered:false,musicalApproval:false}));
console.log(pretty({status:"projects_prepared_not_rendered",version:VERSION,firstManifest:"/deliverables/finished-beats/night-wire-v1-before-manifest.json",seedManifest:"/deliverables/finished-beats/night-wire-seeds-v1-manifest.json",records:records.map(({id,sha256,projectPath,musicDurationSeconds,renderDurationSeconds})=>({id,sha256,projectPath,musicDurationSeconds,renderDurationSeconds}))}));
