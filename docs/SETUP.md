# Local assets and development

## Fresh clone

Install dependencies with `npm ci`, then run `npm run dev -- --port 5173 --strictPort`. Audio needs a user gesture such as Play. The default supplied-kit workflow requires the local sample banks; explicitly enable **Allow original synth fallback if private kit is missing** to try the built-in instruments without them.

## Restore an existing installation

Keep the repository paths unchanged when transferring files privately from an authorized installation:

| Local path | Purpose |
| --- | --- |
| `private-assets/bank.json` | Initial curated sample bank |
| `private-assets/new-palette.json` | Additional sound palette |
| `private-assets/user-tdf-kit-20261016.json` | Supplied kit used by the generator and test setup |
| `private-assets/321-drumkit/` | Optional 321 drum bank and source files |
| `private-assets/extra-loop-kits/`, `private-assets/stash-kit/` | Supplied loop audio |
| `deliverables/audio-research/extra-loop-kit-catalogue.json` | Extra loop library index |
| `deliverables/audio-research/stash-loop-library-catalogue.json` | Stash loop library index |
| `deliverables/` | Local listening demos, authored projects and verification fixtures |

Other optional banks are loaded by their corresponding app panels. Copying the original `private-assets/` and `deliverables/` directories privately preserves all of those paths. Do not commit them: JSON projects and sample banks can contain embedded audio even when their filenames are not audio extensions. The gitignore excludes both directories and common audio/archive exports.

A portable project can instead be loaded through the studio's project import controls. WAV import is available in the instrument panel; set root tuning, trim, gain and playback mode. Unknown bass tuning needs confirmation. FL Studio preset files cannot run directly in the browser.

Existing import scripts are optional, project-specific development utilities, not a clean-clone installation step. Some read the original Downloads archives or retrieve supplied Drive files. Read their inputs before running them and retain source permissions and credits.

## Checks

`npm run build` compiles TypeScript and builds the application without private audio.

`npm test` runs the complete suite with `tests/setup-kit.ts`. It expects the banks above plus authored project fixtures; without them, asset-dependent tests fail or skip. Run it in the original installation or after restoring the fixtures. A fixture-free smoke check is:

```sh
node --import tsx --test tests/sample-time.test.ts tests/loop-support-rhythm.test.ts tests/render-yield.test.ts
```

`npm run qa` is optional browser QA and requires the local app server and a compatible Playwright browser. Development HTML labs and research scripts are not included in the production app bundle. Rendering and packaging scripts write ignored local deliverables.

## Optional audio research

Audio understanding integrations in `scripts/` are separate from studio playback. They require their own documented runtime/provider setup; no credentials are included. Never put keys in source, exported projects or chat. Research requests, browser evidence and reference recordings remain local and are not part of this repository.
