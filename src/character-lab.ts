import type { Project } from "./engine/schema";
import { renderWav as renderBaseline } from "./character-baseline/export";
const log = document.querySelector<HTMLPreElement>("#log")!;
export function say(s: string) {
  log.textContent += `\n${s}`;
}
export async function save(name: string, data: Uint8Array | string) {
  const response = await fetch(
    `/__render-output?name=${encodeURIComponent(`character/${name}`)}`,
    {
      method: "POST",
      body: typeof data === "string" ? data : new Uint8Array(data),
    },
  );
  if (!response.ok) throw new Error(`Save ${name}: ${await response.text()}`);
}
export async function accepted(): Promise<Project> {
  return await (
    await fetch("/deliverables/character/baseline/accepted-project.ish.json")
  ).json();
}
function group(p: Project, roles: string[]) {
  const q = structuredClone(p);
  for (const t of q.candidates[q.selected].tracks)
    t.solo = roles.includes(t.id);
  return q;
}
export async function render(
  name: string,
  p: Project,
  tap = "mix",
  old = false,
) {
  say(`Rendering ${name}…`);
  const fn = old ? renderBaseline : (await import("./io/export")).renderWav;
  const r = await fn(p, tap);
  await save(name, r.wav);
  say(
    `${name} · ${r.duration.toFixed(2)}s · peak ${(20 * Math.log10(r.peak)).toFixed(2)} dBFS`,
  );
  return {
    name,
    frames: r.frames,
    duration: r.duration,
    peak: r.peak,
    rms: r.rms,
  };
}
function task(id: string, fn: () => Promise<void>) {
  const button = document.querySelector<HTMLButtonElement>(`#${id}`)!;
  button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      await fn();
      say(`${id.toUpperCase()} COMPLETE`);
    } catch (e) {
      say(`ERROR: ${e instanceof Error ? e.stack : e}`);
    } finally {
      button.disabled = false;
    }
  });
}
task("baseline", async () => {
  const p = await accepted();
  p.arrangement = false;
  const report = [];
  report.push(await render("baseline/full.wav", p, "mix", true));
  for (const [name, roles] of [
    ["melody", ["melody", "pad", "answer"]],
    ["bass", ["bass"]],
    ["drums", ["kick", "clap", "hat", "open", "perc"]],
  ] as const)
    report.push(
      await render(`baseline/${name}.wav`, group(p, [...roles]), "mix", true),
    );
  await save("baseline/render-report.json", JSON.stringify(report, null, 2));
});
task("phrase", async () =>
  (await import("./character-renders")).renderPhrase(),
);
task("original", async () =>
  (await import("./character-renders")).renderOriginal(),
);
task("loop", async () => (await import("./character-renders")).renderLoop());
task("seeds", async () => (await import("./character-renders")).renderSeeds());
task("checks", async () => (await import("./character-renders")).runChecks());
