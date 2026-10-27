import { samplePlaybackRate } from "./sample-playback";
import { canResumePitchedSample } from "./sample-continuation";
import { BAR, LOOP_TICKS, seconds } from "../engine/schema";
import type { Project, ScoreEvent } from "../engine/schema";
import { score, totalTicks } from "../engine/score";
import { AudioGraph } from "./graph";
import { renderDurationSeconds } from "../engine/render-duration";
import { vocalWarmupSeconds } from "./processing";

/** Re-enter a selected audio region at the correct source position after a seek
 * or graph swap. Playback-rate transposition consumes source time at that rate.
 */
export function resumeSpanningClips(
  events: ScoreEvent[],
  offset: number,
  project: Pick<Project, "settings" | "assets">,
): ScoreEvent[] {
  const resumed: ScoreEvent[] = [];
  for (const event of events) {
    const asset = project.assets.find((a) => a.id === event.instrument);
    const pitched = canResumePitchedSample(event, asset);
    if (
      (!event.vocal &&
        !pitched &&
        !["loop", "resample"].includes(event.role)) ||
      event.tick >= offset ||
      event.tick + event.duration <= offset
    )
      continue;
    if (!asset) continue;
    const elapsed = offset - event.tick,
      rate = pitched
        ? samplePlaybackRate(event, asset)
        : (event.playbackRate ??
          2 ** ((event.pitch - asset.root + asset.tuning / 100) / 12)),
      sourceStart = event.sourceOffset ?? asset.trimStart,
      region =
        event.sourceDuration ??
        (asset.trimEnd || asset.duration || 0) - sourceStart,
      consumed = seconds(elapsed, project.settings.bpm) * rate;
    if (region - consumed <= 0.0001) continue;
    resumed.push({
      ...event,
      id: `${event.id}-resume-${offset}`,
      tick: offset,
      duration: event.tick + event.duration - offset,
      sourceOffset: sourceStart + (event.reverse ? 0 : consumed),
      sourceDuration: region - consumed,
      effectTick:
        (event.effectTick ?? (event.vocal ? 0 : event.tick % LOOP_TICKS)) +
        elapsed,
      ...(event.vocal || pitched
        ? {
            envelopeOffsetSeconds:
              (event.envelopeOffsetSeconds ?? 0) +
              seconds(elapsed, project.settings.bpm),
            envelopeDurationSeconds:
              event.envelopeDurationSeconds ??
              (pitched
                ? Math.min(
                    seconds(event.duration, project.settings.bpm),
                    region / rate,
                  )
                : seconds(event.duration, project.settings.bpm)) +
                (event.envelopeOffsetSeconds ?? 0),
          }
        : {}),
    });
  }
  return resumed;
}
export class Transport {
  private ctx?: AudioContext;
  private graph?: AudioGraph;
  private timer?: ReturnType<typeof setInterval>;
  private events: ScoreEvent[] = [];
  private index = 0;
  private cycle = 0;
  private origin = 0;
  private duration = 0;
  private renderDuration = 0;
  private bpm = 148;
  private token = 0;
  private pending?: {
    p: Project;
    graph: AudioGraph;
    at: number;
    tick: number;
    resumed: number;
  };
  private prepareToken = 0;
  private startOffset = 0;
  private resumedClipCount = 0;
  private boundarySwaps = 0;
  playing = false;
  loop = true;
  position = 0;
  onUpdate: (tick: number, playing: boolean) => void = () => {};
  async play(p: Project, offset = this.position) {
    if (this.playing) return;
    const token = ++this.token;
    this.ctx ??= new AudioContext({ latencyHint: "interactive" });
    await this.ctx.resume();
    if (token !== this.token) return;
    this.graph?.dispose();
    const graph = new AudioGraph(this.ctx, p, "mix", true);
    this.graph = graph;
    await graph.loadSamples();
    if (token !== this.token) {
      graph.dispose();
      return;
    }
    this.events = score(p);
    this.bpm = p.settings.bpm;
    this.duration = seconds(totalTicks(p), this.bpm);
    this.renderDuration = renderDurationSeconds(p);
    const startTick = offset >= totalTicks(p) ? 0 : Math.max(0, offset);
    const history = await graph.prepareVocalHistory(this.events, startTick);
    if (token !== this.token) {
      graph.dispose();
      return;
    }
    this.startOffset = seconds(startTick, this.bpm);
    this.origin =
      this.ctx.currentTime +
      0.07 +
      this.warmup(this.events, startTick, p) -
      this.startOffset;
    this.index = this.events.findIndex(
      (e) => seconds(e.tick, this.bpm) >= this.startOffset,
    );
    if (this.index < 0) this.index = this.events.length;
    this.cycle = 0;
    this.resumedClipCount = 0;
    this.boundarySwaps = 0;
    const at = this.origin + this.startOffset;
    graph.playVocalHistory(history, at);
    this.resumedClipCount = this.resumeClips(p, startTick, at);
    this.playing = true;
    this.tick();
    this.timer = setInterval(() => this.tick(), 25);
  }
  private warmup(events: ScoreEvent[], offset: number, p: Project) {
    return Math.max(
      0,
      ...events
        .filter(
          (e) => e.vocal && e.tick < offset && e.tick + e.duration > offset,
        )
        .map((e) =>
          Math.min(
            vocalWarmupSeconds(e),
            seconds(offset - e.tick, p.settings.bpm),
          ),
        ),
    );
  }
  private resumeClips(
    p: Project,
    offset: number,
    at: number,
    graph = this.graph!,
    events = this.events,
  ) {
    let count = 0;
    for (const original of events) {
      const event = resumeSpanningClips([original], offset, p)[0];
      if (!event) continue;
      if (event.vocal) {
        const from = Math.max(
            original.tick,
            offset - vocalWarmupSeconds(event) * p.settings.bpm * 8,
          ),
          warmed =
            from <= original.tick
              ? original
              : resumeSpanningClips([original], from, p)[0];
        if (warmed)
          graph.schedule(warmed, at - seconds(offset - from, p.settings.bpm), {
            audibleAt: at,
          });
      } else graph.schedule(event, at);
      count++;
    }
    return count;
  }
  private tick() {
    if (!this.playing || !this.ctx || !this.graph) return;
    const now = this.ctx.currentTime,
      horizon = now + 0.14;
    if (this.pending && horizon >= this.pending.at) {
      const next = this.pending,
        old = this.graph;
      this.pending = undefined;
      old.stopAt(next.at);
      setTimeout(() => old.dispose(), Math.max(0, (next.at - now) * 1000) + 60);
      this.graph = next.graph;
      this.events = score(next.p);
      this.bpm = next.p.settings.bpm;
      this.duration = seconds(totalTicks(next.p), this.bpm);
      this.renderDuration = renderDurationSeconds(next.p);
      const offset = this.loop ? next.tick % totalTicks(next.p) : next.tick;
      this.origin = next.at - seconds(offset, this.bpm);
      this.cycle = 0;
      this.index = this.events.findIndex((e) => e.tick >= offset);
      if (this.index < 0) this.index = this.events.length;
      this.resumedClipCount += next.resumed;
      this.boundarySwaps++;
    }
    while (
      this.index < this.events.length &&
      this.origin +
        this.cycle * this.duration +
        seconds(this.events[this.index].tick, this.bpm) <
        horizon
    ) {
      const e = this.events[this.index++],
        at =
          this.origin + this.cycle * this.duration + seconds(e.tick, this.bpm);
      if (at >= now - 0.015) this.graph.schedule(e, Math.max(now + 0.001, at));
    }
    const elapsed = Math.max(0, now - this.origin);
    if (
      elapsed > this.duration * (this.cycle + 1) - 0.14 &&
      this.index === this.events.length &&
      this.loop
    ) {
      this.cycle++;
      this.index = 0;
    }
    this.position =
      (((this.loop
        ? elapsed % this.duration
        : Math.min(elapsed, this.duration)) *
        this.bpm) /
        60) *
      480;
    this.onUpdate(this.position, true);
    if (!this.loop && elapsed >= this.renderDuration) this.stop(false);
  }
  updateAtBoundary(p: Project) {
    if (!this.playing || !this.ctx) return;
    const token = ++this.prepareToken,
      graph = new AudioGraph(this.ctx, p, "mix", true);
    void graph
      .loadSamples()
      .then(async () => {
        if (token !== this.prepareToken || !this.playing || !this.ctx) {
          graph.dispose();
          return;
        }
        this.pending?.graph.dispose();
        this.pending = undefined;
        const events = score(p),
          maximumWarmup = Math.max(
            0,
            ...events.filter((e) => e.vocal).map(vocalWarmupSeconds),
          );
        let lead = events.some((e) => e.vocal) ? 0.25 + maximumWarmup : 0.04;
        for (let attempt = 0; attempt < 5; attempt++) {
          const elapsed = this.ctx.currentTime - this.origin,
            absoluteTick = (((elapsed + lead) * this.bpm) / 60) * 480,
            boundary = Math.ceil(absoluteTick / BAR) * BAR,
            immediate = !this.loop && boundary >= totalTicks(p),
            at = immediate
              ? this.ctx.currentTime + lead
              : this.origin + seconds(boundary, this.bpm),
            tick = immediate
              ? (((at - this.origin) * this.bpm) / 60) * 480
              : boundary,
            offset = this.loop ? tick % totalTicks(p) : tick,
            history = await graph.prepareVocalHistory(events, offset);
          if (token !== this.prepareToken || !this.playing || !this.ctx) {
            graph.dispose();
            return;
          }
          if (
            at - this.warmup(events, offset, p) <=
            this.ctx.currentTime + 0.01
          ) {
            lead *= 2;
            continue;
          }
          graph.playVocalHistory(history, at);
          const resumed = this.resumeClips(p, offset, at, graph, events);
          // Absolute tail position is retained for non-looping playback;
          // modulo would restart an already completed arrangement.
          this.pending = { p, graph, at, tick, resumed };
          return;
        }
        throw new Error(
          "Vocal history preparation could not meet the playback boundary.",
        );
      })
      .catch(() => graph.dispose());
  }
  pause() {
    const at = this.position;
    this.stop(false);
    this.position = at;
    this.onUpdate(at, false);
  }
  stop(reset = true) {
    ++this.token;
    ++this.prepareToken;
    clearInterval(this.timer);
    this.timer = undefined;
    this.graph?.stop();
    this.playing = false;
    this.pending?.graph.dispose();
    this.pending = undefined;
    if (reset) this.position = 0;
    this.onUpdate(this.position, false);
  }
  dispose() {
    this.stop();
    this.graph?.dispose();
    void this.ctx?.close();
  }
  get diagnostics() {
    return {
      playing: this.playing,
      activeVoices: this.graph?.activeVoices ?? 0,
      scheduledIndex: this.index,
      resumedClips: this.resumedClipCount,
      boundarySwaps: this.boundarySwaps,
    };
  }
}
