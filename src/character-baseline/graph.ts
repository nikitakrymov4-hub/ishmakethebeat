import type { Project, ScoreEvent, SampleAsset } from "../engine/schema";
import { seconds, isDrum } from "../engine/schema";
import { rng } from "../engine/random";
import { PRESETS, BASS_PRESETS } from "./bank";
export type Context = AudioContext | OfflineAudioContext;
export type RenderTap = "mix" | "fx" | string;
const hz = (m: number) => 440 * 2 ** ((m - 69) / 12);
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
  private returnBus: GainNode;
  private delay: DelayNode;
  private convolver: ConvolverNode;
  constructor(
    readonly ctx: Context,
    readonly project: Project,
    tap: RenderTap = "mix",
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
    for (const t of [
      ...project.candidates[project.selected].tracks,
      { id: "tag" },
    ]) {
      const input = keep(ctx.createGain()),
        bus = keep(ctx.createGain());
      this.inputs.set(t.id, input);
      const hp = keep(ctx.createBiquadFilter());
      hp.type = "highpass";
      hp.frequency.value =
        t.id === "bass"
          ? 24
          : isDrum(t.id)
            ? 30
            : t.id === "pad"
              ? 95
              : t.id === "answer"
                ? 220
                : 135;
      input.connect(hp);
      if (t.id === "bass") {
        const shaper = keep(ctx.createWaveShaper());
        shaper.curve = curve(
          project.settings.grit *
            (project.settings.profile === "culture" ? 0.17 : 0.5),
        );
        shaper.oversample = "2x";
        const comp = keep(ctx.createGain());
        comp.gain.value = 1 / (1 + project.settings.grit * 2.2);
        hp.connect(shaper);
        shaper.connect(comp);
        comp.connect(bus);
      } else hp.connect(bus);
      if (tap === "mix" || tap === "headroom" || tap === t.id)
        bus.connect(this.master);
      if (!isDrum(t.id) && t.id !== "bass" && t.id !== "tag") {
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
    const used = new Set(
      this.project.candidates[this.project.selected].tracks.map(
        (t) => t.instrument,
      ),
    );
    if (this.project.tagEnabled && this.project.tagAsset)
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
    pan.connect(this.inputs.get(e.role)!);
    const end = () => {
      level.disconnect();
      pan.disconnect();
    };
    return { level, end };
  }
  schedule(e: ScoreEvent, at: number) {
    const asset = this.project.assets.find((a) => a.id === e.instrument);
    if (asset) {
      this.sample(e, asset, at);
      return;
    }
    if (e.instrument.startsWith("sample-")) return;
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
      { level, end } = this.wire(e),
      amp = c.createGain(),
      lp = c.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 700 + s.grit * 1500;
    lp.Q.value = 0.5;
    this.envelope(
      amp,
      at,
      duration,
      (s.profile === "culture" ? 0.25 : 0.43) * e.velocity,
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
    osc.onended = () => {
      this.sources.delete(osc);
      [osc, harm, hg, amp, lp].forEach((n) => n.disconnect());
      end();
    };
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
      noise.buffer = this.noise(e.instrument);
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
  private sample(e: ScoreEvent, a: SampleAsset, at: number) {
    const buffer = this.samples.get(a.id);
    if (!buffer) throw new Error(`Missing sample: ${a.name}`);
    const c = this.ctx,
      source = c.createBufferSource(),
      amp = c.createGain(),
      { level, end } = this.wire(e),
      drum = isDrum(e.role) || e.role === "tag",
      rate = drum ? 1 : 2 ** ((e.pitch - a.root + a.tuning / 100) / 12),
      trim = Math.max(0, Math.min(a.trimStart, buffer.duration - 0.001)),
      available = Math.max(
        0.001,
        Math.min(a.trimEnd || buffer.duration, buffer.duration) - trim,
      ),
      held =
        a.envelopeMode === "one-shot"
          ? Math.min(
              available / rate,
              e.chokeAfter
                ? seconds(e.chokeAfter, this.project.settings.bpm)
                : Infinity,
            )
          : Math.min(
              available / rate,
              seconds(e.duration, this.project.settings.bpm),
            );
    source.buffer = buffer;
    source.loop = a.loop ?? false;
    source.loopStart = trim;
    source.loopEnd = trim + available;
    source.playbackRate.setValueAtTime(rate, at);
    if (e.glide) {
      const start = at + seconds(e.glide.at, this.project.settings.bpm);
      source.playbackRate.setValueAtTime(rate, start);
      source.playbackRate.exponentialRampToValueAtTime(
        2 ** ((e.glide.to - a.root + a.tuning / 100) / 12),
        Math.min(at + held, start + e.glide.ms / 1000),
      );
    }
    this.envelope(
      amp,
      at,
      Math.max(0.005, held - 0.015),
      a.gain * e.velocity,
      0.003,
      0.01,
      0.9,
      0.015,
    );
    source.connect(amp);
    amp.connect(level);
    this.sources.add(source);
    source.start(at, trim, available);
    source.stop(at + held + 0.002);
    source.onended = () => {
      this.sources.delete(source);
      source.disconnect();
      amp.disconnect();
      end();
    };
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
  }
  get activeVoices() {
    return this.sources.size;
  }
}
