import { suppliedDrum } from "./studio-palette";
import { rewriteAura } from "./aura-writing";
import {
  BAR,
  LOOP_TICKS,
  ROLES,
  SCALES,
  VERSION,
  clone,
  isDrum,
} from "./schema";
import type {
  Candidate,
  Chord,
  Metrics,
  Note,
  Project,
  Role,
  Section,
  Settings,
  Track,
} from "./schema";
import { GROOVES, PROFILES, defaultSettings } from "./profiles";
import { clamp, pick, rng } from "./random";
import { cultureCandidate, getPrivatePalette } from "./culture";
import { PRESETS, BANK_VERSION } from "../audio/bank";
import { cultureFormBars } from "./culture-plan";
import {
  tdfDrumInstrument,
  TDF_DEFAULT_NAMES,
  TDF_COMMON_NAMES,
} from "./tdf-kit";

const names: Record<Role, string> = {
  melody: "Main melody",
  pad: "Harmony",
  answer: "Answer",
  bass: "808 bass",
  kick: "Kick",
  clap: "Clap / snare",
  hat: "Closed hat",
  open: "Open hat",
  perc: "Percussion",
  keys: "Rounded keys",
  bridge: "Connecting lead",
  pedal: "Sustained pedal",
};
const rhythms = [
  [0, 3, 6, 10, 16, 22, 27],
  [0, 6, 10, 14, 19, 24, 30],
  [0, 4, 7, 12, 16, 23, 28],
];
function scalePitch(s: Settings, degree: number, base = 60) {
  const scale = SCALES[s.mode];
  return (
    base +
    s.key +
    scale[((degree % scale.length) + scale.length) % scale.length] +
    12 * Math.floor(degree / scale.length)
  );
}
function makeHarmony(s: Settings, seed: string): Chord[] {
  const r = rng(`${seed}/harmony`),
    degrees =
      s.complexity === 1
        ? [0]
        : s.complexity === 2
          ? pick(r, [
              [0, 5],
              [0, 3],
              [0, 0],
            ])
          : s.complexity === 3
            ? [0, 5, 3]
            : [0, 5, 3, 4];
  return degrees.map((d, i) => {
    const start = Math.floor((i * 8) / degrees.length) * BAR,
      end = Math.floor(((i + 1) * 8) / degrees.length) * BAR,
      root = scalePitch(s, d, 24);
    return {
      tick: start,
      duration: end - start,
      root: root < 28 ? root + 12 : root,
      pitches: [0, 2, 4].map((n) => scalePitch(s, d + n, 48)),
    };
  });
}
export function chordAt(h: Chord[], tick: number): Chord {
  return h.find((c) => tick >= c.tick && tick < c.tick + c.duration) ?? h[0];
}
function monophonic(notes: Note[], end = LOOP_TICKS): Note[] {
  notes.sort((a, b) => a.tick - b.tick);
  return notes
    .filter((n, i) => i === 0 || n.tick !== notes[i - 1].tick)
    .map((n, i, arr) => {
      const duration = Math.max(
        15,
        Math.min(n.duration, (arr[i + 1]?.tick ?? end) - n.tick),
      );
      const next = { ...n, duration };
      if (n.glide && n.glide.at < duration)
        next.glide = { ...n.glide, at: Math.min(n.glide.at, duration - 15) };
      else delete next.glide;
      return next;
    });
}
function makeNotes(
  role: Role,
  s: Settings,
  h: Chord[],
  seed: string,
  revision: number,
  groove: number,
): Note[] {
  const r = rng(`${seed}/${role}/${revision}`),
    pr = PROFILES[s.profile],
    notes: Note[] = [];
  const add = (
    tick: number,
    pitch: number,
    duration: number,
    velocity: number,
    glide?: Note["glide"],
  ) => {
    if (tick >= 0 && tick < LOOP_TICKS)
      notes.push({
        id: `${role}-${revision}-${notes.length}`,
        tick: Math.round(tick),
        pitch,
        duration: Math.min(Math.round(duration), LOOP_TICKS - Math.round(tick)),
        velocity: clamp(velocity, 0.05, 1),
        ...(glide ? { glide } : {}),
      });
  };
  const gr = GROOVES[s.profile][groove];
  if (role === "melody") {
    let contour = [...pick(r, pr.motifs)];
    if (s.contour === "falling") contour.sort((a, b) => b - a);
    if (s.contour === "rising") contour.sort((a, b) => a - b);
    const steps =
      rhythms[(Math.floor(r() * rhythms.length) + s.rhythm) % rhythms.length];
    const count = clamp(Math.round(3 + s.noteDensity * 5), 3, steps.length);
    const motif = steps.slice(0, count).map((step, i) => ({
      step,
      degree: contour[i % contour.length],
      duration: pick(r, [180, 240, 360, 480]),
      velocity: 0.6 + r() * 0.2,
    }));
    for (let phrase = 0; phrase < 4; phrase++)
      for (let i = 0; i < motif.length; i++) {
        const m = motif[i],
          tick = phrase * BAR * 2 + m.step * 120,
          chord = chordAt(h, tick);
        let p = scalePitch(s, m.degree, 60) + s.octave * 12;
        if (i === 0 || i % 3 === 0) {
          const targets = chord.pitches.map((x) => x + 12 + s.octave * 12);
          p = targets.reduce((a, b) =>
            Math.abs(b - p) < Math.abs(a - p) ? b : a,
          );
        }
        if (phrase === 3 && i === motif.length - 1) {
          if (s.variation > 0.3) p -= 12;
          if (s.variation > 0.65) continue;
        }
        if (s.mood === "warm" && p > 83) p -= 12;
        add(tick, p, m.duration, m.velocity);
        if (s.profile === "bright" && i % 3 === 0)
          add(tick, p + 7, Math.min(360, m.duration), m.velocity * 0.47);
        if (phrase % 2 === 1 && i === motif.length - 1 && s.variation > 0.5)
          add(tick + 360, scalePitch(s, 0, 72) + s.octave * 12, 120, 0.47);
      }
  } else if (role === "pad") {
    for (let bar = 0; bar < 8; bar += 2) {
      const c = chordAt(h, bar * BAR);
      for (const p of c.pitches.slice(0, s.profile === "dark" ? 2 : 3))
        add(
          bar * BAR,
          p - (s.profile === "dark" ? 12 : 0),
          BAR * (s.profile === "bright" ? 1.4 : 1.8),
          0.42,
        );
    }
  } else if (role === "answer") {
    if (s.profile !== "dark" || s.variation > 0.65)
      for (const bar of [3, 7]) {
        add(bar * BAR + 1200, scalePitch(s, 4, 72), 360, 0.45);
        if (s.profile !== "spacey")
          add(bar * BAR + 1680, scalePitch(s, 2, 72), 180, 0.36);
      }
  } else if (role === "bass") {
    for (let phrase = 0; phrase < 4; phrase++)
      for (let i = 0; i < gr.bass.length; i++) {
        const step = gr.bass[i],
          tick = phrase * BAR * 2 + step * 120,
          chord = chordAt(h, tick);
        let p = chord.root;
        while (p < 28) p += 12;
        while (p > 43) p -= 12;
        if (i === gr.bass.length - 1 && phrase % 2 === 1 && p + 12 <= 43)
          p += 12;
        const gap = ((gr.bass[i + 1] ?? 32) - step) * 120;
        const duration = Math.max(
          90,
          gap * (s.profile === "dark" ? 0.48 : 0.62 + s.sustain * 0.32),
        );
        const glide =
          i === 2 && phrase % 2 === 1 && s.variation > 0.25
            ? {
                to: p + 12,
                at: Math.round(duration * 0.45),
                ms: Math.round(60 + s.sustain * 70),
              }
            : undefined;
        add(tick, p, duration, 0.72 + r() * 0.16, glide);
      }
    return monophonic(notes);
  } else {
    const mapping: Record<string, number> = {
      kick: 36,
      clap: 39,
      hat: 42,
      open: 46,
      perc: 37,
    };
    for (let phrase = 0; phrase < 4; phrase++)
      for (const step of gr[role as "kick"]) {
        if (role !== "clap" && step !== 0 && r() > 0.58 + s.density * 0.72)
          continue;
        let tick = phrase * BAR * 2 + step * 120;
        if (role === "hat" && Math.floor(step / 2) % 2 === 1)
          tick += Math.round((s.swing - 0.5) * 480);
        if (role === "perc" && step > 0) tick += Math.round((r() - 0.5) * 10);
        const accent =
          role === "hat"
            ? step % 4 === 0
              ? 0.58
              : 0.34
            : role === "clap"
              ? 0.77
              : 0.7;
        add(
          tick,
          mapping[role],
          role === "open" ? 240 : 90,
          accent + r() * 0.12,
        );
      }
    if (role === "hat")
      for (const bar of [3, 7]) {
        const turn = bar * BAR + 1560;
        if (s.rolls > 0.15)
          for (let j = 0; j < Math.round(s.rolls * 5); j++)
            add(turn + j * 60, 42, 35, 0.32 + j * 0.04);
        if (s.rolls > 0.6)
          for (let j = 0; j < 3; j++)
            add(bar * BAR + 960 + j * 160, 42, 50, 0.42 + j * 0.08);
      }
    if (role === "perc" && s.profile === "bright" && s.variation > 0.6)
      for (const bar of [3, 7]) add(bar * BAR + 1800, 37, 60, 0.62);
  }
  return isDrum(role)
    ? monophonic(notes)
    : notes.sort((a, b) => a.tick - b.tick || a.pitch - b.pitch);
}
export function assess(c: Pick<Candidate, "tracks" | "harmony">): Metrics {
  const melody = c.tracks.find((t) => t.id === "melody")!.notes,
    bass = c.tracks.find((t) => t.id === "bass")!.notes;
  const first = melody.filter((n) => n.tick < BAR * 2),
    second = melody.filter((n) => n.tick >= BAR * 2 && n.tick < BAR * 4);
  const continuity = first.length
    ? first.filter((n) =>
        second.some((m) => m.tick === n.tick + BAR * 2 && m.pitch === n.pitch),
      ).length / first.length
    : 0;
  const bassConsistency = bass.length
    ? bass.filter((n) => (n.pitch - chordAt(c.harmony, n.tick).root) % 12 === 0)
        .length / bass.length
    : 1;
  const total = c.tracks.flatMap((t) => t.notes).length,
    density = total / 128;
  const pad = c.tracks.find((t) => t.id === "pad")!.notes,
    collisions = melody.filter((n) =>
      pad.some(
        (p) =>
          p.pitch === n.pitch &&
          n.tick >= p.tick &&
          n.tick < p.tick + p.duration,
      ),
    ).length;
  const last = melody.filter((n) => n.tick >= BAR * 6);
  const variation =
    Math.abs(first.length - last.length) +
    (first.some(
      (n) =>
        !last.some((m) => m.pitch === n.pitch && m.tick === n.tick + BAR * 6),
    )
      ? 1
      : 0);
  const score = Math.round(
    55 +
      continuity * 18 +
      bassConsistency * 20 -
      Math.max(0, density - 2.8) * 8 -
      collisions * 2 +
      Math.min(variation, 3) * 2,
  );
  return {
    score: clamp(score, 0, 100),
    continuity,
    bassConsistency,
    density,
    collisions,
    variation,
    reasons: [
      `${Math.round(continuity * 100)}% motif continuity`,
      `${Math.round(bassConsistency * 100)}% bass roots in harmony`,
      `${total} events · ${collisions} register collisions`,
      `${variation} phrase-ending changes`,
    ],
  };
}
function createCandidate(
  s: Settings,
  index: number,
  previous?: Candidate,
  only?: Role[],
  variation = false,
): Candidate {
  const seed = `ish-1.0.0/${s.seed}/${s.profile}/candidate-${index}`;
  // A partial rewrite keeps the existing harmonic plan. A locked bass also constrains new ideas.
  const harmony =
    previous &&
    (only ||
      previous.tracks.some(
        (t) => t.locked && ["bass", "melody", "pad"].includes(t.id),
      ))
      ? clone(previous.harmony)
      : makeHarmony(s, seed);
  const gr = Math.floor(rng(`${seed}/drums`)() * 6);
  const tracks = ROLES.map((role, i): Track => {
    const old = previous?.tracks.find((t) => t.id === role);
    if (old && (old.locked || (only && !only.includes(role))))
      return clone(old);
    const revision = variation ? (old?.revision ?? 0) + 1 : 0,
      rs = rng(`${seed}/sounds/${role}/${revision}`);
    return {
      id: role,
      name: names[role],
      instrument:
        role === "bass" || isDrum(role)
          ? (suppliedDrum(
              s,
              getPrivatePalette(),
              role,
              (gr + index) % 3,
              old?.instrument,
            ) ??
            tdfDrumInstrument(
              getPrivatePalette(),
              role,
              role === "bass" || role === "clap" || role === "hat"
                ? TDF_DEFAULT_NAMES[(gr + index) % 3][role]
                : TDF_COMMON_NAMES[role as "kick" | "open" | "perc"],
              old?.instrument,
            ))
          : (old?.instrument ??
            pick(rs, PROFILES[s.profile].instruments[role])),
      notes: makeNotes(role, s, harmony, seed, revision, (gr + index) % 6),
      volume: old?.volume ?? PROFILES[s.profile].mix[i],
      pan: old?.pan ?? (role === "pad" ? -0.18 : role === "answer" ? 0.25 : 0),
      mute: old?.mute ?? false,
      solo: old?.solo ?? false,
      locked: false,
      revision,
    };
  });
  const c: Candidate = {
    id: `idea-${index}`,
    name: ["Window shopping", "After hours", "Somewhere outside"][index],
    character: [
      "The open pocket",
      "A little more motion",
      "An unexpected turn",
    ][index],
    tracks,
    harmony,
    metrics: null!,
    groove: GROOVES[s.profile][(gr + index) % 6].name,
  };
  c.metrics = assess(c);
  return c;
}
export const generateCandidates = (s: Settings, previous?: Candidate[]) =>
  [0, 1, 2].map((i) => {
    const prior = previous?.[i];
    // Only the exact untouched loading candidate is disposable. An edited,
    // locked or real candidate still goes through normal patch protection.
    const retained =
      prior &&
      prior.id === `pending-${i}` &&
      !prior.recipe &&
      prior.tracks.length === ROLES.length &&
      ROLES.every((role) =>
        prior.tracks.some(
          (t) =>
            t.id === role &&
            t.instrument === "kit-required" &&
            t.notes.length === 0 &&
            !t.locked &&
            !t.mute &&
            !t.solo &&
            t.revision === 0 &&
            t.volume === 0.5 &&
            t.pan === 0,
        ),
      )
        ? undefined
        : prior;
    const c =
      s.profile === "culture"
        ? cultureCandidate(s, i, retained)
        : createCandidate(s, i, retained);
    c.metrics = assess(c);
    return c;
  });
export function rewrite(p: Project, roles?: Role[]): Project {
  if (p.auraOriginal) return rewriteAura(p, roles);
  const out = clone(p);
  for (const asset of getPrivatePalette())
    if (!out.assets.some((a) => a.id === asset.id)) out.assets.push(asset);
  if (out.settings.profile === "culture" && out.sourceKind !== "supplied-loop")
    out.generator = VERSION;
  out.candidates[out.selected] =
    out.settings.profile === "culture"
      ? cultureCandidate(
          out.settings,
          out.selected,
          out.candidates[out.selected],
          roles,
          true,
        )
      : createCandidate(
          out.settings,
          out.selected,
          out.candidates[out.selected],
          roles,
          true,
        );
  out.candidates[out.selected].metrics = assess(out.candidates[out.selected]);
  if (out.sourceKind === "supplied-loop") {
    const before = p.candidates[p.selected],
      after = out.candidates[out.selected];
    after.name = before.name;
    after.character = before.character;
    if (before.phrasePlan)
      after.phrasePlan = {
        ...clone(before.phrasePlan),
        events: [
          ...before.phrasePlan.events.filter((e) => !isDrum(e.role)),
          ...(after.phrasePlan?.events ?? []).filter((e) => isDrum(e.role)),
        ],
      };
  }
  return out;
}
const BASE_SECTIONS = (): Section[] => [
  { id: "intro", name: "Intro", kind: "intro", bars: 4 },
  { id: "hook", name: "Hook", kind: "hook", bars: 16 },
  { id: "verse", name: "Verse", kind: "verse", bars: 16 },
  { id: "break", name: "Break", kind: "break", bars: 8 },
  { id: "return", name: "Return", kind: "return", bars: 16 },
  { id: "outro", name: "Outro", kind: "outro", bars: 4 },
];
export function defaultSections(settings?: Settings): Section[] {
  const sections = BASE_SECTIONS();
  if (settings?.profile === "culture") {
    const bars = cultureFormBars(settings);
    sections.forEach((section, index) => (section.bars = bars[index]));
  }
  return sections;
}
export function newProject(settings = defaultSettings()): Project {
  return {
    format: "ishmakethebeat",
    schema: 1,
    generator: settings.profile === "culture" ? VERSION : "ish-1.0.0",
    title: "Untitled session",
    settings,
    candidates: generateCandidates(settings),
    selected: 0,
    sections: defaultSections(settings),
    arrangement: false,
    assets: getPrivatePalette(),
    soundBank: { version: BANK_VERSION, presets: clone(PRESETS) },
    tagEnabled: false,
    created: new Date().toISOString(),
  };
}
export const DRUM_ROLES: Role[] = ["kick", "clap", "hat", "open", "perc"];

/** Empty loading state: it never generates or plays replacement drums while the private kit loads. */
export function pendingProject(settings = defaultSettings()): Project {
  const root = 24 + settings.key;
  return {
    format: "ishmakethebeat",
    schema: 1,
    generator: "ish-kit-required",
    title: "Load your TDF kit to generate",
    settings,
    selected: 0,
    sections: defaultSections(settings),
    arrangement: false,
    assets: [],
    tagEnabled: false,
    created: new Date().toISOString(),
    soundBank: { version: BANK_VERSION, presets: clone(PRESETS) },
    candidates: [0, 1, 2].map((i) => ({
      id: `pending-${i}`,
      name: "Waiting for TDF kit",
      character: "No replacement drums generated",
      tracks: ROLES.map((role) => ({
        id: role,
        name: names[role],
        instrument: "kit-required",
        notes: [],
        volume: 0.5,
        pan: 0,
        mute: false,
        solo: false,
        locked: false,
        revision: 0,
      })),
      harmony: [
        {
          tick: 0,
          duration: LOOP_TICKS,
          root,
          pitches: [root + 24, root + 27, root + 31],
        },
      ],
      groove: "Kit required",
      metrics: {
        score: 0,
        continuity: 0,
        bassConsistency: 0,
        density: 0,
        collisions: 0,
        variation: 0,
        reasons: ["Existing TDF kit samples are required."],
      },
    })),
  };
}
