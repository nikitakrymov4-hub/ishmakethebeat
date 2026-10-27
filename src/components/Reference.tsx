import { useRef, useState } from "react";
import type { ReferenceAnalysis } from "../audio/reference";
import { analyzeReference } from "../audio/reference";
import { KEYS } from "../engine/schema";
import Icon from "./Icon";
export default function Reference({
  onStop,
  gain,
  onGain,
  onApply,
}: {
  onStop: () => void;
  gain: number;
  onGain: (n: number) => void;
  onApply: (bpm: number, key: number) => void;
}) {
  const input = useRef<HTMLInputElement>(null),
    audio = useRef<HTMLAudioElement>(null),
    [url, setUrl] = useState(""),
    [file, setFile] = useState<File | null>(null),
    [analysis, setAnalysis] = useState<ReferenceAnalysis | null>(null),
    [busy, setBusy] = useState(false),
    [progress, setProgress] = useState(0),
    [error, setError] = useState(""),
    [bpm, setBpm] = useState(150),
    [key, setKey] = useState(0);
  return (
    <div className="reference-panel">
      <div className="panel-title">
        <Icon name="headphones" />
        <h3>Reference desk</h3>
        <span className="badge">LOCAL ONLY</span>
      </div>
      <p>
        Bring an instrumental passage for a gain-adjusted A/B. Your file stays
        on this device.
      </p>
      <button className="secondary" onClick={() => input.current?.click()}>
        <Icon name="plus" size={15} />
        {file ? file.name : "Choose reference audio"}
      </button>
      <input
        type="file"
        ref={input}
        hidden
        accept="audio/*"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (!f) return;
          if (url) URL.revokeObjectURL(url);
          setFile(f);
          setUrl(URL.createObjectURL(f));
          setAnalysis(null);
          setError("");
        }}
      />
      {url && (
        <>
          <audio
            aria-label="Reference audio"
            ref={audio}
            src={url}
            controls
            onPlay={() => {
              onStop();
              if (audio.current) audio.current.volume = 10 ** (gain / 20);
            }}
          />
          <label className="range-row">
            Reference gain <span>{gain} dB</span>
            <input
              aria-label="Reference gain"
              type="range"
              min="-24"
              max="0"
              value={gain}
              onChange={(e) => {
                onGain(+e.target.value);
                if (audio.current)
                  audio.current.volume = 10 ** (+e.target.value / 20);
              }}
            />
          </label>
          <button
            className="secondary"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setError("");
              try {
                const a = await analyzeReference(file!, setProgress);
                setAnalysis(a);
                setBpm(Math.round(a.bpmCandidates[0]));
                setKey(a.key);
              } catch (e) {
                setError(String(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy
              ? `Analyzing locally · ${Math.round(progress * 100)}%`
              : "Estimate audio descriptors"}
          </button>
        </>
      )}
      {error && <p className="error-text">{error}</p>}
      {analysis && (
        <div className="analysis-results">
          <p>
            Tempo candidates{" "}
            <strong>{analysis.bpmCandidates.join(" / ")} BPM</strong>
            <small>
              Confidence {Math.round(analysis.tempoConfidence * 100)}% ·
              half/double time is ambiguous
            </small>
          </p>
          <p>
            Tonal-center candidate <strong>{KEYS[analysis.key]}</strong>
            <small>
              Confidence {Math.round(analysis.keyConfidence * 100)}% · not a key
              transcription
            </small>
          </p>
          <div className="descriptor-grid">
            <span>
              Brightness<strong>{analysis.brightnessHz} Hz</strong>
            </span>
            <span>
              Onsets<strong>{analysis.onsetDensity}/sec</strong>
            </span>
          </div>
          <svg viewBox="0 0 300 45" aria-label="Approximate low-end envelope">
            <polyline
              fill="none"
              stroke="#a1c594"
              strokeWidth="1.5"
              points={analysis.lowEnd
                .map(
                  (v, i) =>
                    `${(i / Math.max(1, analysis.lowEnd.length - 1)) * 300},${44 - (v / Math.max(...analysis.lowEnd, 0.001)) * 40}`,
                )
                .join(" ")}
            />
          </svg>
          <small>
            Energy changes at{" "}
            {analysis.changes.length
              ? analysis.changes.join(", ")
              : "no clear points"}{" "}
            seconds. First 3 minutes analyzed.
          </small>
          <div className="manual-reference">
            <label>
              Correct BPM
              <input
                type="number"
                min="40"
                max="300"
                value={bpm}
                onChange={(e) => setBpm(+e.target.value)}
              />
            </label>
            <label>
              Center
              <select value={key} onChange={(e) => setKey(+e.target.value)}>
                {KEYS.map((k, i) => (
                  <option key={k} value={i}>
                    {k}
                  </option>
                ))}
              </select>
            </label>
            <button className="secondary" onClick={() => onApply(bpm, key)}>
              Use settings
            </button>
          </div>
          <p className="muted">
            These are rough signal descriptors. Vocals and full mixes reduce
            reliability. No melody is copied and no source separation is
            performed.
          </p>
        </div>
      )}
    </div>
  );
}
