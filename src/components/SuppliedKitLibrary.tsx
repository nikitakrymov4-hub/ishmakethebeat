import { useEffect, useRef, useState } from "react";
import type { Project } from "../engine/schema";
import { USER_KIT_ID } from "../engine/user-kit";
import {
  addUserDrumBank,
  rememberUserDrums,
  USER_DRUM_BANK_URL,
} from "../io/user-drum-bank";

export default function SuppliedKitLibrary({
  project,
  onChange,
  onPreview,
}: {
  project: Project;
  onChange: (next: Project, message: string) => void;
  onPreview: () => void;
}) {
  const latest = useRef(project);
  latest.current = project;
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [selected, setSelected] = useState("");
  const sources = project.assets.filter(
    (a) => a.kitId === USER_KIT_ID && a.role !== "vox" && a.role !== "tag",
  );
  const source = sources.find((a) => a.id === selected) ?? sources[0];
  const load = async () => {
    const start = latest.current;
    abort.current?.abort();
    const request = new AbortController();
    abort.current = request;
    setBusy(true);
    setError("");
    try {
      const response = await fetch(USER_DRUM_BANK_URL, {
        signal: request.signal,
      });
      if (!response.ok)
        throw new Error(
          "The attached stash bank is unavailable on this local server.",
        );
      const data: unknown = await response.json();
      if (request.signal.aborted) return;
      if (latest.current !== start)
        throw new Error(
          "The session changed while loading. Add the stash again in the current session.",
        );
      const next = addUserDrumBank(start, data);
      rememberUserDrums(next.project.assets);
      onChange(
        next.project,
        `${next.added} stash sources added. Notes, source choices and mix retained.`,
      );
    } catch (error) {
      if (!request.signal.aborted) setError((error as Error).message);
    } finally {
      if (!request.signal.aborted) setBusy(false);
    }
  };
  return (
    <div className="drum-kit-library">
      <h4>Attached stash</h4>
      <p>{sources.length} / 53 drum and 808 sources in this project</p>
      <button
        className="secondary"
        disabled={busy || sources.length === 53}
        onClick={() => void load()}
      >
        {busy ? "Checking source bytes…" : "Add all 53 stash drums"}
      </button>
      <small>
        Original WAV bytes, with source credits retained. Bass roots are
        estimates; use the tuning controls to adjust. FST presets are preserved
        as files and are not executed.
      </small>
      {error && <p role="alert">{error}</p>}
      {source && (
        <>
          <label>
            Preview original stash source
            <select
              aria-label="Preview stash source"
              value={source.id}
              onChange={(event) => setSelected(event.target.value)}
            >
              {sources.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.originalFilename ?? a.name} · {a.role}
                </option>
              ))}
            </select>
          </label>
          <audio
            controls
            preload="none"
            src={source.data}
            aria-label="Preview original stash audio"
            onPlay={(event) => {
              document.querySelectorAll("audio").forEach((a) => {
                if (a !== event.currentTarget) a.pause();
              });
              onPreview();
            }}
          />
        </>
      )}
    </div>
  );
}
