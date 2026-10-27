import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { writeDeliveryFile } from "../scripts/benchmark-delivery-server";
import { parseDeliveryManifest, deliveryRenderPlan } from "../src/io/delivery-plan";
import { newProject } from "../src/engine/compose";
import { defaultSettings } from "../src/engine/profiles";

test("manifest rejects missing/coerced IDs, duplicate jobs and nonlocal source paths", () => {
  const parse = (value: unknown) => parseDeliveryManifest(new TextEncoder().encode(JSON.stringify(value)));
  const job = { id: "baseline", projectUrl: "/private-assets/qa/baseline.json" };
  assert.throws(() => parse({ schemaVersion: 1, jobs: [job] }), /safe runId/);
  assert.throws(() => parse({ schemaVersion: 1, runId: 123, jobs: [job] }), /safe runId/);
  assert.throws(() => parse({ schemaVersion: 1, runId: "qa", jobs: [{ projectUrl: job.projectUrl }] }), /Job IDs/);
  assert.throws(() => parse({ schemaVersion: 1, runId: "qa", jobs: [job, job] }), /unique/);
  for (const projectUrl of ["https://example.com/file.json", "/private-assets/../outside.json", "/private-assets/%2e%2e/file.json"]) {
    assert.throws(() => parse({ schemaVersion: 1, runId: "qa", jobs: [{ ...job, projectUrl }] }), /local/);
  }
  assert.equal(parse({ schemaVersion: 1, runId: "qa", jobs: [job] }).jobs[0].projectUrl, job.projectUrl);
  assert.equal(parse({ schemaVersion: 1, runId: "qa", jobs: [{ ...job, mode: "mixes" }] }).jobs[0].mode, "mixes");
  assert.throws(() => parse({ schemaVersion: 1, runId: "qa", jobs: [{ ...job, mode: "partial" }] }), /Invalid delivery mode/);
});

test("delivery plan keeps distinct full/instrumental returns and includes silent vocal lanes", () => {
  const project = newProject(defaultSettings());
  const before = JSON.stringify(project);
  const plan = deliveryRenderPlan(project);
  assert.equal(new Set(plan.map((part) => part.name)).size, plan.length);
  assert.ok(plan.some((part) => part.tap === "tag"));
  assert.ok(plan.some((part) => part.tap === "vox"));
  assert.equal(plan.filter((part) => part.tap === "fx").length, 2);
  assert.equal(plan.filter((part) => part.instrumentalOnly).length, 3);
  assert.equal(JSON.stringify(project), before);
  assert.deepEqual(deliveryRenderPlan(project, "mixes"), [
    { name: "mix.wav", tap: "mix" },
    { name: "headroom.wav", tap: "headroom" },
  ]);
  assert.deepEqual(deliveryRenderPlan(project, "complete"), plan);
});

test("delivery writes preserve existing output and serialize checkpoint updates", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ish-delivery-"));
  const name = "run-a/benchmark/checkpoint.json";
  const bytes = (text: string) => new TextEncoder().encode(text);
  try {
    const first = await writeDeliveryFile(root, name, bytes("first"), "absent");
    await assert.rejects(
      writeDeliveryFile(root, name, bytes("unexpected"), "absent"),
      /already exists/,
    );
    const results = await Promise.allSettled([
      writeDeliveryFile(root, name, bytes("next-a"), first.sha256),
      writeDeliveryFile(root, name, bytes("next-b"), first.sha256),
    ]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal(results.filter((r) => r.status === "rejected").length, 1);
    assert.equal(await fs.readFile(path.join(root, name), "utf8"), "next-a");
    assert.deepEqual(await fs.readdir(path.dirname(path.join(root, name))), [
      "checkpoint.json",
    ]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("delivery rejects traversal and symbolic-link output", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ish-delivery-"));
  try {
    const bytes = new Uint8Array([1]);
    await assert.rejects(
      writeDeliveryFile(root, "../bad/file.wav", bytes, "absent"),
      /Invalid delivery filename/,
    );
    await fs.mkdir(path.join(root, "run-a"));
    await fs.symlink(root, path.join(root, "run-a", "alias"));
    await assert.rejects(
      writeDeliveryFile(root, "run-a/alias/file.wav", bytes, "absent"),
      /symlink/,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
