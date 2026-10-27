import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  newProject,
  pendingProject,
  generateCandidates,
  rewrite,
} from "../src/engine/compose";
import { getPrivatePalette, setPrivatePalette } from "../src/engine/culture";
import { defaultSettings } from "../src/engine/profiles";
import { clone } from "../src/engine/schema";
import { score } from "../src/engine/score";
import { validateProject } from "../src/io/persistence";

test("missing-kit UI pending candidates generate fresh with explicit fallback, without bypassing manual protection", () => {
  const assets = getPrivatePalette();
  setPrivatePalette([]);
  try {
    const settings = { ...defaultSettings(), allowSynthFallback: true };
    const pending = pendingProject();
    const before = clone(pending);
    const result = generateCandidates(settings, pending.candidates);
    assert.deepEqual(result, newProject(settings).candidates);
    assert.deepEqual(pending, before);
    assert.ok(
      result.every((c) =>
        c.tracks.every((t) => t.instrument !== "kit-required"),
      ),
    );
    assert.throws(
      () => generateCandidates(defaultSettings(), pending.candidates),
      /Required TDF kit/,
    );
    const real = newProject(settings);
    real.candidates[0].tracks.find((t) => t.id === "bass")!.instrument =
      "manual-patch";
    assert.throws(
      () => generateCandidates(settings, real.candidates),
      /not a verified TDF kit sample/,
    );
    real.candidates[0].tracks.find((t) => t.id === "bass")!.locked = true;
    assert.deepEqual(
      generateCandidates(settings, real.candidates)[0].tracks.find(
        (t) => t.id === "bass",
      ),
      real.candidates[0].tracks.find((t) => t.id === "bass"),
    );
  } finally {
    setPrivatePalette(assets);
  }
});

test("legacy partial rewrite preserves actual non-drum arrangement events across repeat rewrites, locks and portable reload", () => {
  const saved = JSON.parse(
    fs.readFileSync(
      "deliverables/generator-pass-20261016/before.ish.json",
      "utf8",
    ),
  );
  for (const planned of [true, false])
    for (const locked of [true, false]) {
      const p = clone(saved);
      p.arrangement = true;
      p.sections = [
        { id: "h", name: "Hook", kind: "hook", bars: 16 },
        { id: "v", name: "Verse", kind: "verse", bars: 16 },
        { id: "r", name: "Return", kind: "return", bars: 16 },
      ];
      const c = p.candidates[p.selected];
      if (!planned) delete c.phrasePlan;
      c.tracks.find((t: { id: string }) => t.id === "melody").locked = locked;
      const before = score(p).filter((e) =>
        [
          "melody",
          "bass",
          "pad",
          "keys",
          "answer",
          "bridge",
          "pedal",
          "kick",
          "clap",
          "perc",
        ].includes(e.role),
      );
      let next = rewrite(p, ["hat"]);
      for (let i = 0; i < 2; i++) {
        assert.deepEqual(
          score(next).filter((e) =>
            [
              "melody",
              "bass",
              "pad",
              "keys",
              "answer",
              "bridge",
              "pedal",
              "kick",
              "clap",
              "perc",
            ].includes(e.role),
          ),
          before,
        );
        assert.deepEqual(
          next.candidates[p.selected].tracks.find((t) => t.id === "melody"),
          c.tracks.find((t: { id: string }) => t.id === "melody"),
        );
        assert.deepEqual(score(validateProject(clone(next))), score(next));
        next = rewrite(next, ["hat"]);
      }
    }
});
