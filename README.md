# ishmakethebeat

A local-first instrumental beat studio built with React, TypeScript, Vite and native Web Audio. Compose from an imported melodic sample or an original score, edit drums and bass, arrange sections, add recorded tags and vox, and export mixes, stems, MIDI and portable projects.

## Run locally

Use Node.js 22.12+ (or 20.19+), then:

```sh
npm ci
npm run dev -- --port 5173 --strictPort
```

Open http://127.0.0.1:5173/ and press **Play** to enable browser audio. The Mac launcher **Start ishmakethebeat.command**, or `./start.sh`, starts the same local studio. It can use an installed Codex Node runtime when available.

## Audio assets are local

This repository contains application source and tooling. Supplied drum kits, melodic loops, commercial reference recordings, finished listening files and portable projects with embedded samples are intentionally excluded. They remain in the original local installation.

A fresh clone can build and open the editor, but the supplied sample libraries and listening demos will be unavailable until their local files are restored. To try generation without the private kit, explicitly enable **Allow original synth fallback if private kit is missing**. This uses the app's original synthesis; it does not reproduce the supplied samples. You can also open an exported portable project containing audio you are authorized to use, or import your own WAVs.

See [local asset setup and development checks](docs/SETUP.md) for the expected paths and test limitations. Neither the repository nor its optional research tools requires paid music generation or an API key to use the studio.

## Workflow

- Choose a loop foundation or an original-score direction. For a loop, confirm its region, tempo, downbeat and key before building drums and bass around it. Reusing a loop preserves its source credit and is not newly generated melody.
- Generate A/B/C ideas; edit notes, drum subdivisions, articulation, instrument settings and mix levels. Lock parts while rewriting others.
- Develop the beat in Arrangement. Audio regions and vocal events retain their timing, trim, gain, pitch, fades, pan, sends and repeat behavior in the editable project.
- Save locally in IndexedDB or export a portable ZIP/JSON. A portable project embeds its required samples; treat it as private audio when sharing.

## Exports

- Stereo 24-bit PCM WAV listening mix and a mix with headroom.
- Aligned stems with shared effects in a separate return.
- Type 1 MIDI for scored notes. MIDI does not contain recorded loops, spoken tags, sample timbre or effects.
- Portable ZIP/JSON with the editable score, arrangement, settings and embedded audio.

Live playback and offline renders share the project score and audio implementation. Sample-based transposition links pitch and playback speed; independent pitch-preserving time stretching is not provided.

## Development

```sh
npm run build
npm test
```

The build works without private audio. The full test suite needs the original local audio banks and authored fixtures; see [setup](docs/SETUP.md) for a fixture-free smoke check. Optional browser QA uses Playwright. Research and rendering scripts are retained as development tools and may need additional local assets, FFmpeg, Python packages or a separately configured audio provider.

The engine contains production experiments informed by user feedback and references. It does not claim artist endorsement or an exact reproduction of any producer's work. Automated audio-model judgments were unreliable and are not a substitute for listening.
