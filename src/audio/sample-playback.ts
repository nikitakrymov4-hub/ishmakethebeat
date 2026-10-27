import { isDrum } from "../engine/schema";
import type { SampleAsset, ScoreEvent } from "../engine/schema";

/** Drum-map MIDI notes are identifiers, never implicit transposition from a sample root. */
export function samplePlaybackRate(
  event: Pick<ScoreEvent, "role" | "pitch" | "drumPitch">,
  asset: Pick<SampleAsset, "root" | "tuning" | "drumTuning">,
): number {
  if (isDrum(event.role))
    return 2 ** (((event.drumPitch ?? 0) + (asset.drumTuning ?? 0) / 100) / 12);
  if (event.role === "tag") return 1;
  return 2 ** ((event.pitch - asset.root + asset.tuning / 100) / 12);
}
