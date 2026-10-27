import { useState } from "react";
import type { Note, Track, Role } from "../engine/schema";
import { BAR } from "../engine/schema";
import { DRUM_ROLES } from "../engine/compose";
export default function DrumEditor({
  tracks,
  onNotes,
  tick,
  sampleIds,
}: {
  tracks: Track[];
  onNotes: (r: Role, notes: Note[]) => void;
  tick: number;
  sampleIds: string[];
}) {
  const [page, setPage] = useState(0),
    [grid, setGrid] = useState(120),
    [selected, setSelected] = useState<{ role: Role; id: string } | null>(null),
    steps = (BAR * 2) / grid;
  const current = tracks
    .find((t) => t.id === selected?.role)
    ?.notes.find((n) => n.id === selected?.id);
  return (
    <div className="drum-editor">
      <div className="editor-toolbar">
        <span className="track-pill">Two-bar groove</span>
        <div className="bar-pager">
          <button disabled={!page} onClick={() => setPage(page - 1)}>
            ‹
          </button>
          <span>
            Bars {page * 2 + 1}–{page * 2 + 2}
          </span>
          <button disabled={page === 3} onClick={() => setPage(page + 1)}>
            ›
          </button>
        </div>
        <label>
          Grid{" "}
          <select
            aria-label="Drum subdivision"
            value={grid}
            onChange={(e) => setGrid(+e.target.value)}
          >
            <option value={120}>1/16</option>
            <option value={60}>1/32 fill</option>
            <option value={160}>1/8 triplet</option>
          </select>
        </label>
        <span className="hint">
          Click to toggle · right-click to edit a hit
        </span>
      </div>
      <div className="step-scroll">
        <div
          className="step-ruler"
          style={{
            gridTemplateColumns: `112px repeat(${steps},minmax(17px,1fr))`,
          }}
        >
          <span />
          {Array.from({ length: steps }, (_, i) => (
            <span key={i}>
              {(i * grid) % 480 === 0
                ? (Math.floor((i * grid) / 480) % 4) + 1
                : "·"}
            </span>
          ))}
        </div>
        {DRUM_ROLES.map((role) => {
          const t = tracks.find((t) => t.id === role)!;
          return (
            <div
              className="step-row"
              key={role}
              style={{
                gridTemplateColumns: `112px repeat(${steps},minmax(17px,1fr))`,
              }}
            >
              <strong>{t.name}</strong>
              {Array.from({ length: steps }, (_, i) => {
                const at = page * BAR * 2 + i * grid,
                  n = t.notes.find((n) => Math.abs(n.tick - at) < 20);
                return (
                  <button
                    key={i}
                    aria-label={`${t.name} step ${i + 1}`}
                    title={
                      n
                        ? `Velocity ${Math.round(n.velocity * 127)} · pitch ${n.drumPitch ?? 0} st · right-click to edit`
                        : "Add hit"
                    }
                    className={`step ${n ? "on" : ""} ${(i * grid) % 480 === 0 ? "beat" : ""} ${Math.floor(tick / grid) === Math.floor(at / grid) ? "playing" : ""}`}
                    style={
                      { "--velocity": n?.velocity ?? 0 } as React.CSSProperties
                    }
                    onClick={() => {
                      if (n)
                        onNotes(
                          role,
                          t.notes.filter((x) => x.id !== n.id),
                        );
                      else {
                        const note: Note = {
                          id: `drum-${crypto.randomUUID()}`,
                          tick: at,
                          pitch: (
                            {
                              kick: 36,
                              clap: 39,
                              hat: 42,
                              open: 46,
                              perc: 37,
                            } as Record<string, number>
                          )[role],
                          duration: Math.min(grid * 0.65, 90),
                          velocity: 0.72,
                        };
                        onNotes(
                          role,
                          [...t.notes, note].sort((a, b) => a.tick - b.tick),
                        );
                        setSelected({ role, id: note.id });
                      }
                    }}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      if (n) setSelected({ role, id: n.id });
                    }}
                  >
                    <i />
                  </button>
                );
              })}
            </div>
          );
        })}
      </div>
      <div className="note-inspector">
        {current && selected ? (
          <>
            <span>Selected hit</span>
            <label>
              Velocity{" "}
              <input
                aria-label="Drum hit velocity"
                type="range"
                min=".05"
                max="1"
                step=".01"
                value={current.velocity}
                onChange={(e) => {
                  const t = tracks.find((t) => t.id === selected.role)!;
                  onNotes(
                    t.id,
                    t.notes.map((n) =>
                      n.id === current.id
                        ? { ...n, velocity: +e.target.value }
                        : n,
                    ),
                  );
                }}
              />
              {Math.round(current.velocity * 127)}
            </label>
            {sampleIds.includes(
              tracks.find((t) => t.id === selected.role)!.instrument,
            ) ? (
              <label>
                Linked pitch / speed (semitones)
                <input
                  aria-label="Drum hit pitch in semitones"
                  type="number"
                  min="-24"
                  max="24"
                  step="0.1"
                  value={current.drumPitch ?? 0}
                  onChange={(event) => {
                    const value = Number(event.target.value);
                    if (!Number.isFinite(value)) return;
                    const track = tracks.find((t) => t.id === selected.role)!;
                    onNotes(
                      track.id,
                      track.notes.map((note) =>
                        note.id === current.id
                          ? {
                              ...note,
                              drumPitch: Math.max(-24, Math.min(24, value)),
                            }
                          : note,
                      ),
                    );
                  }}
                />
                <small>
                  0 keeps the source pitch. Faster playback also shortens the
                  sample.
                </small>
              </label>
            ) : (
              <span className="muted">
                Select a sample instrument to pitch individual hits.
              </span>
            )}
          </>
        ) : (
          <span className="muted">
            Closed hats choke open hats. Triplets and rolls retain exact tick
            timing.
          </span>
        )}
      </div>
    </div>
  );
}
