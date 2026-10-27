import type { Project, Role, SampleAsset } from "../engine/schema";
import { clone } from "../engine/schema";
export interface AuraEntry {
  id: string;
  name: string;
  category: string;
  filename: string;
  relativePath: string;
  sha256: string;
  sampleRate: number;
  channels: number;
  frames: number;
  duration: number;
  rootMidi: number;
  tuningCents: number;
  rootStatus: "provisional-signal-estimate";
  confidence: number;
  measuredFundamentalHz: number;
  gain: number;
  trimStart: number;
  trimEnd: number;
  envelope: { attack: number; decay: number; sustain: number; release: number };
  loop: false;
  envelopeMode: "gated";
  attackSeconds: number;
  minRecommendedGateSeconds: number;
  notes: string;
}
export interface AuraCatalog {
  schema: 1;
  id: "aura-playable-v1";
  privateLocalOnly: true;
  archiveSha256: string;
  licenseSummary: string;
  entries: AuraEntry[];
}
export type AuraPalette = "piano-wind" | "synth-strings";
export const AURA_PALETTES: Record<
  AuraPalette,
  { name: string; roles: Partial<Record<Role, string[]>> }
> = {
  "piano-wind": {
    name: "Vintage piano / saw flute / Alpha",
    roles: {
      melody: ["Vintage Piano"],
      keys: ["Keys - Alpha"],
      answer: ["Flute Saw"],
      pad: ["Genesis"],
    },
  },
  "synth-strings": {
    name: "Old-school lead / pluck / strings",
    roles: {
      melody: ["Old Skool", "OldSkool"],
      keys: ["Pluck - Glass", "Pluck Glass"],
      answer: ["Synth - Juno"],
      pad: ["Icon Strings"],
    },
  },
};
const finite = (v: unknown, a: number, b: number) =>
  typeof v === "number" && Number.isFinite(v) && v >= a && v <= b;
const hash = (s: unknown) => typeof s === "string" && /^[a-f0-9]{64}$/.test(s);
export function validateAuraCatalog(value: unknown): AuraCatalog {
  const c = value as AuraCatalog;
  if (
    !c ||
    c.schema !== 1 ||
    c.id !== "aura-playable-v1" ||
    c.privateLocalOnly !== true ||
    !hash(c.archiveSha256) ||
    typeof c.licenseSummary !== "string" ||
    c.licenseSummary.length > 5000 ||
    !Array.isArray(c.entries) ||
    !c.entries.length ||
    c.entries.length > 32
  )
    throw new Error("Invalid private Aura index.");
  const ids = new Set<string>();
  const paths = new Set<string>();
  for (const e of c.entries) {
    if (
      !e ||
      typeof e.id !== "string" ||
      !e.id ||
      e.id.length > 160 ||
      ids.has(e.id) ||
      typeof e.filename !== "string" ||
      !/^[-\w ()+.,&'!]+\.wav$/i.test(e.filename) ||
      e.filename.includes("..") ||
      e.relativePath !== "audio/" + e.filename ||
      paths.has(e.relativePath) ||
      !hash(e.sha256) ||
      typeof e.name !== "string" ||
      e.name.length > 200 ||
      typeof e.category !== "string" ||
      typeof e.notes !== "string" ||
      e.notes.length > 5000 ||
      !Number.isInteger(e.rootMidi) ||
      !finite(e.rootMidi, 12, 108) ||
      !finite(e.tuningCents, -100, 100) ||
      e.rootStatus !== "provisional-signal-estimate" ||
      !finite(e.confidence, 0, 1) ||
      !finite(e.measuredFundamentalHz, 15, 10000) ||
      !Number.isInteger(e.sampleRate) ||
      !finite(e.sampleRate, 8000, 192000) ||
      ![1, 2].includes(e.channels) ||
      !Number.isInteger(e.frames) ||
      !finite(e.frames, 1, 192000 * 30) ||
      !finite(e.duration, 0.005, 30) ||
      Math.abs(e.frames / e.sampleRate - e.duration) > 1 / e.sampleRate ||
      !finite(e.gain, 0.001, 4) ||
      !finite(e.trimStart, 0, e.duration) ||
      !finite(e.trimEnd, e.trimStart + 0.001, e.duration) ||
      e.loop !== false ||
      e.envelopeMode !== "gated" ||
      !e.envelope ||
      !finite(e.envelope.attack, 0, 3) ||
      !finite(e.envelope.decay, 0, 10) ||
      !finite(e.envelope.sustain, 0, 1) ||
      !finite(e.envelope.release, 0.001, 5) ||
      !finite(e.attackSeconds, 0, 5) ||
      !finite(e.minRecommendedGateSeconds, 0.001, 10)
    )
      throw new Error("Invalid Aura entry: " + (e?.name ?? "unknown"));
    const correctedCents =
      1200 *
        Math.log2(
          e.measuredFundamentalHz / (440 * 2 ** ((e.rootMidi - 69) / 12)),
        ) +
      e.tuningCents;
    if (Math.abs(correctedCents) > 35)
      throw new Error(
        "Aura root/correction disagrees with measured fundamental: " + e.name,
      );
    ids.add(e.id);
    paths.add(e.relativePath);
  }
  return c;
}
export function auraSelection(
  c: AuraCatalog,
  palette: AuraPalette,
): Partial<Record<Role, AuraEntry>> {
  const plan = AURA_PALETTES[palette];
  if (!plan) throw new Error("Unknown Aura palette");
  return Object.fromEntries(
    Object.entries(plan.roles).map(([role, tokens]) => {
      const entry = c.entries.find((e) =>
        tokens!.some((token) =>
          e.filename.toLowerCase().includes(token.toLowerCase()),
        ),
      );
      if (!entry)
        throw new Error(
          "Required Aura " +
            role +
            " unavailable: " +
            tokens!.join(" / ") +
            ". No synth substitution.",
        );
      return [role, entry];
    }),
  );
}
export const auraUrl = (entry: AuraEntry) =>
  "/private-assets/aura/" +
  entry.relativePath.split("/").map(encodeURIComponent).join("/");
function wavFormat(bytes: Uint8Array) {
  const d = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (i: number) => String.fromCharCode(...bytes.subarray(i, i + 4));
  if (
    bytes.length < 44 ||
    tag(0) !== "RIFF" ||
    tag(8) !== "WAVE" ||
    d.getUint32(4, true) + 8 > bytes.length
  )
    throw new Error("Invalid Aura WAV header");
  let format = 0,
    channels = 0,
    rate = 0,
    bits = 0,
    align = 0,
    data = 0;
  for (let i = 12; i + 8 <= bytes.length; ) {
    const n = d.getUint32(i + 4, true);
    if (i + 8 + n > bytes.length) throw new Error("Truncated Aura WAV");
    if (tag(i) === "fmt " && n >= 16) {
      format = d.getUint16(i + 8, true);
      channels = d.getUint16(i + 10, true);
      rate = d.getUint32(i + 12, true);
      align = d.getUint16(i + 20, true);
      bits = d.getUint16(i + 22, true);
    }
    if (tag(i) === "data") data += n;
    i += 8 + n + (n % 2);
  }
  if (
    ![1, 3].includes(format) ||
    ![16, 24, 32].includes(bits) ||
    align !== (channels * bits) / 8 ||
    !data ||
    data % align !== 0
  )
    throw new Error("Unsupported Aura WAV encoding");
  return { sampleRate: rate, channels, frames: data / align };
}
export async function auraAsset(
  entry: AuraEntry,
  role: Role,
  bytes: Uint8Array,
  license: string,
): Promise<SampleAsset> {
  const digest = Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new Uint8Array(bytes).buffer),
    ),
  )
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
  if (digest !== entry.sha256)
    throw new Error("Aura source hash mismatch: " + entry.name);
  const w = wavFormat(bytes);
  if (
    w.sampleRate !== entry.sampleRate ||
    w.channels !== entry.channels ||
    w.frames !== entry.frames
  )
    throw new Error(
      "Aura sample-rate/channel/frame metadata mismatch: " + entry.name,
    );
  let text = "";
  for (let i = 0; i < bytes.length; i += 16384)
    text += String.fromCharCode(...bytes.subarray(i, i + 16384));
  return {
    id: entry.id,
    name: entry.name,
    data: "data:audio/wav;base64," + btoa(text),
    role,
    root: entry.rootMidi,
    tuning: entry.tuningCents,
    trimStart: entry.trimStart,
    trimEnd: entry.trimEnd,
    gain: entry.gain,
    choke: "",
    license:
      license +
      " PRIVATE LOCAL ONLY; root/tuning provisional signal estimate, manual review required.",
    originalFilename: entry.filename,
    source: "Echo Sound Works Aura / private local installation",
    sourceId: entry.relativePath,
    hash: entry.sha256,
    sampleRate: entry.sampleRate,
    channels: entry.channels,
    duration: entry.duration,
    rootConfidence: entry.confidence,
    measuredFundamentalHz: entry.measuredFundamentalHz,
    envelopeMode: "gated",
    loop: false,
    envelope: clone(entry.envelope),
  };
}
export async function loadAuraCatalog(
  fetcher: typeof fetch = fetch,
): Promise<AuraCatalog> {
  const r = await fetcher("/private-assets/aura/playable-catalog-v1.json");
  if (!r.ok)
    throw new Error(
      "Private Aura catalog missing. Install the local catalog; no synth substitution.",
    );
  const text = await r.text();
  if (text.length > 128000) throw new Error("Aura index too large");
  return validateAuraCatalog(JSON.parse(text));
}
export async function loadAuraPalette(
  palette: AuraPalette,
  existing: SampleAsset[] = [],
  fetcher: typeof fetch = fetch,
) {
  const catalog = await loadAuraCatalog(fetcher);
  const selection = auraSelection(catalog, palette);
  const assets: SampleAsset[] = [];
  for (const [role, e] of Object.entries(selection) as [Role, AuraEntry][]) {
    const saved = existing.find((a) => a.id === e.id && a.hash === e.sha256);
    if (saved) {
      const bytes = Uint8Array.from(atob(saved.data.split(",")[1] ?? ""), (c) =>
        c.charCodeAt(0),
      );
      await auraAsset(e, role, bytes, catalog.licenseSummary);
      assets.push(clone(saved));
      continue;
    }
    const r = await fetcher(auraUrl(e));
    if (!r.ok) throw new Error("Missing private Aura WAV: " + e.filename);
    const bytes = new Uint8Array(await r.arrayBuffer());
    if (bytes.length > 24_000_000) throw new Error("Aura WAV too large");
    assets.push(await auraAsset(e, role, bytes, catalog.licenseSummary));
  }
  return { catalog, selection, assets };
}
/** Palette-only swap: notes, harmony, mix, locks and arrangement are not regenerated. */
export function applyAuraPalette(
  original: Project,
  palette: AuraPalette,
  selection: Partial<Record<Role, AuraEntry>>,
  assets: SampleAsset[],
): Project {
  const p = clone(original);
  if (!p.auraOriginal)
    throw new Error(
      "Open an Aura original project before swapping its palette.",
    );
  for (const a of assets)
    if (!p.assets.some((x) => x.id === a.id)) p.assets.push(clone(a));
  for (const [role, e] of Object.entries(selection))
    if (e && !p.assets.some((a) => a.id === e.id && a.hash === e.sha256))
      throw new Error("Verified Aura palette asset missing for " + role);
  for (const c of p.candidates)
    for (const t of c.tracks) {
      const e = selection[t.id];
      if (e && !t.locked) t.instrument = e.id;
    }
  p.auraOriginal.palette = palette;
  return p;
}
