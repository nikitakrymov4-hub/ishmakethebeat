import fs from "node:fs/promises";
import { chromium } from "playwright";
import assert from "node:assert/strict";
const out = "deliverables/generator-pass-20261016";
const browser=await chromium.launch({channel:"chrome",headless:true,args:["--autoplay-policy=no-user-gesture-required"]});
const page=await browser.newPage({viewport:{width:1512,height:1100}});
const errors=[];page.on("pageerror",e=>errors.push(e.message));
try {
 await page.goto("http://127.0.0.1:5173/");
 await page.getByRole("button",{name:"Generate 3 ideas",exact:true}).waitFor();
 await page.getByLabel("Palette and groove family").selectOption("odd-orbit");
 await page.getByRole("button",{name:"Generate 3 ideas",exact:true}).click();
 await page.getByRole("status").filter({hasText:"Three original ideas"}).waitFor();
 await page.getByRole("button",{name:"Play",exact:true}).click();
 await page.getByRole("button",{name:"Pause",exact:true}).waitFor();
 await page.getByRole("button",{name:"Stop",exact:true}).click();
 await page.getByRole("button",{name:"Play",exact:true}).waitFor();
 await page.screenshot({path:out+"/studio.png",fullPage:true});
 const ui=await page.evaluate(async()=>{const {loadLocal}=await import("/src/io/persistence.ts");return await loadLocal();});
 assert.equal(ui.settings.cultureFamily,"odd-orbit");
 assert.ok(ui.candidates.every(c=>c.recipe.composition.family===2));
 // Only this isolated page may write, and only new files in this pass directory.
 await page.exposeFunction("savePass",async(name,base64)=>{
   assert.match(name,/^[a-z0-9-]+\.(wav|mid|ish.json)$/);
   await fs.writeFile(out+"/"+name,Buffer.from(base64,"base64"),{flag:"wx"});
 });
 const report=await page.evaluate(async()=>{
   const {newProject}=await import("/src/engine/compose.ts");
   const {defaultSettings}=await import("/src/engine/profiles.ts");
   const {renderWav}=await import("/src/io/export.ts");
   const {exportMidi}=await import("/src/io/midi.ts");
   const {validateProject}=await import("/src/io/persistence.ts");
   const before=validateProject(await (await fetch("/deliverables/generator-pass-20261016/before.ish.json")).json());
   const items=[["before",before]];
   for(const family of ["paper-lantern","glass-garden","odd-orbit"]) {
     const p=newProject({...defaultSettings(),seed:"FIRST-PASS-041",cultureFamily:family});p.title=family+" · FIRST-PASS-041";
     items.push([family,p]);
   }
   const arranged=structuredClone(items[1][1]);arranged.title="Paper lantern · developed arrangement";arranged.arrangement=true;
   arranged.sections=[{id:"intro",name:"Intro",kind:"intro",bars:4},{id:"hook",name:"Hook",kind:"hook",bars:16},{id:"verse",name:"Verse",kind:"verse",bars:8},{id:"return",name:"Return",kind:"return",bars:16},{id:"outro",name:"Outro",kind:"outro",bars:4}];
   items.push(["arrangement",arranged]);
   const save=async(name,bytes)=>{let s="";for(let i=0;i<bytes.length;i+=16384)s+=String.fromCharCode(...bytes.subarray(i,i+16384));await window.savePass(name,btoa(s));};
   const rows=[];
   for(const [name,p] of items) {
     if(name!=="before")await save(name+".ish.json",new TextEncoder().encode(JSON.stringify(p)));
     await save(name+".mid",exportMidi(p));
     const r=await renderWav(p);await save(name+".wav",r.wav);
     rows.push({name,peak:r.peak,rms:r.rms,duration:r.duration,frames:r.frames,settings:p.settings});
   }
   return rows;
 });
 assert.ok(report.every(r=>r.peak>0 && Number.isFinite(r.rms)));
 assert.deepEqual(errors,[]);
 await fs.writeFile(out+"/browser-render-report.json",JSON.stringify({browser:await browser.version(),checks:["isolated UI family selection","generate/play/stop","portable score load","shared renderer: five non-silent WAVs"],errors,renders:report},null,2),{flag:"wx"});
 console.log(JSON.stringify(report.map(({name,peak,rms,duration})=>({name,peak,rms,duration}))));
} finally {await browser.close();}
