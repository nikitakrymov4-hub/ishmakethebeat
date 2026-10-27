import fs from "node:fs/promises";
import assert from "node:assert/strict";
import {chromium} from "playwright";
const out="deliverables/generator-pass-20261016";
const browser=await chromium.launch({channel:"chrome",headless:true,args:["--autoplay-policy=no-user-gesture-required"]});
try{
 const page=await browser.newPage();const errors=[];page.on("pageerror",e=>errors.push(e.message));
 await page.goto("http://127.0.0.1:5173/");
 await page.getByLabel("Palette and groove family").selectOption("glass-garden");
 await page.getByRole("button",{name:"Generate 3 ideas",exact:true}).click();
 await page.getByRole("status").filter({hasText:"Three original ideas"}).waitFor();
 await page.getByRole("button",{name:"Play",exact:true}).click();
 await page.getByRole("button",{name:"Pause",exact:true}).waitFor();
 await page.getByRole("button",{name:"Stop",exact:true}).click();
 await page.getByRole("button",{name:"Play",exact:true}).waitFor();
 await page.waitForFunction(async()=>{const {loadLocal}=await import("/src/io/persistence.ts");const p=await loadLocal();return p?.settings.cultureFamily==="glass-garden";});
 await page.exposeFunction("saveArrangement",async(s)=>fs.writeFile(out+"/arrangement.wav",Buffer.from(s,"base64"),{flag:"wx"}));
 const rendered=await page.evaluate(async()=>{
  const {renderWav}=await import("/src/io/export.ts");
  const p=await(await fetch("/deliverables/generator-pass-20261016/arrangement.ish.json")).json();
  const r=await renderWav(p);let s="";for(let i=0;i<r.wav.length;i+=16384)s+=String.fromCharCode(...r.wav.subarray(i,i+16384));await window.saveArrangement(btoa(s));return {peak:r.peak,rms:r.rms,duration:r.duration,frames:r.frames};
 });
 assert.deepEqual(errors,[]);assert.ok(rendered.rms>0);
 await fs.writeFile(out+"/browser-render-report.json",JSON.stringify({browser:await browser.version(),checks:["isolated select family / generate / play / stop / autosave","shared renderer arrangement"],errors,arrangement:rendered},null,2),{flag:"wx"});
 console.log(JSON.stringify(rendered));
}finally{await browser.close();}
