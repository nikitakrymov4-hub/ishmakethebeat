import { useEffect, useRef, useState } from "react";
import type { Project, Role } from "../engine/schema";
import {
  add321Bank,
  checked321Bank,
  is321Asset,
  KIT321_BANK_URL,
  KIT321_SOURCE_COUNT,
} from "../io/drum-kit-bank";
import "./DrumKitLibrary.css";

export default function DrumKitLibrary({
  project,
  role,
  onChange,
  onPreview,
}: {
  project: Project;
  role: Role;
  onChange: (project: Project, message: string) => void;
  onPreview: () => void;
}) {
  const latest = useRef(project);
  latest.current = project;
  const alive = useRef(true);
  const request = useRef<AbortController | null>(null);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      request.current?.abort();
    };
  }, []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState("");
  const sources = project.assets.filter(is321Asset);
  const source =
    sources.find((asset) => asset.id === selected) ??
    sources.find((asset) => asset.role === role) ??
    sources[0];
  const load = async () => {
    const start = latest.current;
    request.current?.abort();
    const abort = new AbortController();
    request.current = abort;
    setBusy(true);
    setError("");
    try {
      const response = await fetch(KIT321_BANK_URL, { signal: abort.signal });
      if (!response.ok)
        throw new Error(
          "The 321 kit is unavailable on this server. Open the local project containing the imported pack.",
        );
      const bank = await checked321Bank(await response.json());
      if (!alive.current || abort.signal.aborted) return;
      if (latest.current !== start)
        throw new Error(
          "The session changed during loading. Load the kit again in the current session.",
        );
      const result = add321Bank(start, bank);
      if (result.added)
        onChange(
          result.project,
          `321 kit: ${result.available} samples available. Choose a sound in the Instrument menu.`,
        );
    } catch (e) {
      if (alive.current && !abort.signal.aborted)
        setError((e as Error).message);
    } finally {
      if (alive.current && !abort.signal.aborted) setBusy(false);
    }
  };
  return (
    <div className="drum-kit-library">
      <h4>321 drumkit</h4>
      <p role="status">
        {sources.length} / {KIT321_SOURCE_COUNT} samples in this project
      </p>
      <button
        className="secondary"
        disabled={busy || sources.length === KIT321_SOURCE_COUNT}
        onClick={() => void load()}
      >
        {busy
          ? "Checking source files…"
          : sources.length === KIT321_SOURCE_COUNT
            ? "321 kit loaded · 9 samples"
            : "Add 321 kit samples"}
      </button>
      <small>
        Choose matching sounds in the Instrument menu after loading. Your
        current sounds and notes stay in place.
      </small>
      {error && (
        <p className="drum-kit-error" role="alert">
          {error}
        </p>
      )}
      {source && (
        <>
          <label>
            Preview 321 source
            <select
              aria-label="Preview 321 source"
              value={source.id}
              onChange={(e) => setSelected(e.target.value)}
            >
              {sources.map((asset) => (
                <option key={asset.id} value={asset.id}>
                  {asset.originalFilename ?? asset.name} · {asset.role}
                </option>
              ))}
            </select>
          </label>
          <audio
            key={source.id}
            controls
            preload="none"
            src={source.data}
            aria-label={`Preview original ${source.originalFilename ?? source.name}`}
            onPlay={(event) => {
              document.querySelectorAll("audio").forEach((audio) => {
                if (audio !== event.currentTarget) audio.pause();
              });
              onPreview();
            }}
          />
          <small>
            Original source playback, before project gain and effects.
          </small>
          {source.role === "bass" &&
            source.rootConfidence === 0 &&
            !source.manualOverride && (
              <p className="drum-kit-root-note">
                Source pitch needs confirmation. After choosing this bass in
                Instrument, set its Root MIDI in Sample setup before playing the
                beat.
              </p>
            )}
          {role === "hat" && !sources.some((asset) => asset.role === "hat") && (
            <small>
              This pack has an open-hat source; no closed-hat source was
              identified in its folders.
            </small>
          )}
          <details>
            <summary>Source and credit</summary>
            <p>{source.source}</p>
            <p>{source.license}</p>
          </details>
        </>
      )}
    </div>
  );
}
