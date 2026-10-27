import type { RoleEffects, Track } from "../engine/schema";
export default function RoleProcessing({
  track,
  onChange,
}: {
  track: Track;
  onChange: (patch: Partial<Track>) => void;
}) {
  const fx = track.effects ?? {};
  const delay = fx.delay ?? {
    division: 0.75,
    feedback: 0.25,
    wet: 0,
    cutoff: 4200,
    pingPong: true,
  };
  const set = (patch: Partial<RoleEffects>) =>
    onChange({ effects: { ...fx, ...patch } });
  const hat = fx.hat ?? {
    mix: 0,
    echoBeats: 0.25,
    feedback: 0.18,
    chorus: 0.2,
    crush: 0,
    room: 0.08,
  };
  return (
    <div className="sample-settings">
      <h4>Role & processing</h4>
      {!["kick", "clap", "hat", "open", "perc"].includes(track.id) && (
        <label>
          Register (semitones)
          <select
            aria-label="Track register"
            value={track.register ?? 0}
            onChange={(e) => onChange({ register: +e.target.value })}
          >
            {[-24, -12, 0, 12, 24].map((n) => (
              <option key={n} value={n}>
                {n > 0 ? "+" : ""}
                {n}
              </option>
            ))}
          </select>
        </label>
      )}
      {track.id === "bass" && (
        <details>
          <summary>808 amplitude envelope</summary>
          <label>
            <input
              aria-label="Use track bass envelope"
              type="checkbox"
              checked={!!fx.sampleEnvelope}
              onChange={(event) => {
                if (event.target.checked)
                  set({
                    sampleEnvelope: {
                      attack: 0.002,
                      decay: 0.085,
                      sustain: 0.74,
                      release: 0.018,
                    },
                  });
                else {
                  const next = { ...fx };
                  delete next.sampleEnvelope;
                  onChange({ effects: next });
                }
              }}
            />{" "}
            Override this track's sample envelope
          </label>
          {fx.sampleEnvelope &&
            (
              [
                ["attack", 0, 0.05, 0.001],
                ["decay", 0.001, 0.5, 0.001],
                ["sustain", 0, 1, 0.01],
                ["release", 0.001, 0.25, 0.001],
              ] as const
            ).map(([name, min, max, step]) => (
              <label key={name}>
                {name} ·{" "}
                {name === "sustain"
                  ? fx.sampleEnvelope![name].toFixed(2)
                  : `${Math.round(fx.sampleEnvelope![name] * 1000)} ms`}
                <input
                  aria-label={`Bass envelope ${name}`}
                  type="range"
                  min={min}
                  max={max}
                  step={step}
                  value={fx.sampleEnvelope![name]}
                  onChange={(event) =>
                    set({
                      sampleEnvelope: {
                        ...fx.sampleEnvelope!,
                        [name]: +event.target.value,
                      },
                    })
                  }
                />
              </label>
            ))}
          <small>
            Source trim and root tuning remain in Sample settings. The override
            is saved per track.
          </small>
        </details>
      )}
      {track.id === "bass" ? (
        <label>
          Saturation
          <input
            aria-label="Bass saturation"
            type="range"
            min="0"
            max="1"
            step=".01"
            value={fx.saturation ?? 0.15}
            onChange={(e) => set({ saturation: +e.target.value })}
          />
        </label>
      ) : (
        <>
          <label>
            Echo division
            <select
              aria-label="Echo division in beats"
              value={delay.division}
              onChange={(e) =>
                set({ delay: { ...delay, division: +e.target.value } })
              }
            >
              {[0.125, 0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4].map((n) => (
                <option key={n} value={n}>
                  {n} beats
                </option>
              ))}
            </select>
          </label>
          {(
            [
              ["wet", 0, 0.8, 0.01],
              ["feedback", 0, 0.6, 0.01],
              ["cutoff", 250, 16000, 50],
            ] as const
          ).map(([name, min, max, step]) => (
            <label key={name}>
              {name}
              <input
                aria-label={`Role delay ${name}`}
                type="range"
                min={min}
                max={max}
                step={step}
                value={delay[name]}
                onChange={(e) =>
                  set({ delay: { ...delay, [name]: +e.target.value } })
                }
              />
              <small>{delay[name]}</small>
            </label>
          ))}
          <label>
            <input
              type="checkbox"
              checked={delay.pingPong}
              onChange={(e) =>
                set({ delay: { ...delay, pingPong: e.target.checked } })
              }
            />{" "}
            Stereo ping-pong
          </label>
          <details>
            <summary>Echo send automation</summary>
            <small>
              Beat positions in the 32-beat phrase. Saved with this role.
            </small>
            {(delay.automation ?? []).map((a, i) => (
              <div className="settings-grid" key={i}>
                <label>
                  Beat
                  <input
                    aria-label={`Echo automation beat ${i + 1}`}
                    type="number"
                    min="0"
                    max="32"
                    step=".25"
                    value={a.tick / 480}
                    onChange={(e) =>
                      set({
                        delay: {
                          ...delay,
                          automation: delay.automation!.map((b, j) =>
                            j === i
                              ? {
                                  ...b,
                                  tick: Math.round(+e.target.value * 480),
                                }
                              : b,
                          ),
                        },
                      })
                    }
                  />
                </label>
                <label>
                  Send
                  <input
                    aria-label={`Echo automation wet ${i + 1}`}
                    type="number"
                    min="0"
                    max=".8"
                    step=".01"
                    value={a.wet}
                    onChange={(e) =>
                      set({
                        delay: {
                          ...delay,
                          automation: delay.automation!.map((b, j) =>
                            j === i ? { ...b, wet: +e.target.value } : b,
                          ),
                        },
                      })
                    }
                  />
                </label>
                <button
                  onClick={() =>
                    set({
                      delay: {
                        ...delay,
                        automation: delay.automation!.filter((_, j) => j !== i),
                      },
                    })
                  }
                >
                  Remove point
                </button>
              </div>
            ))}
            <button
              className="secondary"
              onClick={() =>
                set({
                  delay: {
                    ...delay,
                    automation: [
                      ...(delay.automation ?? []),
                      { tick: 0, wet: delay.wet },
                    ],
                  },
                })
              }
            >
              Add send point
            </button>
          </details>
        </>
      )}
      {track.id === "hat" && (
        <>
          <h4>Authored hat treatment</h4>
          <small>
            Browser approximations; the supplied FL presets cannot run here. Dry
            attacks remain alongside the wet return.
          </small>
          <div className="settings-grid">
            <button onClick={() => set({ hat: { ...hat, mix: 0, crush: 0 } })}>
              Dry
            </button>
            <button
              onClick={() =>
                set({
                  hat: {
                    mix: 0.23,
                    echoBeats: 0.25,
                    feedback: 0.17,
                    chorus: 0.2,
                    crush: 0,
                    room: 0.06,
                  },
                })
              }
            >
              Short echo / motion
            </button>
            <button
              onClick={() =>
                set({
                  hat: {
                    mix: 0.18,
                    echoBeats: 0.125,
                    feedback: 0.12,
                    chorus: 0.46,
                    crush: 0.22,
                    room: 0.05,
                  },
                })
              }
            >
              Grain / phase
            </button>
          </div>
          {(["mix", "feedback", "chorus", "crush", "room"] as const).map(
            (name) => (
              <label key={name}>
                Hat {name}
                <input
                  aria-label={`Hat ${name}`}
                  type="range"
                  min="0"
                  max={name === "feedback" ? 0.6 : 1}
                  step=".01"
                  value={hat[name]}
                  onChange={(e) =>
                    set({ hat: { ...hat, [name]: +e.target.value } })
                  }
                />
              </label>
            ),
          )}
        </>
      )}
    </div>
  );
}
