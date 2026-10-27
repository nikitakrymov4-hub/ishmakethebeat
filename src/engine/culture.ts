import type {
  Candidate,
  Chord,
  Note,
  RecipeState,
  Role,
  SampleAsset,
  Settings,
  Track,
} from "./schema";
import { BAR, LOOP_TICKS, ROLES, SCALES, clone, isDrum } from "./schema";
import { PROFILES, GROOVES } from "./profiles";
import { rng, clamp } from "./random";
import { coordinateEnsemble } from "./ensemble";
export { RECIPES } from "./culture-plan";
import { RECIPES, cultureWritingPlan } from "./culture-plan";
let privatePalette: SampleAsset[] = [];
export const setPrivatePalette = (assets: SampleAsset[]) => {
  privatePalette = assets;
};
export const getPrivatePalette = () => clone(privatePalette);
function pitch(s: Settings, d: number, base = 60) {
  const a = SCALES[s.mode];
  return (
    base +
    s.key +
    a[((d % a.length) + a.length) % a.length] +
    12 * Math.floor(d / a.length)
  );
}
export function cultureCandidate(
  s: Settings,
  index: number,
  previous?: Candidate,
  only?: Role[],
  variation = false,
): Candidate {
  const seed = `ish-2.0.0/${s.seed}/culture/${index}`,
    plan = cultureWritingPlan(s, index),
    family = plan.family,
    recipe = RECIPES[family],
    harmonicDegrees = plan.harmonicDegrees;
  const retain =
    previous &&
    (only || previous.tracks.some((t) => t.locked && !isDrum(t.id)));
  const harmony: Chord[] = retain
    ? clone(previous.harmony)
    : harmonicDegrees.map((d, i) => {
        let root = pitch(s, d, 24);
        while (root < 28) root += 12;
        while (root > 43) root -= 12;
        const pitches = [0, 2, 4].map((n) => pitch(s, d + n, 48));
        if (i === 2) {
          pitches[0] += 12;
          pitches.sort((a, b) => a - b);
        }
        return { tick: i * BAR * 2, duration: BAR * 2, root, pitches };
      });
  const at = (tick: number) =>
    harmony.find((h) => tick >= h.tick && tick < h.tick + h.duration) ??
    harmony[0];
  const groove = GROOVES.culture[plan.grooveIndex];
  const names = [
    "Main melody",
    "Chord rhythm",
    "Answer",
    "808 bass",
    "Kick",
    "Clap / snare",
    "Closed hat",
    "Open hat",
    "Percussion",
  ];
  const instruments = [
    recipe.lead,
    "culture-support",
    recipe.answer,
    "textured-808",
    "felt-kick",
    "dry-clap",
    "short-hat",
    "air-hat",
    "wood",
  ];
  const chooseSample = (name: string, fallback: string) =>
    privatePalette.find((a) => a.name === name)?.id ?? fallback;
  instruments[3] = chooseSample(recipe.bass, "textured-808");
  instruments[5] = chooseSample(recipe.clap, "dry-clap");
  instruments[6] = chooseSample(recipe.hat, "short-hat");
  const state: RecipeState = {
    id: recipe.id,
    family: recipe.name,
    motifRhythm: [...plan.motifRhythm],
    contour: [...plan.contour],
    chordRhythm: recipe.chords.map((x) => ({ ...x })),
    voicings: harmony.map((h) => h.pitches),
    leadTreatment: {
      cutoff: 5100,
      vibrato: family === 1 ? 4 : 2,
      delay: 0.14,
      width: 0.18,
    },
    bassArticulation:
      recipe.bassGate > 0.8
        ? "long landing / short pickup"
        : "gated landing / octave slide",
    arrangementEnergy: s.variation,
    composition: { ...plan, harmonyRetained: !!retain },
    ...(previous && only
      ? {
          performance: clone(
            previous.recipe?.performance ?? {
              developed:
                previous.recipe?.composition?.version === "culture-plan-2",
              planned: !!previous.phrasePlan,
            },
          ),
        }
      : {}),
  };
  const tracks = ROLES.map((role, i): Track => {
    const old = previous?.tracks.find((t) => t.id === role);
    if (old && (old.locked || (only && !only.includes(role))))
      return clone(old);
    const revision = variation ? (old?.revision ?? 0) + 1 : 0,
      prng = rng(`${seed}/${role}/${revision}`),
      notes: Note[] = [];
    const add = (
      tick: number,
      p: number,
      duration: number,
      velocity: number,
      glide?: Note["glide"],
    ) => {
      notes.push({
        id: `${role}-${revision}-${notes.length}`,
        tick: Math.round(tick),
        duration: Math.max(
          15,
          Math.min(Math.round(duration), LOOP_TICKS - Math.round(tick)),
        ),
        pitch: p,
        velocity: clamp(velocity, 0.05, 1),
        ...(role === "bass"
          ? {
              articulation: glide
                ? ("legato" as const)
                : ("retrigger" as const),
            }
          : {}),
        ...(glide ? { glide } : {}),
      });
    };
    if (role === "melody") {
      // Identity PRNG does not depend on track revision. Variations change the turn, not the whole tune.
      const degreeOffset = plan.degreeOffset,
        contour = [...plan.contour];
      if (s.contour === "rising") contour.sort((a, b) => a - b);
      if (s.contour === "falling") contour.sort((a, b) => b - a);
      for (let phrase = 0; phrase < 4; phrase++)
        for (let n = 0; n < plan.motifRhythm.length; n++) {
          if (n === 3 && s.noteDensity < 0.36) continue;
          // B reserves a breath; A returns with its hook intact.
          if (phrase === 2 && n === 3) continue;
          const shifted = (plan.motifRhythm[n] + s.rhythm * 120) % (BAR * 2),
            tick = phrase * BAR * 2 + shifted;
          let degree = contour[n] + degreeOffset;
          // A-prime turns only its tail; B sequences a response, not a new tune.
          if (phrase === 1 && n >= 4) degree += revision % 2 ? -1 : 1;
          if (phrase === 2 && n >= 2) degree += family === 2 ? -2 : 2;
          if (phrase === 3 && n === plan.motifRhythm.length - 1)
            degree = contour[0] + degreeOffset;
          let p = pitch(s, degree, 60) + s.octave * 12;
          if (
            (phrase === 2 && (n === 0 || n === 4)) ||
            (phrase === 3 && n === plan.motifRhythm.length - 1)
          ) {
            const targets = at(tick).pitches.map((x) => x + 12);
            p =
              targets.reduce((a, b) =>
                Math.abs(b - p) < Math.abs(a - p) ? b : a,
              ) +
              s.octave * 12;
          }
          const next = plan.motifRhythm[n + 1] ?? BAR * 2,
            duration = Math.max(
              120,
              Math.min(
                next - plan.motifRhythm[n] - 60,
                n === 0 ? 420 : n % 3 === 1 ? 180 : 300,
              ),
            );
          add(
            tick,
            p,
            phrase === 3 && n >= 4 ? Math.min(duration, 180) : duration,
            0.68 + (n === 0 ? 0.13 : 0) + (n % 3) * 0.015,
          );
          if (s.noteDensity > 0.75 && n === 2 && phrase % 2 === 1)
            add(tick + 180, pitch(s, degree + 1, 60) + s.octave * 12, 90, 0.43);
        }
    } else if (role === "pad")
      for (let phrase = 0; phrase < 4; phrase++)
        for (const onset of recipe.chords) {
          const tick = phrase * BAR * 2 + onset.tick,
            c = at(tick);
          if (phrase === 3 && onset.tick > 2400) continue;
          for (const p of c.pitches) add(tick, p, onset.duration, 0.46);
        }
    else if (role === "answer")
      for (const phrase of [1, 3]) {
        const tick = phrase * BAR * 2 + 3480;
        add(tick, pitch(s, phrase === 3 ? 0 : 4, 72), 180, 0.45);
        if (phrase === 1 && s.variation > 0.55)
          add(tick - 240, pitch(s, 3, 72), 120, 0.33);
      }
    else if (role === "bass")
      for (let phrase = 0; phrase < 4; phrase++)
        for (let j = 0; j < groove.bass.length; j++) {
          const step = groove.bass[j] + (revision % 2 && j === 1 ? 1 : 0),
            tick = phrase * BAR * 2 + step * 120,
            c = at(tick);
          let p = c.root;
          const gap = ((groove.bass[j + 1] ?? 32) - step) * 120,
            pickup = j === 2 || j === groove.bass.length - 1,
            held = Math.round(
              Math.min(
                gap - 35,
                gap *
                  (pickup ? 0.46 : recipe.bassGate * 0.65 + s.sustain * 0.35),
              ),
            );
          const slide =
            j === groove.bass.length - 2 &&
            phrase === 3 &&
            s.variation > 0.35 &&
            held > 160
              ? { to: p + 12, at: Math.round(held * 0.52), ms: 85 }
              : undefined;
          if (j === groove.bass.length - 1 && phrase % 2 === 1 && p + 12 <= 43)
            p += 12;
          add(tick, p, held, 0.78 + (j === 0 ? 0.08 : 0), slide);
        }
    else if (isDrum(role)) {
      const map: Record<string, number> = {
        kick: 36,
        clap: 39,
        hat: 42,
        open: 46,
        perc: 37,
      };
      for (let phrase = 0; phrase < 4; phrase++)
        for (const step of groove[role as "hat"]) {
          if (
            role !== "clap" &&
            role !== "hat" &&
            step !== 0 &&
            prng() > 0.55 + s.density * 0.5
          )
            continue;
          if (role === "hat" && revision % 2 && phrase % 2 === 1 && step === 14)
            continue;
          if (
            role === "hat" &&
            s.density < 0.3 &&
            step % 4 !== 0 &&
            step % 8 !== 6
          )
            continue;
          const swing =
            role === "hat" && Math.floor(step / 2) % 2 === 1
              ? Math.round((s.swing - 0.5) * 480)
              : 0;
          add(
            phrase * BAR * 2 + step * 120 + swing,
            map[role],
            role === "open" ? 160 : role === "hat" ? 32 : 100,
            role === "hat" ? 0.64 : role === "clap" ? 0.79 : 0.72,
          );
        }
      if (role === "hat" && s.rolls > 0.25)
        for (const bar of [3, 7])
          for (let j = 0; j < (s.rolls > 0.65 ? 4 : 3); j++)
            add(bar * BAR + 1320 + j * 60, 42, 25, 0.54 + j * 0.035);
    }
    notes.sort((a, b) => a.tick - b.tick);
    if (role === "bass" || isDrum(role)) {
      for (let j = notes.length - 1; j > 0; j--)
        if (notes[j].tick === notes[j - 1].tick) notes.splice(j, 1);
      notes.forEach(
        (n, j) =>
          (n.duration = Math.min(
            n.duration,
            (notes[j + 1]?.tick ?? LOOP_TICKS) - n.tick,
          )),
      );
    }
    return {
      id: role,
      name: old?.name ?? names[i],
      instrument: old?.instrument ?? instruments[i],
      notes,
      volume: old?.volume ?? PROFILES.culture.mix[i],
      pan: old?.pan ?? (role === "pad" ? -0.16 : role === "answer" ? 0.22 : 0),
      mute: old?.mute ?? false,
      solo: old?.solo ?? false,
      locked: false,
      revision,
    };
  });
  return coordinateEnsemble(
    {
      id: `idea-${index}`,
      name: recipe.name,
      character: recipe.character,
      tracks,
      harmony,
      metrics: null!,
      groove: groove.name,
      recipe: state,
    },
    s,
    privatePalette,
    plan.paletteChoice,
    {
      previous,
      roles: only,
      variation,
      writingPlan: plan,
      selectFamily:
        !!s.cultureFamily &&
        s.cultureFamily !== "auto" &&
        previous?.recipe?.composition?.family !== plan.family,
    },
  );
}
