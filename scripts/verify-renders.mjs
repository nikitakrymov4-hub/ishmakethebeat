import fs from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { parseMidi } from "midi-file";
import assert from "node:assert/strict";
const roots = ["baseline", "comparison", "calibration", "generated"],
  report = process.argv.includes("--matches-only")
    ? JSON.parse(
        await fs.readFile(
          "deliverables/verification/audio-measurements.json",
          "utf8",
        ),
      )
    : [];
for (const root of process.argv.includes("--matches-only") ? [] : roots) {
  let files = [];
  try {
    files = await fs.readdir(`deliverables/${root}`);
  } catch {
    continue;
  }
  for (const name of files.filter((n) => n.endsWith(".wav"))) {
    const file = `deliverables/${root}/${name}`,
      meta = JSON.parse(
        execFileSync("ffprobe", [
          "-v",
          "error",
          "-show_entries",
          "format=duration:stream=codec_name,sample_rate,channels,bits_per_raw_sample,duration_ts",
          "-of",
          "json",
          file,
        ]).toString(),
      ),
      s = meta.streams[0];
    assert.equal(s.codec_name, "pcm_s24le");
    assert.equal(+s.sample_rate, 44100);
    assert.equal(s.channels, 2);
    assert.equal(+s.bits_per_raw_sample, 24);
    const { spawnSync } = await import("node:child_process");
    const log = spawnSync(
      "ffmpeg",
      [
        "-hide_banner",
        "-nostats",
        "-i",
        file,
        "-af",
        "ebur128=peak=true:framelog=verbose",
        "-f",
        "null",
        "-",
      ],
      { encoding: "utf8", maxBuffer: 2e6 },
    ).stderr;
    const lufs = +(
        log
          .match(/I:\s+(-?[\d.]+) LUFS/g)
          ?.at(-1)
          ?.match(/-?[\d.]+/)?.[0] ?? NaN
      ),
      truePeakDb = +(log.match(/Peak:\s+(-?[\d.]+) dBFS/)?.[1] ?? NaN);
    const raw = execFileSync(
        "ffmpeg",
        ["-v", "error", "-i", file, "-f", "f32le", "-"],
        { maxBuffer: 100e6 },
      ),
      samples = new Float32Array(raw.buffer, raw.byteOffset, raw.length / 4);
    let peak = 0,
      sum = 0,
      nonfinite = 0,
      clipped = 0;
    for (const x of samples) {
      if (!Number.isFinite(x)) nonfinite++;
      peak = Math.max(peak, Math.abs(x));
      sum += x * x;
      if (Math.abs(x) >= 0.99999) clipped++;
    }
    assert.equal(nonfinite, 0);
    assert.equal(clipped, 0);
    const rms = Math.sqrt(sum / samples.length);
    if (
      !name.startsWith("stem-") ||
      !["stem-answer.wav", "stem-open.wav"].includes(name)
    )
      assert.ok(rms > 0.000001, `${file} silent`);
    const entry = {
      file,
      frames: s.duration_ts,
      rate: +s.sample_rate,
      channels: s.channels,
      bits: +s.bits_per_raw_sample,
      duration: +meta.format.duration,
      samplePeakDb: 20 * Math.log10(peak),
      truePeakDb,
      lufs,
      rms,
      clipped,
      nonfinite,
      edgeStart: samples[0],
      edgeEnd: samples.at(-1),
    };
    report.push(entry);
    console.log(
      `${name}: ${entry.duration.toFixed(2)}s / ${lufs} LUFS / ${truePeakDb} dBTP`,
    );
  }
}
for (const root of roots) {
  let files = [];
  try {
    files = await fs.readdir(`deliverables/${root}`);
  } catch {
    continue;
  }
  for (const name of files.filter((n) => n.endsWith(".mid"))) {
    const m = parseMidi(await fs.readFile(`deliverables/${root}/${name}`));
    assert.equal(m.header.format, 1);
    assert.equal(m.header.ticksPerBeat, 480);
    assert.equal(m.tracks.length, 10);
    assert.equal(
      new Set(m.tracks.map((t) => t.reduce((n, e) => n + e.deltaTime, 0))).size,
      1,
    );
  }
}
const stems = report.filter((e) => e.file.includes("/stem-"));
if (stems.length) assert.equal(new Set(stems.map((s) => s.frames)).size, 1);
const master = report.find(
  (e) => e.file === "deliverables/calibration/listening-master.wav",
);
if (master)
  assert.ok(
    master.truePeakDb <= -1,
    `True peak ${master.truePeakDb} exceeds -1 dBTP`,
  );
await fs.writeFile(
  "deliverables/verification/audio-measurements.json",
  JSON.stringify(report, null, 2),
);
// A/B/C listening gains are linear and reversible; retain the untouched originals.
const compare = [
  "deliverables/baseline/A-mix.wav",
  "deliverables/comparison/B-mix.wav",
  "deliverables/comparison/C-mix.wav",
].map((f) => report.find((r) => r.file === f));
if (compare.every(Boolean)) {
  const target = Math.min(...compare.map((r) => r.lufs));
  const gains = [];
  for (const [i, r] of compare.entries()) {
    const gain = target - r.lufs,
      name = "ABC"[i];
    execFileSync("ffmpeg", [
      "-y",
      "-v",
      "error",
      "-i",
      r.file,
      "-af",
      `volume=${gain.toFixed(3)}dB`,
      "-c:a",
      "pcm_s24le",
      "-ar",
      "44100",
      `deliverables/comparison/${name}-matched.wav`,
    ]);
    gains.push({
      name,
      original: r.file,
      originalLUFS: r.lufs,
      linearGainDb: gain,
      targetLUFS: target,
    });
  }
  await fs.writeFile(
    "deliverables/comparison/matching-gains.json",
    JSON.stringify(gains, null, 2),
  );
  // Measure the newly written matches after gain processing, so the report never
  // describes an older comparison file from a previous render pass.
  for (const gain of gains) {
    const file = `deliverables/comparison/${gain.name}-matched.wav`,
      raw = execFileSync(
        "ffmpeg",
        ["-v", "error", "-i", file, "-f", "f32le", "-"],
        { maxBuffer: 20e6 },
      ),
      samples = new Float32Array(raw.buffer, raw.byteOffset, raw.length / 4);
    let peak = 0,
      sum = 0;
    for (const x of samples) {
      assert.ok(Number.isFinite(x));
      assert.ok(Math.abs(x) < 0.99999);
      peak = Math.max(peak, Math.abs(x));
      sum += x * x;
    }
    const { spawnSync } = await import("node:child_process"),
      log = spawnSync(
        "ffmpeg",
        [
          "-hide_banner",
          "-nostats",
          "-i",
          file,
          "-af",
          "ebur128=peak=true:framelog=verbose",
          "-f",
          "null",
          "-",
        ],
        { encoding: "utf8", maxBuffer: 2e6 },
      ).stderr,
      source = report.find((r) => r.file === gain.original),
      entry = {
        ...source,
        file,
        samplePeakDb: 20 * Math.log10(peak),
        rms: Math.sqrt(sum / samples.length),
        lufs: +(
          log
            .match(/I:\s+(-?[\d.]+) LUFS/g)
            ?.at(-1)
            ?.match(/-?[\d.]+/)?.[0] ?? NaN
        ),
        truePeakDb: +(log.match(/Peak:\s+(-?[\d.]+) dBFS/)?.[1] ?? NaN),
        edgeStart: samples[0],
        edgeEnd: samples.at(-1),
      };
    const index = report.findIndex((r) => r.file === file);
    if (index >= 0) report[index] = entry;
    else report.push(entry);
    console.log(
      `${gain.name} matched: ${entry.lufs} LUFS / ${entry.truePeakDb} dBTP`,
    );
  }
  await fs.writeFile(
    "deliverables/verification/audio-measurements.json",
    JSON.stringify(report, null, 2),
  );
}
console.log(
  `Verified ${report.length} WAVs, MIDI headers/timing, alignment, and master true peak.`,
);
