import test from "node:test";
import assert from "node:assert/strict";
import { resumeSpanningClips } from "../src/audio/transport";
import { vocalFadePoints } from "../src/audio/processing";
import type { ScoreEvent, SampleAsset, Project } from "../src/engine/schema";

const asset: SampleAsset = {
  id: "sample-clip",
  name: "fixture",
  data: "",
  role: "loop",
  root: 60,
  tuning: 0,
  trimStart: 0.2,
  trimEnd: 8.2,
  gain: 1,
  choke: "",
  license: "Original test fixture",
};
const project = (tuning = 0) =>
  ({ settings: { bpm: 120 }, assets: [{ ...asset, tuning }] }) as Pick<
    Project,
    "settings" | "assets"
  >;
const event: ScoreEvent = {
  id: "phrase",
  role: "loop",
  busId: "loop:phrase",
  instrument: asset.id,
  tick: 480,
  duration: 3840,
  pitch: 60,
  velocity: 1,
  gain: 0.6,
  pan: 0.2,
  filter: 1,
  sourceOffset: 0.2,
  sourceDuration: 8,
  effectTick: 120,
};
const close = (actual: number, expected: number) =>
  assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} ≠ ${expected}`);

test("native audio continuation preserves routing and consumes the correct forward source region", () => {
  const original = structuredClone(event),
    result = resumeSpanningClips([event], 1440, project());
  assert.equal(result.length, 1);
  const resumed = result[0];
  assert.equal(resumed.tick, 1440);
  assert.equal(resumed.duration, 2880);
  close(resumed.sourceOffset!, 1.2);
  close(resumed.sourceDuration!, 7);
  assert.equal(resumed.effectTick, 1080);
  assert.equal(resumed.busId, "loop:phrase");
  assert.equal(resumed.gain, event.gain);
  assert.deepEqual(event, original);
});
test("rate transposition and fine tuning change source consumption without pretending to stretch", () => {
  const octave = resumeSpanningClips(
    [{ ...event, pitch: 72 }],
    1440,
    project(),
  )[0];
  close(octave.sourceOffset!, 2.2);
  close(octave.sourceDuration!, 6);
  assert.equal(octave.duration, 2880);
  const tuned = resumeSpanningClips([event], 1440, project(100))[0],
    rate = 2 ** (1 / 12);
  close(tuned.sourceOffset!, 0.2 + rate);
  close(tuned.sourceDuration!, 8 - rate);
});
test("reverse continuation keeps the original region start and removes its already-played far end", () => {
  const reverse = resumeSpanningClips(
    [
      {
        ...event,
        role: "resample",
        busId: "resample:pickup",
        reverse: true,
        pitch: 72,
      },
    ],
    1440,
    project(),
  )[0];
  close(reverse.sourceOffset!, 0.2);
  close(reverse.sourceDuration!, 6);
  assert.equal(reverse.reverse, true);
  assert.equal(reverse.busId, "resample:pickup");
});
test("clip starts are scheduled normally; ended, exhausted and non-audio events are never resumed", () => {
  assert.deepEqual(resumeSpanningClips([event], event.tick, project()), []);
  assert.deepEqual(
    resumeSpanningClips([event], event.tick + event.duration, project()),
    [],
  );
  assert.deepEqual(
    resumeSpanningClips([{ ...event, sourceDuration: 0.5 }], 1440, project()),
    [],
  );
  assert.deepEqual(
    resumeSpanningClips(
      [{ ...event, role: "melody", instrument: "rounded-keys" }],
      1440,
      project(),
    ),
    [],
  );
  assert.deepEqual(
    resumeSpanningClips([{ ...event, instrument: "absent" }], 1440, project()),
    [],
  );
});

test("vocal seek uses explicit linked rate and preserves the original envelope phase", () => {
  const vocal: ScoreEvent = {
    ...event,
    role: "vox",
    playbackRate: 2,
    pitch: 60,
    envelopeDurationSeconds: 4,
    envelopeOffsetSeconds: 0,
    effectTick: 0,
    vocal: {
      eventId: "vox",
      mode: "gated",
      fadeIn: 0.2,
      fadeOut: 1,
      overlap: "allow",
    },
  };
  const resumed = resumeSpanningClips([vocal], 1440, project())[0];
  close(resumed.sourceOffset!, 2.2);
  close(resumed.sourceDuration!, 6);
  close(resumed.envelopeOffsetSeconds!, 1);
  close(resumed.envelopeDurationSeconds!, 4);
  assert.equal(resumed.effectTick, 960);
  const resumedAgain = resumeSpanningClips([resumed], 1920, project())[0];
  close(resumedAgain.envelopeOffsetSeconds!, 1.5);
  close(resumedAgain.envelopeDurationSeconds!, 4);
  close(resumedAgain.sourceOffset!, 3.2);
  assert.deepEqual(vocalFadePoints(4, 3.5, 0.2, 1), [
    { time: 0, gain: 0.5 },
    { time: 0.5, gain: 0 },
  ]);
});

test("overlapping fades scale into a triangular envelope and remain phase-correct on seek", () => {
  assert.deepEqual(vocalFadePoints(1, 0, 1, 1), [
    { time: 0, gain: 0 },
    { time: 0.5, gain: 1 },
    { time: 1, gain: 0 },
  ]);
  assert.deepEqual(vocalFadePoints(1, 0.75, 1, 1), [
    { time: 0, gain: 0.5 },
    { time: 0.25, gain: 0 },
  ]);
});
