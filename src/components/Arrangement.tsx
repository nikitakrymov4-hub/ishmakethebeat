import type { Project, Section } from "../engine/schema";
import { seconds, BAR } from "../engine/schema";
import Icon from "./Icon";
export default function Arrangement({
  project,
  onSections,
}: {
  project: Project;
  onSections: (s: Section[]) => void;
}) {
  const sections = project.sections,
    bars = sections.reduce((n, s) => n + s.bars, 0),
    duration = seconds(bars * BAR, project.settings.bpm);
  const change = (id: string, patch: Partial<Section>) =>
    onSections(sections.map((s) => (s.id === id ? { ...s, ...patch } : s)));
  const move = (i: number, d: number) => {
    const n = [...sections];
    [n[i], n[i + d]] = [n[i + d], n[i]];
    onSections(n);
  };
  let bar = 1;
  return (
    <div className="arrangement-editor">
      <div className="editor-toolbar">
        <span className="track-pill">Song structure</span>
        <span className="mono">
          {bars} bars · {Math.floor(duration / 60)}:
          {String(Math.round(duration % 60)).padStart(2, "0")}
        </span>
        <span className="hint">
          Entrances, dropouts, filtered edges, and a recognizable return.
        </span>
      </div>
      <div className="section-strip">
        {sections.map((s) => {
          const first = bar;
          bar += s.bars;
          return (
            <div
              className={`section-block ${s.kind}`}
              key={s.id}
              style={{ flexGrow: s.bars }}
            >
              <small>{String(first).padStart(2, "0")}</small>
              <strong>{s.name}</strong>
              <span>{s.bars} bars</span>
              <div className="section-lines">
                <i />
                <i />
                <i />
              </div>
            </div>
          );
        })}
      </div>
      <div className="section-table">
        {sections.map((s, i) => (
          <div className="section-row" key={s.id}>
            <input
              aria-label={`${s.name} section name`}
              value={s.name}
              onChange={(e) => change(s.id, { name: e.target.value })}
            />
            <select
              aria-label={`${s.name} section type`}
              value={s.kind}
              onChange={(e) =>
                change(s.id, { kind: e.target.value as Section["kind"] })
              }
            >
              {["intro", "hook", "verse", "break", "return", "outro"].map(
                (k) => (
                  <option key={k}>{k}</option>
                ),
              )}
            </select>
            <label>
              <input
                aria-label={`${s.name} bars`}
                type="number"
                min="1"
                max="64"
                value={s.bars}
                onChange={(e) =>
                  change(s.id, {
                    bars: Math.max(1, Math.min(64, +e.target.value)),
                  })
                }
              />{" "}
              bars
            </label>
            <button
              className="icon-button"
              aria-label={`Move ${s.name} left`}
              disabled={i === 0}
              onClick={() => move(i, -1)}
            >
              ←
            </button>
            <button
              className="icon-button"
              aria-label={`Move ${s.name} right`}
              disabled={i === sections.length - 1}
              onClick={() => move(i, 1)}
            >
              →
            </button>
            <button
              className="tiny-button"
              onClick={() =>
                onSections([
                  ...sections.slice(0, i + 1),
                  { ...s, id: crypto.randomUUID(), name: `${s.name} copy` },
                  ...sections.slice(i + 1),
                ])
              }
            >
              Duplicate
            </button>
            <button
              className="icon-button"
              aria-label={`Delete ${s.name}`}
              disabled={sections.length === 1}
              onClick={() => onSections(sections.filter((x) => x.id !== s.id))}
            >
              <Icon name="trash" size={14} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
