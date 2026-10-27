import { assertRequiredSamples } from "./required-samples";
import { BAR, LOOP_TICKS, ROLES, SCALES, clone, isDrum } from "./schema";
import type {
  Project,
  Settings,
  SampleAsset,
  Candidate,
  Track,
  Note,
  Role,
  Section,
  Chord,
} from "./schema";
import type { AuraEntry, AuraPalette } from "../io/aura-bank";
import { defaultSettings } from "./profiles";
import { rng, pick } from "./random";
import { suppliedDrum, USER_KIT_ID } from "./studio-palette";
import { BANK_VERSION, PRESETS } from "../audio/bank";
export type AuraDirection = "cascade" | "angular";
export type AuraFeel = "pulse" | "interrupted";
export interface AuraOriginal {
  version: 1;
  palette: AuraPalette;
  direction: AuraDirection;
  feel: AuraFeel;
}
const register = (p: number, low: number, high: number) => {
  while (p < low) p += 12;
  while (p > high) p -= 12;
  return p;
};
export const auraSections = (): Section[] => [
  { id: "entrance", name: "8 · keys entrance", kind: "intro", bars: 8 },
  { id: "main", name: "16 · main call / reply", kind: "hook", bars: 16 },
  {
    id: "verse",
    name: "16 · displaced lower response",
    kind: "verse",
    bars: 16,
  },
  {
    id: "handoff",
    name: "8 · harmonic handoff / bass return",
    kind: "break",
    bars: 8,
  },
  {
    id: "return",
    name: "16 · main return / tail variation",
    kind: "return",
    bars: 16,
  },
  { id: "turn", name: "8 · broken delivery", kind: "verse", bars: 8 },
  { id: "ending", name: "8 · written landing", kind: "outro", bars: 8 },
];
export function auraCandidate(
  settings: Settings,
  writing: AuraOriginal,
  selection: Partial<Record<Role, AuraEntry>>,
  assets: SampleAsset[],
  index = 0,
  retainedHarmony?: Chord[],
  retainedTracks?: Track[],
): Candidate {
  const random = rng(
    "aura-original-writing-1/" +
      settings.seed +
      "/" +
      writing.direction +
      "/" +
      index,
  );
  const drumRandom = rng(
    "aura-pocket-1/" + settings.seed + "/" + writing.feel + "/" + index,
  );
  const pocketVariant = Math.floor(drumRandom() * 3);
  const scale = SCALES[settings.mode];
  const degree = (d: number, base = 60) =>
    base +
    settings.key +
    scale[((d % scale.length) + scale.length) % scale.length] +
    12 * Math.floor(d / scale.length);
  const common = pick(random, [
    [0, 4],
    [2, 6],
    [0, 3],
  ]);
  const moves = pick(random, [
    [2, 1, 5, 2],
    [5, 2, 1, 4],
    [1, 4, 2, 5],
  ]);
  const harmony = retainedHarmony
    ? clone(retainedHarmony)
    : moves.map((d, i) => {
        const pitches = [
          degree(common[0], 48),
          degree(common[1], 48),
          degree(d, 36) + 12,
        ].sort((a, b) => a - b);
        return {
          tick: i * BAR * 2,
          duration: BAR * 2,
          root: register(pitches[i % 3], 28, 43),
          pitches,
        };
      });
  const commonPitches = harmony[0].pitches.filter((p) =>
    harmony.every((h) => h.pitches.some((q) => (q - p) % 12 === 0)),
  );
  const instruments: Record<string, string> = {};
  for (const role of ["melody", "keys", "answer", "pad"] as Role[]) {
    const retained = retainedTracks?.find((t) => t.id === role);
    if (retained) instruments[role] = retained.instrument;
    else {
      const e = selection[role];
      if (!e || !assets.some((a) => a.id === e.id))
        throw new Error("Missing required sampled Aura " + role);
      instruments[role] = e.id;
    }
  }
  for (const role of ["bass", "kick", "clap", "hat", "open", "perc"] as Role[])
    instruments[role] = suppliedDrum(
      { ...settings, drumKitId: USER_KIT_ID, allowSynthFallback: false },
      assets,
      role,
      index % 2,
    )!;
  const roles: Role[] = [...ROLES, "keys"];
  const volume: Record<string, number> = {
    melody: 0.64,
    keys: 0.42,
    answer: 0.52,
    pad: 0.3,
    bass: 0.7,
    kick: 0.32,
    clap: 0.55,
    hat: 0.29,
    open: 0.2,
    perc: 0.31,
  };
  const tracks: Track[] = roles.map((id) => ({
    id,
    name:
      id === "melody"
        ? "Aura foreground"
        : id === "keys"
          ? "Aura common-tone keys"
          : id === "answer"
            ? "Aura slow reply"
            : id,
    instrument: instruments[id],
    notes: [],
    volume: volume[id],
    pan: id === "keys" ? -0.12 : id === "answer" ? 0.14 : 0,
    mute: false,
    solo: false,
    locked: false,
    revision: 0,
  }));
  const add = (
    role: Role,
    tick: number,
    pitch: number,
    duration: number,
    velocity: number,
  ) => {
    if (tick < 0 || tick >= LOOP_TICKS) return;
    const t = tracks.find((t) => t.id === role)!;
    const n: Note = {
      id: role + "-aura-" + t.notes.length,
      tick: Math.round(tick),
      pitch: Math.round(pitch),
      duration: Math.max(30, Math.min(Math.round(duration), LOOP_TICKS - tick)),
      velocity,
    };
    if (role === "bass") n.articulation = "retrigger";
    t.notes.push(n);
  };
  const variant = Math.floor(random() * 4);
  const rhythms =
    writing.direction === "cascade"
      ? [
          [0, 480, 840, 1440, 2160, 2520, 3120],
          [240, 720, 1080, 1680, 2280, 2760, 3240],
          [0, 360, 960, 1560, 2040, 2640, 3120],
          [120, 600, 1080, 1440, 2160, 2880, 3240],
        ]
      : [
          [120, 720, 960, 1800, 2520, 3000],
          [0, 600, 1080, 1920, 2400, 3120],
          [240, 840, 1320, 1800, 2640, 3240],
          [0, 720, 1200, 2040, 2760, 3240],
        ];
  const contours =
    writing.direction === "cascade"
      ? [
          [4, 2, 5, 4, 1, 2, 0],
          [2, 4, 6, 3, 4, 1, 0],
          [5, 3, 4, 1, 2, 4, 0],
          [2, 0, 4, 5, 3, 1, 0],
        ]
      : [
          [0, 5, 2, 6, 4, 2],
          [4, 0, 3, 1, 5, 2],
          [2, 6, 4, 0, 3, 1],
          [5, 1, 4, 2, 0, 3],
        ];
  const rhythm = rhythms[variant],
    contour = contours[Math.floor(random() * 4)],
    anchor = pick(random, [0, 1, 2]);
  for (let cell = 0; cell < 4; cell++) {
    const start = cell * BAR * 2,
      h = harmony[cell];
    // A real recurring call with a longer answer in alternate two-bar cells.
    if (cell % 2 === 0)
      for (let j = 0; j < rhythm.length; j++) {
        let p = degree(contour[j] + anchor, 60);
        if (j === 0 || j === rhythm.length - 1)
          p = register(h.pitches[j === 0 ? 1 : 2], 65, 83);
        if (cell === 2 && j === rhythm.length - 2)
          p = degree(contour[j] + anchor - 1, 60);
        const gap = (rhythm[j + 1] ?? BAR * 2) - rhythm[j];
        const gate = Math.min(
          gap - 45,
          j === rhythm.length - 1
            ? 540
            : writing.direction === "angular"
              ? 300
              : 390,
        );
        add(
          "melody",
          start + rhythm[j],
          register(p, 62, 85),
          gate,
          j === 0 ? 0.8 : j === rhythm.length - 1 ? 0.73 : 0.64,
        );
      }
    else {
      const answer = [h.pitches[1] + 12, h.pitches[2] + 12, h.pitches[0] + 24];
      for (const [j, tick] of [360, 1680, 2760].entries())
        add(
          "answer",
          start + tick,
          register(answer[j], 64, 81),
          j === 1 ? 720 : 540,
          0.64 - j * 0.05,
        );
      if (cell === 3)
        add(
          "melody",
          start + 3360,
          register(harmony[0].pitches[1] + 12, 65, 83),
          300,
          0.55,
        );
    }
    // Held common voices have their own articulation; the lower voice changes independently.
    for (const p of commonPitches)
      add("keys", start, register(p, 52, 71), 1560, 0.53);
    add(
      "keys",
      start + 1920,
      register(
        h.pitches.find((p) => !commonPitches.includes(p)) ?? h.pitches[0],
        48,
        67,
      ),
      1080,
      0.5,
    );
    if (cell === 0 || cell === 2)
      for (const p of commonPitches)
        add("pad", start + 240, register(p + 12, 60, 79), BAR * 4 - 480, 0.42);
    const bassSteps =
      writing.feel === "pulse"
        ? [
            [0, 7, 12, 19, 27],
            [0, 6, 14, 20, 29],
            [0, 9, 16, 23, 28],
          ][pocketVariant]
        : [
            [0, 5, 14, 22, 29],
            [0, 7, 13, 21, 28],
            [0, 6, 15, 24, 29],
          ][pocketVariant];
    const pitchPlan = [
      h.pitches[1],
      h.pitches[1],
      h.pitches[2],
      h.pitches[0],
      h.pitches[1],
    ];
    for (let j = 0; j < bassSteps.length; j++) {
      const tick = start + bassSteps[j] * 120;
      const gap = ((bassSteps[j + 1] ?? 32) - bassSteps[j]) * 120;
      const gate = Math.floor(
        gap * (j === 0 ? 0.83 : j === bassSteps.length - 1 ? 0.44 : 0.62),
      );
      add(
        "bass",
        tick,
        register(pitchPlan[j], 29, 43),
        gate,
        j === 0 ? 0.86 : 0.75,
      );
    }
    for (const step of [0, bassSteps[writing.feel === "pulse" ? 2 : 3]])
      add("kick", start + step * 120, 36, 90, 0.65);
    for (const tick of [960, 2880]) add("clap", start + tick, 39, 100, 0.8);
    const hats =
      writing.feel === "pulse"
        ? [
            [0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 26, 28, 30],
            [0, 2, 4, 8, 10, 12, 14, 16, 18, 20, 24, 26, 28, 30],
            [0, 2, 4, 6, 8, 12, 14, 16, 18, 22, 24, 26, 28, 30],
          ][pocketVariant]
        : [
            [0, 2, 5, 10, 12, 18, 20, 21, 27, 30],
            [0, 3, 6, 11, 12, 19, 22, 23, 28, 30],
            [0, 2, 7, 9, 12, 17, 20, 22, 26, 29],
          ][pocketVariant];
    for (const [j, step] of hats.entries()) {
      if (cell === 3 && step === 30) continue;
      add(
        "hat",
        start + step * 120,
        42,
        32,
        step % 8 === 0 ? 0.62 : j % 3 === 0 ? 0.5 : 0.43,
      );
    }
    if (cell === 1 || cell === 3)
      add(
        "open",
        start + (writing.feel === "pulse" ? 2280 : 3000),
        46,
        150,
        0.43,
      );
    if (cell === 1) add("perc", start + 3240, 37, 90, 0.49);
    if (cell === 3) add("perc", start + 2520, 37, 90, 0.43);
  }
  for (const t of tracks) {
    t.notes.sort((a, b) => a.tick - b.tick);
    if (t.id === "bass")
      for (let i = 0; i < t.notes.length; i++)
        t.notes[i].duration = Math.min(
          t.notes[i].duration,
          (t.notes[i + 1]?.tick ?? LOOP_TICKS) - t.notes[i].tick - 15,
        );
  }
  return {
    id: "aura-" + index,
    name:
      writing.direction === "cascade"
        ? "Cascading keys / wind response"
        : "Angular lead / string ground",
    character: "New sampled notes; provisional tuning; unvalidated draft",
    tracks,
    harmony,
    groove: writing.feel,
    metrics: {
      score: 0,
      continuity: 0,
      bassConsistency: 0,
      density: 0,
      collisions: 0,
      variation: 0,
      reasons: ["Technical draft, not a musical-quality ranking"],
    },
  };
}
export function rewriteAura(original: Project, roles?: Role[]): Project {
  const p = clone(original),
    old = p.candidates[p.selected];
  if (!p.auraOriginal) return p;
  assertRequiredSamples(p);
  const revision = Math.max(...old.tracks.map((t) => t.revision)) + 1;
  const selection = Object.fromEntries(
    ["melody", "keys", "answer", "pad"].map((role) => [
      role,
      { id: old.tracks.find((t) => t.id === role)!.instrument },
    ]),
  ) as Partial<Record<Role, AuraEntry>>;
  // Rewrites retain harmony and use current sources, not a new sound lottery.
  const generated = auraCandidate(
    { ...p.settings, seed: p.settings.seed + "/rewrite/" + revision },
    p.auraOriginal,
    selection,
    p.assets,
    p.selected,
    old.harmony,
    old.tracks,
  );
  generated.tracks = old.tracks.map((saved) => {
    const t = generated.tracks.find((x) => x.id === saved.id);
    return !t || saved.locked || (roles && !roles.includes(saved.id))
      ? clone(saved)
      : { ...clone(saved), notes: t.notes, revision };
  });
  p.candidates[p.selected] = generated;
  return p;
}
export function newAuraProject(
  settings: Settings,
  writing: AuraOriginal,
  selection: Partial<Record<Role, AuraEntry>>,
  assets: SampleAsset[],
): Project {
  const s = {
    ...defaultSettings(),
    ...settings,
    profile: "culture" as const,
    drumKitId: USER_KIT_ID,
    voxDensity: "off" as const,
    masterBypass: true,
    listeningGainDb: 0,
    space: 0.2,
    grit: 0.1,
  };
  const candidates = [0, 1, 2].map((i) =>
    auraCandidate(s, writing, selection, assets, i),
  );
  const ids = new Set(
    candidates.flatMap((c) => c.tracks.map((t) => t.instrument)),
  );
  return {
    format: "ishmakethebeat",
    schema: 1,
    generator: "aura-original-1",
    title: "Aura original · " + writing.direction,
    settings: s,
    candidates,
    selected: 0,
    sections: auraSections(),
    arrangement: true,
    assets: clone(assets.filter((a) => ids.has(a.id))),
    soundBank: { version: BANK_VERSION, presets: clone(PRESETS) },
    auraOriginal: clone(writing),
    tagEnabled: false,
    voxEnabled: false,
    vocalEvents: [],
    clips: [],
    sourceKind: "original-score",
    created: new Date().toISOString(),
  };
}
/** Read-only deterministic section performance of editable base notes. Existing projects never enter this path. */
export function auraSectionNotes(
  p: Project,
  c: Candidate,
  t: Track,
  sec: Section,
): Note[] {
  if (!p.auraOriginal || !p.arrangement) return t.notes;
  const end = sec.bars * BAR,
    notes: Note[] = [];
  const append = (n: Note, tick: number, patch: Partial<Note> = {}) => {
    if (tick < 0 || tick >= end) return;
    const value = {
      ...n,
      ...patch,
      id: sec.id + "-" + tick + "-" + n.id,
      tick,
    };
    value.duration = Math.max(15, Math.min(value.duration, end - tick));
    if (value.glide && value.glide.at >= value.duration) delete value.glide;
    notes.push(value);
  };
  // Lock means no new re-articulation or pitch rewrite (ordinary section arrangement still available).
  for (let cycle = 0; cycle * LOOP_TICKS < end; cycle++)
    for (const n of t.notes) {
      let tick = n.tick + cycle * LOOP_TICKS;
      const bar = Math.floor(tick / BAR);
      let duration = n.duration,
        pitch = n.pitch,
        velocity = n.velocity;
      if (!t.locked) {
        if (sec.kind === "intro") {
          if (
            ["bass", "kick", "clap", "open", "perc"].includes(t.id) &&
            bar < 4
          )
            continue;
          if (t.id === "melody" && bar < 4) continue;
          if (t.id === "answer") continue;
          if (t.id === "hat" && (bar < 2 || n.tick % 480 !== 0)) continue;
        }
        if (sec.kind === "verse") {
          if (t.id === "pad" || t.id === "open") continue;
          if (t.id === "melody" && Math.floor(n.tick / (BAR * 2)) % 2 === 0) {
            if (n.tick % (BAR * 2) < 1920) continue;
            tick += 120;
            pitch -= 12;
            duration = Math.round(duration * 0.75);
          }
          if (t.id === "answer") {
            tick -= 240;
            duration = Math.min(900, duration + 180);
          }
          if (t.id === "keys") {
            duration = Math.min(duration, 540);
            if (n.tick % BAR === 0) tick += 120;
          }
          if (t.id === "hat" && cycle % 2 === 1 && n.tick % 480 !== 0) continue;
          if (t.id === "bass" && bar % 4 === 3 && n.tick % BAR > 960) continue;
        }
        if (sec.kind === "break") {
          if (["melody", "kick", "open", "perc"].includes(t.id)) continue;
          if (t.id === "bass" || t.id === "hat" || t.id === "clap") continue; // deliberate handoff, authored re-entry below
          if (t.id === "keys") {
            pitch -= 12;
            duration = Math.min(BAR * 2 - 120, n.duration * 2);
          }
          if (t.id === "answer" && bar < 4) continue;
        }
        if (sec.kind === "return") {
          if (
            cycle % 2 === 1 &&
            t.id === "melody" &&
            n.tick % (BAR * 2) > 2400
          ) {
            tick += 120;
            duration = Math.max(90, duration - 120);
          }
          if (t.id === "keys" && cycle % 2 === 1) velocity *= 0.86;
        }
        if (sec.kind === "outro") {
          if (bar >= sec.bars - 2) continue;
          if (["kick", "open", "perc"].includes(t.id)) continue;
          if (t.id === "bass" && bar >= 4) continue;
          if (t.id === "hat" && (bar >= 4 || n.tick % 480 !== 0)) continue;
          if (t.id === "melody" && bar >= 4) continue;
        }
        if (
          ["hook", "return", "verse"].includes(sec.kind) &&
          bar === sec.bars - 1 &&
          n.tick % BAR >= 1440 &&
          ["bass", "kick", "hat", "open", "perc"].includes(t.id)
        )
          continue;
      }
      append(n, tick, {
        duration,
        pitch: Math.max(0, Math.min(127, pitch)),
        velocity,
      });
    }
  if (!t.locked && sec.kind === "break") {
    if (t.id === "bass")
      for (const bar of [4, 6]) {
        const h = c.harmony[Math.floor((bar % 8) / 2)];
        append(
          {
            id: "handoff",
            tick: 0,
            pitch: h.root,
            duration: BAR + 960,
            velocity: 0.65,
            articulation: "retrigger",
          },
          bar * BAR,
        );
      }
    if (t.id === "clap")
      for (let bar = Math.max(0, sec.bars - 2); bar < sec.bars; bar++)
        append(
          {
            id: "clap-return",
            tick: 0,
            pitch: 39,
            duration: 100,
            velocity: 0.74,
          },
          bar * BAR + 960,
        );
    if (t.id === "hat")
      for (let beat = 0; beat < 8; beat++)
        append(
          {
            id: "hat-return",
            tick: 0,
            pitch: 42,
            duration: 32,
            velocity: 0.43,
          },
          (sec.bars - 2) * BAR + beat * 480,
        );
  }
  if (
    !t.locked &&
    sec.kind === "outro" &&
    ["keys", "pad", "melody"].includes(t.id)
  ) {
    const h = c.harmony[0],
      pitches =
        t.id === "melody"
          ? [h.pitches[1] + 12]
          : t.id === "pad"
            ? [h.pitches[1] + 12]
            : h.pitches;
    for (const pitch of pitches)
      append(
        {
          id: "ending-" + pitch,
          tick: 0,
          pitch,
          duration: t.id === "melody" ? 720 : BAR + 480,
          velocity: 0.48,
        },
        Math.max(0, sec.bars - 2) * BAR + (t.id === "melody" ? 240 : 0),
      );
  }
  notes.sort((a, b) => a.tick - b.tick);
  if (t.id === "bass" || isDrum(t.id))
    for (let i = 0; i < notes.length; i++)
      notes[i].duration = Math.max(
        15,
        Math.min(
          notes[i].duration,
          (notes[i + 1]?.tick ?? end) - notes[i].tick,
        ),
      );
  return notes;
}
