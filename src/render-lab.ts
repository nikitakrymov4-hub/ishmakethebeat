import { newProject } from "./engine/compose";
import { defaultSettings } from "./engine/profiles";
import { renderWav, portableZip } from "./io/export";
import { exportMidi } from "./io/midi";
import type { Project } from "./engine/schema";
import { calibrationProject, improvedBaseline } from "./engine/calibration";
import { setPrivatePalette } from "./engine/culture";
import { validateProject } from "./io/persistence";
import { verifyAudio } from "./audio/verify";
import { Transport } from "./audio/transport";
import { score, totalTicks } from "./engine/score";
const log = document.querySelector<HTMLPreElement>("#log")!;
export function say(s: string) {
  log.textContent += `\n${s}`;
}
export async function save(name: string, data: Uint8Array | string) {
  const response = await fetch(
    `/__render-output?name=${encodeURIComponent(name)}`,
    {
      method: "POST",
      body: typeof data === "string" ? data : new Uint8Array(data),
    },
  );
  if (!response.ok)
    throw new Error(`Could not save ${name}: ${await response.text()}`);
  say(`Saved ${name}`);
}
export async function audio(name: string, p: Project, tap = "mix") {
  say(`Rendering ${name}…`);
  const r = await renderWav(p, tap);
  await save(name, r.wav);
  say(
    `  ${r.duration.toFixed(2)}s · sample peak ${(20 * Math.log10(r.peak)).toFixed(2)} dBFS · RMS ${(20 * Math.log10(r.rms)).toFixed(2)} dBFS`,
  );
  const a = document.createElement("audio");
  a.controls = true;
  a.src = URL.createObjectURL(
    new Blob([new Uint8Array(r.wav)], { type: "audio/wav" }),
  );
  document.querySelector("#files")!.append(a);
  return {
    name,
    peak: r.peak,
    rms: r.rms,
    frames: r.frames,
    duration: r.duration,
  };
}
const baselineButton = document.querySelector<HTMLButtonElement>("#baseline")!;
baselineButton.disabled = true;
baselineButton.textContent = "Original baseline preserved on disk";
document.querySelector("#checks")!.addEventListener("click", async () => {
  try {
    const result = await verifyAudio(say);
    await save("verification/lifecycle.json", JSON.stringify(result, null, 2));
    say(`AUDIO CHECKS COMPLETE: ${JSON.stringify(result)}`);
  } catch (e) {
    say(`ERROR: ${e}`);
  }
});

const revisionButton = document.querySelector<HTMLButtonElement>("#revision")!;
document.querySelector("#full")!.addEventListener("click", async () => {
  try {
    const p = newProject({ ...defaultSettings("airy"), bpm: 300 });
    p.arrangement = true;
    const t = new Transport();
    t.loop = false;
    let maxTick = 0;
    t.onUpdate = (tick) => {
      maxTick = Math.max(maxTick, tick);
    };
    const started = performance.now();
    await t.play(p);
    say("Full 64-bar transport running at 300 BPM (51.2 seconds of score).");
    await new Promise((r) => setTimeout(r, 55500));
    const diagnostics = t.diagnostics,
      result = {
        diagnostics,
        maxTick,
        expectedTicks: totalTicks(p),
        expectedEvents: score(p).length,
        elapsedMs: performance.now() - started,
      };
    t.dispose();
    if (
      diagnostics.playing ||
      diagnostics.activeVoices !== 0 ||
      diagnostics.scheduledIndex !== score(p).length ||
      maxTick < totalTicks(p) - 480
    )
      throw new Error(
        `Full arrangement timing/lifecycle failed: ${JSON.stringify(result)}`,
      );
    await save(
      "verification/full-transport.json",
      JSON.stringify(result, null, 2),
    );
    say("FULL ARRANGEMENT TRANSPORT COMPLETE");
  } catch (e) {
    say(`ERROR: ${e}`);
  }
});
revisionButton.disabled = false;
revisionButton.addEventListener("click", async () => {
  revisionButton.disabled = true;
  try {
    const assets = await (await fetch("/private-assets/bank.json")).json();
    setPrivatePalette(assets);
    const original = validateProject(
        await (await fetch("/deliverables/baseline/A-project.ish.json")).json(),
      ),
      b = improvedBaseline(original, assets),
      c = calibrationProject(assets),
      report = [];
    await save("comparison/B-project.ish.json", JSON.stringify(b, null, 2));
    await save("comparison/B-score.mid", exportMidi(b));
    report.push(await audio("comparison/B-mix.wav", b));
    await save("comparison/C-project.ish.json", JSON.stringify(c, null, 2));
    await save("comparison/C-score.mid", exportMidi(c));
    report.push(await audio("comparison/C-mix.wav", c));
    for (const [group, roles] of [
      ["melody", ["melody", "pad", "answer"]],
      ["bass", ["bass"]],
      ["drums", ["kick", "clap", "hat", "open", "perc"]],
    ] as const) {
      const p = structuredClone(c);
      for (const t of p.candidates[p.selected].tracks)
        t.solo = (roles as readonly string[]).includes(t.id);
      report.push(await audio(`comparison/C-${group}.wav`, p));
    }
    c.arrangement = true;
    await save("calibration/project.ish.json", JSON.stringify(c, null, 2));
    await save("calibration/project.ish.zip", portableZip(c));
    await save("calibration/score.mid", exportMidi(c));
    report.push(await audio("calibration/mix-headroom.wav", c, "headroom"));
    report.push(await audio("calibration/listening-master.wav", c));
    const stems = [];
    for (const role of [
      ...c.candidates[c.selected].tracks.map((t) => t.id),
      "fx",
    ])
      stems.push(await audio(`calibration/stem-${role}.wav`, c, role));
    await save("calibration/stems.json", JSON.stringify(stems, null, 2));
    for (const [i, seed] of [
      "PAPER-219",
      "GARDEN-083",
      "ORBIT-406",
    ].entries()) {
      const p = newProject({
        ...defaultSettings(),
        seed,
        bpm: [144, 152, 150][i],
        key: [5, 9, 2][i],
        mood: i === 1 ? "warm" : "wistful",
      });
      p.title = `${seed} · generated recipe`;
      p.selected = i;
      p.arrangement = true;
      const form =
          i === 0 ? [2, 8, 4, 2] : i === 1 ? [4, 8, 8, 4] : [4, 8, 8, 8, 4],
        kinds =
          i === 2
            ? ["intro", "hook", "verse", "return", "outro"]
            : ["intro", "hook", "verse", "outro"];
      p.sections = form.map((bars, j) => ({
        id: `seed-${j}`,
        name: kinds[j],
        kind: kinds[j] as Project["sections"][number]["kind"],
        bars,
      }));
      await save(`generated/${seed}.ish.json`, JSON.stringify(p, null, 2));
      await save(`generated/${seed}.mid`, exportMidi(p));
      report.push(await audio(`generated/${seed}.wav`, p));
      if (i === 0) {
        const full = structuredClone(p);
        full.sections = structuredClone(c.sections);
        full.title = `${seed} · full arrangement`;
        await save(
          `generated/${seed}-full.ish.json`,
          JSON.stringify(full, null, 2),
        );
        await save(`generated/${seed}-full.mid`, exportMidi(full));
        report.push(await audio(`generated/${seed}-full.wav`, full));
      }
    }
    await save(
      "verification/render-report.json",
      JSON.stringify({ userAgent: navigator.userAgent, report }, null, 2),
    );
    say("REVISION RENDERS COMPLETE");
  } catch (e) {
    say(`ERROR: ${e}`);
  } finally {
    revisionButton.disabled = false;
  }
});
