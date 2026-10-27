import type { RoleEffects, ScoreEvent } from "../engine/schema";
import type { Context } from "./graph";
import { rng } from "../engine/random";

export interface DelayControl {
  wet: GainNode;
  delays: DelayNode[];
  feedback: GainNode[];
  filters: BiquadFilterNode[];
}
const limit = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x));

/** Warm source filters silently before a seek; returns are restored separately. */
export function vocalWarmupSeconds(event: ScoreEvent): number {
  const filter = event.vocal?.filter;
  const cutoff = filter
    ? Math.min(...[filter.highpass, filter.lowpass].filter((n) => n > 0))
    : Infinity;
  return Math.min(
    3,
    Math.max(0.03, 12 / (2 * Math.PI * Math.SQRT1_2 * cutoff)),
  );
}

/** Linear source-region fades retain their original phase when playback seeks. */
export function vocalFadePoints(
  duration: number,
  offset: number,
  fadeIn: number,
  fadeOut: number,
): { time: number; gain: number }[] {
  const length = Math.max(0, duration),
    start = limit(offset, 0, length);
  let attack = limit(fadeIn, 0, length),
    release = limit(fadeOut, 0, length);
  if (attack + release > length) {
    const scale = length / (attack + release);
    attack *= scale;
    release *= scale;
  }
  const gainAt = (time: number) =>
    Math.max(
      0,
      Math.min(
        1,
        attack ? time / attack : 1,
        release ? (length - time) / release : 1,
      ),
    );
  return [...new Set([start, attack, length - release, length])]
    .filter((time) => time >= start && time <= length)
    .sort((a, b) => a - b)
    .map((time) => ({ time: time - start, gain: gainAt(time) }));
}

/** Deterministic convolution return for explicitly requested vocal reverb. */
export function vocalReverb(
  ctx: Context,
  input: AudioNode,
  output: AudioNode,
  settings: NonNullable<RoleEffects["reverb"]>,
  own: <T extends AudioNode>(n: T) => T,
) {
  const decay = limit(settings.decay, 0.05, 12),
    impulse = ctx.createBuffer(
      2,
      Math.max(1, Math.ceil(ctx.sampleRate * decay)),
      ctx.sampleRate,
    ),
    random = rng(`ish-vocal-room/${decay}`);
  for (let channel = 0; channel < 2; channel++) {
    const data = impulse.getChannelData(channel);
    for (let i = 0; i < data.length; i++)
      data[i] = (random() * 2 - 1) * Math.exp((-6.908 * i) / data.length);
  }
  const preDelay = own(ctx.createDelay(1.01)),
    room = own(ctx.createConvolver()),
    wet = own(ctx.createGain());
  preDelay.delayTime.value = limit(settings.preDelay, 0, 1);
  room.buffer = impulse;
  wet.gain.value = limit(settings.wet, 0, 0.9);
  input.connect(preDelay);
  preDelay.connect(room);
  room.connect(wet);
  wet.connect(output);
}

/** Explicit stereo cross-feedback. The low end is removed before repeats. */
export function stereoDelay(
  ctx: Context,
  input: AudioNode,
  output: AudioNode,
  bpm: number,
  settings: NonNullable<RoleEffects["delay"]>,
  own: <T extends AudioNode>(n: T) => T,
): DelayControl {
  const split = own(ctx.createChannelSplitter(2)),
    merge = own(ctx.createChannelMerger(2)),
    high = own(ctx.createBiquadFilter()),
    wet = own(ctx.createGain()),
    delays = [own(ctx.createDelay(4)), own(ctx.createDelay(4))],
    feedback = [own(ctx.createGain()), own(ctx.createGain())],
    filters = [own(ctx.createBiquadFilter()), own(ctx.createBiquadFilter())];
  high.type = "highpass";
  high.frequency.value = 420;
  if (settings.pingPong) {
    high.channelCount = 1;
    high.channelCountMode = "explicit";
  }
  input.connect(high);
  high.connect(split);
  const division = limit(settings.division, 0.03125, 4);
  delays.forEach((d, i) => {
    d.delayTime.value = Math.min(3.95, (60 / bpm) * division);
    filters[i].type = "lowpass";
    filters[i].frequency.value = limit(settings.cutoff, 250, 18000);
    feedback[i].gain.value = limit(settings.feedback, 0, 0.67);
    if (!settings.pingPong || i === 0)
      split.connect(d, settings.pingPong ? 0 : i);
    d.connect(filters[i]);
    filters[i].connect(merge, 0, i);
    filters[i].connect(feedback[i]);
    feedback[i].connect(delays[settings.pingPong ? 1 - i : i]);
  });
  wet.gain.value = limit(settings.wet, 0, 0.9);
  merge.connect(wet);
  wet.connect(output);
  return { wet, delays, feedback, filters };
}

/** A restrained parallel hat return: short echo + moving comb and a small room.
 * This is an authored browser treatment; it does not load or decode .fst plugin state.
 */
export function hatReturn(
  ctx: Context,
  input: AudioNode,
  output: AudioNode,
  bpm: number,
  settings: NonNullable<RoleEffects["hat"]>,
  room: AudioBuffer,
  own: <T extends AudioNode>(n: T) => T,
  start: (source: AudioScheduledSourceNode, at: number, end: number) => void,
) {
  const wet = own(ctx.createGain()),
    high = own(ctx.createBiquadFilter()),
    low = own(ctx.createBiquadFilter());
  wet.gain.value = limit(settings.mix, 0, 0.65);
  high.type = "highpass";
  high.frequency.value = 2400;
  low.type = "lowpass";
  low.frequency.value = 11600;
  input.connect(high);
  high.connect(low);
  const echo = own(ctx.createDelay(1)),
    echoFeedback = own(ctx.createGain()),
    echoPan = own(ctx.createStereoPanner());
  echo.delayTime.value = Math.max(
    0.006,
    Math.min(0.8, (60 / bpm) * settings.echoBeats),
  );
  echoFeedback.gain.value = limit(settings.feedback, 0, 0.48);
  echoPan.pan.value = 0.5;
  low.connect(echo);
  echo.connect(echoFeedback);
  echoFeedback.connect(echo);
  echo.connect(echoPan);
  echoPan.connect(wet);
  if (settings.chorus > 0) {
    const comb = own(ctx.createDelay(0.04)),
      combGain = own(ctx.createGain()),
      combPan = own(ctx.createStereoPanner()),
      lfo = own(ctx.createOscillator()),
      depth = own(ctx.createGain());
    comb.delayTime.value = 0.009;
    combGain.gain.value = limit(settings.chorus, 0, 1) * 0.6;
    combPan.pan.value = -0.5;
    lfo.frequency.value = 0.24;
    depth.gain.value = 0.0025 * limit(settings.chorus, 0, 1);
    lfo.connect(depth);
    depth.connect(comb.delayTime);
    low.connect(comb);
    comb.connect(combGain);
    combGain.connect(combPan);
    combPan.connect(wet);
    start(lfo, ctx.currentTime, ctx.currentTime + 24 * 3600);
  }
  if (settings.room > 0) {
    const convolver = own(ctx.createConvolver()),
      roomGain = own(ctx.createGain());
    convolver.buffer = room;
    roomGain.gain.value = limit(settings.room, 0, 0.7) * 0.45;
    low.connect(convolver);
    convolver.connect(roomGain);
    roomGain.connect(wet);
  }
  wet.connect(output);
  return wet;
}

/** Deterministic downsample/quantize of a parallel copy; source attack stays dry. */
export function reduceSample(
  ctx: Context,
  source: AudioBuffer,
  amount: number,
) {
  const mix = limit(amount, 0, 1),
    hold = 1 + Math.round(mix * 11),
    quantizer = 2 ** Math.round(12 - mix * 7),
    result = ctx.createBuffer(
      source.numberOfChannels,
      source.length,
      source.sampleRate,
    );
  for (let ch = 0; ch < source.numberOfChannels; ch++) {
    const from = source.getChannelData(ch),
      to = result.getChannelData(ch);
    let value = 0;
    for (let i = 0; i < from.length; i++) {
      if (i % hold === 0) value = Math.round(from[i] * quantizer) / quantizer;
      to[i] = from[i] * (1 - mix * 0.46) + value * mix * 0.46;
    }
  }
  return result;
}
