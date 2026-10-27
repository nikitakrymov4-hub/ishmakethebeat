import { useEffect, useState } from "react";
import type { AudioClip, Project, SampleAsset } from "../engine/schema";
import { clone, KEYS } from "../engine/schema";
import { transposeLoop } from "../engine/loop";
import LoopLibrary from "./LoopLibrary";
import {
  isLoopFoundation,
  updateFoundationRegion,
} from "../io/loop-foundation";
import type { LoopRegion, LoopSource } from "../io/loop-foundation";
import {
  isLoopBeat,
  setLoopBeatKey,
  updateLoopBeatRegion,
} from "../io/loop-beat";
import type { LoopBeatOptions } from "../io/loop-beat";
function Waveform({ asset, clip }: { asset: SampleAsset; clip: AudioClip }) {
  const [wave, setWave] = useState<number[]>([]);
  useEffect(() => {
    let live = true;
    const ctx = new OfflineAudioContext(1, 1, 44100);
    const bytes = Uint8Array.from(atob(asset.data.split(",")[1]), (c) =>
      c.charCodeAt(0),
    );
    void ctx.decodeAudioData(bytes.buffer).then((b) => {
      const a = b.getChannelData(0),
        result = [];
      for (let j = 0; j < 640; j++) {
        let peak = 0;
        for (
          let i = Math.floor((j * a.length) / 640);
          i < Math.floor(((j + 1) * a.length) / 640);
          i++
        )
          peak = Math.max(peak, Math.abs(a[i]));
        result.push(peak);
      }
      if (live) setWave(result);
    });
    return () => {
      live = false;
    };
  }, [asset.data]);
  const length = asset.duration ?? asset.trimEnd,
    x = (n: number) => (640 * n) / Math.max(0.001, length);
  return (
    <svg
      role="img"
      aria-label={`${clip.name} source waveform with editable region and beat grid`}
      viewBox="0 0 640 110"
      style={{ width: "100%", background: "#111c17", borderRadius: 6 }}
    >
      {wave.map((v, i) => (
        <line
          key={i}
          x1={i}
          x2={i}
          y1={55 - v * 48}
          y2={55 + v * 48}
          stroke="#90b886"
          opacity=".65"
        />
      ))}
      <rect
        x={x(clip.sourceOffset)}
        y="0"
        width={x(clip.sourceDuration)}
        height="110"
        fill="#a2c990"
        opacity=".1"
        stroke="#b9df9e"
      />
      {Array.from(
        {
          length: Math.min(
            129,
            Math.ceil((length * clip.provenance.nativeBpm) / 60) + 1,
          ),
        },
        (_, i) => (
          <line
            key={`b${i}`}
            x1={x(
              clip.provenance.downbeatOffset +
                (i * 60) / clip.provenance.nativeBpm,
            )}
            x2={x(
              clip.provenance.downbeatOffset +
                (i * 60) / clip.provenance.nativeBpm,
            )}
            y1="0"
            y2="110"
            stroke={i % 4 === 0 ? "#cfdeb7" : "#586e58"}
            opacity={i % 4 === 0 ? 0.6 : 0.22}
          />
        ),
      )}
    </svg>
  );
}
export default function AudioRegions({
  project,
  onChange,
  onLoadLoop,
  onResample,
  onUseFoundation,
  onBuildBeat,
  onPreview,
  busy,
}: {
  project: Project;
  onChange: (p: Project) => void;
  onLoadLoop: () => void;
  onResample: () => void;
  onUseFoundation: (
    asset: SampleAsset,
    source: LoopSource,
    region: LoopRegion,
  ) => void;
  onBuildBeat: (
    asset: SampleAsset,
    source: LoopSource,
    region: LoopRegion,
    options: LoopBeatOptions,
  ) => void;
  onPreview: () => void;
  busy: boolean;
}) {
  const [regionError, setRegionError] = useState("");
  const foundation = isLoopFoundation(project);
  const beat = isLoopBeat(project);
  const update = (index: number, patch: Partial<AudioClip>) => {
    try {
      let q = clone(project);
      Object.assign(q.clips![index], patch);
      if (
        (foundation || (beat && index === 0)) &&
        q.clips![index].kind === "supplied-loop" &&
        (patch.sourceOffset !== undefined ||
          patch.duration !== undefined ||
          patch.provenance?.nativeBpm !== undefined)
      ) {
        const clip = q.clips![index];
        q = (beat ? updateLoopBeatRegion : updateFoundationRegion)(q, {
          sourceStart: clip.sourceOffset,
          beats: clip.duration / 480,
          nativeBpm: clip.provenance.nativeBpm,
        });
      }
      onChange(q);
      setRegionError("");
    } catch (error) {
      setRegionError((error as Error).message);
    }
  };
  return (
    <div className="audio-regions" style={{ padding: 18 }}>
      <div className="settings-grid">
        <button className="secondary" onClick={onLoadLoop}>
          Open supplied LOOP 10 candidate
        </button>
        <button className="secondary" disabled={busy} onClick={onResample}>
          {busy
            ? "Rendering original role…"
            : "Render selected role → reverse pickup"}
        </button>
      </div>
      <p className="muted">
        Original resampling and direct supplied loops retain their source. Tempo
        matching currently uses native playback; linked rate transposition
        changes both pitch and tempo.
      </p>
      <LoopLibrary
        onUseFoundation={onUseFoundation}
        onBuildBeat={onBuildBeat}
        onPreview={onPreview}
      />
      {beat && (
        <div className="sample-settings">
          <h4>Sample melody · editable bass basis</h4>
          <p>
            The source provides the melody. Only bass/drum notes were generated.
            This key is your writing basis; source chords remain unverified.
            Changing it transposes the bass without changing source audio or
            rhythm.
          </p>
          <div className="settings-grid">
            <label>
              Bass key basis
              <select
                aria-label="Current loop bass key"
                value={project.settings.key}
                onChange={(e) =>
                  onChange(
                    setLoopBeatKey(
                      project,
                      Number(e.target.value),
                      project.settings.mode === "major" ? "major" : "minor",
                    ),
                  )
                }
              >
                {KEYS.map((name, key) => (
                  <option key={key} value={key}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Mode basis
              <select
                aria-label="Current loop mode"
                value={project.settings.mode}
                onChange={(e) =>
                  onChange(
                    setLoopBeatKey(
                      project,
                      project.settings.key,
                      e.target.value as "major" | "minor",
                    ),
                  )
                }
              >
                <option value="minor">Minor</option>
                <option value="major">Major</option>
              </select>
            </label>
          </div>
          <p>
            Use the first clip to edit the shared source start, phrase length or
            native grid. The reduced section and ending follow that region.
            Gains, effects and the arrangement remain editable.
          </p>
        </div>
      )}
      {regionError && <p role="alert">{regionError}</p>}
      {(project.clips ?? []).map((clip, i) => {
        const sourceFoundation =
          (foundation || beat) && clip.kind === "supplied-loop";
        const linkedSecondary = beat && i > 0;
        const asset = project.assets.find((a) => a.id === clip.assetId)!;
        const delay = clip.effects?.delay ?? {
          division: 0.75,
          feedback: 0.2,
          wet: 0,
          cutoff: 4000,
          pingPong: true,
        };
        return (
          <div className="sample-settings" key={clip.id}>
            <h4>{clip.name}</h4>
            <small className="audio-source-creator">
              {clip.kind === "supplied-loop"
                ? "Source sample"
                : "Resampled audio"}{" "}
              · {clip.provenance.creator}
            </small>
            <details className="audio-source-credits">
              <summary>Full source credits & terms</summary>
              <p>
                <strong>Source:</strong> {clip.provenance.sourceName}
              </p>
              <p>{clip.provenance.credit}</p>
              <p>
                <strong>Original SHA-256:</strong>{" "}
                <code>{clip.provenance.sourceHash}</code>
              </p>
            </details>
            {foundation && (
              <p>
                Source key unverified. This foundation contains the chosen
                source region; no harmony was inferred. Source duration follows
                its beat count and grid tempo. Generator key settings are not a
                detected source key.
              </p>
            )}
            <Waveform asset={asset} clip={clip} />
            <div className="settings-grid">
              <label>
                Source start (seconds)
                <input
                  aria-label={`Clip ${i + 1} source start`}
                  disabled={linkedSecondary}
                  type="number"
                  min="0"
                  max={asset.duration ?? asset.trimEnd}
                  step=".001"
                  value={clip.sourceOffset}
                  onChange={(e) =>
                    update(i, {
                      sourceOffset: Math.max(
                        0,
                        Math.min(
                          +e.target.value,
                          (asset.duration ?? asset.trimEnd) -
                            (sourceFoundation ? clip.sourceDuration : 0.01),
                        ),
                      ),
                    })
                  }
                />
              </label>
              <label>
                Source region (seconds)
                <input
                  aria-label={`Clip ${i + 1} source duration`}
                  type="number"
                  min=".01"
                  max={(asset.duration ?? asset.trimEnd) - clip.sourceOffset}
                  step=".001"
                  value={clip.sourceDuration}
                  readOnly={sourceFoundation}
                  onChange={(e) =>
                    update(i, {
                      sourceDuration: Math.max(
                        0.01,
                        Math.min(
                          +e.target.value,
                          (asset.duration ?? asset.trimEnd) - clip.sourceOffset,
                        ),
                      ),
                    })
                  }
                />
              </label>
              <label>
                Place at beat
                <input
                  aria-label={`Clip ${i + 1} start beat`}
                  type="number"
                  min="0"
                  max="31.75"
                  step=".25"
                  value={clip.tick / 480}
                  disabled={sourceFoundation}
                  onChange={(e) =>
                    update(i, { tick: Math.round(+e.target.value * 480) })
                  }
                />
              </label>
              {sourceFoundation && !linkedSecondary && (
                <label>
                  Source grid tempo (BPM, user set)
                  <input
                    aria-label="Foundation source grid BPM"
                    type="number"
                    min="40"
                    max="300"
                    step=".01"
                    value={clip.provenance.nativeBpm}
                    onChange={(e) =>
                      update(i, {
                        provenance: {
                          ...clip.provenance,
                          nativeBpm: Number(e.target.value),
                        },
                      })
                    }
                  />
                </label>
              )}
              <label>
                Region length (beats)
                <input
                  aria-label={`Clip ${i + 1} region beats`}
                  disabled={linkedSecondary}
                  type="number"
                  min=".25"
                  max="32"
                  step=".25"
                  value={clip.duration / 480}
                  onChange={(e) =>
                    update(i, {
                      duration: Math.round(+e.target.value * 480),
                      provenance: {
                        ...clip.provenance,
                        beats: +e.target.value,
                      },
                    })
                  }
                />
              </label>
              <label>
                Playback gain
                <input
                  aria-label={`Clip ${i + 1} gain`}
                  type="range"
                  min="0"
                  max="1"
                  step=".01"
                  value={clip.gain}
                  onChange={(e) => update(i, { gain: +e.target.value })}
                />
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={clip.reverse}
                  onChange={(e) => update(i, { reverse: e.target.checked })}
                />{" "}
                Reverse source region
              </label>
              <label>
                Clip echo send
                <input
                  aria-label={`Clip ${i + 1} echo send`}
                  type="range"
                  min="0"
                  max=".6"
                  step=".01"
                  value={delay.wet}
                  onChange={(e) =>
                    update(i, {
                      effects: {
                        ...clip.effects,
                        delay: { ...delay, wet: +e.target.value },
                      },
                    })
                  }
                />
              </label>
              <label>
                Clip echo division
                <select
                  aria-label={`Clip ${i + 1} echo division`}
                  value={delay.division}
                  onChange={(e) =>
                    update(i, {
                      effects: {
                        ...clip.effects,
                        delay: { ...delay, division: +e.target.value },
                      },
                    })
                  }
                >
                  {[0.25, 0.5, 0.75, 1, 1.5, 2].map((n) => (
                    <option key={n} value={n}>
                      {n} beats
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Clip echo feedback
                <input
                  aria-label={`Clip ${i + 1} echo feedback`}
                  type="range"
                  min="0"
                  max=".6"
                  step=".01"
                  value={delay.feedback}
                  onChange={(e) =>
                    update(i, {
                      effects: {
                        ...clip.effects,
                        delay: { ...delay, feedback: +e.target.value },
                      },
                    })
                  }
                />
              </label>
              {clip.kind === "supplied-loop" && (
                <>
                  <label>
                    Linked transpose (±5)
                    <input
                      aria-label="Loop linked transpose"
                      type="number"
                      min="-5"
                      max="5"
                      value={clip.pitch}
                      onChange={(e) => {
                        try {
                          const next = transposeLoop(project, +e.target.value);
                          if (
                            sourceFoundation &&
                            (next.settings.bpm < 40 || next.settings.bpm > 300)
                          )
                            throw new Error(
                              "Linked pitch/speed would put the tempo outside 40–300 BPM.",
                            );
                          onChange(next);
                          setRegionError("");
                        } catch (error) {
                          setRegionError((error as Error).message);
                        }
                      }}
                    />
                  </label>
                  {!beat && (
                    <label>
                      Key manual override
                      <input
                        aria-label="Loop manual key"
                        value={clip.provenance.manualKey ?? ""}
                        placeholder="Unverified"
                        onChange={(e) =>
                          update(i, {
                            provenance: {
                              ...clip.provenance,
                              manualKey: e.target.value,
                            },
                          })
                        }
                      />
                    </label>
                  )}
                  <label>
                    Downbeat offset (seconds)
                    <input
                      type="number"
                      aria-label="Loop downbeat offset"
                      disabled={linkedSecondary}
                      min="0"
                      step=".001"
                      value={clip.provenance.downbeatOffset}
                      onChange={(e) =>
                        update(i, {
                          provenance: {
                            ...clip.provenance,
                            downbeatOffset: Math.max(
                              0,
                              Math.min(
                                +e.target.value,
                                (asset.duration ?? asset.trimEnd) -
                                  (sourceFoundation
                                    ? clip.sourceDuration
                                    : 0.01),
                              ),
                            ),
                          },
                          sourceOffset: Math.max(
                            0,
                            Math.min(
                              +e.target.value,
                              (asset.duration ?? asset.trimEnd) -
                                (sourceFoundation ? clip.sourceDuration : 0.01),
                            ),
                          ),
                        })
                      }
                    />
                  </label>
                </>
              )}
            </div>
            <small>
              Native {clip.provenance.nativeBpm} BPM ·{" "}
              {clip.provenance.keyEstimate} · no independent time stretch.
              Original SHA-256: {clip.provenance.sourceHash.slice(0, 16)}…
            </small>
            <button
              className="secondary"
              onClick={() => {
                const q = clone(project);
                q.clips = q.clips?.filter((_, j) => i !== j);
                onChange(q);
              }}
            >
              Remove clip
            </button>
          </div>
        );
      })}
      {!project.clips?.length && (
        <p>No audio clips in this original-score project.</p>
      )}
      {(project.scaleGuides ?? []).map((g) => (
        <p key={g.sourceHash}>
          Silent guide: {g.name} · {g.pitches.length} pitches · playback
          disabled
        </p>
      ))}
    </div>
  );
}
