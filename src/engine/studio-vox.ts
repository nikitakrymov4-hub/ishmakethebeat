import { clone } from "./schema";
import type { Project } from "./schema";
import { rng } from "./random";
import { migrateLegacyTag } from "./score";
import { buildVoxPattern } from "../io/vox-pattern";
import { USER_KIT_ID } from "./user-kit";
export function withStudioVocals(original: Project): Project {
  const density = original.settings.voxDensity;
  if (!density) return original;
  const p = clone(original);
  p.vocalEvents = migrateLegacyTag(p);
  const random = rng(`${p.settings.seed}/supplied-vox-1`);
  const sources = p.assets
    .filter(
      (a) =>
        a.role === "vox" &&
        a.kitId === USER_KIT_ID &&
        a.duration !== undefined &&
        a.duration <= 4,
    )
    .map((a) => ({ a, tie: random() }))
    .sort((a, b) => a.tie - b.tie)
    .slice(0, 2)
    .map((x) => x.a.id);
  if (density !== "off" && !sources.length)
    throw new Error(
      "The attached kit vocal accents are unavailable. Choose accents off or reload the supplied bank.",
    );
  const next = buildVoxPattern(p, {
    assetIds: sources,
    seed: `${p.settings.seed}/vox`,
    density,
    placement: random() < 0.5 ? "gaps" : "pickups",
    gain: 0.2,
    echo: true,
  });
  if (density !== "off") next.voxEnabled = true;
  return next;
}
