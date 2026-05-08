import type { Express, Request, Response } from "express";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import type { RunCheckResponse } from "@shared/schema";

const __filenameLocal = fileURLToPath(import.meta.url);
const __dirnameLocal = path.dirname(__filenameLocal);

// Public, non-secret defaults. Real values come from env. Token & keys are
// always required from env — never hard-coded.
const DEFAULTS = {
  GRIDWEAVE_PLATFORM_URL: "https://platform.gridweave.ai",
  GARAGE_ENDPOINT_URL: "",
  GARAGE_BUCKET: "",
  GARAGE_PREFIX: "",
  GARAGE_REGION: "garage",
};

// Locate Python helpers in both dev (server/python) and built (dist/python)
// layouts. The build script copies server/python -> dist/python.
function resolvePy(name: string): string {
  const candidates = [
    path.resolve(__dirnameLocal, "python", name),
    path.resolve(process.cwd(), "server", "python", name),
    path.resolve(process.cwd(), "dist", "python", name),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return candidates[0];
}

const REAL_SCRIPT = resolvePy("gridweave_check.py");
const DEMO_SCRIPT = resolvePy("gridweave_demo.py");

function pickEnv(): NodeJS.ProcessEnv {
  // Forward only the variables the python script needs. Apply non-secret
  // defaults; never inject defaults for secrets.
  const env: NodeJS.ProcessEnv = { ...process.env };
  env.GRIDWEAVE_PLATFORM_URL =
    process.env.GRIDWEAVE_PLATFORM_URL || DEFAULTS.GRIDWEAVE_PLATFORM_URL;
  env.GARAGE_ENDPOINT_URL =
    process.env.GARAGE_ENDPOINT_URL || DEFAULTS.GARAGE_ENDPOINT_URL;
  env.GARAGE_BUCKET = process.env.GARAGE_BUCKET || DEFAULTS.GARAGE_BUCKET;
  env.GARAGE_PREFIX = process.env.GARAGE_PREFIX || DEFAULTS.GARAGE_PREFIX;
  env.GARAGE_REGION = process.env.GARAGE_REGION || DEFAULTS.GARAGE_REGION;
  return env;
}

function runPython(scriptPath: string): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const py = process.env.PYTHON_BIN || "python3";
    const child = spawn(py, [scriptPath], {
      env: pickEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (b) => out.push(b));
    child.stderr.on("data", (b) => err.push(b));
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
        code,
      });
    });
  });
}

async function handleRun(req: Request, res: Response, opts: { demo?: boolean } = {}) {
  const startedAt = new Date();
  const forceDemo =
    opts.demo === true ||
    process.env.GRIDWEAVE_DEMO === "1" ||
    req.query.demo === "1";

  // Determine which script to run.
  const script = forceDemo ? DEMO_SCRIPT : REAL_SCRIPT;

  let stdout = "";
  let stderr = "";
  let exitCode: number | null = 0;
  try {
    const r = await runPython(script);
    stdout = r.stdout;
    stderr = r.stderr;
    exitCode = r.code;
  } catch (e: any) {
    const finishedAt = new Date();
    const body: RunCheckResponse = {
      ok: false,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      elapsedMs: finishedAt.getTime() - startedAt.getTime(),
      error: {
        code: "spawn_failed",
        message: `Failed to launch Python: ${e?.message || String(e)}. Set PYTHON_BIN to a valid interpreter.`,
      },
    };
    return res.status(200).json(body);
  }

  const finishedAt = new Date();
  const elapsedMs = finishedAt.getTime() - startedAt.getTime();

  // Parse JSON. The python scripts always emit a single JSON document.
  let parsed: any = null;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    const body: RunCheckResponse = {
      ok: false,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      elapsedMs,
      error: {
        code: "bad_python_output",
        message:
          `Python exited with code ${exitCode}. Could not parse JSON output.\n` +
          (stderr ? `stderr:\n${stderr}\n` : "") +
          (stdout ? `stdout:\n${stdout}` : ""),
      },
    };
    return res.status(200).json(body);
  }

  if (parsed && parsed.ok === true && parsed.result) {
    const body: RunCheckResponse = {
      ok: true,
      demo: Boolean(parsed.demo),
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      elapsedMs,
      result: parsed.result,
    };
    return res.status(200).json(body);
  }

  const errInfo = parsed?.error || { code: "unknown", message: "Unknown error" };
  const body: RunCheckResponse = {
    ok: false,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    elapsedMs,
    error: errInfo,
  };
  return res.status(200).json(body);
}

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {
  app.post("/api/run-gridweave-check", (req, res) => {
    void handleRun(req, res);
  });

  // Always-on demo endpoint so the deployed preview can demonstrate the
  // gallery layout without secrets.
  app.post("/api/run-gridweave-check/demo", async (req, res) => {
    return handleRun(req, res, { demo: true });
  });

  // Lightweight config probe — tells the UI which env vars are present
  // (booleans only — never the values themselves).
  app.get("/api/gridweave-config", (_req, res) => {
    res.json({
      hasToken: Boolean(process.env.GRIDWEAVE_TOKEN),
      hasAccessKey: Boolean(process.env.GARAGE_ACCESS_KEY),
      hasSecretKey: Boolean(process.env.GARAGE_SECRET_KEY),
      platformUrl: process.env.GRIDWEAVE_PLATFORM_URL || DEFAULTS.GRIDWEAVE_PLATFORM_URL,
      endpoint: process.env.GARAGE_ENDPOINT_URL || "",
      bucket: process.env.GARAGE_BUCKET || "",
      prefix: process.env.GARAGE_PREFIX || "",
      region: process.env.GARAGE_REGION || DEFAULTS.GARAGE_REGION,
      demoForced: process.env.GRIDWEAVE_DEMO === "1",
    });
  });

  return httpServer;
}
