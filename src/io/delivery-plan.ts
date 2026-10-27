import type { Project } from "../engine/schema";

export interface DeliveryJob {
  id: string;
  projectUrl: string;
  expectedSha256?: string;
  /** Generated examples may export the listening/headroom mixes without all stems. */
  mode?: "complete" | "mixes";
}
export interface DeliveryManifest {
  schemaVersion: 1;
  runId: string;
  jobs: DeliveryJob[];
}
export interface DeliveryRenderPart {
  name: string;
  tap: string;
  instrumentalOnly?: boolean;
}
const validId = (value: unknown): value is string =>
  typeof value === "string" && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(value);

export function deliveryLocalPath(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    /[%?#\\]/.test(value) ||
    value.split("/").some((p) => p === "." || p === "..") ||
    !/^\/(deliverables|private-assets)\//.test(value)
  )
    throw new Error(
      "Use a local /deliverables/ or /private-assets/ JSON path, without URL parameters",
    );
  if (!value.endsWith(".json")) throw new Error("A JSON filename is required");
  return value;
}

export function parseDeliveryManifest(bytes: Uint8Array): DeliveryManifest {
  const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Manifest must be an object");
  const m = value as DeliveryManifest;
  if (
    m.schemaVersion !== 1 ||
    !validId(m.runId) ||
    !Array.isArray(m.jobs) ||
    m.jobs.length > 16
  )
    throw new Error(
      "Manifest requires schemaVersion 1, a safe runId and at most 16 jobs",
    );
  const ids = new Set<string>();
  for (const job of m.jobs) {
    if (!job || !validId(job.id) || ids.has(job.id))
      throw new Error("Job IDs must be unique lowercase identifiers");
    ids.add(job.id);
    deliveryLocalPath(job.projectUrl);
    if (job.mode !== undefined && !["complete", "mixes"].includes(job.mode))
      throw new Error(`Invalid delivery mode for ${job.id}`);
    if (
      job.expectedSha256 !== undefined &&
      (typeof job.expectedSha256 !== "string" ||
        !/^[a-f0-9]{64}$/.test(job.expectedSha256))
    )
      throw new Error(`Invalid expectedSha256 for ${job.id}`);
  }
  return m;
}

export function deliveryRenderPlan(project: Project, mode: "complete" | "mixes" = "complete"): DeliveryRenderPart[] {
  if (mode === "mixes") return [
    { name: "mix.wav", tap: "mix" },
    { name: "headroom.wav", tap: "headroom" },
  ];
  const roles = [
    ...new Set([
      ...project.candidates[project.selected].tracks.map((t) => t.id),
      ...(project.clips ?? []).map((c) => c.role),
      "tag",
      "vox",
    ]),
  ];
  return [
    { name: "mix.wav", tap: "mix" },
    { name: "headroom.wav", tap: "headroom" },
    { name: "instrumental.wav", tap: "mix", instrumentalOnly: true },
    {
      name: "instrumental-headroom.wav",
      tap: "headroom",
      instrumentalOnly: true,
    },
    ...roles.map((role) => ({ name: `stem-${role}-dry.wav`, tap: role })),
    { name: "stem-fx.wav", tap: "fx" },
    { name: "stem-fx-instrumental.wav", tap: "fx", instrumentalOnly: true },
  ];
}
