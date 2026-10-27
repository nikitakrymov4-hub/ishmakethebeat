import { newProject } from "../engine/compose";
import { defaultSettings } from "../engine/profiles";
import { renderWav } from "../io/export";
import { encodeWav } from "../io/wav";
import { Transport } from "./transport";
import { AudioGraph } from "./graph";
import { BAR, LOOP_TICKS } from "../engine/schema";
import type {
  Project,
  ScoreEvent,
  SampleAsset,
  AudioClip,
} from "../engine/schema";
function base64(bytes: Uint8Array) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 16384)
    s += String.fromCharCode(...bytes.subarray(i, i + 16384));
  return btoa(s);
}
function frequency(a: Float32Array, rate: number, start: number, end: number) {
  const crossings: number[] = [];
  for (
    let i = Math.floor(start * rate);
    i < Math.min(a.length, Math.floor(end * rate)) - 1;
    i++
  )
    if (a[i] <= 0 && a[i + 1] > 0) crossings.push(i - a[i] / (a[i + 1] - a[i]));
  return ((crossings.length - 1) * rate) / (crossings.at(-1)! - crossings[0]);
}
async function decode(bytes: Uint8Array) {
  const ctx = new AudioContext({ sampleRate: 44100 });
  try {
    return await ctx.decodeAudioData(new Uint8Array(bytes).buffer);
  } finally {
    await ctx.close();
  }
}
function energy(a: Float32Array, rate: number, start: number, end: number) {
  const from = Math.floor(start * rate),
    to = Math.min(a.length, Math.floor(end * rate));
  let sum = 0;
  for (let i = from; i < to; i++) sum += a[i] ** 2;
  return Math.sqrt(sum / Math.max(1, to - from));
}
async function isolated(
  p: Project,
  events: ScoreEvent[],
  tap: string,
  duration = 3,
) {
  for (const event of events) {
    const track = p.candidates[p.selected].tracks.find(
      (t) => t.id === event.role,
    );
    if (track) track.instrument = event.instrument;
  }
  const ctx = new OfflineAudioContext(2, Math.ceil(44100 * duration), 44100),
    graph = new AudioGraph(ctx, p, tap);
  await graph.loadSamples();
  for (const e of events)
    graph.schedule(e, 0.05 + ((e.tick / 480) * 60) / p.settings.bpm);
  const scheduledSources = graph.activeVoices,
    buffer = await ctx.startRendering();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const remaining = graph.activeVoices;
  graph.dispose();
  return { buffer, scheduledSources, remaining };
}
function bassFundamental(
  a: Float32Array,
  rate: number,
  expected: number,
  start: number,
  end: number,
) {
  const from = Math.floor(start * rate),
    to = Math.min(a.length, Math.floor(end * rate)),
    min = Math.floor(rate / (expected * 1.12)),
    max = Math.ceil(rate / (expected * 0.88)),
    correlations: number[] = [];
  let best = min,
    bestValue = -1;
  for (let lag = min - 1; lag <= max + 1; lag++) {
    let dot = 0,
      first = 0,
      second = 0;
    for (let i = from; i < to - lag; i++) {
      dot += a[i] * a[i + lag];
      first += a[i] ** 2;
      second += a[i + lag] ** 2;
    }
    const value = dot / Math.sqrt(Math.max(1e-30, first * second));
    correlations[lag] = value;
    if (lag >= min && lag <= max && value > bestValue) {
      best = lag;
      bestValue = value;
    }
  }
  const left = correlations[best - 1],
    middle = correlations[best],
    right = correlations[best + 1],
    fraction = (left - right) / (2 * (left - 2 * middle + right));
  return {
    hz:
      rate /
      (best +
        (Number.isFinite(fraction)
          ? Math.max(-0.5, Math.min(0.5, fraction))
          : 0)),
    correlation: bestValue,
  };
}
async function verifySourcePalette(
  p: Project,
  event: ScoreEvent,
  say: (s: string) => void,
) {
  const response = await fetch("/private-assets/new-palette.json");
  if (!response.ok)
    throw new Error(
      "New private palette unavailable for required actual-source checks",
    );
  const assets: SampleAsset[] = await response.json(),
    roots = [];
  for (const [filename, root] of [
    ["Plugg (Use 1 Octave Lower).wav", 34],
    ["Jazzfeezy 808 3.wav", 24],
  ] as const) {
    const asset = assets.find((a) => a.name === filename);
    if (!asset || asset.root !== root)
      throw new Error(`${filename}: missing or incorrect mapped source root`);
    p.assets = [asset];
    const target = 36,
      expected = 440 * 2 ** ((target - 69) / 12),
      rendered = await isolated(
        p,
        [
          {
            ...event,
            instrument: asset.id,
            role: "bass",
            pitch: target,
            duration: 720,
          },
        ],
        "bass",
      ),
      measured = bassFundamental(
        rendered.buffer.getChannelData(0),
        44100,
        expected,
        0.15,
        0.4,
      ),
      errorCents = 1200 * Math.log2(measured.hz / expected);
    if (Math.abs(errorCents) > 18 || measured.correlation < 0.75)
      throw new Error(
        `${filename}: source-root playback ${errorCents.toFixed(1)} cents error, correlation ${measured.correlation.toFixed(2)}`,
      );
    roots.push({
      filename,
      sourceRoot: root,
      tuning: asset.tuning,
      target,
      measuredHz: measured.hz,
      errorCents,
      correlation: measured.correlation,
      hash: asset.hash,
    });
    say(
      `${filename}: root MIDI ${root}, tuned playback ${errorCents.toFixed(2)} cents from C2`,
    );
  }
  const sample = assets.find(
    (a) => a.name === "Plugg (Use 1 Octave Lower).wav",
  )!;
  p.assets = [sample];
  const notes: ScoreEvent[] = [
    { ...event, role: "bass", instrument: sample.id, pitch: 36, duration: 240 },
    {
      ...event,
      id: "sample-legato",
      role: "bass",
      instrument: sample.id,
      pitch: 40,
      duration: 240,
      tick: 240,
      articulation: "legato",
    },
  ];
  const legato = await isolated(p, notes, "bass"),
    retrigger = await isolated(
      p,
      notes.map((e) => ({ ...e, articulation: "retrigger" })),
      "bass",
    );
  if (legato.scheduledSources !== 1 || retrigger.scheduledSources !== 2)
    throw new Error(
      "Sample 808 legato did not reuse one source or retrigger failed to create a new attack",
    );
  // Equivalent lookahead scheduling into a rendering context: the second note is added
  // after the context has advanced, as Transport does, rather than all at tick zero.
  const ctx = new OfflineAudioContext(2, legato.buffer.length, 44100),
    graph = new AudioGraph(ctx, p, "bass");
  await graph.loadSamples();
  graph.schedule(notes[0], 0.05);
  const suspension = ctx.suspend(0.2),
    completion = ctx.startRendering();
  await suspension;
  graph.schedule(notes[1], 0.3);
  await ctx.resume();
  const later = await completion;
  let maxDifference = 0;
  for (let ch = 0; ch < 2; ch++) {
    const first = legato.buffer.getChannelData(ch),
      second = later.getChannelData(ch);
    for (let i = 0; i < first.length; i++)
      maxDifference = Math.max(maxDifference, Math.abs(first[i] - second[i]));
  }
  graph.dispose();
  if (maxDifference > 1e-6)
    throw new Error(
      `Lookahead vs static graph render differs by ${maxDifference}`,
    );
  say(
    "Actual sample: continuous legato reuses one 808; retrigger creates a new attack; incremental/static scheduling agrees",
  );
  const hat = assets.find((a) => a.name === "Simple Hat.wav");
  if (!hat) throw new Error("Simple Hat fixture missing");
  p.assets = [hat];
  const rendered = await isolated(
      p,
      [{ ...event, role: "hat", instrument: hat.id, duration: 1, pitch: 60 }],
      "hat",
    ),
    data = rendered.buffer.getChannelData(0),
    early = energy(data, 44100, 0.05, 0.08),
    late = energy(data, 44100, 0.16, 0.35),
    peak = data.reduce((n, x) => Math.max(n, Math.abs(x)), 0);
  if (
    early < 0.001 ||
    late > 1e-6 ||
    peak > 0.35 ||
    hat.trimEnd > 0.12 ||
    hat.gain > 0.5
  )
    throw new Error("Simple Hat one-shot, useful trim, or source gain failed");
  say(
    "Simple Hat: 1-tick trigger retains attack; silent file tail trimmed; +0.33 dBFS source attenuated",
  );
  return {
    roots,
    sampleLegato: {
      continuousSources: legato.scheduledSources,
      retriggerSources: retrigger.scheduledSources,
    },
    lookaheadStaticMaxDifference: maxDifference,
    simpleHat: {
      earlyRms: early,
      lateRms: late,
      peak,
      trimEnd: hat.trimEnd,
      sourceGain: hat.gain,
    },
  };
}
/** Technical checks, not a judgment about musical taste or reference similarity. */
export async function verifyCharacter(say: (s: string) => void) {
  const p = newProject({
    ...defaultSettings("culture"),
    bpm: 120,
    grit: 0,
    space: 0,
    masterBypass: true,
  });
  p.arrangement = false;
  for (const t of p.candidates[0].tracks) {
    t.notes = [];
    delete t.effects;
  }
  const event: ScoreEvent = {
      id: "character",
      tick: 0,
      duration: 960,
      pitch: 66,
      velocity: 0.8,
      role: "melody",
      instrument: "rounded-keys",
      gain: 0.65,
      pan: 0,
      filter: 1,
    },
    tones: Record<
      string,
      { rms: number; attackRms: number; tailRms: number; sideMidDb: number }
    > = {};
  let previous: Float32Array | undefined;
  const differences: number[] = [];
  for (const instrument of [
    "rounded-keys",
    "moving-pad",
    "glass-bell",
    "reed-call",
    "hollow-lead",
    "silk-pedal",
  ]) {
    const { buffer, remaining } = await isolated(
        p,
        [{ ...event, instrument }],
        "melody",
      ),
      left = buffer.getChannelData(0),
      right = buffer.getChannelData(1);
    let side = 0,
      mid = 0,
      sum = 0;
    for (let i = 0; i < left.length; i++) {
      if (!Number.isFinite(left[i]) || !Number.isFinite(right[i]))
        throw new Error("Non-finite instrument voice");
      side += (left[i] - right[i]) ** 2;
      mid += (left[i] + right[i]) ** 2;
      sum += left[i] ** 2;
    }
    const rms = Math.sqrt(sum / left.length);
    if (rms < 0.001 || remaining)
      throw new Error(`${instrument} did not render or release its voices`);
    if (previous) {
      let dot = 0,
        a = 0,
        b = 0;
      for (let i = 0; i < left.length; i++) {
        dot += left[i] * previous[i];
        a += left[i] ** 2;
        b += previous[i] ** 2;
      }
      const correlation = Math.abs(dot) / Math.sqrt(a * b);
      if (correlation > 0.98)
        throw new Error(`${instrument} is effectively the previous instrument`);
      differences.push(correlation);
    }
    previous = left.slice();
    tones[instrument] = {
      rms,
      attackRms: energy(left, 44100, 0.05, 0.1),
      tailRms: energy(left, 44100, 1.05, 1.5),
      sideMidDb: 10 * Math.log10(Math.max(1e-20, side) / Math.max(1e-20, mid)),
    };
    say(`${instrument}: exposed tone rendered, all voices released`);
  }
  if (tones["moving-pad"].sideMidDb < -24)
    throw new Error("Pad stereo movement was collapsed");

  const bass = [
    {
      ...event,
      instrument: "round-sub",
      role: "bass" as const,
      duration: 480,
      pitch: 33,
      articulation: "retrigger" as const,
    },
    {
      ...event,
      id: "continuation",
      instrument: "round-sub",
      role: "bass" as const,
      tick: 480,
      duration: 480,
      pitch: 40,
      articulation: "legato" as const,
    },
  ];
  const legato = await isolated(p, bass, "bass"),
    bassData = legato.buffer.getChannelData(0),
    from = frequency(bassData, 44100, 0.15, 0.4),
    to = frequency(bassData, 44100, 0.7, 0.95),
    before = energy(bassData, 44100, 0.46, 0.53),
    across = energy(bassData, 44100, 0.54, 0.62);
  if (
    legato.scheduledSources !== 2 ||
    Math.abs(from - 55) > 1 ||
    Math.abs(to - 82.4069) > 1 ||
    across < before * 0.45
  )
    throw new Error("Cross-note synth legato retriggered or lost pitch");
  const bassRight = legato.buffer.getChannelData(1);
  for (let i = 0; i < bassData.length; i++)
    if (Math.abs(bassData[i] - bassRight[i]) > 1e-6)
      throw new Error("Bass was not centered mono");
  say(
    `Cross-note legato: one continuous sub + harmonic, ${from.toFixed(2)} → ${to.toFixed(2)} Hz`,
  );

  const impulse = Float32Array.from({ length: 4410 }, (_, i) =>
    i < 441
      ? Math.sin((i / 44100) * Math.PI * 2 * 1900) * 0.3 * (1 - i / 441)
      : 0,
  );
  p.assets = [
    {
      id: "sample-delay-test",
      name: "delay impulse",
      data: `data:audio/wav;base64,${base64(encodeWav([impulse], 44100))}`,
      role: "answer",
      root: 60,
      tuning: 0,
      trimStart: 0,
      trimEnd: 0.1,
      gain: 0.8,
      choke: "",
      license: "Original technical fixture",
      envelopeMode: "one-shot",
    },
  ];
  const answer = p.candidates[0].tracks.find((t) => t.id === "answer")!;
  answer.instrument = p.assets[0].id;
  answer.effects = {
    delay: {
      division: 0.5,
      feedback: 0.4,
      wet: 0.6,
      cutoff: 7000,
      pingPong: true,
      automation: [{ tick: 960, wet: 0 }],
    },
  };
  const delayed = await isolated(
      p,
      [
        {
          ...event,
          role: "answer",
          instrument: answer.instrument,
          effects: answer.effects,
        },
      ],
      "fx",
      2,
    ),
    l = delayed.buffer.getChannelData(0),
    r = delayed.buffer.getChannelData(1),
    leftFirst = energy(l, 44100, 0.29, 0.33),
    rightFirst = energy(r, 44100, 0.29, 0.33),
    rightSecond = energy(r, 44100, 0.54, 0.58),
    afterAutomation = energy(l, 44100, 1.1, 1.9) + energy(r, 44100, 1.1, 1.9);
  if (
    leftFirst < 0.001 ||
    leftFirst < rightFirst * 8 ||
    rightSecond < 0.0001 ||
    afterAutomation > 1e-6
  )
    throw new Error("Stereo delay timing, routing, or automation failed");
  say(
    "Tempo delay: first left echo at 250 ms, right at 500 ms; stored wet automation silences tail",
  );
  const sourcePalette = await verifySourcePalette(p, event, say);
  const clipBuses = await verifyClipBuses(say);
  const transportClips = await verifyTransportClips(say);
  return {
    instruments: tones,
    adjacentToneCorrelations: differences,
    bassLegato: {
      scheduledSources: legato.scheduledSources,
      fromHz: from,
      toHz: to,
      transitionRmsRatio: across / before,
    },
    delay: { leftFirst, rightFirst, rightSecond, afterAutomation },
    sourcePalette,
    clipBuses,
    transportClips,
  };
}
/** Two audio clips may share a stem role while keeping independent delay buses. */
export async function verifyClipBuses(say: (s: string) => void) {
  const p = newProject({
    ...defaultSettings("airy"),
    bpm: 120,
    space: 0,
    grit: 0,
  });
  for (const track of p.candidates[0].tracks) {
    track.notes = [];
    delete track.effects;
  }
  const tone = Float32Array.from({ length: 4410 }, (_, i) =>
    i < 441
      ? Math.sin((i / 44100) * 1900 * Math.PI * 2) * 0.4 * (1 - i / 441)
      : 0,
  );
  p.assets = [
    {
      id: "sample-loop-bus-test",
      name: "Original bus fixture",
      data: `data:audio/wav;base64,${base64(encodeWav([tone], 44100))}`,
      role: "loop",
      root: 60,
      tuning: 0,
      trimStart: 0,
      trimEnd: 0.1,
      gain: 0.8,
      choke: "",
      license: "Original verification signal",
      envelopeMode: "gated",
    },
  ];
  p.clips = [0, 1].map(
    (n): AudioClip => ({
      id: `fixture-${n}`,
      assetId: p.assets[0].id,
      name: `Clip ${n}`,
      kind: "supplied-loop",
      role: "loop",
      tick: n * 960,
      duration: 96,
      sourceOffset: 0,
      sourceDuration: 0.1,
      gain: 0.65,
      pan: 0,
      pitch: 0,
      reverse: false,
      effects: {
        delay: {
          division: n ? 0.5 : 0.125,
          feedback: 0.1,
          wet: n ? 0.6 : 0,
          cutoff: 7000,
          pingPong: true,
        },
      },
      provenance: {
        sourceHash: "original-fixture",
        sourceName: "Original verification signal",
        creator: "ishmakethebeat",
        credit: "Original technical fixture",
        nativeBpm: 120,
        tempoConfidence: 1,
        keyEstimate: "unpitched test burst",
        keyConfidence: 0,
        downbeatOffset: 0,
        beats: 0.2,
        stretch: "native-only",
      },
    }),
  );
  const events: ScoreEvent[] = p.clips.map((clip) => ({
      id: clip.id,
      busId: `${clip.role}:${clip.id}`,
      role: clip.role,
      instrument: clip.assetId,
      tick: clip.tick,
      duration: clip.duration,
      pitch: 60,
      velocity: 0.8,
      gain: clip.gain,
      pan: 0,
      filter: 1,
      sourceOffset: 0,
      sourceDuration: 0.1,
      effects: clip.effects,
      effectTick: 0,
    })),
    fx = (await isolated(p, events, "fx", 2)).buffer.getChannelData(0),
    dry = (await isolated(p, events, "loop", 2)).buffer.getChannelData(0),
    silentFirst = energy(fx, 44100, 0.08, 0.8),
    wrongEarlyDivision = energy(fx, 44100, 1.105, 1.15),
    correctSecond = energy(fx, 44100, 1.29, 1.34),
    dryFirst = energy(dry, 44100, 0.05, 0.09),
    drySecond = energy(dry, 44100, 1.05, 1.09);
  if (
    silentFirst > 1e-6 ||
    wrongEarlyDivision > 1e-6 ||
    correctSecond < 0.001 ||
    dryFirst < 0.001 ||
    Math.abs(dryFirst - drySecond) > 1e-6
  )
    throw new Error(
      "Independent clip effects or shared-role dry-stem routing failed",
    );
  say(
    "Two loop clips retain independent delay divisions/wet levels and both appear in the aligned loop stem",
  );
  return {
    silentFirst,
    wrongEarlyDivision,
    correctSecond,
    dryFirst,
    drySecond,
  };
}
/** Real browser AudioContext playback, including pause/resume and a boundary swap. */
export async function verifyTransportClips(say: (s: string) => void) {
  const wait = (ms: number) =>
      new Promise((resolve) => setTimeout(resolve, ms)),
    p = newProject({
      ...defaultSettings("airy"),
      bpm: 300,
      space: 0,
      grit: 0,
      previewGain: 0.2,
    });
  for (const track of p.candidates[0].tracks) {
    track.notes = [];
    delete track.effects;
  }
  p.arrangement = false;
  const signal = Float32Array.from(
    { length: Math.round(44100 * 6.4) },
    (_, i) => Math.sin((i / 44100) * 220 * Math.PI * 2) * 0.15,
  );
  p.assets = [
    {
      id: "sample-transport-loop",
      name: "Original sustained transport fixture",
      data: `data:audio/wav;base64,${base64(encodeWav([signal], 44100))}`,
      role: "loop",
      root: 60,
      tuning: 0,
      trimStart: 0,
      trimEnd: 6.4,
      gain: 0.7,
      choke: "",
      license: "Original technical test oscillator",
      envelopeMode: "gated",
    },
  ];
  p.clips = [
    {
      id: "transport-fixture",
      assetId: p.assets[0].id,
      name: "Transport fixture",
      kind: "supplied-loop",
      role: "loop",
      tick: 0,
      duration: LOOP_TICKS,
      sourceOffset: 0,
      sourceDuration: 6.4,
      gain: 0.5,
      pan: 0,
      pitch: 0,
      reverse: false,
      provenance: {
        sourceHash: "original-fixture",
        sourceName: "Original technical oscillator",
        creator: "ishmakethebeat",
        credit: "Original verification signal",
        nativeBpm: 300,
        tempoConfidence: 1,
        keyEstimate: "test oscillator",
        keyConfidence: 0,
        downbeatOffset: 0,
        beats: 32,
        stretch: "native-only",
      },
    },
  ];
  const transport = new Transport();
  await transport.play(p, BAR);
  await wait(180);
  const fromMiddle = transport.diagnostics;
  if (fromMiddle.activeVoices !== 1 || fromMiddle.resumedClips !== 1)
    throw new Error("Seeking into an audio clip failed to resume its source");
  const pausedAt = transport.position;
  transport.pause();
  await wait(80);
  await transport.play(p);
  await wait(180);
  const resumed = transport.diagnostics;
  if (
    resumed.activeVoices !== 1 ||
    resumed.resumedClips !== 1 ||
    transport.position <= pausedAt
  )
    throw new Error("Pause/resume lost the spanning audio loop");
  const updated = structuredClone(p);
  updated.clips![0].gain *= 0.8;
  transport.updateAtBoundary(updated);
  await wait(1200);
  const boundary = transport.diagnostics;
  if (
    boundary.boundarySwaps !== 1 ||
    boundary.resumedClips !== 2 ||
    boundary.activeVoices !== 1
  )
    throw new Error("Boundary edit failed to continue the current loop source");
  transport.stop();
  await wait(100);
  const stopped = transport.diagnostics;
  if (stopped.activeVoices !== 0)
    throw new Error("Explicit clip stop retained a source");
  transport.dispose();
  say(
    "Live clip seek, pause/resume, and bar-boundary edit retain one correctly resumed source; Stop clears it",
  );

  const short = structuredClone(p);
  short.arrangement = true;
  short.sections = [
    { id: "tail-test", name: "One-bar tail check", bars: 1, kind: "hook" },
  ];
  short.clips![0].effects = {
    delay: {
      division: 0.5,
      feedback: 0.3,
      wet: 0.3,
      cutoff: 3500,
      pingPong: true,
    },
  };
  const tail = new Transport();
  tail.loop = false;
  let endedAt = 0;
  tail.onUpdate = (tick, playing) => {
    if (!playing && Math.abs(tick - BAR) < 0.01) endedAt = performance.now();
  };
  const beganAt = performance.now();
  await tail.play(short);
  await wait(1300);
  const duringTail = { ...tail.diagnostics, position: tail.position };
  if (!duringTail.playing || Math.abs(duringTail.position - BAR) > 0.01)
    throw new Error(
      "Natural clip ending cut the effect tail or reset the display",
    );
  tail.updateAtBoundary(short);
  await wait(3800);
  const afterTail = { ...tail.diagnostics, position: tail.position };
  if (
    afterTail.playing ||
    afterTail.activeVoices !== 0 ||
    Math.abs(afterTail.position - BAR) > 0.01 ||
    afterTail.boundarySwaps !== 0 ||
    endedAt - beganAt < 4800
  )
    throw new Error(
      "Natural completion did not preserve the four-second tail, or an end-tail edit restarted playback",
    );
  await tail.play(short);
  await wait(180);
  const replay = { ...tail.diagnostics, position: tail.position };
  if (!replay.playing || replay.activeVoices !== 1 || replay.position >= BAR)
    throw new Error(
      "Play after natural completion did not restart from the beginning",
    );
  tail.stop();
  await wait(100);
  tail.dispose();
  say(
    "Nonloop playback holds its final tick for the four-second tail, then ends; Play restarts from tick zero",
  );
  return {
    fromMiddle,
    resumed,
    boundary,
    stopped,
    duringTail,
    afterTail,
    naturalCompletionWallMs: endedAt - beganAt,
    replay,
  };
}
export async function verifyAudio(say: (s: string) => void) {
  const pitchTests = [];
  for (const [rate, root, cents, target] of [
    [11025, 24, 21, 30],
    [44100, 26, -17, 35],
    [48000, 29, 10, 33],
  ]) {
    const source = Float32Array.from(
        { length: Math.round(rate * 0.8) },
        (_, i) =>
          Math.sin(
            (i / rate) *
              440 *
              2 ** ((root - 69 + cents / 100) / 12) *
              Math.PI *
              2,
          ) * 0.3,
      ),
      p = newProject({ ...defaultSettings("airy"), grit: 0 });
    for (const t of p.candidates[0].tracks) t.notes = [];
    p.assets = [
      {
        id: "sample-pitch-fixture",
        name: `${rate}-fixture.wav`,
        data: `data:audio/wav;base64,${base64(encodeWav([source], rate))}`,
        role: "bass",
        root,
        tuning: -cents,
        trimStart: 0,
        trimEnd: 0.8,
        gain: 0.6,
        choke: "bass",
        license: "Original verification oscillator",
        envelopeMode: "gated",
      },
    ];
    const t = p.candidates[0].tracks.find((t) => t.id === "bass")!;
    t.instrument = p.assets[0].id;
    t.notes = [
      { id: "pitch", tick: 0, duration: 960, pitch: target, velocity: 0.8 },
    ];
    const r = await renderWav(p, "bass"),
      b = await decode(r.wav),
      actual = frequency(b.getChannelData(0), b.sampleRate, 0.09, 0.36),
      expected = 440 * 2 ** ((target - 69) / 12),
      errorCents = 1200 * Math.log2(actual / expected);
    if (Math.abs(errorCents) > 3)
      throw new Error(
        `${rate} Hz root transposition error ${errorCents} cents`,
      );
    pitchTests.push({
      sourceRate: rate,
      sourceRoot: root,
      sourceCents: cents,
      target,
      expectedHz: expected,
      measuredHz: actual,
      errorCents,
    });
    say(`Pitch fixture ${rate} Hz: ${errorCents.toFixed(2)} cents error`);
  }
  const p = newProject(defaultSettings("airy"));
  for (const t of p.candidates[0].tracks) t.notes = [];
  const source = Float32Array.from(
    { length: 4410 },
    (_, i) => Math.sin((i / 44100) * 2100 * Math.PI * 2) * 0.2 * (1 - i / 4410),
  );
  p.assets = [
    {
      id: "sample-zero-drum",
      name: "zero-gate.wav",
      data: `data:audio/wav;base64,${base64(encodeWav([source], 44100))}`,
      role: "hat",
      root: 60,
      tuning: 0,
      trimStart: 0,
      trimEnd: 0.1,
      gain: 0.4,
      choke: "",
      license: "Original test oscillator",
      envelopeMode: "one-shot",
    },
  ];
  const hat = p.candidates[0].tracks.find((t) => t.id === "hat")!;
  hat.instrument = p.assets[0].id;
  hat.notes = [{ id: "zero", tick: 0, duration: 1, pitch: 42, velocity: 0.8 }];
  const drum = await decode((await renderWav(p, "hat")).wav);
  const late = drum
      .getChannelData(0)
      .slice(
        Math.round(0.04 * drum.sampleRate),
        Math.round(0.07 * drum.sampleRate),
      ),
    rms = Math.sqrt(late.reduce((a, b) => a + b * b, 0) / late.length);
  if (rms < 0.001) throw new Error("Zero-gate one-shot was silenced");
  say(`One-shot with 1-tick gate retains late audio: RMS ${rms.toFixed(4)}`);
  const glide = newProject({ ...defaultSettings("airy"), grit: 0 });
  for (const t of glide.candidates[0].tracks) t.notes = [];
  glide.candidates[0].tracks.find((t) => t.id === "bass")!.notes = [
    {
      id: "legato",
      tick: 0,
      duration: 960,
      pitch: 33,
      velocity: 0.8,
      articulation: "legato",
      glide: { to: 40, at: 240, ms: 90 },
    },
  ];
  const g = await decode((await renderWav(glide, "bass")).wav),
    f0 = frequency(g.getChannelData(0), g.sampleRate, 0.06, 0.17),
    f1 = frequency(g.getChannelData(0), g.sampleRate, 0.39, 0.61);
  if (Math.abs(f0 - 55) > 1 || Math.abs(f1 - 82.4069) > 1)
    throw new Error("Bass slide endpoints are incorrect");
  say(`Continuous bass slide: ${f0.toFixed(2)} → ${f1.toFixed(2)} Hz`);
  const t = new Transport(),
    fast = newProject({ ...defaultSettings("airy"), bpm: 300 });
  await Promise.all([t.play(fast), t.play(fast)]);
  await new Promise((r) => setTimeout(r, 900));
  const updated = structuredClone(fast);
  updated.settings.brightness = 0.2;
  t.updateAtBoundary(updated);
  await new Promise((r) => setTimeout(r, 13500));
  const active = t.diagnostics,
    position = t.position;
  t.stop();
  await new Promise((r) => setTimeout(r, 150));
  const stopped = t.diagnostics;
  t.dispose();
  if (
    !active.playing ||
    active.activeVoices > 100 ||
    stopped.activeVoices !== 0
  )
    throw new Error("Transport voice lifecycle failed");
  const abort = new AbortController();
  abort.abort();
  let cancelled = false;
  try {
    await renderWav(fast, "mix", abort.signal);
  } catch (e) {
    cancelled = (e as Error).name === "AbortError";
  }
  if (!cancelled) throw new Error("Cancellation was not honored");
  return {
    pitchTests,
    zeroGateOneShotRMS: rms,
    glide: { fromHz: f0, toHz: f1 },
    active,
    position,
    stopped,
    cancelled,
  };
}
