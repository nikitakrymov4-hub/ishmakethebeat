import test from "node:test";
import assert from "node:assert/strict";
import { newProject } from "../src/engine/compose";
import { buildVoxPattern, VOX_PATTERN_PREFIX } from "../src/io/vox-pattern";
import { clone, BAR } from "../src/engine/schema";
import { score, vocalEventIssues } from "../src/engine/score";
import { withoutVocals } from "../src/engine/render-duration";
import { portableZip } from "../src/io/export";
import { validateProject } from "../src/io/persistence";
import { encodeWav } from "../src/io/wav";
import { strFromU8, unzipSync } from "fflate";

const options = {
  assetIds: ["sample-vox-test"],
  seed: "VOX-CONTROL-01",
  density: "sparse" as const,
  placement: "gaps" as const,
  gain: 0.2,
  echo: true,
};
function fixture() {
  const p = newProject();
  p.arrangement = true;
  p.vocalEvents = [];
  p.voxEnabled = true;
  p.assets.push({
    id: "sample-vox-test",
    name: "Original nonverbal test source",
    role: "vox",
    root: 60,
    tuning: 0,
    trimStart: 0,
    trimEnd: 0.45,
    duration: 0.45,
    gain: 0.6,
    choke: "",
    license: "Original synthetic test audio",
    data: `data:audio/wav;base64,${Buffer.from(encodeWav([new Float32Array(19845)])).toString("base64")}`,
  });
  return p;
}
test("accent generation is deterministic, increases density, and leaves every instrumental decision untouched", () => {
  const p = fixture(),
    before = clone(p),
    a = buildVoxPattern(p, options),
    b = buildVoxPattern(p, options);
  assert.deepEqual(p, before);
  assert.deepEqual(a, b);
  assert.deepEqual(a.candidates, p.candidates);
  assert.deepEqual(a.assets, p.assets);
  assert.deepEqual(a.sections, p.sections);
  assert.deepEqual(a.settings, p.settings);
  const regular = buildVoxPattern(p, { ...options, density: "regular" });
  assert.ok(a.vocalEvents!.length > 0);
  assert.ok(regular.vocalEvents!.length > a.vocalEvents!.length);
  assert.deepEqual(vocalEventIssues(a), []);
  for (const e of a.vocalEvents!) {
    assert.equal(e.role, "vox");
    assert.equal(e.pitch, 0);
    assert.equal(e.mode, "gated");
    assert.ok(e.placement.kind === "section");
    const section = a.sections.find(
      (s) => s.id === (e.placement as { sectionId: string }).sectionId,
    )!;
    assert.ok(!["intro", "outro"].includes(section.kind));
    assert.ok(e.placement.tick + e.duration <= section.bars * BAR);
  }
});
test("regeneration replaces only owned accents, preserves manual tags/activity, and section anchors follow edits", () => {
  const p = fixture(),
    withPattern = buildVoxPattern(p, options);
  const manual = {
    ...clone(withPattern.vocalEvents![0]),
    id: "manual-tag",
    role: "tag" as const,
    placement: { kind: "absolute" as const, tick: 0 },
    enabled: false,
  };
  withPattern.vocalEvents!.unshift(manual);
  withPattern.tagEnabled = false;
  withPattern.voxEnabled = false;
  const rebuilt = buildVoxPattern(withPattern, {
    ...options,
    placement: "pickups",
  });
  assert.deepEqual(
    rebuilt.vocalEvents!.find((e) => e.id === "manual-tag"),
    manual,
  );
  assert.equal(rebuilt.tagEnabled, false);
  assert.equal(rebuilt.voxEnabled, false);
  const off = buildVoxPattern(rebuilt, {
    ...options,
    density: "off",
    assetIds: [],
  });
  assert.deepEqual(off.vocalEvents, [manual]);
  assert.deepEqual(off.candidates, p.candidates);
  rebuilt.voxEnabled = true;
  const before = score(rebuilt).filter((e) => e.vocal && e.role === "vox");
  rebuilt.sections[0].bars += 2;
  const after = score(rebuilt).filter((e) => e.vocal && e.role === "vox");
  assert.deepEqual(
    after.map((e) => e.tick),
    before.map((e) => e.tick + 2 * BAR),
  );
});
test("automatic accents cannot select tags or overlap existing manual voices", () => {
  const p = fixture(),
    template = buildVoxPattern(p, options).vocalEvents![0];
  p.assets.push({
    ...p.assets[0],
    id: "sample-tag-test",
    role: "tag",
    name: "Another producer tag",
  });
  assert.throws(
    () => buildVoxPattern(p, { ...options, assetIds: ["sample-tag-test"] }),
    /not a producer tag/,
  );
  p.assets.push({
    ...p.assets[0],
    id: "sample-mislabelled-tag",
    name: "Producer TAG1.wav",
  });
  assert.throws(
    () =>
      buildVoxPattern(p, { ...options, assetIds: ["sample-mislabelled-tag"] }),
    /not a producer tag/,
  );
  p.vocalEvents = [{ ...template, id: "manual-voice" }];
  const result = buildVoxPattern(p, { ...options, placement: "pickups" });
  const events = score(result).filter((e) => e.vocal);
  const manual = events.find((e) => e.vocal!.eventId === "manual-voice")!;
  assert.ok(
    events
      .filter((e) => e.vocal!.eventId.startsWith(VOX_PATTERN_PREFIX))
      .every(
        (e) =>
          e.tick + e.duration <= manual.tick ||
          e.tick >= manual.tick + manual.duration,
      ),
  );
  const legacy = fixture();
  legacy.vocalEvents = undefined;
  legacy.tagAsset = "sample-tag-test";
  assert.throws(() => buildVoxPattern(legacy, options), /editable lane/);
});
test("portable reload preserves editable accents and instrumental-only output removes their sources and sends", () => {
  const p = buildVoxPattern(fixture(), options),
    files = unzipSync(portableZip(p));
  const loaded = validateProject(JSON.parse(strFromU8(files["project.json"])));
  assert.deepEqual(loaded, p);
  assert.equal(loaded.assets[0].data, p.assets[0].data);
  const clean = withoutVocals(loaded);
  assert.ok(score(clean).every((e) => e.role !== "tag" && e.role !== "vox"));
  assert.deepEqual(clean.candidates, p.candidates);
});
