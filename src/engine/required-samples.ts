import type { Project } from "./schema";
/** Persisted sample namespaces must never fall through to a synth preset. */
export const requiresSampleAsset = (id: string) =>
  id.startsWith("sample-") || id.startsWith("aura-");
export function assertRequiredSamples(
  p: Pick<Project, "assets" | "candidates"> &
    Partial<Pick<Project, "selected">>,
  auraOnly = false,
  scheduledOnly = false,
) {
  const absent = [
    ...new Set(
      (scheduledOnly ? [p.candidates[p.selected ?? 0]] : p.candidates).flatMap(
        (c) =>
          c.tracks
            .filter(
              (t) =>
                (!scheduledOnly || t.notes.length > 0) &&
                (auraOnly
                  ? t.instrument.startsWith("aura-")
                  : requiresSampleAsset(t.instrument)) &&
                !p.assets.some((a) => a.id === t.instrument),
            )
            .map((t) => t.instrument),
      ),
    ),
  ];
  if (absent.length)
    throw new Error("Missing required sample asset: " + absent.join(", "));
}
