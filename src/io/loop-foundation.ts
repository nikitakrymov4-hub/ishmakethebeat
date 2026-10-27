import { BAR, LOOP_TICKS, PPQ, clone } from "../engine/schema";
import type { Project, SampleAsset } from "../engine/schema";
import { importSample, validateProject } from "./persistence";

export interface LoopSource {
  filename: string;
  path: string;
  sha256: string;
  creator: string;
  creditBasis: string;
  terms: string;
  filenameBpm?: number | null;
  filenameKey?: string | null;
}
export interface LoopRegion {
  sourceStart: number;
  beats: number;
  nativeBpm: number;
}
export const FOUNDATION_GENERATOR = "ish-source-foundation-1";
export const isLoopFoundation = (project: Project) =>
  project.sourceKind === "supplied-loop" &&
  project.generator === FOUNDATION_GENERATOR;

export function checkedLoopRegion(region: LoopRegion, duration: number) {
  const { sourceStart, beats, nativeBpm } = region;
  if (!Number.isFinite(sourceStart) || sourceStart < 0)
    throw new Error("Enter a source start at or after zero seconds.");
  if (!Number.isFinite(nativeBpm) || nativeBpm < 40 || nativeBpm > 300)
    throw new Error("Enter a source grid tempo from 40 to 300 BPM.");
  if (
    !Number.isFinite(beats) ||
    beats < 0.25 ||
    beats > 32 ||
    !Number.isInteger(beats * 4)
  )
    throw new Error(
      "Choose 0.25–32 beats in quarter-beat steps (up to eight bars).",
    );
  const sourceDuration = (beats * 60) / nativeBpm;
  if (
    !Number.isFinite(duration) ||
    duration <= 0 ||
    sourceStart + sourceDuration > duration + 1e-9
  )
    throw new Error(
      `The selected ${sourceDuration.toFixed(3)}-second region extends beyond the decoded source. Move its start or choose fewer beats.`,
    );
  return {
    ...region,
    sourceDuration,
    ticks: Math.round(beats * PPQ),
    bars: Math.ceil(beats / 4),
  };
}

/** Retain encoded original bytes. MP3 uses the existing decoder's supported import path. */
export async function importLoopSource(
  file: File,
  source: LoopSource,
): Promise<SampleAsset> {
  const audio = await importSample(
    file,
    file.name.toLowerCase().endsWith(".mp3") ? "vox" : "loop",
  );
  if (!/^[a-f0-9]{64}$/.test(source.sha256) || audio.hash !== source.sha256)
    throw new Error(
      "Source bytes differ from the library catalogue hash; reload the catalogue before importing.",
    );
  return {
    ...audio,
    id: `sample-${audio.hash!.slice(0, 16)}-loop`,
    role: "loop",
    root: 60,
    tuning: 0,
    rootConfidence: 0,
    manualOverride: false,
    gain: 1,
    choke: "",
    loop: false,
    envelopeMode: "gated",
    sourceId: source.path,
    source: `Creator: ${source.creator}\nCredit basis: ${source.creditBasis}`,
    license: source.terms,
  };
}

export function loopFoundation(
  base: Project,
  asset: SampleAsset,
  source: LoopSource,
  region: LoopRegion,
): Project {
  const chosen = checkedLoopRegion(region, asset.duration ?? asset.trimEnd);
  if (asset.hash !== source.sha256)
    throw new Error("Imported source hash does not match its provenance.");
  const p = clone(base);
  p.generator = FOUNDATION_GENERATOR;
  p.title = `${source.filename} · loop foundation`;
  p.created = new Date().toISOString();
  p.sourceKind = "supplied-loop";
  p.settings.bpm = chosen.nativeBpm;
  p.settings.listeningGainDb = 0;
  p.selected = 0;
  p.arrangement = true;
  p.sections = [
    {
      id: "source-region",
      name: "Source region",
      kind: "hook",
      bars: chosen.bars,
    },
  ];
  p.assets = [...p.assets.filter((a) => a.id !== asset.id), clone(asset)];
  p.tagAsset = undefined;
  p.tagEnabled = false;
  p.voxEnabled = false;
  p.vocalEvents = [];
  p.scaleGuides = [];
  delete p.recipe;
  for (const [index, candidate] of p.candidates.entries()) {
    candidate.name = `Loop foundation ${String.fromCharCode(65 + index)}`;
    candidate.character = "Source key unverified · empty support lanes";
    candidate.groove = "User-entered source grid";
    // Schema placeholder only: no harmonic notes are inferred or played.
    candidate.harmony = [
      { tick: 0, duration: LOOP_TICKS, root: p.settings.key, pitches: [] },
    ];
    candidate.metrics = {
      score: 0,
      continuity: 0,
      bassConsistency: 0,
      density: 0,
      collisions: 0,
      variation: 0,
      reasons: [
        "Supplied audio; no generated notes. Source harmony and musical quality unassessed.",
      ],
    };
    delete candidate.phrasePlan;
    delete candidate.recipe;
    for (const track of candidate.tracks) {
      track.notes = [];
      track.mute = false;
      track.solo = false;
      track.locked = false;
    }
  }
  p.clips = [
    {
      id: `library-loop-${source.sha256.slice(0, 16)}`,
      assetId: asset.id,
      name: source.filename,
      kind: "supplied-loop",
      role: "loop",
      tick: 0,
      duration: chosen.ticks,
      sourceOffset: chosen.sourceStart,
      sourceDuration: chosen.sourceDuration,
      gain: 1,
      pan: 0,
      pitch: 0,
      reverse: false,
      effects: {},
      repeatTicks: LOOP_TICKS,
      provenance: {
        sourceHash: source.sha256,
        sourceName: source.filename,
        creator: source.creator,
        credit: `${source.creditBasis}\n${source.terms}\nGrid entered by user; no tempo/downbeat detection. Filename hints: ${source.filenameBpm ?? "none"} BPM, ${source.filenameKey ?? "no key"} (unverified).`,
        nativeBpm: chosen.nativeBpm,
        tempoConfidence: 0,
        keyEstimate: "Source key unverified; no harmony inferred",
        keyConfidence: 0,
        downbeatOffset: chosen.sourceStart,
        beats: chosen.beats,
        stretch: "native-only",
      },
    },
  ];
  return validateProject(p);
}

/** Update the chosen region without cropping, stretching, rewriting notes or changing original bytes. */
export function updateFoundationRegion(
  project: Project,
  region: LoopRegion,
): Project {
  if (!isLoopFoundation(project))
    throw new Error("This is not a library loop foundation.");
  const p = clone(project),
    clip = p.clips?.find((c) => c.kind === "supplied-loop");
  if (!clip) throw new Error("Loop source region is missing.");
  const asset = p.assets.find((a) => a.id === clip.assetId);
  if (!asset) throw new Error("Loop source audio is missing.");
  const chosen = checkedLoopRegion(region, asset.duration ?? asset.trimEnd);
  const bpm = chosen.nativeBpm * 2 ** (clip.pitch / 12);
  if (bpm < 40 || bpm > 300)
    throw new Error(
      "Linked pitch/speed places the project tempo outside 40–300 BPM.",
    );
  p.settings.bpm = bpm;
  clip.sourceOffset = chosen.sourceStart;
  clip.sourceDuration = chosen.sourceDuration;
  clip.duration = chosen.ticks;
  clip.repeatTicks = LOOP_TICKS;
  clip.provenance = {
    ...clip.provenance,
    nativeBpm: chosen.nativeBpm,
    beats: chosen.beats,
    downbeatOffset: chosen.sourceStart,
    tempoConfidence: 0,
  };
  // The initial single-section foundation has a whole-bar timeline. Longer user arrangements stay intact.
  if (p.sections.length === 1 && p.sections[0].id === "source-region")
    p.sections[0].bars = Math.ceil(chosen.ticks / BAR);
  return validateProject(p);
}
