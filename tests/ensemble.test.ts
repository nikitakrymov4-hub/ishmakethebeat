import test from "node:test";
import assert from "node:assert/strict";
import {
  newProject,
  rewrite,
  chordAt,
  generateCandidates,
} from "../src/engine/compose";
import { defaultSettings } from "../src/engine/profiles";
import { getPrivatePalette } from "../src/engine/culture";
import {
  coordinateEnsemble,
  compatiblePedal,
  PALETTE_SHORTLIST,
  upgradeEnsemble,
} from "../src/engine/ensemble";
import { BAR, LOOP_TICKS, clone, seconds } from "../src/engine/schema";
import type { Role, SampleAsset } from "../src/engine/schema";

test("the accepted 28-note motif survives instrumentation upgrades exactly, including the edited velocity", () => {
  const original = newProject(),
    lead = original.candidates[0].tracks.find((t) => t.id === "melody")!;
  // The user's exported melody: 8-bar form, with later first-note changes.
  const rhythm = [120, 600, 1080, 1800, 2400, 2760, 3240],
    pitches = [69, 73, 71, 68, 66, 69, 68],
    durations = [420, 180, 300, 300, 180, 300, 300];
  lead.notes = Array.from({ length: 28 }, (_, i) => ({
    id: `accepted-${i}`,
    tick: Math.floor(i / 7) * BAR * 2 + rhythm[i % 7],
    duration: durations[i % 7],
    pitch: i === 14 ? 78 : i === 21 ? 71 : pitches[i % 7],
    velocity: i === 0 ? 0.52 : 0.7,
  }));
  const before = clone(original);
  for (const group of [0, 1, 2]) {
    const upgraded = upgradeEnsemble(original, getPrivatePalette(), group);
    assert.deepEqual(
      upgraded.candidates[0].tracks.find((t) => t.id === "melody")!.notes,
      lead.notes,
    );
    assert.deepEqual(
      upgraded.candidates[0].harmony,
      before.candidates[0].harmony,
    );
    assert.equal(upgraded.candidates[0].tracks.length, 12);
  }
  assert.deepEqual(original, before);
});

test("bell answers enter real gaps; held pedals are consonant throughout their region", () => {
  for (const candidate of newProject().candidates) {
    const melody = candidate.tracks.find((t) => t.id === "melody")!.notes;
    const bell = candidate.tracks.find((t) => t.id === "answer")!.notes;
    assert.ok(bell.length > 0);
    for (const n of bell)
      assert.ok(
        !melody.some((m) => n.tick >= m.tick && n.tick < m.tick + m.duration),
      );
    const plan = candidate.phrasePlan!;
    assert.ok(plan.events.some((e) => e.kind === "call"));
    assert.ok(plan.events.some((e) => e.kind === "rest"));
    assert.ok(plan.events.some((e) => e.kind === "answer"));
    for (const note of candidate.tracks.find((t) => t.id === "pedal")!.notes) {
      for (const chord of candidate.harmony.filter(
        (h) =>
          h.tick < note.tick + note.duration && h.tick + h.duration > note.tick,
      ))
        assert.ok(chord.pitches.some((p) => (p - note.pitch) % 12 === 0));
    }
  }
  const local = compatiblePedal(
    [
      { tick: 0, duration: BAR, root: 36, pitches: [48, 52, 55] },
      { tick: BAR, duration: BAR, root: 38, pitches: [50, 53, 57] },
    ],
    0,
    BAR * 2,
  );
  assert.equal(local.end, BAR);
});

test("new ensemble roles retain locks and independent part rewrites preserve all other event/effect data", () => {
  const project = newProject(),
    c = project.candidates[0];
  for (const role of ["keys", "bridge", "pedal"] as Role[])
    c.tracks.find((t) => t.id === role)!.locked = true;
  const before = clone(c),
    revised = rewrite(project, ["hat"]).candidates[0];
  assert.deepEqual(revised.harmony, before.harmony);
  for (const track of before.tracks)
    if (track.id !== "hat")
      assert.deepEqual(
        revised.tracks.find((t) => t.id === track.id),
        track,
      );
  assert.notDeepEqual(
    revised.tracks.find((t) => t.id === "hat")!.notes,
    before.tracks.find((t) => t.id === "hat")!.notes,
  );
  const all = rewrite(project).candidates[0];
  for (const role of ["keys", "bridge", "pedal"] as Role[])
    assert.deepEqual(
      all.tracks.find((t) => t.id === role),
      before.tracks.find((t) => t.id === role),
    );
});

test("regeneration retains an edited register and deliberately dry role processing", () => {
  const p = newProject(),
    lead = p.candidates[0].tracks.find((t) => t.id === "melody")!,
    keys = p.candidates[0].tracks.find((t) => t.id === "keys")!;
  lead.register = -12;
  delete lead.effects;
  keys.register = 12;
  delete keys.effects;
  const next = generateCandidates(p.settings, p.candidates)[0];
  assert.equal(next.tracks.find((t) => t.id === "melody")!.register, -12);
  assert.equal(next.tracks.find((t) => t.id === "keys")!.register, 12);
  assert.equal(next.tracks.find((t) => t.id === "melody")!.effects, undefined);
  assert.equal(next.tracks.find((t) => t.id === "keys")!.effects, undefined);
});

test("sound groups select a coherent three-source set; authored hats rest and bass lands on the actual harmony", () => {
  const assets = PALETTE_SHORTLIST.flatMap((group, i) =>
    (["bass", "clap", "hat"] as const).map(
      (role) =>
        ({
          id: `group-${i}-${role}`,
          name: group[role][0],
          role,
        }) as SampleAsset,
    ),
  );
  const settings = defaultSettings();
  for (let i = 0; i < 3; i++) {
    const candidate = coordinateEnsemble(
      newProject(settings).candidates[0],
      settings,
      assets,
      i,
      { forcePalette: true },
    );
    for (const role of ["bass", "clap", "hat"] as const)
      assert.equal(
        candidate.tracks.find((t) => t.id === role)!.instrument,
        `group-${i}-${role}`,
      );
    const hats = candidate.tracks.find((t) => t.id === "hat")!.notes;
    assert.ok(hats.every((n) => n.tick % 60 === 0));
    assert.ok(hats.some((n, j) => j > 0 && n.tick - hats[j - 1].tick >= 480));
    assert.equal(
      candidate.phrasePlan!.events.filter(
        (e) => e.role === "hat" && e.kind === "gesture",
      ).length,
      1,
    );
    const claps = candidate.tracks.find((t) => t.id === "clap")!.notes;
    assert.deepEqual(
      claps.map((n) => n.tick),
      Array.from({ length: 8 }, (_, bar) => bar * BAR + 960),
    );
    const bass = candidate.tracks.find((t) => t.id === "bass")!.notes;
    bass.forEach((n, j) => {
      assert.equal((n.pitch - chordAt(candidate.harmony, n.tick).root) % 12, 0);
      if (j > 0) assert.ok(bass[j - 1].tick + bass[j - 1].duration <= n.tick);
      if (n.glide) {
        assert.equal(n.articulation, "legato");
        assert.ok(n.glide.at < n.duration);
      }
    });
    assert.ok(bass.some((n) => n.glide));
  }
});

test("the simple option and explicit half-time grid remain meaningful without rewriting the motif", () => {
  const full = newProject(),
    settings = {
      ...full.settings,
      ensembleMode: "simple" as const,
      grid: "half-time" as const,
      bpm: 75,
    };
  const simple = coordinateEnsemble(full.candidates[0], settings, [], 0, {
    forcePalette: true,
  });
  for (const role of ["pad", "bridge", "pedal"] as const)
    assert.equal(simple.tracks.find((t) => t.id === role)!.notes.length, 0);
  assert.deepEqual(
    simple.tracks.find((t) => t.id === "melody")!.notes,
    full.candidates[0].tracks.find((t) => t.id === "melody")!.notes,
  );
  assert.equal(simple.phrasePlan!.grid, "half-time");
  assert.equal(seconds(LOOP_TICKS, 75), 2 * seconds(LOOP_TICKS, 150));
});
