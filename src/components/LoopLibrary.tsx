import { useEffect, useMemo, useRef, useState } from "react";
import type { SampleAsset } from "../engine/schema";
import { KEYS } from "../engine/schema";
import type { LoopBeatOptions } from "../io/loop-beat";
import { checkedLoopRegion, importLoopSource } from "../io/loop-foundation";
import type { LoopRegion, LoopSource } from "../io/loop-foundation";

type SourceFile = {
  id: string;
  path: string;
  originalFilename: string;
  kind: "audio" | "midi";
  extension: string;
  bytes: number;
  sha256: string;
  perFileCredits?: { names: string[]; basis: string };
  filenameHints?: { tempoBpm: number | null; key: string | null } | null;
  audio?: { durationSeconds: number | null };
  midi?: { declaredTracks: number; ppq: number | null };
};
type SourceKit = {
  id: string;
  archive: string;
  creator: string;
  termsSummary: string;
  creditBasis?: string;
  sourceDocuments: { path: string; sha256?: string; text?: string }[];
  files: SourceFile[];
};
type LibraryFile = SourceFile & { kit: SourceKit };
const CATALOGUES = [
  "/deliverables/audio-research/extra-loop-kit-catalogue.json",
  "/deliverables/audio-research/stash-loop-library-catalogue.json",
];
const PACK_NAMES: Record<string, string> = {
  neptune: "NEPTUNE",
  "stash-main-loops": "Lilfrus stash",
  "carti-type": "Carti Type",
  "deyflo-january": "Deyflo January",
};

function sourceUrl(path: string) {
  const parts = path.split("/");
  if (
    !["private-assets/extra-loop-kits/", "private-assets/stash-kit/"].some(
      (prefix) => path.startsWith(prefix),
    ) ||
    parts.some(
      (part) => !part || part === "." || part === ".." || part.includes("\\"),
    )
  )
    return undefined;
  return `/${parts.map(encodeURIComponent).join("/")}`;
}

function durationLabel(seconds: number | null | undefined) {
  if (seconds == null || !Number.isFinite(seconds))
    return "Duration unavailable";
  const rounded = Math.round(seconds);
  return `${Math.floor(rounded / 60)}:${String(rounded % 60).padStart(2, "0")}`;
}

function fileCredits(file: SourceFile) {
  return file.perFileCredits?.names.length
    ? file.perFileCredits.names.join(" + ")
    : "Creator unverified";
}

export default function LoopLibrary({
  onUseFoundation,
  onBuildBeat,
  onPreview,
}: {
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
  onPreview?: () => void;
}) {
  const [kits, setKits] = useState<SourceKit[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  const [pack, setPack] = useState("all");
  const [kind, setKind] = useState<"all" | "audio" | "midi">("all");
  const [search, setSearch] = useState("");
  const [preview, setPreview] = useState<LibraryFile | null>(null);
  const [previewError, setPreviewError] = useState(false);
  const [setup, setSetup] = useState<LibraryFile | null>(null);
  const [imported, setImported] = useState<{
    asset: SampleAsset;
    source: LoopSource;
  } | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [regionError, setRegionError] = useState("");
  const [sourceStart, setSourceStart] = useState("0");
  const [length, setLength] = useState("4");
  const [unit, setUnit] = useState<"bars" | "beats">("bars");
  const [tempo, setTempo] = useState("");
  const [regionPlaying, setRegionPlaying] = useState(false);
  const [bassKey, setBassKey] = useState("");
  const [bassMode, setBassMode] = useState<"major" | "minor">("minor");
  const [beatSeed, setBeatSeed] = useState("");
  const request = useRef<AbortController | null>(null);
  const regionAudio = useRef<AudioContext | null>(null);
  useEffect(
    () => () => {
      request.current?.abort();
      void regionAudio.current?.close();
    },
    [],
  );
  const stopRegion = () => {
    const context = regionAudio.current;
    regionAudio.current = null;
    if (context && context.state !== "closed") void context.close();
    setRegionPlaying(false);
  };
  const stopOtherAudio = () => {
    onPreview?.();
    document.querySelectorAll("audio").forEach((audio) => audio.pause());
  };
  const region = (): LoopRegion => {
    if (!sourceStart.trim() || !length.trim() || !tempo.trim())
      throw new Error("Enter source start, region length and grid tempo.");
    return {
      sourceStart: Number(sourceStart),
      beats: Number(length) * (unit === "bars" ? 4 : 1),
      nativeBpm: Number(tempo),
    };
  };
  const prepare = async (file: LibraryFile) => {
    request.current?.abort();
    const abort = new AbortController();
    request.current = abort;
    stopRegion();
    stopOtherAudio();
    setSetup(file);
    setImported(null);
    setPreparing(true);
    setRegionError("");
    setSourceStart("0");
    setLength("4");
    setUnit("bars");
    setTempo("");
    setBassKey("");
    setBassMode("minor");
    setBeatSeed(`LOOP-${crypto.randomUUID().slice(0, 8).toUpperCase()}`);
    setPreview(file);
    setPreviewError(false);
    const source: LoopSource = {
      filename: file.originalFilename,
      path: file.path,
      sha256: file.sha256,
      creator: fileCredits(file),
      creditBasis: `${file.perFileCredits?.basis ?? "Per-file attribution unverified"}. Pack: ${file.kit.archive}; ${file.kit.creditBasis ?? file.kit.creator}`,
      terms: [
        file.kit.termsSummary,
        ...file.kit.sourceDocuments.map(
          (document) =>
            `Source document: ${document.path}\nSHA-256: ${document.sha256 ?? "not supplied"}\n${document.text ?? "Original document retained in source pack"}`,
        ),
      ].join("\n\n"),
      filenameBpm: file.filenameHints?.tempoBpm,
      filenameKey: file.filenameHints?.key,
    };
    try {
      const response = await fetch(sourceUrl(file.path)!, {
        signal: abort.signal,
        cache: "no-store",
      });
      if (!response.ok)
        throw new Error(`Source request failed (${response.status}).`);
      const bytes = await response.arrayBuffer();
      if (bytes.byteLength !== file.bytes)
        throw new Error("Source size differs from the library catalogue.");
      const asset = await importLoopSource(
        new File([bytes], file.originalFilename),
        source,
      );
      if (!abort.signal.aborted) setImported({ asset, source });
    } catch (error) {
      if (!abort.signal.aborted) setRegionError((error as Error).message);
    } finally {
      if (!abort.signal.aborted) setPreparing(false);
    }
  };
  const playRegion = async () => {
    if (!imported) return;
    stopRegion();
    stopOtherAudio();
    setRegionError("");
    let context: AudioContext | undefined;
    try {
      const chosen = checkedLoopRegion(
        region(),
        imported.asset.duration ?? imported.asset.trimEnd,
      );
      context = new AudioContext();
      regionAudio.current = context;
      const bytes = Uint8Array.from(
        atob(imported.asset.data.split(",")[1]),
        (c) => c.charCodeAt(0),
      );
      const buffer = await context.decodeAudioData(bytes.buffer);
      if (regionAudio.current !== context) return;
      await context.resume();
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(context.destination);
      source.onended = () => {
        if (regionAudio.current === context) stopRegion();
      };
      source.start(0, chosen.sourceStart, chosen.sourceDuration);
      setRegionPlaying(true);
    } catch (error) {
      if (!context || regionAudio.current === context) {
        stopRegion();
        setRegionError((error as Error).message);
      }
    }
  };

  useEffect(() => {
    const abort = new AbortController();
    setLoading(true);
    setError("");
    void Promise.all(
      CATALOGUES.map(async (catalogue) => {
        const response = await fetch(catalogue, { signal: abort.signal });
        if (!response.ok) throw new Error("Catalogue unavailable");
        const data: { kits?: SourceKit[] } = await response.json();
        if (
          !Array.isArray(data.kits) ||
          data.kits.length === 0 ||
          data.kits.some((kit) => !Array.isArray(kit.files))
        )
          throw new Error("Catalogue invalid");
        return data.kits;
      }),
    )
      .then((catalogues) => {
        if (!abort.signal.aborted) setKits(catalogues.flat());
      })
      .catch(() => {
        if (!abort.signal.aborted)
          setError(
            "The private source library is unavailable on this server. Open the local project to use these packs.",
          );
      })
      .finally(() => {
        if (!abort.signal.aborted) setLoading(false);
      });
    return () => abort.abort();
  }, [reload]);

  const files = useMemo(
    () =>
      kits.flatMap((kit) =>
        kit.files
          .filter(
            (file) =>
              (file.kind === "audio" || file.kind === "midi") &&
              sourceUrl(file.path),
          )
          .map((file) => ({ ...file, kit })),
      ),
    [kits],
  );
  const visible = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    return files.filter(
      (file) =>
        (pack === "all" || file.kit.id === pack) &&
        (kind === "all" || file.kind === kind) &&
        (!query ||
          `${file.originalFilename} ${file.kit.archive} ${fileCredits(file)}`
            .toLocaleLowerCase()
            .includes(query)),
    );
  }, [files, pack, kind, search]);
  const audioCount = files.filter((file) => file.kind === "audio").length;
  const midiCount = files.filter((file) => file.kind === "midi").length;

  return (
    <section className="loop-library" aria-labelledby="loop-library-title">
      <div className="loop-library-heading">
        <div>
          <span className="eyebrow">YOUR SOURCE FILES</span>
          <h3 id="loop-library-title">Loop library</h3>
        </div>
        {!loading && !error && (
          <span className="loop-library-count">
            {audioCount} audio · {midiCount} MIDI
          </span>
        )}
      </div>
      <p className="loop-library-intro">
        Pick the sample that supplies the melody. Build a full arrangement with
        new bass and drums, or open its audio alone.
      </p>
      {loading && (
        <p role="status" className="loop-library-status">
          Loading source catalogue…
        </p>
      )}
      {error && (
        <div className="loop-library-status" role="status">
          <p>{error}</p>
          <button
            className="secondary"
            onClick={() => setReload((value) => value + 1)}
          >
            Retry library
          </button>
        </div>
      )}
      {!loading && !error && (
        <>
          <div
            className="loop-library-packs"
            aria-label="Filter by source pack"
          >
            {kits.map((kit) => {
              const audio = kit.files.filter(
                (file) => file.kind === "audio",
              ).length;
              const midi = kit.files.filter(
                (file) => file.kind === "midi",
              ).length;
              return (
                <button
                  key={kit.id}
                  className={pack === kit.id ? "selected" : ""}
                  aria-pressed={pack === kit.id}
                  onClick={() => setPack(pack === kit.id ? "all" : kit.id)}
                >
                  <strong>
                    {PACK_NAMES[kit.id] ?? kit.archive.replace(/\.zip$/i, "")}
                  </strong>
                  <span>
                    {audio} audio{midi > 0 ? ` · ${midi} MIDI` : ""}
                  </span>
                  <small>{kit.creator}</small>
                </button>
              );
            })}
          </div>
          <div className="loop-library-filters">
            <label className="loop-library-search">
              <span className="sr-only">Search source files</span>
              <input
                type="search"
                aria-label="Search source files"
                placeholder="Search files or creators…"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </label>
            <select
              aria-label="Source file type"
              value={kind}
              onChange={(event) => setKind(event.target.value as typeof kind)}
            >
              <option value="all">Audio + MIDI</option>
              <option value="audio">Audio only</option>
              <option value="midi">MIDI only</option>
            </select>
            <button
              className="secondary"
              disabled={pack === "all" && kind === "all" && search === ""}
              onClick={() => {
                setPack("all");
                setKind("all");
                setSearch("");
              }}
            >
              All files
            </button>
          </div>
          <p className="loop-library-note">
            Filename BPM is unverified. Preview the full source to choose a
            region and check its grid and harmony.
          </p>
          {preview && (
            <div className="loop-library-preview">
              <div className="loop-library-preview-heading">
                <div>
                  <span className="eyebrow">SOURCE PREVIEW</span>
                  <strong>{preview.originalFilename}</strong>
                </div>
                <button
                  className="secondary"
                  aria-label="Close source preview"
                  onClick={() => setPreview(null)}
                >
                  Close
                </button>
              </div>
              <audio
                key={preview.path}
                controls
                preload="none"
                src={sourceUrl(preview.path)}
                aria-label={`Preview ${preview.originalFilename}`}
                onError={() => setPreviewError(true)}
                onPlay={(event) => {
                  onPreview?.();
                  stopRegion();
                  document.querySelectorAll("audio").forEach((audio) => {
                    if (audio !== event.currentTarget) audio.pause();
                  });
                }}
              />
              {previewError && (
                <p role="status">
                  This source could not play here. Download it to open in your
                  audio editor.
                </p>
              )}
              <div className="loop-library-preview-meta">
                <span>
                  {fileCredits(preview)} ·{" "}
                  {durationLabel(preview.audio?.durationSeconds)} full source
                </span>
                <a
                  className="loop-library-download"
                  href={sourceUrl(preview.path)}
                  download={preview.originalFilename}
                >
                  Download source
                </a>
              </div>
            </div>
          )}
          {setup && (
            <div className="sample-settings" aria-label="Loop foundation setup">
              <h4>Build a beat from this loop</h4>
              <p>
                <strong>{setup.originalFilename}</strong> · {fileCredits(setup)}
              </p>
              <p>
                Set a complete source phrase, its grid tempo and a bass key to
                try. The sample supplies the melody. The beat adds bass/drums
                and a roughly two-minute arrangement with a beginning, reduced
                section, return and ending. No generated melody is layered over
                the source.
              </p>
              {preparing && (
                <p role="status">
                  Reading, decoding and checking original source bytes…
                </p>
              )}
              {imported && (
                <p>
                  Decoded source:{" "}
                  {(imported.asset.duration ?? imported.asset.trimEnd).toFixed(
                    3,
                  )}{" "}
                  seconds · original bytes embedded · hash verified.
                </p>
              )}
              <div className="settings-grid">
                <label>
                  Source start (seconds)
                  <input
                    aria-label="Foundation source start"
                    type="number"
                    min="0"
                    step="0.001"
                    value={sourceStart}
                    onChange={(e) => setSourceStart(e.target.value)}
                  />
                </label>
                <label>
                  Region length
                  <input
                    aria-label="Foundation region length"
                    type="number"
                    min={unit === "bars" ? "0.0625" : "0.25"}
                    max={unit === "bars" ? "8" : "32"}
                    step={unit === "bars" ? "0.0625" : "0.25"}
                    value={length}
                    onChange={(e) => setLength(e.target.value)}
                  />
                </label>
                <label>
                  Length unit
                  <select
                    aria-label="Foundation length unit"
                    value={unit}
                    onChange={(e) => {
                      const next = e.target.value as "bars" | "beats";
                      setLength(
                        String(Number(length) * (next === "beats" ? 4 : 0.25)),
                      );
                      setUnit(next);
                    }}
                  >
                    <option value="bars">Bars (4 beats)</option>
                    <option value="beats">Beats</option>
                  </select>
                </label>
                <label>
                  Source grid tempo (BPM)
                  <input
                    aria-label="Foundation source BPM"
                    type="number"
                    min="40"
                    max="300"
                    step="0.01"
                    placeholder="Enter checked tempo"
                    value={tempo}
                    onChange={(e) => setTempo(e.target.value)}
                  />
                </label>
              </div>
              <div className="settings-grid">
                <label>
                  Bass key basis (user choice)
                  <select
                    aria-label="Loop beat bass key"
                    value={bassKey}
                    onChange={(e) => setBassKey(e.target.value)}
                  >
                    <option value="">
                      Source key unverified — choose a basis
                    </option>
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
                    aria-label="Loop beat mode"
                    value={bassMode}
                    onChange={(e) =>
                      setBassMode(e.target.value as "major" | "minor")
                    }
                  >
                    <option value="minor">Minor</option>
                    <option value="major">Major</option>
                  </select>
                </label>
                <label>
                  Beat seed
                  <input
                    aria-label="Loop beat seed"
                    value={beatSeed}
                    maxLength={128}
                    onChange={(e) => setBeatSeed(e.target.value)}
                  />
                </label>
              </div>
              <p>
                Key is not detected. Your choice sets sparse root/fifth bass
                support; check it against the sample and change it in Audio if
                needed.
                {setup.filenameHints?.key
                  ? ` Filename key: ${setup.filenameHints.key} (unverified).`
                  : ""}
                Use 1, 2, 4 or 8 complete bars for a beat. A/B/C share this
                source and have different new bass/drum patterns.
              </p>
              {setup.filenameHints?.tempoBpm != null && (
                <button
                  className="secondary"
                  onClick={() =>
                    setTempo(String(setup.filenameHints!.tempoBpm))
                  }
                >
                  Use filename suggestion: {setup.filenameHints.tempoBpm} BPM
                  (unverified)
                </button>
              )}
              <p>
                {tempo && length && Number(tempo) > 0
                  ? `${((Number(length) * (unit === "bars" ? 4 : 1) * 60) / Number(tempo)).toFixed(3)} seconds of source audio. `
                  : ""}
                Preview the selected audio to check its downbeat and repeat
                boundary. Audio plays at its native rate. Other lengths can open
                as a source-only foundation.
              </p>
              {regionError && <p role="alert">{regionError}</p>}
              <div className="settings-grid">
                <button
                  className="secondary"
                  disabled={!imported || preparing}
                  onClick={() =>
                    regionPlaying ? stopRegion() : void playRegion()
                  }
                >
                  {regionPlaying
                    ? "Stop region preview"
                    : "Preview selected region"}
                </button>
                <button
                  disabled={
                    !imported || preparing || bassKey === "" || !beatSeed.trim()
                  }
                  onClick={() => {
                    if (!imported || bassKey === "") return;
                    try {
                      stopRegion();
                      stopOtherAudio();
                      onBuildBeat(imported.asset, imported.source, region(), {
                        key: Number(bassKey),
                        mode: bassMode,
                        seed: beatSeed,
                      });
                      setSetup(null);
                      setImported(null);
                      setRegionError("");
                    } catch (error) {
                      setRegionError((error as Error).message);
                    }
                  }}
                >
                  Build beat from this loop
                </button>
                <button
                  className="secondary"
                  disabled={!imported || preparing}
                  onClick={() => {
                    if (!imported) return;
                    try {
                      const selected = region();
                      checkedLoopRegion(
                        selected,
                        imported.asset.duration ?? imported.asset.trimEnd,
                      );
                      stopRegion();
                      stopOtherAudio();
                      onUseFoundation(
                        imported.asset,
                        imported.source,
                        selected,
                      );
                      setSetup(null);
                      setImported(null);
                      setRegionError("");
                    } catch (error) {
                      setRegionError((error as Error).message);
                    }
                  }}
                >
                  Open source only · empty support lanes
                </button>
                <button
                  className="secondary"
                  onClick={() => {
                    request.current?.abort();
                    stopRegion();
                    setSetup(null);
                    setImported(null);
                  }}
                >
                  Cancel region setup
                </button>
              </div>
              <details>
                <summary>Retained source credits and terms</summary>
                <p>
                  {imported?.source.creditBasis ?? setup.perFileCredits?.basis}
                </p>
                <pre style={{ whiteSpace: "pre-wrap" }}>
                  {imported?.source.terms ?? setup.kit.termsSummary}
                </pre>
              </details>
            </div>
          )}
          <div className="loop-library-results-heading" aria-live="polite">
            <span>
              {visible.length} source {visible.length === 1 ? "file" : "files"}
              {pack !== "all" ? ` in ${PACK_NAMES[pack] ?? pack}` : ""}
            </span>
            <span>Original files</span>
          </div>
          <ul className="loop-library-files" aria-label="Source files">
            {visible.map((file) => (
              <li
                key={file.path}
                className={preview?.path === file.path ? "selected" : ""}
              >
                <div className="loop-library-file-info">
                  <strong>{file.originalFilename}</strong>
                  <span>
                    {PACK_NAMES[file.kit.id] ?? file.kit.id} ·{" "}
                    {fileCredits(file)}
                  </span>
                  <small>
                    {file.kind === "audio"
                      ? `${file.extension.slice(1).toUpperCase()} · ${durationLabel(file.audio?.durationSeconds)}`
                      : "MIDI source"}
                    {file.filenameHints?.tempoBpm != null &&
                      ` · ${file.filenameHints.tempoBpm} BPM in filename (unverified)`}
                  </small>
                </div>
                {file.kind === "audio" ? (
                  <div>
                    <button
                      className="secondary"
                      aria-label={`Preview source ${file.originalFilename}`}
                      aria-pressed={preview?.path === file.path}
                      onClick={() => {
                        setPreview(file);
                        setPreviewError(false);
                      }}
                    >
                      Preview source
                    </button>
                    <button
                      className="secondary"
                      aria-label={`Build a beat from ${file.originalFilename}`}
                      onClick={() => void prepare(file)}
                    >
                      Build beat from loop
                    </button>
                  </div>
                ) : (
                  <a
                    className="loop-library-download"
                    href={sourceUrl(file.path)}
                    download={file.originalFilename}
                  >
                    Download MIDI
                  </a>
                )}
              </li>
            ))}
          </ul>
          {visible.length === 0 && (
            <p className="loop-library-empty">No files match these filters.</p>
          )}
          <details className="loop-library-credits">
            <summary>Pack credits &amp; source terms</summary>
            {kits.map((kit) => (
              <div key={kit.id}>
                <strong>
                  {PACK_NAMES[kit.id] ?? kit.archive} · {kit.creator}
                </strong>
                <p>{kit.termsSummary}</p>
                {kit.sourceDocuments
                  .filter((document) => sourceUrl(document.path))
                  .map((document) => (
                    <a
                      key={document.path}
                      href={sourceUrl(document.path)}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Read original terms ↗
                    </a>
                  ))}
              </div>
            ))}
          </details>
        </>
      )}
    </section>
  );
}
