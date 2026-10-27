import fs from "node:fs/promises";
import assert from "node:assert/strict";
import {chromium} from "playwright";
const browser=await chromium.launch({channel:"chrome",headless:true});
try{
 const page=await browser.newPage();const errors=[];page.on("pageerror",e=>errors.push(e.message));
 await page.route("**/private-assets/*.json",r=>r.fulfill({status:200,contentType:"application/json",body:"[]"}));
 await page.goto("http://127.0.0.1:5173/");
 await page.getByText(/Session setup: Required TDF kit/).waitFor();
 await page.getByLabel("Allow original synth fallback if private kit is missing").check();
 await page.getByRole("button",{name:"Generate 3 ideas",exact:true}).click();
 await page.getByRole("status").filter({hasText:"Three original ideas"}).waitFor();
 await page.getByRole("button",{name:"Play",exact:true}).click();
 await page.getByRole("button",{name:"Pause",exact:true}).waitFor();
 await page.getByRole("button",{name:"Stop",exact:true}).click();
 await page.getByText("All changes saved",{exact:true}).waitFor();
 const result=await page.evaluate(async()=>{const {loadLocal}=await import("/src/io/persistence.ts");const p=await loadLocal();return {fallback:p.settings.allowSynthFallback,assets:p.assets.length,tracks:p.candidates.map(c=>c.tracks.map(t=>({role:t.id,instrument:t.instrument,notes:t.notes.length})))}});
 assert.equal(result.fallback,true);assert.equal(result.assets,0);assert.ok(result.tracks.every(ts=>ts.every(t=>t.instrument!=="kit-required")));assert.deepEqual(errors,[]);
 await page.screenshot({path:"deliverables/generator-pass-20261016/qa-fixes/missing-kit.png",fullPage:true});
 await fs.writeFile("deliverables/generator-pass-20261016/qa-fixes/missing-kit-browser.json",JSON.stringify({browser:await browser.version(),checks:["empty kit loading state","opt-in fallback Generate","Play / Stop","autosave without assets"],errors,result},null,2),{flag:"wx"});
 console.log("Missing-kit browser path passed");
}finally{await browser.close();}
