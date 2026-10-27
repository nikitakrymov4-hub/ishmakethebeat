import { rewriteLoopSupport } from "./io/rewrite-loop-support";
import { useEffect, useRef, useState } from "react";
import type {
  Candidate,
  Note,
  Project,
  Role,
  Settings,
  Track,
  ProfileId,
} from "./engine/schema";
import {
  BAR,
  KEYS,
  LOOP_TICKS,
  clone,
  isDrum,
  seconds,
  VERSION,
} from "./engine/schema";
import {
  DRUM_ROLES,
  generateCandidates,
  newProject,
  pendingProject,
  rewrite,
  assess,
} from "./engine/compose";
import { getPrivatePalette, setPrivatePalette } from "./engine/culture";
import { importMidi } from "./io/import-midi";
import { defaultSettings, PROFILES } from "./engine/profiles";
import { totalTicks } from "./engine/score";
import { USER_KIT_ID, applyDrumKit } from "./engine/studio-palette";
import { withStudioVocals } from "./engine/studio-vox";
import { mixProject } from "./engine/mix";
import AuraOriginalControls from "./components/AuraOriginalControls";
import MixControls from "./components/MixControls";
import SuppliedKitLibrary from "./components/SuppliedKitLibrary";
import { rememberUserDrums } from "./io/user-drum-bank";
import {
  BASS_PRESETS,
  DRUM_PRESETS,
  PRESETS,
  instrumentName,
} from "./audio/bank";
import { Transport } from "./audio/transport";
import { download, exportStems, portableZip, renderWav } from "./io/export";
import { exportMidi } from "./io/midi";
import {
  importSample,
  loadFile,
  loadLocal,
  missingAssets,
  saveLocal,
} from "./io/persistence";
import Icon from "./components/Icon";
import PianoRoll from "./components/PianoRoll";
import DrumEditor from "./components/DrumEditor";
import Arrangement from "./components/Arrangement";
import Reference from "./components/Reference";
import ListeningRoom from "./components/ListeningRoom";
import RoleProcessing from "./components/RoleProcessing";
import AudioRegions from "./components/AudioRegions";
import VocalEvents from "./components/VocalEvents";
import DrumKitLibrary from "./components/DrumKitLibrary";
import { upgradeEnsemble } from "./engine/ensemble";
import { loopProject } from "./engine/loop";
import { createReversePickup } from "./io/resample";
import { isLoopFoundation, loopFoundation } from "./io/loop-foundation";
import { isLoopBeat, loopBeat, rebuildLoopBeat } from "./io/loop-beat";

const colors: Record<string, string> = {
  melody: "#a2c990",
  pad: "#6a9f90",
  answer: "#83a9bd",
  bass: "#c7a47c",
  kick: "#b7a18a",
  clap: "#a68c9e",
  hat: "#888fa8",
  open: "#888fa8",
  perc: "#a49b72",
  keys: "#b3bd94",
  bridge: "#90b8b3",
  pedal: "#aa9dc0",
};
function MiniScore({ candidate }: { candidate: Candidate }) {
  return (
    <svg viewBox="0 0 260 45" className="mini-score" aria-hidden="true">
      {candidate.tracks
        .filter((t) => ["melody", "bass"].includes(t.id))
        .map((t) =>
          t.notes.map((n) => (
            <rect
              key={`${t.id}-${n.id}`}
              x={(n.tick / LOOP_TICKS) * 260}
              y={
                t.id === "bass"
                  ? 34 + (n.pitch % 12) / 4
                  : 3 + (90 - n.pitch) * 0.8
              }
              width={Math.max(2, (n.duration / LOOP_TICKS) * 260 - 1)}
              height={t.id === "bass" ? 3 : 2.5}
              rx="1"
              fill={colors[t.id]}
              opacity={t.id === "bass" ? 0.5 : 0.85}
            />
          )),
        )}
    </svg>
  );
}
function Range({
  name,
  value,
  onChange,
  min = 0,
  max = 1,
  step = 0.01,
  description,
}: {
  name: string;
  value: number;
  onChange: (n: number) => void;
  min?: number;
  max?: number;
  step?: number;
  description?: string;
}) {
  return (
    <label className="range-row" title={description}>
      <span>{name}</span>
      <span className="mono range-value">
        {max === 1 ? Math.round(value * 100) : value}
        {max === 1 ? "%" : ""}
      </span>
      <input
        aria-label={name}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(+e.target.value)}
      />
    </label>
  );
}
const initialProject = pendingProject();
export default function App() {
  const [p, setP] = useState<Project>(initialProject),
    [draft, setDraft] = useState(initialProject.settings),
    [selectedTrack, setSelectedTrack] = useState<Role>("melody"),
    [tab, setTab] = useState("piano"),
    [rightTab, setRightTab] = useState("sound");
  const [midiBars, setMidiBars] = useState(4),
    [midiBase, setMidiBase] = useState(60);
  const [calibrationBpm, setCalibrationBpm] = useState<number | null>(null);
  const [history, setHistory] = useState<Project[]>([]),
    [future, setFuture] = useState<Project[]>([]),
    [loaded, setLoaded] = useState(false),
    [saveStatus, setSaveStatus] = useState("Opening session"),
    [message, setMessage] = useState(""),
    [error, setError] = useState(""),
    [generating, setGenerating] = useState(false),
    [audioBusy, setAudioBusy] = useState(false),
    [playing, setPlaying] = useState(false),
    [tick, setTick] = useState(0),
    [loop, setLoop] = useState(true),
    [modal, setModal] = useState<string | null>(null),
    [exportKind, setExportKind] = useState("mix"),
    [exportArrangement, setExportArrangement] = useState(false),
    [exporting, setExporting] = useState(false),
    [progress, setProgress] = useState(0),
    [text, setText] = useState("");
  const transport = useRef<Transport | null>(null),
    loadInput = useRef<HTMLInputElement>(null),
    sampleInput = useRef<HTMLInputElement>(null),
    tagInput = useRef<HTMLInputElement>(null),
    midiInput = useRef<HTMLInputElement>(null),
    abort = useRef<AbortController | null>(null),
    editorSection = useRef<HTMLElement | null>(null);
  transport.current ??= new Transport();
  const player = transport.current,
    c = p.candidates[p.selected],
    track = c.tracks.find((t) => t.id === selectedTrack) ?? c.tracks[0],
    profile = PROFILES[p.settings.profile];
  const notify = (m: string) => {
    setMessage(m);
    setTimeout(() => setMessage(""), 5500);
  };
  const commit = (next: Project, notice?: string) => {
    setHistory((h) => [...h.slice(-29), p]);
    setFuture([]);
    setP(next);
    if (notice) notify(notice);
  };
  const patchSettings = (patch: Partial<Settings>) => {
    if (
      p.sourceKind === "supplied-loop" &&
      patch.bpm !== undefined &&
      patch.bpm !== p.settings.bpm
    ) {
      notify(
        "This source plays at its native grid. Use Audio clips → linked transpose to change pitch and tempo together.",
      );
      return;
    }
    const next = clone(p);
    next.settings = { ...next.settings, ...patch };
    commit(next);
    setDraft((draft) => ({ ...draft, ...patch }));
  };
  const changeTrack = (id: Role, patch: Partial<Track>) => {
    const next = clone(p);
    const index = next.candidates[next.selected].tracks.findIndex(
      (t) => t.id === id,
    );
    if (index < 0) return;
    next.candidates[next.selected].tracks[index] = {
      ...next.candidates[next.selected].tracks[index],
      ...patch,
    };
    next.candidates[next.selected].metrics = assess(
      next.candidates[next.selected],
    );
    commit(next);
  };
  useEffect(() => {
    if (!c.tracks.some((t) => t.id === selectedTrack))
      setSelectedTrack("melody");
  }, [c, selectedTrack]);
  const notes = (id: Role, value: Note[]) => {
    let normalized = value
      .map((n) => ({
        ...n,
        duration: Math.max(1, Math.min(n.duration, LOOP_TICKS - n.tick)),
      }))
      .sort((a, b) => a.tick - b.tick);
    if (id === "bass") {
      normalized = [...new Map(normalized.map((n) => [n.tick, n])).values()];
      normalized.forEach(
        (n, i) =>
          (n.duration = Math.min(
            n.duration,
            (normalized[i + 1]?.tick ?? LOOP_TICKS) - n.tick,
          )),
      );
    }
    for (const n of normalized)
      if (n.glide && n.glide.at >= n.duration) delete n.glide;
    changeTrack(id, { notes: normalized });
  };
  useEffect(() => {
    let alive = true;
    void Promise.all([
      loadLocal(),
      Promise.all(
        ["bank.json", "new-palette.json", "user-tdf-kit-20261016.json"].map(
          (name) =>
            fetch(`/private-assets/${name}`)
              .then((r) => (r.ok ? r.json() : []))
              .catch(() => []),
        ),
      ).then((banks) => banks.flat()),
    ])
      .then(([saved, assets]) => {
        if (!alive) return;
        setPrivatePalette(assets);
        if (saved) {
          rememberUserDrums(saved.assets);
          setP(saved);
          setDraft(
            saved.settings.profile === "culture"
              ? saved.settings
              : { ...defaultSettings(), seed: saved.settings.seed },
          );
          setExportArrangement(saved.arrangement);
          setSaveStatus("Session recovered");
        } else {
          const fresh = newProject({
            ...defaultSettings(),
            drumKitId: USER_KIT_ID,
            voxDensity: "off",
          });
          setP(fresh);
          setDraft(fresh.settings);
        }
      })
      .catch((e) => {
        if (alive) setError(`Session setup: ${e.message}`);
      })
      .finally(() => {
        if (alive) setLoaded(true);
      });
    return () => {
      alive = false;
    };
  }, []);
  useEffect(() => {
    if (!loaded || p.generator === "ish-kit-required") return;
    setSaveStatus("Saving locally…");
    const timer = setTimeout(() => {
      void saveLocal(p)
        .then(() => setSaveStatus("All changes saved"))
        .catch((e) => {
          setSaveStatus("Autosave failed");
          setError(
            `Local storage could not save this session: ${e.message}. Export a portable project.`,
          );
        });
    }, 650);
    return () => clearTimeout(timer);
  }, [p, loaded]);
  useEffect(() => {
    player.onUpdate = (position, on) => {
      setTick(position);
      setPlaying(on);
    };
    return () => player.stop();
  }, [player]);
  useEffect(() => {
    player.updateAtBoundary(p);
  }, [p, player]);
  useEffect(() => {
    player.loop = loop;
  }, [loop, player]);
  const play = async () => {
    setError("");
    document.querySelectorAll("audio").forEach((a) => a.pause());
    if (player.playing) {
      player.pause();
      return;
    }
    setAudioBusy(true);
    try {
      if (p.generator === "ish-kit-required")
        throw new Error(
          "Load the existing TDF/Culture or TDF stash kit before generating or playing a new beat.",
        );
      const missing = missingAssets(p);
      if (missing.length)
        throw new Error(
          `Missing samples for ${missing.join(", ")}. Replace them in the Sound panel.`,
        );
      await player.play(p);
    } catch (e) {
      player.stop();
      setError(`Audio could not start: ${(e as Error).message}`);
    } finally {
      setAudioBusy(false);
    }
  };
  const undo = () => {
    if (!history.length) return;
    setFuture((f) => [p, ...f]);
    setP(history.at(-1)!);
    setHistory((h) => h.slice(0, -1));
  };
  const redo = () => {
    if (!future.length) return;
    setHistory((h) => [...h, p]);
    setP(future[0]);
    setFuture((f) => f.slice(1));
  };
  useEffect(() => {
    const handle = (e: KeyboardEvent) => {
      if (
        ["INPUT", "SELECT", "TEXTAREA"].includes(
          (e.target as HTMLElement).tagName,
        )
      )
        return;
      if (e.code === "Space") {
        e.preventDefault();
        void play();
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "z") {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        void saveLocal(p).then(() => notify("Session saved on this device."));
      }
    };
    window.addEventListener("keydown", handle);
    return () => window.removeEventListener("keydown", handle);
  });
  const generate = async (newIdea = false, originalScore = false) => {
    setGenerating(true);
    setError("");
    await new Promise((r) => setTimeout(r, 50));
    try {
      if (isLoopBeat(p) && !originalScore) {
        if (!["major", "minor"].includes(draft.mode))
          throw new Error(
            "For loop bass support, choose a major or minor basis. The source harmony is not automatically detected.",
          );
        const next = rebuildLoopBeat(
          { ...p, settings: { ...p.settings, drumKitId: draft.drumKitId } },
          {
            key: draft.key,
            mode: draft.mode as "major" | "minor",
            seed: newIdea
              ? `LOOP-${crypto.randomUUID().slice(0, 8).toUpperCase()}`
              : draft.seed,
          },
        );
        player.stop();
        setDraft(next.settings);
        setCalibrationBpm(null);
        commit(
          next,
          "Three new bass/drum choices around the same sample. Source melody and arrangement retained.",
        );
        return;
      }
      const next = clone(p),
        settings = {
          ...p.settings,
          ...draft,
          bpm:
            calibrationBpm ??
            (draft.profile === p.settings.profile ? p.settings.bpm : draft.bpm),
          seed: newIdea
            ? `ISH-${crypto.randomUUID().slice(0, 8).toUpperCase()}`
            : draft.seed,
        };
      if (
        settings.profile === p.settings.profile &&
        p.candidates.some((c) =>
          c.tracks.some((t) => t.locked && !isDrum(t.id)),
        )
      ) {
        settings.key = p.settings.key;
        settings.mode = p.settings.mode;
      }
      next.settings = settings;
      next.generator = settings.profile === "culture" ? VERSION : "ish-1.0.0";
      {
        for (const asset of getPrivatePalette())
          if (!next.assets.some((a) => a.id === asset.id))
            next.assets.push(asset);
      }
      next.candidates = generateCandidates(
        settings,
        settings.profile === p.settings.profile ? p.candidates : undefined,
      );
      delete next.auraOriginal; // Explicit legacy Generate leaves the separate Aura workflow.
      next.clips = [];
      next.sourceKind = "original-score";
      if (p.sourceKind === "supplied-loop") {
        next.title = "Untitled original-score session";
        next.tagEnabled = false;
        next.tagAsset = undefined;
      }
      next.selected = 0;
      setCalibrationBpm(null);
      setDraft(settings);
      delete next.mixPass;
      commit(
        withStudioVocals(next),
        "Three original ideas are ready. Audition A, B, and C. Kit and mix choices remain editable.",
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setGenerating(false);
    }
  };
  const regenerate = (roles?: Role[]) => {
    if (isLoopBeat(p)) {
      if (roles?.some((role) => role !== "bass" && !isDrum(role))) {
        notify(
          "This beat's melody comes from the sample. Choose another source in Audio or use the explicit original-score action.",
        );
        return;
      }
      const seed = `LOOP-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
      const next = rewriteLoopSupport(p, roles, seed);
      setDraft(next.settings);
      commit(
        next,
        "Requested unlocked support parts rewritten; other parts, sample melody and arrangement retained.",
      );
      return;
    }
    if (p.sourceKind === "supplied-loop") {
      if (roles?.some((r) => !isDrum(r))) {
        notify(
          isLoopFoundation(p)
            ? "Source key is unverified. Set and check its harmony before writing bass or melody; drum rewrites remain available."
            : "Loop harmony is provisional. Edit the sparse bass support in the piano roll; drum rewrites remain available.",
        );
        return;
      }
      roles ??= DRUM_ROLES;
    }
    const locked = c.tracks.filter(
      (t) => t.locked && (!roles || roles.includes(t.id)),
    );
    commit(
      rewrite(p, roles),
      `${roles ? "Selected parts rewritten" : "Variation created"}${locked.length ? ` · ${locked.length} locked parts kept` : ""}. Harmony remains compatible with the current bass.`,
    );
  };
  const upgradeCurrent = () => {
    if (p.sourceKind === "supplied-loop") {
      notify(
        "Open an original-score session to upgrade its melody. The supplied loop keeps its own source harmony.",
      );
      return;
    }
    try {
      const next = upgradeEnsemble(p, [
        ...new Map(
          [...p.assets, ...getPrivatePalette()].map((a) => [a.id, a]),
        ).values(),
      ]);
      for (const candidate of next.candidates)
        candidate.metrics = assess(candidate);
      commit(
        next,
        "Melody notes retained. Ensemble, phrase pocket and role effects updated.",
      );
      setDraft(next.settings);
      setCalibrationBpm(null);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const loadLoopCandidate = async () => {
    try {
      const bank = await (
        await fetch("/private-assets/loop10-bank.json")
      ).json();
      const assets = [
        ...new Map(
          [...getPrivatePalette(), ...bank].map((a) => [a.id, a]),
        ).values(),
      ] as Project["assets"];
      const source = assets.find((a) => a.role === "loop");
      if (!source)
        throw new Error(
          "The supplied loop bank is not installed in this checkout.",
        );
      const next = loopProject(
        assets,
        source,
        assets.find((a) => a.role === "tag"),
      );
      player.stop();
      commit(
        next,
        "Direct loop candidate opened. @lilfrus source and tag retained; tonal support awaits listening review.",
      );
      setDraft(next.settings);
      setCalibrationBpm(null);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const reverseSelected = async () => {
    setAudioBusy(true);
    try {
      const result = await createReversePickup(p, selectedTrack),
        next = clone(p);
      if (!next.assets.some((a) => a.id === result.asset.id))
        next.assets.push(result.asset);
      next.clips = [
        ...(next.clips ?? []).filter((c) => c.id !== result.clip.id),
        result.clip,
      ];
      commit(
        next,
        "Original role rendered, selected region reversed and placed as a pickup. Source score and transform retained.",
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setAudioBusy(false);
    }
  };
  const load = async (file: File) => {
    try {
      const project = await loadFile(file);
      rememberUserDrums(project.assets);
      player.stop();
      commit(project);
      setDraft(project.settings);
      setCalibrationBpm(null);
      const missing = missingAssets(project);
      notify(
        missing.length
          ? `Missing samples: ${missing.join(", ")}. Replace them to audition.`
          : "Project loaded with its score, settings, and embedded samples.",
      );
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const addSample = async (file: File, tag = false) => {
    try {
      const asset = await importSample(file, tag ? "tag" : selectedTrack),
        next = clone(p);
      const existingAsset = next.assets.find((a) => a.id === asset.id);
      if (!existingAsset) next.assets.push(asset);
      else {
        existingAsset.sampleRate = asset.sampleRate;
        existingAsset.channels = asset.channels;
      }
      if (tag) {
        next.tagAsset = asset.id;
        next.tagEnabled = true;
      } else
        next.candidates[next.selected].tracks.find(
          (t) => t.id === selectedTrack,
        )!.instrument = asset.id;
      commit(next);
      notify("WAV imported and embedded in the project.");
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const runExport = async () => {
    setExporting(true);
    setProgress(0);
    setError("");
    abort.current = new AbortController();
    const project = { ...p, arrangement: exportArrangement },
      base = `ishmakethebeat-${p.settings.profile}-${exportArrangement ? "song" : "loop"}`;
    try {
      const missing = missingAssets(project);
      if (missing.length && ["mix", "headroom", "stems"].includes(exportKind))
        throw new Error(`Missing samples: ${missing.join(", ")}`);
      if (exportKind === "mix" || exportKind === "headroom") {
        const result = await renderWav(
          project,
          exportKind,
          abort.current.signal,
          setProgress,
        );
        download(result.wav, `${base}.wav`, "audio/wav");
        notify(
          `WAV rendered · ${result.duration.toFixed(1)} sec · peak ${(20 * Math.log10(result.peak || 0.00001)).toFixed(1)} dBFS`,
        );
      } else if (exportKind === "stems") {
        download(
          await exportStems(project, abort.current.signal, setProgress),
          `${base}-stems.zip`,
          "application/zip",
        );
        notify("Aligned dry stems and shared effects return exported.");
      } else if (exportKind === "midi") {
        download(exportMidi(project), `${base}.mid`, "audio/midi");
        notify("Type-1 MIDI exported with a dedicated 808 bend channel.");
      } else if (exportKind === "portable") {
        download(portableZip(project), `${base}.ish.zip`, "application/zip");
        notify("Portable project exported with embedded samples and MIDI.");
      } else {
        download(
          JSON.stringify(project, null, 2),
          `${base}.ish.json`,
          "application/json",
        );
        notify("Project JSON exported, including embedded sample data.");
      }
      setProgress(1);
    } catch (e) {
      if ((e as Error).name === "AbortError")
        notify("Export cancelled; no file was downloaded.");
      else setError(`Export failed: ${(e as Error).message}`);
    } finally {
      setExporting(false);
    }
  };
  const audition = (kind: string) => {
    const next = clone(p);
    for (const t of next.candidates[next.selected].tracks) {
      t.solo =
        kind === "full"
          ? false
          : kind === "melody"
            ? ["melody", "pad", "answer", "keys", "bridge", "pedal"].includes(
                t.id,
              )
            : kind === "bass"
              ? t.id === "bass"
              : isDrum(t.id);
      t.mute = false;
      if (p.sourceKind === "supplied-loop" && kind === "melody") {
        t.solo = false;
        t.mute = true;
      }
    }
    commit(next);
  };
  const parseInstruction = () => {
    const phrase = text.toLowerCase().trim(),
      next = clone(p);
    let label = "";
    if (phrase === "less busy") {
      next.settings.density = Math.max(0.1, next.settings.density - 0.2);
      next.settings.noteDensity = Math.max(
        0.15,
        next.settings.noteDensity - 0.15,
      );
      label = "Drum and note density reduced";
    } else if (phrase === "more airy") {
      next.settings.space = Math.min(1, next.settings.space + 0.18);
      next.settings.grit = Math.max(0, next.settings.grit - 0.12);
      label = "Space increased; grit reduced";
    } else if (phrase === "harder bass") {
      next.settings.grit = Math.min(1, next.settings.grit + 0.2);
      label = "Bass saturation increased";
    } else if (phrase === "more variation") {
      next.settings.variation = Math.min(1, next.settings.variation + 0.2);
      label = "Phrase variation increased";
    } else {
      notify(
        "Supported phrases: “less busy”, “more airy”, “harder bass”, “more variation”.",
      );
      return;
    }
    const result =
      phrase === "less busy" && next.sourceKind === "supplied-loop"
        ? isLoopBeat(next)
          ? rewriteLoopSupport(next, DRUM_ROLES, next.settings.seed)
          : rewrite(next, DRUM_ROLES)
        : next;
    if (phrase === "less busy" && next.sourceKind !== "supplied-loop")
      result.candidates = generateCandidates(next.settings, next.candidates);
    commit(result, `${label}. This is an explicit parameter shortcut.`);
    setText("");
  };
  const instruments =
    selectedTrack === "bass"
      ? BASS_PRESETS
      : isDrum(selectedTrack)
        ? DRUM_PRESETS.filter(
            (p) =>
              p.role === selectedTrack ||
              (selectedTrack === "open" && p.role === "hat"),
          )
        : PRESETS;
  const sample = p.assets.find((a) => a.id === track.instrument),
    updateAsset = (patch: Partial<NonNullable<typeof sample>>) => {
      const next = clone(p);
      Object.assign(next.assets.find((a) => a.id === sample?.id)!, patch);
      commit(next);
    };
  const duration = seconds(totalTicks(p), p.settings.bpm),
    loopBeatMode = isLoopBeat(p),
    sampleClip =
      p.sourceKind === "supplied-loop"
        ? p.clips?.find((clip) => clip.kind === "supplied-loop")
        : undefined,
    visibleTracks = c.tracks.filter(
      (t) =>
        !sampleClip || t.notes.length > 0 || t.id === "bass" || isDrum(t.id),
    ),
    sampleSelection =
      !!sampleClip &&
      track.notes.length === 0 &&
      track.id !== "bass" &&
      !isDrum(track.id),
    arrangementBars = p.sections.reduce(
      (bars, section) => bars + section.bars,
      0,
    ),
    arrangementSeconds = Math.round(
      seconds(arrangementBars * BAR, p.settings.bpm),
    ),
    arrangementTime = `${Math.floor(arrangementSeconds / 60)}:${String(arrangementSeconds % 60).padStart(2, "0")}`,
    locked = visibleTracks.filter((t) => t.locked).length;
  const openSampleLibrary = () => {
    setTab("audio");
    requestAnimationFrame(() =>
      editorSection.current?.scrollIntoView({
        behavior: "smooth",
        block: "start",
      }),
    );
  };
  return (
    <div className="studio">
      <header className="app-header">
        <a
          href="#"
          className="brand"
          onClick={(e) => e.preventDefault()}
          aria-label="ishmakethebeat home"
        >
          <span className="brand-symbol">
            <i />
            <i />
            <i />
            <i />
            <i />
          </span>
          ishmakethebeat<span className="brand-period">.</span>
        </a>
        <span className="header-divider" />
        <div className="session-title">
          <input
            aria-label="Project title"
            value={p.title}
            onChange={(e) => commit({ ...p, title: e.target.value })}
          />
          <span>
            <i className="status-dot" />
            {saveStatus}
          </span>
        </div>
        <div className="header-actions">
          <button
            className="icon-button"
            title="Undo (⌘Z)"
            aria-label="Undo"
            disabled={!history.length}
            onClick={undo}
          >
            <Icon name="undo" />
          </button>
          <button
            className="icon-button"
            title="Redo (⇧⌘Z)"
            aria-label="Redo"
            disabled={!future.length}
            onClick={redo}
          >
            <Icon name="redo" />
          </button>
          <span className="header-divider" />
          <button className="subtle" onClick={() => setModal("demos")}>
            <Icon name="folder" size={16} />
            Demos
          </button>
          <button className="subtle" onClick={() => loadInput.current?.click()}>
            <Icon name="folder" size={16} />
            Open
          </button>
          <button
            className="subtle"
            onClick={() => {
              void saveLocal(p)
                .then(() =>
                  notify(
                    "Project saved locally. Use Export for a portable file.",
                  ),
                )
                .catch((e) => setError(e.message));
            }}
          >
            <Icon name="save" size={16} />
            Save
          </button>
          <button
            className="primary export-button"
            onClick={() => {
              setExportArrangement(p.arrangement);
              setModal("export");
            }}
          >
            <Icon name="export" size={16} />
            Export
          </button>
        </div>
      </header>
      <div className="workbench">
        <aside className="left-panel">
          <div className="eyebrow">
            <span>{sampleClip ? "SAMPLE WORKSPACE" : "BEAT WORKSPACE"}</span>
            <span className="small-dot" />
          </div>
          <h2>
            {sampleClip ? "Build around your sample." : "Find your pocket."}
          </h2>
          <p className="intro-copy">
            {sampleClip
              ? "Your source melody, with editable bass, drums and arrangement."
              : "Choose a melody sample, then build a full beat around it."}
          </p>
          <button
            className="primary sample-start-button"
            onClick={openSampleLibrary}
          >
            <Icon name="wave" size={18} />
            <span>Make a beat from a sample</span>
            <span aria-hidden="true">↗</span>
          </button>
          {loopBeatMode && sampleClip && (
            <div className="sample-source-summary">
              <span className="eyebrow">SAMPLE MELODY</span>
              <strong title={sampleClip.provenance.sourceName}>
                {sampleClip.provenance.sourceName}
              </strong>
              <small>{sampleClip.provenance.creator}</small>
              <p>
                {arrangementTime} full arrangement · {arrangementBars} bars
              </p>
              <button className="subtle" onClick={openSampleLibrary}>
                Edit source region & credits →
              </button>
            </div>
          )}
          {!loopBeatMode && (
            <>
              <div className="field-heading">
                01 <span>Original-score direction</span>
              </div>
              <div className="profile-list">
                {(["culture"] as ProfileId[]).map((id) => (
                  <button
                    key={id}
                    aria-label={`Select ${PROFILES[id].name}`}
                    className={`profile-card ${draft.profile === id ? "active" : ""}`}
                    onClick={() =>
                      setDraft({
                        ...defaultSettings(id),
                        seed: draft.seed,
                        key: draft.key,
                        mode: draft.mode,
                      })
                    }
                  >
                    <span className="profile-symbol">{PROFILES[id].icon}</span>
                    <span>
                      <strong>{PROFILES[id].name}</strong>
                      <small>{PROFILES[id].subtitle}</small>
                    </span>
                    {draft.profile === id && <span className="radio-dot" />}
                  </button>
                ))}
                <div className="recipe-note">
                  Coordinated keys, pad, lead colors and answers. Phrase
                  gestures above a centered low end.
                </div>
                <button className="secondary" onClick={upgradeCurrent}>
                  Upgrade current melody ensemble
                </button>
                <details className="legacy-profiles">
                  <summary>Open a legacy direction</summary>
                  {(["airy", "spacey", "bright", "dark"] as ProfileId[]).map(
                    (id) => (
                      <button
                        key={id}
                        onClick={() =>
                          setDraft({
                            ...defaultSettings(id),
                            drumKitId: draft.drumKitId,
                            voxDensity: draft.voxDensity,
                          })
                        }
                      >
                        {PROFILES[id].name}
                      </button>
                    ),
                  )}
                </details>
              </div>
            </>
          )}
          <AuraOriginalControls
            project={p}
            settings={draft}
            onCommit={(next, message) => {
              player.stop();
              setDraft(next.settings);
              setExportArrangement(next.arrangement);
              setCalibrationBpm(null);
              commit(next, message);
            }}
          />
          <div className="field-heading">
            {loopBeatMode ? "01" : "02"}{" "}
            <span>
              {loopBeatMode
                ? "Bass & drum variations"
                : "Set the starting point"}
            </span>
          </div>
          <div className="settings-grid">
            <label className="full-width">
              Drum source
              <select
                aria-label="Drum kit"
                value={draft.drumKitId ?? "tdf-original"}
                onChange={(event) =>
                  setDraft({ ...draft, drumKitId: event.target.value })
                }
              >
                <option value={USER_KIT_ID}>
                  Attached stash · @choppahitlikespinz808
                </option>
                <option value="tdf-original">
                  Earlier supplied TDF / Culture kits
                </option>
              </select>
              <small>
                Stash bass, clap/snare, hat and percussion. Kick and open hat
                retain existing verified supplied sources.
              </small>
            </label>
            <button
              className="secondary full-width"
              onClick={() => {
                try {
                  const next = applyDrumKit(
                    p,
                    getPrivatePalette(),
                    draft.drumKitId ?? "tdf-original",
                  );
                  player.stop();
                  setDraft(next.settings);
                  commit(
                    next,
                    "Kit applied to current notes. Melodic parts, rhythm, levels and locked tracks retained.",
                  );
                } catch (error) {
                  setError((error as Error).message);
                }
              }}
            >
              Apply kit to current notes
            </button>
            <label className="full-width">
              Automatic vocal accents
              <select
                aria-label="Generated vox density"
                value={draft.voxDensity ?? "off"}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    voxDensity: event.target.value as Settings["voxDensity"],
                  })
                }
              >
                <option value="off">Off</option>
                <option value="sparse">Sparse · supplied vox</option>
                <option value="regular">Regular · supplied vox</option>
              </select>
              <small>
                Applied on Generate. Existing manual tags and events are
                retained.
              </small>
            </label>
            {!loopBeatMode && (
              <>
                {draft.profile === "culture" && (
                  <>
                    <label className="full-width">
                      Palette &amp; pocket
                      <select
                        aria-label="Palette and groove family"
                        value={draft.cultureFamily ?? "auto"}
                        onChange={(e) =>
                          setDraft({
                            ...draft,
                            cultureFamily: e.target
                              .value as Settings["cultureFamily"],
                          })
                        }
                      >
                        <option value="auto">Explore all three families</option>
                        <option value="paper-lantern">
                          Paper lantern · woven glass / open pocket
                        </option>
                        <option value="glass-garden">
                          Glass garden · velvet / long landings
                        </option>
                        <option value="odd-orbit">
                          Odd orbit · copper keys / clipped bounce
                        </option>
                      </select>
                    </label>
                    <label className="full-width">
                      <input
                        type="checkbox"
                        checked={draft.allowSynthFallback ?? false}
                        onChange={(e) =>
                          setDraft({
                            ...draft,
                            allowSynthFallback: e.target.checked,
                          })
                        }
                      />
                      Allow original synth fallback if private kit is missing
                    </label>
                  </>
                )}
                <label className="full-width">
                  Ensemble
                  <select
                    aria-label="Ensemble writing"
                    value={draft.ensembleMode ?? "conversation"}
                    onChange={(e) => {
                      setDraft({
                        ...draft,
                        ensembleMode: e.target
                          .value as Settings["ensembleMode"],
                      });
                    }}
                  >
                    <option value="conversation">Conversing ensemble</option>
                    <option value="simple">
                      Simple melody + selective support
                    </option>
                  </select>
                </label>
                <label className="full-width">
                  Calibration grid
                  <select
                    aria-label="Calibration tempo grid"
                    value={draft.grid ?? "double-time"}
                    onChange={(e) => {
                      setCalibrationBpm(
                        e.target.value === "half-time" ? 75 : 150,
                      );
                      setDraft({
                        ...draft,
                        grid: e.target.value as Settings["grid"],
                        bpm: e.target.value === "half-time" ? 75 : 150,
                      });
                    }}
                  >
                    <option value="double-time">150 BPM · double-time</option>
                    <option value="half-time">75 BPM · half-time</option>
                  </select>
                  <small>
                    4/4; 8 bars = {((8 * 4 * 60) / draft.bpm).toFixed(2)}s at{" "}
                    {draft.bpm.toFixed(1)} BPM. Half-time uses half as many bars
                    for the same duration.
                  </small>
                </label>
              </>
            )}
            <label>
              {loopBeatMode ? "Bass key basis" : "Key"}
              <select
                aria-label="Generation key"
                value={draft.key}
                onChange={(e) => setDraft({ ...draft, key: +e.target.value })}
              >
                {KEYS.map((k, i) => (
                  <option key={k} value={i}>
                    {k}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {loopBeatMode ? "Mode basis" : "Scale"}
              <select
                aria-label="Generation mode"
                value={draft.mode}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    mode: e.target.value as Settings["mode"],
                  })
                }
              >
                <option value="minor">Minor</option>
                {!loopBeatMode && (
                  <option value="pentatonic">Minor pent.</option>
                )}
                <option value="major">Major</option>
                {!loopBeatMode && <option value="dorian">Dorian</option>}
              </select>
            </label>
            {!loopBeatMode && (
              <label className="full-width">
                Mood
                <select
                  aria-label="Mood"
                  value={draft.mood}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      mood: e.target.value as Settings["mood"],
                    })
                  }
                >
                  <option value="wistful">Wistful / floating</option>
                  <option value="warm">Warm / open</option>
                  <option value="eerie">Eerie / tense</option>
                </select>
              </label>
            )}
            <label className="full-width">
              Seed
              <div className="seed-input">
                <input
                  aria-label="Seed"
                  value={draft.seed}
                  onChange={(e) => setDraft({ ...draft, seed: e.target.value })}
                />
                <button
                  aria-label="Randomize seed"
                  title="Choose a fresh seed"
                  onClick={() =>
                    setDraft({
                      ...draft,
                      seed: `ISH-${crypto.randomUUID().slice(0, 6).toUpperCase()}`,
                    })
                  }
                >
                  ↻
                </button>
              </div>
            </label>
          </div>
          {loopBeatMode && (
            <p className="sample-basis-note">
              User-set bass harmony. Rebuilding keeps this sample and
              arrangement.
            </p>
          )}
          <button
            className="primary generate-button"
            aria-label={
              loopBeatMode
                ? "Rebuild 3 bass & drum versions"
                : "Generate 3 ideas"
            }
            disabled={generating}
            onClick={() => void generate()}
          >
            <Icon name="spark" size={18} />
            {generating
              ? loopBeatMode
                ? "Writing bass & drums…"
                : "Writing three ideas…"
              : loopBeatMode
                ? "Rebuild 3 bass & drum versions"
                : "Generate 3 ideas"}
            <span>↗</span>
          </button>
          <button
            className="new-idea"
            disabled={generating}
            onClick={() => void generate(true)}
          >
            {isLoopBeat(p)
              ? "New bass/drums · keep this loop"
              : "Start with a completely new idea"}{" "}
            <span>↻</span>
          </button>
          {isLoopBeat(p) && (
            <button
              className="new-idea"
              disabled={generating}
              onClick={() => void generate(true, true)}
            >
              Switch to a new original score
            </button>
          )}
          <div className="local-note">
            <Icon name="sliders" size={17} />
            <div>
              <strong>Made here. Kept here.</strong>
              <span>Local composition. Your samples. No AI credits.</span>
            </div>
          </div>
          <button className="about-button" onClick={() => setModal("about")}>
            <Icon name="info" size={14} /> About the sounds & engine{" "}
            <span>↗</span>
          </button>
        </aside>
        <main className="main-panel">
          <section className="idea-section">
            <div className="section-heading">
              <div>
                <div className="eyebrow">
                  {sampleClip ? "SAMPLE MELODY" : "YOUR STARTING POINT"}
                </div>
                <h1>
                  {sampleClip
                    ? "Your sample. Your beat."
                    : "Good ideas need room."}
                </h1>
                <p>
                  {loopBeatMode
                    ? `${p.candidates.length} bass & drum versions · ${arrangementTime} full arrangement · ${arrangementBars} bars`
                    : sampleClip
                      ? "Source audio with an editable arrangement."
                      : "Audition a direction. Lock what hits. Keep moving."}
                </p>
              </div>
              <div className="session-badge">
                <span className="small-dot" /> {profile.name}
                <span>
                  {sampleClip
                    ? `${arrangementTime} ARRANGEMENT`
                    : "8 BAR IDEAS"}
                </span>
              </div>
            </div>
            {sampleClip && (
              <button
                className="selected-sample-banner"
                onClick={openSampleLibrary}
              >
                <Icon name="wave" size={18} />
                <span>
                  <small>
                    SELECTED SOURCE · {sampleClip.provenance.creator}
                  </small>
                  <strong>{sampleClip.provenance.sourceName}</strong>
                </span>
                <span className="sample-edit-label">Edit sample →</span>
              </button>
            )}
            <div className={`candidate-grid ${generating ? "loading" : ""}`}>
              {p.candidates.map((candidate, i) => (
                <button
                  aria-label={`Select candidate ${"ABC"[i]}`}
                  aria-pressed={p.selected === i}
                  className={`candidate-card ${p.selected === i ? "selected" : ""}`}
                  key={candidate.id}
                  onClick={() => commit({ ...p, selected: i })}
                >
                  <div className="candidate-top">
                    <span className="candidate-letter">{"ABC"[i]}</span>
                    <strong>{candidate.name}</strong>
                    <span className="candidate-play">
                      <Icon
                        name={p.selected === i && playing ? "pause" : "play"}
                        size={11}
                      />
                    </span>
                  </div>
                  <MiniScore candidate={candidate} />
                  <div className="candidate-bottom">
                    <span>{candidate.character}</span>
                    {p.selected === i ? (
                      <span className="selected-label">
                        <Icon name="check" size={11} />
                        SELECTED
                      </span>
                    ) : (
                      <span className="candidate-length">
                        {sampleClip ? arrangementTime : "8 BARS"}
                      </span>
                    )}
                  </div>
                </button>
              ))}
            </div>
            <div className="candidate-caption">
              <span>
                <Icon name="headphones" size={13} />
                {isLoopFoundation(p)
                  ? "Supplied loop foundation · source key unverified"
                  : isLoopBeat(p)
                    ? "Sample melody + generated bass/drums · user-set bass key"
                    : p.sourceKind === "supplied-loop"
                      ? "Supplied loop · provisional tonal support"
                      : p.sourceKind === "supplied-midi"
                        ? "Imported supplied composition"
                        : "Original score"}{" "}
                ·{" "}
                {isLoopFoundation(p)
                  ? "User-set grid"
                  : `${KEYS[p.settings.key]} ${p.settings.mode}`}{" "}
                · {c.groove}
              </span>
              <button onClick={() => setModal("metrics")}>
                Score checks <Icon name="info" size={12} />
              </button>
            </div>
          </section>
          <section className="tracks-section">
            <div className="tracks-heading">
              <div className="tabs compact">
                <button className="active">
                  Tracks{" "}
                  <span>
                    {String(
                      visibleTracks.length + (sampleClip ? 1 : 0),
                    ).padStart(2, "0")}
                  </span>
                </button>
              </div>
              <div className="audition-controls">
                <span>Audition</span>
                {["full", "melody", "bass", "drums"].map((k) => (
                  <button key={k} onClick={() => audition(k)}>
                    {k === "full"
                      ? "Full mix"
                      : k === "melody" && sampleClip
                        ? "Sample melody"
                        : k.charAt(0).toUpperCase() + k.slice(1)}
                  </button>
                ))}
              </div>
              <button className="variation-button" onClick={() => regenerate()}>
                <Icon name="spark" size={14} />
                New variation
              </button>
            </div>
            <div className="track-ruler">
              <span>INSTRUMENT / ROLE</span>
              <div>
                {Array.from({ length: 8 }, (_, i) => (
                  <span key={i}>{String(i + 1).padStart(2, "0")}</span>
                ))}
              </div>
              <span>{locked} locked</span>
            </div>
            <div className="track-list">
              {sampleClip && (
                <button
                  className="source-track-row"
                  onClick={openSampleLibrary}
                >
                  <span className="track-icon">
                    <Icon name="wave" size={16} />
                  </span>
                  <span>
                    <strong>Sample melody</strong>
                    <small>{sampleClip.provenance.sourceName}</small>
                  </span>
                  <span className="source-track-action">
                    Audio region · edit →
                  </span>
                </button>
              )}
              {visibleTracks.map((t, i) => (
                <div
                  role="button"
                  tabIndex={0}
                  aria-label={`Edit ${t.name}`}
                  key={t.id}
                  className={`track-row ${selectedTrack === t.id ? "selected" : ""} ${t.mute ? "muted-track" : ""}`}
                  onClick={() => {
                    setSelectedTrack(t.id);
                    if (isDrum(t.id)) setTab("drums");
                    else setTab("piano");
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      setSelectedTrack(t.id);
                      setTab(isDrum(t.id) ? "drums" : "piano");
                    }
                  }}
                >
                  <div className="track-identity">
                    <span className="track-number">
                      {String(i + 1).padStart(2, "0")}
                    </span>
                    <span
                      className="track-icon"
                      style={{ color: colors[t.id] }}
                    >
                      <Icon
                        name={
                          isDrum(t.id)
                            ? "drums"
                            : t.id === "bass"
                              ? "wave"
                              : "notes"
                        }
                        size={16}
                      />
                    </span>
                    <div>
                      <strong>{t.name}</strong>
                      <small>
                        {p.assets.find((a) => a.id === t.instrument)?.name ??
                          instrumentName(t.instrument)}
                      </small>
                    </div>
                  </div>
                  <div className="track-pattern">
                    <svg
                      viewBox="0 0 560 34"
                      preserveAspectRatio="none"
                      aria-hidden="true"
                    >
                      {Array.from({ length: 9 }, (_, i) => (
                        <line
                          key={i}
                          x1={i * 70}
                          x2={i * 70}
                          y1="0"
                          y2="34"
                          stroke="#2a322a"
                          strokeWidth=".7"
                        />
                      ))}
                      {t.notes.map((n) => (
                        <rect
                          key={n.id}
                          x={(n.tick / LOOP_TICKS) * 560}
                          y={
                            isDrum(t.id)
                              ? 10 + (1 - n.velocity) * 12
                              : 4 + ((n.pitch % 24) / 24) * 22
                          }
                          width={Math.max(
                            1.4,
                            (n.duration / LOOP_TICKS) * 560 - 1,
                          )}
                          height={isDrum(t.id) ? 12 : 3}
                          rx="1"
                          fill={colors[t.id]}
                          opacity={0.35 + n.velocity * 0.55}
                        />
                      ))}
                      {playing && (
                        <line
                          x1={((tick % LOOP_TICKS) / LOOP_TICKS) * 560}
                          x2={((tick % LOOP_TICKS) / LOOP_TICKS) * 560}
                          y1="0"
                          y2="34"
                          stroke="#dafab3"
                        />
                      )}
                    </svg>
                  </div>
                  <div className="track-controls">
                    <button
                      aria-label={`Mute ${t.name}`}
                      title="Mute"
                      className={t.mute ? "active" : ""}
                      onClick={(e) => {
                        e.stopPropagation();
                        changeTrack(t.id, { mute: !t.mute });
                      }}
                    >
                      M
                    </button>
                    <button
                      aria-label={`Solo ${t.name}`}
                      title="Solo"
                      className={t.solo ? "active" : ""}
                      onClick={(e) => {
                        e.stopPropagation();
                        changeTrack(t.id, { solo: !t.solo });
                      }}
                    >
                      S
                    </button>
                    <button
                      aria-label={`Lock ${t.name}`}
                      title="Preserve this part when regenerating"
                      className={t.locked ? "locked" : ""}
                      onClick={(e) => {
                        e.stopPropagation();
                        changeTrack(t.id, { locked: !t.locked });
                      }}
                    >
                      <Icon name={t.locked ? "lock" : "unlock"} size={13} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
            <div className="rewrite-actions">
              <button onClick={() => regenerate(DRUM_ROLES)}>
                <Icon name="drums" size={13} />
                Keep melody, rewrite drums
              </button>
              <button
                onClick={() =>
                  isLoopBeat(p)
                    ? setTab("audio")
                    : regenerate([
                        "melody",
                        "pad",
                        "answer",
                        "keys",
                        "bridge",
                        "pedal",
                      ])
                }
              >
                <Icon name="notes" size={13} />
                {isLoopBeat(p)
                  ? "Choose another melody sample"
                  : "Keep drums, rewrite melody"}
              </button>
              <button onClick={() => regenerate(["bass"])}>
                <Icon name="wave" size={13} />
                New 808 phrase
              </button>
            </div>
          </section>
          <section className="editor-section" ref={editorSection}>
            <div className="editor-heading">
              <div className="tabs">
                {[
                  { id: "piano", name: "Piano roll", icon: "notes" },
                  { id: "drums", name: "Drums", icon: "drums" },
                  { id: "arrangement", name: "Arrangement", icon: "timeline" },
                  { id: "reference", name: "Reference", icon: "headphones" },
                  { id: "audio", name: "Audio clips", icon: "wave" },
                  { id: "vocals", name: "Tags & vox", icon: "volume" },
                ].map((t) => (
                  <button
                    className={tab === t.id ? "active" : ""}
                    key={t.id}
                    onClick={() => {
                      setTab(t.id);
                      if (t.id === "piano" && isDrum(selectedTrack))
                        setSelectedTrack("melody");
                    }}
                  >
                    <Icon name={t.icon} size={15} />
                    {t.name}
                  </button>
                ))}
              </div>
              <span className="editor-mode">
                {playing ? "Edits apply next bar" : "Make it yours"}
              </span>
            </div>
            {tab === "piano" && sampleSelection && (
              <div className="sample-editor-placeholder">
                <Icon name="wave" size={24} />
                <h3>Sample melody</h3>
                <p>{sampleClip?.provenance.sourceName}</p>
                <p>
                  Edit its source region in Audio clips, or select the bass or
                  drums to edit their notes.
                </p>
                <button className="secondary" onClick={openSampleLibrary}>
                  Open sample controls →
                </button>
              </div>
            )}
            {tab === "piano" && !sampleSelection && (
              <PianoRoll
                key={selectedTrack}
                track={track}
                onNotes={(value) => notes(selectedTrack, value)}
                tick={tick}
                guide={p.scaleGuides?.[0]}
              />
            )}{" "}
            {tab === "drums" && (
              <DrumEditor
                tracks={c.tracks}
                sampleIds={p.assets.map((asset) => asset.id)}
                onNotes={notes}
                tick={tick % LOOP_TICKS}
              />
            )}{" "}
            {tab === "arrangement" && (
              <Arrangement
                project={p}
                onSections={(sections) => commit({ ...p, sections })}
              />
            )}{" "}
            {tab === "reference" && (
              <Reference
                onStop={() => player.stop()}
                gain={p.settings.referenceGain}
                onGain={(n) => patchSettings({ referenceGain: n })}
                onApply={(bpm, key) => {
                  setDraft({ ...draft, key });
                  patchSettings({ bpm });
                  notify(
                    "Tempo applied. Tonal center is ready in the generator; Generate applies it to a new score.",
                  );
                }}
              />
            )}
            {tab === "audio" && (
              <AudioRegions
                project={p}
                onChange={(next) => {
                  commit(next);
                  if (isLoopBeat(next)) setDraft(next.settings);
                }}
                onLoadLoop={() => void loadLoopCandidate()}
                onResample={() => void reverseSelected()}
                onPreview={() => player.stop()}
                onBuildBeat={(asset, source, region, options) => {
                  if (audioBusy)
                    throw new Error(
                      "Wait for the current audio render before building a beat.",
                    );
                  const next = loopBeat(p, asset, source, region, options);
                  player.stop();
                  commit(
                    next,
                    "Sample-based beat ready: full arrangement, three bass/drum choices, no generated melody overlay. Undo restores the previous session.",
                  );
                  setDraft(next.settings);
                  setCalibrationBpm(null);
                }}
                onUseFoundation={(asset, source, region) => {
                  if (audioBusy)
                    throw new Error(
                      "Wait for the current audio render before opening a foundation.",
                    );
                  const next = loopFoundation(p, asset, source, region);
                  player.stop();
                  commit(
                    next,
                    "Loop foundation opened. Source key unverified; generated notes are empty. Undo restores the previous session.",
                  );
                  setDraft(next.settings);
                  setCalibrationBpm(null);
                }}
                busy={audioBusy}
              />
            )}
            {tab === "vocals" && (
              <VocalEvents
                project={p}
                onChange={(next) => commit(next)}
                onPreview={() => player.stop()}
              />
            )}
          </section>
          <div className="workspace-footer">
            <span>
              {p.sourceKind === "supplied-loop"
                ? "SOURCE CREDITED. YOUR PRODUCTION."
                : "ORIGINAL BY DESIGN. YOURS TO FINISH."}
            </span>
            <span>GENERATOR {VERSION.replace("ish-", "")} · SOUND BANK 02</span>
          </div>
        </main>
        <aside className="right-panel">
          <div className="right-heading">
            <Icon name="sliders" size={16} />
            <span>SHAPE THE SOUND</span>
          </div>
          <div className="right-tabs">
            <button
              className={rightTab === "sound" ? "active" : ""}
              onClick={() => setRightTab("sound")}
            >
              Sound
            </button>
            <button
              className={rightTab === "instrument" ? "active" : ""}
              onClick={() => setRightTab("instrument")}
            >
              Instrument
            </button>
          </div>
          {rightTab === "sound" ? (
            <>
              <div className="macro-heading">
                <div className="orb">
                  <span />
                  <i />
                  <b />
                </div>
                <h3>A little goes a long way.</h3>
                <p>Shape the feel. Keep the idea.</p>
              </div>
              <div className="macro-controls">
                <button
                  className="secondary"
                  onClick={() => {
                    try {
                      commit(
                        mixProject(p),
                        "Suggested balance applied; notes and sources retained. Undo restores the previous mix.",
                      );
                    } catch (error) {
                      setError((error as Error).message);
                    }
                  }}
                >
                  Mix current beat
                </button>
                <MixControls project={p} onChange={(next) => commit(next)} />
                <Range
                  name="Space"
                  value={p.settings.space}
                  onChange={(space) => patchSettings({ space })}
                  description="Upper-instrument reverb and dotted-eighth delay send"
                />
                <Range
                  name="Brightness"
                  value={p.settings.brightness}
                  onChange={(brightness) => patchSettings({ brightness })}
                  description="Melodic filter cutoff and decay brightness"
                />
                <Range
                  name="Grit"
                  value={p.settings.grit}
                  onChange={(grit) => patchSettings({ grit })}
                  description="Gain-compensated bass waveshaping"
                />
                <Range
                  name="Bass Sustain"
                  value={p.settings.sustain}
                  onChange={(sustain) => patchSettings({ sustain })}
                  description="808 amplitude decay; rewrite bass to change note gates"
                />
                <Range
                  name="Drum Density"
                  value={p.settings.density}
                  onChange={(density) => patchSettings({ density })}
                  description={
                    loopBeatMode
                      ? "Optional drum accents and responses, applied on rewrite"
                      : "Groove hit probability, applied on drum rewrite"
                  }
                />
                <Range
                  name="Variation"
                  value={p.settings.variation}
                  onChange={(variation) => patchSettings({ variation })}
                  description={
                    loopBeatMode
                      ? "Phrase-end answers and selected pitched hat rolls, applied on rewrite"
                      : "Ending changes and selected bass glides, applied on rewrite"
                  }
                />
              </div>
              <p className="control-note">
                Density & variation apply when you rewrite a part.
              </p>
              <details className="advanced">
                <summary>
                  Composition controls <span>+</span>
                </summary>
                <Range
                  name="Roll density"
                  value={p.settings.rolls}
                  onChange={(rolls) => patchSettings({ rolls })}
                />
                <Range
                  name="Note density"
                  value={p.settings.noteDensity}
                  onChange={(noteDensity) => patchSettings({ noteDensity })}
                />
                <Range
                  name="Eighth swing"
                  min={50}
                  max={58}
                  step={1}
                  value={Math.round(p.settings.swing * 100)}
                  onChange={(n) => patchSettings({ swing: n / 100 })}
                />
                <label>
                  Contour
                  <select
                    value={p.settings.contour}
                    onChange={(e) =>
                      patchSettings({
                        contour: e.target.value as Settings["contour"],
                      })
                    }
                  >
                    <option value="arch">Arch</option>
                    <option value="falling">Falling</option>
                    <option value="rising">Rising</option>
                  </select>
                </label>
                <label>
                  Rhythm
                  <select
                    value={p.settings.rhythm}
                    onChange={(e) => patchSettings({ rhythm: +e.target.value })}
                  >
                    <option value="0">Original pocket</option>
                    <option value="1">Offset pocket</option>
                    <option value="2">Spaced pocket</option>
                  </select>
                </label>
                <label>
                  Octave
                  <select
                    value={p.settings.octave}
                    onChange={(e) => patchSettings({ octave: +e.target.value })}
                  >
                    <option value="-1">−1</option>
                    <option value="0">0</option>
                    <option value="1">+1</option>
                  </select>
                </label>
                <label>
                  Harmony
                  <select
                    value={p.settings.complexity}
                    onChange={(e) =>
                      patchSettings({ complexity: +e.target.value })
                    }
                  >
                    {[1, 2, 3, 4].map((n) => (
                      <option key={n} value={n}>
                        {n === 1 ? "Single-chord vamp" : `${n}-chord cycle`}
                      </option>
                    ))}
                  </select>
                </label>
                <p className="muted">
                  Rewrites retain current harmony for bass compatibility. New
                  idea applies harmonic complexity.
                </p>
                <button className="secondary" onClick={() => regenerate()}>
                  Apply to unlocked parts
                </button>
              </details>
              <div className="text-control">
                <label htmlFor="direction">A small nudge</label>
                <div>
                  <input
                    id="direction"
                    placeholder="Try “more airy”"
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") parseInstruction();
                    }}
                  />
                  <button
                    aria-label="Apply text direction"
                    onClick={parseInstruction}
                  >
                    ↗
                  </button>
                </div>
                <small>Four supported parameter shortcuts.</small>
              </div>
            </>
          ) : sampleSelection && sampleClip ? (
            <div className="instrument-panel sample-source-summary">
              <span className="eyebrow">SAMPLE MELODY</span>
              <strong>{sampleClip.provenance.sourceName}</strong>
              <small>{sampleClip.provenance.creator}</small>
              <p>Source gain, region and effects are in Audio clips.</p>
              <button className="secondary" onClick={openSampleLibrary}>
                Edit sample →
              </button>
            </div>
          ) : (
            <div className="instrument-panel">
              <span className="eyebrow">SELECTED TRACK</span>
              <h3 style={{ color: colors[selectedTrack] }}>{track.name}</h3>
              <label>
                Instrument
                <select
                  aria-label="Track instrument"
                  value={track.instrument}
                  onChange={(e) =>
                    changeTrack(selectedTrack, { instrument: e.target.value })
                  }
                >
                  {instruments.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                  {p.assets
                    .filter(
                      (a) =>
                        a.role === selectedTrack ||
                        (p.auraOriginal &&
                          ["melody", "pad", "answer", "keys"].includes(
                            selectedTrack,
                          ) &&
                          a.id.startsWith("aura-")),
                    )
                    .map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                      </option>
                    ))}
                </select>
              </label>
              <Range
                name="Track volume"
                value={track.volume}
                onChange={(volume) => changeTrack(selectedTrack, { volume })}
              />
              <Range
                name="Track pan"
                value={track.pan}
                min={-1}
                max={1}
                onChange={(pan) => changeTrack(selectedTrack, { pan })}
              />
              {selectedTrack === "bass" && (
                <small>Bass remains centered in playback and exports.</small>
              )}
              <RoleProcessing
                track={track}
                onChange={(patch) => changeTrack(selectedTrack, patch)}
              />
              <button
                className="secondary"
                onClick={() => sampleInput.current?.click()}
              >
                <Icon name="plus" size={14} />
                Import WAV one-shot
              </button>
              {(selectedTrack === "bass" || isDrum(selectedTrack)) && (
                <DrumKitLibrary
                  project={p}
                  role={selectedTrack}
                  onChange={(next, message) => commit(next, message)}
                  onPreview={() => player.stop()}
                />
              )}
              {(selectedTrack === "bass" || isDrum(selectedTrack)) && (
                <SuppliedKitLibrary
                  project={p}
                  onChange={(next, message) => commit(next, message)}
                  onPreview={() => player.stop()}
                />
              )}
              <div className="midi-import">
                <h4>Import a MIDI phrase</h4>
                <label>
                  Confirmed loop
                  <select
                    aria-label="MIDI loop bars"
                    value={midiBars}
                    onChange={(e) => setMidiBars(+e.target.value)}
                  >
                    {[1, 2, 4, 8].map((b) => (
                      <option key={b} value={b}>
                        {b} bars
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Bass source base MIDI
                  <input
                    aria-label="MIDI source base note"
                    type="number"
                    min="0"
                    max="127"
                    value={midiBase}
                    onChange={(e) => setMidiBase(+e.target.value)}
                  />
                </label>
                <button
                  className="secondary"
                  onClick={() => midiInput.current?.click()}
                >
                  Import MIDI into this part
                </button>
                <small>
                  Preserves timing and velocity. Zero-length percussion triggers
                  a one-shot. Source tempo is reported, not imposed.
                </small>
              </div>
              {sample && (
                <div className="sample-settings">
                  <h4>Sample setup</h4>
                  <small>
                    {sample.sampleRate ?? "Source"} Hz ·{" "}
                    {sample.channels ?? "?"} channels · root confidence{" "}
                    {Math.round((sample.rootConfidence ?? 0) * 100)}%
                    {sample.manualOverride ? " · manual override" : ""}
                  </small>
                  <label>
                    Root MIDI
                    {isDrum(selectedTrack) ? " (pitched instruments)" : ""}
                    <input
                      type="number"
                      min="0"
                      max="127"
                      value={sample.root}
                      disabled={isDrum(selectedTrack)}
                      onChange={(e) =>
                        updateAsset({
                          root: +e.target.value,
                          manualOverride: true,
                        })
                      }
                    />
                  </label>
                  <label>
                    {isDrum(selectedTrack)
                      ? "Drum tuning (cents, linked speed)"
                      : "Tuning (cents)"}
                    <input
                      type="number"
                      min="-100"
                      max="100"
                      value={
                        isDrum(selectedTrack)
                          ? (sample.drumTuning ?? 0)
                          : sample.tuning
                      }
                      onChange={(e) => {
                        const value = Number(e.target.value);
                        if (!Number.isFinite(value)) return;
                        updateAsset(
                          isDrum(selectedTrack)
                            ? {
                                drumTuning: Math.max(
                                  -100,
                                  Math.min(100, value),
                                ),
                              }
                            : { tuning: value },
                        );
                      }}
                    />
                  </label>
                  {isDrum(selectedTrack) && (
                    <small>
                      Drum tuning starts neutral. Hit pitch in the drum editor
                      and this tuning both change playback speed; existing
                      drum-map notes remain unchanged.
                    </small>
                  )}
                  <label>
                    Trim start (s)
                    <input
                      type="number"
                      step=".01"
                      min="0"
                      value={sample.trimStart}
                      onChange={(e) =>
                        updateAsset({ trimStart: +e.target.value })
                      }
                    />
                  </label>
                  <label>
                    Trim end (s)
                    <input
                      type="number"
                      step=".01"
                      min=".01"
                      value={sample.trimEnd}
                      onChange={(e) =>
                        updateAsset({ trimEnd: +e.target.value })
                      }
                    />
                  </label>
                  <label>
                    Envelope
                    <select
                      value={sample.envelopeMode ?? "gated"}
                      onChange={(e) =>
                        updateAsset({
                          envelopeMode: e.target.value as "one-shot" | "gated",
                        })
                      }
                    >
                      <option value="gated">Gated / pitched</option>
                      <option value="one-shot">Full one-shot</option>
                    </select>
                  </label>
                  <Range
                    name="Sample gain"
                    value={sample.gain}
                    onChange={(gain) => updateAsset({ gain })}
                  />
                  <label>
                    Choke group
                    <select
                      value={sample.choke}
                      onChange={(e) => updateAsset({ choke: e.target.value })}
                    >
                      <option value="">None</option>
                      <option value="hats">Hats</option>
                      <option value="bass">Bass</option>
                      <option value="one">Custom 1</option>
                    </select>
                  </label>
                </div>
              )}
              <div className="tag-settings">
                {p.vocalEvents === undefined ? (
                  <>
                    <h4>Your producer tag</h4>
                    <p>Supply your own recording of “ishmakethebeat”.</p>
                    <button
                      className="secondary"
                      onClick={() => tagInput.current?.click()}
                    >
                      Import tag WAV
                    </button>
                    <label>
                      <input
                        type="checkbox"
                        disabled={!p.tagAsset}
                        checked={p.tagEnabled}
                        onChange={(e) =>
                          commit({ ...p, tagEnabled: e.target.checked })
                        }
                      />
                      Enable supplied tag
                    </label>
                  </>
                ) : (
                  <>
                    <h4>Tags & vox</h4>
                    <p>Your tag uses the editable vocal lane.</p>
                    <button
                      className="secondary"
                      onClick={() => setTab("vocals")}
                    >
                      Edit vocal events
                    </button>
                  </>
                )}
              </div>
            </div>
          )}
          <div className="master-controls">
            <div className="eyebrow">MONITOR</div>
            <Range
              name="Listening gain dB"
              min={0}
              max={8}
              step={0.1}
              value={p.settings.listeningGainDb ?? 0}
              onChange={(listeningGainDb) => patchSettings({ listeningGainDb })}
            />
            <Range
              name="Preview gain"
              value={p.settings.previewGain}
              onChange={(previewGain) => patchSettings({ previewGain })}
            />
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={p.settings.masterBypass}
                onChange={(e) =>
                  patchSettings({ masterBypass: e.target.checked })
                }
              />
              Bypass master protection
            </label>
            <div className="stereo-meter">
              <i style={{ width: playing ? "64%" : "2%" }} />
              <i style={{ width: playing ? "57%" : "2%" }} />
            </div>
            <small>Playback activity · conservative output</small>
          </div>
        </aside>
      </div>
      <footer className="transport">
        <div className="transport-left">
          <button
            className="icon-button"
            aria-label="Stop"
            onClick={() => player.stop()}
          >
            <Icon name="stop" size={16} />
          </button>
          <button
            className="play-button"
            aria-label={playing ? "Pause" : "Play"}
            disabled={audioBusy}
            onClick={() => void play()}
          >
            <Icon name={playing ? "pause" : "play"} size={20} />
          </button>
          <button
            className={`icon-button loop-button ${loop ? "active" : ""}`}
            aria-label="Toggle loop"
            aria-pressed={loop}
            onClick={() => setLoop(!loop)}
          >
            <Icon name="loop" size={20} />
          </button>
          <span className="transport-divider" />
          <div className="position">
            <strong>
              {String(Math.floor(tick / BAR) + 1).padStart(2, "0")}
              <i>:</i>
              {(Math.floor(tick / 480) % 4) + 1}
              <i>:</i>
              {String(Math.floor((tick % 480) / 120) + 1).padStart(2, "0")}
            </strong>
            <small>
              BAR <span>BEAT</span> STEP
            </small>
          </div>
        </div>
        <div className="tempo-group">
          <label>
            <input
              aria-label="BPM"
              type="number"
              min="40"
              max="300"
              value={p.settings.bpm}
              disabled={isLoopBeat(p)}
              title={
                isLoopBeat(p)
                  ? "Edit the source grid in Audio; linked pitch/speed changes tempo together."
                  : undefined
              }
              onChange={(e) => {
                const bpm = Math.max(40, Math.min(300, +e.target.value));
                patchSettings({ bpm });
                setDraft({ ...draft, bpm });
              }}
            />
            <span>BPM</span>
          </label>
          <span className="transport-divider" />
          <div>
            <strong>
              {isLoopFoundation(p) ? "Unverified" : KEYS[p.settings.key]}{" "}
              <span>
                {isLoopFoundation(p)
                  ? ""
                  : p.settings.mode === "pentatonic"
                    ? "MIN. PENT."
                    : p.settings.mode.toUpperCase()}
              </span>
            </strong>
            <small>
              {isLoopFoundation(p)
                ? "SOURCE KEY"
                : isLoopBeat(p)
                  ? "BASS BASIS · USER SET"
                  : "PROJECT KEY"}
            </small>
          </div>
        </div>
        <div className="transport-right">
          <div className="playback-scope">
            <button
              className={!p.arrangement ? "active" : ""}
              onClick={() => commit({ ...p, arrangement: false })}
            >
              8-bar loop
            </button>
            <button
              className={p.arrangement ? "active" : ""}
              onClick={() => commit({ ...p, arrangement: true })}
            >
              Arrangement
            </button>
          </div>
          <span className="duration mono">
            {Math.floor(duration / 60)}:
            {String(Math.floor(duration % 60)).padStart(2, "0")}
          </span>
          <span className="keyboard-hint">
            <kbd>space</kbd> to play
          </span>
        </div>
      </footer>
      {message && (
        <div className="toast" role="status">
          <Icon name="check" size={16} />
          {message}
        </div>
      )}
      {error && (
        <div className="error-banner" role="alert">
          <Icon name="info" size={17} />
          <span>{error}</span>
          <button aria-label="Dismiss error" onClick={() => setError("")}>
            ×
          </button>
        </div>
      )}
      <input
        ref={midiInput}
        type="file"
        accept=".mid,.midi"
        hidden
        onChange={async (e) => {
          const file = e.target.files?.[0];
          if (!file) return;
          try {
            const imported = importMidi(
              new Uint8Array(await file.arrayBuffer()),
              {
                role: selectedTrack,
                loopBars: midiBars,
                sourceBase: midiBase,
                targetRoot: c.harmony[0].root,
              },
            );
            if (imported.classification === "scale-guide") {
              const bytes = await file.arrayBuffer(),
                hash = Array.from(
                  new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
                  (b) => b.toString(16).padStart(2, "0"),
                ).join("");
              const next = clone(p);
              next.scaleGuides = [
                ...(next.scaleGuides ?? []),
                {
                  name: file.name,
                  pitches: imported.scalePitches,
                  sourceHash: hash,
                  enabled: false,
                },
              ];
              commit(
                next,
                "Scale guide imported silently. No MIDI notes were added to playback.",
              );
              e.target.value = "";
              return;
            }
            notes(selectedTrack, imported.notes);
            notify(
              `${imported.sourceNoteCount} source notes · ${imported.sourcePPQ} PPQ · ${imported.sourceTempo?.toFixed(1) ?? "no"} BPM metadata · ${midiBars}-bar boundary retained.`,
            );
          } catch (error) {
            setError((error as Error).message);
          }
          e.target.value = "";
        }}
      />
      <input
        ref={loadInput}
        type="file"
        accept=".json,.zip"
        hidden
        onChange={(e) => {
          if (e.target.files?.[0]) void load(e.target.files[0]);
          e.target.value = "";
        }}
      />
      <input
        ref={sampleInput}
        type="file"
        accept=".wav"
        hidden
        onChange={(e) => {
          if (e.target.files?.[0]) void addSample(e.target.files[0]);
          e.target.value = "";
        }}
      />
      <input
        ref={tagInput}
        type="file"
        accept=".wav"
        hidden
        onChange={(e) => {
          if (e.target.files?.[0]) void addSample(e.target.files[0], true);
          e.target.value = "";
        }}
      />
      {modal && (
        <div
          className="modal-backdrop"
          onClick={() => {
            if (!exporting) setModal(null);
          }}
        >
          <div
            className={`modal ${modal === "about" ? "wide" : ""}`}
            role="dialog"
            aria-modal="true"
            aria-label={
              modal === "export"
                ? "Export session"
                : modal === "demos"
                  ? "Demo sessions"
                  : "Engine information"
            }
            onClick={(e) => e.stopPropagation()}
          >
            <button
              className="modal-close icon-button"
              aria-label="Close dialog"
              disabled={exporting}
              onClick={() => setModal(null)}
            >
              <Icon name="close" />
            </button>
            {modal === "export" ? (
              <>
                <div className="eyebrow">TAKE IT WITH YOU</div>
                <h2>From idea to your DAW.</h2>
                <p>Your edited score, rendered on this device.</p>
                <div className="export-options">
                  {[
                    {
                      id: "mix",
                      name: "Full mix",
                      detail: "Stereo WAV · 24-bit PCM · 44.1 kHz",
                    },
                    {
                      id: "stems",
                      name: "Aligned stems",
                      detail:
                        "Aligned roles, audio clips + isolated FX return · ZIP",
                    },
                    {
                      id: "headroom",
                      name: "Mix with headroom",
                      detail: "Stereo 24-bit WAV · before master protection",
                    },
                    {
                      id: "midi",
                      name: "Multitrack MIDI",
                      detail: "Type 1 · named tracks · tempo · 808 bends",
                    },
                    {
                      id: "portable",
                      name: "Portable project",
                      detail: "Score + settings + samples + MIDI · ZIP",
                    },
                    {
                      id: "json",
                      name: "Project JSON",
                      detail: "Editable score + embedded sample data",
                    },
                  ].map((o) => (
                    <button
                      disabled={exporting}
                      className={exportKind === o.id ? "selected" : ""}
                      key={o.id}
                      onClick={() => setExportKind(o.id)}
                    >
                      <span className="export-radio" />
                      <span>
                        <strong>{o.name}</strong>
                        <small>{o.detail}</small>
                      </span>
                      <Icon
                        name={
                          o.id === "midi"
                            ? "notes"
                            : o.id === "mix"
                              ? "wave"
                              : "folder"
                        }
                        size={19}
                      />
                    </button>
                  ))}
                </div>
                <div className="export-scope">
                  <label>
                    <input
                      type="radio"
                      checked={!exportArrangement}
                      onChange={() => setExportArrangement(false)}
                      disabled={exporting}
                    />
                    8-bar loop
                  </label>
                  <label>
                    <input
                      type="radio"
                      checked={exportArrangement}
                      onChange={() => setExportArrangement(true)}
                      disabled={exporting}
                    />
                    Arrangement ({p.sections.reduce((n, s) => n + s.bars, 0)}{" "}
                    bars)
                  </label>
                </div>
                <p className="export-fine">
                  WAVs include a shared effect-tail window. Dry stems are before
                  master processing; shared effects are separate. MIDI bends use
                  ±24 semitones on the 808’s own channel.
                </p>
                {exporting && (
                  <div className="export-progress">
                    <div style={{ width: `${Math.max(3, progress * 100)}%` }} />
                    <span>
                      {progress < 0.25 ? "Preparing events" : "Rendering audio"}{" "}
                      · {Math.round(progress * 100)}%
                    </span>
                  </div>
                )}
                <div className="modal-actions">
                  {exporting ? (
                    <button
                      className="secondary"
                      onClick={() => abort.current?.abort()}
                    >
                      Cancel render
                    </button>
                  ) : (
                    <button
                      className="primary"
                      onClick={() => void runExport()}
                    >
                      <Icon name="export" size={16} />
                      Export{" "}
                      {exportKind === "mix" || exportKind === "headroom"
                        ? "WAV"
                        : exportKind === "stems"
                          ? "stems"
                          : exportKind === "midi"
                            ? "MIDI"
                            : "project"}
                    </button>
                  )}
                </div>
              </>
            ) : modal === "metrics" ? (
              <>
                <div className="eyebrow">TRANSPARENT HEURISTICS</div>
                <h2>A check, not a taste score.</h2>
                <p>
                  Candidate {"ABC"[p.selected]} · checks of symbolic-score
                  structure.
                </p>
                <ul className="metrics-list">
                  {c.metrics.reasons.map((r) => (
                    <li key={r}>
                      <Icon name="check" size={15} />
                      {r}
                    </li>
                  ))}
                </ul>
                <p>
                  These checks flag density, register collisions, repeated motif
                  notes, bass roots, and ending changes. They do not measure
                  artist similarity or prove that a beat sounds good.
                </p>
              </>
            ) : modal === "demos" ? (
              <ListeningRoom
                onStop={() => player.stop()}
                onOpen={(project) => {
                  rememberUserDrums(project.assets);
                  player.stop();
                  commit(project);
                  setDraft(project.settings);
                  setCalibrationBpm(null);
                  setModal(null);
                }}
              />
            ) : (
              <>
                <div className="eyebrow">BUILT FOR ORIGINAL IDEAS</div>
                <h2>ishmakethebeat.</h2>
                <p>
                  A local-first symbolic composer and beat studio. Every note on
                  screen is an event used by playback, offline rendering, and
                  MIDI export.
                </p>
                <div className="about-grid">
                  <div>
                    <h3>The reference directions</h3>
                    <p>
                      The current workflow takes TDF / CULTURE as the primary
                      direction and Pi’erre as secondary inspiration. Original
                      recipe families coordinate motif, chord rhythm, lead
                      treatment, bass envelope, and drum spacing. Earlier
                      profiles remain available for saved-project compatibility.
                    </p>
                    <label>
                      Provisional identity
                      <input
                        value={p.settings.provisionalIdentity}
                        onChange={(e) =>
                          patchSettings({ provisionalIdentity: e.target.value })
                        }
                      />
                    </label>
                  </div>
                  <div>
                    <h3>What is actually in the bank</h3>
                    <p>
                      A compact refined melodic bank plus the legacy synth
                      presets. Selected supplied kit WAVs are used privately
                      when installed, with source IDs, hashes, root estimates,
                      and trim metadata. These are authored design choices, not
                      the producers’ actual kits. The reference album is
                      analyzed locally; its hooks and audio are not sampled into
                      generated music.
                    </p>
                    <h3>What the defaults mean</h3>
                    <p>
                      Tempos and profile settings are engineering defaults, not
                      measurements or song transcriptions. Heuristic checks do
                      not replace listening. Reference analysis is approximate
                      and can be corrected manually.
                    </p>
                  </div>
                </div>
                <p className="muted">
                  480 ticks/quarter · 4/4 · Independent seeded parts · Offline
                  audio · IndexedDB autosave · No paid API
                </p>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
