import test from "node:test";
import assert from "node:assert/strict";
import { unzipSync, strFromU8 } from "fflate";
import { newProject } from "../src/engine/compose";
import { BAR, PPQ, clone, seconds } from "../src/engine/schema";
import type { Project, SampleAsset, VocalEvent } from "../src/engine/schema";
import {
  migrateLegacyTag,
  score,
  totalTicks,
  vocalEventIssues,
} from "../src/engine/score";
import {
  eventTailSeconds,
  renderDurationSeconds,
  withoutVocals,
} from "../src/engine/render-duration";
import { missingAssets, validateProject } from "../src/io/persistence";
import { portableZip, renderWav } from "../src/io/export";
import { encodeWav } from "../src/io/wav";

const bytes = encodeWav([new Float32Array(44100 * 4)]);
const asset: SampleAsset = {
  id: "sample-vocal-fixture",
  name: "Original voice.wav",
  role: "vox",
  data: `data:audio/wav;base64,${Buffer.from(bytes).toString("base64")}`,
  root: 60,
  tuning: 0,
  trimStart: 0,
  trimEnd: 4,
  duration: 4,
  gain: 0.8,
  choke: "legacy-asset-group",
  license: "Original test recording",
  hash: "fixture-hash",
  sampleRate: 44100,
  channels: 1,
  envelopeMode: "gated",
};
function event(overrides: Partial<VocalEvent> = {}): VocalEvent {
  return {
    id: "voice",
    name: "Original phrase",
    assetId: asset.id,
    role: "vox",
    enabled: true,
    placement: { kind: "absolute", tick: BAR },
    duration: BAR,
    sourceOffset: 0.5,
    sourceDuration: 3,
    gain: 0.65,
    pan: -0.25,
    pitch: 0,
    reverse: false,
    mode: "gated",
    fadeIn: 0.03,
    fadeOut: 0.09,
    filter: { highpass: 150, lowpass: 9000 },
    overlap: "allow",
    provenance: {
      sourceName: asset.name,
      sourceHash: asset.hash!,
      creator: "Fixture author",
      credit: asset.license,
    },
    ...overrides,
  };
}
function project(vocals: VocalEvent[] = [event()]): Project {
  const p = newProject();
  p.settings.bpm = 120;
  p.arrangement = true;
  p.sections = [
    { id: "a", name: "First", kind: "hook", bars: 4 },
    { id: "b", name: "Second", kind: "verse", bars: 4 },
  ];
  p.assets = [clone(asset), ...p.assets];
  p.tagEnabled = true;
  p.vocalEvents = vocals;
  return p;
}

test("legacy tag path is unchanged and an explicit lane cannot double it", () => {
  const p = project();
  delete p.vocalEvents;
  p.tagAsset = asset.id;
  const notesBefore = clone(p.candidates);
  assert.deepEqual(
    score(p).filter((e) => e.role === "tag"),
    [
      {
        id: "user-tag",
        tick: 0,
        duration: BAR * 2,
        pitch: 60,
        velocity: 0.7,
        role: "tag",
        instrument: asset.id,
        gain: 0.6,
        pan: 0,
        filter: 1,
      },
    ],
  );
  assert.equal(migrateLegacyTag(p).length, 1);
  p.vocalEvents = [];
  assert.equal(score(p).filter((e) => e.role === "tag").length, 0);
  p.vocalEvents = [event({ role: "tag" })];
  assert.equal(score(p).filter((e) => e.role === "tag").length, 1);
  assert.deepEqual(p.candidates, notesBefore);
});

test("section anchors follow their section while absolute placements and explicit repeats keep their timing", () => {
  const p = project([
    event({ id: "absolute", placement: { kind: "absolute", tick: PPQ } }),
    event({
      id: "anchored",
      placement: { kind: "section", sectionId: "b", tick: BAR },
      repeats: { count: 2, intervalTicks: PPQ },
    }),
  ]);
  const vocalTicks = () =>
    score(p)
      .filter((e) => e.vocal)
      .map((e) => [e.vocal!.eventId, e.tick]);
  assert.deepEqual(vocalTicks(), [
    ["absolute", PPQ],
    ["anchored", BAR * 5],
    ["anchored", BAR * 5 + PPQ],
    ["anchored", BAR * 5 + 2 * PPQ],
  ]);
  p.sections.reverse();
  assert.deepEqual(vocalTicks(), [
    ["absolute", PPQ],
    ["anchored", BAR],
    ["anchored", BAR + PPQ],
    ["anchored", BAR + 2 * PPQ],
  ]);
  p.arrangement = false;
  assert.deepEqual(vocalTicks(), [["absolute", PPQ]]);
});

test("missing sections remain repairable and exports reject active unresolved events", async () => {
  const p = project([
    event({ placement: { kind: "section", sectionId: "removed", tick: 0 } }),
  ]);
  assert.equal(
    validateProject(JSON.parse(JSON.stringify(p))).vocalEvents![0].placement
      .kind,
    "section",
  );
  assert.match(vocalEventIssues(p)[0].message, /no longer exists/);
  assert.equal(score(p).filter((e) => e.vocal).length, 0);
  await assert.rejects(renderWav(p), /no longer exists/);
});

test("linked pitch includes root fine tuning and one-shots differ from gated events", () => {
  const p = project([
    event({ pitch: 12, mode: "one-shot", duration: PPQ / 4 }),
  ]);
  p.assets[0].tuning = 100;
  const oneShot = score(p).find((e) => e.vocal)!;
  const rate = 2 ** (13 / 12);
  assert.equal(oneShot.playbackRate, rate);
  assert.equal(oneShot.pitch, 72);
  assert.ok(Math.abs(seconds(oneShot.duration, 120) - 3 / rate) < 1e-10);
  assert.equal(oneShot.envelopeDurationSeconds, seconds(oneShot.duration, 120));
  assert.equal(oneShot.effectTick, 0);
  p.vocalEvents![0].mode = "gated";
  assert.equal(score(p).find((e) => e.vocal)!.duration, PPQ / 4);
});

test("explicit choke groups shorten only vocal envelopes and same-tick last trigger wins", () => {
  const p = project([
    event({
      id: "first",
      placement: { kind: "absolute", tick: 0 },
      mode: "one-shot",
      overlap: "choke-group",
      chokeGroup: "voices",
    }),
    event({
      id: "second",
      placement: { kind: "absolute", tick: PPQ },
      overlap: "choke-group",
      chokeGroup: "voices",
    }),
    event({
      id: "last",
      placement: { kind: "absolute", tick: PPQ },
      overlap: "choke-group",
      chokeGroup: "voices",
    }),
    event({
      id: "free",
      placement: { kind: "absolute", tick: PPQ / 2 },
      mode: "one-shot",
    }),
  ]);
  const vocals = score(p).filter((e) => e.vocal);
  assert.equal(vocals.find((e) => e.vocal!.eventId === "first")!.duration, PPQ);
  assert.equal(
    vocals.find((e) => e.vocal!.eventId === "first")!.envelopeDurationSeconds,
    0.5,
  );
  assert.ok(!vocals.some((e) => e.vocal!.eventId === "second"));
  assert.equal(
    vocals.find((e) => e.vocal!.eventId === "free")!.duration,
    (3 * 120 * PPQ) / 60,
  );
});

test("vocal activity and instrumental export leave all instrumental score events untouched", () => {
  const p = project([event({ id: "tag", role: "tag" }), event({ id: "vox" })]);
  const full = score(p);
  const instrumental = withoutVocals(p);
  assert.equal(
    score(instrumental).filter((e) => e.role === "tag" || e.role === "vox")
      .length,
    0,
  );
  assert.deepEqual(
    score(instrumental),
    full.filter((e) => !e.vocal),
  );
  assert.equal(p.tagEnabled, true);
  assert.equal(p.vocalEvents![0].enabled, true);
  p.voxEnabled = false;
  assert.deepEqual(
    score(p)
      .filter((e) => e.vocal)
      .map((e) => e.role),
    ["tag"],
  );
  p.tagEnabled = false;
  assert.equal(score(p).filter((e) => e.vocal).length, 0);
});

test("vocal and instrumental windows align including late sources and long effect returns", () => {
  const p = project([
    event({
      placement: { kind: "absolute", tick: BAR * 8 - PPQ },
      mode: "one-shot",
      effects: {
        delay: {
          division: 2,
          feedback: 0.65,
          wet: 0.6,
          cutoff: 6000,
          pingPong: true,
        },
        reverb: { wet: 0.3, decay: 8, preDelay: 0.25 },
      },
    }),
  ]);
  const vocal = score(p).find((e) => e.vocal)!;
  assert.ok(eventTailSeconds(vocal, 120) >= 8.25);
  assert.ok(renderDurationSeconds(p) > seconds(totalTicks(p), 120) + 4);
  assert.equal(
    renderDurationSeconds(p),
    renderDurationSeconds(withoutVocals(p)),
  );
  p.tagEnabled = false;
  p.voxEnabled = false;
  p.vocalEvents![0].enabled = false;
  assert.equal(
    renderDurationSeconds(p),
    renderDurationSeconds(withoutVocals(p)),
  );
  const legacy = project([]);
  delete legacy.vocalEvents;
  assert.equal(
    renderDurationSeconds(legacy),
    seconds(totalTicks(legacy), 120) + 4,
  );
});

test("validation rejects unsupported processing and unsafe bounds while surfacing missing sources", () => {
  for (const change of [
    { pitch: 25 },
    { sourceDuration: 0 },
    { fadeOut: NaN },
    { overlap: "choke-group", chokeGroup: "" },
    { repeats: { count: 1.5, intervalTicks: PPQ } },
    {
      effects: {
        hat: {
          mix: 1,
          echoBeats: 1,
          feedback: 0.1,
          chorus: 0,
          crush: 0,
          room: 0,
        },
      },
    },
    { effects: { reverb: { wet: 1, decay: 30, preDelay: 5 } } },
  ]) {
    const p = project([event(change as Partial<VocalEvent>)]);
    assert.throws(() => validateProject(p), /Invalid vocal/);
  }
  const duplicate = project([event(), event()]);
  assert.throws(() => validateProject(duplicate), /Invalid vocal/);
  const missing = project([event({ assetId: "missing" })]);
  assert.deepEqual(missingAssets(missing), ["Original phrase"]);
  assert.match(vocalEventIssues(missing)[0].message, /Missing audio asset/);
  assert.deepEqual(missingAssets(withoutVocals(missing)), []);
  assert.match(
    vocalEventIssues(withoutVocals(missing))[0].message,
    /Missing audio asset/,
  );
  const overshoot = project([event({ sourceOffset: 3, sourceDuration: 2 })]);
  assert.match(vocalEventIssues(overshoot)[0].message, /trim exceeds/);
  const shortArrangement = project([
    event({ placement: { kind: "absolute", tick: BAR * 2 } }),
  ]);
  shortArrangement.sections = [
    { id: "short", name: "Short", kind: "hook", bars: 1 },
  ];
  assert.match(
    vocalEventIssues(shortArrangement)[0].message,
    /outside the arrangement/,
  );
});

test("portable reload retains explicit events, provenance, audio bytes and meaningful MIDI", () => {
  const p = project([
    event({ effects: { reverb: { wet: 0.3, decay: 1.2, preDelay: 0.04 } } }),
  ]);
  const mp3 = {
    ...asset,
    id: "sample-original-mp3",
    data: "data:audio/mpeg;base64,SUQz",
    name: "Original.mp3",
  };
  p.assets.push(mp3);
  p.vocalEvents![0].provenance.processing = {
    sourceAssetId: mp3.id,
    sourceHash: "original-hash",
    processor: "fixture",
    version: "1",
    settings: { gainDb: -3, preservePitch: false },
  };
  const archive = unzipSync(portableZip(p));
  const restored = validateProject(
    JSON.parse(strFromU8(archive["project.json"])),
  );
  assert.deepEqual(restored.vocalEvents, p.vocalEvents);
  assert.deepEqual(score(restored), score(p));
  assert.deepEqual(archive[`samples/${asset.id}.wav`], bytes);
  assert.equal(Buffer.from(archive[`samples/${mp3.id}.mp3`]).toString(), "ID3");
  assert.ok(archive["score.mid"].length > 0);
});
