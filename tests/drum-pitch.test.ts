import test from "node:test";
import assert from "node:assert/strict";
import { newProject } from "../src/engine/compose";
import { defaultSettings } from "../src/engine/profiles";
import { score } from "../src/engine/score";
import { clone } from "../src/engine/schema";
import { samplePlaybackRate } from "../src/audio/sample-playback";
import { validateProject } from "../src/io/persistence";
import { portableZip } from "../src/io/export";
import { exportMidi } from "../src/io/midi";
import { parseMidi } from "midi-file";
import { unzipSync, strFromU8 } from "fflate";

test("legacy drum-map notes and legacy tuning metadata remain native; explicit controls transpose", () => {
  const asset = { root: 60, tuning: 73 };
  for (const [role, pitch] of [
    ["kick", 36],
    ["clap", 39],
    ["hat", 42],
    ["open", 46],
    ["perc", 37],
  ] as const)
    assert.equal(samplePlaybackRate({ role, pitch }, asset), 1);
  assert.equal(
    samplePlaybackRate({ role: "hat", pitch: 42, drumPitch: 12 }, asset),
    2,
  );
  assert.equal(
    samplePlaybackRate({ role: "hat", pitch: 42, drumPitch: -12 }, asset),
    0.5,
  );
  assert.ok(
    Math.abs(
      samplePlaybackRate(
        { role: "hat", pitch: 42, drumPitch: 7 },
        { ...asset, drumTuning: 500 },
      ) - 2,
    ) < 1e-12,
  );
  assert.equal(
    samplePlaybackRate(
      { role: "bass", pitch: 72 },
      { root: 60, tuning: 0, drumTuning: 300 },
    ),
    2,
  );
});

test("drum pitch survives arrangement score and portable reload; MIDI keeps mapping and documents pitch", () => {
  const p = newProject({ ...defaultSettings(), bpm: 120 });
  p.assets = [
    {
      id: "sample-qa-hat",
      name: "QA",
      role: "hat",
      data: "data:audio/wav;base64,AA==",
      root: 60,
      tuning: 17,
      drumTuning: 50,
      trimStart: 0,
      trimEnd: 1,
      gain: 0.3,
      choke: "hats",
      license: "test",
    },
  ];
  p.arrangement = false;
  const hat = p.candidates[0].tracks.find((t) => t.id === "hat")!;
  hat.instrument = p.assets[0].id;
  hat.notes = [
    {
      id: "pitched",
      tick: 0,
      duration: 120,
      pitch: 42,
      velocity: 0.8,
      drumPitch: 12,
    },
  ];
  validateProject(p);
  const event = score(p).find((e) => e.role === "hat")!;
  assert.equal(event.drumPitch, 12);
  assert.equal(event.pitch, 42);
  const files = unzipSync(portableZip(p));
  const restored = validateProject(
    JSON.parse(strFromU8(files["project.json"])),
  );
  assert.equal(restored.assets[0].drumTuning, 50);
  assert.equal(
    restored.candidates[0].tracks.find((t) => t.id === "hat")!.notes[0]
      .drumPitch,
    12,
  );
  const tracks = parseMidi(exportMidi(p)).tracks;
  const midiHat = tracks.find((track) =>
    track.some((e) => e.type === "text" && e.text.includes("sample pitch")),
  )!;
  assert.ok(midiHat.some((e) => e.type === "noteOn" && e.noteNumber === 42));
  assert.ok(
    midiHat.some(
      (e) =>
        e.type === "text" &&
        e.text.includes('"semitones":12') &&
        e.text.includes('"tuningCents":50'),
    ),
  );
  assert.ok(!midiHat.some((e) => e.type === "pitchBend"));
  const invalid = clone(p);
  invalid.candidates[0].tracks.find((t) => t.id === "hat")!.notes[0].drumPitch =
    25;
  assert.throws(() => validateProject(invalid), /Invalid events/);
  invalid.candidates[0].tracks.find((t) => t.id === "hat")!.notes[0].drumPitch =
    0;
  invalid.assets[0].drumTuning = NaN;
  assert.throws(() => validateProject(invalid), /sample asset/);
});
