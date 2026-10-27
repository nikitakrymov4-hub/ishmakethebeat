import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import crypto from "node:crypto";
import {
  validateAuraCatalog,
  loadAuraPalette,
  auraAsset,
  auraUrl,
  applyAuraPalette,
} from "../src/io/aura-bank";
import type { AuraPalette, AuraEntry } from "../src/io/aura-bank";
import {
  auraCandidate,
  newAuraProject,
  auraSections,
} from "../src/engine/aura-writing";
import { getPrivatePalette } from "../src/engine/culture";
import { defaultSettings } from "../src/engine/profiles";
import { score, totalTicks } from "../src/engine/score";
import { rewrite } from "../src/engine/compose";
import { validateProject } from "../src/io/persistence";
import { samplePlaybackRate } from "../src/audio/sample-playback";
import { LOOP_TICKS, clone, seconds } from "../src/engine/schema";
const catalog = JSON.parse(
  fs.readFileSync("private-assets/aura/playable-catalog-v1.json", "utf8"),
);
const fetchLocal = (async (url: string | URL | Request) => {
  const file = decodeURIComponent(String(url)).slice(1);
  if (!fs.existsSync(file)) return new Response("missing", { status: 404 });
  return new Response(new Uint8Array(fs.readFileSync(file)));
}) as typeof fetch;
const load = (p: AuraPalette) => loadAuraPalette(p, [], fetchLocal);
const project = async () => {
  const bank = await load("piano-wind");
  return newAuraProject(
    { ...defaultSettings(), seed: "AURA-DAWN-137", bpm: 150, key: 5 },
    {
      version: 1,
      palette: "piano-wind",
      direction: "cascade",
      feel: "interrupted",
    },
    bank.selection,
    [...bank.assets, ...getPrivatePalette()],
  );
};
test("small Aura catalog rejects unsafe paths, nonfinite values, octave mistakes and inconsistent fields", () => {
  assert.equal(validateAuraCatalog(catalog).entries.length, 13);
  for (const patch of [
    { relativePath: "../bank.json" },
    { filename: "../x.wav" },
    { gain: NaN },
    { rootMidi: 60 },
    { loop: true },
    { sampleRate: 0 },
  ]) {
    const c = clone(catalog);
    Object.assign(c.entries[0], patch);
    assert.throws(() => validateAuraCatalog(c));
  }
  assert.ok(auraUrl(catalog.entries[0]).includes("%20"));
});
test("raw-byte hash/sample-rate/frames checked before playback; C4=60 correction semantics stay exact", async () => {
  const e = catalog.entries[0] as AuraEntry,
    bytes = new Uint8Array(
      fs.readFileSync("private-assets/aura/" + e.relativePath),
    );
  const a = await auraAsset(e, "melody", bytes, catalog.licenseSummary);
  assert.equal(a.root, e.rootMidi);
  assert.equal(a.tuning, e.tuningCents);
  assert.equal(
    samplePlaybackRate({ role: "melody", pitch: 60 }, { root: 60, tuning: 0 }),
    1,
  );
  assert.equal(
    samplePlaybackRate({ role: "melody", pitch: 60 }, { root: 72, tuning: 0 }),
    0.5,
  );
  assert.equal(
    samplePlaybackRate(
      { role: "melody", pitch: 60 },
      { root: 60, tuning: 100 },
    ),
    2 ** (1 / 12),
  );
  const corrupt = new Uint8Array(bytes);
  corrupt[corrupt.length - 1] ^= 1;
  await assert.rejects(
    () => auraAsset(e, "melody", corrupt, "private"),
    /hash mismatch/,
  );
  await assert.rejects(
    () =>
      auraAsset(
        { ...e, sampleRate: e.sampleRate / 2 },
        "melody",
        bytes,
        "private",
      ),
    /metadata mismatch/,
  );
});
test("lazy loading fetches four selected WAVs only; missing required source fails; saved tuning survives", async () => {
  const urls: string[] = [];
  const fetched = await loadAuraPalette("piano-wind", [], (async (
    u,
    ...rest
  ) => {
    urls.push(String(u));
    return fetchLocal(u, ...rest);
  }) as typeof fetch);
  assert.equal(urls.filter((x) => x.endsWith(".wav")).length, 4);
  assert.equal(fetched.assets.length, 4);
  fetched.assets[0].root += 12;
  fetched.assets[0].tuning = 17;
  fetched.assets[0].gain = 0.27;
  const saved = await loadAuraPalette("piano-wind", fetched.assets, fetchLocal);
  assert.deepEqual(saved.assets, fetched.assets);
  await assert.rejects(
    () =>
      loadAuraPalette("piano-wind", [], (async (u) =>
        String(u).endsWith(".wav")
          ? new Response("missing", { status: 404 })
          : fetchLocal(u)) as typeof fetch),
    /Missing private Aura WAV/,
  );
});
test("multiple seeds and two writing/feel directions vary real events, not just sound IDs", async () => {
  const b = await load("piano-wind"),
    assets = [...b.assets, ...getPrivatePalette()];
  const hashes = new Set();
  for (let i = 0; i < 12; i++) {
    const s = { ...defaultSettings(), seed: "AURA-SEED-" + i };
    const cfg = {
      version: 1 as const,
      palette: "piano-wind" as const,
      direction: "cascade" as const,
      feel: "interrupted" as const,
    };
    const a = auraCandidate(s, cfg, b.selection, assets);
    assert.deepEqual(a, auraCandidate(s, cfg, b.selection, assets));
    hashes.add(
      crypto
        .createHash("sha256")
        .update(JSON.stringify(a.tracks.map((t) => t.notes)))
        .digest("hex"),
    );
    const other = auraCandidate(
      s,
      { ...cfg, direction: "angular", feel: "pulse" },
      b.selection,
      assets,
    );
    assert.notDeepEqual(a.tracks[0].notes, other.tracks[0].notes);
    assert.notDeepEqual(
      a.tracks.find((t) => t.id === "hat")!.notes,
      other.tracks.find((t) => t.id === "hat")!.notes,
    );
    assert.deepEqual(
      a.tracks.find((t) => t.id === "clap")!.notes,
      other.tracks.find((t) => t.id === "clap")!.notes,
    );
  }
  assert.ok(hashes.size >= 10);
});
test("palette swap preserves notes, effects, mix, locks and arrangement; partial rewrites preserve untouched score roles", async () => {
  const p = await project();
  p.candidates[0].tracks[0].locked = true;
  const b = await load("synth-strings");
  const swapped = applyAuraPalette(p, "synth-strings", b.selection, b.assets);
  for (let i = 0; i < 3; i++)
    for (const t of p.candidates[i].tracks) {
      const n = swapped.candidates[i].tracks.find((x) => x.id === t.id)!;
      assert.deepEqual({ ...n, instrument: t.instrument }, t);
    }
  assert.deepEqual(swapped.sections, p.sections);
  assert.deepEqual(swapped.candidates[0].tracks[0], p.candidates[0].tracks[0]);
  const changed = rewrite(p, ["hat"]);
  for (const t of p.candidates[0].tracks)
    if (t.id !== "hat")
      assert.deepEqual(
        changed.candidates[0].tracks.find((x) => x.id === t.id),
        t,
      );
  assert.deepEqual(
    score(changed).filter((e) => e.role === "melody"),
    score(p).filter((e) => e.role === "melody"),
  );
  assert.deepEqual(validateProject(clone(swapped)), swapped);
});
test("80-bar arrangement has actual responses/handoff/ending; event bounds, bass monophony, duration and reload", async () => {
  const p = await project();
  assert.equal(
    auraSections().reduce((n, s) => n + s.bars, 0),
    80,
  );
  assert.equal(seconds(totalTicks(p), 150), 128);
  for (const bpm of [140, 155, 165])
    assert.equal(seconds(totalTicks(p), bpm), (80 * 240) / bpm);
  for (const c of p.candidates)
    for (const t of c.tracks)
      for (const n of t.notes)
        assert.ok(
          n.tick >= 0 &&
            n.duration > 0 &&
            n.tick + n.duration <= LOOP_TICKS &&
            n.pitch >= 0 &&
            n.pitch <= 127,
        );
  const events = score(p);
  for (const e of events)
    assert.ok(
      e.tick >= 0 && e.duration > 0 && e.tick + e.duration <= totalTicks(p),
    );
  const bass = events.filter((e) => e.role === "bass");
  for (let i = 0; i < bass.length - 1; i++)
    assert.ok(bass[i].tick + bass[i].duration <= bass[i + 1].tick);
  const hook = events.filter(
    (e) => e.id.startsWith("main-") && e.role === "melody",
  );
  const verse = events.filter(
    (e) => e.id.startsWith("verse-") && e.role === "melody",
  );
  assert.ok(verse.length < hook.length);
  assert.ok(verse.some((e) => !hook.some((n) => n.pitch === e.pitch)));
  assert.ok(events.some((e) => e.id.includes("handoff")));
  assert.ok(events.some((e) => e.id.includes("ending-")));
  assert.deepEqual(score(validateProject(clone(p))), events);
  const legacy = clone(p);
  delete legacy.auraOriginal;
  assert.notDeepEqual(score(legacy), events);
});

test("Aura writing remains bounded in every key/mode and seed controls real drum pockets", async () => {
  const b = await load("piano-wind"),
    assets = [...b.assets, ...getPrivatePalette()];
  const pockets = new Set<string>();
  for (const mode of ["minor", "major", "dorian", "pentatonic"] as const)
    for (let key = 0; key < 12; key++) {
      const p = newAuraProject(
        { ...defaultSettings(), mode, key, seed: "BOUNDS-" + key },
        {
          version: 1,
          palette: "piano-wind",
          direction: "angular",
          feel: "pulse",
        },
        b.selection,
        assets,
      );
      for (const c of p.candidates)
        for (const t of c.tracks)
          for (const n of t.notes) {
            assert.ok(
              n.tick >= 0 &&
                n.tick + n.duration <= LOOP_TICKS &&
                n.duration > 0,
            );
            assert.ok(n.pitch >= 0 && n.pitch <= 127);
          }
      const bass = score(p).filter((e) => e.role === "bass");
      for (let i = 0; i < bass.length - 1; i++)
        assert.ok(bass[i].tick + bass[i].duration <= bass[i + 1].tick);
      pockets.add(
        JSON.stringify(
          p.candidates[0].tracks
            .find((t) => t.id === "hat")!
            .notes.map((n) => n.tick),
        ),
      );
    }
  assert.equal(pockets.size, 3);
});
