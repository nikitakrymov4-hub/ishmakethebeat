import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import crypto from "node:crypto";
import {
  newProject,
  generateCandidates,
  rewrite,
  chordAt,
} from "../src/engine/compose";
import { defaultSettings, GROOVES } from "../src/engine/profiles";
import { setPrivatePalette, getPrivatePalette } from "../src/engine/culture";
import {
  cultureWritingPlan,
  CULTURE_PLAN_VERSION,
} from "../src/engine/culture-plan";
import { clone, VERSION, BAR, isDrum, SCALES } from "../src/engine/schema";
import type { Candidate, Track, Role } from "../src/engine/schema";
import { validateProject } from "../src/io/persistence";
import { score } from "../src/engine/score";

const hash = (x: unknown) =>
  crypto.createHash("sha256").update(JSON.stringify(x)).digest("hex");
const notes = (t: Track) =>
  t.notes.map((n) => [
    n.tick,
    n.pitch,
    n.duration,
    n.articulation ?? null,
    n.glide ?? null,
  ]);
const signatures = (c: Candidate) => ({
  melody: hash(notes(c.tracks.find((t) => t.id === "melody")!)),
  harmony: hash(c.harmony),
  drums: hash(
    c.tracks.filter((t) => isDrum(t.id)).map((t) => [t.id, notes(t)]),
  ),
  bass: hash(notes(c.tracks.find((t) => t.id === "bass")!)),
  sounds: hash(c.tracks.map((t) => [t.id, t.instrument])),
  whole: hash(c.tracks.map((t) => [t.id, notes(t)])),
});

test("versioned plan and exact score reproduce from the same complete settings and seed", () => {
  const s = defaultSettings();
  assert.deepEqual(cultureWritingPlan(s), cultureWritingPlan(s));
  const first = newProject(s),
    second = newProject(clone(s));
  assert.equal(first.generator, VERSION);
  assert.equal(first.schema, 1);
  assert.deepEqual(first.candidates, second.candidates);
  assert.deepEqual(first.sections, second.sections);
  assert.deepEqual(generateCandidates(s, first.candidates), first.candidates);
  for (const c of first.candidates) {
    const p = c.recipe!.composition!;
    assert.equal(p.version, CULTURE_PLAN_VERSION);
    assert.ok(c.groove.startsWith(GROOVES.culture[p.grooveIndex].name));
  }
});

test("256 seeds produce substantive note, harmony, groove, bass and sound diversity without counting IDs or velocities", () => {
  const palette = ["bank.json", "new-palette.json"].flatMap((n) =>
    JSON.parse(fs.readFileSync(`private-assets/${n}`, "utf8")),
  );
  const priorPalette = getPrivatePalette();
  setPrivatePalette(palette);
  try {
    const seen = Object.fromEntries(
      [
        "melody",
        "harmony",
        "drums",
        "bass",
        "sounds",
        "whole",
        "arrangement",
      ].map((k) => [k, new Set<string>()]),
    );
    for (let i = 0; i < 256; i++) {
      const p = newProject({
        ...defaultSettings(),
        seed: `AUDIT-${String(i).padStart(3, "0")}`,
      });
      for (const [key, value] of Object.entries(signatures(p.candidates[0])))
        seen[key].add(value);
      seen.arrangement.add(hash(p.sections));
    }
    assert.ok(seen.melody.size >= 60);
    assert.ok(seen.harmony.size >= 4);
    assert.ok(seen.drums.size >= 128);
    assert.ok(seen.bass.size >= 18);
    assert.equal(seen.sounds.size, 3);
    assert.ok(seen.whole.size >= 200);
    assert.equal(seen.arrangement.size, 3);
  } finally {
    setPrivatePalette(priorPalette);
  }
});

test("mood, swing and drum density change real events while tempo changes elapsed duration", () => {
  const s = defaultSettings(),
    base = generateCandidates(s)[0];
  for (const mood of ["warm", "eerie"] as const) {
    const next = generateCandidates({ ...s, mood })[0];
    assert.notEqual(signatures(next).melody, signatures(base).melody);
    assert.notEqual(signatures(next).harmony, signatures(base).harmony);
  }
  const swung = generateCandidates({ ...s, swing: 0.6 })[0];
  assert.notDeepEqual(
    swung.tracks.find((t) => t.id === "hat")!.notes.map((n) => n.tick),
    base.tracks.find((t) => t.id === "hat")!.notes.map((n) => n.tick),
  );
  for (const t of base.tracks.filter((t) => t.id !== "hat"))
    assert.deepEqual(
      swung.tracks.find((x) => x.id === t.id),
      t,
    );
  const counts = [0.15, 0.52, 0.8].map(
    (density) =>
      generateCandidates({ ...s, density })[0].tracks.find(
        (t) => t.id === "hat",
      )!.notes.length,
  );
  assert.ok(counts[0] < counts[1] && counts[1] < counts[2]);
  const a = newProject(s),
    b = newProject({ ...s, bpm: 156 });
  assert.deepEqual(a.candidates, b.candidates);
  assert.ok((64 * 240) / b.settings.bpm < (64 * 240) / a.settings.bpm);
});

test("one through four chord controls write that many distinct roots in every supported mode", () => {
  for (const mode of Object.keys(SCALES) as (keyof typeof SCALES)[])
    for (const complexity of [1, 2, 3, 4])
      for (const mood of ["warm", "wistful", "eerie"] as const) {
        const p = newProject({ ...defaultSettings(), mode, complexity, mood });
        for (const c of p.candidates) {
          assert.equal(
            new Set(c.harmony.map((h) => h.root % 12)).size,
            complexity,
          );
          for (const n of c.tracks.find((t) => t.id === "bass")!.notes)
            assert.equal((n.pitch - chordAt(c.harmony, n.tick).root) % 12, 0);
        }
      }
});

test("seed changes retain locked pitched roles, harmony and user sound/mix edits; partial rewrites retain all other tracks", () => {
  for (const role of [
    "melody",
    "answer",
    "pad",
    "keys",
    "bridge",
    "pedal",
    "bass",
  ] as Role[]) {
    const p = newProject(),
      c = p.candidates[0],
      t = c.tracks.find((t) => t.id === role)!;
    t.locked = true;
    t.volume = 0.31;
    t.pan = role === "bass" ? 0 : -0.22;
    t.register = 12;
    const before = clone(c),
      next = generateCandidates(
        { ...p.settings, seed: "LOCK-CHANGE-34", mood: "warm" },
        p.candidates,
      )[0];
    assert.deepEqual(
      next.tracks.find((t) => t.id === role),
      before.tracks.find((t) => t.id === role),
    );
    assert.deepEqual(next.harmony, before.harmony);
  }
  const p = newProject(),
    lead = p.candidates[0].tracks.find((t) => t.id === "melody")!;
  lead.instrument = "user-choice";
  lead.volume = 0.37;
  lead.register = -12;
  delete lead.effects;
  const before = clone(p),
    next = rewrite(p, ["hat"]);
  for (const t of before.candidates[0].tracks)
    if (t.id !== "hat")
      assert.deepEqual(
        next.candidates[0].tracks.find((x) => x.id === t.id),
        t,
      );
  const regenerated = generateCandidates(
    { ...p.settings, seed: "EDIT-CHANGE-39" },
    p.candidates,
  )[0].tracks.find((t) => t.id === "melody")!;
  assert.equal(regenerated.instrument, "user-choice");
  assert.equal(regenerated.volume, 0.37);
  assert.equal(regenerated.register, -12);
  assert.equal(regenerated.effects, undefined);
});

test("stored schema-1 accepted project loads without regeneration; deliberate rewrites version the new behavior and retain edited form", () => {
  const original = JSON.parse(
    fs.readFileSync(
      "deliverables/character/baseline/accepted-project.ish.json",
      "utf8",
    ),
  );
  const before = clone(original),
    loaded = validateProject(original);
  assert.deepEqual(loaded, before);
  assert.equal(loaded.generator, before.generator);
  const priorScore = hash(score(loaded));
  assert.equal(hash(score(validateProject(clone(loaded)))), priorScore);
  loaded.sections[0].bars = 7;
  loaded.sections[0].name = "User entrance";
  loaded.candidates[loaded.selected].tracks.find(
    (t) => t.id === "melody",
  )!.locked = true;
  const next = rewrite(loaded, ["answer"]);
  assert.equal(next.generator, VERSION);
  assert.deepEqual(next.sections, loaded.sections);
  assert.deepEqual(
    next.candidates[next.selected].tracks.find((t) => t.id === "melody"),
    loaded.candidates[loaded.selected].tracks.find((t) => t.id === "melody"),
  );
  for (const section of newProject().sections)
    assert.ok(section.bars >= 1 && section.bars <= 64);
  assert.equal(
    newProject().sections.reduce((n, s) => n + s.bars * BAR, 0),
    64 * BAR,
  );
});
