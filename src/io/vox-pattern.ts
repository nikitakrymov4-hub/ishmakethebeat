import { BAR, PPQ, LOOP_TICKS, clone } from "../engine/schema";
import type { Project, VocalEvent, SampleAsset } from "../engine/schema";
import { score } from "../engine/score";
import { rng } from "../engine/random";

export const VOX_PATTERN_PREFIX = "vox-pattern:";
export interface VoxPatternOptions {
  assetIds: string[];
  seed: string;
  density: "off" | "sparse" | "regular";
  placement: "gaps" | "pickups";
  gain: number;
  echo: boolean;
}
export const isVoxAccentAsset = (asset: SampleAsset) =>
  asset.role === "vox" &&
  !/\b(tag\d*|producer)\b/i.test(
    `${asset.name} ${asset.originalFilename ?? ""}`,
  );

/** Generate editable accents only. Instrumental notes, tags, manual events and activity switches are retained. */
export function buildVoxPattern(
  project: Project,
  options: VoxPatternOptions,
): Project {
  if (
    typeof options.seed !== "string" ||
    !options.seed.trim() ||
    options.seed.length > 128 ||
    !["off", "sparse", "regular"].includes(options.density) ||
    !["gaps", "pickups"].includes(options.placement) ||
    !Number.isFinite(options.gain) ||
    options.gain < 0 ||
    options.gain > 1 ||
    typeof options.echo !== "boolean"
  )
    throw new Error("Choose valid vox generation settings.");
  if (project.vocalEvents === undefined && project.tagAsset)
    throw new Error(
      "Move the existing tag into the editable lane before generating accents.",
    );
  const next = clone(project);
  const manual = (next.vocalEvents ?? []).filter(
    (v) => !v.id.startsWith(VOX_PATTERN_PREFIX),
  );
  next.vocalEvents = manual;
  if (options.density === "off") return next;
  const ids = [...new Set(options.assetIds)];
  if (!ids.length || ids.length > 4)
    throw new Error("Choose one to four non-identifying vox sources.");
  const assets = ids.map((id) => {
    const a = next.assets.find((a) => a.id === id);
    if (!a || !isVoxAccentAsset(a))
      throw new Error("Choose a vox source, not a producer tag.");
    const length = Math.min(a.trimEnd, a.duration ?? a.trimEnd) - a.trimStart;
    if (!(length > 0 && length <= 4))
      throw new Error("Trim the selected vox source to four seconds or less.");
    return a;
  });
  const random = rng(`${options.seed}/vox-pattern-1`);
  const instrumental = score({ ...project, vocalEvents: manual }, true);
  const step = options.density === "sparse" ? 16 : 8;
  const sections = next.arrangement
    ? next.sections
    : [
        {
          id: "loop",
          name: "Loop",
          bars: LOOP_TICKS / BAR,
          kind: "hook" as const,
        },
      ];
  let offset = 0;
  let index = 0;
  for (const section of sections) {
    if (!["hook", "verse", "break", "return"].includes(section.kind)) {
      offset += section.bars * BAR;
      continue;
    }
    for (let first = 0; first < section.bars; first += step) {
      const bars = Math.min(step, section.bars - first);
      if (bars < 4) continue;
      const a = assets[Math.floor(random() * assets.length)];
      const sourceDuration =
        Math.min(a.trimEnd, a.duration ?? a.trimEnd) - a.trimStart;
      const rate = 2 ** (a.tuning / 1200);
      const duration = Math.max(
        1,
        Math.ceil(
          (Math.min(0.6, sourceDuration / rate) * next.settings.bpm * PPQ) / 60,
        ),
      );
      const end = (first + bars) * BAR;
      const finalBar = end - BAR;
      const choices = [1, 1.5, 2, 2.5, 3]
        .map((beat) => finalBar + beat * PPQ)
        .filter((tick) => tick + duration <= end);
      if (!choices.length) continue;
      const activity = (local: number) => {
        const tick = offset + local;
        return instrumental.reduce((sum, e) => {
          if (!["melody", "answer", "bridge", "tag", "vox"].includes(e.role))
            return sum;
          const overlap = Math.max(
            0,
            Math.min(tick + duration, e.tick + e.duration) -
              Math.max(tick, e.tick),
          );
          return (
            sum +
            overlap *
              (e.role === "tag" || e.role === "vox" ? 10 : e.velocity * e.gain)
          );
        }, 0);
      };
      const ranked = choices
        .map((tick) => ({ tick, activity: activity(tick), tie: random() }))
        .sort((a, b) => a.activity - b.activity || a.tie - b.tie);
      const tick =
        options.placement === "pickups"
          ? choices[choices.length - 1]
          : ranked[0].tick;
      // Do not pile an automatic accent onto an existing manual tag/vox source.
      if (
        instrumental.some(
          (e) =>
            (e.role === "tag" || e.role === "vox") &&
            e.tick < offset + tick + duration &&
            e.tick + e.duration > offset + tick,
        )
      )
        continue;
      const event: VocalEvent = {
        id: `${VOX_PATTERN_PREFIX}${index++}`,
        name: `Phrase accent · ${a.name}`,
        assetId: a.id,
        role: "vox",
        enabled: true,
        placement: next.arrangement
          ? { kind: "section", sectionId: section.id, tick }
          : { kind: "absolute", tick },
        duration,
        sourceOffset: a.trimStart,
        sourceDuration,
        gain: options.gain,
        pan: 0,
        pitch: 0,
        reverse: false,
        mode: "gated",
        fadeIn: 0.004,
        fadeOut: 0.035,
        overlap: "allow",
        filter: { highpass: 180, lowpass: 8500 },
        ...(options.echo
          ? {
              effects: {
                delay: {
                  division: 0.5,
                  feedback: 0.16,
                  wet: 0.12,
                  cutoff: 4600,
                  pingPong: true,
                },
                reverb: { wet: 0.06, decay: 0.55, preDelay: 0.015 },
              },
            }
          : {}),
        provenance: {
          sourceName: a.originalFilename ?? a.name,
          sourceHash: a.hash ?? "",
          creator: "User-supplied source",
          credit: a.license,
        },
      };
      next.vocalEvents.push(event);
    }
    offset += section.bars * BAR;
  }
  if (next.vocalEvents.length > 128)
    throw new Error("This pattern exceeds the 128-event vocal lane limit.");
  return next;
}
