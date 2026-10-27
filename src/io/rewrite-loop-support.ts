import { clone, isDrum } from "../engine/schema";
import type { Note, Project, Role } from "../engine/schema";
import { loopSupportRhythm } from "../engine/loop-support-rhythm";
import type { SupportRole, SupportNote } from "../engine/loop-support-rhythm";
import { tdfDrumInstrument } from "../engine/tdf-kit";
import { isLoopBeat } from "./loop-beat";
import { validateProject } from "./persistence";

const support = (role: Role): role is SupportRole =>
  role === "bass" || isDrum(role);
const phrase = (notes: readonly (Note | SupportNote)[]) =>
  JSON.stringify(
    notes.map(({ tick, duration, pitch, articulation, glide }) => ({
      tick,
      duration,
      pitch,
      articulation,
      glide,
    })),
  );

/** Rewrite requested parts against each candidate's retained score, not a discarded full rebuild. */
export function rewriteLoopSupport(
  project: Project,
  roles: readonly Role[] | undefined,
  seed: string,
): Project {
  if (!isLoopBeat(project))
    throw new Error("Open a sample-based beat before rewriting support.");
  if (roles?.some((role) => !support(role)))
    throw new Error(
      "The source melody is audio; only bass and drum support can be rewritten.",
    );
  if (!seed.trim() || seed.length > 128)
    throw new Error("Enter a beat seed of 1–128 characters.");
  const next = clone(project);
  next.settings.seed = seed;
  const root = 24 + next.settings.key + (next.settings.key < 4 ? 12 : 0);
  const onlyBass = roles?.length === 1 && roles[0] === "bass";
  for (const [index, candidate] of next.candidates.entries()) {
    const bass = candidate.tracks.find((track) => track.id === "bass");
    const retainBass =
      bass?.locked || (roles !== undefined && !roles.includes("bass"));
    const variant = (offset: number) =>
      loopSupportRhythm({
        seed,
        candidate: ((index + offset) % 3) as 0 | 1 | 2,
        root,
        density: next.settings.density,
        variation: next.settings.variation,
        ...(retainBass ? { lockedBass: bass?.notes ?? [] } : {}),
      });
    let rhythm = variant(0);
    if (onlyBass && bass && !bass.locked) {
      // A new phrase should change gates/onsets/pitches, not merely randomize velocity.
      for (let offset = 0; offset < 3; offset++) {
        const alternative = offset === 0 ? rhythm : variant(offset);
        if (phrase(alternative.notes.bass) !== phrase(bass.notes)) {
          rhythm = alternative;
          break;
        }
      }
    }
    let changed = false;
    for (const track of candidate.tracks) {
      if (
        !support(track.id) ||
        track.locked ||
        (roles && !roles.includes(track.id))
      )
        continue;
      // A partial rewrite never copies another candidate's sample or control values.
      tdfDrumInstrument(next.assets, track.id, [], track.instrument);
      track.notes = rhythm.notes[track.id].map((note, i) => ({
        ...note,
        id: `${candidate.id}-${track.id}-${i}`,
      }));
      changed = true;
    }
    if (changed)
      candidate.groove = `${rhythm.name} · ${rhythm.version} · partial rewrite`;
  }
  return validateProject(next);
}
