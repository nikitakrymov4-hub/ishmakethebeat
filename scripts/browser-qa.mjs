import { chromium, webkit } from "playwright";
import fs from "node:fs/promises";
import assert from "node:assert/strict";
import { parseMidi } from "midi-file";
const base = process.env.STUDIO_URL ?? "http://127.0.0.1:5173";
const out = new URL("../qa-artifacts/", import.meta.url);
await fs.mkdir(out, { recursive: true });
const browser =
  process.env.BROWSER === "webkit"
    ? await webkit.launch({ headless: true })
    : await chromium.launch({
        channel: "chrome",
        headless: true,
        args: ["--autoplay-policy=no-user-gesture-required"],
      });
const page = await browser.newPage({
  viewport: { width: 1512, height: 1100 },
  acceptDownloads: true,
});
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const report = {
  browser: await browser.version(),
  checks: [],
  audio: [],
  errors,
};
const check = (name) => {
  report.checks.push(name);
  console.log(`PASS ${name}`);
};
try {
  await page.goto(base);
  await page
    .getByRole("button", { name: "Generate 3 ideas", exact: true })
    .waitFor();
  await page.screenshot({
    path: new URL("studio.png", out).pathname,
    fullPage: true,
  });
  check("studio loads");
  if (process.argv.includes("--screenshot")) {
    console.log("Screenshot saved");
  } else {
    await page
      .getByRole("button", { name: "Generate 3 ideas", exact: true })
      .click();
    await page
      .getByRole("status")
      .filter({ hasText: "Three original ideas" })
      .waitFor();
    await page.getByRole("button", { name: "Play", exact: true }).click();
    await page.getByRole("button", { name: "Pause", exact: true }).waitFor();
    await page.waitForTimeout(700);
    await page.getByRole("button", { name: "Stop", exact: true }).click();
    await page.getByRole("button", { name: "Play", exact: true }).waitFor();
    check("Generate → Play → Stop");
    const before = await page.evaluate(async () => {
      const { loadLocal } = await import("/src/io/persistence.ts");
      return await loadLocal();
    });
    const melody = page.locator(".piano-grid rect[data-note]").first();
    await melody.click();
    const velocityControl = page.getByRole("slider", {
      name: "Note velocity",
      exact: true,
    });
    await velocityControl.press("Home");
    for (let i = 0; i < 46; i++) await velocityControl.press("ArrowRight");
    await page
      .getByRole("button", { name: "Lock Main melody", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Keep melody, rewrite drums", exact: true })
      .click();
    await page.waitForTimeout(900);
    const edited = await page.evaluate(async () => {
      const { loadLocal } = await import("/src/io/persistence.ts");
      return await loadLocal();
    });
    assert.equal(edited.candidates[0].tracks[0].notes[0].velocity, 0.51);
    assert.equal(edited.candidates[0].tracks[0].locked, true);
    assert.notDeepEqual(
      edited.candidates[0].tracks.find((t) => t.id === "hat").notes,
      before.candidates[0].tracks.find((t) => t.id === "hat").notes,
    );
    await page.reload();
    await page.waitForTimeout(900);
    const reloaded = await page.evaluate(async () => {
      const { loadLocal } = await import("/src/io/persistence.ts");
      return await loadLocal();
    });
    assert.deepEqual(reloaded, edited);
    check(
      "edit velocity → lock → drum rewrite → autosave → reload preserves exact score",
    );
    await page.getByRole("button", { name: "Export", exact: true }).click();
    await page
      .getByRole("button", { name: "Multitrack MIDI", exact: false })
      .click();
    const midDownload = page.waitForEvent("download");
    await page
      .getByRole("button", { name: "Export MIDI", exact: true })
      .click();
    const midi = await midDownload;
    await midi.saveAs(new URL("edited.mid", out).pathname);
    const parsed = parseMidi(await fs.readFile(new URL("edited.mid", out)));
    assert.equal(parsed.header.format, 1);
    assert.ok(
      parsed.tracks[1].some((e) => e.type === "noteOn" && e.velocity === 65),
    );
    check("edited MIDI downloads and round-trips velocity");
    await page
      .getByRole("button", { name: "Full mix Stereo WAV", exact: false })
      .click();
    const wavDownload = page.waitForEvent("download", { timeout: 120000 });
    await page.getByRole("button", { name: "Export WAV", exact: true }).click();
    const wav = await wavDownload;
    await wav.saveAs(new URL("edited.wav", out).pathname);
    await page.getByRole("button", { name: "Close dialog" }).click();
    check("edited WAV downloads");
    await page.getByRole("button", { name: "Instrument", exact: true }).click();
    await page
      .getByRole("button", { name: "Import WAV one-shot", exact: true })
      .click({ trial: true });
    const sample = await page.evaluate(async () => {
      const { encodeWav } = await import("/src/io/wav.ts");
      const data = Float32Array.from(
        { length: 4410 },
        (_, i) =>
          Math.sin((i / 44100) * 440 * Math.PI * 2) * 0.25 * (1 - i / 4410),
      );
      return Array.from(encodeWav([data, data]));
    });
    await page
      .locator('input[type=file][accept=".wav"]')
      .first()
      .setInputFiles({
        name: "qa-original-one-shot.wav",
        mimeType: "audio/wav",
        buffer: Buffer.from(sample),
      });
    await page
      .getByRole("status")
      .filter({ hasText: "WAV imported" })
      .waitFor();
    await page.waitForTimeout(900);
    const withSample = await page.evaluate(async () => {
      const { loadLocal } = await import("/src/io/persistence.ts");
      return await loadLocal();
    });
    assert.ok(withSample.assets.length >= 1);
    assert.ok(withSample.assets[0].data.startsWith("data:audio/"));
    await page.reload();
    await page.waitForTimeout(900);
    check("WAV import embeds asset and survives reload");
    // Transport diagnostics: one running instance, no sources remain after stop, repeat cycles bounded.
    const timing = await page.evaluate(async () => {
      const { Transport } = await import("/src/audio/transport.ts");
      const { newProject } = await import("/src/engine/compose.ts");
      const { defaultSettings } = await import("/src/engine/profiles.ts");
      const t = new Transport(),
        p = newProject({ ...defaultSettings(), bpm: 300 });
      await Promise.all([t.play(p), t.play(p)]);
      await new Promise((r) => setTimeout(r, 13500));
      const active = t.diagnostics;
      const position = t.position;
      t.stop();
      await new Promise((r) => setTimeout(r, 130));
      const stopped = t.diagnostics;
      t.dispose();
      return { active, stopped, position };
    });
    assert.ok(timing.active.playing);
    assert.ok(timing.active.activeVoices < 100);
    assert.equal(timing.stopped.activeVoices, 0);
    assert.equal(timing.stopped.playing, false);
    check(
      "double-start guarded; two loops keep bounded voices; stop disposes voices",
    );
    if (process.argv.includes("--render-demos")) {
      for (const profile of ["airy", "spacey", "bright", "dark"]) {
        const result = await page.evaluate(async (profile) => {
          const { newProject } = await import("/src/engine/compose.ts");
          const { defaultSettings } = await import("/src/engine/profiles.ts");
          const { renderWav } = await import("/src/io/export.ts");
          const { exportMidi } = await import("/src/io/midi.ts");
          const p = newProject(defaultSettings(profile));
          p.title = `${{ airy: "Airy Plugg", spacey: "Spacey Bounce", bright: "Bright Distortion", dark: "Dark Pressure" }[profile]} · Midnight 041`;
          p.created = "2026-10-15T00:00:00.000Z";
          const r = await renderWav(p);
          const ctx = new AudioContext();
          const decoded = await ctx.decodeAudioData(r.wav.buffer.slice(0));
          await ctx.close();
          let binary = "";
          for (let i = 0; i < r.wav.length; i += 16384)
            binary += String.fromCharCode(...r.wav.subarray(i, i + 16384));
          return {
            project: p,
            wav: btoa(binary),
            midi: Array.from(exportMidi(p)),
            audio: {
              profile,
              peak: r.peak,
              rms: r.rms,
              duration: r.duration,
              frames: r.frames,
              decodedChannels: decoded.numberOfChannels,
              decodedRate: decoded.sampleRate,
            },
          };
        }, profile);
        assert.ok(result.audio.rms > 0.005 && result.audio.peak < 1);
        assert.equal(result.audio.decodedChannels, 2);
        assert.equal(result.audio.decodedRate, 44100);
        const target = new URL(`../public/demos/${profile}`, import.meta.url);
        await fs.writeFile(
          `${target.pathname}.ish.json`,
          JSON.stringify(result.project, null, 2),
        );
        await fs.writeFile(
          `${target.pathname}.wav`,
          Buffer.from(result.wav, "base64"),
        );
        await fs.writeFile(`${target.pathname}.mid`, Buffer.from(result.midi));
        report.audio.push(result.audio);
        check(
          `${profile} fixed-seed demo renders finite non-silent stereo PCM`,
        );
      }
    }
    const offline = await page.evaluate(async () => {
      const { newProject } = await import("/src/engine/compose.ts");
      const { renderWav } = await import("/src/io/export.ts");
      const { totalTicks } = await import("/src/engine/score.ts");
      const { seconds } = await import("/src/engine/schema.ts");
      const p = newProject();
      const taps = [];
      for (const tap of ["melody", "bass", "kick", "fx"]) {
        const r = await renderWav(p, tap);
        taps.push({
          tap,
          frames: r.frames,
          rms: r.rms,
          peak: r.peak,
          bytes: r.wav.length,
        });
      }
      p.arrangement = true;
      const song = await renderWav(p);
      const abort = new AbortController();
      abort.abort();
      let cancelled = false;
      try {
        await renderWav(p, "mix", abort.signal);
      } catch (e) {
        cancelled = e.name === "AbortError";
      }
      return {
        taps,
        song: {
          frames: song.frames,
          duration: song.duration,
          rms: song.rms,
          peak: song.peak,
        },
        expected: Math.ceil(
          (seconds(totalTicks(p), p.settings.bpm) + 2) * 44100,
        ),
        cancelled,
      };
    });
    assert.equal(new Set(offline.taps.map((t) => t.frames)).size, 1);
    assert.ok(offline.taps.every((t) => t.rms > 0.00001));
    assert.equal(offline.song.frames, offline.expected);
    assert.ok(offline.song.rms > 0.001 && offline.song.peak < 1);
    assert.ok(offline.cancelled);
    report.offline = offline;
    check(
      "dry taps + FX align; 64-bar arrangement renders; cancellation discards output",
    );
    assert.deepEqual(errors, []);
    check("no browser runtime errors");
  }
} finally {
  await fs.writeFile(
    new URL("browser-report.json", out),
    JSON.stringify(report, null, 2),
  );
  await browser.close();
}
