import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import fs from "node:fs/promises";
import path from "node:path";
import { benchmarkDeliveryOutput } from "./scripts/benchmark-delivery-server";
export default defineConfig({
  plugins: [
    react(),
    benchmarkDeliveryOutput(),
    {
      name: "local-render-output",
      configureServer(server) {
        server.middlewares.use("/__render-output", async (req, res) => {
          try {
            if (req.method !== "POST") {
              res.statusCode = 405;
              res.end();
              return;
            }
            if (
              req.headers.origin &&
              req.headers.origin !== `http://${req.headers.host}`
            ) {
              res.statusCode = 403;
              res.end("Local same-origin requests only");
              return;
            }
            const name =
              new URL(req.url!, "http://127.0.0.1").searchParams.get("name") ??
              "";
            if (
              !/^(?:(?:baseline|comparison|calibration|generated|verification)|character\/(?:baseline|comparison|original|loop|generated|verification)|audio-research\/current)\/[a-zA-Z0-9_.-]+$/.test(
                name,
              )
            )
              throw new Error("Invalid render filename");
            const chunks: Buffer[] = [];
            let size = 0;
            for await (const chunk of req) {
              size += chunk.length;
              if (size > 180_000_000) throw new Error("Render too large");
              chunks.push(Buffer.from(chunk));
            }
            const file = path.resolve("deliverables", name);
            await fs.mkdir(path.dirname(file), { recursive: true });
            await fs.writeFile(file, Buffer.concat(chunks));
            res.end("saved");
          } catch (e) {
            res.statusCode = 400;
            res.end(String(e));
          }
        });
      },
    },
  ],
  server: {
    watch: {
      // Research proofs and rendered audio are served on demand, not source
      // modules. Their writes must not reload the editor during playback.
      ignored: ["**/private-assets/**", "**/deliverables/**", "**/docs/**", "**/qa-artifacts/**"],
    },
  },
  build: { target: "es2022" },
});
