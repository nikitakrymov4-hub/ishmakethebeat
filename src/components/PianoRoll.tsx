import { useState } from "react";
import type { Note, Track } from "../engine/schema";
import { BAR, LOOP_TICKS, noteName } from "../engine/schema";
import { clamp } from "../engine/random";
import Icon from "./Icon";
export default function PianoRoll({
  track,
  onNotes,
  tick,
  guide,
}: {
  track: Track;
  onNotes: (notes: Note[]) => void;
  tick: number;
  guide?: { name: string; pitches: number[] };
}) {
  const [page, setPage] = useState(0),
    [grid, setGrid] = useState(120),
    [selected, setSelected] = useState<string | null>(null);
  const [drag, setDrag] = useState<{
    id: string;
    x: number;
    y: number;
    tick: number;
    pitch: number;
  } | null>(null);
  const bass = track.id === "bass",
    low = Math.min(bass ? 24 : 55, ...track.notes.map((n) => n.pitch)),
    high = Math.max(bass ? 49 : 90, ...track.notes.map((n) => n.pitch)),
    rows = high - low + 1,
    W = 960,
    H = 300,
    keyW = 48,
    start = page * BAR * 2,
    end = start + BAR * 2;
  const note = track.notes.find((n) => n.id === selected),
    visible = track.notes.filter((n) => n.tick >= start && n.tick < end);
  const update = (id: string, change: Partial<Note>) => {
    const notes = track.notes
      .map((n) => (n.id === id ? { ...n, ...change } : n))
      .sort((a, b) => a.tick - b.tick);
    onNotes(notes);
  };
  const pos = (ev: React.PointerEvent<SVGSVGElement>) => {
    const b = ev.currentTarget.getBoundingClientRect();
    return {
      x: ((ev.clientX - b.left) / b.width) * W,
      y: ((ev.clientY - b.top) / b.height) * H,
    };
  };
  return (
    <div className="piano-editor">
      <div className="editor-toolbar">
        {guide && (
          <span
            className="hint"
            aria-label={`Silent scale guide ${guide.name}`}
          >
            Silent guide: {guide.name}
          </span>
        )}
        <span className="track-pill">
          <i className={`dot ${bass ? "bass" : ""}`} />
          {track.name}
        </span>
        <div className="bar-pager">
          <button
            aria-label="Previous two bars"
            disabled={page === 0}
            onClick={() => setPage(page - 1)}
          >
            ‹
          </button>
          <span>
            Bars {page * 2 + 1}–{page * 2 + 2}
          </span>
          <button
            aria-label="Next two bars"
            disabled={page === 3}
            onClick={() => setPage(page + 1)}
          >
            ›
          </button>
        </div>
        <label>
          Snap{" "}
          <select
            aria-label="Piano roll quantization"
            value={grid}
            onChange={(e) => setGrid(+e.target.value)}
          >
            <option value={240}>1/8</option>
            <option value={120}>1/16</option>
            <option value={60}>1/32</option>
            <option value={160}>1/8 triplet</option>
          </select>
        </label>
        <span className="hint">
          Click to add · drag to move · double-click to erase
        </span>
      </div>
      <svg
        className="piano-grid"
        role="application"
        aria-label={`${track.name} piano roll`}
        viewBox={`0 0 ${W} ${H}`}
        onPointerDown={(e) => {
          if (
            (e.target as SVGElement).tagName === "rect" &&
            (e.target as SVGElement).dataset.note
          )
            return;
          const { x, y } = pos(e);
          if (x < keyW) return;
          const at =
              start +
              Math.floor((((x - keyW) / (W - keyW)) * BAR * 2) / grid) * grid,
            pitch = clamp(high - Math.floor((y / H) * rows), low, high),
            n: Note = {
              id: `edit-${crypto.randomUUID()}`,
              tick: at,
              duration: Math.min(grid * 2, LOOP_TICKS - at),
              pitch,
              velocity: 0.75,
            };
          onNotes([...track.notes, n].sort((a, b) => a.tick - b.tick));
          setSelected(n.id);
        }}
        onPointerMove={(e) => {
          if (!drag) return;
          const { x, y } = pos(e),
            dt =
              Math.round((((x - drag.x) / (W - keyW)) * BAR * 2) / grid) * grid,
            dp = Math.round(((drag.y - y) / H) * rows);
          update(drag.id, {
            tick: clamp(drag.tick + dt, 0, LOOP_TICKS - grid),
            pitch: clamp(drag.pitch + dp, low, high),
          });
        }}
        onPointerUp={() => setDrag(null)}
        onPointerLeave={() => setDrag(null)}
      >
        {Array.from({ length: rows }, (_, i) => {
          const pitch = high - i,
            black = [1, 3, 6, 8, 10].includes(pitch % 12);
          return (
            <g key={i}>
              <rect
                x="0"
                y={(i * H) / rows}
                width={W}
                height={H / rows}
                fill={
                  guide?.pitches.some((p) => p % 12 === pitch % 12)
                    ? black
                      ? "#1c2b22"
                      : "#233629"
                    : black
                      ? "#151a17"
                      : "#1a201c"
                }
              />
              <line
                x1={keyW}
                y1={(i * H) / rows}
                x2={W}
                y2={(i * H) / rows}
                stroke="#252d27"
                strokeWidth=".5"
              />
              <rect
                x="0"
                y={(i * H) / rows}
                width={keyW - 1}
                height={H / rows - 0.6}
                fill={black ? "#141815" : "#252e27"}
              />
              {pitch % 12 === 0 && (
                <text
                  x="9"
                  y={((i + 0.77) * H) / rows}
                  fill="#7c8c7f"
                  fontSize="8"
                >
                  {noteName(pitch)}
                </text>
              )}
            </g>
          );
        })}
        {Array.from({ length: Math.ceil((BAR * 2) / grid) + 1 }, (_, i) => {
          const x = keyW + ((i * grid) / (BAR * 2)) * (W - keyW);
          return (
            <line
              key={i}
              x1={x}
              y1="0"
              x2={x}
              y2={H}
              stroke={
                (i * grid) % BAR === 0
                  ? "#59694e"
                  : (i * grid) % 480 === 0
                    ? "#384237"
                    : "#242d25"
              }
              strokeWidth={(i * grid) % BAR === 0 ? 1.5 : 0.7}
            />
          );
        })}
        {visible.map((n) => (
          <g key={n.id}>
            <rect
              data-note={n.id}
              aria-label={`${noteName(n.pitch)} at tick ${n.tick}`}
              x={keyW + ((n.tick - start) / (BAR * 2)) * (W - keyW)}
              y={((high - n.pitch) * H) / rows + 0.6}
              width={Math.max(4, (n.duration / (BAR * 2)) * (W - keyW) - 1.5)}
              height={H / rows - 1.2}
              rx="1.5"
              fill={
                selected === n.id ? "#e1ffc5" : bass ? "#d7b789" : "#91bd88"
              }
              opacity={0.45 + n.velocity * 0.55}
              onPointerDown={(e) => {
                e.stopPropagation();
                const svg = e.currentTarget.ownerSVGElement!,
                  b = svg.getBoundingClientRect();
                setSelected(n.id);
                setDrag({
                  id: n.id,
                  x: ((e.clientX - b.left) / b.width) * W,
                  y: ((e.clientY - b.top) / b.height) * H,
                  tick: n.tick,
                  pitch: n.pitch,
                });
                e.currentTarget.setPointerCapture(e.pointerId);
              }}
              onDoubleClick={(e) => {
                e.stopPropagation();
                onNotes(track.notes.filter((x) => x.id !== n.id));
                setSelected(null);
              }}
            />
            {n.glide && (
              <text
                pointerEvents="none"
                x={keyW + ((n.tick - start) / (BAR * 2)) * (W - keyW) + 3}
                y={((high - n.pitch + 0.85) * H) / rows}
                fontSize="10"
                fill="#171b14"
              >
                ↗
              </text>
            )}
          </g>
        ))}
        {tick % LOOP_TICKS >= start && tick % LOOP_TICKS < end && (
          <line
            pointerEvents="none"
            x1={keyW + (((tick % LOOP_TICKS) - start) / (BAR * 2)) * (W - keyW)}
            x2={keyW + (((tick % LOOP_TICKS) - start) / (BAR * 2)) * (W - keyW)}
            y1="0"
            y2={H}
            stroke="#d7f7b1"
            strokeWidth="1.5"
          />
        )}
      </svg>
      <div className="note-inspector">
        {note ? (
          <>
            <span className="mono selected-note">{noteName(note.pitch)}</span>
            <label>
              Pitch{" "}
              <input
                aria-label="Note pitch"
                type="number"
                min="0"
                max="127"
                value={note.pitch}
                onChange={(e) =>
                  update(note.id, { pitch: clamp(+e.target.value, 0, 127) })
                }
              />
            </label>
            <label>
              Length{" "}
              <select
                aria-label="Note length"
                value={note.duration}
                onChange={(e) =>
                  update(note.id, {
                    duration: Math.min(+e.target.value, LOOP_TICKS - note.tick),
                  })
                }
              >
                {[60, 120, 160, 240, 360, 480, 960, 1920].includes(
                  note.duration,
                ) ? null : (
                  <option value={note.duration}>{note.duration} ticks</option>
                )}
                {[60, 120, 160, 240, 360, 480, 960, 1920].map((n) => (
                  <option key={n} value={n}>
                    {n} ticks
                  </option>
                ))}
              </select>
            </label>
            <label>
              Velocity{" "}
              <input
                aria-label="Note velocity"
                type="range"
                min=".05"
                max="1"
                step=".01"
                value={note.velocity}
                onChange={(e) => update(note.id, { velocity: +e.target.value })}
              />
              <span className="mono">{Math.round(note.velocity * 127)}</span>
            </label>
            {bass && (
              <>
                <label>
                  Attack
                  <select
                    aria-label="808 articulation"
                    value={note.articulation ?? "retrigger"}
                    onChange={(e) =>
                      update(note.id, {
                        articulation: e.target.value as Note["articulation"],
                      })
                    }
                  >
                    <option value="retrigger">Retrigger</option>
                    <option value="legato">
                      Continuous legato (adjacent note)
                    </option>
                  </select>
                </label>
                <label>
                  <input
                    type="checkbox"
                    aria-label="808 glide"
                    checked={!!note.glide}
                    onChange={(e) =>
                      update(note.id, {
                        glide: e.target.checked
                          ? {
                              to: note.pitch + 12,
                              at: Math.round(note.duration * 0.4),
                              ms: 90,
                            }
                          : undefined,
                      })
                    }
                  />
                  Glide
                </label>
                {note.glide && (
                  <>
                    <label>
                      To{" "}
                      <input
                        aria-label="Glide target pitch"
                        type="number"
                        value={note.glide.to}
                        onChange={(e) =>
                          update(note.id, {
                            glide: {
                              ...note.glide!,
                              to: clamp(+e.target.value, 0, 127),
                            },
                          })
                        }
                      />
                    </label>
                    <label>
                      ms{" "}
                      <input
                        aria-label="Glide duration"
                        type="number"
                        min="40"
                        max="160"
                        value={note.glide.ms}
                        onChange={(e) =>
                          update(note.id, {
                            glide: {
                              ...note.glide!,
                              ms: clamp(+e.target.value, 40, 160),
                            },
                          })
                        }
                      />
                    </label>
                  </>
                )}
              </>
            )}
            <button
              className="icon-button"
              aria-label="Delete note"
              onClick={() => {
                onNotes(track.notes.filter((n) => n.id !== note.id));
                setSelected(null);
              }}
            >
              <Icon name="trash" size={15} />
            </button>
          </>
        ) : (
          <span className="muted">
            Select a note to edit its length, velocity{bass ? ", or glide" : ""}
            .
          </span>
        )}
        <span className="tick-legend">480 PPQ · 4/4</span>
      </div>
    </div>
  );
}
