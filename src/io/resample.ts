import { BAR, LOOP_TICKS, seconds, clone } from "../engine/schema";
import type { Project, Role, AudioClip, SampleAsset } from "../engine/schema";
import { renderWav } from "./export";
import { PRESETS } from "../audio/bank";
export async function createReversePickup(
  project: Project,
  role: Role,
): Promise<{ asset: SampleAsset; clip: AudioClip }> {
  const p = clone(project),
    t = p.candidates[p.selected].tracks.find((t) => t.id === role)!;
  if (!t.notes.length)
    throw new Error("Choose a role containing notes to resample.");
  p.arrangement = false;
  p.clips = [];
  p.tagEnabled = false;
  for (const track of p.candidates[p.selected].tracks)
    track.solo = track.id === role;
  const rendered = await renderWav(p, role);
  const hash = Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new Uint8Array(rendered.wav)),
    ),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
  const data = await new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(
      new Blob([new Uint8Array(rendered.wav)], { type: "audio/wav" }),
    );
  });
  const sourceOffset = seconds(t.notes[0].tick, p.settings.bpm),
    sourceDuration = seconds(BAR / 2, p.settings.bpm);
  const asset: SampleAsset = {
    id: `sample-resample-${hash.slice(0, 16)}`,
    name: `Original ${t.name} render`,
    data,
    role: "resample",
    root: 60,
    tuning: 0,
    trimStart: 0,
    trimEnd: rendered.duration,
    gain: 1,
    choke: "",
    license: "Original score render; embedded sources retain their provenance",
    hash,
    sourceId: `original-render:${hash}`,
    source: "Authored score, rendered through the shared audio graph",
    sampleRate: 44100,
    channels: 2,
    duration: rendered.duration,
    envelopeMode: "gated",
    rootConfidence: 1,
  };
  const clip: AudioClip = {
    id: `reverse-${role}`,
    assetId: asset.id,
    name: `Reverse ${t.name} pickup`,
    kind: "original-resample",
    role: "resample",
    tick: LOOP_TICKS - BAR / 2,
    duration: BAR / 2,
    sourceOffset,
    sourceDuration,
    gain: 0.32,
    pan: -0.2,
    pitch: 0,
    reverse: true,
    repeatTicks: LOOP_TICKS,
    sections: ["hook", "return"],
    effects: {
      delay: {
        division: 0.5,
        feedback: 0.18,
        wet: 0.14,
        cutoff: 3400,
        pingPong: true,
      },
    },
    provenance: {
      sourceHash: hash,
      sourceName: asset.name,
      creator: "ishmakethebeat · original score",
      credit: "Original phrase resampling; no album audio used",
      nativeBpm: p.settings.bpm,
      tempoConfidence: 1,
      keyEstimate: `MIDI key ${p.settings.key} ${p.settings.mode}`,
      keyConfidence: 1,
      downbeatOffset: 0,
      beats: 2,
      stretch: "native-only",
      renderId: hash,
      sourceScore: {
        role,
        notes: clone(t.notes),
        instrument: t.instrument,
        bpm: p.settings.bpm,
        preset:
          p.soundBank?.presets.find((x) => x.id === t.instrument) ??
          PRESETS.find((x) => x.id === t.instrument),
        gain: t.volume,
        effects: clone(t.effects),
        settings: clone(p.settings),
      },
    },
  };
  return { asset, clip };
}
