// RIFF/WAVE format 1, interleaved signed 24-bit little-endian PCM.
export function readWavInfo(
  bytes: ArrayBuffer,
): { sampleRate: number; channels: number } | null {
  const v = new DataView(bytes),
    tag = (at: number) => String.fromCharCode(...new Uint8Array(bytes, at, 4));
  if (bytes.byteLength < 12 || tag(0) !== "RIFF" || tag(8) !== "WAVE")
    return null;
  for (let at = 12; at + 8 <= bytes.byteLength; ) {
    const size = v.getUint32(at + 4, true);
    if (at + 8 + size > bytes.byteLength) return null;
    if (tag(at) === "fmt " && size >= 16) {
      const channels = v.getUint16(at + 10, true),
        sampleRate = v.getUint32(at + 12, true);
      return sampleRate > 0 && channels > 0 ? { sampleRate, channels } : null;
    }
    at += 8 + size + (size % 2);
  }
  return null;
}
export function encodeWav(
  channels: Float32Array[],
  sampleRate = 44100,
): Uint8Array {
  const frames = channels[0].length,
    count = channels.length,
    bytes = frames * count * 3,
    buffer = new ArrayBuffer(44 + bytes),
    v = new DataView(buffer);
  const str = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(offset + i, s.charCodeAt(i));
  };
  str(0, "RIFF");
  v.setUint32(4, 36 + bytes, true);
  str(8, "WAVE");
  str(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, count, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * count * 3, true);
  v.setUint16(32, count * 3, true);
  v.setUint16(34, 24, true);
  str(36, "data");
  v.setUint32(40, bytes, true);
  let offset = 44;
  for (let i = 0; i < frames; i++)
    for (let ch = 0; ch < count; ch++) {
      const sample = Number.isFinite(channels[ch][i]) ? channels[ch][i] : 0;
      let n = Math.round(Math.max(-1, Math.min(1, sample)) * 8388607);
      if (n < 0) n += 16777216;
      v.setUint8(offset++, n & 255);
      v.setUint8(offset++, (n >> 8) & 255);
      v.setUint8(offset++, (n >> 16) & 255);
    }
  return new Uint8Array(buffer);
}
