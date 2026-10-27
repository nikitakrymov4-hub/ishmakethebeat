import type { SampleAsset, ScoreEvent } from "../engine/schema";
/** Only finite, forward, gated pitched samples; legacy loop/vocal/bass paths stay separate. */
export function canResumePitchedSample(
  e: ScoreEvent,
  a?: SampleAsset,
): boolean {
  return (
    !!a &&
    ["melody", "pad", "answer", "keys", "bridge", "pedal"].includes(e.role) &&
    !e.vocal &&
    !e.reverse &&
    !e.glide &&
    !a.loop &&
    a.envelopeMode !== "one-shot"
  );
}
export interface EnvelopePoint {
  time: number;
  gain: number;
  ramp?: boolean;
}
/** The existing sample ADSR, sliced at elapsed time rather than retriggered. */
export function continuedSampleEnvelope(
  fullHeld: number,
  elapsed: number,
  peak: number,
  attack: number,
  decay: number,
  sustain: number,
  release: number,
): EnvelopePoint[] {
  const r = Math.min(release, fullHeld * 0.25),
    held = Math.max(0.012, Math.max(0.001, fullHeld - r)),
    a = Math.min(attack, held * 0.4),
    d = Math.min(decay, Math.max(0.005, held - a));
  const points: EnvelopePoint[] = [
    { time: 0, gain: 0.00001 },
    { time: a, gain: Math.max(0.00002, peak), ramp: true },
    { time: a + d, gain: Math.max(0.00001, peak * sustain), ramp: true },
    { time: held, gain: Math.max(0.00001, peak * sustain) },
    { time: held + r, gain: 0.00001, ramp: true },
  ];
  // Preserve AudioParam's chronological scheduling semantics for very short gates.
  points.sort((x, y) => x.time - y.time);
  let value = points[0].gain;
  for (let i = 1; i < points.length; i++) {
    const previous = points[i - 1],
      next = points[i];
    if (elapsed < next.time) {
      value =
        next.ramp && next.time > previous.time
          ? previous.gain *
            (next.gain / previous.gain) **
              ((elapsed - previous.time) / (next.time - previous.time))
          : previous.gain;
      break;
    }
    value = next.gain;
  }
  return [
    { time: 0, gain: value },
    ...points
      .filter((p) => p.time > elapsed)
      .map((p) => ({ ...p, time: p.time - elapsed })),
  ];
}
