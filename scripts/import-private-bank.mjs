import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
const lookup = [
  [
    "main plugg 808.wav",
    "1-N2zGbVJ2_3K25Ks6mQEXuA1ubq8H4SB",
    "bass",
    26,
    "ryhon/808s",
  ],
  [
    "fav sub 808.wav",
    "1XLSpxBS5l2QgutEE2ctf1W7kLLfZ6bTD",
    "bass",
    24,
    "ryhon/808s",
  ],
  ["6 808.wav", "1cViT1e6r2hkFhJNYbGkiSMJbKCLLSHei", "bass", 24, "activis/808"],
  [
    "tdf samples clap.wav",
    "1ph20-RP-vsSqgCn6IFsW5Xhzwmn0jkpj",
    "clap",
    60,
    "ryhon/claps",
  ],
  [
    "basic clap.wav",
    "1TEf0TlPq3JLV84CAHetEvy1C7OAO6wU4",
    "clap",
    60,
    "ryhon/claps",
  ],
  [
    "tdf hihat.wav",
    "1DuwPswP3VRqykcaq4VVQfCRaKR9L7Ooc",
    "hat",
    60,
    "ryhon/hihats",
  ],
  [
    "okaymar hihat.wav",
    "14QSIvmMjO1ydJAloHFVM-tNeVFV0KnWw",
    "hat",
    60,
    "ryhon/hihats",
  ],
  [
    "Low tick hat.wav",
    "1TaFUL7JG1BmpoEQnTdK-nXsfvunMNHwk",
    "hat",
    60,
    "activis/Hats",
  ],
  [
    "snap.wav",
    "1kI44nlNUjlozEaZZlyucwogyDj3M1pla",
    "clap",
    60,
    "activis/Snares",
  ],
  [
    "tdf triangle perc.wav",
    "17gzq1m4elQUKRRosncRoNjwrjOpKLYW4",
    "perc",
    60,
    "ryhon/percs",
  ],
];
await fs.mkdir("private-assets", { recursive: true });
const assets = [];
for (const [name, id, role, root, source] of lookup) {
  const filename = `private-assets/${name}`;
  let data;
  try {
    data = await fs.readFile(filename);
  } catch {
    console.log(`Downloading ${name}`);
    const response = await fetch(
      `https://drive.google.com/uc?export=download&id=${id}`,
    );
    if (!response.ok) throw new Error(`${name}: HTTP ${response.status}`);
    data = Buffer.from(await response.arrayBuffer());
    await fs.writeFile(filename, data);
  }
  const info = JSON.parse(
    execFileSync("ffprobe", [
      "-v",
      "error",
      "-show_entries",
      "format=duration:stream=sample_rate,channels",
      "-of",
      "json",
      filename,
    ]).toString(),
  );
  const raw = execFileSync(
      "ffmpeg",
      [
        "-v",
        "error",
        "-i",
        filename,
        "-ac",
        "1",
        "-ar",
        "11025",
        "-f",
        "f32le",
        "-",
      ],
      { maxBuffer: 20e6 },
    ),
    samples = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
  let peak = 0,
    sum = 0,
    last = 0;
  for (let i = 0; i < samples.length; i++) {
    peak = Math.max(peak, Math.abs(samples[i]));
    sum += samples[i] ** 2;
    if (Math.abs(samples[i]) > 0.001) last = i;
  }
  let cents = 0,
    frequency = null,
    confidence = 0;
  if (role === "bass") {
    const expected = 440 * 2 ** ((root - 69) / 12),
      min = Math.floor(11025 / (expected * 1.13)),
      max = Math.ceil(11025 / (expected * 0.88));
    let best = -1,
      period = 11025 / expected;
    for (let lag = min; lag <= max; lag++) {
      let c = 0,
        a = 0,
        b = 0;
      for (let i = 600; i < Math.min(4096, samples.length - lag); i++) {
        c += samples[i] * samples[i + lag];
        a += samples[i] ** 2;
        b += samples[i + lag] ** 2;
      }
      const corr = c / Math.sqrt(a * b || 1);
      if (corr > best) {
        best = corr;
        period = lag;
      }
    }
    frequency = 11025 / period;
    cents = Math.round((69 + 12 * Math.log2(frequency / 440) - root) * 100);
    confidence = Math.max(0, Math.min(0.85, best));
  }
  const hash = createHash("sha256").update(data).digest("hex"),
    duration = +info.format.duration,
    rms = Math.sqrt(sum / samples.length),
    trimEnd =
      role === "bass"
        ? Math.min(duration, (last + 1) / 11025 + 0.015)
        : duration;
  const asset = {
    id: `sample-${hash.slice(0, 16)}`,
    name,
    originalFilename: name,
    sourceId: id,
    source,
    hash,
    sampleRate: +info.streams[0].sample_rate,
    channels: info.streams[0].channels,
    root,
    tuning: -cents,
    rootConfidence: confidence,
    manualOverride: false,
    measuredFundamentalHz: frequency,
    trimStart: 0,
    trimEnd,
    gain:
      role === "bass"
        ? 0.23
        : role === "clap"
          ? 0.45
          : role === "hat"
            ? 0.42
            : 0.4,
    envelopeMode: role === "bass" ? "gated" : "one-shot",
    choke: role === "bass" ? "bass" : role === "hat" ? "hats" : "",
    loop: false,
    role,
    license:
      "User-supplied kit, private project use; redistribution permission unverified",
    peakDb: 20 * Math.log10(peak),
    rmsDb: 20 * Math.log10(rms),
    duration,
    data: `data:audio/wav;base64,${data.toString("base64")}`,
  };
  assets.push(asset);
  console.log(
    `${name}: root ${root}, correction ${-cents} cents, trim ${trimEnd.toFixed(3)} / ${duration.toFixed(3)} sec`,
  );
}
await fs.writeFile("private-assets/bank.json", JSON.stringify(assets));
await fs.writeFile(
  "private-assets/manifest.json",
  JSON.stringify(
    assets.map(({ data, ...a }) => a),
    null,
    2,
  ),
);
