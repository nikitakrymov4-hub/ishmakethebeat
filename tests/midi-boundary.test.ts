import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { parseMidi } from "midi-file";
import { newProject } from "../src/engine/compose";
import { exportMidi } from "../src/io/midi";
import { validateProject } from "../src/io/persistence";

function bassTrack(bytes: Uint8Array) {
  return parseMidi(bytes).tracks.find((track) =>
    track.some(
      (e) => e.type === "trackName" && e.text.startsWith("808 bass ·"),
    ),
  )!;
}
test("a glide clipped exactly at a note boundary resets before a same-tick following note", () => {
  const p = newProject(),
    bass = p.candidates[0].tracks.find((t) => t.id === "bass")!;
  bass.notes = [
    {
      id: "cut-slide",
      tick: 0,
      duration: 480,
      pitch: 36,
      velocity: 0.8,
      articulation: "legato",
      glide: { to: 48, at: 450, ms: 100 },
    },
    {
      id: "following-root",
      tick: 480,
      duration: 480,
      pitch: 36,
      velocity: 0.8,
      articulation: "retrigger",
    },
  ];
  let tick = 0;
  const boundary = bassTrack(exportMidi(p)).flatMap((event) => {
    tick += event.deltaTime;
    return tick === 480 ? [event] : [];
  });
  const finalPoint = boundary.findIndex(
      (e) => e.type === "pitchBend" && e.value === 4096,
    ),
    off = boundary.findIndex((e) => e.type === "noteOff"),
    reset = boundary.findIndex((e) => e.type === "pitchBend" && e.value === 0),
    nextOn = boundary.findIndex((e) => e.type === "noteOn");
  assert.ok(finalPoint >= 0 && finalPoint < off);
  assert.ok(off < reset && reset < nextOn);
  assert.equal(boundary.filter((e) => e.type === "pitchBend").at(-1)!.value, 0);
});

const copperFile = "deliverables/character/generated/COPPER-892.ish.json";
test(
  "the actual COPPER arrangement resets every clipped bass glide and leaves its final pitch bend centered",
  { skip: !fs.existsSync(copperFile) },
  () => {
    const p = validateProject(JSON.parse(fs.readFileSync(copperFile, "utf8"))),
      track = bassTrack(exportMidi(p));
    let bend = 0,
      nonzero = 0;
    for (const event of track) {
      if (event.type === "pitchBend") {
        bend = event.value;
        if (bend) nonzero++;
      }
      if (event.type === "noteOn" && event.velocity > 0)
        assert.equal(
          bend,
          0,
          "A preceding section-clipped glide detunes a new root",
        );
    }
    assert.ok(nonzero > 0);
    assert.equal(bend, 0);
  },
);
