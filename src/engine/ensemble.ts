import { suppliedDrum } from "./studio-palette";
import { BAR, LOOP_TICKS, PPQ, clone } from "./schema";
import type {
  Candidate,
  Chord,
  Note,
  Project,
  Role,
  RoleEffects,
  SampleAsset,
  Settings,
  Track,
} from "./schema";
import { BANK_VERSION, PRESETS } from "../audio/bank";
import { GROOVES } from "./profiles";
import { rng } from "./random";
import { tdfDrumInstrument, isPermittedTdfDrum } from "./tdf-kit";
import { isDrum } from "./schema";
import { RECIPES } from "./culture-plan";
import type { CultureWritingPlan } from "./culture-plan";

// Authored browser instrument groups. These describe complementary jobs, not
// reconstructions of a commercial patch or an automatically learned style.
export const ENSEMBLE_GROUPS = [
  {
    name: "Woven glass",
    foreground: "reed-call",
    bridge: "hollow-lead",
    keyRhythm: [0, 1440, 2400],
    keyGate: [660, 240, 600],
    bass: [0, 6, 13, 18, 25, 29],
    hats: [0, 2, 6, 8, 12, 14, 18, 20, 22, 26, 28, 30],
    kick: [0, 18, 25],
    open: [15],
    perc: [11, 29],
    gestureBar: 7,
  },
  {
    name: "Velvet circuit",
    foreground: "hollow-lead",
    bridge: "reed-call",
    keyRhythm: [240, 2160],
    keyGate: [900, 780],
    bass: [0, 5, 13, 16, 23, 28],
    hats: [0, 4, 6, 8, 10, 14, 16, 20, 22, 24, 28, 30],
    kick: [0, 13, 23],
    open: [27],
    perc: [7, 19],
    gestureBar: 3,
  },
  {
    name: "Copper window",
    foreground: "rounded-keys",
    bridge: "hollow-lead",
    keyRhythm: [0, 1080, 2640],
    keyGate: [480, 360, 540],
    bass: [0, 7, 10, 18, 26, 30],
    hats: [0, 2, 4, 8, 12, 14, 18, 20, 24, 26, 28],
    kick: [0, 10, 26],
    open: [6, 23],
    perc: [15, 27],
    gestureBar: 7,
  },
] as const;

const LABELS: Partial<Record<Role, string>> = {
  keys: "Rounded keys",
  pad: "Moving pad",
  answer: "Glass answers",
  bridge: "Connecting lead",
  pedal: "Tonal pedal",
};
type PlanEvent = NonNullable<Candidate["phrasePlan"]>["events"][number];
interface Options {
  previous?: Candidate;
  roles?: Role[];
  forcePalette?: boolean;
  variation?: boolean;
  writingPlan?: CultureWritingPlan;
  requireTdfKit?: boolean;
  selectFamily?: boolean;
}

const chordAt = (h: Chord[], tick: number) =>
  h.find((c) => tick >= c.tick && tick < c.tick + c.duration) ?? h[0];
const pitchClass = (p: number) => ((p % 12) + 12) % 12;
const registerPitch = (p: number, min: number, max: number) => {
  while (p < min) p += 12;
  while (p > max) p -= 12;
  return p;
};
function nearChord(c: Chord, target: number, min = 62, max = 86): number {
  const pitches = c.pitches
    .flatMap((p) => [-24, -12, 0, 12, 24].map((o) => p + o))
    .filter((p) => p >= min && p <= max);
  return pitches.reduce(
    (best, p) => (Math.abs(p - target) < Math.abs(best - target) ? p : best),
    pitches[0] ?? registerPitch(c.root, min, max),
  );
}
function add(
  notes: Note[],
  role: Role,
  tick: number,
  pitch: number,
  duration: number,
  velocity: number,
  revision: number,
  extra: Partial<Note> = {},
) {
  tick = Math.round(tick);
  if (tick < 0 || tick >= LOOP_TICKS) return;
  notes.push({
    id: `${role}-ensemble-${revision}-${notes.length}`,
    tick,
    pitch,
    duration: Math.max(15, Math.min(Math.round(duration), LOOP_TICKS - tick)),
    velocity,
    ...extra,
  });
}

/** Read actual score gaps, including overlapping notes, rather than assigning an
 * unrelated answer melody to a timer. Answers may ring into the next call. */
export function melodyGaps(notes: Note[], from = 0, to = LOOP_TICKS) {
  let cursor = from;
  const gaps: { start: number; end: number }[] = [];
  for (const n of [...notes].sort((a, b) => a.tick - b.tick)) {
    if (n.tick + n.duration <= from || n.tick >= to) continue;
    if (n.tick > cursor)
      gaps.push({ start: cursor, end: Math.min(to, n.tick) });
    cursor = Math.max(cursor, n.tick + n.duration);
  }
  if (cursor < to) gaps.push({ start: cursor, end: to });
  return gaps;
}

/** Root/fifth shared by the entire held region. If no common tone exists, use
 * a shorter locally consonant pedal; never insert the tutorial's G blindly. */
export function compatiblePedal(
  harmony: Chord[],
  start: number,
  end: number,
): { pitch: number; end: number } {
  const chords = harmony.filter(
    (c) => c.tick < end && c.tick + c.duration > start,
  );
  const first = chords[0] ?? harmony[0];
  const shared = first.pitches.filter((p) =>
    chords.every((c) => c.pitches.some((q) => pitchClass(q) === pitchClass(p))),
  );
  const target =
    shared.find((p) => pitchClass(p) === pitchClass(first.root + 7)) ??
    shared[0];
  return {
    pitch: registerPitch(target ?? first.pitches[1] ?? first.root, 58, 73),
    end:
      target === undefined ? Math.min(end, first.tick + first.duration) : end,
  };
}

// A coherent shortlist can be supplied by the asset preparation stage. Role
// matching prevents a tag or a similarly named melodic file becoming a drum.
export const PALETTE_SHORTLIST = [
  {
    bass: ["Jazzfeezy 808 3.wav", "main plugg 808.wav"],
    clap: ["Jazzfeezy Clap2.wav", "tdf samples clap.wav"],
    hat: ["Lex Hi-Hat (1).wav", "tdf hihat.wav"],
  },
  {
    bass: ["Plugg (Use 1 Octave Lower).wav", "fav sub 808.wav"],
    clap: ["C - RnB.wav", "basic clap.wav"],
    hat: ["HIHATS3.wav", "okaymar hihat.wav"],
  },
  {
    bass: ["@lilfrus - Classic Frus 808.wav", "6 808.wav"],
    clap: ["@lilfrus - Perc40 Normal Clap.wav", "snap.wav"],
    hat: ["@lilfrus - Perc40 May Sample 1 High Hat.wav", "Low tick hat.wav"],
  },
] as const;
function sampleFor(
  assets: SampleAsset[],
  role: Role,
  names: readonly string[],
  fallback: string,
  strict = false,
) {
  for (const name of names) {
    const found = assets.find(
      (a) =>
        a.role === role &&
        (!strict || isPermittedTdfDrum(a)) &&
        (a.name === name || a.originalFilename?.split(/[\\/]/).pop() === name),
    );
    if (found) return found.id;
  }
  return fallback;
}

export function coordinateEnsemble(
  candidate: Candidate,
  settings: Settings,
  assets: SampleAsset[] = [],
  paletteChoice = 0,
  options: Options = {},
): Candidate {
  const c = clone(candidate),
    family = (((options.writingPlan?.family ?? paletteChoice) % 3) + 3) % 3,
    group = ENSEMBLE_GROUPS[family],
    palette = PALETTE_SHORTLIST[family];
  const writing = options.writingPlan;
  const recipe = writing ? RECIPES[family] : undefined;
  const groove = writing ? GROOVES.culture[writing.grooveIndex] : undefined;
  const pattern: {
    bass: readonly number[];
    hats: readonly number[];
    kick: readonly number[];
    open: readonly number[];
    perc: readonly number[];
  } = groove ? { ...groove, hats: groove.hat } : group;
  const hatSteps = writing
    ? [
        ...new Set([
          ...pattern.hats,
          ...Array.from({ length: 16 }, (_, i) => i * 2),
          ...(settings.density > 0.7 ? [5, 13, 21, 29] : []),
        ]),
      ].sort((a, b) => a - b)
    : pattern.hats;
  const keepHit = (role: string, step: number, cell: number, extra = false) => {
    if (!writing) return true;
    if ((role === "hat" && step % 8 === 0) || (role === "kick" && step === 0))
      return true;
    const value = rng(
      `${writing.version}/${settings.seed}/${role}/${cell}/${step}/density`,
    )();
    return (
      value <=
      (extra
        ? Math.max(0, (settings.density - 0.5) * 1.6)
        : 0.2 + settings.density * 0.8)
    );
  };
  for (const track of options.previous?.tracks ?? [])
    if (!c.tracks.some((t) => t.id === track.id)) c.tracks.push(clone(track));
  const chooseSample = (
    role: Role,
    names: readonly string[],
    fallback: string,
  ) =>
    sampleFor(
      assets,
      role,
      names,
      fallback,
      !!writing || !!options.requireTdfKit,
    );
  const simple = settings.ensembleMode === "simple",
    events: PlanEvent[] = [];
  const melody = c.tracks.find((t) => t.id === "melody")!;
  const editable = (role: Role) => {
    const existing =
      options.previous?.tracks.find((t) => t.id === role) ??
      c.tracks.find((t) => t.id === role);
    return (
      !existing?.locked && (!options.roles || options.roles.includes(role))
    );
  };
  const automaticPatch = (role: Role) => {
    if (!options.selectFamily) return false;
    const old = options.previous?.tracks.find((t) => t.id === role);
    return (
      !!old &&
      (options.previous?.recipe?.automaticPalette ??
        options.previous?.recipe?.resolvedPalette)?.[role] === old.instrument
    );
  };
  const configure = (
    role: Role,
    notes: Note[],
    instrument: string,
    volume: number,
    pan: number,
    effects?: RoleEffects,
  ): Track => {
    const old = c.tracks.find((t) => t.id === role),
      retained = options.previous?.tracks.find((t) => t.id === role);
    if (!editable(role) && old) return old;
    const revision =
      (old?.revision ?? 0) +
      (options.variation && retained && old?.revision === retained.revision
        ? 1
        : 0);
    const track: Track = {
      id: role,
      name: old?.name ?? LABELS[role] ?? role,
      notes,
      instrument:
        (writing || options.requireTdfKit) && (role === "bass" || isDrum(role))
          ? (suppliedDrum(
              settings,
              assets,
              role,
              family,
              !options.forcePalette && !automaticPatch(role)
                ? retained?.instrument
                : undefined,
            ) ??
            tdfDrumInstrument(
              assets,
              role,
              [assets.find((a) => a.id === instrument)?.name ?? instrument],
              !options.forcePalette && !automaticPatch(role)
                ? retained?.instrument
                : undefined,
              settings.allowSynthFallback ? instrument : undefined,
            ))
          : options.forcePalette || automaticPatch(role) || !retained
            ? instrument
            : retained.instrument,
      volume: options.forcePalette || !retained ? volume : retained.volume,
      pan: options.forcePalette || !retained ? pan : retained.pan,
      mute: old?.mute ?? false,
      solo: old?.solo ?? false,
      locked: old?.locked ?? false,
      revision,
      register: retained?.register ?? old?.register ?? 0,
      effects:
        retained && !options.forcePalette ? clone(retained.effects) : effects,
    };
    if (!track.effects) delete track.effects;
    const i = c.tracks.findIndex((t) => t.id === role);
    if (i < 0) c.tracks.push(track);
    else c.tracks[i] = track;
    return track;
  };
  // Keep the accepted melody's events byte-for-byte: sound selection does not
  // quantize, transpose, re-articulate or secretly rewrite the foreground.
  if (editable("melody")) {
    melody.instrument =
      options.forcePalette || automaticPatch("melody") || !options.previous
        ? group.foreground
        : melody.instrument;
    melody.volume =
      options.forcePalette || !options.previous ? 0.77 : melody.volume;
    const retained = options.previous?.tracks.find((t) => t.id === "melody");
    melody.register = retained?.register ?? melody.register ?? 0;
    melody.effects =
      retained && !options.forcePalette
        ? clone(retained.effects)
        : {
            delay: {
              division: family === 1 ? 0.75 : 0.5,
              feedback: 0.23,
              wet: 0.13,
              cutoff: 4300,
              pingPong: true,
              automation: [0, 1, 2, 3].flatMap((cell) => [
                { tick: cell * BAR * 2, wet: 0.08 },
                { tick: cell * BAR * 2 + 3120, wet: 0.22 },
              ]),
            },
          };
    if (!melody.effects) delete melody.effects;
  }
  for (let cell = 0; cell < 4; cell++) {
    const begin = cell * BAR * 2,
      end = begin + BAR * 2;
    const calls = melody.notes.filter((n) => n.tick >= begin && n.tick < end);
    for (const n of calls)
      events.push({
        role: "melody",
        start: n.tick,
        end: n.tick + n.duration,
        kind: "call",
        description: "Retained foreground motif",
      });
    for (const gap of melodyGaps(melody.notes, begin, end))
      if (gap.end - gap.start >= 120)
        events.push({
          role: "melody",
          ...{ start: gap.start, end: gap.end },
          kind: "rest",
          description: "Space reserved for another voice or an echo",
        });
  }
  const keys: Note[] = [],
    pad: Note[] = [],
    answers: Note[] = [],
    bridge: Note[] = [],
    pedal: Note[] = [];
  const revision = (role: Role) => {
    const old = c.tracks.find((t) => t.id === role),
      retained = options.previous?.tracks.find((t) => t.id === role);
    return (
      (old?.revision ?? 0) +
      (options.variation &&
      editable(role) &&
      retained &&
      old?.revision === retained.revision
        ? 1
        : 0)
    );
  };
  const gestureBar =
    revision("hat") % 2 ? (group.gestureBar === 7 ? 3 : 7) : group.gestureBar;
  for (let cell = 0; cell < 4; cell++) {
    const begin = cell * BAR * 2,
      end = begin + BAR * 2;
    if (!simple || cell === 0 || cell === 2) {
      const keyRhythm = recipe?.chords.map((x) => x.tick) ?? group.keyRhythm;
      const keyGate = recipe?.chords.map((x) => x.duration) ?? group.keyGate;
      for (let j = 0; j < keyRhythm.length; j++) {
        // The last return is a recognizable opening voicing with fewer attacks.
        if (cell === 3 && j === keyRhythm.length - 1) continue;
        const tick = begin + keyRhythm[j],
          chord = chordAt(c.harmony, tick);
        const active = melody.notes.filter(
          (n) => n.tick < tick + 480 && n.tick + n.duration > tick,
        );
        let voicing = chord.pitches.map((p) => registerPitch(p, 47, 66));
        voicing = [...new Set(voicing)].sort((a, b) => a - b);
        if (family === 1 && voicing.length >= 3) voicing[0] += 12;
        for (const voicedPitch of voicing) {
          let p = voicedPitch;
          if (active.some((n) => Math.abs(n.pitch - p) < 3)) p -= 12;
          add(
            keys,
            "keys",
            tick,
            Math.max(36, p),
            keyGate[j],
            j === 0 ? 0.51 : 0.39,
            revision("keys"),
          );
        }
        events.push({
          role: "keys",
          start: tick,
          end: tick + keyGate[j],
          kind: "support",
          description: "Chord voicing below the actual foreground register",
        });
      }
    }
    // Pad is held above the low mids in alternating cells, not a second piano.
    if (!simple && ((family === 1 && cell !== 0) || cell === 0 || cell === 2)) {
      const tick = begin + (family === 2 ? PPQ : 0),
        chord = chordAt(c.harmony, tick),
        duration = Math.min(BAR * 1.7, chord.tick + chord.duration - tick);
      for (const p of chord.pitches.filter((_, i) => i !== 0).slice(0, 2))
        add(
          pad,
          "pad",
          tick,
          registerPitch(p, 60, 76),
          duration,
          0.35,
          revision("pad"),
        );
      events.push({
        role: "pad",
        start: tick,
        end: tick + duration,
        kind: "support",
        description: "Slow contrasting two-note texture; no doubled bass root",
      });
    }
    const gaps = melodyGaps(melody.notes, begin + BAR, end).filter(
      (g) => g.end - g.start >= 240,
    );
    const chosen = gaps.sort((a, b) => b.end - b.start - (a.end - a.start))[0];
    if (chosen && (!simple || cell % 2 === 1)) {
      const tick = Math.ceil((chosen.start + 30) / 60) * 60;
      if (tick + 90 < chosen.end) {
        const last = melody.notes
            .filter((n) => n.tick < tick)
            .sort((a, b) => a.tick - b.tick)
            .at(-1),
          chord = chordAt(c.harmony, tick);
        const p = nearChord(
          chord,
          (last?.pitch ?? 72) + (family === 2 ? -5 : 5),
          68,
          87,
        );
        add(
          answers,
          "answer",
          tick,
          p,
          Math.min(240, chosen.end - tick),
          cell === 3 ? 0.39 : 0.47,
          revision("answer"),
        );
        events.push({
          role: "answer",
          start: tick,
          end: Math.min(LOOP_TICKS, chosen.end + 180),
          kind: "answer",
          description:
            "Bell starts inside a measured foreground gap; its decay can overlap the next call",
        });
        if (!simple && family === 1 && chosen.end - tick >= 540)
          add(
            answers,
            "answer",
            tick + 300,
            nearChord(chord, p - 4, 68, 87),
            120,
            0.32,
            revision("answer"),
          );
      }
    }
    // One complementary voice connects the middle turn. It is intentionally
    // slower and lower than the bell and may sustain under the next call.
    if (
      !simple &&
      (cell === (family === 2 ? 2 : 1) || (cell === 3 && family === 1))
    ) {
      const local = melodyGaps(melody.notes, begin + PPQ, end - 240)
        .filter((g) => g.end - g.start >= 240)
        .sort((a, b) => b.end - b.start - (a.end - a.start))[0];
      const tick = local ? Math.ceil(local.start / 120) * 120 : begin + 1560;
      const chord = chordAt(c.harmony, tick),
        p = nearChord(chord, 63 + family * 3, 58, 72),
        duration = Math.min(840, end - tick - 60);
      add(bridge, "bridge", tick, p, duration, 0.43, revision("bridge"));
      events.push({
        role: "bridge",
        start: tick,
        end: tick + duration,
        kind: "answer",
        description:
          "Lower contrasting lead connects two motif calls with intentional partial overlap",
      });
    }
  }
  if (!simple) {
    const start = (family === 1 ? BAR * 3 : BAR * 4) + 240,
      support = compatiblePedal(c.harmony, start, BAR * 7 + 480);
    if (support.end - start >= 480) {
      add(
        pedal,
        "pedal",
        start,
        support.pitch,
        support.end - start - 60,
        0.55,
        revision("pedal"),
      );
      events.push({
        role: "pedal",
        start,
        end: support.end,
        kind: "support",
        description:
          "Common chord tone across this held region; shortened when harmony has no shared pitch",
      });
      events.push({
        role: "pedal",
        start: support.end,
        end: LOOP_TICKS,
        kind: "delay",
        description:
          "Filtered stereo repeats answer the release of the tonal pedal",
      });
    }
  }
  configure("keys", keys, "rounded-keys", simple ? 0.33 : 0.42, -0.12, {
    delay: {
      division: 0.75,
      feedback: 0.12,
      wet: 0.07,
      cutoff: 3100,
      pingPong: false,
    },
  });
  configure("pad", pad, "moving-pad", 0.34, 0.08, {
    delay: {
      division: 1,
      feedback: 0.16,
      wet: 0.08,
      cutoff: 2400,
      pingPong: true,
    },
  });
  configure("answer", answers, "glass-bell", 0.46, 0.16, {
    delay: {
      division: family === 2 ? 0.75 : 0.5,
      feedback: 0.27,
      wet: 0.19,
      cutoff: 5100,
      pingPong: true,
    },
  });
  configure("bridge", bridge, group.bridge, 0.4, -0.2, {
    delay: {
      division: 0.75,
      feedback: 0.3,
      wet: 0.22,
      cutoff: 3500,
      pingPong: true,
    },
  });
  configure("pedal", pedal, "silk-pedal", 0.55, 0, {
    delay: {
      division: 1.5,
      feedback: 0.35,
      wet: 0.28,
      cutoff: 2900,
      pingPong: true,
      automation: [
        { tick: 0, wet: 0.12 },
        { tick: BAR * 6, wet: 0.31 },
        { tick: BAR * 7, wet: 0.2 },
      ],
    },
  });

  const bass: Note[] = [],
    hat: Note[] = [],
    kick: Note[] = [],
    clap: Note[] = [],
    open: Note[] = [],
    perc: Note[] = [];
  for (let cell = 0; cell < 4; cell++) {
    const begin = cell * BAR * 2;
    const bassSteps = pattern.bass.filter(
      (_, j) => !(writing && cell === 2 && j === 2),
    );
    const playedBassSteps = bassSteps.map(
      (step, j) =>
        step + (options.variation && revision("bass") % 2 && j === 1 ? 1 : 0),
    );
    for (let j = 0; j < bassSteps.length; j++) {
      const step = playedBassSteps[j],
        tick = begin + step * 120;
      const chord = chordAt(c.harmony, tick),
        p = registerPitch(chord.root, 28, 43),
        next = begin + (playedBassSteps[j + 1] ?? 32) * 120;
      const landing = j === 0 || step === 16 || step === 18;
      const duration = Math.max(
        60,
        Math.floor(
          (next - tick) *
            (landing
              ? Math.min(
                  0.95,
                  (recipe?.bassGate ?? 0.76) * 0.75 + settings.sustain * 0.25,
                )
              : family === 2
                ? 0.48
                : 0.61),
        ),
      );
      const glide =
        cell === 3 &&
        j === bassSteps.length - 2 &&
        duration >= 180 &&
        settings.variation > 0.25
          ? { to: p + 12, at: Math.round(duration * 0.55), ms: 85 }
          : undefined;
      add(
        bass,
        "bass",
        tick,
        p,
        Math.min(duration, chord.tick + chord.duration - tick),
        landing ? 0.83 : 0.72,
        revision("bass"),
        {
          articulation: glide ? "legato" : "retrigger",
          ...(glide ? { glide } : {}),
        },
      );
      events.push({
        role: "bass",
        start: tick,
        end: tick + duration,
        kind: landing ? "support" : "gesture",
        description: glide
          ? "One sustained sub voice moves continuously to a root octave"
          : landing
            ? "Root landing against the current chord"
            : "Short root pickup, with air before the next landing",
      });
    }
    for (let j = 0; j < hatSteps.length; j++) {
      const baseStep = hatSteps[j],
        step =
          revision("hat") % 2 && cell % 2 && baseStep === 14 ? 15 : baseStep;
      if (
        !writing &&
        settings.density < 0.3 &&
        step % 4 !== 0 &&
        step % 8 !== 6
      )
        continue;
      if (!keepHit("hat", step, cell, !pattern.hats.includes(baseStep)))
        continue;
      const tick =
        begin +
        step * 120 +
        (writing && Math.floor(step / 2) % 2 === 1
          ? Math.round((settings.swing - 0.5) * 480)
          : 0);
      const gestureStart = gestureBar * BAR + 1200;
      if (
        settings.rolls > 0.25 &&
        tick >= gestureStart &&
        tick < gestureStart + 360
      )
        continue;
      add(
        hat,
        "hat",
        tick,
        42,
        30,
        step % 8 === 0 ? 0.64 : j % 3 === 0 ? 0.46 : 0.54,
        revision("hat"),
      );
    }
    // Kicks emphasize bass attacks, never independently fill its deliberate rests.
    const kickSteps = writing
      ? [
          ...new Set(
            pattern.kick.map((step) =>
              playedBassSteps.reduce((a, b) =>
                Math.abs(b - step) < Math.abs(a - step) ? b : a,
              ),
            ),
          ),
        ]
      : pattern.kick;
    for (const step of kickSteps)
      if (keepHit("kick", step, cell))
        add(
          kick,
          "kick",
          begin + step * 120,
          36,
          90,
          step === 0 ? 0.74 : 0.63,
          revision("kick"),
        );
    for (const beat of [2, 6])
      add(clap, "clap", begin + beat * PPQ, 39, 90, 0.79, revision("clap"));
    for (const step of pattern.open)
      if (keepHit("open", step, cell))
        add(open, "open", begin + step * 120, 46, 150, 0.55, revision("open"));
    for (const step of pattern.perc)
      if ((cell !== 0 || family === 2) && keepHit("perc", step, cell))
        add(perc, "perc", begin + step * 120, 37, 90, 0.55, revision("perc"));
  }
  if (settings.rolls > 0.25) {
    const tick = gestureBar * BAR + 1200,
      count = settings.rolls > 0.7 ? 4 : 3;
    for (let i = 0; i < count; i++)
      add(hat, "hat", tick + i * 60, 42, 24, 0.42 + i * 0.045, revision("hat"));
    events.push({
      role: "hat",
      start: tick,
      end: tick + 360,
      kind: "gesture",
      description:
        "Authored 32nd-note cluster, then a clean recovery to the unchanged base pattern",
    });
  }
  for (const notes of [bass, hat, kick, clap, open, perc])
    notes.sort((a, b) => a.tick - b.tick);
  configure(
    "bass",
    bass,
    chooseSample("bass", palette.bass, "textured-808"),
    0.67,
    0,
    { saturation: family === 1 ? 0.22 : 0.14 },
  );
  configure(
    "kick",
    kick,
    chooseSample("kick", ["SB Kick.wav"], "felt-kick"),
    family === 1 ? 0.27 : 0.36,
    0,
  );
  configure(
    "clap",
    clap,
    chooseSample("clap", palette.clap, "dry-clap"),
    0.57,
    0,
  );
  configure(
    "hat",
    hat,
    chooseSample("hat", palette.hat, "short-hat"),
    0.34,
    -0.04,
    {
      hat: {
        mix: family === 2 ? 0.28 : 0.2,
        echoBeats: family === 1 ? 0.375 : 0.25,
        feedback: 0.15,
        chorus: family === 0 ? 0.15 : 0.08,
        crush: family === 2 ? 0.22 : 0.04,
        room: 0.08,
      },
    },
  );
  configure(
    "open",
    open,
    chooseSample("open", ["Basic 808 Open Hat.wav"], "air-hat"),
    0.27,
    0.19,
  );
  configure(
    "perc",
    perc,
    chooseSample("perc", ["Clink Hit.wav"], "wood"),
    0.34,
    -0.21,
  );
  if (c.recipe && writing) {
    const owned =
      options.previous?.recipe?.automaticPalette ??
      options.previous?.recipe?.resolvedPalette;
    c.recipe.automaticPalette = Object.fromEntries(
      c.tracks.map((t) => [
        t.id,
        !options.previous ||
        !options.previous.tracks.some((old) => old.id === t.id) ||
        (editable(t.id) && (options.forcePalette || automaticPatch(t.id)))
          ? t.instrument
          : owned?.[t.id],
      ]),
    );
    c.recipe.resolvedPalette = Object.fromEntries(
      c.tracks.map((t) => [t.id, t.instrument]),
    );
    c.recipe.development = "A-Aprime-B-A";
  }
  c.phrasePlan = {
    version: 1,
    grid: settings.grid ?? "double-time",
    beatsPerBar: 4,
    events: events.sort((a, b) => a.start - b.start),
  };
  c.character = `${group.name} · ${simple ? "simple motif" : "conversing ensemble"}`;
  c.groove = writing
    ? `${groove!.name} / ${group.name}`
    : `${group.name} / authored pocket`;
  return c;
}

/** First review candidate: preserve every identifiable melody note/rhythm and
 * existing harmonic plan, while changing its ensemble and rhythm treatment. */
export function upgradeEnsemble(
  original: Project,
  assets: SampleAsset[],
  paletteChoice = 0,
): Project {
  const p = clone(original);
  p.title = "Accepted melody · coordinated ensemble";
  p.generator = "ish-3.0.0-ensemble";
  p.settings = {
    ...p.settings,
    profile: "culture",
    ensembleMode: "conversation",
    grid: p.settings.grid ?? "double-time",
    grit: 0.25,
    space: 0.28,
    brightness: 0.55,
    listeningGainDb: 0,
  };
  p.assets = clone(assets);
  p.soundBank = { version: BANK_VERSION, presets: clone(PRESETS) };
  p.candidates = p.candidates.map((c, i) =>
    coordinateEnsemble(
      c,
      p.settings,
      p.assets,
      paletteChoice + (i === p.selected ? 0 : i),
      { forcePalette: true, requireTdfKit: true },
    ),
  );
  p.recipe = p.candidates[p.selected].recipe;
  return p;
}
