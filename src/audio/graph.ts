import {
  canResumePitchedSample,
  continuedSampleEnvelope,
} from "./sample-continuation";
import {
  requiresSampleAsset,
  assertRequiredSamples,
} from "../engine/required-samples";
import type {
  Project,
  ScoreEvent,
  SampleAsset,
  RoleEffects,
} from "../engine/schema";
import { seconds, isDrum, LOOP_TICKS } from "../engine/schema";
import { rng } from "../engine/random";
import { eventTailSeconds } from "../engine/render-duration";
import { PRESETS, BASS_PRESETS } from "./bank";
import { characterVoice } from "./character";
import { score } from "../engine/score";
import { duckWindows } from "../engine/mix";
import { samplePlaybackRate } from "./sample-playback";
import {
  consumedSource,
  sourceEndSeconds,
  rateAt,
  sampleRatePlan,
  type RatePoint,
} from "./sample-time";
import {
  hatReturn,
  reduceSample,
  stereoDelay,
  vocalFadePoints,
  vocalReverb,
  vocalWarmupSeconds,
  type DelayControl,
} from "./processing";
export type Context = AudioContext | OfflineAudioContext;
export type RenderTap = "mix" | "fx" | string;
export interface VocalScheduleOptions {
  /** Process the source before this time with dry and effect input muted. */
  audibleAt?: number;
  /** Used by history rendering: omit later input, retaining the existing return. */
  sendEnd?: number;
}
const hz = (m: number) => 440 * 2 ** ((m - 69) / 12);
interface BassVoice {
  instrument: string;
  sources: AudioScheduledSourceNode[];
  params: AudioParam[];
  rate: (pitch: number) => number;
  amp: GainNode;
  level: GainNode;
  gateEnd: number;
  naturalEnd: number;
  sustainGain: number;
  pitch: number;
  sampleTime?: { at: number; available: number; points: RatePoint[] };
}
function curve(amount: number) {
  const c = new Float32Array(2048);
  const k = 1 + amount * 14;
  for (let i = 0; i < c.length; i++) {
    const x = (i * 2) / (c.length - 1) - 1;
    c[i] = Math.tanh(x * k) / Math.tanh(k);
  }
  return c;
}
export class AudioGraph {
  readonly master: GainNode;
  readonly output: GainNode;
  private nodes: AudioNode[] = [];
  private sources = new Set<AudioScheduledSourceNode>();
  private buffers = new Map<string, AudioBuffer>();
  private samples = new Map<string, AudioBuffer>();
  private inputs = new Map<string, GainNode>();
  private roleEffects = new Map<string, RoleEffects>();
  private roleDelays = new Map<string, DelayControl>();
  private processed = new Map<string, AudioBuffer>();
  private bassVoice?: BassVoice;
  private bassDuck?: GainNode;
  private duckBases = new Set<string>();
  private vocalVoices = new Map<
    string,
    { end: number; choke: (at: number) => void }
  >();
  private returnBus: GainNode;
  private delay: DelayNode;
  private convolver: ConvolverNode;
  constructor(
    readonly ctx: Context,
    readonly project: Project,
    private readonly tap: RenderTap = "mix",
    live = false,
  ) {
    const keep = <T extends AudioNode>(n: T) => {
      this.nodes.push(n);
      return n;
    };
    this.master = keep(ctx.createGain());
    this.output = keep(ctx.createGain());
    this.master.gain.value = tap === "mix" || tap === "headroom" ? 0.73 : 1;
    this.output.gain.value =
      (live ? project.settings.previewGain : 1) *
      (tap === "mix"
        ? 10 ** ((project.settings.listeningGainDb ?? 0) / 20)
        : 1);
    if (tap === "mix" && !project.settings.masterBypass) {
      const protect = keep(ctx.createDynamicsCompressor());
      protect.threshold.value = -6;
      protect.knee.value = 5;
      protect.ratio.value = 8;
      protect.attack.value = 0.003;
      protect.release.value = 0.12;
      this.master.connect(protect);
      protect.connect(this.output);
    } else this.master.connect(this.output);
    if (tap === "mix" && !project.settings.masterBypass) {
      const guard = keep(ctx.createWaveShaper()),
        c = new Float32Array(4097);
      for (let i = 0; i < c.length; i++) {
        const x = (i * 2) / (c.length - 1) - 1;
        c[i] =
          Math.abs(x) <= 0.86
            ? x
            : Math.sign(x) *
              (0.86 + 0.035 * Math.tanh((Math.abs(x) - 0.86) / 0.035));
      }
      guard.curve = c;
      guard.oversample = "2x";
      this.output.connect(guard);
      guard.connect(ctx.destination);
    } else this.output.connect(ctx.destination);
    this.returnBus = keep(ctx.createGain());
    this.returnBus.gain.value = project.settings.space * 0.42;
    const fxHP = keep(ctx.createBiquadFilter());
    fxHP.type = "highpass";
    fxHP.frequency.value = 650;
    this.returnBus.connect(fxHP);
    this.delay = keep(ctx.createDelay(2));
    this.delay.delayTime.value = (60 / project.settings.bpm) * 0.75;
    const feedback = keep(ctx.createGain());
    feedback.gain.value = 0.23;
    this.delay.connect(feedback);
    feedback.connect(this.delay);
    this.convolver = keep(ctx.createConvolver());
    this.convolver.buffer = this.impulse();
    fxHP.connect(this.delay);
    fxHP.connect(this.convolver);
    const wet = keep(ctx.createGain());
    wet.gain.value = 0.5;
    this.delay.connect(wet);
    this.convolver.connect(wet);
    if (tap === "mix" || tap === "headroom" || tap === "fx")
      wet.connect(this.master);
    const descriptors = [
      ...project.candidates[project.selected].tracks.map((t) => ({
        id: t.id as string,
        key: t.id as string,
        effects: t.effects,
      })),
      { id: "tag", key: "tag", effects: undefined },
      ...(project.clips ?? []).map((clip) => ({
        id: clip.role as string,
        key: `${clip.role}:${clip.id}`,
        effects: clip.effects,
      })),
    ];
    for (const t of descriptors) {
      if (this.inputs.has(t.key)) continue;
      const input = keep(ctx.createGain()),
        bus = keep(ctx.createGain());
      this.inputs.set(t.key, input);
      if (t.id === "bass") {
        input.channelCount = 1;
        input.channelCountMode = "explicit";
        input.channelInterpretation = "speakers";
      }
      if (t.effects) this.roleEffects.set(t.key, t.effects);
      const hp = keep(ctx.createBiquadFilter());
      hp.type = "highpass";
      hp.frequency.value =
        t.id === "bass"
          ? 24
          : isDrum(t.id)
            ? 30
            : t.id === "pad"
              ? 210
              : t.id === "answer"
                ? 220
                : 135;
      input.connect(hp);
      if (t.id === "bass") {
        const shaper = keep(ctx.createWaveShaper()),
          drive =
            t.effects?.saturation ??
            project.settings.grit *
              (project.settings.profile === "culture" ? 0.17 : 0.5);
        shaper.curve = curve(drive);
        shaper.oversample = "2x";
        const comp = keep(ctx.createGain());
        comp.gain.value = 1 / (1 + drive * 2.2);
        hp.connect(shaper);
        shaper.connect(comp);
        if (project.mixPass) {
          this.bassDuck = keep(ctx.createGain());
          this.bassDuck.gain.value = 1;
          comp.connect(this.bassDuck);
          this.bassDuck.connect(bus);
        } else comp.connect(bus);
      } else hp.connect(bus);
      if (tap === "mix" || tap === "headroom" || tap === t.id)
        bus.connect(this.master);
      // All role sends share a dedicated aligned FX tap; dry stems omit these returns.
      const fxOutput = keep(ctx.createGain());
      if (tap === "mix" || tap === "headroom" || tap === "fx")
        fxOutput.connect(this.master);
      if (t.effects?.delay) {
        this.roleDelays.set(
          t.key,
          stereoDelay(
            ctx,
            bus,
            fxOutput,
            project.settings.bpm,
            t.effects.delay,
            keep,
          ),
        );
      }
      if (t.effects?.hat) {
        hatReturn(
          ctx,
          bus,
          fxOutput,
          project.settings.bpm,
          t.effects.hat,
          this.convolver.buffer!,
          keep,
          (s, a, e) => this.start(s, a, e),
        );
      }
      if (!t.effects && !isDrum(t.id) && t.id !== "bass" && t.id !== "tag") {
        const send = keep(ctx.createGain());
        send.gain.value =
          t.id === "melody"
            ? (project.candidates[project.selected].recipe?.leadTreatment
                .delay ?? 0.14) / 0.14
            : 1;
        bus.connect(send);
        send.connect(this.returnBus);
      }
    }
  }
  private impulse() {
    const b = this.ctx.createBuffer(
      2,
      Math.ceil(this.ctx.sampleRate * 1.6),
      this.ctx.sampleRate,
    );
    const r = rng("ish-room-1");
    for (let ch = 0; ch < 2; ch++) {
      const a = b.getChannelData(ch);
      for (let i = 0; i < a.length; i++)
        a[i] = (r() * 2 - 1) * Math.pow(1 - i / a.length, 3.8) * 0.45;
    }
    return b;
  }
  async loadSamples() {
    assertRequiredSamples(this.project, false, true);
    const used = new Set(
      this.project.candidates[this.project.selected].tracks.map(
        (t) => t.instrument,
      ),
    );
    for (const clip of this.project.clips ?? []) used.add(clip.assetId);
    for (const event of this.project.vocalEvents ?? [])
      if (
        event.enabled &&
        (event.role === "tag"
          ? this.project.tagEnabled
          : this.project.voxEnabled !== false)
      )
        used.add(event.assetId);
    if (
      this.project.vocalEvents === undefined &&
      this.project.tagEnabled &&
      this.project.tagAsset
    )
      used.add(this.project.tagAsset);
    await Promise.all(
      this.project.assets
        .filter((a) => used.has(a.id))
        .map(async (a) => {
          if (a.role === "bass" && a.rootConfidence === 0 && !a.manualOverride)
            throw new Error(
              `Set the unmeasured root MIDI note for ${a.name} in Sample setup before pitched playback.`,
            );
          const data = Uint8Array.from(atob(a.data.split(",")[1] ?? ""), (c) =>
            c.charCodeAt(0),
          );
          try {
            this.samples.set(a.id, await this.ctx.decodeAudioData(data.buffer));
          } catch {
            throw new Error(`Cannot decode imported sample: ${a.name}`);
          }
        }),
    );
  }
  private noise(id: string) {
    let b = this.buffers.get(id);
    if (b) return b;
    b = this.ctx.createBuffer(1, this.ctx.sampleRate, this.ctx.sampleRate);
    const a = b.getChannelData(0),
      r = rng(`${this.project.settings.seed}/${id}/noise-1`);
    for (let i = 0; i < a.length; i++) a[i] = r() * 2 - 1;
    this.buffers.set(id, b);
    return b;
  }
  private start(source: AudioScheduledSourceNode, at: number, end: number) {
    this.sources.add(source);
    source.onended = () => {
      this.sources.delete(source);
      source.disconnect();
    };
    source.start(at);
    source.stop(Math.max(at + 0.003, end));
  }
  private envelope(
    g: GainNode,
    at: number,
    duration: number,
    peak: number,
    attack: number,
    decay: number,
    sustain: number,
    release: number,
  ) {
    const held = Math.max(0.012, duration),
      a = Math.min(attack, held * 0.4),
      d = Math.min(decay, Math.max(0.005, held - a));
    g.gain.setValueAtTime(0.00001, at);
    g.gain.exponentialRampToValueAtTime(Math.max(0.00002, peak), at + a);
    g.gain.exponentialRampToValueAtTime(
      Math.max(0.00001, peak * sustain),
      at + a + d,
    );
    g.gain.setValueAtTime(Math.max(0.00001, peak * sustain), at + held);
    g.gain.exponentialRampToValueAtTime(0.00001, at + held + release);
  }
  private wire(e: ScoreEvent) {
    const level = this.ctx.createGain(),
      pan = this.ctx.createStereoPanner();
    level.gain.value = e.gain;
    const width =
      this.project.candidates[this.project.selected].recipe?.leadTreatment
        .width ?? 0;
    pan.pan.value =
      e.role === "bass"
        ? 0
        : Math.max(
            -1,
            Math.min(
              1,
              e.pan +
                (e.role === "melody" ? Math.sin(e.pitch) * width * 0.12 : 0),
            ),
          );
    level.connect(pan);
    pan.connect(this.inputs.get(e.busId ?? e.role)!);
    const end = () => {
      level.disconnect();
      pan.disconnect();
    };
    return { level, end };
  }
  schedule(e: ScoreEvent, at: number, options?: VocalScheduleOptions) {
    if (this.bassDuck && this.project.mixPass) {
      const base = at - seconds(e.tick, this.project.settings.bpm),
        key = base.toFixed(5);
      if (!this.duckBases.has(key)) {
        this.duckBases.add(key);
        for (const w of duckWindows(
          score(this.project),
          this.project.settings.bpm,
          this.project.mixPass.duck,
        )) {
          const start = base + w.start,
            end = base + w.end;
          const now = this.ctx.currentTime,
            low = 10 ** (-w.depthDb / 20),
            peakAt = start + w.attack,
            releaseAt = Math.max(peakAt, end - w.release);
          if (end <= now) continue;
          const from = Math.max(start, now);
          const initial =
            from < peakAt
              ? 1 - ((1 - low) * (from - start)) / w.attack
              : from < releaseAt
                ? low
                : low +
                  ((1 - low) * (from - releaseAt)) /
                    Math.max(0.001, end - releaseAt);
          this.bassDuck.gain.setValueAtTime(initial, from);
          if (peakAt > from)
            this.bassDuck.gain.linearRampToValueAtTime(low, peakAt);
          if (releaseAt > from)
            this.bassDuck.gain.setValueAtTime(low, releaseAt);
          this.bassDuck.gain.linearRampToValueAtTime(1, end);
        }
      }
    }
    const busId = e.busId ?? e.role,
      effects = e.effects ?? this.roleEffects.get(busId),
      delay = this.roleDelays.get(busId);
    if (delay && effects?.delay) {
      const d = effects.delay,
        local = e.effectTick ?? e.tick % LOOP_TICKS,
        points = [...(d.automation ?? [])].sort((a, b) => a.tick - b.tick),
        previous = points.filter((point) => point.tick <= local).at(-1);
      delay.wet.gain.setValueAtTime(
        Math.max(0, Math.min(0.9, previous?.wet ?? d.wet)),
        at,
      );
      for (const point of points.filter((point) => point.tick > local))
        delay.wet.gain.setValueAtTime(
          Math.max(0, Math.min(0.9, point.wet)),
          at + seconds(point.tick - local, this.project.settings.bpm),
        );
    }
    const asset = this.project.assets.find((a) => a.id === e.instrument);
    if (asset) {
      if (e.vocal) this.vocalSample(e, asset, at, options);
      else this.sample(e, asset, at);
      return;
    }
    if (requiresSampleAsset(e.instrument))
      throw new Error("Missing required sample asset: " + e.instrument);
    if (isDrum(e.role)) {
      this.drum(e, at);
      return;
    }
    if (e.role === "bass") {
      this.bass(e, at);
      return;
    }
    this.melodic(e, at);
  }
  private melodic(e: ScoreEvent, at: number) {
    const c = this.ctx,
      s = this.project.settings,
      p =
        this.project.soundBank?.presets.find((p) => p.id === e.instrument) ??
        PRESETS.find((p) => p.id === e.instrument) ??
        PRESETS[0],
      duration = seconds(e.duration, s.bpm),
      { level, end } = this.wire(e);
    if (p.family) {
      characterVoice(
        c,
        p,
        e.pitch,
        e.velocity,
        s.brightness * e.filter,
        at,
        duration,
        level,
        (source, begin, finish) => this.start(source, begin, finish),
        end,
      );
      return;
    }
    const filter = c.createBiquadFilter();
    const treatment =
        e.role === "melody"
          ? this.project.candidates[this.project.selected].recipe?.leadTreatment
          : undefined,
      cutoffRatio = (treatment?.cutoff ?? 5100) / 5100;
    filter.type = "lowpass";
    filter.Q.value = 0.65;
    filter.frequency.setValueAtTime(
      Math.max(250, p.cutoff * cutoffRatio * (0.35 + s.brightness) * e.filter),
      at,
    );
    filter.frequency.exponentialRampToValueAtTime(
      Math.max(
        220,
        p.cutoff * cutoffRatio * (0.13 + s.brightness * 0.4) * e.filter,
      ),
      at + 0.18,
    );
    const amp = c.createGain();
    this.envelope(
      amp,
      at,
      duration,
      p.gain * e.velocity,
      p.attack,
      p.decay,
      p.sustain,
      p.release,
    );
    filter.connect(amp);
    amp.connect(level);
    const f = hz(e.pitch),
      osc = c.createOscillator(),
      second = c.createOscillator(),
      secondGain = c.createGain(),
      mod = c.createOscillator(),
      modGain = c.createGain();
    osc.type = p.wave;
    osc.frequency.value = f;
    osc.detune.value = -p.detune;
    second.type = p.wave;
    second.frequency.value = f;
    second.detune.value = p.detune;
    secondGain.gain.value = 0.32;
    second.connect(secondGain);
    secondGain.connect(filter);
    mod.type = "sine";
    mod.frequency.value = f * p.ratio;
    modGain.gain.setValueAtTime(f * p.fm, at);
    modGain.gain.exponentialRampToValueAtTime(
      Math.max(0.01, f * p.fm * 0.12),
      at + Math.min(0.7, duration + 0.1),
    );
    mod.connect(modGain);
    modGain.connect(osc.frequency);
    osc.connect(filter);
    const finish = at + duration + p.release + 0.02;
    const lfo = c.createOscillator(),
      lfoGain = c.createGain();
    lfo.frequency.value = 5.1;
    lfoGain.gain.value = treatment?.vibrato ?? 0;
    lfo.connect(lfoGain);
    lfoGain.connect(osc.detune);
    lfoGain.connect(second.detune);
    this.start(lfo, at, finish);
    this.start(osc, at, finish);
    this.start(second, at, finish);
    this.start(mod, at, finish);
    osc.onended = () => {
      this.sources.delete(osc);
      [
        osc,
        second,
        secondGain,
        mod,
        modGain,
        filter,
        amp,
        lfo,
        lfoGain,
      ].forEach((n) => n.disconnect());
      end();
    };
  }
  private bass(e: ScoreEvent, at: number) {
    const c = this.ctx,
      s = this.project.settings,
      p = BASS_PRESETS.find((p) => p.id === e.instrument) ?? BASS_PRESETS[1],
      duration = seconds(e.duration, s.bpm),
      peak = (s.profile === "culture" ? 0.25 : 0.43) * e.velocity;
    if (this.legato(e, at, duration, peak * 0.55)) return;
    this.chokeBass(at);
    const { level, end } = this.wire(e),
      amp = c.createGain(),
      lp = c.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 700 + s.grit * 1500;
    lp.Q.value = 0.5;
    this.envelope(
      amp,
      at,
      duration,
      peak,
      p.attack,
      p.decay * (0.5 + s.sustain),
      0.55,
      0.015,
    );
    amp.connect(lp);
    lp.connect(level);
    const osc = c.createOscillator(),
      harm = c.createOscillator(),
      hg = c.createGain();
    osc.type = "sine";
    harm.type = p.id === "pressure-808" ? "sawtooth" : "triangle";
    hg.gain.value = p.harmonic;
    const f = hz(e.pitch);
    osc.frequency.setValueAtTime(f, at);
    harm.frequency.setValueAtTime(f, at);
    if (e.glide) {
      const start = at + seconds(e.glide.at, s.bpm),
        finish = Math.min(at + duration, start + e.glide.ms / 1000);
      for (const o of [osc, harm]) {
        o.frequency.setValueAtTime(f, start);
        o.frequency.exponentialRampToValueAtTime(hz(e.glide.to), finish);
      }
    }
    osc.connect(amp);
    harm.connect(hg);
    hg.connect(amp);
    this.start(osc, at, at + duration + 0.03);
    this.start(harm, at, at + duration + 0.03);
    const voice: BassVoice = {
      instrument: e.instrument,
      sources: [osc, harm],
      params: [osc.frequency, harm.frequency],
      rate: hz,
      amp,
      level,
      gateEnd: at + duration,
      naturalEnd: Infinity,
      sustainGain: peak * 0.55,
      pitch: e.glide?.to ?? e.pitch,
    };
    this.bassVoice = voice;
    osc.onended = () => {
      this.sources.delete(osc);
      if (this.bassVoice === voice) this.bassVoice = undefined;
      [osc, harm, hg, amp, lp].forEach((n) => n.disconnect());
      end();
    };
  }
  private chokeBass(at: number) {
    const voice = this.bassVoice;
    if (!voice) return;
    if (voice.gateEnd >= at - 0.001) {
      voice.amp.gain.cancelScheduledValues(at);
      voice.amp.gain.setValueAtTime(Math.max(0.00001, voice.sustainGain), at);
      voice.amp.gain.linearRampToValueAtTime(0, at + 0.002);
      for (const source of voice.sources) {
        try {
          source.stop(at + 0.002);
        } catch {
          /* ended */
        }
      }
    }
    this.bassVoice = undefined;
  }
  private legato(
    e: ScoreEvent,
    at: number,
    duration: number,
    sustainGain: number,
  ) {
    const voice = this.bassVoice;
    if (
      e.articulation !== "legato" ||
      !voice ||
      voice.instrument !== e.instrument ||
      at > voice.gateEnd + 0.001 ||
      (!voice.sampleTime && at >= voice.naturalEnd - 0.02)
    )
      return false;
    const sample = voice.sampleTime;
    const remaining = sample
      ? sample.available - consumedSource(sample.points, at - sample.at)
      : Infinity;
    const previous = sample
      ? rateAt(sample.points, at - sample.at)
      : voice.rate(voice.pitch);
    if (remaining <= previous * 0.02) return false;
    const points = sampleRatePlan(
      voice.rate(e.pitch),
      duration,
      e.glide
        ? {
            start: seconds(e.glide.at, this.project.settings.bpm),
            duration: e.glide.ms / 1000,
            rate: voice.rate(e.glide.to),
          }
        : undefined,
      previous,
    );
    const natural = sample ? sourceEndSeconds(points, remaining) : Infinity;
    const held = Math.min(duration, natural),
      end = at + Math.max(0.006, held);
    for (const param of voice.params) {
      if (sample) {
        // Keep the already scheduled portion of a ramp when the handoff interrupts it.
        param.cancelAndHoldAtTime(at);
        for (const point of points) {
          if (point.ramp)
            param.exponentialRampToValueAtTime(point.rate, at + point.time);
          else param.setValueAtTime(point.rate, at + point.time);
        }
      } else {
        // Keep the established oscillator articulation; only finite sampled sources need accounting.
        param.cancelScheduledValues(at);
        param.setValueAtTime(voice.rate(voice.pitch), at);
        param.exponentialRampToValueAtTime(
          voice.rate(e.pitch),
          Math.min(end, at + 0.035),
        );
        if (e.glide) {
          const begin = at + seconds(e.glide.at, this.project.settings.bpm);
          if (begin < end) {
            param.setValueAtTime(voice.rate(e.pitch), begin);
            param.exponentialRampToValueAtTime(
              voice.rate(e.glide.to),
              Math.min(end, begin + e.glide.ms / 1000),
            );
          }
        }
      }
    }
    if (sample) {
      voice.sampleTime = { at, available: remaining, points };
      voice.naturalEnd = at + natural;
    }
    voice.amp.gain.cancelScheduledValues(at);
    voice.amp.gain.setValueAtTime(Math.max(0.00001, voice.sustainGain), at);
    voice.amp.gain.linearRampToValueAtTime(
      Math.max(0.00001, sustainGain),
      Math.min(end, at + 0.02),
    );
    voice.amp.gain.setValueAtTime(Math.max(0.00001, sustainGain), end);
    voice.amp.gain.exponentialRampToValueAtTime(0.00001, end + 0.015);
    voice.level.gain.setValueAtTime(e.gain, at);
    for (const source of voice.sources) {
      try {
        source.stop(end + 0.02);
      } catch {
        /* ended */
      }
    }
    voice.gateEnd = end;
    voice.sustainGain = sustainGain;
    voice.pitch = e.glide?.to ?? e.pitch;
    return true;
  }
  private drum(e: ScoreEvent, at: number) {
    const c = this.ctx,
      { level, end } = this.wire(e),
      amp = c.createGain(),
      v = e.velocity,
      duration = seconds(e.duration, this.project.settings.bpm);
    amp.connect(level);
    let life = 0.4;
    const cleanup: AudioNode[] = [amp];
    if (e.role === "kick") {
      const o = c.createOscillator(),
        filter = c.createBiquadFilter();
      o.type = "sine";
      filter.type = "lowpass";
      filter.frequency.value = 2200;
      o.frequency.setValueAtTime(e.instrument === "punch-kick" ? 180 : 135, at);
      o.frequency.exponentialRampToValueAtTime(46, at + 0.055);
      o.connect(filter);
      filter.connect(amp);
      this.envelope(amp, at, 0.11, 0.68 * v, 0.003, 0.065, 0.28, 0.15);
      this.start(o, at, at + 0.28);
      cleanup.push(o, filter);
      life = 0.3;
    } else if (e.role === "perc") {
      const o = c.createOscillator(),
        o2 = c.createOscillator();
      o.type = e.instrument === "wood" ? "sine" : "triangle";
      o.frequency.setValueAtTime(e.instrument === "zap" ? 1600 : 930, at);
      o.frequency.exponentialRampToValueAtTime(
        e.instrument === "zap" ? 230 : 730,
        at + 0.055,
      );
      o2.frequency.value = 1540;
      const small = c.createGain();
      small.gain.value = 0.24;
      o2.connect(small);
      small.connect(amp);
      o.connect(amp);
      this.envelope(amp, at, 0.016, 0.23 * v, 0.002, 0.01, 0.08, 0.055);
      this.start(o, at, at + 0.1);
      this.start(o2, at, at + 0.1);
      cleanup.push(o, o2, small);
      life = 0.12;
    } else {
      const noise = c.createBufferSource(),
        filter = c.createBiquadFilter();
      noise.buffer = this.sampleTreatment(
        this.noise(e.instrument),
        e,
        e.instrument,
      );
      noise.connect(filter);
      filter.connect(amp);
      cleanup.push(noise, filter);
      if (e.role === "clap") {
        filter.type = "bandpass";
        filter.frequency.value = e.instrument === "soft-clap" ? 1500 : 2100;
        filter.Q.value = 0.7;
        const peak = 0.54 * v;
        amp.gain.setValueAtTime(0.00001, at);
        for (let i = 0; i < 3; i++) {
          amp.gain.setValueAtTime(0.00001, at + i * 0.012);
          amp.gain.linearRampToValueAtTime(
            peak * (1 - i * 0.12),
            at + i * 0.012 + 0.001,
          );
          amp.gain.exponentialRampToValueAtTime(0.001, at + i * 0.012 + 0.011);
        }
        amp.gain.setValueAtTime(peak * 0.5, at + 0.037);
        amp.gain.exponentialRampToValueAtTime(0.00001, at + 0.18);
        if (e.instrument.includes("snare")) {
          const tone = c.createOscillator(),
            tg = c.createGain();
          tone.frequency.value = 185;
          tg.gain.setValueAtTime(0.12 * v, at);
          tg.gain.exponentialRampToValueAtTime(0.00001, at + 0.12);
          tone.connect(tg);
          tg.connect(level);
          this.start(tone, at, at + 0.15);
          cleanup.push(tone, tg);
        }
        this.start(noise, at, at + 0.2);
        life = 0.22;
      } else {
        filter.type = "highpass";
        filter.frequency.value = e.instrument === "silk-hat" ? 6800 : 7900;
        filter.Q.value = 0.6;
        const held =
          e.role === "open"
            ? Math.min(0.28, duration)
            : e.instrument === "metal-hat"
              ? 0.045
              : 0.021;
        this.envelope(
          amp,
          at,
          held,
          0.19 * v,
          0.001,
          0.018,
          0.15,
          e.role === "open" ? 0.018 : 0.025,
        );
        this.start(noise, at, at + held + 0.03);
        life = held + 0.04;
        if (e.instrument === "metal-hat") {
          const o = c.createOscillator(),
            og = c.createGain();
          o.type = "square";
          o.frequency.value = 8333;
          og.gain.value = 0.014 * v;
          o.connect(og);
          og.connect(amp);
          this.start(o, at, at + life);
          cleanup.push(o, og);
        }
      }
    }
    // A silent clock source owns cleanup in both real-time and offline contexts.
    const clock = c.createConstantSource(),
      silent = c.createGain();
    silent.gain.value = 0;
    clock.connect(silent);
    silent.connect(level);
    this.start(clock, at, at + life);
    clock.onended = () => {
      this.sources.delete(clock);
      [clock, silent, ...cleanup].forEach((n) => n.disconnect());
      end();
    };
  }
  private sampleTreatment(buffer: AudioBuffer, e: ScoreEvent, id: string) {
    const crush =
      (e.effects ?? this.roleEffects.get(e.busId ?? e.role))?.hat?.crush ?? 0;
    if (!crush || !["hat", "open"].includes(e.role)) return buffer;
    const key = `${id}/reduced/${crush}`;
    let processed = this.processed.get(key);
    if (!processed) {
      processed = reduceSample(this.ctx, buffer, crush);
      this.processed.set(key, processed);
    }
    return processed;
  }
  private vocalSample(
    e: ScoreEvent,
    asset: SampleAsset,
    at: number,
    options?: VocalScheduleOptions,
  ) {
    const original = this.samples.get(asset.id);
    if (!original) throw new Error(`Missing vocal sample: ${asset.name}`);
    const vocal = e.vocal!,
      c = this.ctx,
      rate =
        e.playbackRate ??
        2 ** ((e.pitch - asset.root + asset.tuning / 100) / 12);
    let buffer = original,
      trim = Math.max(0, e.sourceOffset ?? asset.trimStart),
      available = Math.min(
        e.sourceDuration ?? (asset.trimEnd || buffer.duration) - trim,
        buffer.duration - trim,
      );
    if (!Number.isFinite(rate) || rate <= 0 || available <= 0) return;
    if (e.reverse) {
      const first = Math.floor(trim * buffer.sampleRate),
        count = Math.min(
          buffer.length - first,
          Math.round(available * buffer.sampleRate),
        ),
        key = `${asset.id}/vocal-reverse/${first}/${count}`;
      let reversed = this.processed.get(key);
      if (!reversed) {
        reversed = c.createBuffer(
          buffer.numberOfChannels,
          Math.max(1, count),
          buffer.sampleRate,
        );
        for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
          const source = buffer.getChannelData(channel),
            target = reversed.getChannelData(channel);
          for (let i = 0; i < count; i++)
            target[i] = source[first + count - 1 - i];
        }
        this.processed.set(key, reversed);
      }
      buffer = reversed;
      trim = 0;
      available = buffer.duration;
    }
    const held = Math.min(
      seconds(e.duration, this.project.settings.bpm),
      available / rate,
    );
    if (held <= 0) return;
    const group =
      vocal.overlap === "choke-group" ? vocal.chokeGroup : undefined;
    const previous = group ? this.vocalVoices.get(group) : undefined;
    if (previous && previous.end > at + 0.000001) previous.choke(at);
    const owned: AudioNode[] = [],
      own = <T extends AudioNode>(node: T): T => {
        owned.push(node);
        return node;
      },
      source = own(c.createBufferSource()),
      amp = own(c.createGain()),
      pan = own(c.createStereoPanner()),
      inputGate = own(c.createGain()),
      dry = own(c.createGain()),
      fx = own(c.createGain()),
      elapsed = e.envelopeOffsetSeconds ?? 0,
      fullDuration = e.envelopeDurationSeconds ?? held + elapsed,
      peak = asset.gain * e.gain * e.velocity;
    source.buffer = buffer;
    // playbackRate is k-rate: establish its initial value before a start
    // inside a render quantum, rather than briefly playing at the default 1.
    source.playbackRate.value = rate;
    source.playbackRate.setValueAtTime(rate, at);
    source.loop = false;
    const points = vocalFadePoints(
      fullDuration,
      elapsed,
      vocal.fadeIn,
      vocal.fadeOut,
    );
    amp.gain.setValueAtTime((points[0]?.gain ?? 0) * peak, at);
    for (const point of points.slice(1))
      if (point.time <= held)
        amp.gain.linearRampToValueAtTime(point.gain * peak, at + point.time);
    source.connect(amp);
    let output: AudioNode = amp;
    if (vocal.filter) {
      const hp = own(c.createBiquadFilter()),
        lp = own(c.createBiquadFilter());
      hp.type = "highpass";
      hp.frequency.value = Math.max(
        0,
        Math.min(c.sampleRate * 0.49, vocal.filter.highpass),
      );
      lp.type = "lowpass";
      lp.frequency.value = Math.max(
        1,
        Math.min(c.sampleRate * 0.49, vocal.filter.lowpass),
      );
      hp.Q.value = lp.Q.value = Math.SQRT1_2;
      output.connect(hp);
      hp.connect(lp);
      output = lp;
    }
    if (e.effects?.saturation) {
      const amount = Math.max(0, Math.min(1, e.effects.saturation)),
        drive = own(c.createWaveShaper()),
        compensation = own(c.createGain());
      drive.curve = curve(amount);
      drive.oversample = "2x";
      compensation.gain.value = 1 / (1 + amount * 2.2);
      output.connect(drive);
      drive.connect(compensation);
      output = compensation;
    }
    output.connect(pan);
    pan.pan.value = Math.max(-1, Math.min(1, e.pan));
    pan.connect(inputGate);
    inputGate.channelCount = 2;
    inputGate.channelCountMode = "explicit";
    inputGate.gain.setValueAtTime(
      options?.audibleAt && options.audibleAt > at ? 0 : 1,
      at,
    );
    if (options?.audibleAt !== undefined)
      inputGate.gain.setValueAtTime(1, Math.max(at, options.audibleAt));
    if (options?.sendEnd !== undefined)
      inputGate.gain.setValueAtTime(0, Math.max(at, options.sendEnd));
    inputGate.connect(dry);
    if (["mix", "headroom", e.role].includes(this.tap))
      dry.connect(this.master);
    if (["mix", "headroom", "fx"].includes(this.tap)) fx.connect(this.master);
    const d = e.effects?.delay;
    if (d && (d.wet > 0 || d.automation?.some((point) => point.wet > 0))) {
      const control = stereoDelay(
          c,
          inputGate,
          fx,
          this.project.settings.bpm,
          d,
          own,
        ),
        offset = e.effectTick ?? 0,
        automation = [...(d.automation ?? [])].sort((a, b) => a.tick - b.tick),
        previous = automation.filter((point) => point.tick <= offset).at(-1);
      control.wet.gain.setValueAtTime(
        Math.max(0, Math.min(0.9, previous?.wet ?? d.wet)),
        at,
      );
      for (const point of automation.filter((point) => point.tick > offset))
        control.wet.gain.setValueAtTime(
          Math.max(0, Math.min(0.9, point.wet)),
          at + seconds(point.tick - offset, this.project.settings.bpm),
        );
    }
    if (e.effects?.reverb && e.effects.reverb.wet > 0)
      vocalReverb(c, inputGate, fx, e.effects.reverb, own);
    this.sources.add(source);
    source.start(at, trim, available);
    source.stop(at + held);
    // Keep each occurrence's return alive through its declared tail, including
    // after a source choke. Repeat occurrences never share mutable FX settings.
    const finish = at + held + eventTailSeconds(e, this.project.settings.bpm),
      clock = own(c.createConstantSource()),
      silence = own(c.createGain());
    // Audio-thread automation fixes the tail boundary; main-thread onended
    // delivery can occur at different render blocks in offline contexts.
    fx.gain.setValueAtTime(1, Math.max(at, finish - 0.005));
    fx.gain.linearRampToValueAtTime(0, finish);
    silence.gain.value = 0;
    clock.connect(silence);
    silence.connect(this.master);
    this.start(clock, at, finish + 0.005);
    const voice = {
      end: at + held,
      choke: (time: number) => {
        const fadeAt = Math.max(c.currentTime, at, time - vocal.fadeOut),
          tailEnd = time + eventTailSeconds(e, this.project.settings.bpm);
        amp.gain.cancelAndHoldAtTime(fadeAt);
        amp.gain.linearRampToValueAtTime(0, time);
        source.stop(time);
        fx.gain.cancelScheduledValues(time);
        fx.gain.setValueAtTime(1, Math.max(time, tailEnd - 0.005));
        fx.gain.linearRampToValueAtTime(0, tailEnd);
        clock.stop(tailEnd + 0.005);
        voice.end = time;
      },
    };
    if (group) this.vocalVoices.set(group, voice);
    source.onended = () => {
      this.sources.delete(source);
      if (group && this.vocalVoices.get(group) === voice)
        this.vocalVoices.delete(group);
    };
    clock.onended = () => {
      this.sources.delete(clock);
      this.sources.delete(source);
      owned.forEach((node) => node.disconnect());
    };
  }
  private sample(e: ScoreEvent, a: SampleAsset, at: number) {
    const original = this.samples.get(a.id);
    if (!original) throw new Error(`Missing sample: ${a.name}`);
    // A resumed finite melodic sample must not clamp an exhausted source back into sound.
    const continuing =
      canResumePitchedSample(e, a) && (e.envelopeOffsetSeconds ?? 0) > 0;
    if (
      continuing &&
      ((e.sourceOffset ?? a.trimStart) >= original.duration ||
        (e.sourceDuration ?? Infinity) <= 0)
    )
      return;
    let buffer = this.sampleTreatment(original, e, a.id),
      trim = Math.max(
        0,
        Math.min(e.sourceOffset ?? a.trimStart, buffer.duration - 0.001),
      ),
      available = Math.max(
        0.001,
        Math.min(
          e.sourceDuration ?? (a.trimEnd || buffer.duration) - trim,
          buffer.duration - trim,
        ),
      );
    if (e.reverse) {
      const key = `${a.id}/reverse/${trim}/${available}`;
      let reversed = this.processed.get(key);
      if (!reversed) {
        const first = Math.floor(trim * buffer.sampleRate),
          count = Math.min(
            buffer.length - first,
            Math.round(available * buffer.sampleRate),
          );
        reversed = this.ctx.createBuffer(
          buffer.numberOfChannels,
          Math.max(1, count),
          buffer.sampleRate,
        );
        for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
          const from = buffer.getChannelData(ch),
            to = reversed.getChannelData(ch);
          for (let i = 0; i < count; i++) to[i] = from[first + count - 1 - i];
        }
        this.processed.set(key, reversed);
      }
      buffer = reversed;
      trim = 0;
      available = buffer.duration;
    }
    const c = this.ctx,
      rate = samplePlaybackRate(e, a),
      looping = (a.loop ?? false) && e.sourceDuration === undefined,
      gate =
        a.envelopeMode === "one-shot" &&
        e.role !== "loop" &&
        e.role !== "resample"
          ? Infinity
          : seconds(e.duration, this.project.settings.bpm),
      points = sampleRatePlan(
        rate,
        gate,
        e.glide
          ? {
              start: seconds(e.glide.at, this.project.settings.bpm),
              duration: e.glide.ms / 1000,
              rate: 2 ** ((e.glide.to - a.root + a.tuning / 100) / 12),
            }
          : undefined,
      ),
      natural = looping ? Infinity : sourceEndSeconds(points, available),
      choke =
        gate === Infinity && e.chokeAfter !== undefined
          ? seconds(e.chokeAfter, this.project.settings.bpm)
          : Infinity,
      held = Math.min(gate, natural, choke),
      env =
        e.effects?.sampleEnvelope ??
        this.roleEffects.get(e.busId ?? e.role)?.sampleEnvelope ??
        a.envelope,
      // Preserve short hat/clap attacks; clip boundaries receive separate 4 ms fades.
      clip = e.role === "loop" || e.role === "resample",
      attack =
        env?.attack ?? (clip ? 0.004 : e.role === "bass" ? 0.0015 : 0.00045),
      release = Math.min(env?.release ?? (clip ? 0.008 : 0.004), held * 0.25),
      peak = a.gain * e.velocity,
      sustain = env?.sustain ?? (e.role === "bass" ? 0.9 : 1);
    if (
      e.role === "bass" &&
      this.legato(e, at, Math.min(gate, choke), peak * sustain)
    )
      return;
    if (e.role === "bass") this.chokeBass(at);
    const source = c.createBufferSource(),
      amp = c.createGain(),
      { level, end } = this.wire(e);
    source.buffer = buffer;
    source.loop = looping;
    source.loopStart = trim;
    source.loopEnd = trim + available;
    source.playbackRate.value = rate;
    for (const point of points) {
      if (point.ramp)
        source.playbackRate.exponentialRampToValueAtTime(
          point.rate,
          at + point.time,
        );
      else source.playbackRate.setValueAtTime(point.rate, at + point.time);
    }
    let resumeFade: GainNode | undefined;
    if (continuing) {
      const phase = e.envelopeOffsetSeconds!;
      const envelope = continuedSampleEnvelope(
        e.envelopeDurationSeconds ?? held + phase,
        phase,
        peak,
        attack,
        env?.decay ?? 0.008,
        sustain,
        env?.release ?? 0.004,
      );
      amp.gain.setValueAtTime(envelope[0].gain, at);
      for (const point of envelope.slice(1)) {
        if (point.ramp)
          amp.gain.exponentialRampToValueAtTime(point.gain, at + point.time);
        else amp.gain.setValueAtTime(point.gain, at + point.time);
      }
      // Short independent de-click ramp: source and original envelope keep advancing.
      resumeFade = c.createGain();
      resumeFade.gain.setValueAtTime(0, at);
      resumeFade.gain.linearRampToValueAtTime(1, at + Math.min(0.004, held));
      amp.connect(resumeFade);
      resumeFade.connect(level);
    } else {
      this.envelope(
        amp,
        at,
        Math.max(0.001, held - release),
        peak,
        attack,
        env?.decay ?? 0.008,
        sustain,
        release,
      );
      amp.connect(level);
    }
    source.connect(amp);
    this.sources.add(source);
    // Explicit stop owns the gate. Omitting start(duration) allows real legato to extend it.
    source.start(at, trim);
    source.stop(at + held + 0.002);
    let voice: BassVoice | undefined;
    if (e.role === "bass") {
      voice = {
        instrument: e.instrument,
        sources: [source],
        params: [source.playbackRate],
        rate: (pitch) => 2 ** ((pitch - a.root + a.tuning / 100) / 12),
        amp,
        level,
        gateEnd: at + held,
        naturalEnd: at + natural,
        sampleTime: { at, available: looping ? Infinity : available, points },
        sustainGain: peak * sustain,
        pitch: e.glide?.to ?? e.pitch,
      };
      this.bassVoice = voice;
    }
    source.onended = () => {
      this.sources.delete(source);
      if (voice && this.bassVoice === voice) this.bassVoice = undefined;
      source.disconnect();
      amp.disconnect();
      resumeFade?.disconnect();
      end();
    };
  }
  /** Render only the still-audible contribution from vocal input before a seek.
   * Historical input is bounded by the declared -80 dB return horizon plus
   * source-filter warmup. Decoded buffers are reused at this context's rate.
   */
  async prepareVocalHistory(
    events: ScoreEvent[],
    offset: number,
  ): Promise<AudioBuffer | undefined> {
    const bpm = this.project.settings.bpm,
      seek = seconds(offset, bpm),
      rate = this.ctx.sampleRate;
    const previous = events.filter(
      (event) =>
        event.vocal &&
        event.tick < offset &&
        eventTailSeconds(event, bpm) > 0 &&
        seconds(event.tick + event.duration, bpm) +
          eventTailSeconds(event, bpm) >
          seek,
    );
    if (!previous.length) return undefined;
    const tail = Math.max(
        ...previous.map((event) => eventTailSeconds(event, bpm)),
      ),
      warmup = Math.max(...previous.map(vocalWarmupSeconds)),
      startFrame = Math.floor(Math.max(0, seek - tail - warmup) * rate),
      start = startFrame / rate,
      seekFrame = Math.round(seek * rate) - startFrame,
      context = new OfflineAudioContext(
        2,
        Math.max(1, seekFrame + Math.ceil(tail * rate)),
        rate,
      ),
      history = new AudioGraph(context, this.project, "fx");
    history.samples = new Map(this.samples);
    try {
      for (const event of previous) {
        const asset = this.project.assets.find(
          (a) => a.id === event.instrument,
        );
        if (!asset) continue;
        const originalStart = seconds(event.tick, bpm),
          begin = Math.max(start, originalStart),
          end = Math.min(seek, seconds(event.tick + event.duration, bpm)),
          elapsed = begin - originalStart,
          playbackRate =
            event.playbackRate ??
            2 ** ((event.pitch - asset.root + asset.tuning / 100) / 12),
          sourceOffset = event.sourceOffset ?? asset.trimStart,
          sourceDuration =
            event.sourceDuration ??
            (asset.trimEnd || asset.duration || 0) - sourceOffset,
          consumed = elapsed * playbackRate;
        if (end <= begin || consumed >= sourceDuration) continue;
        const cropped: ScoreEvent = {
          ...event,
          tick: (begin - start) * bpm * 8,
          duration: (end - begin) * bpm * 8,
          sourceOffset: sourceOffset + (event.reverse ? 0 : consumed),
          sourceDuration: sourceDuration - consumed,
          envelopeOffsetSeconds: (event.envelopeOffsetSeconds ?? 0) + elapsed,
          envelopeDurationSeconds:
            event.envelopeDurationSeconds ?? seconds(event.duration, bpm),
          effectTick: (event.effectTick ?? 0) + elapsed * bpm * 8,
        };
        // Gate after source filtering/saturation so the split remains linear
        // at the input of the parallel delay/reverb network.
        history.schedule(cropped, begin - start, { sendEnd: seek - start });
      }
      const rendered = await context.startRendering(),
        buffer = this.ctx.createBuffer(2, rendered.length - seekFrame, rate);
      for (let channel = 0; channel < 2; channel++)
        buffer.copyToChannel(
          rendered.getChannelData(channel).subarray(seekFrame),
          channel,
        );
      return buffer;
    } finally {
      history.dispose();
    }
  }
  playVocalHistory(buffer: AudioBuffer | undefined, at: number) {
    if (!buffer || !["mix", "headroom", "fx"].includes(this.tap)) return;
    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.master);
    this.start(source, at, at + buffer.duration);
  }
  stopAt(time = this.ctx.currentTime) {
    this.output.gain.cancelScheduledValues(time);
    this.output.gain.setTargetAtTime(0, time, 0.004);
    for (const s of this.sources) {
      try {
        s.stop(time + 0.025);
      } catch {
        /* already ended */
      }
    }
  }
  stop() {
    this.stopAt();
  }
  dispose() {
    this.stop();
    this.nodes.forEach((n) => n.disconnect());
    this.sources.clear();
    this.inputs.clear();
    this.buffers.clear();
    this.samples.clear();
    this.processed.clear();
    this.roleEffects.clear();
    this.roleDelays.clear();
    this.vocalVoices.clear();
    this.bassVoice = undefined;
  }
  get activeVoices() {
    return this.sources.size;
  }
}
