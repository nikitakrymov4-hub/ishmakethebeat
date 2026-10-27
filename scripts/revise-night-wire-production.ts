import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {BAR, PPQ, clone, seconds, isDrum} from '../src/engine/schema';
import type {Project, SampleAsset, VocalEvent} from '../src/engine/schema';
import {score, totalTicks, vocalEventIssues} from '../src/engine/score';
import {validateProject, missingAssets} from '../src/io/persistence';
import {renderDurationSeconds} from '../src/io/export';
import {parseDeliveryManifest} from '../src/io/delivery-plan';

const version='v3-production', runId='night-wire-v3-production-post-yield';
const input='deliverables/finished-beats/projects/v2-source-tag/night-wire.ish.json';
const privateDir='private-assets/audio-research/night-wire-v3';
const ffmpeg='/opt/homebrew/bin/ffmpeg', ffprobe='/opt/homebrew/bin/ffprobe';
const sha=(value:Uint8Array|string)=>createHash('sha256').update(value).digest('hex');
const pretty=(value:unknown)=>`${JSON.stringify(value,null,2)}\n`;
async function immutable(file:string,data:Uint8Array|string){
 const bytes=Buffer.from(data);await fs.mkdir(path.dirname(file),{recursive:true});
 const temp=`${file}.pending-${process.pid}`;
 try{const handle=await fs.open(temp,'wx');try{await handle.writeFile(bytes);await handle.sync();}finally{await handle.close();}
 try{await fs.link(temp,file);}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;if(!(await fs.readFile(file)).equals(bytes))throw new Error(`Frozen output differs: ${file}`);}}
 finally{await fs.rm(temp,{force:true});}
}
function audioMetadata(file:string){
 const info=JSON.parse(execFileSync(ffprobe,['-v','error','-select_streams','a:0','-show_entries','stream=codec_name,sample_rate,channels,duration_ts,time_base','-of','json',file],{encoding:'utf8'})).streams[0];
 const rate=Number(info.sample_rate),frames=Number(info.duration_ts);
 if(info.time_base!==`1/${rate}`||!Number.isInteger(frames)||frames<1)throw new Error(`Non-native frame metadata: ${file}`);
 return {codec:info.codec_name,sampleRate:rate,channels:Number(info.channels),frames,durationSeconds:frames/rate};
}
const bytes=await fs.readFile(input),beforeHash=sha(bytes);
const before:Project=validateProject(JSON.parse(bytes.toString('utf8'))),p=clone(before);
const source=p.assets.find(a=>a.id==='sample-loop-6278d2e14f1ee60d')!;
if(!source?.source)throw new Error('Original source missing');
const sourceBytes=await fs.readFile(source.source);
if(sha(sourceBytes)!==source.hash||!Buffer.from(source.data.split(',')[1],'base64').equals(sourceBytes))throw new Error('Original source bytes changed');
const originalMetadata=audioMetadata(source.source),ffmpegVersion=execFileSync(ffmpeg,['-version'],{encoding:'utf8'}).split('\n')[0];
const derivativeRecords:unknown[]=[];
async function derived(id:string,filename:string,filter:string,expectedFrames:number){
 const output=`${privateDir}/${filename}`;await fs.mkdir(privateDir,{recursive:true});
 const temporary=`${output}.rendering-${process.pid}.wav`;
 const args=['-v','error','-nostdin','-y','-threads','1','-filter_threads','1','-i',source.source!,'-map','0:a:0','-af',filter,'-map_metadata','-1','-c:a','pcm_s24le','-fflags','+bitexact','-flags:a','+bitexact',temporary];
 let outputBytes:Buffer;
 try{execFileSync(ffmpeg,args,{stdio:'pipe'});outputBytes=await fs.readFile(temporary);}finally{await fs.rm(temporary,{force:true});}
 await immutable(output,outputBytes!);
 const native=audioMetadata(output),hash=sha(outputBytes!);
 if(native.sampleRate!==originalMetadata.sampleRate||native.channels!==originalMetadata.channels||native.frames!==expectedFrames)throw new Error('Unexpected derivative rate/channel/frame change');
 const command={executable:ffmpeg,arguments:[...args.slice(0,-1),output],executionOutputWasTemporary:true};
 const processing={sourcePath:source.source,sourceSHA256:source.hash,outputPath:output,outputSHA256:hash,renderId:`${runId}:${id}:${hash.slice(0,16)}`,processor:ffmpegVersion,command,filter,native};
 derivativeRecords.push(processing);
 const asset:SampleAsset={id:`sample-loop-v3-${id}-${hash.slice(0,12)}`,name:`${source.name} · ${id}`,originalFilename:filename,data:`data:audio/wav;base64,${outputBytes!.toString('base64')}`,role:'loop',root:60,tuning:0,trimStart:0,trimEnd:native.durationSeconds,duration:native.durationSeconds,gain:1,choke:'',envelopeMode:'gated',loop:false,envelope:clone(source.envelope!),license:source.license,sourceId:source.id,source:pretty(processing),hash,sampleRate:native.sampleRate,channels:native.channels,rootConfidence:0,manualOverride:false};
 return {asset,processing,native};
}
const verse=await derived('verse-lp4500','loop10-verse-lp4500.wav','lowpass=f=4500:p=2:t=q:w=0.707:m=1:a=di:r=f64',originalMetadata.frames);
const endingSeconds=seconds(4*BAR,p.settings.bpm),endingFrames=Math.round(endingSeconds*originalMetadata.sampleRate),fadeFrames=Math.round(1.2*originalMetadata.sampleRate);
const ending=await derived('ending-fade','loop10-ending-four-bars-fade.wav',`atrim=start_sample=0:end_sample=${endingFrames},asetpts=PTS-STARTPTS,afade=t=out:ss=${endingFrames-fadeFrames}:ns=${fadeFrames}:curve=tri`,endingFrames);
p.assets.push(verse.asset,ending.asset);
const gains=[];
for(const candidate of p.candidates){
 for(const [role,multiplier] of [['bass',.84],['kick',1.4125],['hat',.7943]] as const){const track=candidate.tracks.find(t=>t.id===role)!;const old=track.volume;track.volume*=multiplier;gains.push({candidateId:candidate.id,role,before:old,after:track.volume,multiplier,changeDb:20*Math.log10(multiplier)});}
 const hat=candidate.tracks.find(t=>t.id==='hat')!;if(!hat.effects?.hat||hat.effects.hat.mix!==.2)throw new Error('Expected saved hatFX .20');hat.effects.hat.mix=.14;
}
p.settings.listeningGainDb=3;
const main=p.clips!.find(c=>c.id==='library-loop-6278d2e14f1ee60d')!;
if(!main.sections?.includes('verse'))throw new Error('Expected main verse membership');
main.sections=main.sections.filter(kind=>kind!=='verse');
const verseClip=clone(main);verseClip.id+='-verse-lp4500';verseClip.assetId=verse.asset.id;verseClip.sections=['verse'];verseClip.gain=.61;verseClip.name+=' · quieter filtered development';
verseClip.provenance.sourceHash=verse.asset.hash!;verseClip.provenance.sourceName=verse.asset.originalFilename!;verseClip.provenance.renderId=verse.processing.renderId;
verseClip.provenance.credit+=`\nDerived from the original embedded loop by ${ffmpegVersion}. ${pretty(verse.processing)} Original source and USE TAG!! credit are retained. Two-pole4500Hz low-pass and clip gain.61 are a controlled revision, not a reproduced FST preset.`;
p.clips!.splice(1,0,verseClip);
const endingClip=p.clips!.find(c=>c.id==='library-loop-6278d2e14f1ee60d-ending')!;
endingClip.assetId=ending.asset.id;endingClip.sourceDuration=ending.native.durationSeconds;endingClip.name+=' · final1.2s source fade';
endingClip.effects={delay:{division:.75,feedback:.22,wet:.14,cutoff:4200,pingPong:true}};
endingClip.provenance.sourceHash=ending.asset.hash!;endingClip.provenance.sourceName=ending.asset.originalFilename!;endingClip.provenance.renderId=ending.processing.renderId;
endingClip.provenance.credit+=`\nDerived original first4bars, rounded to nearest native frame (${endingFrames} at44100Hz; requested${endingSeconds}s, actual${ending.native.durationSeconds}s). Final52920frames=1.2s linear fade. ${pretty(ending.processing)} Editable0.75beat ping-pong delay wet.14/feedback.22/cutoff4200Hz is stored on this outro clip; no new notes.`;
const voxPath='private-assets/culture-kit/Culture Drum Kit (North)/vox/Exotic_Ahh_3.wav',voxBytes=await fs.readFile(voxPath),voxHash=sha(voxBytes),voxNative=audioMetadata(voxPath);
if(voxHash!=='0e436d4002a39a2d7f1b1e45f46feab64fc8fc6bb3b0483720d633a2de19652c'||voxNative.frames!==97215)throw new Error('Auditioned vox source changed');
const vox:SampleAsset={id:`sample-vox-${voxHash.slice(0,16)}`,name:'Exotic_Ahh_3.wav',originalFilename:'Exotic_Ahh_3.wav',data:`data:audio/wav;base64,${voxBytes.toString('base64')}`,role:'vox',root:60,tuning:0,trimStart:0,trimEnd:voxNative.durationSeconds,duration:voxNative.durationSeconds,gain:1,choke:'',envelopeMode:'one-shot',loop:false,license:'User-supplied Culture Drum Kit.rar, internal Culture Drum Kit (North)/vox. Original speaker/creator and redistribution permission unverified; source retained for private project use.',sourceId:voxPath,source:voxPath,hash:voxHash,sampleRate:voxNative.sampleRate,channels:voxNative.channels,rootConfidence:0,manualOverride:false};
p.assets.push(vox);
const voxEvents:VocalEvent[]=[{id:'vox-before-reduction',sectionId:'verse-0',pan:-.15},{id:'vox-before-return',sectionId:'loop-break',pan:.15}].map(({id,sectionId,pan})=>({id,name:`Supplied vocal accent · ${id==='vox-before-return'?'return pickup':'reduction pickup'}`,assetId:vox.id,role:'vox',enabled:true,placement:{kind:'section',sectionId,tick:p.sections.find(s=>s.id===sectionId)!.bars*BAR-PPQ},duration:BAR*2,sourceOffset:0,sourceDuration:voxNative.durationSeconds,gain:.12,pan,pitch:0,reverse:false,mode:'one-shot',fadeIn:.004,fadeOut:.12,filter:{highpass:250,lowpass:6500},effects:{reverb:{wet:.05,decay:.45,preDelay:.012},delay:{division:.5,feedback:.12,wet:.08,cutoff:4200,pingPong:true}},overlap:'allow',provenance:{sourceName:vox.name,sourceHash:voxHash,creator:'User-supplied Culture Drum Kit (North); original speaker/creator unverified',credit:'Actual source itemC in the Culture voice audition reel was provisionally described as a medium-high short vocal exclamation. That model response failed later in the reel and does not establish complete reliable audition. Used twice as an original arrangement choice, never a producer identity or copied rap performance. Exact original bytes retained; no pitch/time change. Private source-kit terms retained in asset.'}}));
p.vocalEvents=[...p.vocalEvents??[],...voxEvents];p.voxEnabled=true;
for(const clip of p.clips!){clip.provenance.credit=clip.provenance.credit.replace('No additional supplied vox chosen.','Two provisionally auditioned Exotic_Ahh_3 vocal accents added before the reduced section and full return in v3.');}
validateProject(p);if(missingAssets(p).length||vocalEventIssues(p).length)throw new Error('Unresolved source/placement');
const noteHashes=p.candidates.map((candidate,index)=>{const hash=sha(JSON.stringify(candidate.tracks.map(t=>({role:t.id,notes:t.notes}))));if(hash!==sha(JSON.stringify(before.candidates[index].tracks.map(t=>({role:t.id,notes:t.notes})))))throw new Error('Revision changed notes');return{id:candidate.id,sha256:hash};});
if(p.candidates.some(c=>c.tracks.some(t=>t.id!=='bass'&&!isDrum(t.id)&&t.notes.length)))throw new Error('Upper generated melody exists');
if(JSON.stringify(p.sections)!==JSON.stringify(before.sections))throw new Error('Arrangement boundaries changed');
if(JSON.stringify(p.vocalEvents.slice(0,2))!==JSON.stringify(before.vocalEvents))throw new Error('Original tags altered');
for(const old of before.assets){const a=p.assets.find(a=>a.id===old.id);if(JSON.stringify(a)!==JSON.stringify(old))throw new Error(`Original asset altered: ${old.id}`);}
const scheduled=score(p),eventTiming=voxEvents.map(v=>{const found=scheduled.find(e=>e.id.startsWith(v.id)||e.vocal?.eventId===v.id);let tick=0;for(const section of p.sections){if(v.placement.kind==='section'&&section.id===v.placement.sectionId){tick+=v.placement.tick;break;}tick+=section.bars*BAR;}return{id:v.id,tick,seconds:seconds(tick,p.settings.bpm),scoreOccurrenceFound:!!found};});
const data=pretty(p),output=`deliverables/finished-beats/projects/${version}/night-wire.ish.json`;
await immutable(output,data);
const manifest={schemaVersion:1,runId,jobs:[{id:'night-wire',projectUrl:`/${output}`,expectedSha256:sha(data)}]};parseDeliveryManifest(Buffer.from(pretty(manifest)));
await immutable('deliverables/finished-beats/night-wire-v3-production-manifest.json',pretty(manifest));
const evidencePaths=['deliverables/audio-research/google-studio-night-wire-v2-pro-response.txt','deliverables/audio-research/google-studio-night-wire-v2-fresh-pro-response.txt','docs/audio-research/night-wire-v2-numerical-corroboration.md','deliverables/audio-research/night-wire-v2-numerical-timeline.json','deliverables/audio-research/google-studio-culture-voices-lite-response.txt','deliverables/audio-research/comparison-reels-v1-inputs.json'];
const evidence=await Promise.all(evidencePaths.map(async path=>({path,sha256:sha(await fs.readFile(path))})));
const beforeMix='deliverables/benchmark-delivery/night-wire-v2-source-tag-delivery/night-wire/mix.wav';
const record={schemaVersion:1,version,status:'controlled_revision_prepared_not_rendered_or_auditioned',runId,project:{path:output,sha256:sha(data)},before:{projectPath:input,projectSHA256:beforeHash,mixPath:beforeMix,mixSHA256:sha(await fs.readFile(beforeMix))},rationale:{provisional:'Both actual-audio model requests suggested weak kick/sub interaction, bright hats and repeated source texture. These are hypotheses tested with modest reversible level/texture changes, not confirmed objective gaps or evidence of a TDF match.',rejected:'Wrong model break/end timings, programmed triplet hats and bass glide claims are contradicted by the actual saved score/PCM audit. Arrangement boundaries and all notes remain unchanged.',ending:'Numerical audit finds musical source lasts to120.788685s, then3.985488s zero tail. New source fade and delay test musical closure at the actual ending, not a fictitious hard cut at124s.',gain:'Listening master increases3dB explicitly. Headroom render uses existing separate tap. Final actual output must be audited for peaks; no universalLUFS target and no new limiter.'},evidence,levelChanges:gains,hatFx:{before:.2,after:.14},listeningGainDb:{before:before.settings.listeningGainDb??0,after:3},derivatives:derivativeRecords,endingFrameRounding:{requestedSeconds:endingSeconds,actualSeconds:ending.native.durationSeconds,errorSeconds:ending.native.durationSeconds-endingSeconds,fadeFrames},vox:{path:voxPath,sha256:voxHash,native:voxNative,events:voxEvents,timing:eventTiming},noteHashes,originalAssetsAndTagsUnchanged:true,musicDurationSeconds:seconds(totalTicks(p),p.settings.bpm),renderDurationSeconds:renderDurationSeconds(p),dependencies:await Promise.all(['scripts/revise-night-wire-production.ts','src/engine/score.ts','src/io/export.ts'].map(async path=>({path,sha256:sha(await fs.readFile(path))}))),browserRendered:false,musicalApproval:false};
await immutable(`deliverables/finished-beats/authoring/${version}/revision-record.json`,pretty(record));
if(sha(await fs.readFile(input))!==beforeHash||sha(await fs.readFile(source.source))!==source.hash)throw new Error('Before source changed');
console.log(pretty({status:record.status,manifest:'/deliverables/finished-beats/night-wire-v3-production-manifest.json',project:record.project,renderDurationSeconds:record.renderDurationSeconds,eventTiming,gains:gains.slice(0,3),derivatives:[verse.asset.id,ending.asset.id]}));
