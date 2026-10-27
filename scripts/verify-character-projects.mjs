// Run with a working Node runtime: node --import tsx scripts/verify-character-projects.mjs
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import assert from "node:assert/strict";
import { unzipSync, strFromU8 } from "fflate";
import { parseMidi } from "midi-file";
import { validateProject } from "../src/io/persistence.ts";
import { importMidi } from "../src/io/import-midi.ts";
import { score, totalTicks } from "../src/engine/score.ts";
import { score as baselineScore } from "../src/character-baseline/score.ts";
import { BAR, PPQ, isDrum } from "../src/engine/schema.ts";

const root = path.resolve("deliverables/character");
const relative = (file) => path.relative(root, file).split(path.sep).join("/");
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");
const jsonHash = (value) => hash(JSON.stringify(value));
function walk(dir) {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) =>
      entry.isDirectory()
        ? walk(path.join(dir, entry.name))
        : [path.join(dir, entry.name)],
    );
}
const files = walk(root);
const failures = [];
const report = {
  generatedAt: new Date().toISOString(),
  status: "pass",
  scope:
    "Saved score, MIDI, WAV timing and portable asset integrity; no subjective audio audition.",
  acceptedMelody: {},
  projects: [],
  portableProjects: [],
  fullInstrumentals: [],
  generatedSeeds: {},
  suppliedMidi: {},
  limits: [
    "Technical checks do not establish musical acceptance or a verified reference-artist patch.",
    "MIDI carries score notes and bass bends; source loops, rendered reverse audio and browser effect audio remain in the portable project/WAV stems.",
  ],
};
function check(label, work) {
  try {
    return work();
  } catch (error) {
    failures.push({
      check: label,
      error:
        error instanceof Error ? error.message.split("\n")[0] : String(error),
      location: error?.stack
        ?.split("\n")
        .find((line) => line.includes("verify-character-projects.mjs:"))
        ?.trim(),
      actual: typeof error?.actual !== "object" ? error?.actual : undefined,
      expected:
        typeof error?.expected !== "object" ? error?.expected : undefined,
    });
    return null;
  }
}

const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  crcTable[n] = c >>> 0;
}
function crc32(bytes) {
  let c = 0xffffffff;
  for (const byte of bytes) c = crcTable[(c ^ byte) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function verifyZip(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (
    let at = bytes.length - 22;
    at >= Math.max(0, bytes.length - 65557);
    at--
  )
    if (view.getUint32(at, true) === 0x06054b50) {
      end = at;
      break;
    }
  assert.ok(end >= 0, "ZIP end record missing");
  const count = view.getUint16(end + 10, true),
    unpacked = unzipSync(bytes);
  let at = view.getUint32(end + 16, true);
  const names = new Set();
  for (let i = 0; i < count; i++) {
    assert.equal(
      view.getUint32(at, true),
      0x02014b50,
      "ZIP central-directory record",
    );
    const expectedCrc = view.getUint32(at + 16, true),
      size = view.getUint32(at + 24, true),
      nameLength = view.getUint16(at + 28, true),
      extraLength = view.getUint16(at + 30, true),
      commentLength = view.getUint16(at + 32, true),
      localOffset = view.getUint32(at + 42, true);
    const name = new TextDecoder().decode(
      bytes.subarray(at + 46, at + 46 + nameLength),
    );
    assert.ok(!names.has(name), `Duplicate ZIP entry ${name}`);
    names.add(name);
    assert.ok(unpacked[name], `ZIP entry missing after decompression: ${name}`);
    assert.equal(unpacked[name].length, size, `ZIP uncompressed size: ${name}`);
    assert.equal(crc32(unpacked[name]), expectedCrc, `ZIP CRC32: ${name}`);
    assert.equal(
      view.getUint32(localOffset, true),
      0x04034b50,
      `ZIP local record: ${name}`,
    );
    at += 46 + nameLength + extraLength + commentLength;
  }
  assert.equal(Object.keys(unpacked).length, count);
  return { unpacked, count };
}
function sourceBytes(asset) {
  return Buffer.from(asset.data.slice(asset.data.indexOf(",") + 1), "base64");
}
function verifyAssets(project, entries) {
  let hashed = 0;
  for (const asset of project.assets) {
    const bytes = sourceBytes(asset),
      stored = entries?.[`samples/${asset.id}.wav`];
    if (entries) {
      assert.ok(stored, `Missing portable sample ${asset.id}`);
      assert.deepEqual(
        Buffer.from(stored),
        bytes,
        `Portable sample differs from project data URI: ${asset.id}`,
      );
    }
    if (asset.hash) {
      assert.equal(
        hash(bytes),
        asset.hash,
        `Asset source SHA-256: ${asset.id}`,
      );
      hashed++;
    }
  }
  return {
    assets: project.assets.length,
    sourceHashesChecked: hashed,
    dataUriMatchesStoredSamples: !!entries,
  };
}
function noteTuples(notes) {
  return notes
    .map((n) => [n.tick, n.pitch, n.duration, Math.round(n.velocity * 127)])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2] || a[3] - b[3]);
}
function midiAudit(bytes, p, frozen = false) {
  const midi = parseMidi(bytes),
    roles = p.candidates[p.selected].tracks,
    events = (frozen ? baselineScore : score)(p),
    expectedEnd = totalTicks(p);
  assert.equal(midi.header.format, 1);
  assert.equal(midi.header.ticksPerBeat, PPQ);
  assert.equal(midi.tracks.length, roles.length + 1);
  assert.ok(
    midi.tracks[0].some(
      (e) =>
        e.type === "setTempo" &&
        e.microsecondsPerBeat === Math.round(60000000 / p.settings.bpm),
    ),
  );
  assert.ok(
    midi.tracks[0].some(
      (e) =>
        e.type === "timeSignature" && e.numerator === 4 && e.denominator === 4,
    ),
  );
  for (const track of midi.tracks) {
    assert.equal(
      track.reduce((sum, e) => sum + e.deltaTime, 0),
      expectedEnd,
    );
    assert.ok(track.some((e) => e.type === "trackName"));
  }
  const channels = {},
    counts = {},
    bends = [];
  for (let i = 0; i < roles.length; i++) {
    const t = roles[i],
      track = midi.tracks[i + 1],
      channel = isDrum(t.id)
        ? 9
        : ({ keys: 4, bridge: 5, pedal: 6 }[t.id] ?? i);
    assert.ok(
      track.some(
        (e) =>
          e.type === "trackName" && e.text === `${t.name} · ${t.instrument}`,
      ),
    );
    let tick = 0,
      currentBend = 0;
    const pending = new Map(),
      actual = [];
    for (const e of track) {
      tick += e.deltaTime;
      if ("channel" in e)
        assert.equal(e.channel, channel, `${t.id} MIDI channel`);
      if (e.type === "noteOn" && e.velocity > 0) {
        if (t.id === "bass")
          assert.equal(
            currentBend,
            0,
            "A prior glide leaves the next bass note detuned",
          );
        const key = `${e.channel}:${e.noteNumber}`,
          queue = pending.get(key) ?? [];
        queue.push({ tick, pitch: e.noteNumber, velocity: e.velocity / 127 });
        pending.set(key, queue);
      } else if (
        e.type === "noteOff" ||
        (e.type === "noteOn" && e.velocity === 0)
      ) {
        const on = pending.get(`${e.channel}:${e.noteNumber}`)?.shift();
        assert.ok(on, `${t.id} unmatched note-off`);
        actual.push({ ...on, duration: tick - on.tick });
      }
      if (e.type === "pitchBend") {
        currentBend = e.value;
        bends.push({ role: t.id, channel: e.channel, tick, value: e.value });
      }
    }
    assert.ok(
      [...pending.values()].every((queue) => queue.length === 0),
      `${t.id} unmatched note-on`,
    );
    assert.deepEqual(
      noteTuples(actual),
      noteTuples(events.filter((e) => e.role === t.id)),
      `${t.id} MIDI/score disagreement`,
    );
    channels[t.id] = channel;
    counts[t.id] = actual.length;
    if (t.id === "bass") {
      assert.equal(channel, 3);
      for (const [controllerType, value] of [
        [101, 0],
        [100, 0],
        [6, 24],
        [38, 0],
        [101, 127],
        [100, 127],
      ])
        assert.ok(
          track.some(
            (e) =>
              e.type === "controller" &&
              e.controllerType === controllerType &&
              e.value === value &&
              e.channel === 3,
          ),
        );
      assert.equal(bends.filter((e) => e.role === "bass").at(-1)?.value, 0);
    }
  }
  assert.ok(
    bends.every((e) => e.role === "bass" && e.channel === 3),
    "Pitch bends escape the bass channel",
  );
  const expectedGlides = events.filter(
    (e) => e.role === "bass" && e.glide,
  ).length;
  if (expectedGlides)
    assert.ok(
      bends.some((e) => e.value !== 0),
      "Bass glide missing from MIDI",
    );
  return {
    type: 1,
    ppq: PPQ,
    tracks: midi.tracks.length,
    endTicks: expectedEnd,
    noteEvents: Object.values(counts).reduce((sum, n) => sum + n, 0),
    notesByRole: counts,
    channels,
    bassBendRangeSemitones: 24,
    bassGlides: expectedGlides,
    pitchBendEvents: bends.length,
    audioOnlyScoreEventsOmitted: events.filter(
      (e) => !roles.some((t) => t.id === e.role),
    ).length,
  };
}
function wavInfo(file) {
  const fd = fs.openSync(file, "r"),
    header = Buffer.alloc(12);
  fs.readSync(fd, header, 0, 12, 0);
  assert.equal(header.toString("ascii", 0, 4), "RIFF");
  assert.equal(header.toString("ascii", 8, 12), "WAVE");
  let position = 12,
    fmt;
  try {
    while (position + 8 <= fs.statSync(file).size) {
      const chunk = Buffer.alloc(8);
      fs.readSync(fd, chunk, 0, 8, position);
      const name = chunk.toString("ascii", 0, 4),
        size = chunk.readUInt32LE(4);
      if (name === "fmt ") {
        const f = Buffer.alloc(16);
        fs.readSync(fd, f, 0, 16, position + 8);
        fmt = {
          format: f.readUInt16LE(0),
          channels: f.readUInt16LE(2),
          sampleRate: f.readUInt32LE(4),
          bits: f.readUInt16LE(14),
        };
      }
      if (name === "data") {
        assert.ok(fmt);
        const frames = size / ((fmt.channels * fmt.bits) / 8);
        assert.ok(Number.isInteger(frames));
        assert.ok(position + 8 + size <= fs.statSync(file).size);
        return { ...fmt, frames, duration: frames / fmt.sampleRate };
      }
      position += 8 + size + (size % 2);
    }
    throw new Error("WAV data chunk missing");
  } finally {
    fs.closeSync(fd);
  }
}

const projectFiles = files.filter((file) => file.endsWith(".ish.json"));
for (const file of projectFiles)
  check(`project ${relative(file)}`, () => {
    const p = validateProject(readJson(file));
    const assetAudit = verifyAssets(p);
    report.projects.push({
      file: relative(file),
      valid: true,
      seed: p.settings.seed,
      bpm: p.settings.bpm,
      selectedTracks: p.candidates[p.selected].tracks.length,
      bars: totalTicks(p) / BAR,
      clips: p.clips?.length ?? 0,
      ...assetAudit,
    });
  });
const accepted = readJson(
    path.join(root, "baseline/accepted-project.ish.json"),
  ),
  upgraded = readJson(path.join(root, "comparison/ensemble-project.ish.json"));
check("accepted melody preservation", () => {
  const before = accepted.candidates[accepted.selected].tracks.find(
      (t) => t.id === "melody",
    ),
    after = upgraded.candidates[upgraded.selected].tracks.find(
      (t) => t.id === "melody",
    );
  assert.equal(before.notes.length, 28);
  assert.deepEqual(after.notes, before.notes);
  assert.equal(after.instrument, "reed-call");
  assert.equal(after.locked, true);
  report.acceptedMelody = {
    notes: 28,
    completeNoteObjectsIdentical: true,
    noteSha256: jsonHash(before.notes),
    seed: accepted.settings.seed,
    originalInstrument: before.instrument,
    upgradedInstrument: after.instrument,
    savedLock: after.locked,
    harmonyIdentical:
      jsonHash(accepted.candidates[accepted.selected].harmony) ===
      jsonHash(upgraded.candidates[upgraded.selected].harmony),
  };
});

for (const file of files.filter((file) => file.endsWith(".ish.zip")))
  check(`portable ${relative(file)}`, () => {
    const bytes = new Uint8Array(fs.readFileSync(file)),
      { unpacked, count } = verifyZip(bytes),
      p = validateProject(JSON.parse(strFromU8(unpacked["project.json"])));
    const assetAudit = verifyAssets(p, unpacked),
      frozen = relative(file).startsWith("baseline/");
    const midi = midiAudit(unpacked["score.mid"], p, frozen);
    const paired = file.replace(/\.zip$/, ".json");
    if (fs.existsSync(paired))
      assert.deepEqual(
        p,
        readJson(paired),
        "Portable JSON differs from separately editable project",
      );
    const pairedMidi = frozen
      ? path.join(root, "baseline/accepted-export.mid")
      : file.replace(/\.ish\.zip$/, ".mid");
    assert.ok(fs.existsSync(pairedMidi), "Standalone MIDI missing");
    assert.deepEqual(
      Buffer.from(unpacked["score.mid"]),
      fs.readFileSync(pairedMidi),
      "Portable and standalone MIDI differ",
    );
    report.portableProjects.push({
      file: relative(file),
      sha256: hash(bytes),
      crcEntriesChecked: count,
      ...assetAudit,
      midi,
    });
  });

for (const folder of ["original", "loop"])
  check(`${folder} full arrangement`, () => {
    const p = validateProject(
        readJson(path.join(root, folder, "project.ish.json")),
      ),
      ticks = totalTicks(p),
      expectedBpm = folder === "original" ? 148 : 155,
      expectedFrames = Math.ceil(
        (((ticks / PPQ) * 60) / p.settings.bpm + 4) * 44100,
      );
    assert.equal(p.arrangement, true);
    assert.equal(ticks, 64 * BAR);
    assert.equal(p.settings.bpm, expectedBpm);
    const wavs = files.filter(
      (file) =>
        path.dirname(file) === path.join(root, folder) &&
        (path.basename(file).startsWith("stem-") ||
          ["full.wav", "headroom.wav"].includes(path.basename(file))),
    );
    const infos = wavs.map((file) => ({
      file: relative(file),
      ...wavInfo(file),
    }));
    assert.ok(infos.length >= 14);
    for (const info of infos) {
      assert.equal(info.frames, expectedFrames);
      assert.equal(info.channels, 2);
      assert.equal(info.bits, 24);
      assert.equal(info.sampleRate, 44100);
    }
    const events = score(p);
    assert.ok(events.every((e) => e.tick + e.duration <= ticks));
    const midi = midiAudit(
      new Uint8Array(fs.readFileSync(path.join(root, folder, "project.mid"))),
      p,
    );
    if (folder === "loop") {
      assert.equal(p.sourceKind, "supplied-loop");
      assert.equal(
        events.filter((e) =>
          ["melody", "pad", "answer", "keys", "bridge", "pedal"].includes(
            e.role,
          ),
        ).length,
        0,
      );
      assert.ok(p.clips.length >= 3);
      assert.ok(
        p.clips.every(
          (c) =>
            c.provenance.stretch === "native-only" &&
            c.provenance.creator === "@lilfrus" &&
            c.provenance.credit.includes("USE TAG"),
        ),
      );
      assert.ok(
        p.tagEnabled && p.tagAsset && p.assets.some((a) => a.id === p.tagAsset),
      );
    } else
      assert.deepEqual(
        p.candidates[p.selected].tracks.find((t) => t.id === "melody").notes,
        accepted.candidates[accepted.selected].tracks.find(
          (t) => t.id === "melody",
        ).notes,
      );
    report.fullInstrumentals.push({
      kind: folder,
      bars: 64,
      bpm: p.settings.bpm,
      grid: p.settings.grid,
      scoreSeconds: ((ticks / PPQ) * 60) / p.settings.bpm,
      tailSeconds: 4,
      frames: expectedFrames,
      renderedSeconds: expectedFrames / 44100,
      alignedWavFiles: infos.length,
      noUpperVoicesOverSourceLoop: folder === "loop" ? true : undefined,
      midi,
    });
  });

check("three generated seeds", () => {
  const seeds = ["WOVEN-127", "VELVET-304", "COPPER-892"].map((seed) => {
    const p = validateProject(
        readJson(path.join(root, `generated/${seed}.ish.json`)),
      ),
      candidate = p.candidates[p.selected],
      melody = candidate.tracks.find((t) => t.id === "melody").notes,
      firstPitch = melody[0].pitch;
    const raw = melody.map((n) => [n.tick, n.duration, n.pitch]),
      normalized = melody.map((n) => [
        n.tick,
        n.duration,
        n.pitch - firstPitch,
      ]),
      rhythm = melody.map((n) => [n.tick, n.duration]);
    return {
      seed,
      bpm: p.settings.bpm,
      key: p.settings.key,
      recipe: candidate.recipe.id,
      character: candidate.character,
      melodyNotes: melody.length,
      noteHash: jsonHash(raw),
      transpositionInvariantHash: jsonHash(normalized),
      rhythmHash: jsonHash(rhythm),
      distinctMelodicPitches: new Set(melody.map((n) => n.pitch)).size,
    };
  });
  assert.equal(new Set(seeds.map((s) => s.noteHash)).size, 3);
  assert.equal(new Set(seeds.map((s) => s.transpositionInvariantHash)).size, 3);
  report.generatedSeeds = {
    examples: seeds,
    allDistinctNotes: true,
    allDistinctAfterRemovingGlobalTransposition: true,
    rhythmFamilies: new Set(seeds.map((s) => s.rhythmHash)).size,
  };
});

check("supplied MIDI and silent scale guide", () => {
  const p = validateProject(
      readJson(
        path.join(root, "generated/supplied-midi-and-silent-guide.ish.json"),
      ),
    ),
    candidate = p.candidates[p.selected],
    keys = candidate.tracks.find((t) => t.id === "keys"),
    midiRoot =
      "private-assets/stash-kit/1 (@prodfrustration) - personal tdf stash kit v2 (with presets)/Midis",
    phrase = fs.readFileSync(
      path.join(midiRoot, "Midis/Cool Piano Thing (a major).mid"),
    ),
    imported = importMidi(phrase, {
      role: "keys",
      loopBars: 8,
      sourceBase: 60,
      targetRoot: 36,
    });
  assert.equal(p.sourceKind, "supplied-midi");
  assert.equal(keys.notes.length, 146);
  assert.deepEqual(noteTuples(keys.notes), noteTuples(imported.notes));
  assert.ok(keys.notes.every((n) => n.duration > 0));
  const barSignatures = Array.from({ length: 8 }, (_, bar) =>
    jsonHash(
      keys.notes
        .filter((n) => Math.floor(n.tick / BAR) === bar)
        .map((n) => [n.tick % BAR, n.pitch, n.duration])
        .sort((a, b) => a[0] - b[0] || a[1] - b[1]),
    ),
  );
  for (const [a, b] of [
    [0, 2],
    [1, 3],
    [4, 6],
    [5, 7],
  ])
    assert.equal(barSignatures[a], barSignatures[b]);
  assert.equal(new Set(barSignatures).size, 4);
  assert.ok(p.scaleGuides.length > 0);
  for (const guide of p.scaleGuides) {
    assert.equal(guide.enabled, false);
    const bytes = fs.readFileSync(path.join(midiRoot, "Scales", guide.name));
    const g = importMidi(bytes, {
      role: "keys",
      loopBars: 8,
      sourceBase: 60,
      targetRoot: 36,
    });
    assert.equal(g.classification, "scale-guide");
    assert.equal(g.notes.length, 0);
    assert.deepEqual(guide.pitches, g.scalePitches);
    assert.equal(guide.sourceHash, hash(bytes));
  }
  const events = score(p);
  assert.equal(events.length, 146);
  assert.ok(events.every((e) => e.role === "keys"));
  const midi = midiAudit(
    new Uint8Array(
      fs.readFileSync(
        path.join(root, "generated/supplied-midi-and-silent-guide.mid"),
      ),
    ),
    p,
  );
  assert.equal(midi.noteEvents, 146);
  report.suppliedMidi = {
    sourceSha256: hash(phrase),
    playableNotes: 146,
    sourceTimingPreserved: true,
    positiveDurations: true,
    form: "A B A B C D C D",
    notesPerBar: Array.from(
      { length: 8 },
      (_, bar) =>
        keys.notes.filter((n) => Math.floor(n.tick / BAR) === bar).length,
    ),
    silentScaleGuides: p.scaleGuides.map((g) => ({
      name: g.name,
      pitches: g.pitches.length,
      enabled: g.enabled,
    })),
    guideNotesInMidi: 0,
  };
});

report.status = failures.length ? "fail" : "pass";
report.failures = failures;
fs.mkdirSync(path.join(root, "verification"), { recursive: true });
fs.writeFileSync(
  path.join(root, "verification/project-integrity.json"),
  JSON.stringify(report, null, 2) + "\n",
);
console.log(
  JSON.stringify(
    {
      status: report.status,
      validatedProjects: report.projects.length,
      portableZips: report.portableProjects.length,
      crcEntries: report.portableProjects.reduce(
        (sum, item) => sum + item.crcEntriesChecked,
        0,
      ),
      fullInstrumentals: report.fullInstrumentals.length,
      failures,
    },
    null,
    2,
  ),
);
if (failures.length) process.exitCode = 1;
