/** A rate point ramps exponentially from the preceding point when ramp is true. */
export interface RatePoint {
  time: number;
  rate: number;
  ramp?: boolean;
}

function sourceInSegment(from: RatePoint, to: RatePoint, duration: number) {
  if (!to.ramp || Math.abs(to.rate - from.rate) < 1e-12)
    return from.rate * duration;
  const k = Math.log(to.rate / from.rate) / (to.time - from.time);
  return (from.rate * Math.expm1(k * duration)) / k;
}

/** Source seconds actually consumed by native playback-rate automation. */
export function consumedSource(points: RatePoint[], elapsed: number): number {
  let consumed = 0;
  for (let i = 1; i < points.length; i++) {
    const from = points[i - 1],
      to = points[i];
    if (elapsed <= from.time) return consumed;
    consumed += sourceInSegment(
      from,
      to,
      Math.min(elapsed, to.time) - from.time,
    );
    if (elapsed <= to.time) return consumed;
  }
  const last = points[points.length - 1];
  return consumed + Math.max(0, elapsed - last.time) * last.rate;
}

/** Inverse of consumedSource, including the constant rate after the last point. */
export function sourceEndSeconds(
  points: RatePoint[],
  available: number,
): number {
  let remaining = Math.max(0, available);
  for (let i = 1; i < points.length; i++) {
    const from = points[i - 1],
      to = points[i];
    const span = to.time - from.time;
    const used = sourceInSegment(from, to, span);
    if (remaining <= used) {
      if (!to.ramp || Math.abs(to.rate - from.rate) < 1e-12)
        return from.time + remaining / from.rate;
      const k = Math.log(to.rate / from.rate) / span;
      return from.time + Math.log1p((remaining * k) / from.rate) / k;
    }
    remaining -= used;
  }
  const last = points[points.length - 1];
  return last.time + remaining / last.rate;
}

export function rateAt(points: RatePoint[], elapsed: number): number {
  for (let i = 1; i < points.length; i++) {
    const from = points[i - 1],
      to = points[i];
    if (elapsed < to.time)
      return to.ramp
        ? from.rate *
            (to.rate / from.rate) **
              (Math.max(0, elapsed - from.time) / (to.time - from.time))
        : from.rate;
  }
  return points[points.length - 1].rate;
}

/** All times are relative to this note; source exhaustion never accelerates a written glide. */
export function sampleRatePlan(
  rate: number,
  gate: number,
  glide?: { start: number; duration: number; rate: number },
  previousRate?: number,
): RatePoint[] {
  const points: RatePoint[] = [{ time: 0, rate: previousRate ?? rate }];
  const glideStart = glide ? Math.min(gate, Math.max(0, glide.start)) : gate;
  if (previousRate !== undefined && glideStart > 0)
    points.push({ time: Math.min(0.035, gate, glideStart), rate, ramp: true });
  else points[0].rate = rate;
  if (glide && glideStart < gate) {
    if (glideStart > points[points.length - 1].time)
      points.push({ time: glideStart, rate });
    const end = Math.min(gate, glideStart + Math.max(0.001, glide.duration));
    points.push({ time: end, rate: glide.rate, ramp: true });
  }
  return points;
}
