import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { newProject } from "../src/engine/compose";
import { defaultSettings } from "../src/engine/profiles";
import { score } from "../src/engine/score";
import { seconds } from "../src/engine/schema";
import type { SampleAsset } from "../src/engine/schema";
import { transposeLoop } from "../src/engine/loop";
import {
  checkedLoopRegion,
  isLoopFoundation,
  loopFoundation,
  updateFoundationRegion,
} from "../src/io/loop-foundation";
import { encodeWav } from "../src/io/wav";
import { portableZip } from "../src/io/export";
import { validateProject } from "../src/io/persistence";
import { unzipSync, strFromU8 } from "fflate";

function fixture() {
  const wav = encodeWav([
    new Float32Array(44100 * 12),
    new Float32Array(44100 * 12),
  ]);
  const hash = createHash("sha256").update(wav).digest("hex");
  const source = {
    filename: "fixture.wav",
    path: "private-assets/fixture.wav",
    sha256: hash,
    creator: "Fixture author",
    creditBasis: "Explicit test credit",
    terms: "Fixture source terms",
    filenameBpm: 123,
    filenameKey: "F#",
  };
  const asset: SampleAsset = {
    id: `sample-${hash.slice(0, 16)}-loop`,
    name: source.filename,
    data: `data:audio/wav;base64,${Buffer.from(wav).toString("base64")}`,
    role: "loop",
    root: 60,
    tuning: 0,
    gain: 1,
    trimStart: 0,
    trimEnd: 12,
    duration: 12,
    choke: "",
    license: source.terms,
    hash,
    sampleRate: 44100,
    channels: 2,
    envelopeMode: "gated",
    loop: false,
  };
  return { base: newProject(defaultSettings()), asset, source, wav };
}

test("foundation uses only the chosen source and preserves the original session for Undo", () => {
  const { base, asset, source } = fixture();
  const before = JSON.stringify(base);
  const p = loopFoundation(base, asset, source, {
    sourceStart: 2,
    beats: 16,
    nativeBpm: 120,
  });
  assert.equal(JSON.stringify(base), before);
  assert.equal(isLoopFoundation(p), true);
  assert.equal(p.clips![0].sourceDuration, 8);
  assert.equal(p.clips![0].sourceOffset, 2);
  assert.equal(p.sections[0].bars, 4);
  assert.equal(p.tagEnabled, false);
  assert.equal(p.voxEnabled, false);
  assert.deepEqual(p.vocalEvents, []);
  for (const candidate of p.candidates) {
    assert.ok(candidate.tracks.every((track) => track.notes.length === 0));
    assert.ok(candidate.harmony.every((chord) => chord.pitches.length === 0));
    assert.match(candidate.character, /key unverified/);
  }
  for (let selected = 0; selected < 3; selected++) {
    const events = score({ ...p, selected });
    assert.equal(events.length, 1);
    assert.equal(events[0].role, "loop");
    assert.equal(
      seconds(events[0].duration, p.settings.bpm),
      p.clips![0].sourceDuration,
    );
  }
  assert.match(p.clips![0].provenance.keyEstimate, /unverified/);
  assert.equal(p.clips![0].provenance.keyConfidence, 0);
  assert.match(p.clips![0].provenance.credit, /Fixture source terms/);
  assert.match(p.clips![0].provenance.credit, /123 BPM, F# \(unverified\)/);
});

test("region validation rejects mismatched bounds and linked playback keeps seconds consistent", () => {
  const { base, asset, source } = fixture();
  assert.throws(
    () => checkedLoopRegion({ sourceStart: 5, beats: 16, nativeBpm: 120 }, 12),
    /beyond/,
  );
  assert.throws(
    () =>
      checkedLoopRegion({ sourceStart: 0, beats: 32.25, nativeBpm: 120 }, 60),
    /0.25–32/,
  );
  assert.throws(
    () => checkedLoopRegion({ sourceStart: 0, beats: 8, nativeBpm: NaN }, 12),
    /tempo/,
  );
  const original = loopFoundation(base, asset, source, {
    sourceStart: 1,
    beats: 7,
    nativeBpm: 120,
  });
  const transposed = transposeLoop(original, 3);
  const changed = updateFoundationRegion(transposed, {
    sourceStart: 2,
    beats: 9,
    nativeBpm: 125,
  });
  assert.equal(changed.sections[0].bars, 3);
  assert.equal(changed.clips![0].sourceDuration, (9 * 60) / 125);
  assert.equal(changed.clips![0].pitch, 3);
  const event = score(changed)[0];
  assert.equal(score(changed).length, 1);
  assert.ok(
    Math.abs(
      seconds(event.duration, changed.settings.bpm) -
        changed.clips![0].sourceDuration / 2 ** (3 / 12),
    ) < 1e-9,
  );
  assert.equal(changed.assets.find((a) => a.id === asset.id)!.data, asset.data);
});

test("portable export preserves exact source bytes, credits, region and silent score", () => {
  const { base, asset, source, wav } = fixture();
  const p = loopFoundation(base, asset, source, {
    sourceStart: 0,
    beats: 16,
    nativeBpm: 120,
  });
  const files = unzipSync(portableZip(p));
  assert.deepEqual(files[`samples/${asset.id}.wav`], wav);
  const loaded = validateProject(JSON.parse(strFromU8(files["project.json"])));
  assert.equal(
    loaded.assets.find((a) => a.id === asset.id)!.hash,
    source.sha256,
  );
  assert.deepEqual(loaded.clips, p.clips);
  assert.equal(score(loaded).length, 1);
  assert.ok(
    loaded.candidates.every((c) => c.tracks.every((t) => t.notes.length === 0)),
  );
});
