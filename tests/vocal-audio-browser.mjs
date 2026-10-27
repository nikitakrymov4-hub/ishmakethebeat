/** Real Web Audio regressions; requires the local Vite app at STUDIO_URL. */
import { chromium } from "playwright";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

const browser = await chromium.launch({
  channel: "chrome",
  headless: true,
  args: ["--autoplay-policy=no-user-gesture-required", "--disable-gpu"],
});
try {
  const page = await browser.newPage();
  await page.goto(process.env.STUDIO_URL ?? "http://127.0.0.1:5173");
  const report = await page.evaluate(async () => {
    const { newProject } = await import("/src/engine/compose.ts");
    const { score } = await import("/src/engine/score.ts");
    const { AudioGraph } = await import("/src/audio/graph.ts");
    const { resumeSpanningClips, Transport } = await import(
      "/src/audio/transport.ts"
    );
    const { encodeWav } = await import("/src/io/wav.ts");
    const { renderWav } = await import("/src/io/export.ts");
    const { withoutVocals } = await import("/src/engine/render-duration.ts");
    const { stereoDelay } = await import("/src/audio/processing.ts");
    const rate = 44100,
      sourceRate = 32000,
      data = Float32Array.from(
        { length: sourceRate * 2 },
        (_, i) => 0.2 * Math.sin((2 * Math.PI * 440 * i) / sourceRate),
      );
    const wav = encodeWav([data], sourceRate);
    let binary = "";
    for (let i = 0; i < wav.length; i += 16384)
      binary += String.fromCharCode(...wav.subarray(i, i + 16384));
    const project = newProject();
    project.arrangement = false;
    project.settings.bpm = 120;
    project.settings.space = 0;
    project.settings.masterBypass = true;
    project.tagEnabled = true;
    project.voxEnabled = true;
    for (const candidate of project.candidates)
      for (const track of candidate.tracks) {
        track.notes = [];
        track.effects = undefined;
      }
    project.clips = [];
    project.assets = [
      {
        id: "sample-vocal-fixture",
        name: "Synthetic regression tone",
        role: "vox",
        data: `data:audio/wav;base64,${btoa(binary)}`,
        root: 60,
        tuning: 0,
        trimStart: 0,
        trimEnd: 2,
        duration: 2,
        gain: 0.8,
        choke: "",
        license: "Original test signal",
      },
    ];
    project.vocalEvents = [
      {
        id: "test-voice",
        name: "Fixture",
        assetId: project.assets[0].id,
        role: "vox",
        enabled: true,
        placement: { kind: "absolute", tick: 0 },
        duration: 1920,
        sourceOffset: 0.2,
        sourceDuration: 1.6,
        gain: 0.7,
        pan: -0.25,
        pitch: 12,
        reverse: false,
        mode: "one-shot",
        fadeIn: 0.2,
        fadeOut: 0.2,
        overlap: "allow",
        provenance: {
          sourceName: "Synthetic regression tone",
          sourceHash: "fixture",
          creator: "Test",
          credit: "Original test signal",
        },
      },
    ];
    const rms = (audio, start = 0, end = audio.length) => {
      let sum = 0;
      for (let i = start; i < end; i++) sum += audio[i] ** 2;
      return Math.sqrt(sum / Math.max(1, end - start));
    };
    const render = async (p, events = score(p), tap = "vox", duration = 3) => {
      const context = new OfflineAudioContext(
        2,
        Math.ceil(rate * duration),
        rate,
      );
      const graph = new AudioGraph(context, p, tap);
      await graph.loadSamples();
      for (const event of events) graph.schedule(event, event.tick / 960);
      const audio = await context.startRendering();
      const channels = [
        audio.getChannelData(0).slice(),
        audio.getChannelData(1).slice(),
      ];
      graph.dispose();
      return channels;
    };
    const seekError = async (reverse) => {
      const p = structuredClone(project);
      p.vocalEvents[0].reverse = reverse;
      const events = score(p),
        full = await render(p, events);
      const seek = resumeSpanningClips(events, 288, p).map((e) => ({
        ...e,
        tick: 0,
      }));
      const resumed = await render(p, seek);
      let error = 0;
      // Skip the resampler's first 64 samples; source-rate and timeline phases
      // should then match the uninterrupted render through the fade-out.
      for (let channel = 0; channel < 2; channel++)
        for (let i = 64; i < Math.round(0.5 * rate) - 64; i++)
          error = Math.max(
            error,
            Math.abs(
              resumed[channel][i] - full[channel][i + Math.round(0.3 * rate)],
            ),
          );
      return {
        maximumError: error,
        remainingRMS: rms(resumed[0]),
        afterEndRMS: rms(resumed[0], Math.ceil(0.501 * rate)),
      };
    };
    const dry = await render(project),
      noFX = await render(project, score(project), "fx");
    const filtered = structuredClone(project);
    filtered.vocalEvents[0].filter = { highpass: 5000, lowpass: 7000 };
    const filteredAudio = await render(filtered);
    const wet = structuredClone(project);
    wet.vocalEvents[0].effects = {
      delay: {
        division: 0.5,
        feedback: 0.25,
        wet: 0.4,
        cutoff: 6000,
        pingPong: true,
      },
      reverb: { wet: 0.25, decay: 0.7, preDelay: 0.03 },
    };
    const wetEvents = score(wet),
      wetDry = await render(wet, wetEvents),
      returns = await render(wet, wetEvents, "fx"),
      headroom = await render(wet, wetEvents, "headroom");
    let reconstructionError = 0,
      reconstructionSquared = 0,
      reconstructionPeakFrame = 0;
    for (let channel = 0; channel < 2; channel++)
      for (let i = 0; i < headroom[channel].length; i++) {
        const error = Math.abs(
          headroom[channel][i] -
            0.73 * (wetDry[channel][i] + returns[channel][i]),
        );
        reconstructionSquared += error * error;
        if (error > reconstructionError) {
          reconstructionError = error;
          reconstructionPeakFrame = i;
        }
      }
    const removed = withoutVocals(wet),
      instrumentalFX = await render(removed, score(removed), "fx");
    const exportWith = await renderWav(wet, "headroom"),
      exportWithout = await renderWav(wet, "headroom", undefined, undefined, {
        instrumentalOnly: true,
      });
    const choke = structuredClone(wet);
    choke.vocalEvents[0].overlap = "choke-group";
    choke.vocalEvents[0].chokeGroup = "test";
    choke.vocalEvents[0].repeats = { count: 1, intervalTicks: 384 };
    const choked = score(choke),
      chokedAudio = await render(choke, choked);
    const chokedReturn = await render(choke, [choked[0]], "fx");
    // Simulate separate transport cycles: both events retain their full score
    // durations, so only the graph can choke the previous cycle's source.
    const crossing = structuredClone(wetEvents[0]);
    crossing.vocal.overlap = "choke-group";
    crossing.vocal.chokeGroup = "cross-cycle";
    const crossingNext = {
      ...structuredClone(crossing),
      id: "next-cycle",
      tick: 384,
      gain: 0,
    };
    const crossingDry = await render(wet, [crossing, crossingNext], "vox"),
      crossingFX = await render(wet, [crossing, crossingNext], "fx");
    const repeats = structuredClone(wet);
    repeats.vocalEvents[0].effects.delay.automation = [
      { tick: 0, wet: 0 },
      { tick: 240, wet: 0.4 },
    ];
    repeats.vocalEvents[0].repeats = { count: 1, intervalTicks: 384 };
    const repeatEvents = score(repeats),
      combinedReturns = await render(repeats, repeatEvents, "fx"),
      returnA = await render(repeats, [repeatEvents[0]], "fx"),
      returnB = await render(repeats, [repeatEvents[1]], "fx");
    let repeatReturnError = 0;
    for (let channel = 0; channel < 2; channel++)
      for (let i = 0; i < combinedReturns[channel].length; i++)
        repeatReturnError = Math.max(
          repeatReturnError,
          Math.abs(
            combinedReturns[channel][i] -
              returnA[channel][i] -
              returnB[channel][i],
          ),
        );
    const sourceOnly = await render(project, score(project), "vox");
    const live = new Transport();
    live.loop = false;
    await live.play(wet, 288);
    const resumedLive = live.diagnostics;
    await new Promise((resolve) => setTimeout(resolve, 150));
    live.stop();
    await new Promise((resolve) => setTimeout(resolve, 120));
    const stoppedLive = live.diagnostics;
    live.dispose();
    const wetSeekComparison = async (
      seekSeconds,
      processed,
      tap = "headroom",
      effect = "both",
    ) => {
      const p = structuredClone(wet);
      if (effect === "delay") delete p.vocalEvents[0].effects.reverb;
      if (effect === "reverb") delete p.vocalEvents[0].effects.delay;
      if (processed) {
        p.vocalEvents[0].filter = { highpass: 150, lowpass: 6000 };
        p.vocalEvents[0].effects.saturation = 0.3;
      }
      const events = score(p),
        full = await render(p, events, tap),
        context = new OfflineAudioContext(2, rate * 3, rate),
        graph = new AudioGraph(context, p, tap);
      await graph.loadSamples();
      const history = await graph.prepareVocalHistory(
          events,
          seekSeconds * 960,
        ),
        at = 0.2;
      graph.playVocalHistory(history, at);
      const transport = new Transport();
      transport.resumeClips(p, seekSeconds * 960, at, graph, events);
      const resumed = await context.startRendering();
      let error = 0,
        squared = 0,
        count = 0,
        peak = [];
      for (let channel = 0; channel < 2; channel++)
        for (let i = 1; i < Math.floor((2.6 - seekSeconds) * rate); i++) {
          const difference =
            resumed.getChannelData(channel)[i + Math.round(at * rate)] -
            full[channel][i + Math.round(seekSeconds * rate)];
          if (Math.abs(difference) > error) {
            error = Math.abs(difference);
            peak = [
              channel,
              i,
              resumed.getChannelData(channel)[i + Math.round(at * rate)],
              full[channel][i + Math.round(seekSeconds * rate)],
            ];
          }
          squared += difference * difference;
          count++;
        }
      graph.dispose();
      return {
        maximumError: error,
        peak,
        rmsError: Math.sqrt(squared / count),
        historySeconds: history?.duration ?? 0,
      };
    };
    const activityCheck = async (offset) => {
      const p = structuredClone(wet);
      p.arrangement = true;
      p.sections = [{ id: "short", name: "Short", kind: "hook", bars: 1 }];
      p.vocalEvents[0].placement.tick = 960;
      const transport = new Transport();
      transport.loop = false;
      await transport.play(p, offset);
      await new Promise((resolve) => setTimeout(resolve, 200));
      const before = { ...transport.diagnostics, position: transport.position };
      transport.updateAtBoundary(withoutVocals(p));
      await new Promise((resolve) => setTimeout(resolve, 250));
      const after = { ...transport.diagnostics, position: transport.position };
      transport.dispose();
      return { before, after };
    };
    const cutoffContext = new OfflineAudioContext(2, 128, rate);
    const prefixAudio = await render(
        wet,
        [{ ...wetEvents[0], duration: 288 }],
        "vox",
      ),
      wholeAudio = await render(wet, wetEvents, "vox");
    let prefixError = 0,
      prefixErrorFrame = 0;
    for (let i = 0; i < 13230; i++) {
      const error = Math.abs(prefixAudio[0][i] - wholeAudio[0][i]);
      if (error > prefixError) {
        prefixError = error;
        prefixErrorFrame = i;
      }
    }
    const cutoffs = [250, 18000].map(
      (cutoff) =>
        stereoDelay(
          cutoffContext,
          cutoffContext.createGain(),
          cutoffContext.createGain(),
          120,
          { division: 0.5, feedback: 0, wet: 0.2, cutoff, pingPong: false },
          (node) => node,
        ).filters[0].frequency.value,
    );
    return {
      browser: navigator.userAgent,
      sampleRate: rate,
      sourceSampleRate: sourceRate,
      forwardSeek: await seekError(false),
      reverseSeek: await seekError(true),
      dryRMS: rms(dry[0]),
      noEffectsRMS: rms(noFX[0]),
      filterRatio: rms(filteredAudio[0]) / rms(dry[0]),
      tailRMS: rms(returns[0], Math.ceil(0.85 * rate), Math.ceil(1.3 * rate)),
      reconstructionError,
      reconstructionRMS: Math.sqrt(
        reconstructionSquared / (headroom[0].length * 2),
      ),
      reconstructionPeakFrame,
      instrumentalFXRMS: rms(instrumentalFX[0]),
      instrumentalRMS: exportWithout.rms,
      exportFrames: [exportWith.frames, exportWithout.frames],
      chokedDurations: choked.map((e) => e.duration / 960),
      chokedReturnRMS: rms(
        chokedReturn[0],
        Math.ceil(0.45 * rate),
        Math.ceil(0.7 * rate),
      ),
      crossCycleSourceAfterChoke: rms(crossingDry[0], Math.ceil(0.401 * rate)),
      crossCycleReturnAfterChoke: rms(
        crossingFX[0],
        Math.ceil(0.45 * rate),
        Math.ceil(0.7 * rate),
      ),
      repeatReturnError,
      chokedFinalSilence: rms(chokedAudio[0], Math.ceil(1.201 * rate)),
      sourceDurationSilence: rms(sourceOnly[0], Math.ceil(0.801 * rate)),
      resumedLive,
      stoppedLive,
      delayCutoffs: cutoffs,
      prefixError,
      prefixErrorFrame,
      wetSeekValidation: {
        maximumErrorTolerance: 0.001,
        rmsErrorTolerance: 0.0001,
        scope:
          "Explicit vocal returns on the current score timeline, compared with uninterrupted synthetic renders at matching sample rate. This is measured approximation, not bit-identical wet seeking.",
        method:
          "Offline rendering of pre-seek processed vocal input, bounded by the -80 dB feedback horizon plus source-filter warmup; remaining wet buffer mixed with warmed resumed sources and new returns.",
        limitations:
          "Native convolution startup and bounded-tail differences remain. Non-vocal shared effects and preceding transport-loop cycles are not reconstructed. No hardware-output capture or subjective audio-quality claim.",
      },
      wetSeek: await wetSeekComparison(0.3, false),
      warmDrySeek: await wetSeekComparison(0.3, false, "vox"),
      fxOnlySeek: await wetSeekComparison(0.3, false, "fx"),
      delayOnlySeek: await wetSeekComparison(0.3, false, "fx", "delay"),
      reverbOnlySeek: await wetSeekComparison(0.3, false, "fx", "reverb"),
      processedWetSeek: await wetSeekComparison(0.3, true),
      endedSourceWetSeek: await wetSeekComparison(1, true),
      finalBarActivity: await activityCheck(1152),
      tailActivity: await activityCheck(1872),
    };
  });
  assert.ok(report.dryRMS > 0.005);
  assert.equal(report.noEffectsRMS, 0);
  assert.ok(report.filterRatio < 0.1, JSON.stringify(report));
  for (const key of ["forwardSeek", "reverseSeek"]) {
    assert.ok(
      report[key].maximumError < 1e-5,
      `${key}: ${JSON.stringify(report[key])}`,
    );
    assert.equal(report[key].afterEndRMS, 0);
  }
  assert.ok(report.tailRMS > 0.0001);
  assert.ok(report.reconstructionError < 1e-6, JSON.stringify(report));
  assert.equal(report.instrumentalFXRMS, 0);
  assert.equal(report.instrumentalRMS, 0);
  assert.equal(report.exportFrames[0], report.exportFrames[1]);
  assert.deepEqual(report.chokedDurations, [0.4, 0.8]);
  assert.ok(report.chokedReturnRMS > 0.0001);
  assert.equal(report.crossCycleSourceAfterChoke, 0);
  assert.ok(report.crossCycleReturnAfterChoke > 0.0001);
  assert.ok(report.repeatReturnError < 1e-6, JSON.stringify(report));
  assert.equal(report.chokedFinalSilence, 0);
  assert.equal(report.sourceDurationSilence, 0);
  assert.equal(report.resumedLive.resumedClips, 1);
  assert.equal(report.stoppedLive.playing, false);
  assert.equal(report.stoppedLive.activeVoices, 0);
  assert.deepEqual(report.delayCutoffs, [250, 18000]);
  assert.equal(report.warmDrySeek.maximumError, 0);
  assert.equal(report.prefixError, 0);
  for (const key of [
    "wetSeek",
    "fxOnlySeek",
    "delayOnlySeek",
    "reverbOnlySeek",
    "processedWetSeek",
    "endedSourceWetSeek",
  ]) {
    assert.ok(
      report[key].maximumError < report.wetSeekValidation.maximumErrorTolerance,
      `${key}: ${JSON.stringify(report[key])}`,
    );
    assert.ok(
      report[key].rmsError < report.wetSeekValidation.rmsErrorTolerance,
      `${key}: ${JSON.stringify(report[key])}`,
    );
  }
  for (const key of ["finalBarActivity", "tailActivity"]) {
    assert.ok(report[key].before.activeVoices > 0, JSON.stringify(report[key]));
    assert.equal(report[key].after.activeVoices, 0);
    assert.equal(report[key].after.boundarySwaps, 1);
    assert.ok(report[key].after.position >= report[key].before.position);
  }
  await fs.mkdir("qa-artifacts", { recursive: true });
  await fs.writeFile(
    "qa-artifacts/vocal-audio-report.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser.close();
}
