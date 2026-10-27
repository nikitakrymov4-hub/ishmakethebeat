import type { Project } from "../engine/schema";
import { clone } from "../engine/schema";

export default function MixControls({
  project,
  onChange,
}: {
  project: Project;
  onChange: (next: Project) => void;
}) {
  const duck = project.mixPass?.duck ?? {
    depthDb: 0,
    attack: 0.004,
    release: 0.08,
  };
  const change = (patch: Partial<typeof duck>) => {
    const next = clone(project);
    next.mixPass = {
      version: "balance-1",
      changes: project.mixPass?.changes ?? [],
      duck: { ...duck, ...patch },
    };
    onChange(next);
  };
  return (
    <details>
      <summary>Kick / bass separation</summary>
      <small>
        Short bass gain dips at overlapping kick hits. Saved with the project
        and shared by playback and export. Set depth to 0 to bypass.
      </small>
      <label>
        Duck depth · {duck.depthDb.toFixed(1)} dB
        <input
          aria-label="Bass duck depth"
          type="range"
          min="0"
          max="9"
          step="0.5"
          value={duck.depthDb}
          onChange={(event) => change({ depthDb: +event.target.value })}
        />
      </label>
      <label>
        Attack · {Math.round(duck.attack * 1000)} ms
        <input
          aria-label="Bass duck attack"
          type="range"
          min="1"
          max="30"
          step="1"
          value={duck.attack * 1000}
          onChange={(event) => change({ attack: +event.target.value / 1000 })}
        />
      </label>
      <label>
        Recovery · {Math.round(duck.release * 1000)} ms
        <input
          aria-label="Bass duck recovery"
          type="range"
          min="10"
          max="300"
          step="5"
          value={duck.release * 1000}
          onChange={(event) => change({ release: +event.target.value / 1000 })}
        />
      </label>
      {project.mixPass && (
        <p className="control-note">{project.mixPass.changes.join(" · ")}</p>
      )}
    </details>
  );
}
