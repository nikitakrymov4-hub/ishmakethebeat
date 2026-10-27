import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { BAR, clone, seconds } from "../src/engine/schema";
import type { Project, SampleAsset, VocalEvent } from "../src/engine/schema";
import { score, totalTicks, vocalEventIssues } from "../src/engine/score";
import { validateProject, missingAssets } from "../src/io/persistence";
import { renderDurationSeconds } from "../src/io/export";
import { parseDeliveryManifest } from "../src/io/delivery-plan";
const version="v2-source-tag";
const sha=(v:Uint8Array|string)=>createHash('sha256').update(v).digest('hex');
const pretty=(v:unknown)=>`${JSON.stringify(v,null,2)}\n`;
async function immutable(file:string,data:Uint8Array|string) {
 const bytes=Buffer.from(data); await fs.mkdir(path.dirname(file),{recursive:true});
 const temporary=`${file}.pending-${process.pid}`;
 try {
   const handle=await fs.open(temporary,"wx");
   try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
   try { await fs.link(temporary,file); }
   catch(e) { if((e as NodeJS.ErrnoException).code!=="EEXIST")throw e; if(!(await fs.readFile(file)).equals(bytes))throw new Error(`Frozen file differs: ${file}`); }
 } finally { await fs.rm(temporary,{force:true}); }
}
const bank:SampleAsset[]=JSON.parse(await fs.readFile('private-assets/loop10-bank.json','utf8'));
const tag=bank.find(a=>a.hash==='4730193935446576fba525760620e7691976ac5a97f337f0086290b29d781a10');
if(!tag)throw new Error('Auditioned TAG1 missing');
const native=await fs.readFile(tag.source!);
if(sha(native)!==tag.hash||!Buffer.from(tag.data.split(',')[1],'base64').equals(native))throw new Error('TAG1 original source/hash mismatch');
const ids=['night-wire','night-wire-seed02','night-wire-seed03','night-wire-seed04'];
const records=[];
for(const id of ids){
 const beforePath=`deliverables/finished-beats/projects/v1-before/${id}.ish.json`;
 const before=await fs.readFile(beforePath);
 const p:Project=validateProject(JSON.parse(before.toString('utf8')));
 p.assets=[...p.assets.filter(a=>a.id!==tag.id),clone(tag)];
 const sourceTag:VocalEvent={id:'source-credit-lilfrus-tag1',name:'Source credit · supplied @lilfrus TAG 1',assetId:tag.id,role:'tag',enabled:true,placement:{kind:'absolute',tick:480},duration:BAR,sourceOffset:0,sourceDuration:tag.duration!,gain:.9,pan:0,pitch:0,reverse:false,mode:'one-shot',fadeIn:.004,fadeOut:.025,overlap:'allow',provenance:{sourceName:tag.originalFilename??tag.name,sourceHash:tag.hash!,creator:'@lilfrus (source filename attribution)',credit:'Original LOOP 10 filename requests USE TAG!!. Supplied TAG 1 from the same creator-labelled source folder is included once near the opening. Actual audio audition described a short intimate/whispered spoken phrase; speaker identity is unverified. This is source credit, never labelled as the ishmakethebeat identity.'}};
 p.vocalEvents=[sourceTag,...p.vocalEvents??[]];
 p.tagEnabled=true;p.voxEnabled=false;
 for(const clip of p.clips??[]){
  clip.provenance.credit=clip.provenance.credit.replace('USE TAG!! requirement retained; source producer-tag selection/placement still pending audition in this first-listen draft.','USE TAG!! requirement retained; the auditioned supplied TAG 1 is included once as a separate source-credit event.').replace('Pending: audition and add the required source producer-credit tag. This first-listen version contains only the separately credited original ishmakethebeat tag.','Source-credit TAG 1 is included once at opening beat 1 (zero-based), separate from the original ishmakethebeat identity pickup. No additional supplied vox chosen.');
 }
 const identity=p.vocalEvents.find(v=>v.id==='ish-identity-pickup')!;
 identity.provenance.credit+=' Actual audio-model intelligibility response was “H make the beat”; exact spelling of ish remains uncertain. Dry speech and current treatment retained for the first full-mix comparison; no claim of perfect pronunciation.';
 validateProject(p);if(missingAssets(p).length||vocalEventIssues(p).length)throw new Error('Unresolved source/placement');
 const output=`deliverables/finished-beats/projects/${version}/${id}.ish.json`, data=pretty(p);
 await immutable(output,data);
 records.push({id,projectPath:output,sha256:sha(data),before:{path:beforePath,sha256:sha(before)},seed:p.settings.seed,musicDurationSeconds:seconds(totalTicks(p),p.settings.bpm),renderDurationSeconds:renderDurationSeconds(p),vocalEvents:p.vocalEvents,eventCount:score(p).length});
}
for(const group of [{name:'night-wire-v2-source-tag',items:[records[0]]},{name:'night-wire-seeds-v2',items:records.slice(1)},{name:'night-wire-all-v2',items:records}]){
 const manifest={schemaVersion:1,runId:`${group.name}-delivery`,jobs:group.items.map(r=>({id:r.id,projectUrl:`/${r.projectPath}`,expectedSha256:r.sha256}))};
 parseDeliveryManifest(Buffer.from(pretty(manifest)));
 await immutable(`deliverables/finished-beats/${group.name}-manifest.json`,pretty(manifest));
}
await immutable(`deliverables/finished-beats/authoring/${version}/revision-record.json`,pretty({schemaVersion:1,version,status:'first_full_mix_preview_pending',changes:['Added auditioned source-credit TAG1 at beat1/155BPM (0.387096774s), original bytes unchanged; event gain .9 times preserved asset gain .25 = .225 before graph/master.','Original ish identity retained at intro final bar (4.64516129s), separate provenance; intelligibility uncertain from actual model response.','No new supplied vox, engine changes, extra melody, bass/drum edits or gain changes.'],sourceTag:{originalPath:tag.source,sha256:tag.hash,duration:tag.duration,nativeSampleRate:tag.sampleRate,channels:tag.channels},records,browserRendered:false,musicalApproval:false}));
console.log(pretty({status:'ready_for_first_full_mix',manifest:'/deliverables/finished-beats/night-wire-v2-source-tag-manifest.json',firstOutput:'/deliverables/benchmark-delivery/night-wire-v2-source-tag-delivery/night-wire/mix.wav',seedManifest:'/deliverables/finished-beats/night-wire-seeds-v2-manifest.json',records:records.map(({id,projectPath,sha256,renderDurationSeconds})=>({id,projectPath,sha256,renderDurationSeconds}))}));
