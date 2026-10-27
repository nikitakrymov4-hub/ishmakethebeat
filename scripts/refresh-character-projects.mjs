// Metadata/MIDI packaging only. Existing WAV renders and the frozen baseline
// are intentionally never written by this script.
// Run: node --import tsx scripts/refresh-character-projects.mjs
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import assert from "node:assert/strict";
import { exportMidi } from "../src/io/midi.ts";
import { portableZip } from "../src/io/export.ts";
import { validateProject } from "../src/io/persistence.ts";
const root = path.resolve("deliverables/character");
function walk(dir) {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) =>
      entry.isDirectory()
        ? walk(path.join(dir, entry.name))
        : [path.join(dir, entry.name)],
    );
}
const digest = (file) =>
  crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const frozenFiles = [
  "baseline/accepted-project.ish.zip",
  "baseline/accepted-export.mid",
];
const before = Object.fromEntries(
  frozenFiles.map((name) => [name, digest(path.join(root, name))]),
);
const updated = [];
function writeAtomic(file, bytes) {
  const temp = `${file}.refresh-tmp`;
  fs.writeFileSync(temp, bytes);
  fs.renameSync(temp, file);
}
for (const file of walk(root).filter(
  (file) =>
    file.endsWith(".ish.json") &&
    !path.relative(root, file).startsWith(`baseline${path.sep}`),
)) {
  const p = validateProject(JSON.parse(fs.readFileSync(file, "utf8"))),
    prefix = file.slice(0, -".ish.json".length),
    midi = exportMidi(p),
    zip = portableZip(p);
  writeAtomic(`${prefix}.mid`, midi);
  writeAtomic(`${prefix}.ish.zip`, zip);
  updated.push({
    project: path.relative(root, file).split(path.sep).join("/"),
    midiBytes: midi.length,
    portableBytes: zip.length,
  });
}
const after = Object.fromEntries(
  frozenFiles.map((name) => [name, digest(path.join(root, name))]),
);
assert.deepEqual(
  after,
  before,
  "The authoritative baseline changed during refresh",
);
const report = {
  generatedAt: new Date().toISOString(),
  updated,
  frozenBaselineSha256: after,
  frozenBaselineUnchanged: true,
  wavFilesWritten: 0,
};
fs.writeFileSync(
  path.join(root, "verification/project-refresh.json"),
  JSON.stringify(report, null, 2) + "\n",
);
console.log(
  JSON.stringify({
    refreshedProjects: updated.length,
    frozenBaselineUnchanged: true,
    wavFilesWritten: 0,
  }),
);
