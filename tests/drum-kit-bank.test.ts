import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { SampleAsset } from "../src/engine/schema";
import { clone } from "../src/engine/schema";
import { newProject } from "../src/engine/compose";
import { encodeWav } from "../src/io/wav";
import { add321Bank, checked321Bank } from "../src/io/drum-kit-bank";

function fixtures(): SampleAsset[] {
  const roles: SampleAsset["role"][] = [
    "bass",
    "bass",
    "kick",
    "clap",
    "clap",
    "open",
    "perc",
    "perc",
    "perc",
  ];
  return roles.map((role, index) => {
    const bytes = Buffer.from(encodeWav([new Float32Array(4410 + index)]));
    const hash = createHash("sha256").update(bytes).digest("hex");
    return {
      id: `sample-321-${role}-${hash.slice(0, 16)}`,
      name: `Source ${index}`,
      originalFilename: `source-${index}.wav`,
      data: `data:audio/wav;base64,${bytes.toString("base64")}`,
      role,
      hash,
      sourceId: `private-assets/321-drumkit/321 drumkit/drums/fixtures/${index}.wav`,
      source: "Fixture provenance",
      license: "Original fixture",
      root: 60,
      tuning: 0,
      rootConfidence: 0,
      manualOverride: false,
      gain: 0.23,
      trimStart: 0,
      trimEnd: (4410 + index) / 44100,
      duration: (4410 + index) / 44100,
      channels: 1,
      sampleRate: 44100,
      choke: role === "bass" ? "bass" : "",
      envelopeMode: role === "bass" ? "gated" : "one-shot",
      loop: false,
    };
  });
}

test("kit loading retains all composition and processing, original bytes, and unconfirmed bass roots", async () => {
  const p = newProject();
  const before = clone(p);
  const input = fixtures();
  const checked = await checked321Bank(input);
  const loaded = add321Bank(p, checked);
  assert.equal(loaded.added, 9);
  assert.equal(loaded.available, 9);
  assert.deepEqual(p, before, "source project is immutable");
  assert.deepEqual(
    { ...loaded.project, assets: before.assets },
    before,
    "no instrument selection, notes, clips, arrangement, vocals or settings change",
  );
  assert.deepEqual(loaded.project.assets.slice(-9), input);
  assert.equal(loaded.project.assets.at(-9)!.rootConfidence, 0);
  assert.equal(loaded.project.assets.at(-9)!.manualOverride, false);
  loaded.project.assets.at(-9)!.root = 27;
  loaded.project.assets.at(-9)!.manualOverride = true;
  loaded.project.assets.at(-9)!.trimStart = 0.01;
  const again = add321Bank(loaded.project, checked);
  assert.equal(again.added, 0);
  assert.deepEqual(
    again.project,
    loaded.project,
    "reload retains explicit root/trim edits",
  );
});

test("kit loader rejects tampered bytes, vocal/loop records and conflicting existing assets", async () => {
  const bank = fixtures();
  const tampered = clone(bank);
  tampered[0].data = tampered[1].data;
  await assert.rejects(checked321Bank(tampered), /Source hash mismatch/);
  const borrowedTag = clone(bank);
  borrowedTag[0].role = "tag";
  await assert.rejects(
    checked321Bank(borrowedTag),
    /Invalid 321 sample metadata/,
  );
  const checked = await checked321Bank(bank);
  const p = newProject();
  p.assets.push({ ...checked[0], data: checked[1].data });
  const before = clone(p);
  assert.throws(() => add321Bank(p, checked), /conflicts/);
  assert.deepEqual(
    p,
    before,
    "conflicting existing source is never overwritten",
  );
});
