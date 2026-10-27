import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { unzipSync, strFromU8 } from "fflate";
import { newProject } from "../src/engine/compose";
import { BAR, clone, seconds, isDrum } from "../src/engine/schema";
import type { SampleAsset } from "../src/engine/schema";
import { score, totalTicks } from "../src/engine/score";
import { transposeLoop } from "../src/engine/loop";
import {
  loopBeat,
  loopBeatSections,
  isLoopBeat,
  rebuildLoopBeat,
  setLoopBeatKey,
  updateLoopBeatRegion,
} from "../src/io/loop-beat";
import { portableZip } from "../src/io/export";
import { validateProject } from "../src/io/persistence";
import { encodeWav } from "../src/io/wav";
import { isPermittedTdfDrum } from "../src/engine/tdf-kit";
import { missingAssets } from "../src/io/persistence";

function fixture() {
  const wav = encodeWav([
    new Float32Array(44100 * 20),
    new Float32Array(44100 * 20),
  ]);
  const hash = createHash("sha256").update(wav).digest("hex");
  const source = {
    filename: "A real supplied melody.wav",
    path: "private-assets/fixture.wav",
    sha256: hash,
    creator: "Fixture author",
    creditBasis: "Source credit",
    terms: "Keep source credit",
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
    trimStart: 0,
    trimEnd: 20,
    duration: 20,
    gain: 1,
    choke: "",
    license: source.terms,
    hash,
    sampleRate: 44100,
    channels: 2,
    envelopeMode: "gated",
    loop: false,
  };
  const base = newProject();
  const region = { sourceStart: 1, beats: 16, nativeBpm: 148 };
  const options = { key: 7, mode: "minor" as const, seed: "LOOP-TEST-1" };
  return { base, source, asset, region, options, wav };
}
const noteData = (p: ReturnType<typeof newProject>) =>
  p.candidates.map((c) =>
    c.tracks.map((t) => ({ role: t.id, notes: t.notes })),
  );

test("loop beat has a full arrangement and three distinct support scores with identical actual source melody", () => {
  const f = fixture(),
    before = JSON.stringify(f.base);
  const p = loopBeat(f.base, f.asset, f.source, f.region, f.options);
  assert.equal(JSON.stringify(f.base), before);
  assert.equal(isLoopBeat(p), true);
  assert.equal(p.settings.seed, "LOOP-TEST-1");
  assert.ok(seconds(totalTicks(p), p.settings.bpm) >= 90);
  assert.ok(seconds(totalTicks(p), p.settings.bpm) + 4 <= 150);
  assert.ok(
    ["intro", "hook", "break", "return", "outro"].every((kind) =>
      p.sections.some((s) => s.kind === kind),
    ),
  );
  const loopEvents = score(p).filter((e) => e.role === "loop");
  assert.ok(loopEvents.length > 8);
  for (let selected = 0; selected < 3; selected++) {
    const c = p.candidates[selected];
    assert.ok(
      c.tracks
        .filter((t) => t.id !== "bass" && !isDrum(t.id))
        .every((t) => t.notes.length === 0),
    );
    assert.ok(c.tracks.find((t) => t.id === "bass")!.notes.length > 0);
    assert.ok(c.tracks.find((t) => t.id === "hat")!.notes.length > 0);
    assert.ok(
      c.tracks
        .find((t) => t.id === "bass")!
        .notes.every((n) => [7, 2].includes(n.pitch % 12)),
    );
    assert.deepEqual(
      score({ ...p, selected }).filter((e) => e.role === "loop"),
      loopEvents,
    );
    assert.ok(
      score({ ...p, selected }).every(
        (e) => e.role === "loop" || e.role === "bass" || isDrum(e.role),
      ),
    );
  }
  const sequences = p.candidates.map((c) =>
    JSON.stringify(
      c.tracks
        .filter((t) => t.id === "bass" || isDrum(t.id))
        .map((t) => t.notes),
    ),
  );
  assert.equal(new Set(sequences).size, 3);
  const main = p.clips![0];
  assert.equal(main.sourceOffset, 1);
  assert.equal(main.sourceDuration, (16 * 60) / 148);
  assert.equal(main.repeatTicks, 16 * 480);
  assert.equal(main.provenance.keyConfidence, 0);
  assert.match(main.provenance.keyEstimate, /user.selected.*unverified/i);
  assert.match(main.provenance.credit, /Source credit/);
  assert.match(main.provenance.credit, /Keep source credit/);
  for (const section of p.sections.filter((s) =>
    ["hook", "verse", "return"].includes(s.kind),
  ))
    assert.equal(section.bars % 4, 0);
  // No duplicate loop layers; occurrences never overlap even at section transitions.
  for (let i = 1; i < loopEvents.length; i++)
    assert.ok(
      loopEvents[i].tick >= loopEvents[i - 1].tick + loopEvents[i - 1].duration,
    );
});

test("saved seed is reproducible and a fresh seed changes support without changing the source", () => {
  const f = fixture();
  const a = loopBeat(f.base, f.asset, f.source, f.region, f.options),
    b = loopBeat(f.base, f.asset, f.source, f.region, f.options);
  assert.deepEqual(noteData(a), noteData(b));
  const next = loopBeat(f.base, f.asset, f.source, f.region, {
    ...f.options,
    seed: "LOOP-TEST-2",
  });
  assert.notDeepEqual(noteData(a), noteData(next));
  assert.deepEqual(a.clips, next.clips);
  assert.equal(
    next.assets.find((x) => x.id === f.asset.id)!.data,
    f.asset.data,
  );
});

test("tempo/phrase extremes keep a complete main source phrase inside a 90–150 second delivery", () => {
  for (const bpm of [40, 50, 80, 120, 148, 200, 300])
    for (const bars of [1, 2, 4, 8]) {
      const sections = loopBeatSections(bpm, bars),
        duration = (sections.reduce((n, s) => n + s.bars, 0) * 240) / bpm;
      assert.ok(
        duration >= 90 && duration + 4 <= 150,
        `${bpm}/${bars}: ${duration}`,
      );
      assert.ok(sections.every((s) => s.bars >= 1 && s.bars <= 64));
      for (const s of sections.filter((s) =>
        ["hook", "verse", "return"].includes(s.kind),
      ))
        assert.equal(s.bars % bars, 0);
    }
  const f = fixture();
  assert.throws(
    () =>
      loopBeat(f.base, f.asset, f.source, { ...f.region, beats: 7 }, f.options),
    /complete/,
  );
  assert.throws(
    () =>
      loopBeat(f.base, f.asset, f.source, f.region, { ...f.options, key: NaN }),
    /Choose a bass key/,
  );
  assert.throws(
    () =>
      loopBeat(f.base, f.asset, f.source, f.region, { ...f.options, seed: "" }),
    /seed/,
  );
});

test("rebuilding support retains source edits, vocal activity, arrangement and exact encoded bytes", () => {
  const f = fixture(),
    p = loopBeat(f.base, f.asset, f.source, f.region, f.options);
  p.clips![0].gain = 0.49;
  p.clips![0].effects = {
    delay: {
      division: 0.5,
      feedback: 0.1,
      wet: 0.1,
      cutoff: 5000,
      pingPong: true,
    },
  };
  p.sections[0].name = "Edited entrance";
  p.tagEnabled = true;
  p.voxEnabled = true;
  p.vocalEvents = [];
  const selectedTracks = p.candidates[p.selected].tracks;
  const editedHat = selectedTracks.find((t) => t.id === "hat")!;
  editedHat.volume = 0.19;
  editedHat.pan = -0.24;
  editedHat.mute = true;
  editedHat.solo = true;
  editedHat.register = 1;
  editedHat.revision = 4;
  editedHat.effects = {
    hat: {
      mix: 0.2,
      echoBeats: 0.375,
      feedback: 0.15,
      chorus: 0.08,
      crush: 0.04,
      room: 0.08,
    },
  };
  const before = JSON.stringify(p);
  const next = rebuildLoopBeat(p, { ...f.options, seed: "LOOP-NEW-SUPPORT" });
  assert.equal(JSON.stringify(p), before);
  assert.deepEqual(next.clips, p.clips);
  assert.deepEqual(next.sections, p.sections);
  assert.deepEqual(next.vocalEvents, p.vocalEvents);
  assert.equal(next.tagEnabled, true);
  assert.equal(next.voxEnabled, true);
  assert.deepEqual(next.assets, p.assets);
  assert.notDeepEqual(noteData(next), noteData(p));
  for (const c of next.candidates) {
    assert.equal(
      c.phrasePlan,
      undefined,
      "rebuild must not change the legacy eighth-bar arrangement mask",
    );
    for (const t of c.tracks.filter((t) => t.id === "bass" || isDrum(t.id))) {
      const { notes: _newNotes, ...after } = t;
      const { notes: _oldNotes, ...beforeTrack } = selectedTracks.find(
        (old) => old.id === t.id,
      )!;
      assert.deepEqual(after, beforeTrack, `${t.id} mixer/editor/sample state`);
    }
  }
});

test("loop rebuild honors saved density and variation while a locked bass still guides new kicks", () => {
  const f = fixture();
  const p = loopBeat(f.base, f.asset, f.source, f.region, f.options);
  const bass = p.candidates[p.selected].tracks.find((t) => t.id === "bass")!;
  bass.notes = Array.from({ length: 8 }, (_, i) => ({
    id: `manual-${i}`,
    tick: i * BAR + 120,
    duration: 300,
    pitch: 31,
    velocity: 0.7,
  }));
  bass.locked = true;
  p.settings.density = 0;
  p.settings.variation = 0;
  const next = rebuildLoopBeat(p, f.options);
  for (const c of next.candidates) {
    assert.deepEqual(
      c.tracks.find((t) => t.id === "bass"),
      bass,
    );
    const bassTicks = new Set(bass.notes.map((n) => n.tick));
    assert.ok(
      c.tracks
        .find((t) => t.id === "kick")!
        .notes.every((n) => bassTicks.has(n.tick)),
    );
    assert.equal(c.tracks.find((t) => t.id === "clap")!.notes.length, 8);
    assert.equal(c.tracks.find((t) => t.id === "hat")!.notes.length, 64);
    assert.equal(c.tracks.find((t) => t.id === "perc")!.notes.length, 0);
    assert.equal(c.tracks.find((t) => t.id === "open")!.notes.length, 0);
  }
});

test("editable bass basis and source grid remain independent and linked transpose stays consistent", () => {
  const f = fixture(),
    p = loopBeat(f.base, f.asset, f.source, f.region, f.options);
  const keyed = setLoopBeatKey(p, 5, "major");
  assert.equal(keyed.settings.key, 5);
  assert.equal(keyed.clips![0].pitch, 0);
  assert.equal(keyed.clips![0].sourceOffset, p.clips![0].sourceOffset);
  for (let i = 0; i < 3; i++) {
    const old = p.candidates[i].tracks.find((t) => t.id === "bass")!.notes;
    const now = keyed.candidates[i].tracks.find((t) => t.id === "bass")!.notes;
    assert.deepEqual(
      now.map((n) => [n.tick, n.duration]),
      old.map((n) => [n.tick, n.duration]),
    );
    assert.deepEqual(
      now.map((n) => n.pitch),
      old.map((n) => n.pitch - 2),
    );
  }
  const linked = transposeLoop(keyed, 3);
  const updated = updateLoopBeatRegion(linked, {
    sourceStart: 2,
    beats: 8,
    nativeBpm: 150,
  });
  assert.equal(updated.clips![0].duration, 2 * BAR);
  assert.equal(updated.clips![0].sourceDuration, (8 * 60) / 150);
  assert.equal(updated.settings.bpm, 150 * 2 ** (3 / 12));
  assert.ok(
    updated.clips!.every(
      (c) =>
        c.sourceOffset === 2 && c.pitch === 3 && c.provenance.nativeBpm === 150,
    ),
  );
  for (const e of score(updated).filter(
    (e) => e.role === "loop" && e.duration === 2 * BAR,
  ))
    assert.ok(
      Math.abs(
        seconds(e.duration, updated.settings.bpm) -
          e.sourceDuration! / 2 ** (3 / 12),
      ) < 1e-9,
    );
  assert.deepEqual(noteData(updated), noteData(linked));
});

test("portable project reload retains sample melody, all three support scores and credits", () => {
  const f = fixture(),
    p = loopBeat(f.base, f.asset, f.source, f.region, f.options),
    before = clone(p);
  const zip = unzipSync(portableZip(p));
  assert.deepEqual(zip[`samples/${f.asset.id}.wav`], f.wav);
  const loaded = validateProject(JSON.parse(strFromU8(zip["project.json"])));
  assert.deepEqual(loaded, JSON.parse(JSON.stringify(before)));
  assert.deepEqual(score(loaded), score(p));
});

test("loop generation and rebuild enforce verified TDF bytes and retain locked manual support", () => {
  const f = fixture();
  const p = loopBeat(f.base, f.asset, f.source, f.region, f.options);
  assert.deepEqual(missingAssets(p), []);
  for (const c of p.candidates)
    for (const t of c.tracks.filter((t) => t.id === "bass" || isDrum(t.id)))
      assert.ok(
        isPermittedTdfDrum(p.assets.find((a) => a.id === t.instrument)!),
      );
  const missing = clone(f.base);
  missing.assets = [];
  assert.throws(
    () => loopBeat(missing, f.asset, f.source, f.region, f.options),
    /not a verified TDF kit sample/,
  );
  const manual = p.candidates[p.selected].tracks.find((t) => t.id === "hat")!;
  manual.instrument = "short-hat";
  assert.throws(
    () => rebuildLoopBeat(p, { ...f.options, seed: "KIT-REBUILD" }),
    /not a verified TDF kit sample/,
  );
  manual.locked = true;
  manual.volume = 0.19;
  const next = rebuildLoopBeat(p, { ...f.options, seed: "KIT-REBUILD" });
  for (const c of next.candidates)
    assert.deepEqual(
      c.tracks.find((t) => t.id === "hat"),
      manual,
    );
  const editedBytes = clone(p);
  const bass = editedBytes.candidates[editedBytes.selected].tracks.find(
    (t) => t.id === "bass",
  )!;
  editedBytes.assets.find((a) => a.id === bass.instrument)!.data =
    "data:audio/wav;base64,AA==";
  assert.throws(
    () => rebuildLoopBeat(editedBytes, { ...f.options, seed: "KIT-REBUILD" }),
    /not a verified TDF kit sample/,
  );
});
