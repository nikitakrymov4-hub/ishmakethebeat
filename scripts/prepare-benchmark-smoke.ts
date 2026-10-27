import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { unzipSync, strFromU8 } from "fflate";
import { parseMidi } from "midi-file";
import { validateProject, missingAssets } from "../src/io/persistence";
import { exportMidi } from "../src/io/midi";
import { portableZip, renderDurationSeconds } from "../src/io/export";
import {
  deliveryRenderPlan,
  parseDeliveryManifest,
} from "../src/io/delivery-plan";
import { score } from "../src/engine/score";

const sourcePath = "deliverables/audio-research/current/project.ish.json";
const copyPath =
  "private-assets/qa/benchmark-delivery-smoke/baseline-copy.ish.json";
const manifestPath = "deliverables/benchmark-delivery/qa-smoke-manifest.json";
const qa = "qa-artifacts/benchmark-delivery-smoke";
const digest = (data: Uint8Array | string) =>
  createHash("sha256").update(data).digest("hex");
const pretty = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
async function writeSame(file: string, bytes: Uint8Array | string) {
  const wanted = Buffer.from(bytes);
  await fs.mkdir(path.dirname(file), { recursive: true });
  try {
    await fs.writeFile(file, wanted, { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (!(await fs.readFile(file)).equals(wanted))
      throw new Error(`Refusing to replace changed QA artifact: ${file}`);
  }
}

const sourceBytes = await fs.readFile(sourcePath),
  sourceSha256 = digest(sourceBytes);
const project = validateProject(JSON.parse(sourceBytes.toString("utf8")));
const absent = missingAssets(project);
if (absent.length) throw new Error(`Missing assets: ${absent.join(", ")}`);
const before = JSON.stringify(project);
await writeSame(copyPath, sourceBytes);
const manifest = {
  schemaVersion: 1,
  runId: "qa-baseline-smoke-v1",
  jobs: [
    {
      id: "baseline-copy",
      projectUrl: `/${copyPath}`,
      expectedSha256: sourceSha256,
    },
  ],
};
parseDeliveryManifest(Buffer.from(pretty(manifest)));
await writeSame(manifestPath, pretty(manifest));
await fs.mkdir(qa, { recursive: true });
const midi = exportMidi(project);
await writeSame(`${qa}/score.mid`, midi);
let portable: Uint8Array;
try {
  portable = await fs.readFile(`${qa}/portable-project.zip`);
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  portable = portableZip(project);
  await writeSame(`${qa}/portable-project.zip`, portable);
}
const archive = unzipSync(portable);
const loaded = validateProject(JSON.parse(strFromU8(archive["project.json"])));
if (JSON.stringify(loaded) !== before)
  throw new Error("Portable project differs from the baseline");
const assets = project.assets.map((asset) => {
  const original = Buffer.from(asset.data.split(",")[1], "base64");
  const extension = asset.data.startsWith("data:audio/mpeg;") ? "mp3" : "wav";
  const file = `samples/${asset.id.replace(/[^a-zA-Z0-9._-]/g, "_")}.${extension}`;
  if (!archive[file] || !Buffer.from(archive[file]).equals(original))
    throw new Error(`Portable sample changed: ${asset.id}`);
  return {
    id: asset.id,
    bytes: original.length,
    sha256: digest(original),
    archivePath: file,
  };
});
if (
  JSON.stringify(project) !== before ||
  digest(await fs.readFile(sourcePath)) !== sourceSha256
)
  throw new Error(
    "Baseline or in-memory project changed during smoke preparation",
  );
const plan = deliveryRenderPlan(project);
const parsedMidi = parseMidi(midi);
const report = {
  schemaVersion: 1,
  preparedAt: new Date().toISOString(),
  status: "static_exports_verified_browser_wav_render_pending",
  source: { path: sourcePath, bytes: sourceBytes.length, sha256: sourceSha256 },
  copy: {
    path: copyPath,
    bytes: (await fs.stat(copyPath)).size,
    sha256: digest(await fs.readFile(copyPath)),
    byteIdentical: true,
  },
  manifest: {
    path: manifestPath,
    sha256: digest(await fs.readFile(manifestPath)),
    ...manifest,
  },
  projectUnchanged: true,
  sourceCanonicalUnchanged: true,
  title: project.title,
  seed: project.settings.seed,
  bpm: project.settings.bpm,
  selected: project.selected,
  sections: project.sections,
  roleNoteHashes: project.candidates.map((candidate) => ({
    id: candidate.id,
    roles: candidate.tracks.map((track) => ({
      role: track.id,
      notes: track.notes.length,
      sha256: digest(JSON.stringify(track.notes)),
    })),
  })),
  scoreEventCount: score(project).length,
  staticExports: [
    {
      path: `${qa}/score.mid`,
      sha256: digest(midi),
      bytes: midi.length,
      tracks: parsedMidi.tracks.length,
      noteOns: parsedMidi.tracks
        .flat()
        .filter((e) => e.type === "noteOn" && e.velocity > 0).length,
    },
    {
      path: `${qa}/portable-project.zip`,
      sha256: digest(portable),
      bytes: portable.length,
      projectRoundtripEqual: true,
      embeddedSourceBytesAllEqual: true,
      assets,
    },
  ],
  expectedWavFiles: plan,
  expectedFrames: Math.ceil(renderDurationSeconds(project) * 44100),
  expectedDurationSeconds:
    Math.ceil(renderDurationSeconds(project) * 44100) / 44100,
  outputRoot:
    "deliverables/benchmark-delivery/qa-baseline-smoke-v1/baseline-copy",
  browserAudioRenderedByThisScript: false,
  notes: [
    "No CUA or browser automation was used.",
    "No musical or gain edits were made.",
    "Baseline has vocals disabled; expected tag/vox stems are silent, and mix/instrumental audio should match.",
  ],
};
await fs.writeFile(`${qa}/preparation-report.json`, pretty(report));
process.stdout.write(
  pretty({
    status: report.status,
    sourceSha256,
    manifestPath,
    outputRoot: report.outputRoot,
    expectedWavFiles: plan.length,
    expectedFrames: report.expectedFrames,
    assetsVerified: assets.length,
    sourceCanonicalUnchanged: true,
  }),
);
