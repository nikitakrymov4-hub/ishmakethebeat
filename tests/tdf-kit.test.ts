import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { getPrivatePalette, setPrivatePalette } from "../src/engine/culture";
import {
  newProject,
  generateCandidates,
  pendingProject,
} from "../src/engine/compose";
import { defaultSettings } from "../src/engine/profiles";
import { isDrum, clone } from "../src/engine/schema";
import { isPermittedTdfDrum, kitBytesSha256 } from "../src/engine/tdf-kit";
import { TDF_KIT_HASH_ROLES } from "../src/engine/tdf-kit-hashes";

test("kit byte verification matches independent SHA-256 and rejects altered or unrelated sources", () => {
  for (const text of ["", "abc", "a".repeat(1000)]) {
    const data = new TextEncoder().encode(text);
    assert.equal(
      kitBytesSha256(data),
      createHash("sha256").update(data).digest("hex"),
    );
  }
  const asset = getPrivatePalette().find(isPermittedTdfDrum)!;
  assert.ok(asset);
  const bytes = Buffer.from(asset.data.split(",")[1], "base64");
  assert.equal(kitBytesSha256(bytes), asset.hash);
  const changed = clone(asset);
  changed.data = "data:audio/wav;base64,AA==";
  assert.equal(isPermittedTdfDrum(changed), false);
  changed.hash = createHash("sha256")
    .update(Buffer.from([0]))
    .digest("hex");
  assert.equal(isPermittedTdfDrum(changed), false);
});
test("every newly generated drum and 808 uses exact bytes from the permitted existing TDF kit set", () => {
  const assets = getPrivatePalette();
  for (const profile of [
    "culture",
    "airy",
    "spacey",
    "bright",
    "dark",
  ] as const)
    for (let i = 0; i < 24; i++) {
      const p = newProject({
        ...defaultSettings(profile),
        seed: `TDF-KIT-${i}`,
      });
      for (const c of p.candidates)
        for (const t of c.tracks.filter(
          (t) => t.id === "bass" || isDrum(t.id),
        )) {
          const a = p.assets.find((a) => a.id === t.instrument)!;
          assert.ok(a, `${t.id} has no source`);
          assert.ok(isPermittedTdfDrum(a));
          assert.ok(TDF_KIT_HASH_ROLES[a.hash!].includes(t.id));
          assert.ok(assets.some((a) => a.id === t.instrument));
        }
    }
});
test("missing kit gives an actionable error with no fallback; loading placeholder contains no generated notes", () => {
  const original = getPrivatePalette();
  setPrivatePalette([]);
  try {
    assert.throws(() => newProject(), /Required TDF kit/);
    const p = pendingProject();
    assert.equal(p.generator, "ish-kit-required");
    assert.ok(
      p.candidates.every((c) => c.tracks.every((t) => t.notes.length === 0)),
    );
  } finally {
    setPrivatePalette(original);
  }
});
test("manual non-kit sounds remain playable/editable but require selection or a lock before automatic replacement", () => {
  const p = newProject(),
    t = p.candidates[0].tracks.find((t) => t.id === "hat")!;
  t.instrument = "short-hat";
  assert.throws(
    () => generateCandidates(p.settings, p.candidates),
    /not a verified TDF kit sample/,
  );
  t.locked = true;
  const result = generateCandidates(
    { ...p.settings, seed: "TDF-LOCK-MANUAL" },
    p.candidates,
  );
  assert.deepEqual(
    result[0].tracks.find((t) => t.id === "hat"),
    t,
  );
});
