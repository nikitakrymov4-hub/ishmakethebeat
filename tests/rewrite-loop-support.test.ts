import test from "node:test";
import assert from "node:assert/strict";
import { newProject, DRUM_ROLES } from "../src/engine/compose";
import { BAR, clone, isDrum } from "../src/engine/schema";
import type { Note, Track } from "../src/engine/schema";
import { LOOP_BEAT_GENERATOR } from "../src/io/loop-beat";
import { rewriteLoopSupport } from "../src/io/rewrite-loop-support";

const controls = ({ notes: _notes, ...rest }: Track) => rest;
const phrase = (notes: Note[]) =>
  notes.map(({ tick, duration, pitch, articulation }) => ({
    tick,
    duration,
    pitch,
    articulation,
  }));
function fixture() {
  const p = newProject();
  p.sourceKind = "supplied-loop";
  p.generator = LOOP_BEAT_GENERATOR;
  p.selected = 2;
  p.vocalEvents = [];
  p.tagEnabled = true;
  p.voxEnabled = true;
  for (const [index, c] of p.candidates.entries()) {
    for (const track of c.tracks) {
      track.volume = 0.2 + index * 0.1;
      track.pan = -0.2 + index * 0.2;
      track.revision = index + 2;
      if (track.id !== "bass" && !isDrum(track.id)) track.notes = [];
    }
    c.tracks.find((t) => t.id === "bass")!.notes = Array.from(
      { length: 8 },
      (_, bar) => ({
        id: `manual-${index}-${bar}`,
        tick: bar * BAR + 60 + index * 30,
        duration: 300,
        pitch: 36,
        velocity: 0.7,
      }),
    );
  }
  p.candidates[1].tracks.find((t) => t.id === "hat")!.locked = true;
  return p;
}

test("drum-only rewrites follow retained edited bass in each candidate, preserving individual palettes and controls", () => {
  const before = fixture(),
    snapshot = JSON.stringify(before);
  const next = rewriteLoopSupport(before, DRUM_ROLES, "RETAINED-BASS-TEST");
  assert.equal(JSON.stringify(before), snapshot);
  assert.equal(next.selected, before.selected);
  assert.deepEqual(next.assets, before.assets);
  assert.deepEqual(next.clips, before.clips);
  assert.deepEqual(next.sections, before.sections);
  assert.deepEqual(next.vocalEvents, before.vocalEvents);
  assert.equal(next.tagEnabled, true);
  assert.equal(next.voxEnabled, true);
  for (const [index, c] of next.candidates.entries()) {
    const old = before.candidates[index];
    for (const t of c.tracks) {
      const oldTrack = old.tracks.find((n) => n.id === t.id)!;
      assert.deepEqual(controls(t), controls(oldTrack));
      if (!isDrum(t.id) || t.locked) assert.deepEqual(t, oldTrack);
    }
    const bassTicks = new Set(
      c.tracks.find((t) => t.id === "bass")!.notes.map((n) => n.tick),
    );
    const kicks = c.tracks.find((t) => t.id === "kick")!.notes;
    assert.ok(kicks.filter((n) => !bassTicks.has(n.tick)).length <= 1);
    assert.ok(kicks.filter((n) => bassTicks.has(n.tick)).length >= 8);
  }
});

test("New 808 phrase changes an unlocked phrase while keeping every drum and locked bass edit", () => {
  const p = fixture();
  p.candidates[1].tracks.find((t) => t.id === "bass")!.locked = true;
  const first = rewriteLoopSupport(p, ["bass"], "BASS-PHRASE-1");
  const second = rewriteLoopSupport(first, ["bass"], "BASS-PHRASE-2");
  for (const [index, c] of second.candidates.entries()) {
    for (const t of c.tracks) {
      const original = p.candidates[index].tracks.find((x) => x.id === t.id)!;
      assert.deepEqual(controls(t), controls(original));
      if (t.id !== "bass" || t.locked) assert.deepEqual(t, original);
      else
        assert.notDeepEqual(
          phrase(t.notes),
          phrase(
            first.candidates[index].tracks.find((x) => x.id === "bass")!.notes,
          ),
        );
    }
  }
});

test("individual hat rewrites and saved density controls leave unrequested notes untouched", () => {
  const p = fixture();
  p.settings.density = 0;
  p.settings.variation = 0;
  const next = rewriteLoopSupport(p, ["hat"], "JUST-HATS");
  for (const [index, c] of next.candidates.entries())
    for (const t of c.tracks) {
      const old = p.candidates[index].tracks.find((x) => x.id === t.id)!;
      if (t.id !== "hat" || t.locked) assert.deepEqual(t, old);
      else {
        assert.equal(t.notes.length, 64);
        assert.ok(t.notes.every((n) => n.drumPitch === undefined));
        assert.deepEqual(controls(t), controls(old));
      }
    }
});

test("all-support rewrite remains deterministic and rejects melody or non-loop requests", () => {
  const p = fixture();
  assert.deepEqual(
    rewriteLoopSupport(p, undefined, "ALL"),
    rewriteLoopSupport(p, undefined, "ALL"),
  );
  const next = rewriteLoopSupport(p, undefined, "ALL");
  for (const c of next.candidates) {
    const bass = new Set(
      c.tracks.find((t) => t.id === "bass")!.notes.map((n) => n.tick),
    );
    assert.ok(
      c.tracks
        .find((t) => t.id === "kick")!
        .notes.filter((n) => !bass.has(n.tick)).length <= 1,
    );
  }
  assert.throws(
    () => rewriteLoopSupport(p, ["melody"], "BAD"),
    /source melody/,
  );
  assert.throws(() => rewriteLoopSupport(p, DRUM_ROLES, ""), /seed/);
  const original = clone(p);
  original.sourceKind = "original-score";
  assert.throws(
    () => rewriteLoopSupport(original, DRUM_ROLES, "BAD"),
    /sample-based beat/,
  );
});
