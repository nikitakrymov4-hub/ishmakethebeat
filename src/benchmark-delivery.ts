/// <reference types="vite/client" />
import { score, totalTicks, vocalEventIssues } from "./engine/score";
import { seconds } from "./engine/schema";
import { missingAssets, validateProject } from "./io/persistence";
import { portableZip, renderDurationSeconds, renderWav } from "./io/export";
import { exportMidi } from "./io/midi";
import {
  deliveryLocalPath as localPath,
  parseDeliveryManifest as parseManifest,
  deliveryRenderPlan as renderPlan,
} from "./io/delivery-plan";
import type {
  DeliveryJob as Job,
  DeliveryManifest as Manifest,
} from "./io/delivery-plan";

// The development entry records the exact source versions it loaded, including itself.
const sources = import.meta.glob<string>(
  ["./audio/*.ts", "./engine/*.ts", "./io/*.ts", "./benchmark-delivery.ts"],
  { query: "?raw", import: "default", eager: true },
);
const runButton = document.querySelector<HTMLButtonElement>("#run")!;
const cancelButton = document.querySelector<HTMLButtonElement>("#cancel")!;
const manifestInput = document.querySelector<HTMLInputElement>("#manifest")!;
const log = document.querySelector<HTMLPreElement>("#log")!;
const results = document.querySelector<HTMLDivElement>("#results")!;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const digestPattern = /^[a-f0-9]{64}$/;
let controller: AbortController | undefined;
const say = (message: string) => {
  log.textContent += `\n${message}`;
};
const json = (value: unknown) => encoder.encode(JSON.stringify(value, null, 2));
const sha256 = async (bytes: Uint8Array) =>
  Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)),
    ),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");

interface Output {
  name: string;
  sha256: string;
  bytes: number;
  kind: string;
  tap?: string;
  instrumentalOnly?: boolean;
  frames?: number;
  duration?: number;
  samplePeak?: number;
  rms?: number;
}
interface Checkpoint {
  schemaVersion: 1;
  identitySha256: string;
  identity: Record<string, unknown>;
  status: "running" | "interrupted" | "failed" | "complete";
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  error?: string;
  outputs: Output[];
  provenance: Record<string, unknown>;
}

async function read(
  path: string,
  optional = false,
): Promise<Uint8Array | undefined> {
  const response = await fetch(path, { cache: "no-store" });
  if (optional && response.status === 404) return undefined;
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  // Vite's SPA fallback can return index.html for a missing extension route.
  if (response.headers.get("content-type")?.includes("text/html")) {
    if (optional) return undefined;
    throw new Error(`${path}: received HTML instead of a saved file`);
  }
  return bytes;
}
async function write(name: string, bytes: Uint8Array, previous?: string) {
  const response = await fetch(
    `/__benchmark-delivery-output?name=${encodeURIComponent(name)}`,
    {
      method: "POST",
      body: new Uint8Array(bytes),
      headers: previous
        ? { "If-Match": `"${previous}"` }
        : { "If-None-Match": "*" },
    },
  );
  if (!response.ok) throw new Error(`Saving ${name}: ${await response.text()}`);
  const written = (await response.json()) as { sha256: string; bytes: number };
  if (
    written.sha256 !== (await sha256(bytes)) ||
    written.bytes !== bytes.byteLength
  )
    throw new Error(`Server checksum mismatch: ${name}`);
  return written.sha256;
}
function checkCancelled(signal: AbortSignal) {
  if (signal.aborted)
    throw new DOMException(
      "Stopped; completed files remain checkpointed",
      "AbortError",
    );
}
async function deliver(
  manifest: Manifest,
  job: Job,
  manifestSha256: string,
  manifestUrl: string,
  engine: Record<string, unknown>,
  signal: AbortSignal,
) {
  const prefix = `${manifest.runId}/${job.id}`;
  const url = `/deliverables/benchmark-delivery/${prefix}`;
  const sourceBytes = (await read(job.projectUrl))!;
  if (sourceBytes.length > 150_000_000)
    throw new Error(`${job.id}: project exceeds 150 MB`);
  const sourceSha256 = await sha256(sourceBytes);
  if (job.expectedSha256 && sourceSha256 !== job.expectedSha256)
    throw new Error(
      `${job.id}: project does not match the manifest's expected SHA-256`,
    );
  const project = validateProject(JSON.parse(decoder.decode(sourceBytes)));
  const absent = missingAssets(project);
  if (absent.length)
    throw new Error(`${job.id}: unresolved assets: ${absent.join(", ")}`);
  const projectBefore = JSON.stringify(project);
  const frames = Math.ceil(renderDurationSeconds(project) * 44100);
  if (44 + frames * 6 > 180_000_000)
    throw new Error(
      `${job.id}: one WAV would exceed the 180 MB delivery limit`,
    );
  const plan = renderPlan(project, job.mode);
  const identity = {
    jobId: job.id,
    mode: job.mode ?? "complete",
    runId: manifest.runId,
    projectUrl: job.projectUrl,
    sourceSha256,
    engineSnapshotSha256: engine.snapshotSha256,
    browser: navigator.userAgent,
    format: { sampleRate: 44100, channels: 2, bitDepth: 24, frames },
    renderPlan: plan,
    artifactNames: [
      "project.ish.json",
      "score.mid",
      "portable-project.zip",
      "README.txt",
    ],
  };
  const identitySha256 = await sha256(json(identity));
  const old = await read(`${url}/checkpoint.json`, true);
  let checkpointHash = old ? await sha256(old) : undefined;
  let state: Checkpoint;
  if (old) {
    state = JSON.parse(decoder.decode(old)) as Checkpoint;
    if (
      state.schemaVersion !== 1 ||
      state.identitySha256 !== identitySha256 ||
      (await sha256(json(state.identity))) !== identitySha256 ||
      !Array.isArray(state.outputs)
    )
      throw new Error(
        `${job.id}: saved checkpoint belongs to another project, engine or browser; use a new runId`,
      );
    const known = new Set([
      ...plan.map((p) => p.name),
      ...identity.artifactNames,
    ]);
    const found = new Set<string>();
    for (const output of state.outputs) {
      if (
        !known.has(output.name) ||
        found.has(output.name) ||
        !digestPattern.test(output.sha256)
      )
        throw new Error(`${job.id}: invalid checkpoint output record`);
      found.add(output.name);
      const bytes = await read(`${url}/${output.name}`);
      if (
        !bytes ||
        bytes.length !== output.bytes ||
        (await sha256(bytes)) !== output.sha256
      )
        throw new Error(
          `${job.id}: ${output.name} is missing or changed; existing files have been preserved`,
        );
    }
    say(`${job.id}: verified ${state.outputs.length} checkpointed files.`);
  } else {
    const assetNames = new Set<string>();
    const assets = [];
    for (const asset of project.assets) {
      const name = asset.id.replace(/[^a-zA-Z0-9._-]/g, "_");
      if (assetNames.has(name))
        throw new Error("Portable sample filenames would collide");
      assetNames.add(name);
      const bytes = Uint8Array.from(atob(asset.data.split(",")[1]), (c) =>
        c.charCodeAt(0),
      );
      assets.push({
        id: asset.id,
        name: asset.name,
        bytes: bytes.length,
        sha256: await sha256(bytes),
        declaredSourceHash: asset.hash,
        sourceId: asset.sourceId,
        license: asset.license,
      });
    }
    const events = score(project);
    const roleEventCounts = Object.fromEntries(
      [...new Set(events.map((e) => e.role))].map((role) => [
        role,
        events.filter((e) => e.role === role).length,
      ]),
    );
    state = {
      schemaVersion: 1,
      identitySha256,
      identity,
      status: "running",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      outputs: [],
      provenance: {
        manifest: { url: manifestUrl, sha256: manifestSha256 },
        engine,
        project: {
          title: project.title,
          seed: project.settings.seed,
          selected: project.selected,
          bpm: project.settings.bpm,
          arrangement: project.arrangement,
          sourceSha256,
          settings: project.settings,
          sourceBytes: sourceBytes.length,
          musicDurationSeconds: seconds(
            totalTicks(project),
            project.settings.bpm,
          ),
          renderDurationSeconds: frames / 44100,
          projectModified: false,
        },
        assets,
        roleEventCounts,
        vocalIssues: vocalEventIssues(project),
        vocalActivity: {
          tagEnabled: project.tagEnabled,
          voxEnabled: project.voxEnabled,
          explicitEvents: project.vocalEvents !== undefined,
          note: "Saved activity is preserved; inactive tag/vox stems are silent. Instrumental renders omit sources and their sends.",
        },
        verification:
          "Rendered output and source hashes only. No music understanding, true-peak measurement or musical approval is implied.",
      },
    };
  }
  const checkpoint = async () => {
    state.updatedAt = new Date().toISOString();
    checkpointHash = await write(
      `${prefix}/checkpoint.json`,
      json(state),
      checkpointHash,
    );
  };
  const has = (name: string) => state.outputs.some((o) => o.name === name);
  const saveArtifact = async (
    name: string,
    bytes: Uint8Array,
    detail: Omit<Output, "name" | "sha256" | "bytes">,
  ) => {
    const hash = await sha256(bytes);
    const uncheckpointed = await read(`${url}/${name}`, true);
    if (uncheckpointed) {
      if ((await sha256(uncheckpointed)) !== hash)
        throw new Error(
          `${job.id}: uncheckpointed ${name} differs from this render; use a new runId`,
        );
      say(
        `${job.id}: adopted identical file saved before an interrupted checkpoint: ${name}`,
      );
    } else await write(`${prefix}/${name}`, bytes);
    state.outputs.push({ name, sha256: hash, bytes: bytes.length, ...detail });
    await checkpoint();
  };
  try {
    state.status = "running";
    delete state.error;
    delete state.completedAt;
    await checkpoint();
    checkCancelled(signal);
    if (!has("project.ish.json"))
      await saveArtifact("project.ish.json", sourceBytes, {
        kind: "unchanged source project",
      });
    if (!has("score.mid"))
      await saveArtifact("score.mid", exportMidi(project), {
        kind: "existing MIDI score export",
      });
    if (!has("portable-project.zip"))
      await saveArtifact("portable-project.zip", portableZip(project), {
        kind: "existing portable project export",
      });
    for (const part of plan) {
      checkCancelled(signal);
      if (has(part.name)) continue;
      say(`${job.id}: rendering ${part.name}…`);
      const started = performance.now();
      let previousStage = "";
      const progress = (value: number) => {
        // Log stage changes and coarse scheduling buckets, never fake DSP progress.
        const stage =
          value === 0
            ? "Loading embedded audio"
            : value < 0.25
              ? `Scheduling score: ${Math.min(100, Math.floor(((value - 0.01) / 0.19) * 10) * 10)}%`
              : value < 0.85
                ? "Rendering audio with OfflineAudioContext"
                : value < 1
                  ? "Encoding 24-bit WAV"
                  : "WAV ready";
        if (stage === previousStage) return;
        previousStage = stage;
        say(
          `${job.id} / ${part.name}: ${stage} (${((performance.now() - started) / 1000).toFixed(1)} s elapsed).`,
        );
      };
      const rendered = await renderWav(project, part.tap, signal, progress, {
        instrumentalOnly: part.instrumentalOnly,
      });
      say(`${job.id} / ${part.name}: verifying and saving output…`);
      if (rendered.frames !== frames)
        throw new Error(`${part.name}: stem alignment changed`);
      if (rendered.peak >= 1)
        throw new Error(
          `${part.name}: pre-encoding sample peak ${rendered.peak.toFixed(6)} reaches clipping; correct the saved project or use a new job. No gain was changed.`,
        );
      if (JSON.stringify(project) !== projectBefore)
        throw new Error("Rendering unexpectedly modified the project");
      await saveArtifact(part.name, rendered.wav, {
        kind:
          part.tap === "fx"
            ? "aligned effect return"
            : part.tap === "mix" || part.tap === "headroom"
              ? "full arrangement"
              : "aligned dry role",
        tap: part.tap,
        instrumentalOnly: Boolean(part.instrumentalOnly),
        frames: rendered.frames,
        duration: rendered.duration,
        samplePeak: rendered.peak,
        rms: rendered.rms,
      });
      say(`${job.id}: saved ${part.name} (${rendered.duration.toFixed(3)} s).`);
    }
    if (!has("README.txt"))
      await saveArtifact(
        "README.txt",
        encoder.encode(
          [
            `ishmakethebeat · ${project.title}`,
            `Source: ${job.projectUrl}`,
            `Source SHA-256: ${sourceSha256}`,
            `Every WAV: 44,100 Hz, stereo 24-bit PCM, ${frames} frames. All begin at tick 0 with a common effect-tail window.`,
            "mix.wav follows the saved listening gain and master bypass/protection settings. headroom.wav uses the engine's existing headroom tap with no listening boost or master protection; it is not normalized to a target peak.",
            job.mode === "mixes" ? "Generated-example delivery: listening and headroom mixes plus the editable project, MIDI and portable sources. Separate instrumental versions and stems are not rendered in this mode." : "instrumental.wav and instrumental-headroom.wav omit tag/vox sources and their sends while retaining the same duration.",
            job.mode === "mixes" ? "Open the saved project to edit vocal activity and export further versions." : "stem-<role>-dry.wav is post-instrument/filter/insert/fader, before master gain/protection. stem-fx.wav contains all returns. stem-fx-instrumental.wav contains returns without tags/vox. Use exactly one FX file when summing stems.",
            "Muted/non-soloed tracks and inactive tag/vox lanes remain silent. Do not sum full mixes with stems. The stem sum excludes master behavior and can differ from the protected listening mix.",
            "score.mid contains the existing note-score export; it does not encode audio-loop content, sampled vocal audio or browser effects. project.ish.json and portable-project.zip preserve those editable sources and settings.",
            "checkpoint.json contains measured sample peak and RMS, not true-peak or loudness certification. Analyze the actual WAV files separately before final musical approval.",
            "No composition, gain, activity or asset decisions were made by this delivery runner.",
          ].join("\n\n"),
        ),
        { kind: "delivery instructions" },
      );
    state.status = "complete";
    state.completedAt = new Date().toISOString();
    await checkpoint();
    const section = document.createElement("section");
    const heading = document.createElement("h2");
    heading.textContent = `${job.id} · ${project.title}`;
    const audio = document.createElement("audio");
    audio.controls = true;
    audio.preload = "none";
    audio.src = `${url}/mix.wav`;
    const link = document.createElement("a");
    link.href = `${url}/checkpoint.json`;
    link.textContent = "Open provenance and output hashes";
    section.append(heading, audio, link);
    results.append(section);
    say(
      `${job.id}: delivery complete; ${state.outputs.length} files verified.`,
    );
  } catch (error) {
    state.status = signal.aborted ? "interrupted" : "failed";
    state.error = error instanceof Error ? error.message : String(error);
    try {
      await checkpoint();
    } catch (checkpointError) {
      say(`Checkpoint could not be updated: ${String(checkpointError)}`);
    }
    throw error;
  }
}

cancelButton.addEventListener("click", () => {
  controller?.abort();
  cancelButton.disabled = true;
});
runButton.addEventListener("click", async () => {
  runButton.disabled = true;
  cancelButton.disabled = false;
  manifestInput.disabled = true;
  controller = new AbortController();
  results.replaceChildren();
  log.textContent = "Loading manifest…";
  try {
    const manifestUrl = localPath(manifestInput.value.trim());
    const bytes = (await read(manifestUrl))!;
    const manifest = parseManifest(bytes);
    if (!manifest.jobs.length) {
      say(
        "No jobs supplied. Add existing project paths to the local manifest before rendering.",
      );
      return;
    }
    const engineFiles = await Promise.all(
      Object.entries(sources)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(async ([path, content]) => ({
          path: `src/${path.slice(2)}`,
          sha256: await sha256(encoder.encode(content)),
        })),
    );
    const engine = {
      sourceFiles: engineFiles,
      snapshotSha256: await sha256(json(engineFiles)),
      scope:
        "Loaded src/audio, src/engine and src/io TypeScript sources plus this delivery entry.",
      renderer: "Current renderWav / AudioGraph / OfflineAudioContext",
      userAgent: navigator.userAgent,
    };
    for (const job of manifest.jobs) {
      checkCancelled(controller.signal);
      await deliver(
        manifest,
        job,
        await sha256(bytes),
        manifestUrl,
        engine,
        controller.signal,
      );
    }
    say(
      "All manifest jobs finished. Audio research and final listening approval are separate steps.",
    );
  } catch (error) {
    say(
      `${controller.signal.aborted ? "STOPPED" : "ERROR"}: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    controller = undefined;
    runButton.disabled = false;
    cancelButton.disabled = true;
    manifestInput.disabled = false;
  }
});
