import type { Preset } from "./bank";
import type { Context } from "./graph";

/** These instruments are original browser synths, not emulations of named plugins. */
export function characterVoice(
  ctx: Context,
  p: Preset,
  pitch: number,
  velocity: number,
  brightness: number,
  at: number,
  duration: number,
  output: AudioNode,
  start: (source: AudioScheduledSourceNode, at: number, end: number) => void,
  done: () => void,
) {
  const hz = 440 * 2 ** ((pitch - 69) / 12),
    finish = at + duration + p.release + 0.025,
    nodes: AudioNode[] = [],
    own = <T extends AudioNode>(n: T): T => (nodes.push(n), n),
    amp = own(ctx.createGain()),
    low = own(ctx.createBiquadFilter()),
    high = own(ctx.createBiquadFilter()),
    held = Math.max(0.012, duration),
    attack = Math.min(p.attack, held * 0.38),
    decay = Math.min(p.decay, Math.max(0.004, held - attack)),
    peak = p.gain * velocity;
  high.type = "highpass";
  high.frequency.value = ["moving-pad", "string"].includes(p.family!)
    ? 235
    : p.family === "fm-bell"
      ? 300
      : 150;
  low.type = "lowpass";
  low.Q.value = p.family === "reed" ? 0.85 : 0.58;
  const cutoff = Math.min(
    ctx.sampleRate * 0.42,
    Math.max(450, p.cutoff * (0.48 + brightness * 0.75)),
  );
  low.frequency.setValueAtTime(cutoff, at);
  // Keys/bells lose high partials; held pad and pedal keep their slow movement.
  if (p.family === "electric-keys" || p.family === "fm-bell")
    low.frequency.exponentialRampToValueAtTime(
      Math.max(850, cutoff * 0.37),
      at + Math.min(held, 0.7),
    );
  amp.gain.setValueAtTime(0.000001, at);
  amp.gain.linearRampToValueAtTime(peak, at + attack);
  amp.gain.exponentialRampToValueAtTime(
    Math.max(0.000002, peak * p.sustain),
    at + attack + decay,
  );
  amp.gain.setValueAtTime(Math.max(0.000002, peak * p.sustain), at + held);
  amp.gain.exponentialRampToValueAtTime(0.000001, at + held + p.release);
  high.connect(low);
  low.connect(amp);
  amp.connect(output);
  const tone = (
    wave: OscillatorType,
    ratio: number,
    gain: number,
    cents = 0,
    pan = 0,
  ) => {
    const o = own(ctx.createOscillator()),
      g = own(ctx.createGain()),
      stereo = own(ctx.createStereoPanner());
    o.type = wave;
    o.frequency.setValueAtTime(hz * ratio, at);
    o.detune.setValueAtTime(cents, at);
    g.gain.value = gain;
    stereo.pan.value = pan;
    o.connect(g);
    g.connect(stereo);
    stereo.connect(high);
    start(o, at, finish);
    return { o, g, stereo };
  };
  const lfo = (
    frequency: number,
    amount: number,
    dest: AudioParam,
    phaseDelay = 0,
  ) => {
    const mod = own(ctx.createOscillator()),
      depth = own(ctx.createGain());
    mod.frequency.value = frequency;
    depth.gain.setValueAtTime(0, at);
    depth.gain.linearRampToValueAtTime(amount, at + Math.max(0.04, phaseDelay));
    mod.connect(depth);
    depth.connect(dest);
    start(mod, at, finish);
  };
  if (p.family === "electric-keys") {
    const fundamental = tone("sine", 1, 0.8),
      tine = tone("sine", 2.004, 0.29),
      upper = tone("sine", 4.016, 0.16 * (0.35 + velocity));
    // Independent tine decays and velocity-driven hammer brightness, rather than two detuned sines.
    tine.g.gain.setValueAtTime(0.29, at);
    tine.g.gain.exponentialRampToValueAtTime(0.025, at + 0.55);
    upper.g.gain.setValueAtTime(0.16 * (0.35 + velocity), at);
    upper.g.gain.exponentialRampToValueAtTime(0.0001, at + 0.15);
    const hammer = own(ctx.createOscillator()),
      hammerG = own(ctx.createGain());
    hammer.frequency.setValueAtTime(hz * 7.03, at);
    hammer.frequency.exponentialRampToValueAtTime(hz * 4.8, at + 0.012);
    hammerG.gain.setValueAtTime(0.035 * velocity ** 2, at);
    hammerG.gain.exponentialRampToValueAtTime(0.00001, at + 0.027);
    hammer.connect(hammerG);
    hammerG.connect(high);
    start(hammer, at, at + 0.03);
    lfo(4.2, 0.035, fundamental.g.gain, 0.3);
  } else if (p.family === "moving-pad" || p.family === "string") {
    const string = p.family === "string";
    const a = tone(
        string ? "sawtooth" : "triangle",
        1,
        string ? 0.22 : 0.47,
        -p.detune,
        -0.66,
      ),
      b = tone("triangle", 1, 0.44, p.detune, 0.66),
      air = tone("sine", 2, string ? 0.12 : 0.18, 1.5, 0.14);
    lfo(0.11, 0.23, a.stereo.pan, 0.5);
    lfo(0.137, -0.22, b.stereo.pan, 0.5);
    lfo(0.19, string ? 140 : 330, low.frequency, 0.7);
    lfo(4.6, string ? 3.5 : 1.3, a.o.detune, 0.6);
    lfo(5.1, string ? 3 : 1, b.o.detune, 0.7);
    lfo(0.16, 0.035, air.g.gain, 0.5);
  } else if (p.family === "fm-bell") {
    const carrier = tone("sine", 1, 0.85),
      mod = own(ctx.createOscillator()),
      modG = own(ctx.createGain());
    mod.frequency.value = hz * p.ratio;
    modG.gain.setValueAtTime(hz * p.fm * (0.35 + velocity), at);
    modG.gain.exponentialRampToValueAtTime(hz * 0.035, at + 0.65);
    mod.connect(modG);
    modG.connect(carrier.o.frequency);
    start(mod, at, finish);
    const strike = tone("sine", 4.21, 0.09);
    strike.g.gain.exponentialRampToValueAtTime(0.00001, at + 0.09);
  } else if (p.family === "reed") {
    const a = tone("sawtooth", 1, 0.45),
      core = tone("sine", 1, 0.5),
      formant = own(ctx.createBiquadFilter());
    // A quiet band-limited reed formant complements a stable sinusoidal core.
    formant.type = "bandpass";
    formant.frequency.value = Math.min(2600, hz * 5);
    formant.Q.value = 1.25;
    a.g.disconnect();
    a.g.connect(formant);
    formant.connect(high);
    lfo(5.25, 7 + velocity * 3, a.o.detune, 0.16);
    lfo(5.25, 5 + velocity * 2, core.o.detune, 0.16);
    a.o.detune.setValueAtTime(-13, at);
    a.o.detune.linearRampToValueAtTime(0, at + 0.035);
  } else if (p.family === "hollow") {
    // Odd harmonic periodic wave keeps the hollow reply distinct from the reed.
    const real = new Float32Array(12),
      imag = new Float32Array(12);
    for (let n = 1; n < 12; n += 2) imag[n] = 1 / (n * n ** 0.22);
    const a = tone("sine", 1, 0.63),
      b = tone("sine", 0.5, 0.1);
    a.o.setPeriodicWave(ctx.createPeriodicWave(real, imag));
    lfo(4.1, 4.5, a.o.detune, 0.12);
    lfo(0.7, 120, low.frequency, 0.2);
    b.o.detune.value = 1;
  }
  const clock = ctx.createConstantSource(),
    silent = ctx.createGain();
  silent.gain.value = 0;
  clock.connect(silent);
  silent.connect(output);
  start(clock, at, finish + 0.001);
  const sourceEnded = clock.onended;
  clock.onended = (event) => {
    sourceEnded?.call(clock, event);
    clock.disconnect();
    silent.disconnect();
    nodes.forEach((n) => n.disconnect());
    done();
  };
}
