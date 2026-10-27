import { chromium } from "playwright";
import fs from "node:fs/promises";
import assert from "node:assert/strict";
import path from "node:path";
import { createHash } from "node:crypto";
const output = process.argv[2];
if (!output) throw new Error("Supply a new output directory");
await fs.mkdir(output, { recursive: true });
try {
  await fs.access(path.join(output, "report.json"));
  throw new Error(
    "Output already contains a completed report; use a new directory",
  );
} catch (e) {
  if (e.code !== "ENOENT") throw e;
}
const browser = await chromium.launch({
  channel: "chrome",
  headless: true,
  args: ["--autoplay-policy=no-user-gesture-required", "--disable-gpu"],
});
try {
  const page = await browser.newPage();
  // A plain same-origin document keeps unrelated React/Vite edits from navigating the test host.
  const base = (process.env.STUDIO_URL ?? "http://127.0.0.1:5173").replace(
    /\/$/,
    "",
  );
  const host = `${base}/__ish-bass-test-host`;
  await page.route(host, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>808 source-time regression</title>",
    }),
  );
  await page.goto(host);
  const report = {
    browser: await browser.version(),
    fixtures: [],
    production: [],
    sourceHashes: {},
  };
  for (const name of [
    "src/audio/graph.ts",
    "src/audio/sample-time.ts",
    "deliverables/character/original/project.ish.json",
  ]) {
    const bytes = await fs.readFile(name);
    report.sourceHashes[name] = createHash("sha256")
      .update(bytes)
      .digest("hex");
  }
  for (const name of ["down", "up", "legato-down", "neutral"]) {
    const result = await page.evaluate(async (name) => {
      const { newProject } = await import("/src/engine/compose.ts");
      const { score } = await import("/src/engine/score.ts");
      const { AudioGraph } = await import("/src/audio/graph.ts");
      const { encodeWav } = await import("/src/io/wav.ts");
      const p = newProject();
      p.arrangement = false;
      p.settings.bpm = 120;
      p.settings.space = 0;
      p.settings.masterBypass = true;
      p.tagEnabled = false;
      p.vocalEvents = [];
      p.clips = [];
      for (const c of p.candidates)
        for (const t of c.tracks) {
          t.notes = [];
          t.effects = { saturation: 0 };
        }
      const rate = 44100,
        data = Float32Array.from(
          { length: rate },
          (_, i) => 0.2 * Math.sin((2 * Math.PI * 110 * i) / rate),
        );
      const wav = encodeWav([data], rate);
      let binary = "";
      for (let i = 0; i < wav.length; i += 16384)
        binary += String.fromCharCode(...wav.subarray(i, i + 16384));
      p.assets = [
        {
          id: "sample-time-fixture",
          name: "Original 110 Hz source",
          role: "bass",
          data: `data:audio/wav;base64,${btoa(binary)}`,
          root: 36,
          tuning: 0,
          trimStart: 0,
          trimEnd: 1,
          gain: 0.8,
          choke: "bass",
          license: "Original synthetic diagnostic",
          envelopeMode: "gated",
          envelope: { attack: 0.002, decay: 0.01, sustain: 1, release: 0.015 },
        },
      ];
      const t = p.candidates[0].tracks.find((t) => t.id === "bass");
      t.instrument = p.assets[0].id;
      t.volume = 0.7;
      const note = {
        id: "first",
        tick: 0,
        duration: 2400,
        pitch: 36,
        velocity: 0.8,
      };
      if (name !== "neutral")
        note.glide = { to: name === "up" ? 48 : 24, at: 0, ms: 100 };
      if (name === "legato-down") {
        note.duration = 576;
        t.notes = [
          note,
          {
            id: "second",
            tick: 576,
            duration: 1440,
            pitch: 36,
            velocity: 0.8,
            articulation: "legato",
          },
        ];
      } else t.notes = [note];
      const ctx = new OfflineAudioContext(2, Math.ceil(rate * 3), rate),
        graph = new AudioGraph(ctx, p, "bass");
      await graph.loadSamples();
      for (const event of score(p)) graph.schedule(event, event.tick / 960);
      const audio = await ctx.startRendering(),
        ch = audio.getChannelData(0);
      graph.dispose();
      const rms = (a, b) =>
        Math.sqrt(
          ch
            .slice(Math.round(a * rate), Math.round(b * rate))
            .reduce((n, x) => n + x * x, 0) / Math.round((b - a) * rate),
        );
      let last = 0;
      for (let i = 0; i < ch.length; i++) if (Math.abs(ch[i]) > 1e-4) last = i;
      const encoded = encodeWav([ch, audio.getChannelData(1)]);
      binary = "";
      for (let i = 0; i < encoded.length; i += 16384)
        binary += String.fromCharCode(...encoded.subarray(i, i + 16384));
      return {
        name,
        lastNonSilentSeconds: last / rate,
        rmsAt1_25: rms(1.25, 1.5),
        rmsAt1_05: rms(1.05, 1.2),
        wav: btoa(binary),
      };
    }, name);
    await fs.writeFile(
      path.join(output, `${name}.wav`),
      Buffer.from(result.wav, "base64"),
    );
    delete result.wav;
    // Signal checks for this known fixture, not perceptual or artist-similarity judgments.
    if (name === "down")
      assert.ok(
        result.rmsAt1_25 > 0.02,
        "downward glide must retain its available source after one second",
      );
    if (name === "legato-down")
      assert.ok(
        result.rmsAt1_05 > 0.02,
        "legato must retain the true remaining source",
      );
    if (name === "legato-down")
      assert.ok(
        result.lastNonSilentSeconds > 1.27 &&
          result.lastNonSilentSeconds < 1.42,
        "legato must consume the original source rather than restart it",
      );
    if (name === "up")
      assert.ok(
        result.lastNonSilentSeconds < 0.65,
        "upward glide must exhaust its source at the accelerated rate",
      );
    report.fixtures.push(result);
    console.log(JSON.stringify(result));
  }
  for (const tap of process.argv.includes("--fixtures-only")
    ? []
    : ["mix", "bass", "melody"]) {
    const result = await page.evaluate(async (tap) => {
      const { renderWav } = await import("/src/io/export.ts");
      const p = await (
        await fetch("/deliverables/character/original/project.ish.json")
      ).json();
      const r = await renderWav(p, tap);
      let binary = "";
      for (let i = 0; i < r.wav.length; i += 16384)
        binary += String.fromCharCode(...r.wav.subarray(i, i + 16384));
      return {
        tap,
        duration: r.duration,
        frames: r.frames,
        peak: r.peak,
        rms: r.rms,
        wav: btoa(binary),
      };
    }, tap);
    await fs.writeFile(
      path.join(output, `accepted-${tap}.wav`),
      Buffer.from(result.wav, "base64"),
    );
    delete result.wav;
    report.production.push(result);
    console.log(JSON.stringify(result));
  }
  await fs.writeFile(
    path.join(output, "report.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
} finally {
  await browser.close();
}
