import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { BAR, clone, isDrum, seconds } from "../src/engine/schema";
import type { Project, SampleAsset } from "../src/engine/schema";
import { score, totalTicks, vocalEventIssues } from "../src/engine/score";
import { loopBeat } from "../src/io/loop-beat";
import { validateProject, missingAssets } from "../src/io/persistence";
import { renderDurationSeconds } from "../src/io/export";
import { parseDeliveryManifest } from "../src/io/delivery-plan";
const version="different-melodies-v1";
const created="2026-10-16T19:24:04.000Z";
const basePath="deliverables/finished-beats/projects/v2-source-tag/night-wire.ish.json";
const cataloguePath="deliverables/audio-research/extra-loop-kit-catalogue.json";
const numericalPath="deliverables/audio-research/loop-numerical-support-v1.json";
const sha=(v:Uint8Array|string)=>createHash('sha256').update(v).digest('hex');
const pretty=(v:unknown)=>`${JSON.stringify(v,null,2)}\n`;
async function immutable(file:string,data:Uint8Array|string){
 const bytes=Buffer.from(data);await fs.mkdir(path.dirname(file),{recursive:true});
 const temporary=`${file}.pending-${process.pid}`;
 try{const h=await fs.open(temporary,'wx');try{await h.writeFile(bytes);await h.sync();}finally{await h.close();}
 try{await fs.link(temporary,file);}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;if(!(await fs.readFile(file)).equals(bytes))throw new Error(`Frozen artifact differs: ${file}`);}}
 finally{await fs.rm(temporary,{force:true});}
}
interface SourceFile {originalFilename:string;path:string;sha256:string;bytes:number;extension:string;perFileCredits:{names:string[];basis:string};filenameHints:{tempoBpm:number|null;key:string|null};}
interface SourceKit {id:string;archive:string;creator:string;creditBasis:string;termsSummary:string;sourceDocuments:{path:string;sha256?:string;text?:string}[];files:SourceFile[];}
const catalogue:{kits:SourceKit[]}=JSON.parse(await fs.readFile(cataloguePath,'utf8'));
const numerical=JSON.parse(await fs.readFile(numericalPath,'utf8'));
const baseBytes=await fs.readFile(basePath),baseHash=sha(baseBytes);
const base:Project=validateProject(JSON.parse(baseBytes.toString('utf8')));
const identityEvent=base.vocalEvents?.find(v=>v.id==='ish-identity-pickup');
if(!identityEvent)throw new Error('Original ish identity event missing');
const identityAsset=base.assets.find(a=>a.id===identityEvent.assetId)!;
const specs=[
 {id:'glitch-bloom',title:'Glitch Bloom',seed:'GLITCH-BLOOM-147-01',kit:'neptune',token:'glitchcore',analysisId:'loop-screen-12',bpm:147,key:9,mode:'major' as const,keyBasis:'Working A major; C-sharp minor is an alternate numerical reading. Source harmony remains unverified.',response:'deliverables/audio-research/google-studio-loop-reel03-lite-response.txt',label:'B',observation:'High crystalline bell-like melody with airy supporting texture; sharp attack and moderate sustain. Model observation from actual source audition, not a preset identification.'},
 {id:'juicy-glass',title:'Juicy Glass',seed:'JUICY-GLASS-149-02',kit:'carti-type',token:'juicy',analysisId:'loop-screen-16',bpm:149,key:11,mode:'minor' as const,keyBasis:'Working B minor; relative D major is nearly tied in numerical evidence. Source harmony remains unverified.',response:'deliverables/audio-research/google-studio-loop-reel04-lite-response.txt',label:'A',observation:'Bright upper-register bell/mallet-like arpeggio with fast attack and decay. Model observation from actual source audition; register-change details remain uncertain.'},
 {id:'promo-static',title:'Promo Static',seed:'PROMO-STATIC-145-03',kit:'deyflo-january',token:'promo_145',analysisId:'loop-screen-19',bpm:145,key:9,mode:'minor' as const,keyBasis:'Working A minor; E minor is an alternate numerical reading. Source harmony remains unverified.',response:'deliverables/audio-research/google-studio-loop-reel04-lite-response.txt',label:'D',observation:'Upper chiptune-like riff with snappy attack/decay and repeating harmonic backing. Model observation from actual source audition, not a decoded instrument preset.'},
];
const records=[];
for(const spec of specs){
 const kit=catalogue.kits.find(k=>k.id===spec.kit)!;
 const matches=kit.files.filter(f=>f.originalFilename.toLowerCase().includes(spec.token));
 if(matches.length!==1)throw new Error(`Ambiguous source ${spec.token}`);
 const file=matches[0], original=await fs.readFile(file.path);
 if(original.length!==file.bytes||sha(original)!==file.sha256)throw new Error(`Source catalogue mismatch ${file.path}`);
 const numeric=numerical.sources.find((x:{id:string})=>x.id===spec.analysisId);
 if(!numeric||numeric.source.sha256!==file.sha256)throw new Error(`Numeric evidence source mismatch ${spec.id}`);
 const native=numeric.source;
 const chosenGrid=numeric.tempo.gridHypothesisChecks.find((g:{bpmHypothesis:number})=>g.bpmHypothesis===spec.bpm);
 if(!chosenGrid)throw new Error(`Missing exact native grid hypothesis ${spec.id}`);
 const terms=[kit.termsSummary,...kit.sourceDocuments.map(d=>`Source document: ${d.path}\nSHA-256: ${d.sha256??'not supplied'}\n${d.text??'Original document retained in source pack'}`)].join('\n\n');
 const creator=file.perFileCredits.names.join(' + ')||kit.creator;
 const asset:SampleAsset={id:`sample-${file.sha256.slice(0,16)}-loop`,name:file.originalFilename,originalFilename:file.originalFilename,data:`data:${file.extension==='.mp3'?'audio/mpeg':'audio/wav'};base64,${original.toString('base64')}`,role:'loop',root:60,tuning:0,trimStart:0,trimEnd:native.durationSeconds,duration:native.durationSeconds,gain:1,choke:'',envelopeMode:'gated',loop:false,envelope:{attack:.004,decay:.015,sustain:1,release:.006},license:terms,sourceId:file.path,source:`Creator: ${creator}\nCredit basis: ${file.perFileCredits.basis}\n${kit.creditBasis}\nNative metadata from full original FFmpeg decode, not MP3 container duration alone.`,hash:file.sha256,sampleRate:native.sampleRate,channels:native.channels,rootConfidence:0,manualOverride:false};
 const source={filename:file.originalFilename,path:file.path,sha256:file.sha256,creator,creditBasis:`${file.perFileCredits.basis}. Pack: ${kit.archive}; ${kit.creditBasis}`,terms,filenameBpm:file.filenameHints.tempoBpm,filenameKey:file.filenameHints.key};
 const p=loopBeat(base,asset,source,{sourceStart:0,beats:32,nativeBpm:spec.bpm},{key:spec.key,mode:spec.mode,seed:spec.seed});
 p.title=spec.title;p.created=created;p.selected=0;
 // The same saved first-listen sparsity rule as Night Wire; no per-song hand-authored MIDI.
 for(const candidate of p.candidates){const hat=candidate.tracks.find(t=>t.id==='hat')!;hat.notes=hat.notes.filter(n=>n.tick%240===0&&n.duration>=32);candidate.metrics.reasons.push(spec.keyBasis);}
 for(const clip of p.clips??[]){clip.provenance.keyEstimate=spec.keyBasis;clip.provenance.keyConfidence=0;clip.provenance.credit+=`\nActual supplied source heard in Google audio reel ${spec.response}, label ${spec.label}, initial20seconds. ${spec.observation}\nNative ${spec.bpm} BPM is a working grid: numeric sixteenth proxy deviation ${chosenGrid.weightedGridDeviationSeconds} seconds; this is not an auditory downbeat proof. Initial32beats only, not the whole file or its long tail. ${spec.keyBasis}`;}
 const tag=clone(identityEvent),intro=p.sections.find(s=>s.kind==='intro')!;
 tag.placement={kind:'section',sectionId:intro.id,tick:Math.max(0,intro.bars*BAR-BAR)};
 p.vocalEvents=[tag];p.tagEnabled=true;p.voxEnabled=false;p.tagAsset=undefined;
 // Embed only this source, original ish identity and the actual selected support palette.
 const used=new Set([...p.candidates.flatMap(c=>c.tracks.map(t=>t.instrument)),asset.id,identityAsset.id]);
 p.assets=p.assets.filter(a=>used.has(a.id));
 if(!p.assets.some(a=>a.id===identityAsset.id))p.assets.push(clone(identityAsset));
 if(p.assets.some(a=>a.id==='sample-tag-4730193935446576'||a.id==='sample-loop-6278d2e14f1ee60d'))throw new Error('Unrelated lilfrus loop/tag leaked into a different-source project');
 validateProject(p);
 if(missingAssets(p).length||vocalEventIssues(p).length)throw new Error(`Missing audio in ${spec.id}`);
 const events=score(p);
 if(events.some(e=>!['loop','tag','bass'].includes(e.role)&&!isDrum(e.role)))throw new Error('Generated upper-melody overlay');
 const assets=p.assets.map(a=>{const bytes=Buffer.from(a.data.split(',')[1],'base64');const hash=sha(bytes);if(a.hash&&a.hash!==hash)throw new Error(`Embedded source altered: ${a.name}`);return{id:a.id,name:a.name,bytes:bytes.length,sha256:hash};});
 if(seconds(totalTicks(p),p.settings.bpm)<90||renderDurationSeconds(p)>150)throw new Error(`Arrangement outside requested range ${spec.id}`);
 const filePath=`deliverables/finished-beats/projects/${version}/${spec.id}.ish.json`, data=pretty(p);
 await immutable(filePath,data);
 records.push({id:spec.id,title:spec.title,seed:spec.seed,projectPath:filePath,sha256:sha(data),bytes:Buffer.byteLength(data),source:{path:file.path,sha256:file.sha256,nativeMetadata:native,originalBytesPreserved:true,creator,terms},sourceRegion:{startSeconds:0,endSeconds:32*60/spec.bpm,beats:32,bpm:spec.bpm,downbeatVerified:false,workingKey:spec.keyBasis},audioEvidence:{path:spec.response,sha256:sha(await fs.readFile(spec.response)),reelLabel:spec.label,sourceRangeSeconds:[0,20],provisionalObservation:spec.observation},gridEvidence:chosenGrid,musicDurationSeconds:seconds(totalTicks(p),p.settings.bpm),renderDurationSeconds:renderDurationSeconds(p),frames:Math.ceil(renderDurationSeconds(p)*44100),sections:p.sections,identityEvent:tag,identityStartSeconds:seconds(tag.placement.tick,p.settings.bpm),assets,candidates:p.candidates.map(c=>({id:c.id,groove:c.groove,noteHash:sha(JSON.stringify(c.tracks.map(t=>({role:t.id,notes:t.notes})))),roles:c.tracks.map(t=>({role:t.id,notes:t.notes.length}))})),noLilfrusTag:true});
 if(sha(await fs.readFile(file.path))!==file.sha256)throw new Error('Original source changed during authoring');
}
if(new Set(records.map(r=>r.source.sha256)).size!==3||new Set(records.map(r=>r.seed)).size!==3||new Set(records.map(r=>r.candidates[0].noteHash)).size!==3)throw new Error('Examples must have three different source melodies and generated support seeds');
const manifest={schemaVersion:1,runId:'different-melodies-v1-post-yield',jobs:records.map(r=>({id:r.id,projectUrl:`/${r.projectPath}`,expectedSha256:r.sha256}))};
parseDeliveryManifest(Buffer.from(pretty(manifest)));
await immutable('deliverables/finished-beats/different-melodies-v1-manifest.json',pretty(manifest));
for(const job of manifest.jobs)await immutable(`deliverables/finished-beats/${job.id}-v1-manifest.json`,pretty({...manifest,runId:`${job.id}-v1-post-yield`,jobs:[job]}));
if(sha(await fs.readFile(basePath))!==baseHash)throw new Error('Night Wire source changed during authoring');
const dependencies=await Promise.all([basePath,cataloguePath,numericalPath,'src/io/loop-beat.ts','src/io/loop-foundation.ts','src/io/export.ts','scripts/author-different-loop-beats.ts'].map(async p=>({path:p,sha256:sha(await fs.readFile(p))})));
await immutable(`deliverables/finished-beats/authoring/${version}/authoring-record.json`,pretty({schemaVersion:1,version,createdAt:created,status:'different_actual_source_melodies_prepared_render_and_listening_pending',base:{path:basePath,sha256:baseHash},dependencies,records,identityIntelligibilityUncertain:true,sourceKeyAndDownbeatVerified:false,browserRendered:false,musicalApproval:false}));
console.log(pretty({status:'three_different_sample_beats_ready',manifest:'/deliverables/finished-beats/different-melodies-v1-manifest.json',records:records.map(({id,title,seed,projectPath,sha256,renderDurationSeconds,sourceRegion,assets})=>({id,title,seed,projectPath,sha256,renderDurationSeconds,sourceRegion,embeddedAssets:assets.length}))}));
