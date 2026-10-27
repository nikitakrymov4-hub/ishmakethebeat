import { newProject, assess } from "./compose";
import { defaultSettings } from "./profiles";
import { BAR, SCALES } from "./schema";
import type { Project, SampleAsset } from "./schema";
import { setPrivatePalette } from "./culture";
import { upgradeEnsemble } from "./ensemble";
export { upgradeEnsemble } from "./ensemble";
export function improvedBaseline(
  original: Project,
  assets: SampleAsset[],
): Project {
  const p = upgradeEnsemble(original, assets);
  p.title = "B · Accepted melody / coordinated ensemble";
  return p;
}
export function calibrationProject(assets: SampleAsset[]): Project {
  setPrivatePalette(assets);
  const p = newProject({
    ...defaultSettings(),
    seed: "LANTERN-CALIBRATION",
    bpm: 150,
    grid: "double-time",
    complexity: 2,
  });
  p.title = "Paper lantern · calibration";
  p.selected = p.candidates.findIndex((c) => c.recipe?.id === "paper-lantern");
  const c = p.candidates[p.selected],
    scale = SCALES.minor,
    base = 66,
    rhythm = [0, 360, 720, 1320, 2160, 2520, 3000],
    degrees = [4, 2, 0, 1, 4, 3, 2];
  const lead = c.tracks.find((t) => t.id === "melody")!;
  lead.notes = [];
  for (let phrase = 0; phrase < 4; phrase++)
    for (let j = 0; j < rhythm.length; j++) {
      const degree = phrase === 3 && j === 6 ? 0 : degrees[j];
      let pitch = base + scale[degree];
      if (phrase === 2 && j === 0) pitch = 69;
      if (phrase === 3 && j === 0) pitch = 71;
      lead.notes.push({
        id: `authored-motif-${phrase}-${j}`,
        tick: phrase * BAR * 2 + rhythm[j],
        duration: [420, 180, 300, 240, 300, 180, 300][j],
        pitch,
        velocity: [0.82, 0.68, 0.72, 0.62, 0.77, 0.64, 0.7][j],
      });
    }
  // The answer only occupies the last gap of the second and fourth two-bar cells.
  const answer = c.tracks.find((t) => t.id === "answer")!;
  answer.notes = [
    {
      id: "authored-answer-a",
      tick: BAR * 4 - 360,
      duration: 180,
      pitch: 78,
      velocity: 0.45,
    },
    {
      id: "authored-answer-b",
      tick: BAR * 8 - 360,
      duration: 180,
      pitch: 78,
      velocity: 0.4,
    },
  ];
  c.metrics = assess(c);
  p.settings.listeningGainDb = 0;
  p.recipe = c.recipe;
  p.created = "2026-10-15T00:00:00.000Z";
  const upgraded = upgradeEnsemble(p, assets);
  upgraded.title = "Woven glass · original 150 double-time calibration";
  upgraded.candidates[upgraded.selected].metrics = assess(
    upgraded.candidates[upgraded.selected],
  );
  return upgraded;
}
