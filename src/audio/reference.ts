export interface ReferenceAnalysis {
  bpmCandidates: number[];
  tempoConfidence: number;
  key: number;
  keyConfidence: number;
  brightnessHz: number;
  onsetDensity: number;
  lowEnd: number[];
  changes: number[];
  duration: number;
}
// Local descriptor analysis, not source separation or transcription.
function magnitudes(input: Float64Array) {
  const n = input.length,
    re = new Float64Array(input),
    im = new Float64Array(n);
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) [re[i], re[j]] = [re[j], re[i]];
  }
  for (let len = 2; len <= n; len *= 2) {
    const a = (-2 * Math.PI) / len;
    for (let i = 0; i < n; i += len)
      for (let j = 0; j < len / 2; j++) {
        const cos = Math.cos(a * j),
          sin = Math.sin(a * j),
          u = i + j,
          v = u + len / 2,
          tr = re[v] * cos - im[v] * sin,
          ti = re[v] * sin + im[v] * cos;
        re[v] = re[u] - tr;
        im[v] = im[u] - ti;
        re[u] += tr;
        im[u] += ti;
      }
  }
  return re.slice(0, n / 2).map((v, i) => Math.hypot(v, im[i]));
}
export async function analyzeReference(
  file: File,
  progress: (n: number) => void,
): Promise<ReferenceAnalysis> {
  if (file.size > 60_000_000)
    throw new Error("Reference analysis accepts files up to 60 MB.");
  const ctx = new AudioContext(),
    buffer = await ctx.decodeAudioData(await file.arrayBuffer());
  await ctx.close();
  const stride = Math.max(1, Math.round(buffer.sampleRate / 11025)),
    rate = buffer.sampleRate / stride,
    hop = 512,
    N = 2048,
    length = Math.min(buffer.length, buffer.sampleRate * 180),
    energy: number[] = [],
    chroma = new Float64Array(12),
    low: number[] = [];
  let centroid = 0,
    weight = 0;
  for (let at = 0; at + N * stride < length; at += hop * stride) {
    const frame = new Float64Array(N);
    let rms = 0;
    for (let i = 0; i < N; i++) {
      let sample = 0;
      for (let ch = 0; ch < buffer.numberOfChannels; ch++)
        sample +=
          buffer.getChannelData(ch)[at + i * stride] / buffer.numberOfChannels;
      frame[i] = sample * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1)));
      rms += sample * sample;
    }
    const mag = magnitudes(frame);
    let lo = 0,
      hi = 0;
    for (let k = 1; k < mag.length; k++) {
      const f = (k * rate) / N,
        m = mag[k] * mag[k];
      if (f < 180) lo += m;
      if (f > 500) hi += m;
      centroid += f * m;
      weight += m;
      if (f > 65 && f < 2000) {
        const midi = Math.round(69 + 12 * Math.log2(f / 440));
        chroma[((midi % 12) + 12) % 12] += mag[k];
      }
    }
    energy.push(Math.sqrt(rms / N) + Math.sqrt(hi) / N);
    low.push(Math.sqrt(lo) / N);
    if (energy.length % 80 === 0) {
      progress(at / length);
      await new Promise((r) => setTimeout(r, 0));
    }
  }
  const onset = energy.map((x, i) => Math.max(0, x - (energy[i - 1] ?? x))),
    dt = hop / rate;
  const scores = Array.from({ length: 101 }, (_, i) => {
    const bpm = 80 + i,
      lag = 60 / bpm / dt;
    let score = 0;
    for (let j = Math.ceil(lag); j < onset.length; j++) {
      const x = j - lag,
        a = Math.floor(x),
        f = x - a;
      score += onset[j] * ((onset[a] ?? 0) * (1 - f) + (onset[a + 1] ?? 0) * f);
    }
    return { bpm, score };
  }).sort((a, b) => b.score - a.score);
  const top = scores[0],
    bpmCandidates = [top.bpm, top.bpm / 2, top.bpm * 2].filter(
      (b) => b >= 40 && b <= 300,
    ),
    sorted = [...chroma]
      .map((v, key) => ({ key, v }))
      .sort((a, b) => b.v - a.v);
  const changes: number[] = [];
  for (let i = 2; i < energy.length; i++)
    if (
      Math.abs(energy[i] - energy[i - 1]) >
        Math.max(0.05, energy[i - 1] * 1.7) &&
      (!changes.length || i * dt - changes.at(-1)! > 2)
    )
      changes.push(Math.round(i * dt * 10) / 10);
  const threshold =
    (onset.reduce((a, b) => a + b, 0) / Math.max(1, onset.length)) * 2.2;
  let hits = 0;
  for (let i = 1; i < onset.length - 1; i++)
    if (
      onset[i] > threshold &&
      onset[i] > onset[i - 1] &&
      onset[i] > onset[i + 1]
    )
      hits++;
  progress(1);
  return {
    bpmCandidates,
    tempoConfidence: Math.min(
      0.8,
      top.score /
        (scores.reduce((a, b) => a + b.score, 0) / scores.length || 1) /
        6,
    ),
    key: sorted[0].key,
    keyConfidence: Math.min(
      0.75,
      ((sorted[0].v - sorted[1].v) / (sorted[0].v || 1)) * 3,
    ),
    brightnessHz: Math.round(centroid / (weight || 1)),
    onsetDensity: Math.round((hits / (energy.length * dt || 1)) * 10) / 10,
    lowEnd: low.filter(
      (_, i) => i % Math.max(1, Math.floor(low.length / 64)) === 0,
    ),
    changes: changes.slice(0, 12),
    duration: buffer.duration,
  };
}
