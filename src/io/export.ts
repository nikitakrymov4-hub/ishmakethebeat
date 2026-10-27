import { assertRequiredSamples } from "../engine/required-samples";
import { zipSync, strToU8 } from "fflate";
import { AudioGraph } from "../audio/graph";
import { score, vocalEventIssues } from "../engine/score";
import { seconds } from "../engine/schema";
import type { Project, Role } from "../engine/schema";
import {
  renderDurationSeconds,
  withoutVocals,
} from "../engine/render-duration";
import { encodeWav } from "./wav";
import { exportMidi } from "./midi";
export {
  TAIL_SECONDS,
  renderDurationSeconds,
  eventTailSeconds,
  withoutVocals,
} from "../engine/render-duration";
export interface RenderOptions {
  instrumentalOnly?: boolean;
}
export interface RenderResult {
  wav: Uint8Array;
  peak: number;
  rms: number;
  duration: number;
  frames: number;
}
/** Yield a real task without background-tab setTimeout clamping. */
export function yieldRenderTask(): Promise<void> {
  const taskScheduler = (
    globalThis as typeof globalThis & {
      scheduler?: { yield?: () => Promise<void> };
    }
  ).scheduler;
  if (typeof taskScheduler?.yield === "function") return taskScheduler.yield();
  return new Promise<void>((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.onmessage = null;
      channel.port1.close();
      channel.port2.close();
      resolve();
    };
    channel.port2.postMessage(null);
  });
}

export async function renderWav(
  p: Project,
  tap = "mix",
  signal?: AbortSignal,
  onProgress?: (value: number) => void,
  options: RenderOptions = {},
): Promise<RenderResult> {
  if (signal?.aborted) throw new DOMException("Render cancelled", "AbortError");
  const project = options.instrumentalOnly ? withoutVocals(p) : p;
  assertRequiredSamples(project, false, true);
  const activeVocals = new Set(
    (project.vocalEvents ?? [])
      .filter(
        (v) =>
          v.enabled &&
          (v.role === "tag"
            ? project.tagEnabled
            : project.voxEnabled !== false),
      )
      .map((v) => v.id),
  );
  const issues = vocalEventIssues(project).filter((i) =>
    activeVocals.has(i.eventId),
  );
  if (issues.length) throw new Error(issues.map((i) => i.message).join(" "));
  const duration = renderDurationSeconds(p),
    frames = Math.ceil(duration * 44100),
    ctx = new OfflineAudioContext(2, frames, 44100),
    graph = new AudioGraph(ctx, project, tap);
  onProgress?.(0);
  await graph.loadSamples();
  onProgress?.(0.01);
  const events = score(project).filter((e) =>
    tap === "mix" || tap === "headroom"
      ? true
      : tap === "fx"
        ? true
        : e.role === tap,
  );
  // Chunk scheduling yields to the UI and permits cancellation, including large arrangements.
  for (let i = 0; i < events.length; i++) {
    if (signal?.aborted) {
      graph.dispose();
      throw new DOMException("Render cancelled", "AbortError");
    }
    graph.schedule(events[i], seconds(events[i].tick, p.settings.bpm));
    if (i % 150 === 0) {
      onProgress?.(0.01 + (i / events.length) * 0.19);
      await yieldRenderTask();
    }
  }
  onProgress?.(0.25);
  // OfflineAudioContext has no cross-browser abort API. Cancellation discards its result.
  const buffer = await ctx.startRendering();
  if (signal?.aborted) {
    graph.dispose();
    throw new DOMException("Render cancelled", "AbortError");
  }
  const channels = [buffer.getChannelData(0), buffer.getChannelData(1)];
  let peak = 0,
    sum = 0;
  // Taper the end of the common render window to prevent a final discontinuity.
  for (const c of channels)
    for (let i = 0; i < 221; i++) c[c.length - 1 - i] *= i / 221;
  for (const c of channels)
    for (const x of c) {
      if (!Number.isFinite(x)) throw new Error("Non-finite sample in render");
      peak = Math.max(peak, Math.abs(x));
      sum += x * x;
    }
  onProgress?.(0.85);
  await yieldRenderTask();
  const wav = encodeWav(channels);
  graph.dispose();
  onProgress?.(1);
  return {
    wav,
    peak,
    rms: Math.sqrt(sum / (frames * 2)),
    duration: frames / 44100,
    frames,
  };
}
export async function exportStems(
  p: Project,
  signal: AbortSignal,
  progress: (n: number) => void,
  options: RenderOptions = {},
) {
  const project = options.instrumentalOnly ? withoutVocals(p) : p;
  assertRequiredSamples(project, false, true);
  const vocals = score(project).filter(
    (e) => e.role === "tag" || e.role === "vox",
  );
  const roles: (Role | "tag" | "vox" | "fx" | "loop" | "resample")[] = [
      ...p.candidates[p.selected].tracks.map((t) => t.id),
      ...new Set((p.clips ?? []).map((c) => c.role)),
      "fx",
      ...new Set(vocals.map((e) => e.role as "tag" | "vox")),
    ],
    files: Record<string, Uint8Array> = {};
  for (let i = 0; i < roles.length; i++) {
    const role = roles[i];
    files[`${String(i + 1).padStart(2, "0")}-${role}.wav`] = (
      await renderWav(
        p,
        role,
        signal,
        (n) => progress((i + n) / roles.length),
        options,
      )
    ).wav;
  }
  files["README.txt"] = strToU8(
    `ishmakethebeat aligned stems\n44,100 Hz stereo 24-bit PCM. All files start at tick 0 and share ${Math.ceil(renderDurationSeconds(p) * 44100)} frames, including the common effect-tail window.\nTap: post instrument, track filter/insert and fader; before master gain and protection.\nStereo echoes, modulation and room returns are isolated in the fx stem. No shared FX in dry track files.\nMuted and non-soloed tracks are silent to match the current audition.\n${options.instrumentalOnly ? "Instrumental-only: tag and vox sources and sends are omitted.\n" : ""}Master protection is excluded. The sum can differ from the nonlinear protected mix.\n`,
  );
  progress(1);
  return zipSync(files, { level: 0 });
}
export function portableZip(p: Project) {
  assertRequiredSamples(p, true);
  const files: Record<string, Uint8Array> = {
    "project.json": strToU8(JSON.stringify(p, null, 2)),
    "score.mid": exportMidi(p),
  };
  for (const a of p.assets) {
    const extension = a.data.startsWith("data:audio/mpeg;") ? "mp3" : "wav";
    files[`samples/${a.id.replace(/[^a-zA-Z0-9._-]/g, "_")}.${extension}`] =
      Uint8Array.from(atob(a.data.split(",")[1]), (c) => c.charCodeAt(0));
  }
  return zipSync(files, { level: 1 });
}
export function download(
  data: Uint8Array | string,
  name: string,
  type = "application/octet-stream",
) {
  const blob = new Blob(
      [typeof data === "string" ? data : new Uint8Array(data)],
      { type },
    ),
    url = URL.createObjectURL(blob),
    a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
