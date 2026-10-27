import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { unzipSync, strFromU8 } from "fflate";
import { parseMidi } from "midi-file";
import { newProject, rewrite, DRUM_ROLES } from "../src/engine/compose";
import { defaultSettings } from "../src/engine/profiles";
import { loopProject, transposeLoop, gridDuration } from "../src/engine/loop";
import { score, totalTicks } from "../src/engine/score";
import { BAR, LOOP_TICKS, clone, seconds } from "../src/engine/schema";
import type { Project, SampleAsset } from "../src/engine/schema";
import { importMidi } from "../src/io/import-midi";
import {
  validateProject,
  loadFile,
  missingAssets,
} from "../src/io/persistence";
import { portableZip, TAIL_SECONDS } from "../src/io/export";
import { encodeWav } from "../src/io/wav";

const sourceBytes = encodeWav([Float32Array.from([0, 0.2, -0.1, 0])], 44100);
const loopAsset: SampleAsset = {
  id: "sample-loop-fixture",
  name: "@lilfrus - LOOP 10 (155) (USE TAG!!).wav",
  originalFilename: "@lilfrus - LOOP 10 (155) (USE TAG!!).wav",
  role: "loop",
  data: `data:audio/wav;base64,${Buffer.from(sourceBytes).toString("base64")}`,
  root: 60,
  tuning: 0,
  trimStart: 0,
  trimEnd: (32 * 60) / 155,
  gain: 0.8,
  choke: "",
  license: "Private supplied source fixture",
  hash: "fixture-source-sha256",
  sourceId: "fixture-source-sha256",
  source: "user-supplied-loop",
  duration: (32 * 60) / 155,
  sampleRate: 44100,
  channels: 1,
  envelopeMode: "gated",
  loop: false,
};

test("loop score respects phrase boundaries and creates explicit gaps in the breakdown and ending", () => {
  const p = loopProject([loopAsset], loopAsset),
    clips = score(p).filter((e) => e.role === "loop");
  assert.equal(totalTicks(p), 64 * BAR);
  assert.deepEqual(missingAssets(p), []);
  assert.deepEqual(
    clips.map((e) => e.tick / BAR),
    [0, 4, 12, 20, 28, 36, 40, 44, 52, 60],
  );
  assert.deepEqual(
    clips.map((e) => e.duration / BAR),
    [4, 8, 8, 8, 8, 2, 2, 8, 8, 2],
  );
  assert.equal(
    clips.reduce((sum, e) => sum + e.duration, 0),
    58 * BAR,
  );
  clips.forEach((event, i) => {
    assert.ok(event.tick + event.duration <= totalTicks(p));
    if (i) assert.ok(clips[i - 1].tick + clips[i - 1].duration <= event.tick);
    assert.ok(
      seconds(event.duration, p.settings.bpm) <= event.sourceDuration! + 1e-9,
    );
  });
  p.arrangement = false;
  assert.deepEqual(
    score(p)
      .filter((e) => e.role === "loop")
      .map((e) => [e.tick, e.duration]),
    [[0, LOOP_TICKS]],
  );
});

test("direct-loop arrangements never inject accepted-score voices or a generated outro cadence", () => {
  const original = newProject(),
    originalSnapshot = clone(original);
  assert.ok(
    original.candidates[0].tracks.find((t) => t.id === "melody")!.notes.length >
      0,
  );
  const p = loopProject([loopAsset], loopAsset);
  const upperRoles = ["melody", "pad", "answer", "keys", "bridge", "pedal"];
  for (const semitones of [0, 3, -2]) {
    const version = semitones === 0 ? clone(p) : transposeLoop(p, semitones);
    for (let selected = 0; selected < version.candidates.length; selected++) {
      version.selected = selected;
      for (const track of version.candidates[selected].tracks.filter((t) =>
        upperRoles.includes(t.id),
      ))
        assert.deepEqual(track.notes, []);
      const events = score(version);
      assert.ok(events.some((e) => e.role === "loop"));
      assert.ok(events.some((e) => e.role === "bass"));
      assert.deepEqual(
        events.filter((e) => upperRoles.includes(e.role)),
        [],
      );
      assert.ok(!events.some((e) => e.id.includes("cadence")));
      const outroStart = version.sections
        .slice(0, -1)
        .reduce((sum, section) => sum + section.bars * BAR, 0);
      assert.ok(events.some((e) => e.role === "loop" && e.tick >= outroStart));
    }
  }
  assert.deepEqual(original, originalSnapshot);
});

test("a permitted loop drum rewrite retains the source clips, tonal support and empty melodic roles", () => {
  const p = loopProject([loopAsset], loopAsset),
    before = clone(p),
    changed = rewrite(p, DRUM_ROLES);
  assert.equal(changed.sourceKind, "supplied-loop");
  assert.deepEqual(changed.clips, before.clips);
  assert.deepEqual(changed.assets, before.assets);
  assert.deepEqual(changed.candidates[0].harmony, before.candidates[0].harmony);
  for (const track of before.candidates[0].tracks)
    if (!DRUM_ROLES.includes(track.id))
      assert.deepEqual(
        changed.candidates[0].tracks.find((t) => t.id === track.id),
        track,
      );
  assert.deepEqual(
    score(changed).filter((e) =>
      ["melody", "pad", "answer", "keys", "bridge", "pedal"].includes(e.role),
    ),
    [],
  );
});

test("edited clip region/repetition and section presence survive score expansion without overrunning a phrase", () => {
  const p = loopProject([loopAsset], loopAsset),
    clip = p.clips![0];
  p.sections = [
    { id: "a", name: "A", kind: "hook", bars: 7 },
    { id: "b", name: "B", kind: "break", bars: 4 },
  ];
  clip.tick = BAR;
  clip.duration = BAR * 3;
  clip.repeatTicks = BAR * 4;
  clip.sourceOffset = 0.25;
  clip.sourceDuration = (4 * 60) / 155;
  clip.sections = ["hook"];
  p.clips = [clip];
  const events = score(p).filter((e) => e.role === "loop");
  assert.deepEqual(
    events.map((e) => [e.tick / BAR, e.duration / BAR]),
    [
      [1, 3],
      [5, 2],
    ],
  );
  assert.ok(
    events.every(
      (e) =>
        e.sourceOffset === 0.25 && e.sourceDuration === clip.sourceDuration,
    ),
  );
  assert.ok(events.every((e) => e.tick + e.duration <= BAR * 7));
});

test("75 BPM and 150 BPM have explicit different bar counts for the same elapsed duration", () => {
  assert.equal(gridDuration(150, 64), 102.4);
  assert.equal(gridDuration(75, 32), 102.4);
  assert.equal(gridDuration(75, 64), 204.8);
  assert.equal(gridDuration(150, 8) * 2, gridDuration(75, 8));
  assert.equal(TAIL_SECONDS, 4);
  const p = loopProject([loopAsset], loopAsset);
  assert.equal(seconds(totalTicks(p), p.settings.bpm), gridDuration(155, 64));
  assert.ok(
    gridDuration(155, 64) + TAIL_SECONDS >= 90 &&
      gridDuration(155, 64) + TAIL_SECONDS <= 150,
  );
});

test("loop transposition links rate, pitch, MIDI and harmony while retaining native source metadata", () => {
  const p = loopProject([loopAsset], loopAsset),
    original = clone(p),
    shifted = transposeLoop(p, 3),
    clip = shifted.clips![0],
    ratio = 2 ** (3 / 12);
  assert.deepEqual(p, original);
  assert.equal(shifted.settings.bpm, 155 * ratio);
  assert.equal(clip.pitch, 3);
  assert.equal(clip.provenance.stretch, "native-only");
  assert.deepEqual(clip.provenance, p.clips![0].provenance);
  assert.equal(clip.sourceDuration, p.clips![0].sourceDuration);
  const loopEvent = score(shifted).find((e) => e.role === "loop")!;
  assert.equal(loopEvent.pitch, loopAsset.root + 3);
  assert.ok(
    Math.abs(
      seconds(LOOP_TICKS, shifted.settings.bpm) - clip.sourceDuration / ratio,
    ) < 1e-9,
  );
  for (let i = 0; i < p.candidates.length; i++) {
    const before = p.candidates[i],
      after = shifted.candidates[i];
    for (const track of before.tracks) {
      const current = after.tracks.find((t) => t.id === track.id)!;
      if (["kick", "clap", "hat", "open", "perc"].includes(track.id))
        assert.deepEqual(current.notes, track.notes);
      else
        assert.deepEqual(
          current.notes.map((n) => [n.tick, n.duration, n.pitch]),
          track.notes.map((n) => [n.tick, n.duration, n.pitch + 3]),
        );
    }
    assert.deepEqual(
      after.harmony.map((h) => h.root),
      before.harmony.map((h) => h.root + 3),
    );
  }
  const changedAgain = transposeLoop(shifted, -2);
  assert.equal(changedAgain.settings.bpm, 155 * 2 ** (-2 / 12));
  assert.equal(
    changedAgain.candidates[0].tracks.find((t) => t.id === "bass")!.notes[0]
      .pitch,
    34,
  );
  assert.equal(transposeLoop(p, 100).clips![0].pitch, 5);
  assert.equal(transposeLoop(p, -100).clips![0].pitch, -5);
  const reloaded = JSON.parse(JSON.stringify(shifted));
  assert.deepEqual(validateProject(reloaded), reloaded);
  const fakeStretch = clone(shifted);
  Object.assign(fakeStretch.clips![0].provenance, {
    stretch: "pitch-preserving",
  });
  assert.throws(() => validateProject(fakeStretch), /clip/i);
});

test("legacy nine-role and ensemble twelve-role projects validate and portable ZIPs retain source/audio/processing data", async () => {
  const legacy = newProject(defaultSettings("airy")),
    ensemble = newProject(),
    loop = loopProject([loopAsset], loopAsset);
  assert.equal(legacy.candidates[0].tracks.length, 9);
  assert.equal(ensemble.candidates[0].tracks.length, 12);
  const sourceScore = ensemble.candidates[0].tracks.find(
    (t) => t.id === "melody",
  )!;
  loop.clips!.push({
    ...clone(loop.clips![0]),
    id: "authored-reverse",
    role: "resample",
    kind: "original-resample",
    reverse: true,
    tick: BAR * 7,
    duration: 240,
    sourceOffset: 0.03,
    sourceDuration: 0.1,
    repeatTicks: LOOP_TICKS,
    effects: {
      delay: {
        division: 0.5,
        feedback: 0.2,
        wet: 0.17,
        cutoff: 2800,
        pingPong: true,
        automation: [{ tick: BAR * 7, wet: 0.25 }],
      },
    },
    provenance: {
      ...clone(loop.clips![0].provenance),
      creator: "ishmakethebeat original score",
      credit: "Original score resampling; source loop untouched",
      renderId: "authored-render-fixed-score",
      sourceScore: {
        role: "melody",
        notes: clone(sourceScore.notes),
        instrument: sourceScore.instrument,
        bpm: ensemble.settings.bpm,
      },
    },
  });
  loop.scaleGuides = [
    {
      name: "C minor",
      pitches: [60, 62, 63, 65, 67, 68, 70],
      sourceHash: "guide-source-hash",
      enabled: false,
    },
  ];
  for (const p of [legacy, ensemble, loop]) {
    const parsed = JSON.parse(JSON.stringify(p)) as Project;
    assert.deepEqual(validateProject(parsed), parsed);
    const zipped = portableZip(p),
      unpacked = unzipSync(zipped),
      saved = JSON.parse(strFromU8(unpacked["project.json"]));
    assert.deepEqual(saved, parsed);
    assert.ok(unpacked["score.mid"].length > 0);
    for (const asset of p.assets)
      assert.deepEqual(
        unpacked[`samples/${asset.id}.wav`],
        new Uint8Array(Buffer.from(asset.data.split(",")[1], "base64")),
        `${asset.name}: portable ZIP must preserve the actual source bytes`,
      );
    const loaded = await loadFile(
      new File([new Uint8Array(zipped)], "portable.ish.zip"),
    );
    assert.deepEqual(loaded, parsed);
  }
  const invalid = clone(ensemble);
  invalid.candidates[0].tracks[11].id = "keys";
  assert.throws(() => validateProject(invalid), /duplicate/i);
});

const midiRoot =
  "private-assets/stash-kit/1 (@prodfrustration) - personal tdf stash kit v2 (with presets)/Midis";
test(
  "all 24 supplied scale MIDIs become silent guides; the supplied piano phrase remains 146 playable notes",
  { skip: !fs.existsSync(midiRoot) },
  () => {
    const directory = path.join(midiRoot, "Scales"),
      guides = fs
        .readdirSync(directory)
        .filter((file) => file.toLowerCase().endsWith(".mid"));
    assert.equal(guides.length, 24);
    for (const file of guides) {
      const imported = importMidi(fs.readFileSync(path.join(directory, file)), {
        role: "melody",
        loopBars: 8,
        sourceBase: 60,
        targetRoot: 36,
      });
      assert.equal(imported.classification, "scale-guide", file);
      assert.equal(imported.notes.length, 0, file);
      assert.ok(
        imported.scalePitches.length >= 35 &&
          imported.scalePitches.length <= 42,
        file,
      );
      assert.equal(imported.loopTicks, 32 * 480, file);
    }
    const phraseBytes = fs.readFileSync(
      path.join(midiRoot, "Midis/Cool Piano Thing (a major).mid"),
    );
    const imported = importMidi(phraseBytes, {
      role: "melody",
      loopBars: 8,
      sourceBase: 60,
      targetRoot: 36,
    });
    assert.equal(imported.classification, "phrase");
    assert.equal(imported.sourcePPQ, 96);
    assert.ok(Math.abs(imported.sourceTempo! - 147) < 0.001);
    assert.equal(imported.sourceNoteCount, 146);
    assert.equal(imported.notes.length, 146);
    assert.equal(imported.scalePitches.length, 0);
    assert.deepEqual(
      Array.from(
        { length: 8 },
        (_, bar) =>
          imported.notes.filter((n) => Math.floor(n.tick / BAR) === bar).length,
      ),
      [21, 21, 21, 21, 13, 18, 13, 18],
    );
    assert.ok(
      imported.notes.every(
        (n) => n.duration > 0 && n.tick + n.duration <= LOOP_TICKS,
      ),
    );
    assert.equal(
      Math.max(...imported.notes.map((n) => n.tick + n.duration)),
      LOOP_TICKS,
    );
    assert.ok(
      imported.notes.every(
        (n) => n.pitch >= 64 && n.pitch <= 88 && n.velocity === 1,
      ),
    );
    // Verify the short positive source durations, rather than accepting an
    // importer's minimum gate as evidence that the source had positive lengths.
    const midi = parseMidi(phraseBytes),
      factor = 480 / midi.header.ticksPerBeat!,
      raw: { tick: number; pitch: number; duration: number }[] = [];
    for (const track of midi.tracks) {
      let tick = 0;
      const active = new Map<string, number[]>();
      for (const event of track) {
        tick += event.deltaTime;
        if (event.type !== "noteOn" && event.type !== "noteOff") continue;
        const key = `${event.channel}:${event.noteNumber}`;
        if (event.type === "noteOn" && event.velocity > 0) {
          const queue = active.get(key) ?? [];
          queue.push(tick);
          active.set(key, queue);
        } else {
          const start = active.get(key)?.shift();
          if (start !== undefined)
            raw.push({
              tick: start * factor,
              pitch: event.noteNumber,
              duration: (tick - start) * factor,
            });
        }
      }
      assert.ok([...active.values()].every((queue) => queue.length === 0));
    }
    assert.equal(raw.length, 146);
    assert.ok(raw.every((n) => n.duration > 0));
    assert.equal(Math.min(...raw.map((n) => n.duration)), 45);
    const sorted = (
      notes: { tick: number; pitch: number; duration: number }[],
    ) =>
      notes
        .map((n) => [n.tick, n.pitch, n.duration])
        .sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
    assert.deepEqual(sorted(imported.notes), sorted(raw));
  },
);
