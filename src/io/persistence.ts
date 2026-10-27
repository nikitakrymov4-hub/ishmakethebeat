import {
  requiresSampleAsset,
  assertRequiredSamples,
} from "../engine/required-samples";
import { unzipSync, strFromU8 } from "fflate";
import { readWavInfo } from "./wav";
import type { Project } from "../engine/schema";
import { BAR, LOOP_TICKS, ROLES, ALL_ROLES, isDrum } from "../engine/schema";
import type { RoleEffects } from "../engine/schema";
import { PROFILES } from "../engine/profiles";
const DB = "ishmakethebeat",
  KEY = "current";
let connection: Promise<IDBDatabase> | undefined;
function db() {
  return (connection ??= new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore("sessions");
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  }));
}
export async function saveLocal(project: Project) {
  const d = await db();
  return new Promise<void>((resolve, reject) => {
    const tx = d.transaction("sessions", "readwrite");
    tx.objectStore("sessions").put(project, KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
export async function loadLocal(): Promise<Project | null> {
  const d = await db();
  return new Promise((resolve, reject) => {
    const r = d.transaction("sessions").objectStore("sessions").get(KEY);
    r.onsuccess = () => {
      try {
        resolve(r.result ? validateProject(r.result) : null);
      } catch (e) {
        reject(e);
      }
    };
    r.onerror = () => reject(r.error);
  });
}
function finite(n: unknown, a: number, b: number) {
  return typeof n === "number" && Number.isFinite(n) && n >= a && n <= b;
}
function validEffects(
  e?: RoleEffects,
  automationLimit = LOOP_TICKS,
  vocal = false,
) {
  if (!e) return true;
  if (typeof e !== "object" || Array.isArray(e)) return false;
  const d = e.delay,
    envelope = e.sampleEnvelope,
    h = e.hat,
    r = e.reverb;
  return (
    (!envelope ||
      (finite(envelope.attack, 0, 0.2) &&
        finite(envelope.decay, 0.001, 2) &&
        finite(envelope.sustain, 0, 1) &&
        finite(envelope.release, 0.001, 1))) &&
    (!d ||
      (finite(d.division, 0.125, 4) &&
        finite(d.feedback, 0, 0.65) &&
        finite(d.wet, 0, 0.8) &&
        finite(d.cutoff, 250, 18000) &&
        typeof d.pingPong === "boolean" &&
        (!d.automation ||
          (Array.isArray(d.automation) &&
            d.automation.length < 1024 &&
            d.automation.every(
              (a) =>
                finite(a.tick, 0, automationLimit) && finite(a.wet, 0, 0.8),
            ))))) &&
    (!r ||
      (vocal &&
        finite(r.wet, 0, 0.8) &&
        finite(r.decay, 0.1, 8) &&
        finite(r.preDelay, 0, 0.25))) &&
    (!h ||
      (finite(h.mix, 0, 1) &&
        finite(h.echoBeats, 0.0625, 2) &&
        finite(h.feedback, 0, 0.6) &&
        finite(h.chorus, 0, 1) &&
        finite(h.crush, 0, 1) &&
        finite(h.room, 0, 1))) &&
    (e.saturation === undefined || finite(e.saturation, 0, 1))
  );
}
export function validateProject(value: unknown): Project {
  const p = value as Project;
  if (
    p?.auraOriginal &&
    (p.auraOriginal.version !== 1 ||
      !["piano-wind", "synth-strings"].includes(p.auraOriginal.palette) ||
      !["cascade", "angular"].includes(p.auraOriginal.direction) ||
      !["pulse", "interrupted"].includes(p.auraOriginal.feel))
  )
    throw new Error("Unsupported Aura original writing version or controls.");
  if (
    p?.mixPass &&
    (p.mixPass.version !== "balance-1" ||
      !finite(p.mixPass.duck?.depthDb, 0, 12) ||
      !finite(p.mixPass.duck?.attack, 0.001, 0.05) ||
      !finite(p.mixPass.duck?.release, 0.01, 0.5) ||
      !Array.isArray(p.mixPass.changes))
  )
    throw new Error("Invalid saved mix settings.");
  if (
    !p ||
    p.format !== "ishmakethebeat" ||
    p.schema !== 1 ||
    !p.settings ||
    !PROFILES[p.settings.profile] ||
    !finite(p.settings.bpm, 40, 300) ||
    !finite(p.settings.key, 0, 11) ||
    !["minor", "pentatonic", "major", "dorian"].includes(p.settings.mode) ||
    (p.settings.cultureFamily !== undefined &&
      !["auto", "paper-lantern", "glass-garden", "odd-orbit"].includes(
        p.settings.cultureFamily,
      )) ||
    (p.settings.allowSynthFallback !== undefined &&
      typeof p.settings.allowSynthFallback !== "boolean") ||
    !Array.isArray(p.candidates) ||
    p.candidates.length !== 3 ||
    !finite(p.selected, 0, 2)
  )
    throw new Error("This is not a supported ishmakethebeat project.");
  if (
    !Array.isArray(p.sections) ||
    p.sections.length > 128 ||
    p.sections.some(
      (s) => !Number.isInteger(s.bars) || !finite(s.bars, 1, 64),
    ) ||
    p.sections.reduce((n, s) => n + s.bars * BAR, 0) > BAR * 512
  )
    throw new Error(
      "Arrangement must contain 1–512 bars, with up to 64 bars per section.",
    );
  for (const c of p.candidates) {
    if (
      !Array.isArray(c.harmony) ||
      !c.harmony.length ||
      !Array.isArray(c.tracks) ||
      c.tracks.length < 9 ||
      c.tracks.length > 12
    )
      throw new Error("Missing score or harmony.");
    if (ROLES.some((r) => c.tracks.filter((t) => t.id === r).length !== 1))
      throw new Error("Duplicate or missing tracks.");
    if (
      c.tracks.some(
        (t) =>
          !ALL_ROLES.includes(t.id) ||
          c.tracks.filter((x) => x.id === t.id).length !== 1,
      )
    )
      throw new Error("Unsupported or duplicate ensemble role.");
    for (const t of c.tracks)
      if (
        !finite(t.volume, 0, 1) ||
        !finite(t.pan, -1, 1) ||
        (t.register !== undefined &&
          (!Number.isInteger(t.register) || !finite(t.register, -24, 24))) ||
        !validEffects(t.effects) ||
        !Array.isArray(t.notes) ||
        t.notes.length > 20000 ||
        t.notes.some(
          (n) =>
            !finite(n.tick, 0, LOOP_TICKS - 1) ||
            !finite(n.duration, 1, LOOP_TICKS - n.tick) ||
            !finite(n.pitch, 0, 127) ||
            !finite(n.velocity, 0, 1) ||
            (n.drumPitch !== undefined &&
              (!isDrum(t.id) || !finite(n.drumPitch, -24, 24))) ||
            (n.glide &&
              (!finite(n.glide.to, 0, 127) ||
                !finite(n.glide.at, 0, n.duration) ||
                !finite(n.glide.ms, 1, 1000))),
        )
      )
        throw new Error(`Invalid events in ${t.name}.`);
  }
  if (
    !Array.isArray(p.assets) ||
    p.assets.some(
      (a) =>
        typeof a.data !== "string" ||
        !a.data.startsWith("data:audio/") ||
        a.data.length > 30_000_000 ||
        (a.drumTuning !== undefined && !finite(a.drumTuning, -2400, 2400)),
    )
  )
    throw new Error("Invalid or oversized sample asset.");
  if (
    p.clips &&
    (!Array.isArray(p.clips) ||
      p.clips.length > 32 ||
      p.clips.some(
        (c) =>
          !p.assets.some((a) => a.id === c.assetId) ||
          !["loop", "resample"].includes(c.role) ||
          !finite(c.tick, 0, LOOP_TICKS - 1) ||
          !finite(c.duration, 1, LOOP_TICKS) ||
          !finite(c.sourceOffset, 0, 3600) ||
          !finite(c.sourceDuration, 0.001, 3600) ||
          !finite(c.gain, 0, 1) ||
          !finite(c.pan, -1, 1) ||
          !finite(c.pitch, -12, 12) ||
          !finite(c.repeatTicks ?? LOOP_TICKS, 1, LOOP_TICKS) ||
          !validEffects(c.effects) ||
          c.provenance?.stretch !== "native-only" ||
          !finite(c.provenance.nativeBpm, 40, 300),
      ))
  )
    throw new Error("Invalid audio clip or source region.");
  if (p.voxEnabled !== undefined && typeof p.voxEnabled !== "boolean")
    throw new Error("Invalid vocal activity setting.");
  if (p.vocalEvents !== undefined) {
    const text = (v: unknown, max: number, empty = false) =>
      typeof v === "string" &&
      v.length <= max &&
      (empty || v.trim().length > 0);
    if (!Array.isArray(p.vocalEvents) || p.vocalEvents.length > 128)
      throw new Error(
        "Vocal events must be an array of at most 128 placements.",
      );
    const ids = new Set<string>();
    for (const v of p.vocalEvents) {
      const provenance = v?.provenance;
      const processing = provenance?.processing;
      if (
        !v ||
        !text(v.id, 128) ||
        ids.has(v.id) ||
        !text(v.name, 256) ||
        !text(v.assetId, 256) ||
        !["tag", "vox"].includes(v.role) ||
        typeof v.enabled !== "boolean" ||
        !v.placement ||
        !["absolute", "section"].includes(v.placement.kind) ||
        !finite(v.placement.tick, 0, BAR * 512 - 1) ||
        (v.placement.kind === "section" && !text(v.placement.sectionId, 256)) ||
        !finite(v.duration, 1, BAR * 512) ||
        !finite(v.sourceOffset, 0, 3600) ||
        !finite(v.sourceDuration, 0.001, 3600) ||
        !finite(v.gain, 0, 1) ||
        !finite(v.pan, -1, 1) ||
        !finite(v.pitch, -24, 24) ||
        typeof v.reverse !== "boolean" ||
        !["one-shot", "gated"].includes(v.mode) ||
        !finite(v.fadeIn, 0, 10) ||
        !finite(v.fadeOut, 0, 10) ||
        (v.filter &&
          (!finite(v.filter.highpass, 20, 20000) ||
            !finite(v.filter.lowpass, 20, 20000) ||
            v.filter.highpass > v.filter.lowpass)) ||
        !validEffects(v.effects, BAR * 512, true) ||
        v.effects?.hat !== undefined ||
        (v.repeats &&
          (!Number.isInteger(v.repeats.count) ||
            !finite(v.repeats.count, 0, 64) ||
            !finite(v.repeats.intervalTicks, 1, BAR * 512))) ||
        !["allow", "choke-group"].includes(v.overlap) ||
        (v.chokeGroup !== undefined && !text(v.chokeGroup, 128, true)) ||
        (v.overlap === "choke-group" && !text(v.chokeGroup, 128)) ||
        !provenance ||
        !text(provenance.sourceName, 1024) ||
        !text(provenance.sourceHash, 256, true) ||
        !text(provenance.creator, 1024, true) ||
        !text(provenance.credit, 4096, true) ||
        (processing &&
          (!text(processing.sourceAssetId, 256) ||
            !text(processing.sourceHash, 256) ||
            !text(processing.processor, 256) ||
            !text(processing.version, 256) ||
            !processing.settings ||
            typeof processing.settings !== "object" ||
            Array.isArray(processing.settings) ||
            Object.keys(processing.settings).length > 64 ||
            Object.values(processing.settings).some((x) =>
              typeof x === "number"
                ? !Number.isFinite(x)
                : typeof x !== "string" && typeof x !== "boolean",
            )))
      )
        throw new Error(`Invalid vocal event${v?.name ? `: ${v.name}` : ""}.`);
      ids.add(v.id);
      const asset = p.assets.find((a) => a.id === v.assetId);
      if (
        asset &&
        (!finite(asset.root, 0, 127) ||
          !finite(asset.tuning, -2400, 2400) ||
          !finite(asset.gain, 0, 4))
      )
        throw new Error(`Invalid source tuning or gain for ${v.name}.`);
    }
  }
  if (
    p.scaleGuides &&
    (p.scaleGuides.length > 64 ||
      p.scaleGuides.some(
        (g) =>
          g.pitches.length > 128 ||
          g.pitches.some((n) => !Number.isInteger(n) || !finite(n, 0, 127)),
      ))
  )
    throw new Error("Invalid silent scale guide.");
  // Legacy staged drum imports may temporarily lack sample-* sources; Aura packs may not.
  assertRequiredSamples(p, true);
  return p;
}
export function missingAssets(p: Project) {
  const activeVocals = (p.vocalEvents ?? []).filter(
    (v) =>
      v.enabled && (v.role === "tag" ? p.tagEnabled : p.voxEnabled !== false),
  );
  return [
    ...new Set([
      ...p.candidates.flatMap((c) =>
        c.tracks
          .filter(
            (t) =>
              requiresSampleAsset(t.instrument) &&
              !p.assets.some((a) => a.id === t.instrument),
          )
          .map((t) => t.name),
      ),
      ...(p.clips ?? [])
        .filter((c) => !p.assets.some((a) => a.id === c.assetId))
        .map((c) => c.name),
      ...activeVocals
        .filter((v) => !p.assets.some((a) => a.id === v.assetId))
        .map((v) => v.name),
      ...(p.vocalEvents === undefined &&
      p.tagEnabled &&
      p.tagAsset &&
      !p.assets.some((a) => a.id === p.tagAsset)
        ? ["Producer tag"]
        : []),
      ...activeVocals
        .filter(
          (v) =>
            v.provenance.processing &&
            !p.assets.some(
              (a) => a.id === v.provenance.processing!.sourceAssetId,
            ),
        )
        .map((v) => `${v.name} (original source)`),
    ]),
  ];
}
export async function loadFile(file: File): Promise<Project> {
  if (file.size > 150_000_000) throw new Error("Project file exceeds 150 MB.");
  let text: string;
  if (file.name.toLowerCase().endsWith(".zip")) {
    const files = unzipSync(new Uint8Array(await file.arrayBuffer()));
    if (!files["project.json"]) throw new Error("ZIP has no project.json.");
    text = strFromU8(files["project.json"]);
  } else text = await file.text();
  return validateProject(JSON.parse(text));
}
export async function importSample(
  file: File,
  role: Project["assets"][number]["role"],
): Promise<Project["assets"][number]> {
  const vocal = role === "tag" || role === "vox";
  const mp3 = file.name.toLowerCase().endsWith(".mp3");
  if (file.size > 15_000_000)
    throw new Error(
      `Use a ${vocal ? "WAV or MP3" : "WAV one-shot"} smaller than 15 MB.`,
    );
  if (!file.name.toLowerCase().endsWith(".wav") && !(vocal && mp3))
    throw new Error(`Please import a ${vocal ? "WAV or MP3" : "WAV"} file.`);
  const data = await new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () =>
      resolve(
        String(r.result).replace(
          /^data:[^;]+;/,
          `data:audio/${mp3 ? "mpeg" : "wav"};`,
        ),
      );
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
  const ctx = new AudioContext();
  let duration = 0;
  let sampleRate = 44100,
    channels = 1;
  try {
    const decoded = await ctx.decodeAudioData(await file.arrayBuffer());
    duration = decoded.duration;
    sampleRate = decoded.sampleRate;
    channels = decoded.numberOfChannels;
  } finally {
    await ctx.close();
  }
  const bytes = await file.arrayBuffer(),
    digest = await crypto.subtle.digest("SHA-256", bytes),
    hash = Array.from(new Uint8Array(digest), (b) =>
      b.toString(16).padStart(2, "0"),
    ).join("");
  // Decode reports the context rate; preserve the WAV header's source rate when present.
  const info = readWavInfo(bytes);
  if (info) {
    sampleRate = info.sampleRate;
    channels = info.channels;
  }
  return {
    id: `sample-${hash.slice(0, 16)}-${role}`,
    name: file.name,
    data,
    role,
    root: 60,
    tuning: 0,
    trimStart: 0,
    trimEnd: duration,
    gain: role === "bass" ? 0.23 : 0.45,
    originalFilename: file.name,
    sourceId: `local:${hash}`,
    hash,
    sampleRate,
    channels,
    rootConfidence: 0,
    manualOverride: false,
    envelopeMode: isDrum(role) ? "one-shot" : "gated",
    loop: false,
    duration,
    choke:
      role === "hat" || role === "open"
        ? "hats"
        : role === "bass"
          ? "bass"
          : "",
    license: "User supplied; user retains rights",
  };
}
