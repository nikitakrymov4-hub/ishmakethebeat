import test from "node:test";
import assert from "node:assert/strict";
import { BAR, LOOP_TICKS, PPQ } from "../src/engine/schema";
import type { Note } from "../src/engine/schema";
import {
  loopSupportRhythm,
  SUPPORT_ROLES,
} from "../src/engine/loop-support-rhythm";

const options = {
  seed: "PROMO-STATIC-145-03",
  candidate: 0 as const,
  root: 33,
};
const cellTicks = BAR * 2;
const stepsIn = (notes: { tick: number }[], cell: number) =>
  notes
    .filter(
      (n) => n.tick >= cell * cellTicks && n.tick < (cell + 1) * cellTicks,
    )
    .map((n) => (n.tick - cell * cellTicks) / (PPQ / 4));

test("demonstration-based option repeats its coherent two-bar hat grid and retains every backbeat", () => {
  const rhythm = loopSupportRhythm(options);
  const expected = [
    0, 2, 4, 5, 6, 8, 10, 12, 13, 14, 16, 18, 20, 22, 24, 26, 28, 30,
  ];
  for (const cell of [0, 1, 2])
    assert.deepEqual(stepsIn(rhythm.notes.hat, cell), expected);
  assert.notDeepEqual(stepsIn(rhythm.notes.hat, 3), expected);
  for (let cell = 0; cell < 4; cell++) {
    assert.deepEqual(stepsIn(rhythm.notes.clap, cell), [8, 14, 24]);
    const hits = rhythm.notes.clap.slice(cell * 3, cell * 3 + 3);
    assert.ok(
      hits[1].velocity < hits[0].velocity &&
        hits[1].velocity < hits[2].velocity,
    );
  }
  const rolls = rhythm.notes.hat.filter((n) => n.drumPitch !== undefined);
  assert.equal(rolls.length, 3);
  assert.ok(rolls.every((n) => n.drumPitch === 1 && n.tick >= 3 * cellTicks));
  assert.equal(rolls[1].tick - rolls[0].tick, PPQ / 8);
  assert.equal(rolls[2].tick - rolls[1].tick, PPQ / 8);
});

test("bass gates leave real rests; kicks chiefly reinforce actual bass attacks", () => {
  for (const candidate of [0, 1, 2] as const) {
    const rhythm = loopSupportRhythm({ ...options, candidate });
    const bass = rhythm.notes.bass;
    for (let i = 0; i < bass.length; i++) {
      assert.ok(
        (bass[i + 1]?.tick ?? LOOP_TICKS) - bass[i].tick - bass[i].duration >=
          PPQ / 4,
      );
      assert.ok([33, 40].includes(bass[i].pitch));
      assert.equal(bass[i].articulation, "retrigger");
    }
    const onsets = new Set(bass.map((n) => n.tick));
    const independent = rhythm.notes.kick.filter((n) => !onsets.has(n.tick));
    assert.ok(independent.length <= 1);
    assert.ok(
      (rhythm.notes.kick.length - independent.length) /
        rhythm.notes.kick.length >=
        0.8,
    );
    const claps = new Set(rhythm.notes.clap.map((n) => n.tick));
    assert.ok(rhythm.notes.perc.every((n) => !claps.has(n.tick)));
  }
  const bass = loopSupportRhythm(options).notes.bass;
  assert.deepEqual(stepsIn(bass, 0), [0, 10, 14]);
  assert.equal((bass[1].tick + bass[1].duration) / PPQ, 3);
  assert.equal(bass[2].tick / PPQ, 3.5);
});

test("candidate answers differ in role; variation zero removes answers without removing anchors", () => {
  const a = loopSupportRhythm(options);
  const b = loopSupportRhythm({ ...options, candidate: 1 });
  const c = loopSupportRhythm({ ...options, candidate: 2 });
  assert.ok(a.notes.hat.some((n) => n.drumPitch === 1));
  assert.ok(
    !b.notes.hat.some((n) => n.drumPitch) &&
      !c.notes.hat.some((n) => n.drumPitch),
  );
  assert.notDeepEqual(stepsIn(b.notes.bass, 0), stepsIn(b.notes.bass, 3));
  assert.notDeepEqual(stepsIn(c.notes.perc, 0), stepsIn(c.notes.perc, 3));
  for (const candidate of [0, 1, 2] as const) {
    const plain = loopSupportRhythm({ ...options, candidate, variation: 0 });
    assert.ok(plain.notes.hat.every((n) => n.drumPitch === undefined));
    assert.deepEqual(
      stepsIn(plain.notes.bass, 0),
      stepsIn(plain.notes.bass, 3),
    );
    if (candidate === 2)
      assert.deepEqual(
        stepsIn(plain.notes.perc, 0),
        stepsIn(plain.notes.perc, 3),
      );
    for (let bar = 0; bar < 8; bar++)
      assert.ok(plain.notes.clap.some((n) => n.tick === bar * BAR + PPQ * 2));
  }
});

test("density changes optional support and variation changes phrase answers, not the core backbeat", () => {
  const sparse = loopSupportRhythm({ ...options, density: 0, variation: 0 });
  const full = loopSupportRhythm({ ...options, density: 1, variation: 1 });
  assert.equal(sparse.notes.clap.length, 8);
  assert.equal(sparse.notes.hat.length, 64);
  assert.equal(sparse.notes.open.length, 0);
  assert.equal(sparse.notes.perc.length, 0);
  assert.ok(full.notes.open.length > sparse.notes.open.length);
  assert.ok(full.notes.perc.length > sparse.notes.perc.length);
  assert.equal(full.notes.hat.filter((n) => n.drumPitch === 1).length, 6);
  assert.deepEqual(full.notes.bass, sparse.notes.bass);
});

test("locked edited bass determines kick attacks without mutating the supplied notes", () => {
  const lockedBass: Note[] = Array.from({ length: 8 }, (_, i) => ({
    id: `edited-${i}`,
    tick: i * BAR + 180,
    duration: 360,
    pitch: 33,
    velocity: 0.6,
  }));
  const before = JSON.stringify(lockedBass);
  const rhythm = loopSupportRhythm({ ...options, lockedBass });
  assert.equal(JSON.stringify(lockedBass), before);
  const onsets = new Set(lockedBass.map((n) => n.tick));
  assert.ok(rhythm.notes.kick.filter((n) => !onsets.has(n.tick)).length <= 1);
  assert.equal(rhythm.notes.kick.filter((n) => onsets.has(n.tick)).length, 8);
  assert.deepEqual(rhythm.notes.hat, loopSupportRhythm(options).notes.hat);
  assert.deepEqual(
    loopSupportRhythm({ ...options, lockedBass: [] }).notes.kick,
    [],
  );
});

test("seeds reproduce notes and choices stay inside an editable eight-bar score", () => {
  assert.deepEqual(loopSupportRhythm(options), loopSupportRhythm(options));
  assert.notDeepEqual(
    loopSupportRhythm(options).notes,
    loopSupportRhythm({ ...options, seed: "OTHER" }).notes,
  );
  for (let seed = 0; seed < 24; seed++)
    for (const candidate of [0, 1, 2] as const) {
      const rhythm = loopSupportRhythm({
        ...options,
        seed: `CHECK-${seed}`,
        candidate,
      });
      for (const role of SUPPORT_ROLES) {
        const notes = rhythm.notes[role];
        assert.equal(new Set(notes.map((n) => n.tick)).size, notes.length);
        for (const [i, n] of notes.entries()) {
          assert.ok(
            Number.isInteger(n.tick) && n.tick >= 0 && n.tick < LOOP_TICKS,
          );
          assert.ok(n.duration > 0 && n.tick + n.duration <= LOOP_TICKS);
          assert.ok(n.velocity > 0 && n.velocity <= 1);
          assert.ok(n.tick + n.duration <= (notes[i + 1]?.tick ?? LOOP_TICKS));
        }
      }
    }
});
