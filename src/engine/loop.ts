import { newProject, defaultSections } from "./compose";
import { defaultSettings } from "./profiles";
import { BAR, LOOP_TICKS, clone } from "./schema";
import type { Project, SampleAsset } from "./schema";
/** Direct source-audio use, explicitly separate from generated composition. */
export function loopProject(
  assets: SampleAsset[],
  loop: SampleAsset,
  tag?: SampleAsset,
): Project {
  const p = newProject({
    ...defaultSettings(),
    bpm: 155,
    key: 0,
    mode: "minor",
    seed: "LILFRUS-LOOP10",
    ensembleMode: "simple",
    grid: "double-time",
  });
  p.title = "@lilfrus LOOP 10 · production candidate";
  p.sourceKind = "supplied-loop";
  p.assets = [
    ...new Map([...p.assets, ...clone(assets)].map((a) => [a.id, a])).values(),
  ];
  p.arrangement = true;
  p.sections = defaultSections();
  p.tagAsset = tag?.id;
  p.tagEnabled = !!tag;
  // Two measured C-salient windows. This is a restrained audition candidate,
  // not a chord transcription or a claim that global C minor is confirmed.
  for (const c of p.candidates) {
    for (const t of c.tracks)
      if (!["kick", "clap", "hat", "open", "perc"].includes(t.id)) t.notes = [];
    const b = c.tracks.find((t) => t.id === "bass")!;
    b.notes = [2, 10].map((beat, i) => ({
      id: `loop-checked-pedal-${i}`,
      tick: beat * 480,
      duration: 600,
      pitch: 36,
      velocity: 0.76,
      articulation: "retrigger",
    }));
    b.volume = 0.56;
    c.name = "Direct loop · sparse checked support";
    c.character =
      "Actual @lilfrus audio; provisional tonal support in measured C-salient windows";
    c.phrasePlan = {
      version: 1,
      grid: "double-time",
      beatsPerBar: 4,
      events: b.notes.map((n) => ({
        role: "bass",
        start: n.tick,
        end: n.tick + n.duration,
        kind: "support",
        description:
          "C-salient source window; tonic/harmony remain unverified by ear",
      })),
    };
  }
  const main: NonNullable<Project["clips"]>[number] = {
    id: "lilfrus-loop10",
    assetId: loop.id,
    name: loop.originalFilename ?? loop.name,
    kind: "supplied-loop",
    role: "loop",
    tick: 0,
    duration: LOOP_TICKS,
    sourceOffset: 0,
    sourceDuration: (32 * 60) / 155,
    gain: 0.8,
    pan: 0,
    pitch: 0,
    reverse: false,
    effects: {},
    repeatTicks: LOOP_TICKS,
    sections: ["intro", "hook", "verse", "return"],
    provenance: {
      sourceHash: loop.hash ?? "",
      sourceName: loop.originalFilename ?? loop.name,
      creator: "@lilfrus",
      credit: `USE TAG!! · ${tag ? "creator-labelled @lilfrus TAG1 included at the opening" : "creator tag requested by source filename"}; supplied stash kit, tag association/authorship/placement unverified by listening`,
      nativeBpm: 155,
      tempoConfidence: 0.7,
      keyEstimate: "C minor / E♭ major ambiguous; measured chroma only",
      keyConfidence: 0.35,
      downbeatOffset: 0,
      beats: 32,
      stretch: "native-only",
    },
  };
  p.clips = [
    main,
    {
      ...clone(main),
      id: "loop10-reduced",
      name: "@lilfrus LOOP 10 · two-bar breakdown region",
      duration: BAR * 2,
      sourceDuration: (8 * 60) / 155,
      gain: 0.48,
      repeatTicks: BAR * 4,
      sections: ["break"],
      provenance: { ...main.provenance, beats: 8 },
    },
    {
      ...clone(main),
      id: "loop10-ending",
      name: "@lilfrus LOOP 10 · ending region",
      duration: BAR * 2,
      sourceDuration: (8 * 60) / 155,
      gain: 0.6,
      sections: ["outro"],
      provenance: { ...main.provenance, beats: 8 },
    },
  ];
  return p;
}
/** Linked rate transposition: tempo and audio pitch move together; MIDI follows.
 * It is deliberately not called pitch-preserving time stretching. */
export function transposeLoop(p: Project, semitones: number): Project {
  const q = clone(p),
    clip = q.clips?.find((c) => c.kind === "supplied-loop");
  if (!clip) return q;
  const target = Math.max(-5, Math.min(5, Math.round(semitones))),
    delta = target - clip.pitch;
  for (const c of q.clips ?? [])
    if (c.kind === "supplied-loop") c.pitch = target;
  q.settings.bpm = clip.provenance.nativeBpm * 2 ** (target / 12);
  q.settings.key = (((q.settings.key + delta) % 12) + 12) % 12;
  for (const c of q.candidates) {
    for (const t of c.tracks)
      if (!["kick", "clap", "hat", "open", "perc"].includes(t.id))
        for (const n of t.notes) {
          n.pitch += delta;
          if (n.glide) n.glide.to += delta;
        }
    for (const chord of c.harmony) {
      chord.root += delta;
      chord.pitches = chord.pitches.map((n) => n + delta);
    }
  }
  return q;
}
export const gridDuration = (bpm: number, bars: number) =>
  (((bars * BAR) / 480) * 60) / bpm;
