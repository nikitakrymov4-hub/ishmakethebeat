/** Local test setup: use the supplied kit bytes, never synthetic stand-ins for kit identity. */
import fs from "node:fs";
import { setPrivatePalette } from "../src/engine/culture";
const files = [
  "private-assets/bank.json",
  "private-assets/new-palette.json",
  "private-assets/user-tdf-kit-20261016.json",
];
if (files.every((f) => fs.existsSync(f)))
  setPrivatePalette(
    files.flatMap((f) => JSON.parse(fs.readFileSync(f, "utf8"))),
  );
