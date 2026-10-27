/// <reference types="vite/client" />
import { BAR, clone, seconds } from "./engine/schema";
import type { Project } from "./engine/schema";
import { score, totalTicks } from "./engine/score";
import { renderWav, TAIL_SECONDS } from "./io/export";
import { encodeWav } from "./io/wav";
import { validateProject } from "./io/persistence";

// Only this explicit development HTML entry imports these source snapshots.
const engineSources = import.meta.glob<string>(
  ["./audio/*.ts", "./engine/*.ts", "./io/*.ts"],
  { query: "?raw", import: "default", eager: true },
);
const sourceUrl = "/deliverables/character/original/project.ish.json";
const outputPrefix = "audio-research/current";
const log = document.querySelector<HTMLPreElement>("#log")!;
const button = document.querySelector<HTMLButtonElement>("#run")!;
const say = (message: string) => {
  log.textContent += `\n${message}`;
};
async function sha256(data: string | Uint8Array) {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data);
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    (b) => b.toString(16).padStart(2, "0")).join("");
}
async function save(name: string, data: string | Uint8Array) {
  const response = await fetch(`/__render-output?name=${encodeURIComponent(`${outputPrefix}/${name}`)}`, {
    method: "POST",
    body: typeof data === "string" ? data : new Uint8Array(data),
  });
  if (!response.ok) throw new Error(`Saving ${name}: ${await response.text()}`);
}
function decode24(wav: Uint8Array): Float32Array[] {
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  const tag = (at: number) => String.fromCharCode(...wav.slice(at, at + 4));
  let data = 0, length = 0;
  for (let at = 12; at + 8 <= wav.length;) {
    const size = view.getUint32(at + 4, true);
    if (tag(at) === "fmt " && (
      view.getUint16(at + 8, true) !== 1 || view.getUint16(at + 10, true) !== 2 ||
      view.getUint32(at + 12, true) !== 44100 || view.getUint16(at + 22, true) !== 24
    )) throw new Error("Diagnostic expected 44.1 kHz stereo 24-bit PCM");
    if (tag(at) === "data") { data = at + 8; length = size; break; }
    at += 8 + size + (size % 2);
  }
  if (!data || length % 6 || data + length > wav.length) throw new Error("Invalid diagnostic WAV");
  const channels = [new Float32Array(length / 6), new Float32Array(length / 6)];
  for (let i = 0, at = data; i < length / 6; i++) for (let ch = 0; ch < 2; ch++, at += 3) {
    let n = wav[at] | (wav[at + 1] << 8) | (wav[at + 2] << 16);
    if (n & 0x800000) n -= 0x1000000;
    channels[ch][i] = n / 8388608;
  }
  return channels;
}
function groupProject(p: Project, roles: string[]) {
  const q = clone(p);
  for (const t of q.candidates[q.selected].tracks) {
    t.mute = t.mute || !roles.includes(t.id);
    // Source is fully unmuted and not soloed; fail rather than silently
    // repurposing a different audition if the source changes in the future.
    t.solo = false;
  }
  q.clips = (q.clips ?? []).filter((clip) => roles.includes(clip.role));
  q.tagEnabled = q.tagEnabled && roles.includes("tag");
  return q;
}
interface OutputRecord {
  name: string;
  sha256: string;
  frames: number;
  duration: number;
  samplePeak: number;
  rms: number;
  tap: string;
  roles?: string[];
}

button.addEventListener("click", async () => {
  button.disabled = true;
  document.querySelector("#result")!.replaceChildren();
  log.textContent = "Loading the saved project…";
  try {
    const response = await fetch(sourceUrl, { cache: "no-store" });
    if (!response.ok) throw new Error(`Source project HTTP ${response.status}`);
    const sourceText = await response.text(), source = JSON.parse(sourceText) as Project;
    validateProject(source);
    const selected = source.candidates[source.selected];
    if (selected.tracks.some((t) => t.solo || t.mute))
      throw new Error("Source audition changed: diagnostic expects the saved complete, unmuted ensemble.");
    const sectionIndex = source.sections.findIndex((s) => s.id === "main" && s.kind === "hook" && s.bars === 16);
    if (sectionIndex < 0) throw new Error("The expected saved 16-bar main section is missing");
    const precedingBars = source.sections.slice(0, sectionIndex).reduce((n, s) => n + s.bars, 0);
    const p = clone(source);
    p.arrangement = true;
    p.sections = [clone(source.sections[sectionIndex])];
    validateProject(p);
    if (JSON.stringify(p.candidates) !== JSON.stringify(source.candidates) ||
        JSON.stringify(p.assets) !== JSON.stringify(source.assets) ||
        JSON.stringify(p.clips) !== JSON.stringify(source.clips))
      throw new Error("Diagnostic unexpectedly changed notes, source assets or clip recipes");
    const derivedText = JSON.stringify(p, null, 2);
    await save("project.ish.json", derivedText);
    const engineFiles = await Promise.all(Object.entries(engineSources).sort(([a], [b]) => a.localeCompare(b))
      .map(async ([path, content]) => ({ path: `src/${path.slice(2)}`, sha256: await sha256(content) })));
    const outputs: OutputRecord[] = [];
    const groups = [
      { name: "melody", roles: ["melody", "pad", "answer", "keys", "bridge", "pedal", "resample"] },
      { name: "bass", roles: ["bass"] },
      { name: "drums", roles: ["kick", "clap", "hat", "open", "perc"] },
    ];
    const activeRoles = new Set<string>(score(p).map((e) => e.role));
    const report = {
      schemaVersion: 1, status: "rendering", startedAt: new Date().toISOString(), completedAt: null as string | null,
      source: { url: sourceUrl, sha256: await sha256(sourceText), seed: p.settings.seed,
        selectedCandidate: p.selected, title: p.title },
      engine: { sourceFiles: engineFiles, snapshotSha256: await sha256(JSON.stringify(engineFiles)),
        snapshotScope: "All src/audio, src/engine and src/io TypeScript sources loaded by this local development entry.",
        userAgent: navigator.userAgent, rendering: "Actual current renderWav / AudioGraph / OfflineAudioContext" },
      project: { path: `${outputPrefix}/project.ish.json`, sha256: await sha256(derivedText),
        changedFields: ["sections"], candidatesAssetsSettingsClipsUnchanged: true },
      section: { originalId: p.sections[0].id, bars: p.sections[0].bars, bpm: p.settings.bpm,
        sourceBarsInclusive: [precedingBars + 1, precedingBars + 16],
        sourceStartTicks: precedingBars * BAR, sourceStartSeconds: seconds(precedingBars * BAR, p.settings.bpm),
        newStartTicks: 0, musicDurationSeconds: seconds(totalTicks(p), p.settings.bpm),
        tailSeconds: TAIL_SECONDS,
        contextDifference: "The original section is moved from after its four-bar intro to time zero, retaining section-relative note/clip phase and original section ID. The fresh render starts with empty FX and voice state; the old full-arrangement crop contains preceding intro release/FX tails. No added fade or resynthesis recipe is applied." },
      stemSemantics: { dry: "Actual per-role renderWav taps summed linearly. Post instrument/filter/insert/fader, before 0.73 master gain and master protection. Separate per-role dry files are retained.",
        groupFx: "Actual fx tap with other tracks muted and unrelated clips excluded. Wet returns only, before master gain/protection.",
        sharedFx: "Actual fx tap for the complete unchanged diagnostic project.",
        full: "Actual mix tap, including saved listening gain and master protection.",
        headroom: "Actual headroom tap, 0.73 master gain without listening gain or protection." },
      tagVox: { enabled: p.tagEnabled, available: activeRoles.has("tag"),
        note: "The saved original has no enabled tag or sampled vox. No silent or invented tag stem is created." },
      outputs,
      audioUnderstandingStatus: "not_submitted_by_this_render_lab",
    };
    const checkpoint = () => save("render-report.json", JSON.stringify(report, null, 2));
    await checkpoint();
    async function renderPart(name: string, q: Project, tap: string, roles?: string[]) {
      say(`Rendering ${name}…`);
      const r = await renderWav(q, tap);
      await save(name, r.wav);
      outputs.push({ name, sha256: await sha256(r.wav), frames: r.frames, duration: r.duration,
        samplePeak: r.peak, rms: r.rms, tap, roles });
      await checkpoint();
      say(`Saved ${name} · ${r.duration.toFixed(3)} s`);
      return r.wav;
    }
    await renderPart("full.wav", p, "mix");
    await renderPart("headroom.wav", p, "headroom");
    for (const group of groups) {
      let sum: Float32Array[] | undefined;
      const roles = group.roles.filter((role) => activeRoles.has(role));
      for (const role of roles) {
        const audio = decode24(await renderPart(`role-${role}-dry.wav`, p, role, [role]));
        if (!sum) sum = audio;
        else for (let ch = 0; ch < 2; ch++) for (let i = 0; i < audio[ch].length; i++) sum[ch][i] += audio[ch][i];
      }
      if (sum) {
        let peak = 0, squares = 0;
        for (const ch of sum) for (const value of ch) {
          if (!Number.isFinite(value)) throw new Error(`Non-finite ${group.name} stem`);
          peak = Math.max(peak, Math.abs(value)); squares += value * value;
        }
        if (peak >= 1) throw new Error(`${group.name} dry sum would clip; preserving its individual source stems instead`);
        const wav = encodeWav(sum), name = `${group.name}-dry.wav`;
        await save(name, wav);
        outputs.push({ name, sha256: await sha256(wav), frames: sum[0].length, duration: sum[0].length / 44100,
          samplePeak: peak, rms: Math.sqrt(squares / (sum[0].length * 2)), tap: "sum of actual dry role taps", roles });
        await checkpoint();
      }
      await renderPart(`${group.name}-fx-only.wav`, groupProject(p, group.roles), "fx", roles);
    }
    await renderPart("shared-fx.wav", p, "fx");
    report.status = "complete";
    report.completedAt = new Date().toISOString();
    await checkpoint();
    say("COMPLETE · fresh 16-bar mix, aligned dry groups, individual roles, isolated FX and reproducible project saved.");
    const audio = document.createElement("audio");
    audio.controls = true;
    audio.src = `/deliverables/${outputPrefix}/full.wav`;
    const link = document.createElement("a");
    link.href = `/deliverables/${outputPrefix}/render-report.json`;
    link.textContent = "Open render provenance";
    document.querySelector("#result")!.append(audio, link);
  } catch (error) {
    say(`ERROR: ${error instanceof Error ? error.stack : String(error)}`);
  } finally {
    button.disabled = false;
  }
});
