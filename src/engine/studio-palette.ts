import type { Project, Role, SampleAsset, Settings } from "./schema";
import { clone, isDrum } from "./schema";
import { USER_KIT_HASH_ROLES, USER_KIT_ID } from "./user-kit";
import { isPermittedTdfDrum, tdfDrumInstrument } from "./tdf-kit";
export { USER_KIT_ID } from "./user-kit";
const fallback: Record<string, string> = {
  bass: "textured-808",
  kick: "felt-kick",
  clap: "dry-clap",
  hat: "short-hat",
  open: "air-hat",
  perc: "wood",
};
const names = [
  {
    bass: "go-to tdf sub",
    clap: "basic clap",
    hat: "coupe hat",
    perc: "lighter perc",
  },
  {
    bass: "jenga 808",
    clap: "water clap",
    hat: "dolly hat",
    perc: "benjicold perc",
  },
  {
    bass: "late night drinks 808",
    clap: "jenga clap",
    hat: "today hat",
    perc: "tdf glass sfx",
  },
];
export function suppliedDrum(
  settings: Pick<Settings, "drumKitId" | "allowSynthFallback">,
  assets: SampleAsset[],
  role: Role,
  group: number,
  retained?: string,
) {
  if (settings.drumKitId !== USER_KIT_ID) return undefined;
  // The attached kit has no kick/open-hat source. Keep an existing verified
  // source assigned; no notes are removed and no synthesized fallback is used.
  if (role === "kick" || role === "open") {
    const inactive =
      assets.find(
        (a) => a.id === retained && a.role === role && isPermittedTdfDrum(a),
      ) ?? assets.find((a) => a.role === role && isPermittedTdfDrum(a));
    if (!inactive && settings.allowSynthFallback) return fallback[role];
    if (!inactive)
      throw new Error(
        `The inactive ${role} lane needs an existing verified source assignment.`,
      );
    return inactive.id;
  }
  const previous = assets.find((a) => a.id === retained);
  if (
    previous &&
    USER_KIT_HASH_ROLES[previous.hash ?? ""]?.includes(role) &&
    previous.role === role &&
    isPermittedTdfDrum(previous)
  )
    return previous.id;
  if (
    retained &&
    !previous &&
    settings.allowSynthFallback &&
    retained === fallback[role]
  )
    return retained;
  if (retained && (!previous || !isPermittedTdfDrum(previous)))
    throw new Error(
      `${role}: lock your manual sound before generating, or select a verified supplied kit source.`,
    );
  const token = names[group % 3][role as "bass" | "clap" | "hat" | "perc"];
  const chosen = assets.find(
    (a) =>
      a.kitId === USER_KIT_ID &&
      a.role === role &&
      a.name.toLowerCase().includes(token),
  );
  if (!chosen && settings.allowSynthFallback) return fallback[role];
  if (!chosen)
    throw new Error(
      `Supplied TDF stash ${role} is unavailable. Reload the attached kit; no substitute sound was generated.`,
    );
  return tdfDrumInstrument(assets, role, [chosen.name]);
}

/** Change only unlocked sources on the selected idea; no score rewrite. */
export function applyDrumKit(
  original: Project,
  palette: SampleAsset[],
  kitId: string,
): Project {
  const p = clone(original);
  for (const a of palette)
    if (!p.assets.some((old) => old.id === a.id)) p.assets.push(clone(a));
  p.settings.drumKitId = kitId;
  const oldKit = p.assets.filter((a) => !USER_KIT_HASH_ROLES[a.hash ?? ""]);
  for (const track of p.candidates[p.selected].tracks) {
    if (track.locked || !(track.id === "bass" || isDrum(track.id))) continue;
    track.instrument =
      kitId === USER_KIT_ID
        ? suppliedDrum(
            p.settings,
            p.assets,
            track.id,
            p.selected,
            ["kick", "open"].includes(track.id) ? track.instrument : undefined,
          )!
        : tdfDrumInstrument(oldKit, track.id, []);
  }
  return p;
}
