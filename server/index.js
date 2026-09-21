import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { askJev, validateState, DEFAULT_MODEL, RequestError } from "./jev.js";

const publicDir = fileURLToPath(new URL("../public/", import.meta.url));
const files = new Map([
  ["/", ["index.html", "text/html"]],
  ["/styles.css", ["styles.css", "text/css"]],
  ["/app.js", ["app.js", "text/javascript"]],
  ["/engine.js", ["engine.js", "text/javascript"]],
  ["/pilot.js", ["pilot.js", "text/javascript"]],
  ["/debug.js", ["debug.js", "text/javascript"]],
  ["/favicon.svg", ["favicon.svg", "image/svg+xml"]],
]);

export function createApp({
  apiKey = process.env.OPENROUTER_API_KEY,
  model = process.env.JEV_MODEL || DEFAULT_MODEL,
  fetchImpl = fetch,
} = {}) {
  let inFlight = false;
  let lastRequest = 0;
  return createServer(async (req, res) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
    );
    const json = (status, data) => {
      if (!res.destroyed) {
        res.writeHead(status, {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        });
        res.end(JSON.stringify(data));
      }
    };
    try {
      const url = new URL(req.url, "http://localhost");
      if (req.method === "GET" && url.pathname === "/api/config")
        return json(200, {
          configured: Boolean(
            apiKey && apiKey !== "your_openrouter_api_key_here",
          ),
          model,
        });
      if (req.method === "POST" && url.pathname === "/api/decision") {
        // This local app must not be callable by unrelated websites using the owner's key.
        if (
          req.headers.origin &&
          new URL(req.headers.origin).host !== req.headers.host
        )
          throw new RequestError("Cross-origin requests are not allowed.", 403);
        if (!req.headers["content-type"]?.startsWith("application/json"))
          throw new RequestError("Expected JSON.", 415);
        if (inFlight || Date.now() - lastRequest < 100)
          throw new RequestError(
            "A decision is already pending. Try again in a moment.",
            429,
          );
        let raw = "";
        for await (const chunk of req) {
          raw += chunk;
          if (Buffer.byteLength(raw) > 8192)
            throw new RequestError("Game state is too large.", 413);
        }
        let body;
        try {
          body = JSON.parse(raw);
        } catch {
          throw new RequestError("Invalid JSON.");
        }
        const state = validateState(body);
        const controller = new AbortController();
        res.on("close", () => {
          if (!res.writableEnded) controller.abort();
        });
        inFlight = true;
        lastRequest = Date.now();
        try {
          return json(
            200,
            await askJev(state, {
              apiKey,
              model,
              fetchImpl,
              signal: controller.signal,
            }),
          );
        } finally {
          inFlight = false;
        }
      }
      if (req.method === "GET" && files.has(url.pathname)) {
        const [file, type] = files.get(url.pathname);
        const content = await readFile(resolve(publicDir, file));
        res.writeHead(200, {
          "Content-Type": `${type}; charset=utf-8`,
          "Cache-Control": "no-cache",
        });
        return res.end(content);
      }
      json(404, { error: "Not found." });
    } catch (error) {
      json(error instanceof RequestError ? error.status : 500, {
        error:
          error instanceof RequestError
            ? error.message
            : "Something went wrong. Please try again.",
      });
    }
  });
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const port = Number(process.env.PORT || 3000);
  createApp().listen(port, "127.0.0.1", () =>
    console.log(`Jev Flight Lab → http://localhost:${port}`),
  );
}
