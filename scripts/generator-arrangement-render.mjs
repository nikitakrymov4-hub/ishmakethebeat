import fs from "node:fs/promises";
import assert from "node:assert/strict";
import {chromium} from "playwright";
const out="deliverables/generator-pass-20261016";
const browser=await chromium.launch({channel:"chrome",headless:true});
try{
 const page=await browser.newPage();const errors=[];page.on("pageerror",e=>errors.push(e.message));
 // A static page avoids studio autosave and playback entirely.
 await page.goto("http://127.0.0.1:5173/deliverables/generator-pass-20261016/listen.html");
 const file=await fs.open(out+"/arrangement.wav","wx");
 try{
  await page.exposeFunction("appendWavChunk",async(s)=>{await file.write(Buffer.from(s,"base64"));});
  const result=await page.evaluate(async()=>{
   const {renderWav}=await import("/src/io/export.ts");
   const p=await(await fetch("/deliverables/generator-pass-20261016/arrangement.ish.json")).json();
   const r=await renderWav(p);
   for(let i=0;i<r.wav.length;i+=49152){const chunk=r.wav.subarray(i,i+49152);await window.appendWavChunk(btoa(String.fromCharCode(...chunk)));}
   return {peak:r.peak,rms:r.rms,duration:r.duration,frames:r.frames,bytes:r.wav.length};
  });
  assert.ok(result.rms>0);assert.deepEqual(errors,[]);
  await fs.writeFile(out+"/qa-fixes/arrangement-render.json",JSON.stringify({browser:await browser.version(),errors,...result},null,2),{flag:"wx"});
  console.log(JSON.stringify(result));
 }finally{await file.close();}
}finally{await browser.close();}
