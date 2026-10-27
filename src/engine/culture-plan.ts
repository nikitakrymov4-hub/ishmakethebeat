import type { Settings } from "./schema";
import { rng, pick } from "./random";
export const CULTURE_PLAN_VERSION = "culture-plan-2" as const;
export const RECIPES = [
  {
    id: "paper-lantern",
    name: "Paper lantern",
    character: "Digital keys / open pocket",
    rhythm: [0, 360, 720, 1320, 2160, 2520, 3000],
    contour: [4, 2, 0, 1, 4, 3, 2],
    chords: [
      { tick: 0, duration: 840 },
      { tick: 1440, duration: 360 },
      { tick: 2400, duration: 720 },
    ],
    lead: "culture-key",
    answer: "culture-bell",
    bass: "main plugg 808.wav",
    hat: "tdf hihat.wav",
    clap: "tdf samples clap.wav",
    grooves: [0, 3],
    bassGate: 0.7,
  },
  {
    id: "glass-garden",
    name: "Glass garden",
    character: "Rounded plucks / longer landings",
    rhythm: [0, 480, 840, 1680, 2040, 2640, 3240],
    contour: [0, 2, 4, 3, 2, 1, 0],
    chords: [
      { tick: 240, duration: 1080 },
      { tick: 2160, duration: 960 },
    ],
    lead: "culture-pluck",
    answer: "culture-flute",
    bass: "fav sub 808.wav",
    hat: "okaymar hihat.wav",
    clap: "basic clap.wav",
    grooves: [1, 4],
    bassGate: 0.87,
  },
  {
    id: "odd-orbit",
    name: "Odd orbit",
    character: "Soft organ color / clipped responses",
    rhythm: [120, 600, 1080, 1800, 2400, 2760, 3240],
    contour: [2, 4, 3, 1, 0, 2, 1],
    chords: [
      { tick: 0, duration: 480 },
      { tick: 1080, duration: 480 },
      { tick: 2640, duration: 600 },
    ],
    lead: "culture-organ",
    answer: "culture-bell",
    bass: "6 808.wav",
    hat: "Low tick hat.wav",
    clap: "snap.wav",
    grooves: [2, 5],
    bassGate: 0.58,
  },
] as const;

export interface CultureWritingPlan {
  version: "culture-plan-1" | typeof CULTURE_PLAN_VERSION;
  mood: Settings["mood"];
  key: number;
  mode: Settings["mode"];
  family: number;
  rhythmVariant: number;
  motifVariant: number;
  motifRhythm: number[];
  contour: number[];
  degreeOffset: number;
  harmonicDegrees: number[];
  grooveIndex: number;
  paletteChoice: number;
  arrangementIndex: number;
}
const RHYTHMS = [
  [
    [0, 360, 720, 1320, 2160, 2520, 3000],
    [0, 480, 840, 1440, 2040, 2640, 3240],
    [120, 600, 1080, 1560, 2280, 2760, 3360],
  ],
  [
    [0, 480, 840, 1680, 2040, 2640, 3240],
    [0, 360, 960, 1560, 2160, 2520, 3120],
    [240, 720, 1080, 1800, 2280, 2880, 3360],
  ],
  [
    [120, 600, 1080, 1800, 2400, 2760, 3240],
    [0, 480, 1200, 1680, 2280, 2640, 3360],
    [240, 600, 960, 1560, 2160, 2880, 3240],
  ],
];
const CONTOURS = [
  [
    [4, 2, 0, 1, 4, 3, 2],
    [2, 4, 1, 0, 3, 2, 0],
    [4, 5, 2, 3, 1, 2, 0],
    [0, 2, 4, 3, 2, 1, 0],
  ],
  [
    [0, 2, 4, 3, 2, 1, 0],
    [2, 0, 3, 4, 2, 1, 0],
    [4, 2, 1, 3, 2, 0, 1],
    [0, 1, 3, 2, 4, 2, 0],
  ],
  [
    [2, 4, 3, 1, 0, 2, 1],
    [3, 1, 4, 2, 0, 1, 2],
    [1, 3, 4, 2, 1, 0, 2],
    [4, 2, 3, 0, 1, 2, 0],
  ],
];
const CYCLES: Record<Settings["mood"], number[][][]> = {
  warm: [
    [[0, 0, 0, 0]],
    [
      [0, 0, 3, 3],
      [0, 3, 0, 3],
      [0, 0, 4, 0],
    ],
    [
      [0, 3, 4, 3],
      [0, 4, 3, 4],
      [0, 3, 5, 3],
    ],
    [
      [0, 3, 5, 4],
      [0, 4, 3, 5],
    ],
  ],
  wistful: [
    [[0, 0, 0, 0]],
    [
      [0, 0, 5, 5],
      [0, 5, 0, 5],
      [0, 0, 3, 3],
      [0, 3, 0, 3],
    ],
    [
      [0, 5, 3, 5],
      [0, 3, 5, 3],
      [0, 5, 4, 5],
    ],
    [
      [0, 5, 3, 4],
      [0, 3, 5, 4],
      [0, 5, 4, 3],
    ],
  ],
  eerie: [
    [[0, 0, 0, 0]],
    [
      [0, 0, 1, 1],
      [0, 1, 0, 1],
      [0, 0, 4, 4],
      [0, 4, 0, 4],
    ],
    [
      [0, 1, 4, 1],
      [0, 4, 1, 4],
      [0, 1, 5, 1],
    ],
    [
      [0, 1, 5, 4],
      [0, 4, 1, 5],
      [0, 1, 3, 4],
    ],
  ],
};
/** An authored bounded vocabulary, not artist identification or a learned style model. */
export function cultureWritingPlan(s: Settings, index = 0): CultureWritingPlan {
  const mood = CYCLES[s.mood] ? s.mood : "wistful";
  const random = (part: string) =>
    rng(`${CULTURE_PLAN_VERSION}/${s.seed}/${mood}/${index}/${part}`);
  const selectedFamily = RECIPES.findIndex((r) => r.id === s.cultureFamily);
  const family =
    selectedFamily >= 0
      ? selectedFamily
      : (Math.floor(rng(`ish-2.0.0/${s.seed}/family`)() * 3) + index) % 3;
  const rhythmVariant = (Math.floor(random("rhythm")() * 3) + s.rhythm) % 3;
  const motifVariant = Math.floor(random("motif")() * 4);
  const complexity = Math.max(1, Math.min(4, Math.round(s.complexity)));
  const harmonicDegrees = [
    ...pick(random("harmony"), CYCLES[mood][complexity - 1]),
  ].map((d) => (s.mode === "pentatonic" && d === 5 ? 2 : d));
  const contour = [...CONTOURS[family][motifVariant]];
  if (s.contour === "rising") contour.sort((a, b) => a - b);
  if (s.contour === "falling") contour.sort((a, b) => b - a);
  return {
    version: CULTURE_PLAN_VERSION,
    mood,
    key: s.key,
    mode: s.mode,
    family,
    rhythmVariant,
    motifVariant,
    motifRhythm: [...RHYTHMS[family][rhythmVariant]],
    contour,
    degreeOffset:
      mood === "eerie"
        ? 1
        : mood === "warm"
          ? 0
          : pick(random("register"), [0, 2]),
    harmonicDegrees,
    grooveIndex: pick(random("groove"), [...RECIPES[family].grooves]),
    paletteChoice: family,
    arrangementIndex: Math.floor(
      rng(`${CULTURE_PLAN_VERSION}/${s.seed}/${mood}/form`)() * 3,
    ),
  };
}
/** Only fresh sessions choose a form. Regeneration must retain the user's current sections. */
export const cultureFormBars = (s: Settings) =>
  [
    [4, 16, 16, 8, 16, 4],
    [4, 8, 24, 8, 16, 4],
    [4, 16, 8, 8, 24, 4],
  ][cultureWritingPlan(s).arrangementIndex];
