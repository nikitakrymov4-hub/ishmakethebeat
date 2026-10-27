import { writeMidi } from "midi-file";
import type { MidiEvent } from "midi-file";
import { score, totalTicks } from "../engine/score";
import { PPQ, isDrum } from "../engine/schema";
import type { Project } from "../engine/schema";
type Timed = { tick: number; order: number; event: MidiEvent };
function timedTrack(events: Timed[], end: number): MidiEvent[] {
  let last = 0;
  const result = events
    .sort((a, b) => a.tick - b.tick || a.order - b.order)
    .map((e) => {
      const out = { ...e.event, deltaTime: e.tick - last };
      last = e.tick;
      return out;
    });
  result.push({ type: "endOfTrack", deltaTime: Math.max(0, end - last) });
  return result;
}
export function exportMidi(p: Project): Uint8Array {
  const events = score(p),
    end = totalTicks(p),
    tracks: MidiEvent[][] = [];
  tracks.push([
    { deltaTime: 0, type: "trackName", text: `ishmakethebeat · ${p.title}` },
    {
      deltaTime: 0,
      type: "setTempo",
      microsecondsPerBeat: Math.round(60000000 / p.settings.bpm),
    },
    {
      deltaTime: 0,
      type: "timeSignature",
      numerator: 4,
      denominator: 4,
      metronome: 24,
      thirtyseconds: 8,
    },
    { deltaTime: end, type: "endOfTrack" },
  ]);
  for (const [i, t] of p.candidates[p.selected].tracks.entries()) {
    const role = t.id,
      channel = isDrum(role)
        ? 9
        : ({ keys: 4, bridge: 5, pedal: 6 }[role as "keys"] ?? i),
      te: Timed[] = [];
    const add = (tick: number, order: number, event: MidiEvent) =>
      te.push({ tick, order, event });
    add(0, -10, {
      deltaTime: 0,
      type: "trackName",
      text: `${t.name} · ${t.instrument}`,
    });
    add(0, -9, {
      deltaTime: 0,
      type: "controller",
      channel,
      controllerType: 7,
      value: Math.round(t.volume * 127),
    });
    add(0, -8, {
      deltaTime: 0,
      type: "controller",
      channel,
      controllerType: 10,
      value: Math.round((role === "bass" ? 0 : t.pan) * 63 + 64),
    });
    if (role === "bass") {
      // RPN 0,0 = pitch bend sensitivity. Dedicated channel 4 (zero-based 3), ±24 semitones.
      [
        [101, 0],
        [100, 0],
        [6, 24],
        [38, 0],
        [101, 127],
        [100, 127],
      ].forEach(([controllerType, value], j) =>
        add(0, -7 + j * 0.1, {
          deltaTime: 0,
          type: "controller",
          channel,
          controllerType,
          value,
        }),
      );
      add(0, -5, { deltaTime: 0, type: "pitchBend", channel, value: 0 });
    }
    for (const n of events.filter((e) => e.role === role)) {
      const sample = isDrum(role) ? p.assets.find((a) => a.id === n.instrument) : undefined;
      if (sample && ((n.drumPitch ?? 0) !== 0 || (sample.drumTuning ?? 0) !== 0))
        add(n.tick, -1, {
          deltaTime: 0,
          type: "text",
          text: `ishmakethebeat sample pitch ${JSON.stringify({
            role, note: n.pitch, semitones: n.drumPitch ?? 0,
            tuningCents: sample.drumTuning ?? 0,
            playback: "linked pitch/speed; preserved by project/WAV, not General MIDI drum notes",
          })}`,
        });
      add(n.tick, 0, {
        deltaTime: 0,
        type: "noteOn",
        channel,
        noteNumber: n.pitch,
        velocity: Math.round(n.velocity * 127),
      });
      add(n.tick + n.duration, -3, {
        deltaTime: 0,
        type: "noteOff",
        channel,
        noteNumber: n.pitch,
        velocity: 0,
      });
      if (n.glide && role === "bass") {
        const start = n.tick + n.glide.at,
          length = Math.min(
            n.duration - n.glide.at,
            Math.round((((n.glide.ms / 1000) * p.settings.bpm) / 60) * PPQ),
          );
        // Exponential frequency ramp is linear in semitones. 16 control points per glide.
        for (let j = 0; j <= 16; j++) {
          const bendTick = start + Math.round((length * j) / 16);
          // A section can shorten a glide to the note's exact endpoint. Its
          // final control point must run before note-off and bend reset, or
          // the following note inherits the previous slide's detuning.
          add(bendTick, bendTick === n.tick + n.duration ? -4 : 1, {
            deltaTime: 0,
            type: "pitchBend",
            channel,
            value: Math.max(
              -8192,
              Math.min(
                8191,
                Math.round((((n.glide.to - n.pitch) / 24) * 8192 * j) / 16),
              ),
            ),
          });
        }
        add(n.tick + n.duration, -2, {
          deltaTime: 0,
          type: "pitchBend",
          channel,
          value: 0,
        });
      }
    }
    tracks.push(timedTrack(te, end));
  }
  return Uint8Array.from(
    writeMidi({
      header: { format: 1, numTracks: tracks.length, ticksPerBeat: PPQ },
      tracks,
    }),
  );
}
