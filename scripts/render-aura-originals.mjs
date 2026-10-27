import fs from "node:fs/promises";
import assert from "node:assert/strict";
import {createServer} from "vite";
import {chromium} from "playwright";
const [name,group="mix"]=process.argv.slice(2);
assert.match(name,/^(daybreak|nightline)-(full|preview)$/);assert.ok(["mix","melody","bass","drums"].includes(group));
const out="deliverables/aura-originals-20261016",qa="qa-artifacts/aura-originals-20261016",file=name+(group==="mix"?"":"-"+group)+".wav";
try{await fs.access(out+"/"+file);throw new Error("Output exists; refusing overwrite: "+file);}catch(e){if(e.code!=="ENOENT")throw e;}
const server=await createServer({configFile:false,root:process.cwd(),logLevel:"error",server:{host:"127.0.0.1",port:5189,strictPort:true}});await server.listen();let browser;
try{
 browser=await chromium.launch({channel:"chrome",headless:true});const page=await browser.newPage();const errors=[];page.on("pageerror",e=>errors.push(e.message));
 await page.goto("http://127.0.0.1:5189/"+out+"/render-host.html");
 const result=await page.evaluate(async({name,group})=>{
  const {renderWav}=await import("/src/io/export.ts");const {validateProject}=await import("/src/io/persistence.ts");const {isDrum}=await import("/src/engine/schema.ts");
  const p=validateProject(await(await fetch("/deliverables/aura-originals-20261016/"+name+".ish.json")).json());
  if(group!=="mix")for(const t of p.candidates[p.selected].tracks)t.mute=group==="melody"?(t.id==="bass"||isDrum(t.id)):group==="bass"?t.id!=="bass":!isDrum(t.id);
  const r=await renderWav(p,"headroom");if(r.peak>=.98||!Number.isFinite(r.rms)||r.rms<=0)throw new Error("Unsafe/silent draft peak "+r.peak);
  let s="";for(let i=0;i<r.wav.length;i+=16384)s+=String.fromCharCode(...r.wav.subarray(i,i+16384));
  return {data:btoa(s),peak:r.peak,rms:r.rms,frames:r.frames,seconds:r.duration,assetCount:p.assets.length};
 },{name,group});
 assert.deepEqual(errors,[]);await fs.writeFile(out+"/"+file,Buffer.from(result.data,"base64"),{flag:"wx"});delete result.data;
 await fs.writeFile(qa+"/render-"+file+".json",JSON.stringify({name,group,file,browser:await browser.version(),errors,tap:"headroom",...result},null,2),{flag:"wx"});console.log(JSON.stringify({file,...result}));
}finally{if(browser)await browser.close();await server.close();}
