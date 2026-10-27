import { accepted, render, save, say } from "./character-lab";
import { clone } from "./engine/schema";
import type { Project, SampleAsset, Role } from "./engine/schema";
import { upgradeEnsemble } from "./engine/ensemble";
import { setPrivatePalette } from "./engine/culture";
import { newProject, assess } from "./engine/compose";
import { defaultSettings } from "./engine/profiles";
import { loopProject } from "./engine/loop";
import { portableZip } from "./io/export";
import { exportMidi } from "./io/midi";
import { createReversePickup } from "./io/resample";
import { validateProject } from "./io/persistence";
import { verifyAudio, verifyCharacter } from "./audio/verify";

async function json<T>(path: string): Promise<T> {
  const r = await fetch(path);
  if (!r.ok) throw new Error(`Missing ${path}`);
  return r.json();
}
async function palette() {
  const banks = await Promise.all(
    ["bank.json", "new-palette.json"].map((name) =>
      json<SampleAsset[]>(`/private-assets/${name}`),
    ),
  );
  const assets = [...new Map(banks.flat().map((a) => [a.id, a])).values()];
  setPrivatePalette(assets);
  return assets;
}
function restrict(p: Project, roles: string[], keepClips = false) {
  const q = clone(p);
  for (const t of q.candidates[q.selected].tracks)
    t.mute = !roles.includes(t.id);
  if (!keepClips) q.clips = [];
  q.tagEnabled = false;
  return q;
}
const upper: Role[] = ["melody", "pad", "answer", "keys", "bridge", "pedal"];
const drums: Role[] = ["kick", "clap", "hat", "open", "perc"];
function dry(p: Project) {
  const q = clone(p);
  q.settings.space = 0;
  for (const t of q.candidates[q.selected].tracks) delete t.effects;
  for (const c of q.clips ?? []) delete c.effects;
  return q;
}
async function upgraded(withReverse = true) {
  const assets = await palette(),
    source = await accepted();
  // The brief explicitly requests a new foreground timbre around the accepted
  // notes. Retain the saved lock after this controlled comparison, while the
  // ordinary generator and UI upgrade continue to respect existing locks.
  const melodyLocks = source.candidates.map(
    (c) => c.tracks.find((t) => t.id === "melody")!.locked,
  );
  for (const c of source.candidates)
    c.tracks.find((t) => t.id === "melody")!.locked = false;
  const p = upgradeEnsemble(source, [
    ...new Map([...source.assets, ...assets].map((a) => [a.id, a])).values(),
  ]);
  p.sourceKind = "original-score";
  p.arrangement = false;
  p.tagEnabled = false;
  for (const [i, c] of p.candidates.entries())
    c.tracks.find((t) => t.id === "melody")!.locked = melodyLocks[i];
  for (const c of p.candidates) c.metrics = assess(c);
  if (withReverse) {
    const pickup = await createReversePickup(p, "melody");
    p.assets.push(pickup.asset);
    p.clips = [pickup.clip];
  }
  return p;
}
async function project(name: string, p: Project) {
  validateProject(p);
  await save(`${name}.ish.json`, JSON.stringify(p));
  await save(`${name}.ish.zip`, portableZip(p));
  await save(`${name}.mid`, exportMidi(p));
}
export async function renderPhrase() {
  const p = await upgraded(),
    report = [];
  const base = await accepted();
  const originalNotes = base.candidates[base.selected].tracks.find(
    (t) => t.id === "melody",
  )!.notes;
  if (
    JSON.stringify(originalNotes) !==
    JSON.stringify(
      p.candidates[p.selected].tracks.find((t) => t.id === "melody")!.notes,
    )
  )
    throw new Error("Accepted melody changed");
  await project("comparison/ensemble-project", p);
  report.push(await render("comparison/ensemble-only.wav", restrict(p, upper)));
  report.push(
    await render(
      "comparison/ensemble-drums.wav",
      restrict(p, [...upper, ...drums]),
    ),
  );
  const without = clone(p);
  without.clips = [];
  report.push(await render("comparison/full-without-reverse.wav", without));
  report.push(await render("comparison/full.wav", p));
  report.push(
    await render("comparison/lead-dry.wav", dry(restrict(p, ["melody"]))),
  );
  report.push(
    await render("comparison/lead-treated.wav", restrict(p, ["melody"])),
  );
  report.push(
    await render("comparison/hat-dry.wav", dry(restrict(p, ["hat"]))),
  );
  const hatEcho = restrict(p, ["hat"]);
  hatEcho.candidates[hatEcho.selected].tracks.find(
    (t) => t.id === "hat",
  )!.effects = {
    hat: {
      mix: 0.23,
      echoBeats: 0.25,
      feedback: 0.17,
      chorus: 0.2,
      crush: 0,
      room: 0.06,
    },
  };
  report.push(await render("comparison/hat-echo-motion.wav", hatEcho));
  const hatGrain = restrict(p, ["hat"]);
  hatGrain.candidates[hatGrain.selected].tracks.find(
    (t) => t.id === "hat",
  )!.effects = {
    hat: {
      mix: 0.18,
      echoBeats: 0.125,
      feedback: 0.12,
      chorus: 0.46,
      crush: 0.22,
      room: 0.05,
    },
  };
  report.push(await render("comparison/hat-grain-phase.wav", hatGrain));
  const manifest = await json<{
    groups: { id: string; assets: Record<string, string> }[];
  }>("/private-assets/new-palette-manifest.json");
  for (const group of manifest.groups) {
    const q = clone(without);
    for (const role of ["bass", "clap", "hat"] as const)
      q.candidates[q.selected].tracks.find((t) => t.id === role)!.instrument =
        group.assets[role];
    await save(`comparison/palette-${group.id}.ish.json`, JSON.stringify(q));
    report.push(await render(`comparison/palette-${group.id}.wav`, q));
  }
  await save(
    "verification/phrase-render-report.json",
    JSON.stringify(
      {
        acceptedMelodyIdentical: true,
        baselineSeed: base.settings.seed,
        selectedPalette:
          "north-round · provisional candidate, not subjective winner",
        report,
      },
      null,
      2,
    ),
  );
}
async function full(p: Project, folder: "original" | "loop") {
  p.arrangement = true;
  if (folder === "original") p.settings.listeningGainDb = 4;
  await project(`${folder}/project`, p);
  const stable = clone(p);
  stable.created = "";
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(stable)),
  );
  const sourceHash = Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
  let progress: {
    sourceHash: string;
    report: Awaited<ReturnType<typeof render>>[];
  } = { sourceHash, report: [] };
  try {
    const previous = await json<typeof progress>(
      `/deliverables/character/verification/render-progress-${folder}.json`,
    );
    if (previous.sourceHash === sourceHash) progress = previous;
  } catch {
    /* first render */
  }
  const renderPart = async (name: string, tap = "mix") => {
    if (progress.report.some((r) => r.name === name)) {
      say(`Retained completed ${name}`);
      return;
    }
    progress.report.push(await render(name, p, tap));
    await save(
      `verification/render-progress-${folder}.json`,
      JSON.stringify(progress),
    );
  };
  await renderPart(`${folder}/full.wav`);
  await renderPart(`${folder}/headroom.wav`, "headroom");
  const roles = [
    ...p.candidates[p.selected].tracks.map((t) => t.id),
    ...new Set((p.clips ?? []).map((c) => c.role)),
    ...(p.tagEnabled ? ["tag"] : []),
    "fx",
  ];
  for (const role of roles)
    await renderPart(`${folder}/stem-${role}.wav`, role);
  await save(
    `${folder}/render-report.json`,
    JSON.stringify(progress.report, null, 2),
  );
}
export async function renderOriginal() {
  let p: Project;
  try {
    p = await json<Project>(
      "/deliverables/character/comparison/ensemble-project.ish.json",
    );
  } catch {
    p = await upgraded();
  }
  p.title = "Woven glass · accepted melody, original instrumental";
  p.sections = [
    { id: "opening", name: "Keys & foreground", kind: "intro", bars: 4 },
    { id: "main", name: "Full ensemble", kind: "hook", bars: 16 },
    { id: "develop", name: "Connecting voice", kind: "verse", bars: 16 },
    { id: "space", name: "Held color & room", kind: "break", bars: 8 },
    { id: "return", name: "Motif returns", kind: "return", bars: 16 },
    { id: "ending", name: "Resolution", kind: "outro", bars: 4 },
  ];
  await full(p, "original");
}
export async function renderLoop() {
  const assets = await palette(),
    bank = await json<SampleAsset[]>("/private-assets/loop10-bank.json");
  const all = [...assets, ...bank],
    p = loopProject(
      all,
      bank.find((a) => a.role === "loop")!,
      bank.find((a) => a.role === "tag"),
    );
  const excerpt = clone(p);
  excerpt.arrangement = false;
  const report = [];
  const loopOnly = restrict(excerpt, [], true);
  loopOnly.tagEnabled = true;
  report.push(await render("loop/loop-only.wav", loopOnly));
  const withDrums = restrict(excerpt, drums, true);
  withDrums.tagEnabled = true;
  report.push(await render("loop/loop-drums.wav", withDrums));
  report.push(await render("loop/full-excerpt.wav", excerpt));
  await save("loop/excerpt-report.json", JSON.stringify(report, null, 2));
  await full(p, "loop");
}
export async function renderSeeds() {
  await palette();
  const report = [];
  for (const [i, seed] of ["WOVEN-127", "VELVET-304", "COPPER-892"].entries()) {
    const p = newProject({
      ...defaultSettings(),
      seed,
      bpm: [150, 146, 154][i],
      key: [2, 8, 4][i],
      mood: i === 1 ? "warm" : "wistful",
      ensembleMode: "conversation",
      grid: "double-time",
    });
    p.selected = i;
    p.sourceKind = "original-score";
    p.title = `${seed} · original generated ensemble`;
    p.arrangement = true;
    p.sections = [
      { id: "intro", name: "Opening", kind: "intro", bars: 4 },
      { id: "main", name: "Main phrase", kind: "hook", bars: 8 + i * 8 },
      { id: "outro", name: "Return & tail", kind: "outro", bars: 4 },
    ];
    await project(`generated/${seed}`, p);
    report.push(await render(`generated/${seed}.wav`, p));
  }
  const source = await json<{
    notes: Project["candidates"][number]["tracks"][number]["notes"];
    hash: string;
    originalFilename: string;
  }>("/private-assets/supplied-phrase.json");
  const guides = await json<
    { guide: { pitches: number[] }; hash: string; originalFilename: string }[]
  >("/private-assets/scale-guides.json");
  const q = newProject({
    ...defaultSettings(),
    seed: "SUPPLIED-MIDI",
    bpm: 147,
    key: 9,
    mode: "major",
  });
  q.sourceKind = "supplied-midi";
  q.title = "Supplied Cool Piano Thing · original MIDI import";
  for (const c of q.candidates) {
    for (const t of c.tracks) t.notes = [];
    const keys = c.tracks.find((t) => t.id === "keys")!;
    keys.notes = clone(source.notes);
    keys.instrument = "rounded-keys";
    keys.volume = 0.55;
  }
  q.scaleGuides = [
    {
      name: guides[0].originalFilename,
      pitches: guides[0].guide.pitches,
      sourceHash: guides[0].hash,
      enabled: false,
    },
  ];
  await project("generated/supplied-midi-and-silent-guide", q);
  report.push(await render("generated/supplied-midi.wav", q));
  await save(
    "verification/generated-report.json",
    JSON.stringify(
      {
        report,
        suppliedMidiHash: source.hash,
        silentGuide: guides[0].originalFilename,
      },
      null,
      2,
    ),
  );
}
export async function runChecks() {
  const character = await verifyCharacter(say);
  await save(
    "verification/character-audio.json",
    JSON.stringify(character, null, 2),
  );
  const lifecycle = await verifyAudio(say);
  await save("verification/lifecycle.json", JSON.stringify(lifecycle, null, 2));
  say(
    "New instrument, source-root, one-shot, legato, FX timing and lifecycle checks passed.",
  );
}
