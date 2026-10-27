/// <reference types="vite/client" />
import { verifySampledDrumPitch } from "./audio/verify-drum-pitch";
const sources = import.meta.glob<string>(
  ["./audio/*.ts", "./engine/*.ts", "./io/*.ts", "./drum-pitch-qa.ts"],
  { query: "?raw", import: "default", eager: true },
);
const run = document.querySelector<HTMLButtonElement>("#run")!;
const output = document.querySelector<HTMLPreElement>("#report")!;
const hash = async (text: string) =>
  Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
    ),
    (x) => x.toString(16).padStart(2, "0"),
  ).join("");
run.addEventListener("click", async () => {
  run.disabled = true;
  output.textContent = "Rendering actual test audio…";
  try {
    const report = await verifySampledDrumPitch();
    const engineFiles = await Promise.all(
      Object.entries(sources)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(async ([path, text]) => ({ path, sha256: await hash(text) })),
    );
    const proof = {
      ...report,
      engine: {
        snapshotSha256: await hash(JSON.stringify(engineFiles)),
        files: engineFiles,
      },
    };
    output.textContent = JSON.stringify(proof, null, 2);
    const name = `qa-drum-pitch-${Date.now()}/control/report.json`;
    const saved = await fetch(
      `/__benchmark-delivery-output?name=${encodeURIComponent(name)}`,
      {
        method: "POST",
        headers: { "If-None-Match": "*" },
        body: output.textContent,
      },
    );
    if (!saved.ok)
      throw new Error(
        `Checks passed; proof save failed: ${await saved.text()}`,
      );
    const link = document.createElement("a");
    link.href = `/deliverables/benchmark-delivery/${name}`;
    link.textContent = "Saved audio verification proof";
    document.querySelector("#saved")!.replaceChildren(link);
  } catch (error) {
    output.textContent += `\nERROR: ${(error as Error).stack ?? String(error)}`;
  } finally {
    run.disabled = false;
  }
});
