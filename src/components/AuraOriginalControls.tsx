import { useRef, useState } from "react";
import type { Project, Settings, Role } from "../engine/schema";
import { clone } from "../engine/schema";
import { getPrivatePalette } from "../engine/culture";
import { newAuraProject } from "../engine/aura-writing";
import type { AuraDirection, AuraFeel } from "../engine/aura-writing";
import {
  AURA_PALETTES,
  loadAuraPalette,
  loadAuraCatalog,
  auraAsset,
  auraUrl,
  applyAuraPalette,
} from "../io/aura-bank";
import type { AuraPalette, AuraCatalog } from "../io/aura-bank";
export default function AuraOriginalControls({
  project,
  settings,
  onCommit,
}: {
  project: Project;
  settings: Settings;
  onCommit: (p: Project, message: string) => void;
}) {
  const [palette, setPalette] = useState<AuraPalette>("piano-wind"),
    [direction, setDirection] = useState<AuraDirection>("cascade"),
    [feel, setFeel] = useState<AuraFeel>("interrupted"),
    [ack, setAck] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [catalog, setCatalog] = useState<AuraCatalog | null>(null),
    [role, setRole] = useState<Role>("melody"),
    [source, setSource] = useState("");
  const live = useRef(project);
  live.current = project;
  async function run(action: "create" | "palette" | "catalog" | "source") {
    setBusy(true);
    setError("");
    const before = project;
    try {
      if (action === "catalog") {
        const c = await loadAuraCatalog();
        setCatalog(c);
        setSource(c.entries[0].id);
        return;
      }
      if (action === "source") {
        const e = catalog?.entries.find((e) => e.id === source);
        if (!e) throw new Error("Choose a catalog source first");
        const track = before.candidates[before.selected].tracks.find(
          (t) => t.id === role,
        );
        if (!track) throw new Error("Role absent");
        if (track.locked)
          throw new Error("Unlock the role before changing its sound");
        const response = await fetch(auraUrl(e));
        if (!response.ok) throw new Error("Private source missing: " + e.name);
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.length > 24_000_000) throw new Error("Source too large");
        const a = await auraAsset(e, role, bytes, catalog!.licenseSummary),
          next = clone(before);
        if (!next.assets.some((x) => x.id === a.id)) next.assets.push(a);
        next.candidates[next.selected].tracks.find(
          (t) => t.id === role,
        )!.instrument = a.id;
        if (live.current !== before)
          throw new Error(
            "Session changed while loading; nothing was applied.",
          );
        onCommit(
          next,
          "Private Aura source applied without rewriting notes. Root/cents remain provisional.",
        );
        return;
      }
      const loaded = await loadAuraPalette(palette, before.assets);
      setCatalog(loaded.catalog);
      const assets = [
        ...loaded.assets,
        ...before.assets,
        ...getPrivatePalette(),
      ].filter((a, i, all) => all.findIndex((x) => x.id === a.id) === i);
      const next =
        action === "palette"
          ? applyAuraPalette(before, palette, loaded.selection, loaded.assets)
          : newAuraProject(
              settings,
              { version: 1, palette, direction, feel },
              loaded.selection,
              assets,
            );
      if (live.current !== before)
        throw new Error("Session changed while loading; nothing was applied.");
      onCommit(
        next,
        action === "palette"
          ? "Aura palette changed; notes, locks and arrangement preserved."
          : "New 80-bar Aura original draft created. Undo restores prior session. Listening and tuning review required.",
      );
      setAck(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <details className="legacy-profiles">
      <summary>Aura from-scratch · opt-in private draft</summary>
      <p>
        New sampled notes, not a musical loop. No TDF-accuracy claim. Private
        sources only; root/cents provisional. No raw-sample redistribution.
      </p>
      <label>
        Sample palette
        <select
          aria-label="Aura palette"
          value={palette}
          onChange={(e) => setPalette(e.target.value as AuraPalette)}
        >
          {Object.entries(AURA_PALETTES).map(([id, p]) => (
            <option key={id} value={id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        Writing
        <select
          aria-label="Aura writing direction"
          value={direction}
          onChange={(e) => setDirection(e.target.value as AuraDirection)}
        >
          <option value="cascade">Cascading key calls / longer replies</option>
          <option value="angular">Angular lead / lower ground</option>
        </select>
      </label>
      <label>
        Drum feel
        <select
          aria-label="Aura drum feel"
          value={feel}
          onChange={(e) => setFeel(e.target.value as AuraFeel)}
        >
          <option value="interrupted">Interrupted grouped cell</option>
          <option value="pulse">Continuous pulse / sparse replies</option>
        </select>
      </label>
      <p>
        Uses current starting-point seed/key/mode/tempo. 80 bars = 128 seconds
        music at 150 BPM. Intro, contrast, handoff, return and ending; no
        autoplay.
      </p>
      <label>
        <input
          type="checkbox"
          aria-label="Accept new Aura session replacement"
          checked={ack}
          onChange={(e) => setAck(e.target.checked)}
        />{" "}
        Export current session first or accept replacing it with a NEW draft
        (Undo available).
      </label>
      <button
        className="secondary"
        disabled={!ack || busy}
        onClick={() => void run("create")}
      >
        {busy
          ? "Loading private sources…"
          : "Create new Aura original · 80 bars"}
      </button>
      <button
        className="secondary"
        disabled={!project.auraOriginal || busy}
        onClick={() => void run("palette")}
      >
        Swap Aura palette · keep notes / locks
      </button>
      <p>
        Existing Generate remains legacy. This explicit action creates an Aura
        song. Edit base notes in the piano roll; Arrangement develops their
        delivery.
      </p>
      <button
        className="secondary"
        disabled={busy}
        onClick={() => void run("catalog")}
      >
        Browse curated private Aura sources
      </button>
      {catalog && (
        <>
          <label>
            Target role
            <select
              aria-label="Aura source role"
              value={role}
              onChange={(e) => setRole(e.target.value as Role)}
            >
              {["melody", "keys", "answer", "pad"].map((r) => (
                <option key={r}>{r}</option>
              ))}
            </select>
          </label>
          <label>
            Playable source
            <select
              aria-label="Aura playable source"
              value={source}
              onChange={(e) => setSource(e.target.value)}
            >
              <option value="">Choose a source</option>
              {catalog.entries.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name} · root {e.rootMidi}, {e.tuningCents.toFixed(1)}¢
                  provisional
                </option>
              ))}
            </select>
          </label>
          <button
            className="secondary"
            disabled={busy || !source}
            onClick={() => void run("source")}
          >
            Apply Aura source · notes unchanged
          </button>
          <small>
            Slow pads require long gates. Existing Instrument controls edit
            root/cents, trim and envelope; original WAVs remain unchanged.
          </small>
        </>
      )}
      {error && <p role="alert">{error}</p>}
    </details>
  );
}
