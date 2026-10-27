import { BAR, LOOP_TICKS, PPQ } from "./schema";
import type { Candidate, Note } from "./schema";
import { clamp, pick, rng } from "./random";

export const LOOP_SUPPORT_RHYTHM = "source-support-cells-2";
export const SUPPORT_ROLES = [
  "bass",
  "kick",
  "clap",
  "hat",
  "open",
  "perc",
] as const;
export type SupportRole = (typeof SUPPORT_ROLES)[number];
export type SupportNote = Omit<Note, "id">;
export interface SupportRhythmOptions {
  seed: string;
  candidate: 0 | 1 | 2;
  root: number;
  density?: number;
  variation?: number;
  /** Rebuilt kicks follow the actual edited bass when that track is locked. */
  lockedBass?: readonly Note[];
}
export interface SupportRhythm {
  version: typeof LOOP_SUPPORT_RHYTHM;
  name: string;
  notes: Record<SupportRole, SupportNote[]>;
  /** Exposed for inspection, not installed on Candidate: that changes legacy arrangement masks. */
  phrasePlan: NonNullable<Candidate["phrasePlan"]>;
}

const STEP = PPQ / 4;
const CELL = BAR * 2;
const bassCells = [
  // The first onset pattern follows the demonstrated 0, 2.5, 3.5-beat example.
  // These gates and the other cells are app choices, not a transcription of TDF.
  { steps: [0, 10, 14], gates: [8, 2, 16] },
  { steps: [0, 10, 17], gates: [8, 3, 12] },
  { steps: [0, 7, 18, 27], gates: [5, 4, 6, 3] },
] as const;
const drumPitches = { kick: 36, clap: 39, hat: 42, open: 46, perc: 37 };

/**
 * Bounded support choices informed by third-party demonstrations, not an artist formula.
 * prod. gas D1g-FYMrEvA: 5:20 two-bar hat grid, 5:34 clap accent, 6:04–6:46 gates/onsets.
 * Busy Works Beats Hp0pMTWCJ8Y: 5:31–6:11 +1-semitone rolls, 6:49 beat-three backbeat anchors.
 * This module cannot infer source accents, downbeats or harmony from an audio filename.
 */
export function loopSupportRhythm(
  options: SupportRhythmOptions,
): SupportRhythm {
  const { seed, candidate, root } = options;
  const density = clamp(options.density ?? 0.5, 0, 1);
  const variation = clamp(options.variation ?? 0.45, 0, 1);
  const random = (role: string) =>
    rng(`${seed}/${LOOP_SUPPORT_RHYTHM}/${candidate}/${role}`);
  const choice = random("cell");
  const bassCell =
    bassCells[
      candidate === 0 ? 0 : 1 + ((Math.floor(choice() * 2) + candidate - 1) % 2)
    ];
  const notes: Record<SupportRole, SupportNote[]> = {
    bass: [],
    kick: [],
    clap: [],
    hat: [],
    open: [],
    perc: [],
  };
  const phrasePlan: SupportRhythm["phrasePlan"] = {
    version: 1,
    grid: "double-time",
    beatsPerBar: 4,
    events: [],
  };
  const add = (role: SupportRole, note: SupportNote) => notes[role].push(note);
  const drum = (
    role: Exclude<SupportRole, "bass">,
    tick: number,
    velocity: number,
    drumPitch?: number,
  ) => {
    add(role, {
      tick,
      pitch: drumPitches[role],
      velocity,
      duration:
        role === "hat"
          ? drumPitch === undefined
            ? 40
            : 28
          : role === "open"
            ? 180
            : 100,
      ...(drumPitch === undefined ? {} : { drumPitch }),
    });
  };
  const bassVelocity = random("bass-velocity");
  for (let cell = 0; cell < 4; cell++) {
    const steps = [...bassCell.steps] as number[];
    const gates = [...bassCell.gates] as number[];
    if (candidate === 1 && cell === 3 && variation >= 0.25) {
      // Eight-bar answer: delay one re-entry, leaving an explicit rest before it.
      steps[steps.length - 1] =
        bassCell === bassCells[0]
          ? pick(choice, [17, 18])
          : pick(choice, [28, 29]);
      gates[gates.length - 1] = Math.min(
        gates[gates.length - 1],
        32 - steps[steps.length - 1] - 2,
      );
    }
    for (let i = 0; i < steps.length; i++) {
      const next = steps[i + 1] ?? 32;
      const gate = Math.min(gates[i], next - steps[i] - 1);
      add("bass", {
        tick: cell * CELL + steps[i] * STEP,
        duration: Math.round(gate * STEP),
        pitch: root + (i === steps.length - 1 && cell % 2 === 1 ? 7 : 0),
        velocity: 0.74 + bassVelocity() * 0.08,
        articulation: "retrigger",
      });
    }
  }
  if (options.lockedBass !== undefined) {
    notes.bass = options.lockedBass.map(({ id: _id, ...note }) => ({
      ...note,
    }));
  }
  notes.bass.sort((a, b) => a.tick - b.tick);

  const hatVelocity = random("hat-velocity");
  const hatBase = Array.from({ length: 16 }, (_, i) => i * 2);
  // A retains the legible two-bar demonstration: extras at beat offsets 1.25 and 3.25.
  const hatSteps =
    density < 0.3
      ? hatBase
      : candidate === 0
        ? [...hatBase, 5, 13]
        : candidate === 1
          ? [...hatBase.filter((step) => step !== 22), 5]
          : [...hatBase.filter((step) => step !== 6), 13];
  const rollStart = pick(random("answer-roll"), [29, 30]);
  const responseStep = pick(random("response"), [11, 27]);
  for (let cell = 0; cell < 4; cell++) {
    const origin = cell * CELL;
    const roll =
      candidate === 0 &&
      ((cell === 3 && variation >= 0.25) || (cell === 1 && variation >= 0.8));
    for (const step of [8, 24]) drum("clap", origin + step * STEP, 0.78);
    // Demonstrated 4-and position; its quieter velocity is an app choice, not measured evidence.
    if (candidate === 0 && density >= 0.3)
      drum("clap", origin + 14 * STEP, 0.46);
    for (const step of hatSteps) {
      if (roll && step >= rollStart && step <= rollStart + 1) continue;
      drum(
        "hat",
        origin + step * STEP,
        (step % 4 === 0 ? 0.56 : 0.44) + hatVelocity() * 0.05,
      );
    }
    if (roll) {
      for (let i = 0; i < 3; i++)
        drum("hat", origin + (rollStart + i * 0.5) * STEP, 0.43 + i * 0.035, 1);
      phrasePlan.events.push({
        role: "hat",
        start: origin + rollStart * STEP,
        end: origin + (rollStart + 1) * STEP + 28,
        kind: "gesture",
        description: "Short phrase-end answer roll, linked pitch +1 semitone.",
      });
    }
    if (density >= 0.3 && (cell % 2 === 1 || density >= 0.8))
      drum("open", origin + 23 * STEP, 0.65);
    if (
      density >= 0.3 &&
      (candidate !== 0 || cell % 2 === 1 || density >= 0.8)
    ) {
      const answer = candidate === 2 && cell === 3 && variation >= 0.25;
      const step = answer ? (responseStep === 11 ? 27 : 11) : responseStep;
      drum(
        "perc",
        origin + step * STEP,
        0.62 + random(`perc-${cell}`)() * 0.05,
      );
      if (answer)
        phrasePlan.events.push({
          role: "perc",
          start: origin + step * STEP,
          end: origin + step * STEP + 100,
          kind: "answer",
          description:
            "Move one sparse response to answer the final two-bar cell.",
        });
    }
  }

  // Select actual bass attacks, including locked edits, instead of an unrelated kick array.
  const kickVelocity = random("kick-velocity");
  for (let cell = 0; cell < 4; cell++) {
    const attacks = [
      ...new Set(
        notes.bass
          .filter((n) => n.tick >= cell * CELL && n.tick < (cell + 1) * CELL)
          .map((n) => n.tick),
      ),
    ];
    if (!attacks.length) continue;
    const selected = new Set([attacks[0], attacks[attacks.length - 1]]);
    if (candidate === 2 && attacks.length > 2) selected.add(attacks[1]);
    for (const tick of selected)
      drum("kick", tick, 0.74 + kickVelocity() * 0.06);
  }
  if (notes.kick.length >= 4 && density >= 0.3) {
    // At most one independent pickup in eight bars, with room around a bass attack.
    const pickups = [31, 30, 29]
      .map((step) => CELL + step * STEP)
      .filter((tick) =>
        notes.bass.every((n) => Math.abs(n.tick - tick) >= STEP),
      );
    if (pickups.length)
      drum("kick", pick(random("kick-pickup"), pickups), 0.61);
  }

  for (const role of SUPPORT_ROLES) notes[role].sort((a, b) => a.tick - b.tick);
  for (const [i, note] of notes.bass.entries()) {
    const end = Math.min(LOOP_TICKS, note.tick + note.duration);
    phrasePlan.events.push({
      role: "bass",
      start: note.tick,
      end,
      kind: "support",
      description: "Gated bass landing; pitch basis remains user-selected.",
    });
    const next = notes.bass[i + 1]?.tick ?? LOOP_TICKS;
    if (end < next)
      phrasePlan.events.push({
        role: "bass",
        start: end,
        end: next,
        kind: "rest",
        description: "Explicit gate gap before the next bass attack.",
      });
  }
  const bassAttacks = new Set(notes.bass.map((n) => n.tick));
  for (const note of notes.kick)
    phrasePlan.events.push({
      role: "kick",
      start: note.tick,
      end: note.tick + note.duration,
      kind: bassAttacks.has(note.tick) ? "support" : "gesture",
      description: bassAttacks.has(note.tick)
        ? "Reinforces an actual bass attack."
        : "Single independent eight-bar pickup.",
    });
  return {
    version: LOOP_SUPPORT_RHYTHM,
    name: ["Two-bar accents", "Rest and re-entry", "Sparse responses"][
      candidate
    ],
    notes,
    phrasePlan,
  };
}
