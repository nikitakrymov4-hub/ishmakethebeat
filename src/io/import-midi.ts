import { parseMidi } from "midi-file";
import type { Note, Role } from "../engine/schema";
import { BAR, LOOP_TICKS, PPQ, isDrum } from "../engine/schema";
export function importMidi(
  bytes: Uint8Array,
  options: {
    role: Role;
    loopBars: number;
    sourceBase: number;
    targetRoot: number;
  },
) {
  const midi = parseMidi(bytes);
  if (!midi.header.ticksPerBeat)
    throw new Error("SMPTE-time MIDI is not supported.");
  const factor = PPQ / midi.header.ticksPerBeat,
    loop = options.loopBars * BAR,
    notes: Note[] = [],
    names: string[] = [];
  let tempo: number | undefined;
  if (![1, 2, 4, 8].includes(options.loopBars))
    throw new Error("Confirm a 1, 2, 4, or 8-bar loop boundary.");
  for (const track of midi.tracks) {
    let tick = 0;
    const pending = new Map<
      string,
      { tick: number; pitch: number; velocity: number }[]
    >();
    for (const e of track) {
      tick += e.deltaTime;
      if (e.type === "setTempo") tempo = 60000000 / e.microsecondsPerBeat;
      if (e.type === "trackName") names.push(e.text);
      if (e.type === "noteOn" && e.velocity > 0) {
        const key = `${e.channel}:${e.noteNumber}`,
          queue = pending.get(key) ?? [];
        queue.push({
          tick: Math.round(tick * factor),
          pitch: e.noteNumber,
          velocity: e.velocity / 127,
        });
        pending.set(key, queue);
      }
      if (e.type === "noteOff" || (e.type === "noteOn" && e.velocity === 0)) {
        const key = `${e.channel}:${e.noteNumber}`,
          on = pending.get(key)?.shift();
        if (!on) continue;
        const rawDuration = Math.round(tick * factor) - on.tick,
          duration =
            rawDuration > 0 ? rawDuration : isDrum(options.role) ? 30 : 60,
          pitch = isDrum(options.role)
            ? (
                { kick: 36, clap: 39, hat: 42, open: 46, perc: 37 } as Record<
                  string,
                  number
                >
              )[options.role]
            : options.role === "bass"
              ? on.pitch - options.sourceBase + options.targetRoot
              : on.pitch;
        if (on.tick < loop)
          notes.push({
            id: `midi-${notes.length}`,
            tick: on.tick,
            duration: Math.min(duration, loop - on.tick),
            pitch: Math.max(0, Math.min(127, pitch)),
            velocity: on.velocity,
          });
      }
    }
  }
  const repeated: Note[] = [];
  const isGuide =
    notes.length >= 24 &&
    notes.every((n) => n.tick <= 1 && n.duration >= loop * 0.95);
  for (let offset = 0; offset < LOOP_TICKS; offset += loop)
    for (const n of notes)
      repeated.push({
        ...n,
        id: `${n.id}-${offset}`,
        tick: n.tick + offset,
        duration: Math.min(n.duration, LOOP_TICKS - n.tick - offset),
      });
  return {
    notes: isGuide ? [] : repeated.sort((a, b) => a.tick - b.tick),
    classification: isGuide ? ("scale-guide" as const) : ("phrase" as const),
    scalePitches: isGuide
      ? [...new Set(notes.map((n) => n.pitch))].sort((a, b) => a - b)
      : [],
    sourcePPQ: midi.header.ticksPerBeat,
    sourceTempo: tempo,
    names,
    loopTicks: loop,
    sourceNoteCount: notes.length,
  };
}
