import test from "node:test";
import assert from "node:assert/strict";
import { parseMidi } from "midi-file";
import {
  newProject,
  generateCandidates,
  rewrite,
  chordAt,
} from "../src/engine/compose";
import { defaultSettings, GROOVES } from "../src/engine/profiles";
import { BAR, LOOP_TICKS, PPQ, SCALES, clone } from "../src/engine/schema";
import type { ProfileId } from "../src/engine/schema";
import { score, totalTicks } from "../src/engine/score";
import { exportMidi } from "../src/io/midi";
import { encodeWav } from "../src/io/wav";
import { validateProject, missingAssets } from "../src/io/persistence";

test("same seed and complete settings reproduce score, instruments, and noise identities", () => {
  for (const id of [
    "culture",
    "airy",
    "spacey",
    "bright",
    "dark",
  ] as ProfileId[])
    assert.deepEqual(
      generateCandidates(defaultSettings(id)),
      generateCandidates(defaultSettings(id)),
    );
});

test("Generate repeats unlocked scores; explicit Rewrite alone advances per-part revisions", () => {
  for (const id of [
    "culture",
    "airy",
    "spacey",
    "bright",
    "dark",
  ] as ProfileId[]) {
    const settings = defaultSettings(id),
      first = generateCandidates(settings);
    assert.deepEqual(generateCandidates(settings, first), first);
    const p = newProject(settings),
      changed = rewrite(p, ["bass"]);
    assert.equal(changed.candidates[0].tracks[3].revision, 1);
    assert.equal(changed.candidates[0].tracks[0].revision, 0);
  }
});
test("every profile owns six distinct authored two-bar grooves", () => {
  for (const grooves of Object.values(GROOVES)) {
    assert.equal(grooves.length, 6);
    assert.equal(new Set(grooves.map((g) => JSON.stringify(g))).size, 6);
    for (const g of grooves)
      for (const key of [
        "kick",
        "clap",
        "hat",
        "open",
        "perc",
        "bass",
      ] as const)
        assert.ok(g[key].every((x) => x >= 0 && x < 32));
  }
});
test("generated notes fit the loop; bass is monophonic and follows actual roots in every key/mode", () => {
  for (const id of [
    "culture",
    "airy",
    "spacey",
    "bright",
    "dark",
  ] as ProfileId[])
    for (let key = 0; key < 12; key++)
      for (const mode of Object.keys(SCALES) as (keyof typeof SCALES)[]) {
        const settings = { ...defaultSettings(id), key, mode, complexity: 4 };
        for (const c of generateCandidates(settings)) {
          for (const t of c.tracks)
            for (const n of t.notes) {
              assert.ok(
                n.tick >= 0 &&
                  n.duration > 0 &&
                  n.tick + n.duration <= LOOP_TICKS,
                `${id}/${t.id} out of bounds`,
              );
              assert.ok(n.pitch >= 0 && n.pitch <= 127);
              assert.ok(Number.isInteger(n.tick));
            }
          const bass = c.tracks.find((t) => t.id === "bass")!.notes;
          bass.forEach((n, i) => {
            assert.ok((n.pitch - chordAt(c.harmony, n.tick).root) % 12 === 0);
            assert.ok(n.pitch >= 28 && n.pitch <= 43);
            if (i) assert.ok(bass[i - 1].tick + bass[i - 1].duration <= n.tick);
            if (n.glide) assert.ok(n.glide.at < n.duration);
          });
        }
      }
});
test("candidate loops differ; motifs retain meaningful repetition and ending developments", () => {
  for (const id of [
    "culture",
    "airy",
    "spacey",
    "bright",
    "dark",
  ] as ProfileId[]) {
    const c = generateCandidates(defaultSettings(id));
    assert.equal(new Set(c.map((x) => JSON.stringify(x.tracks))).size, 3);
    for (const idea of c) {
      assert.ok(idea.metrics.continuity >= 0.5);
      assert.equal(idea.metrics.bassConsistency, 1);
    }
  }
});
test("partial regeneration preserves locked event data, instrument and harmonic dependencies", () => {
  const p = newProject();
  const c = p.candidates[0];
  c.tracks.find((t) => t.id === "melody")!.locked = true;
  c.tracks.find((t) => t.id === "bass")!.locked = true;
  const before = clone(c);
  const next = rewrite(p);
  assert.deepEqual(next.candidates[0].tracks[0], before.tracks[0]);
  assert.deepEqual(next.candidates[0].tracks[3], before.tracks[3]);
  assert.deepEqual(next.candidates[0].harmony, before.harmony);
  assert.deepEqual(next.candidates[1], p.candidates[1]);
  const drums = rewrite(p, ["hat"]);
  for (const t of c.tracks)
    if (t.id !== "hat")
      assert.deepEqual(
        drums.candidates[0].tracks.find((x) => x.id === t.id),
        t,
      );
});
test("arrangement is 64 bars, reflects edits, and applies section presence and filters", () => {
  const p = newProject();
  p.arrangement = true;
  assert.equal(totalTicks(p), 64 * BAR);
  const s = score(p);
  assert.ok(s.length > 500);
  assert.ok(s.every((n) => n.tick + n.duration <= 64 * BAR));
  assert.ok(!s.some((n) => n.role === "bass" && n.tick < 4 * BAR));
  assert.ok(s.some((n) => n.filter < 1));
  p.sections[0].bars = 8;
  assert.equal(totalTicks(p), 68 * BAR);
  p.arrangement = false;
  const first = p.candidates[0].tracks[0].notes[0];
  first.pitch = 77;
  assert.equal(
    score(p).find((n) => n.role === "melody" && n.tick === first.tick)!.pitch,
    77,
  );
});
test("MIDI round-trips type, PPQ, tempo, signature, names, notes and actual bend/reset events", () => {
  for (const arrangement of [false, true]) {
    const p = newProject();
    p.arrangement = arrangement;
    const parsed = parseMidi(exportMidi(p));
    assert.equal(parsed.header.format, 1);
    assert.equal(parsed.header.ticksPerBeat, PPQ);
    assert.equal(
      parsed.tracks.length,
      p.candidates[p.selected].tracks.length + 1,
    );
    assert.ok(
      parsed.tracks[0].some(
        (e) =>
          e.type === "setTempo" &&
          e.microsecondsPerBeat === Math.round(60000000 / 148),
      ),
    );
    assert.ok(
      parsed.tracks[0].some(
        (e) =>
          e.type === "timeSignature" &&
          e.numerator === 4 &&
          e.denominator === 4,
      ),
    );
    const actual = parsed.tracks.flat().filter((e) => e.type === "noteOn");
    assert.equal(actual.length, score(p).length);
    for (const track of parsed.tracks) {
      assert.ok(track.some((e) => e.type === "trackName"));
      assert.equal(
        track.reduce((n, e) => n + e.deltaTime, 0),
        totalTicks(p),
      );
    }
    const bass = parsed.tracks[4];
    assert.ok(bass.some((e) => e.type === "pitchBend" && e.value !== 0));
    assert.ok(
      bass.some(
        (e) =>
          e.type === "controller" && e.controllerType === 6 && e.value === 24,
      ),
    );
    assert.ok(
      bass.filter((e) => e.type === "pitchBend").every((e) => e.channel === 3),
    );
    let tick = 0;
    const midiNotes = parsed.tracks[1].flatMap((e) => {
      tick += e.deltaTime;
      return e.type === "noteOn"
        ? [{ tick, pitch: e.noteNumber, velocity: e.velocity }]
        : [];
    });
    assert.deepEqual(
      midiNotes.map((n) => [n.tick, n.pitch]),
      score(p)
        .filter((e) => e.role === "melody")
        .map((e) => [e.tick, e.pitch]),
    );
  }
});
test("24-bit PCM WAV header and signed sample data are correct", () => {
  const wav = encodeWav(
      [Float32Array.from([0, 0.5, -0.5, 1, -1]), new Float32Array(5)],
      44100,
    ),
    v = new DataView(wav.buffer);
  assert.equal(wav.length, 44 + 5 * 2 * 3);
  assert.equal(new TextDecoder().decode(wav.slice(0, 4)), "RIFF");
  assert.equal(v.getUint16(20, true), 1);
  assert.equal(v.getUint16(22, true), 2);
  assert.equal(v.getUint16(34, true), 24);
  assert.equal(v.getUint32(24, true), 44100);
  assert.equal(v.getUint32(28, true), 44100 * 6);
  assert.equal(v.getUint32(40, true), 30);
  assert.equal(wav[44 + 6 + 2], 64);
  assert.equal(wav[44 + 12 + 2], 192);
});
test("project validation round-trips edits and visibly identifies missing imported assets", () => {
  const p = newProject();
  p.candidates[0].tracks[0].notes[0].velocity = 0.33;
  assert.deepEqual(validateProject(JSON.parse(JSON.stringify(p))), p);
  p.candidates[0].tracks[0].instrument = "sample-missing";
  assert.deepEqual(missingAssets(p), ["Main melody"]);
  assert.throws(() => validateProject({ ...p, schema: 999 }));
  const bad = clone(p);
  bad.candidates[0].tracks[0].notes[0].tick = Infinity;
  assert.throws(() => validateProject(bad));
});
