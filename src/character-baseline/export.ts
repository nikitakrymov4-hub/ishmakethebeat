import { zipSync, strToU8 } from "fflate";
import { AudioGraph } from "./graph";
import { score, totalTicks } from "./score";
import { seconds, isDrum } from "../engine/schema";
import type { Project, Role } from "../engine/schema";
import { encodeWav } from "../io/wav";
import { exportMidi } from "../io/midi";
export const TAIL_SECONDS = 4;
export interface RenderResult {
  wav: Uint8Array;
  peak: number;
  rms: number;
  duration: number;
  frames: number;
}
export async function renderWav(
  p: Project,
  tap = "mix",
  signal?: AbortSignal,
  onProgress?: (value: number) => void,
): Promise<RenderResult> {
  if (signal?.aborted) throw new DOMException("Render cancelled", "AbortError");
  const duration = seconds(totalTicks(p), p.settings.bpm) + TAIL_SECONDS,
    frames = Math.ceil(duration * 44100),
    ctx = new OfflineAudioContext(2, frames, 44100),
    graph = new AudioGraph(ctx, p, tap);
  await graph.loadSamples();
  const events = score(p).filter((e) =>
    tap === "mix" || tap === "headroom"
      ? true
      : tap === "fx"
        ? !isDrum(e.role) && e.role !== "bass"
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
      onProgress?.((i / events.length) * 0.2);
      await new Promise((r) => setTimeout(r, 0));
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
  // Fixed tail is tapered over its last 5 ms, so truncated feedback cannot click.
  for (const c of channels)
    for (let i = 0; i < 221; i++) c[c.length - 1 - i] *= i / 221;
  for (const c of channels)
    for (const x of c) {
      if (!Number.isFinite(x)) throw new Error("Non-finite sample in render");
      peak = Math.max(peak, Math.abs(x));
      sum += x * x;
    }
  onProgress?.(0.85);
  await new Promise((r) => setTimeout(r, 0));
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
) {
  const roles: (Role | "tag" | "fx")[] = [
      ...p.candidates[p.selected].tracks.map((t) => t.id),
      "fx",
      ...(p.tagEnabled ? ["tag" as const] : []),
    ],
    files: Record<string, Uint8Array> = {};
  for (let i = 0; i < roles.length; i++) {
    const role = roles[i];
    files[`${String(i + 1).padStart(2, "0")}-${role}.wav`] = (
      await renderWav(p, role, signal, (n) => progress((i + n) / roles.length))
    ).wav;
  }
  files["README.txt"] = strToU8(
    "ishmakethebeat aligned stems\n44,100 Hz stereo 24-bit PCM. All files start at tick 0 and include a fixed 2-second tail.\nTap: post instrument, track filter/insert and fader; before master gain and protection.\nShared upper-instrument delay/reverb is isolated in fx.wav. No shared FX in dry track files.\nMuted and non-soloed tracks are silent to match the current audition.\nMaster protection is excluded. The sum can differ from the nonlinear protected mix.\n",
  );
  progress(1);
  return zipSync(files, { level: 0 });
}
export function portableZip(p: Project) {
  const files: Record<string, Uint8Array> = {
    "project.json": strToU8(JSON.stringify(p, null, 2)),
    "score.mid": exportMidi(p),
  };
  for (const a of p.assets)
    files[`samples/${a.id}.wav`] = Uint8Array.from(
      atob(a.data.split(",")[1]),
      (c) => c.charCodeAt(0),
    );
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
