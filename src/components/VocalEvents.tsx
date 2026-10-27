import { useEffect, useRef, useState } from "react";
import type {
  Project,
  RoleEffects,
  SampleAsset,
  VocalEvent,
} from "../engine/schema";
import { BAR, PPQ, clone } from "../engine/schema";
import { migrateLegacyTag, vocalEventIssues } from "../engine/score";
import { importSample, validateProject } from "../io/persistence";
import { buildVoxPattern, isVoxAccentAsset } from "../io/vox-pattern";
import type { VoxPatternOptions } from "../io/vox-pattern";
import "./VocalEvents.css";

const delayDefault = {
  division: 0.5,
  feedback: 0.2,
  wet: 0,
  cutoff: 5000,
  pingPong: false,
};
const reverbDefault = { wet: 0, decay: 1.2, preDelay: 0.015 };

// Commit on blur/Enter so typing a number or credit makes one undo step.
function NumberField({
  label,
  value,
  onChange,
  min,
  max,
  step = 0.01,
  disabled = false,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  min: number;
  max: number;
  step?: number;
  disabled?: boolean;
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  return (
    <label>
      {label}
      <input
        type="number"
        value={draft}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={(e) => {
          const parsed =
            e.target.value.trim() === "" ? NaN : Number(e.target.value);
          const n = step === 1 ? Math.round(parsed) : parsed;
          const next = Number.isFinite(n)
            ? Math.max(min, Math.min(max, n))
            : value;
          setDraft(String(next));
          if (next !== value) onChange(next);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "Escape") {
            e.currentTarget.value = String(value);
            setDraft(String(value));
            e.currentTarget.blur();
          }
        }}
      />
    </label>
  );
}

function TextField({
  label,
  value,
  onChange,
  maxLength = 240,
  allowEmpty = true,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  maxLength?: number;
  allowEmpty?: boolean;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <label>
      {label}
      <input
        value={draft}
        maxLength={maxLength}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={(e) => {
          if (!allowEmpty && !e.target.value.trim()) {
            setDraft(value);
            return;
          }
          if (e.target.value !== value) onChange(e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "Escape") {
            e.currentTarget.value = value;
            setDraft(value);
            e.currentTarget.blur();
          }
        }}
      />
    </label>
  );
}

function newEvent(
  asset: SampleAsset,
  role: VocalEvent["role"],
  bpm: number,
): VocalEvent {
  const end = asset.duration ?? asset.trimEnd;
  const start = Math.max(0, Math.min(3600, asset.trimStart, end - 0.001));
  const length = Math.min(
    3600,
    Math.max(0.001, Math.min(asset.trimEnd, end) - start),
  );
  return {
    id: crypto.randomUUID(),
    name: asset.name,
    assetId: asset.id,
    role,
    enabled: true,
    placement: { kind: "absolute", tick: 0 },
    duration: Math.min(
      BAR * 512,
      Math.max(1, Math.round(((length * bpm) / 60) * PPQ)),
    ),
    sourceOffset: start,
    sourceDuration: length,
    gain: 1,
    pan: 0,
    pitch: 0,
    reverse: false,
    mode: "one-shot",
    fadeIn: 0.003,
    fadeOut: 0.008,
    overlap: "allow",
    provenance: {
      sourceName: asset.originalFilename ?? asset.name,
      sourceHash: asset.hash ?? "",
      creator: "User supplied",
      credit: asset.license,
    },
  };
}

function EventEditor({
  event,
  project,
  onChange,
  onRemove,
  issues,
  onPreview,
}: {
  event: VocalEvent;
  project: Project;
  onChange: (patch: Partial<VocalEvent>) => void;
  onRemove: () => void;
  issues: string[];
  onPreview?: () => void;
}) {
  const asset = project.assets.find((a) => a.id === event.assetId);
  const sourceEnd = asset?.duration ?? asset?.trimEnd ?? 3600;
  const placement = event.placement;
  const section =
    placement.kind === "section"
      ? project.sections.find((s) => s.id === placement.sectionId)
      : undefined;
  const bar = Math.floor(placement.tick / BAR) + 1;
  const beat = (placement.tick % BAR) / PPQ + 1;
  const fx = event.effects ?? {};
  const delay = fx.delay ?? delayDefault;
  const reverb = fx.reverb ?? reverbDefault;
  const filter = event.filter ?? { highpass: 20, lowpass: 20000 };
  const setFX = (patch: Partial<RoleEffects>) =>
    onChange({ effects: { ...fx, ...patch } });
  const muted =
    !event.enabled ||
    (event.role === "tag" ? !project.tagEnabled : project.voxEnabled === false);
  const rate = 2 ** ((event.pitch + (asset?.tuning ?? 0) / 100) / 12);
  const naturalLength = event.sourceDuration / rate;
  const gateLength = ((event.duration / PPQ) * 60) / project.settings.bpm;
  const playedLength =
    event.mode === "gated"
      ? Math.min(naturalLength, gateLength)
      : naturalLength;
  const repeat = event.repeats ?? { count: 0, intervalTicks: PPQ };
  const options = project.assets.filter(
    (a) => a.role === "tag" || a.role === "vox" || a.id === event.assetId,
  );
  return (
    <article
      className={`vocal-event ${muted ? "vocal-event-muted" : ""}`}
      aria-label={`${event.name} vocal event`}
    >
      <header className="vocal-event-header">
        <label className="vocal-check">
          <input
            type="checkbox"
            checked={event.enabled}
            onChange={(e) => onChange({ enabled: e.target.checked })}
          />{" "}
          Enabled
        </label>
        <span className="vocal-event-state">
          {muted ? "Muted" : event.role === "tag" ? "Tag" : "Vox"}
        </span>
        <button
          className="tiny-button"
          onClick={onRemove}
          aria-label={`Remove ${event.name}`}
        >
          Remove event
        </button>
      </header>
      {issues.length > 0 && (
        <ul className="vocal-issues" role="alert">
          {issues.map((message) => (
            <li key={message}>{message}</li>
          ))}
        </ul>
      )}
      <div className="vocal-grid">
        <TextField
          label="Event name"
          value={event.name}
          allowEmpty={false}
          onChange={(name) => onChange({ name })}
        />
        <label>
          Event type
          <select
            value={event.role}
            onChange={(e) =>
              onChange({ role: e.target.value as VocalEvent["role"] })
            }
          >
            <option value="tag">Producer tag</option>
            <option value="vox">Sampled vox</option>
          </select>
        </label>
        <label className="vocal-wide">
          Audio asset
          <select
            value={event.assetId}
            onChange={(e) => {
              const next = project.assets.find((a) => a.id === e.target.value);
              if (!next) return;
              const defaults = newEvent(next, event.role, project.settings.bpm);
              onChange({
                assetId: next.id,
                sourceOffset: defaults.sourceOffset,
                sourceDuration: defaults.sourceDuration,
                provenance: defaults.provenance,
              });
            }}
          >
            {!asset && (
              <option value={event.assetId}>
                Missing asset: {event.assetId}
              </option>
            )}
            {options.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Place relative to
          <select
            value={placement.kind}
            onChange={(e) => {
              if (e.target.value === "absolute")
                onChange({
                  placement: { kind: "absolute", tick: placement.tick },
                });
              else if (project.sections[0])
                onChange({
                  placement: {
                    kind: "section",
                    sectionId: project.sections[0].id,
                    tick: placement.tick,
                  },
                });
            }}
          >
            <option value="absolute">Song start</option>
            <option value="section" disabled={!project.sections.length}>
              Section start
            </option>
          </select>
        </label>
        {placement.kind === "section" ? (
          <label>
            Section
            <select
              value={placement.sectionId}
              onChange={(e) =>
                onChange({
                  placement: { ...placement, sectionId: e.target.value },
                })
              }
            >
              {!section && (
                <option value={placement.sectionId}>
                  Missing section: {placement.sectionId}
                </option>
              )}
              {project.sections.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} · {s.bars} bars
                </option>
              ))}
            </select>
          </label>
        ) : (
          <div className="vocal-field-note">
            Song positions stay fixed when sections move.
          </div>
        )}
        <NumberField
          label={
            placement.kind === "section" ? "Bar within section" : "Song bar"
          }
          value={bar}
          min={1}
          max={512}
          step={1}
          onChange={(n) =>
            onChange({
              placement: {
                ...placement,
                tick: (Math.round(n) - 1) * BAR + (placement.tick % BAR),
              },
            })
          }
        />
        <NumberField
          label="Beat within bar (1-based)"
          value={beat}
          min={1}
          max={1 + (BAR - 1) / PPQ}
          step={0.0625}
          onChange={(n) =>
            onChange({
              placement: {
                ...placement,
                tick:
                  (bar - 1) * BAR +
                  Math.min(BAR - 1, Math.round((n - 1) * PPQ)),
              },
            })
          }
        />
      </div>
      {!project.arrangement && placement.kind === "section" && (
        <p className="vocal-notice">
          Section events play in Song mode. Switch the transport to Song to hear
          this placement.
        </p>
      )}
      <details className="vocal-detail" open>
        <summary>
          Trim, length & level{" "}
          <span>{playedLength.toFixed(2)} s before effect tails</span>
        </summary>
        <div className="vocal-grid">
          <NumberField
            label="Source start (seconds)"
            value={event.sourceOffset}
            min={0}
            max={Math.min(3600, Math.max(0, sourceEnd - 0.001))}
            step={0.001}
            onChange={(sourceOffset) =>
              onChange({
                sourceOffset,
                sourceDuration: Math.max(
                  0.001,
                  Math.min(event.sourceDuration, sourceEnd - sourceOffset),
                ),
              })
            }
          />
          <NumberField
            label="Source length (seconds)"
            value={event.sourceDuration}
            min={0.001}
            max={Math.min(
              3600,
              Math.max(0.001, sourceEnd - event.sourceOffset),
            )}
            step={0.001}
            onChange={(sourceDuration) => onChange({ sourceDuration })}
          />
          <label>
            Playback mode
            <select
              value={event.mode}
              onChange={(e) =>
                onChange({ mode: e.target.value as VocalEvent["mode"] })
              }
            >
              <option value="one-shot">One-shot · play trimmed region</option>
              <option value="gated">Gated · limit by beat length</option>
            </select>
          </label>
          <NumberField
            label="Gate length (beats)"
            value={event.duration / PPQ}
            min={1 / PPQ}
            max={2048}
            step={0.25}
            disabled={event.mode !== "gated"}
            onChange={(n) => onChange({ duration: Math.round(n * PPQ) })}
          />
          <NumberField
            label="Event gain (0–1)"
            value={event.gain}
            min={0}
            max={1}
            onChange={(gain) => onChange({ gain })}
          />
          <NumberField
            label="Pan (−1 left, 1 right)"
            value={event.pan}
            min={-1}
            max={1}
            onChange={(pan) => onChange({ pan })}
          />
          <NumberField
            label="Linked pitch / speed (semitones)"
            value={event.pitch}
            min={-24}
            max={24}
            step={0.1}
            onChange={(pitch) => onChange({ pitch })}
          />
          <label className="vocal-check vocal-align">
            <input
              type="checkbox"
              checked={event.reverse}
              onChange={(e) => onChange({ reverse: e.target.checked })}
            />{" "}
            Reverse trimmed region
          </label>
          <NumberField
            label="Fade in (seconds)"
            value={event.fadeIn}
            min={0}
            max={10}
            step={0.001}
            onChange={(fadeIn) => onChange({ fadeIn })}
          />
          <NumberField
            label="Fade out (seconds)"
            value={event.fadeOut}
            min={0}
            max={10}
            step={0.001}
            onChange={(fadeOut) => onChange({ fadeOut })}
          />
        </div>
        <p className="vocal-help">
          Pitch changes speed and length together. Fades use playback seconds.
          Source gain {asset?.gain.toFixed(2) ?? "unknown"} also applies.
        </p>
        {asset && (
          <details className="vocal-source-preview">
            <summary>Preview dry source</summary>
            <audio
              controls
              preload="none"
              src={asset.data}
              aria-label={`${event.name} dry source preview`}
              onPlay={(e) => {
                document.querySelectorAll("audio").forEach((audio) => {
                  if (audio !== e.currentTarget) audio.pause();
                });
                onPreview?.();
              }}
            />
            <p className="vocal-help">
              Full imported file before event trim and processing.
            </p>
          </details>
        )}
      </details>
      <details className="vocal-detail">
        <summary>Filter, delay & reverb</summary>
        <label className="vocal-check">
          <input
            type="checkbox"
            checked={!!event.filter}
            onChange={(e) =>
              onChange({ filter: e.target.checked ? filter : undefined })
            }
          />{" "}
          Enable filter
        </label>
        {event.filter && (
          <div className="vocal-grid">
            <NumberField
              label="High-pass (Hz)"
              value={filter.highpass}
              min={20}
              max={filter.lowpass}
              step={10}
              onChange={(highpass) =>
                onChange({ filter: { ...filter, highpass } })
              }
            />
            <NumberField
              label="Low-pass (Hz)"
              value={filter.lowpass}
              min={filter.highpass}
              max={20000}
              step={10}
              onChange={(lowpass) =>
                onChange({ filter: { ...filter, lowpass } })
              }
            />
          </div>
        )}
        <div className="vocal-grid">
          <NumberField
            label="Delay send (0–0.8)"
            value={delay.wet}
            min={0}
            max={0.8}
            onChange={(wet) => setFX({ delay: { ...delay, wet } })}
          />
          <NumberField
            label="Delay interval (beats)"
            value={delay.division}
            min={0.125}
            max={4}
            step={0.125}
            onChange={(division) => setFX({ delay: { ...delay, division } })}
          />
          <NumberField
            label="Delay feedback"
            value={delay.feedback}
            min={0}
            max={0.65}
            onChange={(feedback) => setFX({ delay: { ...delay, feedback } })}
          />
          <NumberField
            label="Delay low-pass (Hz)"
            value={delay.cutoff}
            min={250}
            max={18000}
            step={50}
            onChange={(cutoff) => setFX({ delay: { ...delay, cutoff } })}
          />
          <label className="vocal-check vocal-wide">
            <input
              type="checkbox"
              checked={delay.pingPong}
              onChange={(e) =>
                setFX({ delay: { ...delay, pingPong: e.target.checked } })
              }
            />{" "}
            Stereo ping-pong delay
          </label>
          <NumberField
            label="Reverb send (0–0.8)"
            value={reverb.wet}
            min={0}
            max={0.8}
            onChange={(wet) => setFX({ reverb: { ...reverb, wet } })}
          />
          <NumberField
            label="Reverb decay (seconds)"
            value={reverb.decay}
            min={0.1}
            max={8}
            step={0.1}
            onChange={(decay) => setFX({ reverb: { ...reverb, decay } })}
          />
          <NumberField
            label="Reverb pre-delay (seconds)"
            value={reverb.preDelay}
            min={0}
            max={0.25}
            step={0.001}
            onChange={(preDelay) => setFX({ reverb: { ...reverb, preDelay } })}
          />
        </div>
      </details>
      <details className="vocal-detail">
        <summary>Repeats & overlap</summary>
        <div className="vocal-grid">
          <NumberField
            label="Additional repeats"
            value={repeat.count}
            min={0}
            max={64}
            step={1}
            onChange={(count) =>
              onChange({ repeats: { ...repeat, count: Math.round(count) } })
            }
          />
          <NumberField
            label="Repeat spacing (beats)"
            value={repeat.intervalTicks / PPQ}
            min={1 / PPQ}
            max={2048}
            step={0.25}
            onChange={(n) =>
              onChange({
                repeats: { ...repeat, intervalTicks: Math.round(n * PPQ) },
              })
            }
          />
          <label>
            Overlap
            <select
              value={event.overlap}
              onChange={(e) =>
                onChange({
                  overlap: e.target.value as VocalEvent["overlap"],
                  ...(e.target.value === "choke-group"
                    ? { chokeGroup: event.chokeGroup?.trim() || "vocals" }
                    : {}),
                })
              }
            >
              <option value="allow">Allow overlap</option>
              <option value="choke-group">Stop previous in group</option>
            </select>
          </label>
          {event.overlap === "choke-group" && (
            <TextField
              label="Choke group"
              value={event.chokeGroup ?? ""}
              allowEmpty={false}
              maxLength={128}
              onChange={(chokeGroup) => onChange({ chokeGroup })}
            />
          )}
        </div>
        <p className="vocal-help">
          Zero repeats plays once. Choking stops the earlier source in the same
          group; its effect tails can continue.
        </p>
        {event.overlap === "choke-group" && !event.chokeGroup?.trim() && (
          <p className="vocal-notice">
            Enter a group name to share choking with other events.
          </p>
        )}
      </details>
      <details className="vocal-detail">
        <summary>Source & credits</summary>
        <div className="vocal-grid">
          <TextField
            label="Creator"
            value={event.provenance.creator}
            onChange={(creator) =>
              onChange({ provenance: { ...event.provenance, creator } })
            }
          />
          <TextField
            label="Credit / usage notes"
            value={event.provenance.credit}
            maxLength={2000}
            onChange={(credit) =>
              onChange({ provenance: { ...event.provenance, credit } })
            }
          />
        </div>
        <p className="vocal-source-name">
          Source: {event.provenance.sourceName}
        </p>
        <code className="vocal-source-hash">
          SHA256: {event.provenance.sourceHash || "Not recorded"}
        </code>
        {event.provenance.processing && (
          <p className="vocal-help">
            Processed with {event.provenance.processing.processor}{" "}
            {event.provenance.processing.version}. Original source and
            processing settings remain in the project.
          </p>
        )}
      </details>
    </article>
  );
}

export default function VocalEvents({
  project,
  onChange,
  onPreview,
}: {
  project: Project;
  onChange: (project: Project) => void;
  onPreview?: () => void;
}) {
  const [role, setRole] = useState<VocalEvent["role"]>("tag");
  const [assetId, setAssetId] = useState("");
  const [patternAssetId, setPatternAssetId] = useState("");
  const [density, setDensity] =
    useState<VoxPatternOptions["density"]>("sparse");
  const [placement, setPlacement] =
    useState<VoxPatternOptions["placement"]>("gaps");
  const [accentGain, setAccentGain] = useState(0.2);
  const [accentEcho, setAccentEcho] = useState(true);
  const [accentSeed, setAccentSeed] = useState(project.settings.seed);
  useEffect(
    () => setAccentSeed(project.settings.seed),
    [project.created, project.settings.seed],
  );
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const latest = useRef(project);
  latest.current = project;
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const explicit = project.vocalEvents !== undefined;
  const events = project.vocalEvents ?? [];
  const voxOn = project.voxEnabled ?? explicit;
  const issues = vocalEventIssues(project);
  const assets = project.assets.filter(
    (a) => a.role === "tag" || a.role === "vox",
  );
  const chosenAsset = assets.find((a) => a.id === assetId) ?? assets[0];
  const accentAssets = assets.filter(isVoxAccentAsset);
  const accentAsset =
    accentAssets.find((a) => a.id === patternAssetId) ?? accentAssets[0];
  const makeAccents = () => {
    setError("");
    try {
      const next = buildVoxPattern(project, {
        assetIds: accentAsset ? [accentAsset.id] : [],
        seed: accentSeed,
        density,
        placement,
        gain: accentGain,
        echo: accentEcho,
      });
      onChange(next);
      const count = next.vocalEvents!.filter((e) =>
        e.id.startsWith("vox-pattern:"),
      ).length;
      setMessage(
        `${count} editable accents. Manual events and tags retained.${project.voxEnabled === false ? " Vox is off; enable it to audition." : ""}`,
      );
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const loadLocalSources = async () => {
    const start = latest.current;
    setBusy(true);
    setError("");
    try {
      const response = await fetch(
        "/private-assets/vocal-palette-20261016.json",
      );
      if (!response.ok)
        throw new Error(
          "Local supplied vocal palette is unavailable. Import a non-identifying vox recording instead.",
        );
      const bank = (await response.json()) as { assets: SampleAsset[] };
      if (
        !Array.isArray(bank.assets) ||
        !bank.assets.length ||
        bank.assets.length > 8
      )
        throw new Error("Invalid local vocal palette.");
      if (!alive.current) return;
      if (
        latest.current.created !== start.created ||
        latest.current.vocalEvents === undefined
      )
        throw new Error(
          "The session changed; load the vocal palette in the current editable lane.",
        );
      const next = clone(latest.current);
      for (const a of bank.assets) {
        if (!["tag", "vox"].includes(a.role))
          throw new Error("The local palette contains a non-vocal source.");
        if (!next.assets.some((existing) => existing.id === a.id))
          next.assets.push(a);
      }
      validateProject(next);
      onChange(next);
      setMessage(
        "Local vocal sources added. Identity tags stay optional; choose an accent source below.",
      );
    } catch (e) {
      if (alive.current) setError((e as Error).message);
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  const setMode = (tags: boolean, vox: boolean) =>
    onChange({ ...project, tagEnabled: tags, voxEnabled: vox });
  const add = (
    asset: SampleAsset,
    type: VocalEvent["role"],
    base = project,
  ) => {
    if ((base.vocalEvents?.length ?? 0) >= 128) {
      setError("A project supports up to 128 vocal events.");
      return;
    }
    const next = clone(base);
    if (!next.assets.some((a) => a.id === asset.id)) next.assets.push(asset);
    next.vocalEvents = [
      ...migrateLegacyTag(next),
      newEvent(asset, type, next.settings.bpm),
    ];
    onChange(next);
    setMessage(`Added ${asset.name} at song bar 1. Set its position below.`);
  };
  const importFile = async (file: File) => {
    const start = latest.current;
    const type = role;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const asset = await importSample(file, type);
      if (!alive.current) return;
      if (latest.current.created !== start.created)
        throw new Error(
          "The session changed during import. Import the file again in this session.",
        );
      if (latest.current.vocalEvents === undefined)
        throw new Error(
          "The editable lane was closed during import. Open the lane and import again.",
        );
      add(asset, type, latest.current);
    } catch (e) {
      if (alive.current) setError((e as Error).message);
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  return (
    <div className="vocal-events">
      <div className="vocal-heading">
        <div>
          <h3>Tags & vox</h3>
          <p>Place your recorded tag and vocal samples in the song.</p>
        </div>
        <div className="vocal-modes" role="group" aria-label="Vocal activity">
          {[
            { text: "Off", tags: false, vox: false },
            { text: "Tags", tags: true, vox: false },
            { text: "Tags + vox", tags: true, vox: true },
          ].map((mode) => (
            <button
              key={mode.text}
              aria-pressed={
                project.tagEnabled === mode.tags && voxOn === mode.vox
              }
              onClick={() => setMode(mode.tags, mode.vox)}
            >
              {mode.text}
            </button>
          ))}
        </div>
      </div>
      <p className="vocal-help">
        Tags {project.tagEnabled ? "on" : "off"} · Vox {voxOn ? "on" : "off"}.
        Off creates an instrumental-only playback and export. These choices keep
        your events.
      </p>
      {!explicit ? (
        <div className="vocal-empty">
          <h4>Start an editable vocal lane</h4>
          <p>
            {project.tagAsset
              ? "Your existing tag uses its original playback path. Move it into this lane to edit its timing, trim and effects. The editable envelope may sound different."
              : "Import a WAV or MP3, then choose its song or section position. Audio stays embedded in the project."}
          </p>
          <button
            className="secondary"
            onClick={() =>
              onChange({
                ...project,
                vocalEvents: clone(migrateLegacyTag(project)),
                voxEnabled: voxOn,
              })
            }
          >
            {project.tagAsset
              ? "Move existing tag into editable lane"
              : "Create editable vocal lane"}
          </button>
        </div>
      ) : (
        <>
          <div className="vocal-add">
            <label>
              Add as
              <select
                value={role}
                onChange={(e) => setRole(e.target.value as VocalEvent["role"])}
              >
                <option value="tag">Producer tag</option>
                <option value="vox">Sampled vox</option>
              </select>
            </label>
            <button
              className="secondary"
              disabled={busy || events.length >= 128}
              onClick={() => input.current?.click()}
            >
              {busy ? "Importing audio…" : "Import WAV / MP3"}
            </button>
            {assets.length > 0 && (
              <>
                <label>
                  Existing vocal asset
                  <select
                    value={chosenAsset?.id ?? ""}
                    onChange={(e) => setAssetId(e.target.value)}
                  >
                    {assets.map((a) => (
                      <option value={a.id} key={a.id}>
                        {a.name}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  className="secondary"
                  disabled={busy || !chosenAsset || events.length >= 128}
                  onClick={() => {
                    if (chosenAsset) add(chosenAsset, role);
                  }}
                >
                  Add event
                </button>
              </>
            )}
          </div>
          <p className="vocal-help">
            New events start at song bar 1. Import your own spoken
            “ishmakethebeat” recording for your identity; keep other producers’
            tags credited to their source.
          </p>
          <details className="vocal-detail">
            <summary>Generate phrase accents</summary>
            <p className="vocal-help">
              Use a non-identifying vocal one-shot. Rebuild affects generated
              accents only; manual placements and tags remain. Generation
              controls apply when you press Rebuild.
            </p>
            <button
              className="secondary"
              disabled={busy}
              onClick={() => void loadLocalSources()}
            >
              Load supplied vocal sounds
            </button>
            <div className="vocal-grid">
              <label>
                Accent source
                <select
                  aria-label="Accent source"
                  value={accentAsset?.id ?? ""}
                  onChange={(e) => setPatternAssetId(e.target.value)}
                >
                  {!accentAssets.length && (
                    <option value="">Import or load a vox source</option>
                  )}
                  {accentAssets.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Vox density
                <select
                  aria-label="Vox density"
                  value={density}
                  onChange={(e) =>
                    setDensity(e.target.value as VoxPatternOptions["density"])
                  }
                >
                  <option value="off">Remove generated accents</option>
                  <option value="sparse">Sparse · about every 16 bars</option>
                  <option value="regular">Regular · about every 8 bars</option>
                </select>
              </label>
              <label>
                Accent placement
                <select
                  aria-label="Accent placement"
                  value={placement}
                  onChange={(e) =>
                    setPlacement(
                      e.target.value as VoxPatternOptions["placement"],
                    )
                  }
                >
                  <option value="gaps">Prefer phrase gaps</option>
                  <option value="pickups">Phrase pickups</option>
                </select>
              </label>
              <NumberField
                label="Accent level"
                value={accentGain}
                min={0}
                max={1}
                onChange={setAccentGain}
              />
              <TextField
                label="Accent seed"
                value={accentSeed}
                onChange={setAccentSeed}
                maxLength={128}
                allowEmpty={false}
              />
              <label className="vocal-check">
                <input
                  type="checkbox"
                  checked={accentEcho}
                  onChange={(e) => setAccentEcho(e.target.checked)}
                />{" "}
                Short echo & room
              </label>
            </div>
            <p className="vocal-help">
              Accents use up to 0.6 seconds of the selected region and keep its
              original pitch. Sparse placement and level are starting choices
              for listening review.
            </p>
            <button
              className="secondary"
              disabled={busy || (density !== "off" && !accentAsset)}
              onClick={makeAccents}
            >
              Rebuild generated accents
            </button>
          </details>
          {events.length === 0 && (
            <div className="vocal-empty">
              No vocal events yet. Import a recording to add one.
            </div>
          )}
          {events.map((event) => (
            <EventEditor
              key={event.id}
              event={event}
              project={project}
              onPreview={onPreview}
              issues={issues
                .filter((i) => i.eventId === event.id)
                .map((i) => i.message)}
              onChange={(patch) => {
                const next = clone(project);
                Object.assign(
                  next.vocalEvents!.find((e) => e.id === event.id)!,
                  patch,
                );
                onChange(next);
              }}
              onRemove={() =>
                onChange({
                  ...project,
                  vocalEvents: events.filter((e) => e.id !== event.id),
                })
              }
            />
          ))}
        </>
      )}
      {error && (
        <p className="vocal-issues" role="alert">
          {error}
        </p>
      )}
      {message && (
        <p className="vocal-notice" role="status">
          {message}
        </p>
      )}
      <input
        ref={input}
        type="file"
        accept=".wav,.mp3,audio/wav,audio/mpeg"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file) void importFile(file);
        }}
      />
    </div>
  );
}
