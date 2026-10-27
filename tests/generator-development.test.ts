import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  newProject,
  generateCandidates,
  rewrite,
  chordAt,
} from "../src/engine/compose";
import { defaultSettings } from "../src/engine/profiles";
import { getPrivatePalette, setPrivatePalette } from "../src/engine/culture";
import { RECIPES } from "../src/engine/culture-plan";
import { ENSEMBLE_GROUPS } from "../src/engine/ensemble";
import { BAR, LOOP_TICKS, clone, SCALES } from "../src/engine/schema";
import { score } from "../src/engine/score";
import { validateProject } from "../src/io/persistence";
const track = (p: ReturnType<typeof newProject>, role: string) =>
  p.candidates[0].tracks.find((t) => t.id === role)!;

test("selected families reach the final ensemble, with reproducible hooks, rests and coherent grooves", () => {
  for (const [i, recipe] of RECIPES.entries()) {
    const s = {
      ...defaultSettings(),
      seed: "FIRST-PASS-041",
      cultureFamily: recipe.id,
    };
    const p = newProject(s);
    assert.deepEqual(p.candidates, newProject(s).candidates);
    for (const c of p.candidates) {
      assert.equal(c.recipe!.composition!.family, i);
      assert.equal(c.recipe!.composition!.paletteChoice, i);
      assert.ok(
        (recipe.grooves as readonly number[]).includes(
          c.recipe!.composition!.grooveIndex,
        ),
      );
      assert.equal(
        c.tracks.find((t) => t.id === "melody")!.instrument,
        ENSEMBLE_GROUPS[i].foreground,
      );
      assert.deepEqual(
        c.recipe!.resolvedPalette,
        Object.fromEntries(c.tracks.map((t) => [t.id, t.instrument])),
      );
      const cells = [0, 1, 2, 3].map((cell) =>
        c.tracks[0].notes
          .filter((n) => Math.floor(n.tick / (BAR * 2)) === cell)
          .map((n) => [n.tick % (BAR * 2), n.pitch, n.duration]),
      );
      assert.deepEqual(cells[0].slice(0, 3), cells[1].slice(0, 3));
      assert.deepEqual(cells[0].slice(0, 3), cells[3].slice(0, 3));
      assert.notDeepEqual(cells[0], cells[1]);
      assert.notDeepEqual(cells[0], cells[2]);
      assert.ok(cells[2].length < cells[0].length);
      const bass = c.tracks.find((t) => t.id === "bass")!.notes;
      for (const n of c.tracks.find((t) => t.id === "kick")!.notes)
        assert.ok(bass.some((b) => b.tick === n.tick));
      assert.deepEqual(
        c.tracks.find((t) => t.id === "clap")!.notes.map((n) => n.tick),
        Array.from({ length: 8 }, (_, b) => b * BAR + 960),
      );
      assert.ok(bass.filter((n) => n.glide).length <= 1);
    }
  }
});

test("all modes and keys keep bounded monophonic root bass; synth fallback is explicit and repeatable", () => {
  const assets = getPrivatePalette();
  setPrivatePalette([]);
  try {
    assert.throws(() => newProject(), /Required TDF kit/);
    for (const mode of Object.keys(SCALES) as (keyof typeof SCALES)[])
      for (let key = 0; key < 12; key++) {
        const p = newProject({
          ...defaultSettings(),
          mode,
          key,
          allowSynthFallback: true,
        });
        assert.deepEqual(
          generateCandidates(p.settings, p.candidates),
          p.candidates,
        );
        for (const c of p.candidates) {
          for (const t of c.tracks)
            for (const n of t.notes) {
              assert.ok(
                n.tick >= 0 &&
                  n.tick + n.duration <= LOOP_TICKS &&
                  n.duration > 0,
              );
              assert.ok(n.pitch >= 0 && n.pitch <= 127);
            }
          const b = c.tracks.find((t) => t.id === "bass")!.notes;
          for (const [i, n] of b.entries()) {
            assert.equal((n.pitch - chordAt(c.harmony, n.tick).root) % 12, 0);
            assert.ok(n.tick + n.duration <= (b[i + 1]?.tick ?? LOOP_TICKS));
            if (n.glide) {
              assert.ok(n.glide.at < n.duration);
              assert.equal(n.glide.to - n.pitch, 12);
            }
          }
        }
        assert.deepEqual(validateProject(clone(p)), p);
      }
  } finally {
    setPrivatePalette(assets);
  }
});

test("family changes preserve locks and manual patches, while switching owned automatic patches", () => {
  const p = newProject({
    ...defaultSettings(),
    cultureFamily: "paper-lantern",
  });
  const locked = track(p, "bass");
  locked.locked = true;
  const manual = track(p, "answer");
  manual.instrument = "culture-flute";
  const changed = generateCandidates(
    { ...p.settings, cultureFamily: "odd-orbit" },
    p.candidates,
  )[0];
  assert.deepEqual(
    changed.tracks.find((t) => t.id === "bass"),
    locked,
  );
  assert.equal(
    changed.tracks.find((t) => t.id === "answer")!.instrument,
    manual.instrument,
  );
  assert.equal(changed.tracks[0].instrument, ENSEMBLE_GROUPS[2].foreground);
  const again = generateCandidates({ ...p.settings, cultureFamily: "glass-garden" }, [changed, p.candidates[1], p.candidates[2]])[0];
  assert.equal(again.tracks.find(t => t.id === "answer")!.instrument, manual.instrument);
  const next = rewrite(p, ["hat"]);
  for (const t of p.candidates[0].tracks.filter((t) => t.id !== "hat"))
    assert.deepEqual(
      next.candidates[0].tracks.find((x) => x.id === t.id),
      t,
    );
});

test("new arrangements have actual octave responses and shorter verse gates; legacy playback and locks are unchanged", () => {
  const p = newProject();
  p.arrangement = true;
  p.sections = [{ id: "h", name: "Hook", kind: "hook", bars: 16 }];
  const events = score(p).filter((e) => e.role === "melody");
  const first = events.filter((e) => e.tick < 8 * BAR);
  const second = events.filter((e) => e.tick >= 8 * BAR);
  assert.ok(
    second.some((e) =>
      first.some(
        (a) => a.tick === e.tick - 8 * BAR && e.pitch === a.pitch + 12,
      ),
    ),
  );
  const unchanged = clone(p);
  unchanged.candidates[0].recipe!.composition!.version = "culture-plan-1";
  const old = score(unchanged).filter((e) => e.role === "melody");
  assert.deepEqual(
    old.slice(0, first.length).map((e) => e.pitch),
    old.slice(first.length).map((e) => e.pitch),
  );
  track(p, "melody").locked = true;
  assert.deepEqual(
    score(p).filter((e) => e.role === "melody"),
    old,
  );
  const baseline = JSON.parse(
    fs.readFileSync(
      "deliverables/generator-pass-20261016/before.ish.json",
      "utf8",
    ),
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(score(validateProject(baseline)))),
    JSON.parse(
      fs.readFileSync(
        "deliverables/generator-pass-20261016/score-before.json",
        "utf8",
      ),
    ),
  );
  track(p, "melody").locked = false;
  p.sections[0].kind = "verse";
  assert.ok(
    score(p)
      .filter((e) => e.role === "melody")
      .some(
        (e) =>
          e.duration <
          track(p, "melody").notes.find((n) => n.tick === e.tick % LOOP_TICKS)!
            .duration,
      ),
  );
});
