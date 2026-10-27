import { clone, seconds, LOOP_TICKS } from "./schema";
import type { Project, ScoreEvent } from "./schema";

/** A reviewable starting balance, not a style/quality score or mastering preset. */
export function mixProject(original: Project): Project {
  const p = clone(original),
    candidate = p.candidates[p.selected];
  const targets: Record<string, number> = {
    melody: 0.065,
    keys: 0.022,
    answer: 0.025,
    bass: 0.085,
    kick: 0.045,
    clap: 0.025,
    hat: 0.012,
    open: 0.01,
    perc: 0.014,
  };
  const changes: string[] = [];
  for (const t of candidate.tracks) {
    const a = p.assets.find((a) => a.id === t.instrument);
    if (!t.notes.length || t.mute) continue;
    if (a?.rms && targets[t.id]) {
      const energy = t.notes.reduce((sum, n) => {
        const rate =
          2 ** ((n.pitch + (t.register ?? 0) - a.root + a.tuning / 100) / 12);
        const sourceSeconds =
          (a.trimEnd - a.trimStart) /
          (t.id === "bass" ||
          !["kick", "clap", "hat", "open", "perc"].includes(t.id)
            ? rate
            : 1);
        const held =
          a.envelopeMode === "one-shot"
            ? sourceSeconds
            : Math.min(sourceSeconds, seconds(n.duration, p.settings.bpm));
        return sum + a.rms! ** 2 * a.gain ** 2 * n.velocity ** 2 * held;
      }, 0);
      const estimated = Math.sqrt(energy / seconds(LOOP_TICKS, p.settings.bpm));
      t.volume = Math.max(
        0.08,
        Math.min(0.82, targets[t.id] / Math.max(estimated, 0.001)),
      );
      changes.push(
        `${t.name}: source-energy starting gain ${t.volume.toFixed(2)}`,
      );
    }
    if (t.id === "bass") {
      t.pan = 0;
      if (a)
        t.effects = {
          ...t.effects,
          sampleEnvelope: {
            attack: 0.002,
            decay: 0.085,
            sustain: 0.74,
            release: 0.018,
          },
        };
      changes.push(
        "808 centered; gated envelope has a short release before the next landing",
      );
    }
  }
  for (const v of p.vocalEvents ?? [])
    if (v.role === "vox" && v.id.startsWith("vox-pattern:")) {
      v.gain = Math.min(v.gain, 0.2);
      v.fadeIn = 0.004;
      v.fadeOut = 0.035;
      v.filter = { highpass: 180, lowpass: 8500 };
    }
  // Listening gain is a user audition preference; do not overwrite it.
  p.mixPass = {
    version: "balance-1",
    duck: { depthDb: 3, attack: 0.004, release: 0.08 },
    changes,
  };
  return p;
}

export interface DuckWindow {
  start: number;
  end: number;
  depthDb: number;
  attack: number;
  release: number;
}
/** Merge colliding hits before scheduling; a compressor node has no sidechain input. */
export function duckWindows(
  events: ScoreEvent[],
  bpm: number,
  settings: NonNullable<Project["mixPass"]>["duck"],
): DuckWindow[] {
  const bass = events.filter(
    (e) => e.role === "bass" && e.gain > 0 && e.velocity > 0,
  );
  const windows = events
    .filter((e) => e.role === "kick" && e.gain > 0 && e.velocity > 0)
    .map((e) => ({
      start: seconds(e.tick, bpm),
      end: seconds(e.tick, bpm) + settings.attack + settings.release,
      ...settings,
    }))
    .filter((w) =>
      bass.some(
        (e) =>
          seconds(e.tick, bpm) < w.end &&
          seconds(e.tick + e.duration, bpm) > w.start,
      ),
    )
    .sort((a, b) => a.start - b.start);
  const merged: DuckWindow[] = [];
  for (const w of windows) {
    const last = merged.at(-1);
    if (last && w.start <= last.end) {
      last.end = Math.max(last.end, w.end);
      last.depthDb = Math.max(last.depthDb, w.depthDb);
    } else merged.push({ ...w });
  }
  return merged;
}
