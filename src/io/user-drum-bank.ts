import type { SampleAsset, Project } from "../engine/schema";
import { clone } from "../engine/schema";
import { USER_KIT_ID, USER_KIT_HASH_ROLES } from "../engine/user-kit";
import { isPermittedTdfDrum } from "../engine/tdf-kit";
import { validateProject } from "./persistence";
import { getPrivatePalette, setPrivatePalette } from "../engine/culture";
export const USER_DRUM_BANK_URL =
  "/private-assets/user-tdf-full-drums-20261016.json";
/** Keep manually selected verified stash sources available to regeneration after reload. */
export function rememberUserDrums(assets: SampleAsset[]) {
  const palette = getPrivatePalette();
  for (const a of assets)
    if (isPermittedTdfDrum(a) && !palette.some((old) => old.id === a.id))
      palette.push(clone(a));
  setPrivatePalette(palette);
}
export function checkedUserDrumBank(input: unknown): SampleAsset[] {
  if (!Array.isArray(input) || input.length !== 53)
    throw new Error("The attached stash must contain its 53 drum/808 sources.");
  const seen = new Set<string>();
  for (const a of input as SampleAsset[]) {
    if (
      !a ||
      a.kitId !== USER_KIT_ID ||
      !a.hash ||
      seen.has(a.hash) ||
      !USER_KIT_HASH_ROLES[a.hash]?.includes(a.role) ||
      !isPermittedTdfDrum(a)
    )
      throw new Error(
        "Attached stash source bytes or role do not match the supplied archive.",
      );
    seen.add(a.hash);
  }
  return clone(input as SampleAsset[]);
}
export function addUserDrumBank(original: Project, bank: unknown) {
  const p = clone(original);
  let added = 0;
  for (const a of checkedUserDrumBank(bank)) {
    const old = p.assets.find((x) => x.id === a.id);
    if (old) {
      if (old.hash !== a.hash || old.data !== a.data)
        throw new Error(
          `Existing source conflicts with ${a.name}; nothing was changed.`,
        );
      continue;
    }
    p.assets.push(a);
    added++;
  }
  validateProject(p);
  return { project: p, added };
}
