/**
 * Freeze a controlled Promo Static support-note revision and three same-source seeds.
 * Run only after the support engine review, passing both reviewed source hashes:
 * node --import tsx scripts/author-promo-drum-revision.ts --engine-sha HEX --rhythm-sha HEX
 * This authors projects/manifests, not audio, and never modifies existing outputs.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { BAR, PPQ, clone, isDrum, seconds } from "../src/engine/schema";
import type { Candidate, Project, Track } from "../src/engine/schema";
import { score, totalTicks, vocalEventIssues } from "../src/engine/score";
import { LOOP_SUPPORT_RHYTHM } from "../src/engine/loop-support-rhythm";
import { rebuildLoopBeat } from "../src/io/loop-beat";
import { checked321Bank, add321Bank } from "../src/io/drum-kit-bank";
import { validateProject, missingAssets } from "../src/io/persistence";
import { renderDurationSeconds } from "../src/engine/render-duration";
import {
  deliveryRenderPlan,
  parseDeliveryManifest,
} from "../src/io/delivery-plan";
import type { DeliveryJob, DeliveryManifest } from "../src/io/delivery-plan";

const VERSION = "promo-drum-revision-v1";
const BASE =
  "deliverables/finished-beats/projects/different-melodies-v1/promo-static.ish.json";
const BASE_SHA =
  "fd9e6fe9d2d6d31a553ae2107b1004aba1d840f7dba877e9873c6ee1d80f1432";
const BANK = "private-assets/321-drumkit/drum-bank.json";
const BANK_SHA =
  "f34fdf32f68ce86afcd964c69df80f5842a3b7d8ada442fbda296a18ef9d1ad4";
const ENGINE = "src/io/loop-beat.ts";
const RHYTHM = "src/engine/loop-support-rhythm.ts";
const BEFORE_MIX =
  "deliverables/benchmark-delivery/different-melodies-mixes-stable-v3/promo-static/mix.wav";
const BEFORE_MIX_SHA =
  "bbb8b9bbebba95425c86acb6dd88209e96ad71b2cbc33d2f3b76844356247b17";
const sha = (value: Uint8Array | string) =>
  createHash("sha256").update(value).digest("hex");
const pretty = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const same = (a: unknown, b: unknown, message: string) =>
  assert.deepEqual(a, b, message);
const support = (role: string) => role === "bass" || isDrum(role);
const withoutNotes = ({ notes: _notes, ...controls }: Track) => controls;

async function immutable(file: string, data: Uint8Array | string) {
  const bytes = Buffer.from(data);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.pending-${process.pid}`;
  try {
    const handle = await fs.open(temporary, "wx");
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await fs.link(temporary, file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (!(await fs.readFile(file)).equals(bytes))
        throw new Error(`Frozen artifact differs; preserved: ${file}`);
    }
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

function expectedHash(flag: string) {
  const index = process.argv.indexOf(flag);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value || !/^[a-f0-9]{64}$/.test(value))
    throw new Error(
      `Pass ${flag} with the reviewed source SHA-256. Do not author before engine review is complete.`,
    );
  return value;
}

function noteGrid(candidate: Candidate) {
  return candidate.tracks.map((track) => ({
    role: track.id,
    notes: clone(track.notes),
  }));
}

function rhythmFingerprint(candidate: Candidate) {
  // Exclude IDs and velocity so distinctness cannot mean a rename or level-only variation.
  return sha(
    JSON.stringify(
      candidate.tracks
        .filter((track) => support(track.id))
        .map((track) => ({
          role: track.id,
          notes: track.notes.map(
            ({ tick, duration, pitch, drumPitch, glide, articulation }) => ({
              tick,
              duration,
              pitch,
              drumPitch,
              glide,
              articulation,
            }),
          ),
        })),
    ),
  );
}

function sourceSchedule(project: Project) {
  return score(project).filter((event) => !support(event.role));
}

function onsetFingerprint(candidate: Candidate) {
  return sha(
    JSON.stringify(
      candidate.tracks
        .filter((track) => support(track.id))
        .map((track) => ({
          role: track.id,
          ticks: track.notes.map((note) => note.tick),
        })),
    ),
  );
}

const reviewedEngine = expectedHash("--engine-sha");
const reviewedRhythm = expectedHash("--rhythm-sha");
assert.equal(
  sha(await fs.readFile(ENGINE)),
  reviewedEngine,
  "Engine changed after review",
);
assert.equal(
  sha(await fs.readFile(RHYTHM)),
  reviewedRhythm,
  "Rhythm implementation changed after review",
);
assert.equal(
  LOOP_SUPPORT_RHYTHM,
  "source-support-cells-2",
  "Unexpected support implementation",
);
const baseBytes = await fs.readFile(BASE);
assert.equal(sha(baseBytes), BASE_SHA, "Frozen accepted Promo source changed");
assert.equal(
  sha(await fs.readFile(BEFORE_MIX)),
  BEFORE_MIX_SHA,
  "Before mix changed",
);
const before: Project = validateProject(JSON.parse(baseBytes.toString("utf8")));
assert.equal(before.settings.bpm, 145);
assert.equal(totalTicks(before), 70 * BAR);
assert.equal(before.settings.mode, "minor");
assert.equal(before.settings.key, 9);
assert.equal(before.selected, 0);
assert(
  before.candidates.every((candidate) =>
    candidate.tracks.every(
      (track) => support(track.id) || track.notes.length === 0,
    ),
  ),
  "Unexpected upper melody notes",
);
assert(
  before.candidates.every((candidate) =>
    candidate.tracks.every((track) => !support(track.id) || !track.locked),
  ),
  "Do not silently unlock support",
);
const bankBytes = await fs.readFile(BANK);
assert.equal(sha(bankBytes), BANK_SHA, "321 bank records changed");
const bank = await checked321Bank(JSON.parse(bankBytes.toString("utf8")));

const dependencyPaths = [
  ENGINE,
  RHYTHM,
  "src/engine/schema.ts",
  "src/engine/random.ts",
  "src/engine/tdf-kit.ts",
  "src/engine/score.ts",
  "src/engine/render-duration.ts",
  "src/io/drum-kit-bank.ts",
  "src/io/persistence.ts",
  "src/io/delivery-plan.ts",
  "scripts/author-promo-drum-revision.ts",
  "scripts/author-different-loop-beats.ts",
  "deliverables/finished-beats/authoring/different-melodies-v1/authoring-record.json",
];
const dependencies = await Promise.all(
  dependencyPaths.map(async (file) => ({
    path: file,
    sha256: sha(await fs.readFile(file)),
  })),
);
const specs = [
  {
    id: "promo-static-drum-revision",
    title: "Promo Static • Drum Revision",
    seed: before.settings.seed,
    selected: 0,
    mode: "complete" as const,
  },
  {
    id: "promo-seed-01",
    title: "Promo Static • A variation (same loop)",
    seed: "PROMO-STATIC-DRUMS-145-01",
    selected: 0,
    mode: "mixes" as const,
  },
  {
    id: "promo-seed-02",
    title: "Promo Static • B variation (same loop)",
    seed: "PROMO-STATIC-DRUMS-145-02",
    selected: 1,
    mode: "mixes" as const,
  },
  {
    id: "promo-seed-03",
    title: "Promo Static • C variation (same loop)",
    seed: "PROMO-STATIC-DRUMS-145-03",
    selected: 2,
    mode: "mixes" as const,
  },
];
const pending: { path: string; data: string }[] = [];
const jobs: DeliveryJob[] = [];
const records = [];

for (const spec of specs) {
  // Run writing against only the unchanged accepted palette; add available321 sources afterward.
  const generated = rebuildLoopBeat(before, {
    key: before.settings.key,
    mode: "minor",
    seed: spec.seed,
  });
  const project = clone(before);
  project.title = spec.title;
  project.settings.seed = spec.seed;
  project.generator = generated.generator;
  project.candidates = clone(generated.candidates);
  project.selected = spec.selected;
  for (const [index, candidate] of project.candidates.entries()) {
    const previous = before.candidates[index];
    assert(previous, "Unexpected candidate count");
    for (const track of candidate.tracks) {
      const old = previous.tracks.find((other) => other.id === track.id);
      assert(old, `Unexpected track ${track.id}`);
      same(
        withoutNotes(track),
        withoutNotes(old),
        `Non-note track control changed: ${spec.id}/${index}/${track.id}`,
      );
      if (!support(track.id))
        same(track, old, "Accepted empty upper track changed");
    }
    // Do not reapply the old authoring script's tick%240/duration hat filter.
    same(
      noteGrid(candidate),
      noteGrid(generated.candidates[index]),
      "Post-generation note processing is forbidden",
    );
  }
  const loaded = add321Bank(project, bank);
  const p = loaded.project;
  assert.equal(loaded.added, 9);
  assert.equal(loaded.available, 9);
  same(
    p.assets.slice(0, before.assets.length),
    before.assets,
    "Original source asset objects changed",
  );
  same(
    p.assets.slice(before.assets.length),
    bank,
    "Unexpected additional assets",
  );
  same(
    p.clips,
    before.clips,
    "Source melody, region, credits or clip treatment changed",
  );
  same(p.sections, before.sections, "Arrangement changed");
  same(
    { ...p.settings, seed: before.settings.seed },
    before.settings,
    "Mix, key or tempo changed",
  );
  same(
    sourceSchedule(p),
    sourceSchedule(before),
    "Arranged melody or vocal source events changed",
  );
  same(
    {
      ...p,
      title: before.title,
      settings: before.settings,
      candidates: before.candidates,
      selected: before.selected,
      assets: before.assets,
    },
    before,
    "Unexpected project changes beyond title, seed, support candidates and available kit assets",
  );
  validateProject(p);
  assert.equal(missingAssets(p).length, 0);
  assert.equal(vocalEventIssues(p).length, 0);
  assert.equal(totalTicks(p), 70 * BAR);
  assert.equal(renderDurationSeconds(p), renderDurationSeconds(before));
  const embedded = p.assets.map((asset) => {
    const bytes = Buffer.from(asset.data.split(",")[1], "base64");
    const hash = sha(bytes);
    assert.equal(
      hash,
      asset.hash,
      `Embedded source bytes changed: ${asset.name}`,
    );
    return {
      id: asset.id,
      name: asset.name,
      sha256: hash,
      bytes: bytes.length,
      selectedByAnyTrack: p.candidates.some((c) =>
        c.tracks.some((t) => t.instrument === asset.id),
      ),
    };
  });
  assert(
    embedded
      .slice(before.assets.length)
      .every((asset) => !asset.selectedByAnyTrack),
    "321 sources were automatically selected",
  );
  const projectPath = `deliverables/finished-beats/projects/${VERSION}/${spec.id}.ish.json`;
  const data = pretty(p);
  const gridPath = `deliverables/finished-beats/authoring/${VERSION}/${spec.id}-note-grid.json`;
  const scheduled = score(p);
  const grid = {
    schemaVersion: 1,
    seed: spec.seed,
    supportVersion: LOOP_SUPPORT_RHYTHM,
    ppq: PPQ,
    ticksPerBar: BAR,
    gridMeaning:
      "Saved eight-bar source grid; full arrangement masking remains in the unchanged score path. No post-generation hat filtering.",
    projectPath,
    projectSHA256: sha(data),
    baseProjectSHA256: BASE_SHA,
    selectedCandidate: spec.selected,
    engine: { path: ENGINE, sha256: reviewedEngine },
    rhythm: { path: RHYTHM, sha256: reviewedRhythm },
    candidates: p.candidates.map((candidate) => ({
      id: candidate.id,
      name: candidate.name,
      groove: candidate.groove,
      noteSHA256: sha(JSON.stringify(noteGrid(candidate))),
      rhythmFingerprint: rhythmFingerprint(candidate),
      onsetSHA256: onsetFingerprint(candidate),
      tracks: noteGrid(candidate),
    })),
    selectedArrangedEvents: {
      total: scheduled.length,
      sha256: sha(JSON.stringify(scheduled)),
      support: scheduled.filter((event) => support(event.role)).length,
      preservedMelodyAndVocalEventsSHA256: sha(
        JSON.stringify(sourceSchedule(p)),
      ),
    },
  };
  pending.push(
    { path: projectPath, data },
    { path: gridPath, data: pretty(grid) },
  );
  jobs.push({
    id: spec.id,
    projectUrl: `/${projectPath}`,
    expectedSha256: sha(data),
    mode: spec.mode,
  });
  records.push({
    ...spec,
    projectPath,
    projectSHA256: sha(data),
    projectBytes: Buffer.byteLength(data),
    noteGridPath: gridPath,
    noteGridSHA256: sha(pretty(grid)),
    selectedCandidate: spec.selected,
    selectedNoteSHA256: grid.candidates[spec.selected].noteSHA256,
    selectedRhythmFingerprint: grid.candidates[spec.selected].rhythmFingerprint,
    selectedOnsetSHA256: grid.candidates[spec.selected].onsetSHA256,
    perCandidateCounts: p.candidates.map((c) => ({
      id: c.id,
      roles: c.tracks.map((t) => ({ role: t.id, notes: t.notes.length })),
    })),
    embeddedAssets: embedded,
    sections: p.sections,
    musicDurationSeconds: seconds(totalTicks(p), p.settings.bpm),
    renderDurationSeconds: renderDurationSeconds(p),
    plannedFrames44100: Math.ceil(renderDurationSeconds(p) * 44100),
    plannedWavs: deliveryRenderPlan(p, spec.mode).map((part) => part.name),
    status: "prepared_not_rendered_or_auditioned",
  });
}

assert.equal(
  new Set(records.map((record) => record.seed)).size,
  4,
  "Seed identities collide",
);
assert.equal(
  new Set(records.slice(1).map((record) => record.selectedRhythmFingerprint))
    .size,
  3,
  "Additional seeds must differ in support rhythm/pitch/gates, not only velocity or IDs",
);
assert.equal(
  new Set(records.slice(1).map((record) => record.selectedOnsetSHA256)).size,
  3,
  "Additional A/B/C examples must differ in selected onsets, not only velocity, pitch or IDs",
);
assert.notEqual(
  records[0].selectedNoteSHA256,
  sha(JSON.stringify(noteGrid(before.candidates[0]))),
  "Main support notes did not change",
);
const manifests: { path: string; value: DeliveryManifest }[] = [
  {
    path: "deliverables/finished-beats/promo-static-drums-v1-manifest.json",
    value: {
      schemaVersion: 1,
      runId: "promo-static-drums-v1-complete",
      jobs: jobs.slice(0, 1),
    },
  },
  {
    path: "deliverables/finished-beats/promo-static-drums-v1-seeds-manifest.json",
    value: {
      schemaVersion: 1,
      runId: "promo-static-drums-v1-seeds",
      jobs: jobs.slice(1),
    },
  },
];
for (const manifest of manifests) {
  parseDeliveryManifest(Buffer.from(pretty(manifest.value)));
  pending.push({ path: manifest.path, data: pretty(manifest.value) });
}
const record = {
  schemaVersion: 1,
  version: VERSION,
  status: "prepared_not_rendered_or_auditioned",
  base: {
    projectPath: BASE,
    projectSHA256: BASE_SHA,
    mixPath: BEFORE_MIX,
    mixSHA256: BEFORE_MIX_SHA,
    selectedNoteSHA256: sha(JSON.stringify(noteGrid(before.candidates[0]))),
  },
  revisionScope:
    "New generated support notes only. Accepted source melody/region,145BPM,70bars, all selected samples, track controls/FX, mix, original assets/credits and vocal events are unchanged. Nine321 kit assets are available but unselected.",
  seedScope:
    "Three full-length same-source consistency examples, explicitly sharing the accepted Promo melody. Selected candidates A/B/C respectively expose distinct onset grids from three seeds; all three generated candidates remain editable in each project. These are not three different melodies.",
  historicalHatFilterApplied: false,
  postGenerationNoteEdits: false,
  musicalApproval: false,
  sourceHarmonyAndDownbeatRemainUnverified: true,
  bank: {
    path: BANK,
    sha256: BANK_SHA,
    added: 9,
    automaticallySelected: 0,
    originalMetadataPreserved: true,
  },
  dependencies,
  records,
  manifests: manifests.map(({ path, value }) => ({
    path,
    sha256: sha(pretty(value)),
    runId: value.runId,
  })),
};
pending.push({
  path: `deliverables/finished-beats/authoring/${VERSION}/authoring-record.json`,
  data: pretty(record),
});

// Finish validation of every project before publishing any frozen artifact.
for (const dependency of dependencies)
  assert.equal(
    sha(await fs.readFile(dependency.path)),
    dependency.sha256,
    `Source changed during authoring: ${dependency.path}`,
  );
assert.equal(sha(await fs.readFile(BASE)), BASE_SHA);
assert.equal(sha(await fs.readFile(BANK)), BANK_SHA);
for (const output of pending) await immutable(output.path, output.data);
assert.equal(
  sha(await fs.readFile(BASE)),
  BASE_SHA,
  "Original project changed during authoring",
);
assert.equal(
  sha(await fs.readFile(BEFORE_MIX)),
  BEFORE_MIX_SHA,
  "Original mix changed during authoring",
);
console.log(
  pretty({
    status: record.status,
    manifests: record.manifests,
    projects: records.map(
      ({
        id,
        seed,
        selectedCandidate,
        projectPath,
        projectSHA256,
        renderDurationSeconds,
        selectedRhythmFingerprint,
      }) => ({
        id,
        seed,
        selectedCandidate,
        projectPath,
        projectSHA256,
        renderDurationSeconds,
        selectedRhythmFingerprint,
      }),
    ),
  }),
);
