import test from "node:test";
import assert from "node:assert/strict";
import {
  consumedSource,
  sourceEndSeconds,
  rateAt,
  sampleRatePlan,
} from "../src/audio/sample-time";

test("native-rate source budget stays exact and constant transposition retains its duration", () => {
  for (const rate of [0.5, 1, 2, 2 ** (17 / 1200)]) {
    const points = sampleRatePlan(rate, 4);
    assert.ok(Math.abs(sourceEndSeconds(points, 1) - 1 / rate) < 1e-12);
    assert.ok(Math.abs(consumedSource(points, 0.7) - 0.7 * rate) < 1e-12);
  }
});

test("gliding samples integrate source time instead of truncating at their initial rate", () => {
  for (const rate of [0.5, 2]) {
    const points = sampleRatePlan(1, 2.5, { start: 0, duration: 0.1, rate });
    const rampSource = (0.1 * (rate - 1)) / Math.log(rate);
    const expected = 0.1 + (1 - rampSource) / rate;
    const end = sourceEndSeconds(points, 1);
    assert.ok(Math.abs(end - expected) < 1e-12);
    assert.ok(Math.abs(consumedSource(points, end) - 1) < 1e-12);
    assert.ok(Math.abs(rateAt(points, 0.05) - Math.sqrt(rate)) < 1e-12);
  }
});

test("a legato handoff carries consumed audio and the instantaneous unfinished glide rate", () => {
  const first = sampleRatePlan(1, 0.6, { start: 0, duration: 0.1, rate: 0.5 });
  const remaining = 1 - consumedSource(first, 0.6);
  const second = sampleRatePlan(1, 1.5, undefined, rateAt(first, 0.6));
  const end = sourceEndSeconds(second, remaining);
  assert.ok(end > 0.68 && end < 0.7);
  assert.ok(Math.abs(consumedSource(second, end) - remaining) < 1e-12);
  const mid = rateAt(first, 0.04);
  const interrupted = sampleRatePlan(2, 1, undefined, mid);
  assert.equal(interrupted[0].rate, mid);
  assert.ok(mid < 1 && mid > 0.5);
});

test("source exhaustion during a ramp and delayed glides invert within numeric tolerance", () => {
  for (const points of [
    sampleRatePlan(1, 2, { start: 0, duration: 1, rate: 4 }),
    sampleRatePlan(1, 2, { start: 0.5, duration: 0.4, rate: 0.25 }),
    sampleRatePlan(1, 0.02, { start: 0, duration: 0.1, rate: 2 }),
    sampleRatePlan(1, 0.02, { start: 0, duration: 0.1, rate: 2 }, 0.5),
  ]) {
    for (const available of [0, 0.001, 0.02, 0.5, 1, 3]) {
      const end = sourceEndSeconds(points, available);
      assert.ok(Math.abs(consumedSource(points, end) - available) < 1e-10);
    }
  }
});
