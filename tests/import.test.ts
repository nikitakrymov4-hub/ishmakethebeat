import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { writeMidi, parseMidi } from "midi-file";
import { importMidi } from "../src/io/import-midi";
import { BAR } from "../src/engine/schema";
import { readWavInfo, encodeWav } from "../src/io/wav";
test("WAV source-rate parser walks extra RIFF chunks in actual supplied files", () => {
  for (const [name, rate, channels] of [
    ["okaymar hihat.wav", 48000, 2],
    ["snap.wav", 11025, 1],
    ["tdf hihat.wav", 44100, 2],
  ] as const) {
    const file = `private-assets/${name}`;
    if (!fs.existsSync(file)) continue;
    const info = readWavInfo(new Uint8Array(fs.readFileSync(file)).buffer);
    assert.deepEqual(info, { sampleRate: rate, channels });
  }
  const info = readWavInfo(
    encodeWav([new Float32Array(8)], 48000).buffer as ArrayBuffer,
  );
  assert.deepEqual(info, { sampleRate: 48000, channels: 1 });
});
test("zero-length percussion at 96 PPQ fires and retains explicit 16-beat loop", () => {
  const midi = Uint8Array.from(
    writeMidi({
      header: { format: 1, numTracks: 1, ticksPerBeat: 96 },
      tracks: [
        [
          {
            deltaTime: 0,
            type: "setTempo",
            microsecondsPerBeat: Math.round(60000000 / 156),
          },
          ...Array.from({ length: 4 }, (_, i) => [
            {
              deltaTime: i === 0 ? 192 : 384,
              type: "noteOn" as const,
              channel: 0,
              noteNumber: 60,
              velocity: 100,
            },
            {
              deltaTime: 0,
              type: "noteOff" as const,
              channel: 0,
              noteNumber: 60,
              velocity: 0,
            },
          ]).flat(),
          { deltaTime: 0, type: "endOfTrack" },
        ],
      ],
    }),
  );
  const imported = importMidi(midi, {
    role: "clap",
    loopBars: 4,
    sourceBase: 60,
    targetRoot: 30,
  });
  assert.equal(imported.loopTicks, 4 * BAR);
  assert.equal(imported.sourcePPQ, 96);
  assert.equal(imported.sourceNoteCount, 4);
  assert.deepEqual(
    imported.notes.slice(0, 4).map((n) => n.tick),
    [960, 2880, 4800, 6720],
  );
  assert.equal(imported.notes[4].tick, 4 * BAR + 960);
  assert.ok(
    imported.notes.every(
      (n) => n.duration > 0 && n.pitch === 39 && n.velocity === 100 / 127,
    ),
  );
});
test("real supplied MIDI templates preserve PPQ conversion, flat velocities, gaps, roll timing and loop boundary", () => {
  for (const [file, role, count, velocity] of [
    ["beat", "bass", 10, 127],
    ["cool", "bass", 16, 100],
    ["classic", "clap", 4, 100],
    ["tdf", "hat", 31, 100],
    ["delay", "hat", 24, 100],
  ] as const) {
    const filename = `private-assets/${file}.mid`;
    if (!fs.existsSync(filename)) continue;
    const data = fs.readFileSync(filename),
      m = importMidi(data, {
        role,
        loopBars: 4,
        sourceBase: 60,
        targetRoot: 30,
      });
    assert.equal(m.sourcePPQ, 96);
    assert.equal(m.loopTicks, 4 * BAR);
    assert.equal(m.sourceNoteCount, count);
    assert.ok(m.notes.every((n) => Math.round(n.velocity * 127) === velocity));
    const raw = parseMidi(data);
    assert.ok(raw.tracks.length > 0);
    if (file === "tdf") {
      const expected = [
        0, 0.25, 0.5, 1.5, 2, 3, 3.25, 4.5, 4.75, 5, 5.5, 5.625, 5.75, 5.875,
        6.5, 7,
      ];
      assert.deepEqual(
        m.notes.filter((n) => n.tick < 2 * BAR).map((n) => n.tick / 480),
        expected,
      );
    }
    if (file === "classic")
      assert.deepEqual(
        m.notes.slice(0, 4).map((n) => n.tick / 480),
        [2, 6, 10, 14],
      );
  }
});
test("bass sampler-note convention maps intervals from a confirmed source base", () => {
  const bytes = Uint8Array.from(
    writeMidi({
      header: { format: 0, numTracks: 1, ticksPerBeat: 96 },
      tracks: [
        [
          {
            deltaTime: 0,
            type: "noteOn",
            channel: 0,
            noteNumber: 60,
            velocity: 100,
          },
          {
            deltaTime: 96,
            type: "noteOff",
            channel: 0,
            noteNumber: 60,
            velocity: 0,
          },
          {
            deltaTime: 0,
            type: "noteOn",
            channel: 0,
            noteNumber: 67,
            velocity: 100,
          },
          {
            deltaTime: 96,
            type: "noteOff",
            channel: 0,
            noteNumber: 67,
            velocity: 0,
          },
          { deltaTime: 0, type: "endOfTrack" },
        ],
      ],
    }),
  );
  const m = importMidi(bytes, {
    role: "bass",
    loopBars: 4,
    sourceBase: 60,
    targetRoot: 30,
  });
  assert.deepEqual(
    m.notes.slice(0, 2).map((n) => n.pitch),
    [30, 37],
  );
  assert.equal(m.notes[0].duration, 480);
});
