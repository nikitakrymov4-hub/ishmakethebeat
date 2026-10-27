import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  validateProject,
  missingAssets,
  loadFile,
} from "../src/io/persistence";
import { AudioGraph } from "../src/audio/graph";
import { renderWav, exportStems, portableZip } from "../src/io/export";
import { rewrite } from "../src/engine/compose";
import { score } from "../src/engine/score";
import {
  BAR,
  seconds,
  type Project,
  type ScoreEvent,
  type SampleAsset,
} from "../src/engine/schema";
import { resumeSpanningClips, Transport } from "../src/audio/transport";
import { continuedSampleEnvelope } from "../src/audio/sample-continuation";
const original = JSON.parse(
  fs.readFileSync(
    "deliverables/aura-originals-20261016/daybreak-full.ish.json",
    "utf8",
  ),
) as Project;
const project = () => structuredClone(original);
const close = (a: number, b: number) =>
  assert.ok(Math.abs(a - b) < 1e-9, String(a) + " != " + b);
test("damaged Aura portable data fails validation/import, missingAssets, graph loading/scheduling, WAV/stems and ZIP export", async () => {
  const p = project();
  const id = "aura-instrument-vintage-piano";
  p.assets = p.assets.filter((a) => a.id !== id);
  assert.ok(missingAssets(p).length > 0);
  assert.throws(
    () => validateProject(p),
    /Missing required sample asset.*aura-/,
  );
  await assert.rejects(
    () => loadFile(new File([JSON.stringify(p)], "damaged.ish.json")),
    /Missing required sample asset/,
  );
  const fake = { project: p, roleEffects: new Map(), roleDelays: new Map() };
  await assert.rejects(
    () => AudioGraph.prototype.loadSamples.call(fake as unknown as AudioGraph),
    /Missing required sample asset/,
  );
  const event = score(p).find((e) => e.instrument === id)!;
  assert.throws(
    () =>
      AudioGraph.prototype.schedule.call(
        fake as unknown as AudioGraph,
        event,
        0,
      ),
    /Missing required sample asset/,
  );
  await assert.rejects(() => renderWav(p), /Missing required sample asset/);
  await assert.rejects(
    () => exportStems(p, new AbortController().signal, () => {}),
    /Missing required sample asset/,
  );
  assert.throws(() => portableZip(p), /Missing required sample asset/);
  assert.throws(() => rewrite(p, ["hat"]), /Missing required sample asset/);
});
test("legacy sample IDs remain required; known synth IDs and custom bank presets are not missing samples", () => {
  const p = project(),
    t = p.candidates[p.selected].tracks.find((t) => t.id === "melody")!;
  t.instrument = "rounded-keys";
  assert.doesNotThrow(() => validateProject(p));
  assert.deepEqual(missingAssets(p), []);
  t.instrument = "sample-lost";
  assert.ok(missingAssets(p).length > 0);
});
test("unrelated/locked Aura rewrites retain manual synth, sample, effects, register and exact edited notes", () => {
  for (const locked of [false, true]) {
    const p = project(),
      c = p.candidates[p.selected],
      melody = c.tracks.find((t) => t.id === "melody")!,
      keys = c.tracks.find((t) => t.id === "keys")!;
    melody.instrument = "rounded-keys";
    melody.locked = locked;
    melody.register = -12;
    melody.notes[0].velocity = 0.27;
    keys.instrument = p.assets.find(
      (a) => a.id.startsWith("aura-") && a.id !== keys.instrument,
    )!.id;
    keys.register = 12;
    keys.effects = {
      sampleEnvelope: { attack: 0.1, decay: 0.3, sustain: 0.4, release: 0.2 },
    };
    keys.notes[0].pitch += 12;
    validateProject(p);
    const next = rewrite(p, ["hat"]),
      nc = next.candidates[next.selected];
    for (const saved of c.tracks.filter((t) => t.id !== "hat"))
      assert.deepEqual(
        nc.tracks.find((t) => t.id === saved.id),
        saved,
      );
    assert.ok(
      nc.tracks.find((t) => t.id === "hat")!.revision >
        c.tracks.find((t) => t.id === "hat")!.revision,
    );
    const all = rewrite(p),
      mc = all.candidates[all.selected].tracks.find((t) => t.id === "melody")!;
    assert.equal(mc.instrument, "rounded-keys");
    assert.equal(mc.register, -12);
    if (locked) assert.deepEqual(mc, melody);
    assert.deepEqual(validateProject(next), next);
  }
});
const a: SampleAsset = {
  id: "aura-test",
  name: "pad",
  role: "pad",
  root: 60,
  tuning: 0,
  trimStart: 0.2,
  trimEnd: 12.2,
  gain: 1,
  choke: "",
  data: "",
  license: "test",
  envelopeMode: "gated",
};
const e: ScoreEvent = {
  id: "pad",
  instrument: a.id,
  role: "pad",
  tick: 0,
  duration: 5760,
  pitch: 60,
  velocity: 1,
  gain: 1,
  pan: 0,
  filter: 1,
};
const p = { settings: { bpm: 120 }, assets: [a] } as Pick<
  Project,
  "settings" | "assets"
>;
test("gated pitched continuation keeps source and original envelope phase at root and +/- octave with tuning", () => {
  for (const pitch of [48, 60, 72])
    for (const tuning of [-37, 0, 64]) {
      const rate = 2 ** ((pitch - 60 + tuning / 100) / 12),
        r = resumeSpanningClips([{ ...e, pitch }], 960, {
          ...p,
          assets: [{ ...a, tuning }],
        })[0];
      close(r.sourceOffset!, 0.2 + rate);
      close(r.sourceDuration!, 12 - rate);
      close(r.envelopeOffsetSeconds!, 1);
      close(r.envelopeDurationSeconds!, Math.min(6, 12 / rate));
      assert.equal(r.duration, 4800);
      const twice = resumeSpanningClips([r], 1440, {
        ...p,
        assets: [{ ...a, tuning }],
      })[0];
      close(twice.sourceOffset!, 0.2 + rate * 1.5);
      close(twice.envelopeOffsetSeconds!, 1.5);
    }
});
test("gated sample continuation excludes exhausted, synth, one-shot, looped and bass-glide paths", () => {
  assert.deepEqual(resumeSpanningClips([e], 5760, p), []);
  assert.deepEqual(resumeSpanningClips([{ ...e, pitch: 84 }], 3840, p), []);
  for (const event of [
    { ...e, instrument: "rounded-keys" },
    { ...e, role: "bass" as const },
    { ...e, reverse: true },
    { ...e, glide: { to: 72, at: 240, ms: 100 } },
  ])
    assert.deepEqual(resumeSpanningClips([event], 960, p), []);
  for (const asset of [
    { ...a, loop: true },
    { ...a, envelopeMode: "one-shot" as const },
  ])
    assert.deepEqual(
      resumeSpanningClips([e], 960, { ...p, assets: [asset] }),
      [],
    );
});
test("continuation ADSR starts in decay/sustain/release rather than retriggering attack", () => {
  const points = continuedSampleEnvelope(6, 1, 1, 0.1, 0.3, 0.4, 0.2);
  close(points[0].gain, 0.4);
  assert.ok(!points.some((p) => p.gain === 1));
  close(
    continuedSampleEnvelope(6, 0.25, 1, 0.1, 0.3, 0.4, 0.2)[0].gain,
    Math.sqrt(0.4),
  );
  close(
    continuedSampleEnvelope(6, 5.9, 1, 0.1, 0.3, 0.4, 0.2)[0].gain,
    Math.sqrt(0.4 * 0.00001),
  );
});
test("actual Daybreak held pads resume at bar two through the shared pause/swap scheduling path", () => {
  const p = project(),
    events = score(p),
    offset = BAR,
    spanning = events.filter(
      (e) =>
        e.role === "pad" && e.tick < offset && e.tick + e.duration > offset,
    );
  assert.equal(spanning.length, 2);
  const resumed = resumeSpanningClips(spanning, offset, p);
  assert.equal(resumed.length, 2);
  for (let i = 0; i < resumed.length; i++) {
    const asset = p.assets.find((a) => a.id === spanning[i].instrument)!,
      rate = 2 ** ((spanning[i].pitch - asset.root + asset.tuning / 100) / 12);
    close(
      resumed[i].sourceOffset!,
      asset.trimStart +
        seconds(offset - spanning[i].tick, p.settings.bpm) * rate,
    );
    assert.ok(resumed[i].sourceDuration! > 6);
    assert.equal(resumed[i].envelopeDurationSeconds, 6);
  }
  const transport = new Transport() as any,
    scheduled: ScoreEvent[] = [];
  const count = transport.resumeClips(
    p,
    offset,
    10,
    { schedule: (event: ScoreEvent) => scheduled.push(event) },
    spanning,
  );
  assert.equal(count, 2);
  assert.deepEqual(scheduled, resumed);
});

test("playback preflight ignores unused legacy fixture assignments but refuses scheduled missing sources", async () => {
  const p = project();
  for (const c of p.candidates) for (const t of c.tracks) t.notes = [];
  p.assets = [];
  // An empty score has no sample sound to substitute; direct event scheduling still refuses missing IDs.
  await assert.doesNotReject(() =>
    AudioGraph.prototype.loadSamples.call({
      project: p,
    } as unknown as AudioGraph),
  );
  p.candidates[p.selected].tracks.find((t) => t.id === "melody")!.notes = [
    { id: "required", tick: 0, duration: 120, pitch: 60, velocity: 0.5 },
  ];
  await assert.rejects(
    () =>
      AudioGraph.prototype.loadSamples.call({
        project: p,
      } as unknown as AudioGraph),
    /Missing required sample asset/,
  );
});
