import test from "node:test";
import assert from "node:assert/strict";
import { newProject, generateCandidates } from "../src/engine/compose";
import { defaultSettings } from "../src/engine/profiles";
import { USER_KIT_ID, applyDrumKit } from "../src/engine/studio-palette";
import { withStudioVocals } from "../src/engine/studio-vox";
import { mixProject, duckWindows } from "../src/engine/mix";
import { isPermittedTdfDrum } from "../src/engine/tdf-kit";
import { clone, isDrum } from "../src/engine/schema";
import type { ScoreEvent } from "../src/engine/schema";
import { validateProject } from "../src/io/persistence";
import fs from "node:fs";
import { addUserDrumBank, checkedUserDrumBank } from "../src/io/user-drum-bank";
import { readWavInfo } from "../src/io/wav";
import { getPrivatePalette, setPrivatePalette } from "../src/engine/culture";
import { rememberUserDrums } from "../src/io/user-drum-bank";
const settings = () => ({
  ...defaultSettings(),
  drumKitId: USER_KIT_ID,
  voxDensity: "sparse" as const,
});
test("attached stash supplies generated bass/drums and keeps existing kick/open patterns", () => {
  const p = newProject(settings());
  const legacy = newProject({ ...settings(), drumKitId: "tdf-original" });
  for (const c of p.candidates)
    for (const t of c.tracks.filter((t) => t.id === "bass" || isDrum(t.id))) {
      const a = p.assets.find((a) => a.id === t.instrument)!;
      assert.ok(isPermittedTdfDrum(a));
      if (["kick", "open"].includes(t.id)) {
        assert.deepEqual(
          t.notes,
          legacy.candidates[p.candidates.indexOf(c)].tracks.find(
            (x) => x.id === t.id,
          )!.notes,
        );
        assert.equal(a.kitId, undefined);
      } else assert.equal(a.kitId, USER_KIT_ID);
    }
  const before = clone(legacy),
    applied = applyDrumKit(legacy, p.assets, USER_KIT_ID);
  assert.deepEqual(legacy, before);
  assert.deepEqual(applied.candidates.slice(1), before.candidates.slice(1));
  for (const t of before.candidates[0].tracks) {
    const after = applied.candidates[0].tracks.find((x) => x.id === t.id)!;
    if (t.id === "bass" || isDrum(t.id))
      assert.deepEqual({ ...after, instrument: t.instrument }, t);
    else assert.deepEqual(after, t);
  }
  assert.deepEqual(applied.sections, before.sections);
});
test("kit changes preserve locked parts, manual source choices and edited studio levels", () => {
  const p = newProject(settings()),
    t = p.candidates[0].tracks.find((t) => t.id === "melody")!;
  t.volume = 0.31;
  t.effects = { saturation: 0.1 };
  const result = generateCandidates(
    { ...settings(), seed: "STUDIO-LEVELS" },
    p.candidates,
  );
  assert.equal(result[0].tracks[0].volume, 0.31);
  assert.deepEqual(result[0].tracks[0].effects, { saturation: 0.1 });
  const bass = p.candidates[0].tracks.find((t) => t.id === "bass")!;
  bass.locked = true;
  const snapshot = clone(bass);
  assert.deepEqual(
    generateCandidates(
      { ...settings(), seed: "STUDIO-LOCK" },
      p.candidates,
    )[0].tracks.find((t) => t.id === "bass"),
    snapshot,
  );
});
test("automatic vox vary source choices with seed, reproduce exactly and preserve manual events", () => {
  const seen = new Set<string>();
  for (let i = 0; i < 20; i++) {
    const p = withStudioVocals(newProject({ ...settings(), seed: `VOX-${i}` }));
    assert.deepEqual(withStudioVocals(p), p);
    for (const v of p.vocalEvents!) seen.add(v.assetId);
    const e = clone(p.vocalEvents![0]);
    e.id = "manual-voice";
    p.vocalEvents!.push(e);
    assert.deepEqual(
      withStudioVocals(p).vocalEvents!.find((x) => x.id === e.id),
      e,
    );
  }
  assert.ok(seen.size >= 3);
});
test("post-composition mix preserves all notes, audio bytes, source assignments and unselected ideas", () => {
  const p = withStudioVocals(newProject(settings())),
    before = clone(p),
    mixed = mixProject(p);
  assert.deepEqual(p, before);
  assert.deepEqual(mixed.assets, p.assets);
  assert.deepEqual(mixed.candidates.slice(1), p.candidates.slice(1));
  for (const t of p.candidates[0].tracks) {
    const after = mixed.candidates[0].tracks.find((x) => x.id === t.id)!;
    assert.deepEqual(after.notes, t.notes);
    assert.equal(after.instrument, t.instrument);
  }
  assert.deepEqual(mixed.sections, p.sections);
  assert.equal(mixed.mixPass!.version, "balance-1");
  assert.deepEqual(
    validateProject(JSON.parse(JSON.stringify(mixed))),
    JSON.parse(JSON.stringify(mixed)),
  );
  const again = mixProject(mixed);
  assert.deepEqual(again, mixed);
});
test("sidechain windows cover actual overlaps, merge rapid hits, and skip kicks without bass", () => {
  const e = (role: string, tick: number, duration: number) =>
    ({ role, tick, duration, gain: 1, velocity: 0.8 }) as ScoreEvent;
  const result = duckWindows(
    [
      e("bass", 0, 960),
      e("kick", 120, 30),
      e("kick", 150, 30),
      e("kick", 3000, 30),
    ],
    120,
    { depthDb: 3, attack: 0.004, release: 0.08 },
  );
  assert.equal(result.length, 1);
  assert.equal(result[0].start, 0.125);
  assert.ok(result[0].end > 0.23);
  assert.equal(
    duckWindows([e("kick", 0, 100)], 120, {
      depthDb: 3,
      attack: 0.004,
      release: 0.08,
    }).length,
    0,
  );
});
test("complete stash library verifies actual bytes, native metadata, and preserves manual root edits", () => {
  const bank = checkedUserDrumBank(
    JSON.parse(
      fs.readFileSync(
        "private-assets/user-tdf-full-drums-20261016.json",
        "utf8",
      ),
    ),
  );
  assert.equal(bank.length, 53);
  for (const a of bank) {
    const bytes = Buffer.from(a.data.split(",")[1], "base64");
    const info = readWavInfo(Uint8Array.from(bytes).buffer);
    assert.ok(info);
    assert.equal(a.sampleRate, info.sampleRate);
    assert.equal(a.channels, info.channels);
  }
  const p = newProject(settings()),
    before = clone(p),
    loaded = addUserDrumBank(p, bank).project;
  assert.deepEqual(p, before);
  assert.deepEqual(loaded.candidates, p.candidates);
  loaded.assets.find((a) => a.id === bank[0].id)!.root = 30;
  assert.deepEqual(addUserDrumBank(loaded, bank).project, loaded);
  const bad = clone(bank);
  bad[0].data = bad[1].data;
  assert.throws(() => checkedUserDrumBank(bad), /source bytes/);
});
test("portable sources support generation without server banks; synth fallback remains explicit", () => {
  const palette = getPrivatePalette(),
    p = newProject(settings());
  try {
    setPrivatePalette([]);
    rememberUserDrums(p.assets);
    assert.doesNotThrow(() => generateCandidates(p.settings, p.candidates));
    setPrivatePalette([]);
    assert.throws(() => newProject(settings()));
    const fallback = newProject({
      ...settings(),
      allowSynthFallback: true,
      voxDensity: "off",
    });
    assert.equal(fallback.assets.length, 0);
    assert.ok(
      fallback.candidates.every(
        (c) =>
          c.tracks.find((t) => t.id === "bass")!.instrument === "textured-808",
      ),
    );
  } finally {
    setPrivatePalette(palette);
  }
});
