import { newProject } from "../engine/compose";
import { defaultSettings } from "../engine/profiles";
import type { Project } from "../engine/schema";
import { clone, seconds } from "../engine/schema";
import { score } from "../engine/score";
import { renderWav } from "../io/export";
import { encodeWav } from "../io/wav";
import { AudioGraph } from "./graph";

function rms(samples: Float32Array, start: number, end: number) {
  let sum = 0;
  const from = Math.floor(start * 44100),
    to = Math.min(samples.length, Math.floor(end * 44100));
  for (let i = from; i < to; i++) sum += samples[i] ** 2;
  return Math.sqrt(sum / Math.max(1, to - from));
}
function frequency(samples: Float32Array, start: number, end: number) {
  const crossings = [];
  for (
    let i = Math.floor(start * 44100);
    i < Math.min(samples.length - 1, Math.floor(end * 44100));
    i++
  )
    if (samples[i] <= 0 && samples[i + 1] > 0)
      crossings.push(i - samples[i] / (samples[i + 1] - samples[i]));
  return ((crossings.length - 1) * 44100) / (crossings.at(-1)! - crossings[0]);
}
function audioEnd(samples: Float32Array) {
  for (let i = samples.length - 1; i >= 0; i--)
    if (Math.abs(samples[i]) > 1e-4) return i / 44100;
  return 0;
}
async function decode(wav: Uint8Array) {
  return new OfflineAudioContext(2, 1, 44100).decodeAudioData(
    new Uint8Array(wav).buffer,
  );
}

export async function verifySampledDrumPitch() {
  const p = newProject({
    ...defaultSettings(),
    bpm: 120,
    listeningGainDb: 0,
    previewGain: 1,
  });
  p.arrangement = true;
  p.sections = [{ id: "qa", name: "QA", kind: "hook", bars: 1 }];
  p.clips = [];
  p.vocalEvents = [];
  p.tagEnabled = false;
  p.voxEnabled = false;
  for (const candidate of p.candidates)
    for (const track of candidate.tracks) {
      track.notes = [];
      track.mute = false;
      track.solo = false;
      track.effects = {};
      track.volume = 1;
      track.pan = 0;
    }
  const tone = Float32Array.from(
    { length: 17640 },
    (_, i) => 0.25 * Math.sin((i * Math.PI * 2 * 440) / 44100),
  );
  const wav = encodeWav([tone, tone]);
  let binary = "";
  for (let i = 0; i < wav.length; i += 16384)
    binary += String.fromCharCode(...wav.subarray(i, i + 16384));
  p.assets = [
    {
      id: "sample-qa-drum-tone",
      name: "QA 440 Hz / 0.4 s",
      role: "hat",
      data: `data:audio/wav;base64,${btoa(binary)}`,
      root: 60,
      tuning: 73,
      trimStart: 0,
      trimEnd: 0.4,
      duration: 0.4,
      sampleRate: 44100,
      channels: 2,
      gain: 1,
      choke: "hats",
      envelopeMode: "one-shot",
      loop: false,
      license: "Synthetic test fixture",
    },
  ];
  const hat = p.candidates[0].tracks.find((t) => t.id === "hat")!;
  hat.instrument = p.assets[0].id;
  hat.notes = [
    { id: "qa-hit", tick: 0, pitch: 42, duration: 120, velocity: 1 },
  ];
  const before = JSON.stringify(p);
  const checks: {
    name: string;
    passed: boolean;
    measured: Record<string, number | boolean>;
  }[] = [];
  const check = (
    name: string,
    passed: boolean,
    measured: Record<string, number | boolean>,
  ) => {
    checks.push({ name, passed, measured });
    if (!passed) throw new Error(`${name}: ${JSON.stringify(measured)}`);
  };
  const render = async (project: Project) =>
    (await decode((await renderWav(project, "hat")).wav)).getChannelData(0);
  let neutral: Float32Array | undefined;
  for (const [label, drumPitch, tuning, expectedRate] of [
    ["legacy-neutral", undefined, undefined, 1],
    ["octave-up", 12, 0, 2],
    ["octave-down", -12, 0, 0.5],
    ["fine-tuning", 0, 100, 2 ** (1 / 12)],
  ] as const) {
    const q = clone(p);
    q.candidates[0].tracks.find((t) => t.id === "hat")!.notes[0].drumPitch =
      drumPitch;
    q.assets[0].drumTuning = tuning;
    const samples = await render(q),
      hz = frequency(samples, 0.02, 0.15),
      end = audioEnd(samples);
    check(
      label,
      Math.abs(hz - 440 * expectedRate) < 0.5 &&
        Math.abs(end - 0.4 / expectedRate) < 0.015,
      {
        hz,
        expectedHz: 440 * expectedRate,
        end,
        expectedEnd: 0.4 / expectedRate,
      },
    );
    if (label === "legacy-neutral") neutral = samples;
  }
  const gated = clone(p);
  gated.assets[0].envelopeMode = "gated";
  gated.candidates[0].tracks.find((t) => t.id === "hat")!.notes[0].drumPitch =
    -12;
  const gate = await render(gated);
  check(
    "pitched-gated-note",
    rms(gate, 0.02, 0.08) > 0.01 && rms(gate, 0.16, 0.3) < 1e-5,
    {
      beforeGateRms: rms(gate, 0.02, 0.08),
      afterGateRms: rms(gate, 0.16, 0.3),
    },
  );
  const choked = clone(p);
  choked.candidates[0].tracks.find((t) => t.id === "hat")!.notes[0].drumPitch =
    -12;
  const open = choked.candidates[0].tracks.find((t) => t.id === "open")!;
  open.instrument = p.assets[0].id;
  open.notes = [
    { id: "choke", tick: 240, pitch: 46, duration: 120, velocity: 1 },
  ];
  const chopped = await render(choked);
  check(
    "pitched-one-shot-choke",
    rms(chopped, 0.02, 0.2) > 0.01 && rms(chopped, 0.3, 0.6) < 1e-5,
    {
      beforeChokeRms: rms(chopped, 0.02, 0.2),
      afterChokeRms: rms(chopped, 0.3, 0.6),
    },
  );
  const explicitZero = clone(p);
  explicitZero.assets[0].drumTuning = 0;
  explicitZero.candidates[0].tracks.find(
    (t) => t.id === "hat",
  )!.notes[0].drumPitch = 0;
  const zero = await render(explicitZero);
  let maxZeroDifference = 0;
  for (let i = 0; i < zero.length; i++)
    maxZeroDifference = Math.max(
      maxZeroDifference,
      Math.abs(zero[i] - neutral![i]),
    );
  check("explicit-zero-equals-legacy", maxZeroDifference === 0, {
    maxDifference: maxZeroDifference,
  });
  // Exercise the live graph configuration in an offline context; this is not a transport seek test.
  const liveConfigured = clone(p);
  liveConfigured.candidates[0].tracks.find(
    (t) => t.id === "hat",
  )!.notes[0].drumPitch = 12;
  const context = new OfflineAudioContext(2, 44100, 44100),
    graph = new AudioGraph(context, liveConfigured, "hat", true);
  await graph.loadSamples();
  for (const event of score(liveConfigured))
    graph.schedule(event, seconds(event.tick, liveConfigured.settings.bpm));
  const buffer = await context.startRendering();
  graph.dispose();
  const liveHz = frequency(buffer.getChannelData(0), 0.02, 0.15);
  check("live-graph-configuration-pitch", Math.abs(liveHz - 880) < 0.5, {
    hz: liveHz,
    expectedHz: 880,
  });
  check("fixture-project-unchanged", JSON.stringify(p) === before, {
    unchanged: JSON.stringify(p) === before,
  });
  return {
    schemaVersion: 1,
    status: "passed",
    createdAt: new Date().toISOString(),
    browser: navigator.userAgent,
    fixture: {
      sampleRate: 44100,
      frequencyHz: 440,
      durationSeconds: 0.4,
      drumMapPitch: 42,
      legacyTuningCents: 73,
    },
    route:
      "Actual renderWav/AudioGraph/OfflineAudioContext outputs, measured after 24-bit WAV decode",
    limitations:
      "Live-configuration check renders AudioGraph with live=true in OfflineAudioContext; it does not certify a real-time device or transport seek.",
    checks,
  };
}
