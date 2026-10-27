import { suppliedDrum } from "../engine/studio-palette";
import { BAR, KEYS, LOOP_TICKS, PPQ, clone, isDrum } from "../engine/schema";
import type {
  AudioClip,
  Candidate,
  Project,
  Section,
  Settings,
} from "../engine/schema";
import { loopSupportRhythm } from "../engine/loop-support-rhythm";
import type { SupportRole } from "../engine/loop-support-rhythm";
import { validateProject } from "./persistence";
import { checkedLoopRegion, loopFoundation } from "./loop-foundation";
import type { LoopRegion, LoopSource } from "./loop-foundation";
import type { SampleAsset } from "../engine/schema";
import { tdfDrumInstrument } from "../engine/tdf-kit";

export const LOOP_BEAT_GENERATOR = "ish-source-beat-1";
export const isLoopBeat = (p: Project) =>
  p.sourceKind === "supplied-loop" && p.generator === LOOP_BEAT_GENERATOR;
export interface LoopBeatOptions {
  key: number;
  mode: "major" | "minor";
  seed: string;
}
const support = (id: string) => id === "bass" || isDrum(id);
function checkedOptions(options: LoopBeatOptions) {
  if (
    !Number.isInteger(options.key) ||
    options.key < 0 ||
    options.key > 11 ||
    !["major", "minor"].includes(options.mode)
  )
    throw new Error(
      "Choose a bass key and major/minor basis. This is your setting, not detected source harmony.",
    );
  if (
    typeof options.seed !== "string" ||
    !options.seed.trim() ||
    options.seed.length > 128
  )
    throw new Error("Enter a beat seed of 1–128 characters.");
}
function checkedBeatRegion(region: LoopRegion, duration: number) {
  const chosen = checkedLoopRegion(region, duration);
  if (![4, 8, 16, 32].includes(chosen.beats))
    throw new Error(
      "For a beat, select a complete 1, 2, 4 or 8-bar source phrase (4, 8, 16 or 32 beats). The source-only foundation can use other lengths.",
    );
  return chosen;
}

/** Aim near two minutes; main sections contain complete selected source phrases. */
export function loopBeatSections(bpm: number, phraseBars: number): Section[] {
  const desiredBars = (120 * bpm) / 240;
  const intro = Math.min(4, Math.max(1, Math.round(desiredBars * 0.06)));
  const reduced = Math.min(8, Math.max(2, Math.round(desiredBars * 0.08)));
  const fixedBars = intro * 2 + reduced;
  const choices = Array.from({ length: 128 }, (_, i) => i + 2)
    .map((cycles) => ({
      cycles,
      seconds: ((fixedBars + cycles * phraseBars) * 240) / bpm,
    }))
    .filter((x) => x.seconds >= 90 && x.seconds <= 146)
    .sort((a, b) => Math.abs(a.seconds - 120) - Math.abs(b.seconds - 120));
  if (!choices.length)
    throw new Error(
      "This tempo and phrase length cannot fit the beat arrangement.",
    );
  const cycles = choices[0].cycles;
  const verseCycles = cycles >= 3 ? Math.floor(cycles / 3) : 0;
  const hookCycles = Math.ceil((cycles - verseCycles) / 2);
  const returnCycles = cycles - verseCycles - hookCycles;
  const split = (
    kind: Section["kind"],
    name: string,
    bars: number,
  ): Section[] => {
    const sections: Section[] = [];
    for (let left = bars; left > 0; left -= 64)
      sections.push({
        id: `${kind}-${sections.length}`,
        name: sections.length ? `${name} continued` : name,
        kind,
        bars: Math.min(64, left),
      });
    return sections;
  };
  return [
    { id: "loop-intro", name: "Source entrance", kind: "intro", bars: intro },
    ...split("hook", "Main beat", hookCycles * phraseBars),
    ...split("verse", "Development", verseCycles * phraseBars),
    {
      id: "loop-break",
      name: "Reduced source",
      kind: "break",
      bars: reduced,
    },
    ...split("return", "Full return", returnCycles * phraseBars),
    { id: "loop-outro", name: "Source ending", kind: "outro", bars: intro },
  ];
}

function writeSupport(
  template: Candidate,
  options: LoopBeatOptions,
  assets: SampleAsset[],
  settings: Pick<Settings, "density" | "variation" | "drumKitId">,
): Candidate[] {
  return ([0, 1, 2] as const).map((index) => {
    const c = clone(template);
    // The root/fifth basis is user-chosen. No chord progression or melody is inferred.
    const root = 24 + options.key + (options.key < 4 ? 12 : 0);
    const bass = template.tracks.find((track) => track.id === "bass");
    const rhythm = loopSupportRhythm({
      seed: options.seed,
      candidate: index,
      root,
      density: settings.density,
      variation: settings.variation,
      ...(bass?.locked ? { lockedBass: bass.notes } : {}),
    });
    c.id = `loop-beat-${index}`;
    c.name = [
      "A · Two-bar accents",
      "B · Rest and re-entry",
      "C · Sparse responses",
    ][index];
    c.character = `Sample melody · ${KEYS[options.key]} ${options.mode} bass basis (user set)`;
    c.groove = `${rhythm.name} · ${rhythm.version}`;
    delete c.recipe;
    // Installing a phrasePlan changes legacy eighth-bar bass presence in score().
    // Keep the generic arrangement unchanged; the pure rhythm module exposes the plan.
    delete c.phrasePlan;
    c.harmony = [
      { tick: 0, duration: LOOP_TICKS, root, pitches: [root, root + 7] },
    ];
    c.metrics = {
      score: 0,
      continuity: 0,
      bassConsistency: 0,
      density: 0,
      collisions: 0,
      variation: 0,
      reasons: [
        "Actual supplied melody. Bass uses the selected root/fifth only; source chord compatibility and production quality require listening.",
        `${rhythm.version}: repeated two-bar cells, beat-three clap anchors, explicit bass gaps, bass-linked kicks and a candidate-specific phrase answer. Third-party reconstruction choices, not a verified TDF formula.`,
      ],
    };
    for (const track of c.tracks) {
      if (support(track.id) && track.locked) continue;
      if (!support(track.id)) {
        track.notes = [];
        continue;
      }
      // Keep selected samples, mixer state, tuning, effects and editor metadata intact.
      track.instrument =
        suppliedDrum(settings, assets, track.id, index, track.instrument) ??
        tdfDrumInstrument(assets, track.id, [], track.instrument);
      track.notes = rhythm.notes[track.id as SupportRole].map((note, i) => ({
        ...note,
        id: `${c.id}-${track.id}-${i}`,
      }));
    }
    return c;
  });
}

function arrangeClips(main: AudioClip, sections: Section[]): AudioClip[] {
  const reducedRepeat = Math.min(LOOP_TICKS, main.duration * 2);
  const outroTicks = Math.min(
    main.duration,
    sections.find((s) => s.kind === "outro")!.bars * BAR,
  );
  return [
    {
      ...clone(main),
      sections: ["intro", "hook", "verse", "return"],
      repeatTicks: main.duration,
    },
    {
      ...clone(main),
      id: `${main.id}-reduced`,
      name: `${main.provenance.sourceName} · reduced section`,
      sections: ["break"],
      gain: main.gain * 0.7,
      repeatTicks: reducedRepeat,
    },
    {
      ...clone(main),
      id: `${main.id}-ending`,
      name: `${main.provenance.sourceName} · ending region`,
      sections: ["outro"],
      duration: outroTicks,
      sourceDuration: ((outroTicks / PPQ) * 60) / main.provenance.nativeBpm,
      gain: main.gain * 0.8,
      repeatTicks: LOOP_TICKS,
      provenance: { ...main.provenance, beats: outroTicks / PPQ },
    },
  ];
}

export function loopBeat(
  base: Project,
  asset: SampleAsset,
  source: LoopSource,
  region: LoopRegion,
  options: LoopBeatOptions,
): Project {
  checkedOptions(options);
  const chosen = checkedBeatRegion(region, asset.duration ?? asset.trimEnd);
  const template = base.candidates[base.selected];
  const p = loopFoundation(base, asset, source, region);
  p.generator = LOOP_BEAT_GENERATOR;
  p.title = `${source.filename} · sample-based beat`;
  p.settings = {
    ...p.settings,
    profile: "culture",
    key: options.key,
    mode: options.mode,
    seed: options.seed,
    ensembleMode: "simple",
    listeningGainDb: 0,
  };
  p.candidates = writeSupport(template, options, p.assets, p.settings);
  p.sections = loopBeatSections(chosen.nativeBpm, chosen.bars);
  const main = p.clips![0];
  main.gain = 0.68;
  main.provenance.manualKey = `${KEYS[options.key]} ${options.mode}`;
  main.provenance.keyEstimate = `User-selected ${KEYS[options.key]} ${options.mode} bass basis; source harmony unverified`;
  main.provenance.credit +=
    "\nMelody is the supplied audio, not newly generated notes. Bass/drums and arrangement are generated from the saved seed; key is user chosen, not detected.";
  p.clips = arrangeClips(main, p.sections);
  return validateProject(p);
}

/** Regenerate only support; preserve source edits, arrangement, imported bytes, vocal lane and all credits. */
export function rebuildLoopBeat(
  project: Project,
  options: LoopBeatOptions,
): Project {
  if (!isLoopBeat(project))
    throw new Error("Open a sample-based beat before rebuilding support.");
  checkedOptions(options);
  const p = clone(project);
  p.settings.key = options.key;
  p.settings.mode = options.mode;
  p.settings.seed = options.seed;
  p.candidates = writeSupport(
    p.candidates[p.selected],
    options,
    p.assets,
    p.settings,
  );
  p.selected = 0;
  for (const clip of p.clips ?? [])
    if (clip.kind === "supplied-loop") {
      clip.provenance.manualKey = `${KEYS[options.key]} ${options.mode}`;
      clip.provenance.keyEstimate = `User-selected ${KEYS[options.key]} ${options.mode} bass basis; source harmony unverified`;
    }
  return validateProject(p);
}

export function updateLoopBeatRegion(
  project: Project,
  region: LoopRegion,
): Project {
  if (!isLoopBeat(project)) throw new Error("This is not a sample-based beat.");
  const p = clone(project),
    main = p.clips?.find((c) => c.kind === "supplied-loop");
  if (!main) throw new Error("The loop source region is missing.");
  const asset = p.assets.find((a) => a.id === main.assetId);
  if (!asset) throw new Error("The loop source asset is missing.");
  const chosen = checkedBeatRegion(region, asset.duration ?? asset.trimEnd);
  const bpm = chosen.nativeBpm * 2 ** (main.pitch / 12);
  if (bpm < 40 || bpm > 300)
    throw new Error(
      "Linked pitch/speed puts the project tempo outside 40–300 BPM.",
    );
  p.settings.bpm = bpm;
  main.sourceOffset = chosen.sourceStart;
  main.sourceDuration = chosen.sourceDuration;
  main.duration = chosen.ticks;
  main.provenance = {
    ...main.provenance,
    nativeBpm: chosen.nativeBpm,
    beats: chosen.beats,
    downbeatOffset: chosen.sourceStart,
    tempoConfidence: 0,
  };
  const arranged = arrangeClips(main, p.sections);
  // Retain gain/FX/pan/reverse edits on secondary clips while synchronizing their source grid.
  p.clips = arranged.map((clip, i) => ({
    ...clip,
    gain: p.clips?.[i]?.gain ?? clip.gain,
    effects: p.clips?.[i]?.effects ?? clip.effects,
    pan: p.clips?.[i]?.pan ?? clip.pan,
    reverse: p.clips?.[i]?.reverse ?? clip.reverse,
  }));
  return validateProject(p);
}

/** Move written bass pitches with a changed user basis, retaining rhythm and all source audio. */
export function setLoopBeatKey(
  project: Project,
  key: number,
  mode: "major" | "minor",
): Project {
  if (!isLoopBeat(project)) throw new Error("This is not a sample-based beat.");
  checkedOptions({ key, mode, seed: project.settings.seed });
  const p = clone(project),
    delta = key - p.settings.key;
  p.settings.key = key;
  p.settings.mode = mode;
  for (const candidate of p.candidates) {
    const bass = candidate.tracks.find((t) => t.id === "bass");
    for (const note of bass?.notes ?? []) {
      note.pitch += delta;
      if (note.glide) note.glide.to += delta;
    }
    for (const chord of candidate.harmony) {
      chord.root += delta;
      chord.pitches = chord.pitches.map((n) => n + delta);
    }
    candidate.character = `Sample melody · ${KEYS[key]} ${mode} bass basis (user set)`;
  }
  for (const clip of p.clips ?? [])
    if (clip.kind === "supplied-loop") {
      clip.provenance.manualKey = `${KEYS[key]} ${mode}`;
      clip.provenance.keyEstimate = `User-selected ${KEYS[key]} ${mode} bass basis; source harmony unverified`;
    }
  return validateProject(p);
}
