import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { Plugin } from "vite";

const queues = new Map<string, Promise<unknown>>();
const sha256 = (data: Uint8Array) =>
  createHash("sha256").update(data).digest("hex");
const safeName =
  /^[a-z0-9][a-z0-9_-]{0,63}\/[a-z0-9][a-z0-9_-]{0,63}\/[a-zA-Z0-9][a-zA-Z0-9_.-]{0,95}$/;

/** Serialize the compare-and-swap with an atomic rename; never replace unknown output. */
export async function writeDeliveryFile(
  root: string,
  name: string,
  bytes: Uint8Array,
  expected: "absent" | string,
) {
  if (!safeName.test(name)) throw new Error("Invalid delivery filename");
  if (expected !== "absent" && !/^[a-f0-9]{64}$/.test(expected))
    throw new Error("A SHA-256 precondition is required");
  const file = path.join(root, name);
  const previous = queues.get(file) ?? Promise.resolve();
  const operation = previous
    .catch(() => undefined)
    .then(async () => {
      await fs.mkdir(root, { recursive: true });
      let directory = root;
      if ((await fs.lstat(root)).isSymbolicLink())
        throw new Error("Output root cannot be a symlink");
      for (const part of name.split("/").slice(0, -1)) {
        directory = path.join(directory, part);
        await fs.mkdir(directory, { recursive: true });
        if ((await fs.lstat(directory)).isSymbolicLink())
          throw new Error("Output directory cannot be a symlink");
      }
      let actual: string | undefined;
      try {
        if (!(await fs.lstat(file)).isFile())
          throw new Error("Output must be a regular file");
        actual = sha256(await fs.readFile(file));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (expected === "absent" ? actual !== undefined : actual !== expected)
        throw new Error(
          "Output changed or already exists; reload the checkpoint or use a new run ID",
        );
      const temporary = path.join(
        directory,
        `.${path.basename(file)}.${randomUUID()}.part`,
      );
      try {
        await fs.writeFile(temporary, bytes, { flag: "wx" });
        await fs.rename(temporary, file);
      } finally {
        await fs.rm(temporary, { force: true });
      }
      return { sha256: sha256(bytes), bytes: bytes.byteLength };
    });
  queues.set(file, operation);
  try {
    return await operation;
  } finally {
    if (queues.get(file) === operation) queues.delete(file);
  }
}

export function benchmarkDeliveryOutput(): Plugin {
  return {
    name: "benchmark-delivery-output",
    configureServer(server) {
      const root = path.join(
        server.config.root,
        "deliverables",
        "benchmark-delivery",
      );
      server.middlewares.use(
        "/__benchmark-delivery-output",
        async (req, res) => {
          try {
            if (req.method !== "POST") {
              res.statusCode = 405;
              res.end("POST required");
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
            const expected =
              req.headers["if-none-match"] === "*"
                ? "absent"
                : String(req.headers["if-match"] ?? "").replace(/^"|"$/g, "");
            if (expected !== "absent" && !/^[a-f0-9]{64}$/.test(expected)) {
              res.statusCode = 428;
              res.end("If-None-Match: * or If-Match SHA-256 required");
              return;
            }
            const name =
              new URL(req.url!, "http://127.0.0.1").searchParams.get("name") ??
              "";
            if (!safeName.test(name))
              throw new Error("Invalid delivery filename");
            let size = 0;
            const chunks: Buffer[] = [];
            for await (const chunk of req) {
              size += chunk.length;
              if (size > 180_000_000)
                throw new Error("Delivery file exceeds 180 MB");
              chunks.push(Buffer.from(chunk));
            }
            const result = await writeDeliveryFile(
              root,
              name,
              Buffer.concat(chunks),
              expected,
            );
            res.setHeader("Content-Type", "application/json");
            res.setHeader("Cache-Control", "no-store");
            res.setHeader("ETag", `"${result.sha256}"`);
            res.end(JSON.stringify(result));
          } catch (error) {
            res.statusCode = 409;
            res.end(String(error));
          }
        },
      );
    },
  };
}
