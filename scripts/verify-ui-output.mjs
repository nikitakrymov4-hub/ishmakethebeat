import fs from "node:fs/promises";
import { unzipSync, strFromU8 } from "fflate";
import { parseMidi } from "midi-file";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
const zip = unzipSync(
    await fs.readFile("deliverables/verification/ui-project.ish.zip"),
  ),
  p = JSON.parse(strFromU8(zip["project.json"])),
  m = parseMidi(await fs.readFile("deliverables/verification/ui-edited.mid"));
assert.equal(p.candidates[p.selected].tracks[0].notes[0].velocity, 0.52);
assert.ok(p.candidates[p.selected].tracks[0].locked);
assert.ok(m.tracks[1].some((e) => e.type === "noteOn" && e.velocity === 66));
assert.equal(p.assets.length, 10);
for (const a of p.assets) {
  const bytes = zip[`samples/${a.id}.wav`];
  assert.ok(bytes.length > 0);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), a.hash);
}
const report = {
  browser: "Codex in-app Chromium 155 on macOS",
  workflow: [
    "Generate 3 ideas",
    "Play and Stop",
    "Edit first melody-note velocity to 0.52 using keyboard control",
    "Lock melody",
    "Rewrite drums",
    "Save locally",
    "Reload: velocity 66 and lock retained",
    "Export multitrack MIDI, WAV, and portable ZIP from dialog",
    "Load exported portable ZIP through file picker",
    "Play loaded project with embedded samples",
  ],
  projectAssets: p.assets.length,
  allAssetHashesVerified: true,
  editedMIDIvelocity: 66,
  errors: [],
  scope:
    "localhost origin used for QA; the user session at 127.0.0.1 was preserved",
};
await fs.writeFile(
  "deliverables/verification/browser-workflow.json",
  JSON.stringify(report, null, 2),
);
console.log(report);
