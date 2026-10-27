export const VERSION = "ish-3.2.0-developed";
export const PPQ = 480;
export const BAR = 1920;
export const LOOP_TICKS = BAR * 8;
export const ROLES = [
  "melody",
  "pad",
  "answer",
  "bass",
  "kick",
  "clap",
  "hat",
  "open",
  "perc",
] as const;
export const ENSEMBLE_ROLES = ["keys", "bridge", "pedal"] as const;
export const ALL_ROLES = [...ROLES, ...ENSEMBLE_ROLES] as const;
export type Role = (typeof ALL_ROLES)[number];
export interface RoleEffects {
  sampleEnvelope?: {
    attack: number;
    decay: number;
    sustain: number;
    release: number;
  };
  /** Currently rendered only by explicit vocal events. */
  reverb?: { wet: number; decay: number; preDelay: number };
  delay?: {
    division: number;
    feedback: number;
    wet: number;
    cutoff: number;
    pingPong: boolean;
    automation?: { tick: number; wet: number }[];
  };
  hat?: {
    mix: number;
    echoBeats: number;
    feedback: number;
    chorus: number;
    crush: number;
    room: number;
  };
  saturation?: number;
}
export type ProfileId = "culture" | "airy" | "spacey" | "bright" | "dark";
export type Mode = "minor" | "pentatonic" | "major" | "dorian";
export interface Note {
  id: string;
  tick: number;
  duration: number;
  pitch: number;
  velocity: number;
  /** Sampled drum pitch offset in semitones; MIDI pitch remains the drum-map note. */
  drumPitch?: number;
  articulation?: "retrigger" | "legato";
  glide?: { to: number; at: number; ms: number };
}
export interface Track {
  id: Role;
  name: string;
  instrument: string;
  notes: Note[];
  volume: number;
  pan: number;
  mute: boolean;
  solo: boolean;
  locked: boolean;
  revision: number;
  register?: number;
  effects?: RoleEffects;
}
export interface Chord {
  tick: number;
  duration: number;
  root: number;
  pitches: number[];
}
export interface Metrics {
  score: number;
  continuity: number;
  bassConsistency: number;
  density: number;
  collisions: number;
  variation: number;
  reasons: string[];
}
export interface Candidate {
  id: string;
  name: string;
  character: string;
  tracks: Track[];
  harmony: Chord[];
  metrics: Metrics;
  groove: string;
  recipe?: RecipeState;
  phrasePlan?: {
    version: 1;
    grid: "double-time" | "half-time";
    beatsPerBar: 4;
    events: {
      role: Role;
      start: number;
      end: number;
      kind: "call" | "answer" | "support" | "rest" | "delay" | "gesture";
      description: string;
    }[];
  };
}
export interface Settings {
  drumKitId?: string;
  voxDensity?: "off" | "sparse" | "regular";
  profile: ProfileId;
  bpm: number;
  key: number;
  mode: Mode;
  mood: "warm" | "wistful" | "eerie";
  seed: string;
  space: number;
  brightness: number;
  grit: number;
  sustain: number;
  density: number;
  rolls: number;
  variation: number;
  swing: number;
  noteDensity: number;
  complexity: number;
  contour: "arch" | "falling" | "rising";
  rhythm: number;
  octave: number;
  referenceGain: number;
  masterBypass: boolean;
  previewGain: number;
  listeningGainDb?: number;
  provisionalIdentity: string;
  cultureFamily?: "auto" | "paper-lantern" | "glass-garden" | "odd-orbit";
  /** Explicit opt-in; existing kit-only sessions keep their policy. */
  allowSynthFallback?: boolean;
  ensembleMode?: "conversation" | "simple";
  grid?: "double-time" | "half-time";
}
export interface Section {
  id: string;
  name: string;
  bars: number;
  kind: "intro" | "hook" | "verse" | "break" | "return" | "outro";
}
export interface SampleAsset {
  kitId?: string;
  rms?: number;
  id: string;
  name: string;
  data: string;
  role: Role | "tag" | "vox" | "loop" | "resample";
  root: number;
  tuning: number;
  /** Explicit sampled-drum tuning in cents. Absence preserves legacy native-rate playback. */
  drumTuning?: number;
  trimStart: number;
  trimEnd: number;
  gain: number;
  choke: string;
  license: string;
  originalFilename?: string;
  sourceId?: string;
  source?: string;
  hash?: string;
  sampleRate?: number;
  channels?: number;
  rootConfidence?: number;
  manualOverride?: boolean;
  measuredFundamentalHz?: number | null;
  envelopeMode?: "one-shot" | "gated";
  loop?: boolean;
  duration?: number;
  envelope?: {
    attack: number;
    decay: number;
    sustain: number;
    release: number;
  };
}
export interface AudioClip {
  id: string;
  assetId: string;
  name: string;
  kind: "supplied-loop" | "original-resample";
  role: "loop" | "resample";
  tick: number;
  duration: number;
  sourceOffset: number;
  sourceDuration: number;
  gain: number;
  pan: number;
  pitch: number;
  reverse: boolean;
  effects?: RoleEffects;
  sections?: Section["kind"][];
  repeatTicks?: number;
  provenance: {
    sourceHash: string;
    sourceName: string;
    creator: string;
    credit: string;
    nativeBpm: number;
    tempoConfidence: number;
    keyEstimate: string;
    keyConfidence: number;
    manualKey?: string;
    downbeatOffset: number;
    beats: number;
    stretch: "native-only";
    sourceScore?: {
      role: Role;
      notes: Note[];
      instrument: string;
      bpm: number;
      preset?: import("../audio/bank").Preset;
      gain?: number;
      effects?: RoleEffects;
      settings?: Settings;
    };
    renderId?: string;
  };
}
/** Explicit vocal audio placements. Pitch changes playback speed; no time-stretch is implied. */
export interface VocalEvent {
  id: string;
  name: string;
  assetId: string;
  role: "tag" | "vox";
  enabled: boolean;
  placement:
    | { kind: "absolute"; tick: number }
    | { kind: "section"; sectionId: string; tick: number };
  duration: number;
  sourceOffset: number;
  sourceDuration: number;
  gain: number;
  pan: number;
  pitch: number;
  reverse: boolean;
  mode: "one-shot" | "gated";
  fadeIn: number;
  fadeOut: number;
  filter?: { highpass: number; lowpass: number };
  effects?: RoleEffects;
  /** Count is additional occurrences; zero means play once. */
  repeats?: { count: number; intervalTicks: number };
  overlap: "allow" | "choke-group";
  chokeGroup?: string;
  provenance: {
    sourceName: string;
    sourceHash: string;
    creator: string;
    credit: string;
    processing?: {
      sourceAssetId: string;
      sourceHash: string;
      processor: string;
      version: string;
      settings: Record<string, string | number | boolean>;
    };
  };
}
export interface RecipeState {
  id: string;
  family: string;
  motifRhythm: number[];
  contour: number[];
  chordRhythm: { tick: number; duration: number }[];
  voicings: number[][];
  leadTreatment: {
    cutoff: number;
    vibrato: number;
    delay: number;
    width: number;
  };
  bassArticulation: string;
  arrangementEnergy: number;
  /** Last automatic patch per role; manual selections never become generator-owned. */
  automaticPalette?: Partial<Record<Role, string>>;
  resolvedPalette?: Partial<Record<Role, string>>;
  development?: "A-Aprime-B-A";
  /** Partial rewrites retain the existing arrangement policy independently of new writing metadata. */
  performance?: { developed: boolean; planned: boolean };
  composition?: import("./culture-plan").CultureWritingPlan & {
    harmonyRetained: boolean;
  };
}
export interface Project {
  /** Explicit opt-in only; absent on all existing sessions. */
  auraOriginal?: import("./aura-writing").AuraOriginal;
  mixPass?: {
    version: "balance-1";
    duck: { depthDb: number; attack: number; release: number };
    changes: string[];
  };
  format: "ishmakethebeat";
  schema: 1;
  generator: string;
  title: string;
  settings: Settings;
  candidates: Candidate[];
  selected: number;
  sections: Section[];
  arrangement: boolean;
  assets: SampleAsset[];
  recipe?: RecipeState;
  soundBank?: { version: string; presets: import("../audio/bank").Preset[] };
  tagAsset?: string;
  tagEnabled: boolean;
  voxEnabled?: boolean;
  /** Absence retains the legacy tag; an explicit array replaces it. */
  vocalEvents?: VocalEvent[];
  created: string;
  clips?: AudioClip[];
  scaleGuides?: {
    name: string;
    pitches: number[];
    sourceHash: string;
    enabled: boolean;
  }[];
  sourceKind?: "original-score" | "supplied-loop" | "supplied-midi";
}
export interface ScoreEvent extends Note {
  role: Role | "tag" | "vox" | "loop" | "resample";
  instrument: string;
  gain: number;
  pan: number;
  filter: number;
  chokeAfter?: number;
  effects?: RoleEffects;
  reverse?: boolean;
  effectTick?: number;
  busId?: string;
  sourceOffset?: number;
  sourceDuration?: number;
  playbackRate?: number;
  envelopeOffsetSeconds?: number;
  envelopeDurationSeconds?: number;
  vocal?: {
    eventId: string;
    mode: "one-shot" | "gated";
    fadeIn: number;
    fadeOut: number;
    filter?: { highpass: number; lowpass: number };
    overlap: "allow" | "choke-group";
    chokeGroup?: string;
  };
}
export const SCALES: Record<Mode, number[]> = {
  minor: [0, 2, 3, 5, 7, 8, 10],
  pentatonic: [0, 3, 5, 7, 10],
  major: [0, 2, 4, 5, 7, 9, 11],
  dorian: [0, 2, 3, 5, 7, 9, 10],
};
export const KEYS = [
  "C",
  "C♯",
  "D",
  "D♯",
  "E",
  "F",
  "F♯",
  "G",
  "G♯",
  "A",
  "A♯",
  "B",
];
export const isDrum = (r: string) =>
  ["kick", "clap", "hat", "open", "perc"].includes(r);
export const seconds = (ticks: number, bpm: number) =>
  ((ticks / PPQ) * 60) / bpm;
export const noteName = (p: number) =>
  `${KEYS[((p % 12) + 12) % 12]}${Math.floor(p / 12) - 1}`;
export const clone = <T>(p: T): T => structuredClone(p);
