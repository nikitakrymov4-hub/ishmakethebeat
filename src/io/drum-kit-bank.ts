import type { Project, SampleAsset } from "../engine/schema";
import { clone } from "../engine/schema";
import { validateProject } from "./persistence";

export const KIT321_BANK_URL = "/private-assets/321-drumkit/drum-bank.json";
export const KIT321_SOURCE_COUNT = 9;
const SOURCE_PREFIX = "private-assets/321-drumkit/321 drumkit/drums/";
const ROLES = new Set(["bass", "kick", "clap", "hat", "open", "perc"]);
const finite = (value: unknown, min: number, max: number): value is number =>
  typeof value === "number" &&
  Number.isFinite(value) &&
  value >= min &&
  value <= max;

export const is321Asset = (asset: SampleAsset) =>
  asset.id.startsWith("sample-321-") &&
  asset.sourceId?.startsWith(SOURCE_PREFIX) === true;

/** Validate the supplied bank's original embedded bytes before a user adds it. */
export async function checked321Bank(input: unknown): Promise<SampleAsset[]> {
  if (!Array.isArray(input) || input.length !== KIT321_SOURCE_COUNT)
    throw new Error("The 321 kit must contain its nine drum sources.");
  const ids = new Set<string>();
  for (const item of input) {
    if (!item || typeof item !== "object")
      throw new Error("Invalid 321 sample record.");
    const asset = item as SampleAsset;
    if (
      typeof asset.id !== "string" ||
      typeof asset.sourceId !== "string" ||
      !is321Asset(asset) ||
      ids.has(asset.id) ||
      !ROLES.has(asset.role) ||
      typeof asset.name !== "string" ||
      typeof asset.license !== "string" ||
      typeof asset.source !== "string" ||
      typeof asset.hash !== "string" ||
      !/^[a-f0-9]{64}$/.test(asset.hash) ||
      !asset.id.endsWith(asset.hash.slice(0, 16)) ||
      typeof asset.data !== "string" ||
      asset.data.length > 15_000_000 ||
      !/^data:audio\/(?:wav|mpeg);base64,[A-Za-z0-9+/]*={0,2}$/.test(
        asset.data,
      ) ||
      !Number.isInteger(asset.root) ||
      !finite(asset.root, 0, 127) ||
      !finite(asset.tuning, -1200, 1200) ||
      !finite(asset.rootConfidence, 0, 1) ||
      !finite(asset.gain, 0, 1) ||
      !finite(asset.duration, 0.001, 60) ||
      !finite(asset.trimStart, 0, asset.duration) ||
      !finite(asset.trimEnd, asset.trimStart, asset.duration) ||
      asset.trimEnd <= asset.trimStart ||
      !finite(asset.sampleRate, 8000, 192000) ||
      !finite(asset.channels, 1, 2) ||
      !["one-shot", "gated"].includes(asset.envelopeMode ?? "")
    )
      throw new Error(
        "Invalid 321 sample metadata. Reload the original kit bank.",
      );
    ids.add(asset.id);
    const bytes = Uint8Array.from(atob(asset.data.split(",")[1]), (c) =>
      c.charCodeAt(0),
    );
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    const hash = Array.from(new Uint8Array(digest), (b) =>
      b.toString(16).padStart(2, "0"),
    ).join("");
    if (hash !== asset.hash)
      throw new Error(`Source hash mismatch for ${asset.name}.`);
  }
  return clone(input as SampleAsset[]);
}

/** Adding sources changes no instruments, notes, mix, arrangement or vocal events. */
export function add321Bank(project: Project, bank: SampleAsset[]) {
  const next = clone(project);
  let added = 0;
  for (const asset of bank) {
    const existing = next.assets.find((candidate) => candidate.id === asset.id);
    if (existing) {
      if (existing.hash !== asset.hash || existing.data !== asset.data)
        throw new Error(
          `Existing sample conflicts with ${asset.name}; it was preserved.`,
        );
      // Preserve saved user root, tuning, trim, envelope and gain edits on reload.
      continue;
    }
    next.assets.push(clone(asset));
    added++;
  }
  validateProject(next);
  return {
    project: next,
    added,
    available: next.assets.filter(is321Asset).length,
  };
}
