import type { Express, Request, Response, NextFunction } from "express";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync } from "node:fs";
import type { AcceleratorVendor, GarageImageResponse, GarageImageError, GarageWriteResponse, JobConfig, RunCheckResponse } from "@shared/schema";

function resolveSelfDir(): string {
  try {
    const metaUrl: string | undefined = (import.meta as any)?.url;
    if (typeof metaUrl === "string" && metaUrl.length > 0) {
      return path.dirname(fileURLToPath(metaUrl));
    }
  } catch {
    // fall through
  }
  if (typeof __dirname === "string" && __dirname.length > 0) {
    return __dirname;
  }
  return process.cwd();
}

const __dirnameLocal = resolveSelfDir();

const DEFAULTS = {
  GRIDWEAVE_PLATFORM_URL: "https://platform.gridweave.ai",
  GARAGE_ENDPOINT_URL: "",
  GARAGE_BUCKET: "",
  GARAGE_PREFIX: "",
  GARAGE_REGION: "garage",
};

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
const PREFIX_SCRIPT = resolvePy("garage_prefixes.py");
const PREFIX_DIRECT_SCRIPT = resolvePy("garage_prefixes_direct.py");
const WRITE_SCRIPT = resolvePy("garage_write.py");
const IMAGE_SCRIPT = resolvePy("garage_image.py");

const VENDORS: AcceleratorVendor[] = ["NVIDIA", "AMD", "Axelera", "Lumai"];

function normalizeJobConfig(body: unknown): JobConfig {
  const input = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const vendorRaw = typeof input.vendor === "string" ? input.vendor.trim() : "NVIDIA";
  const vendor = VENDORS.find((v) => v.toLowerCase() === vendorRaw.toLowerCase()) || "NVIDIA";
  const vramRaw = typeof input.vram === "string" ? input.vram.trim() : "2GB";
  const match = vramRaw.match(/^(\d+(?:\.\d+)?)\s*(GB|MB)$/i);
  const vram = match ? `${match[1]}${match[2].toUpperCase()}` : "2GB";
  const prefix = typeof input.prefix === "string" ? input.prefix.trim() : (process.env.GARAGE_PREFIX || DEFAULTS.GARAGE_PREFIX);
  return { vendor, vram, prefix };
}

// tokenOverride: session token takes precedence over the env var so each
// user runs jobs under their own GridWeave identity.
function pickEnv(job: JobConfig, tokenOverride?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (tokenOverride) env.GRIDWEAVE_TOKEN = tokenOverride;
  env.GRIDWEAVE_PLATFORM_URL = process.env.GRIDWEAVE_PLATFORM_URL || DEFAULTS.GRIDWEAVE_PLATFORM_URL;
  env.GARAGE_ENDPOINT_URL = process.env.GARAGE_ENDPOINT_URL || DEFAULTS.GARAGE_ENDPOINT_URL;
  env.GARAGE_BUCKET = process.env.GARAGE_BUCKET || DEFAULTS.GARAGE_BUCKET;
  env.GARAGE_PREFIX = job.prefix ?? process.env.GARAGE_PREFIX ?? DEFAULTS.GARAGE_PREFIX;
  env.GARAGE_REGION = process.env.GARAGE_REGION || DEFAULTS.GARAGE_REGION;
  env.GRIDWEAVE_JOB_VENDOR = job.vendor;
  env.GRIDWEAVE_JOB_VRAM = job.vram;
  return env;
}

const PYTHON_TIMEOUT_MS = parseInt(process.env.PYTHON_TIMEOUT_MS || "90000", 10);
const PYTHON_CHECK_TIMEOUT_MS = parseInt(process.env.PYTHON_CHECK_TIMEOUT_MS || "300000", 10);

function runPython(
  scriptPath: string,
  job: JobConfig,
  timeoutMs = PYTHON_TIMEOUT_MS,
  token?: string,
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const py = process.env.PYTHON_BIN || "python3";
    const child = spawn(py, [scriptPath], {
      env: pickEnv(job, token),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: `Python process killed after ${timeoutMs}ms timeout`,
        code: null,
      });
    }, timeoutMs);
    child.stdout.on("data", (b) => out.push(b));
    child.stderr.on("data", (b) => err.push(b));
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
        code,
      });
    });
  });
}

function runPythonWithInput(
  scriptPath: string,
  job: JobConfig,
  payload: unknown,
  token?: string,
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const py = process.env.PYTHON_BIN || "python3";
    const child = spawn(py, [scriptPath], {
      env: pickEnv(job, token),
      stdio: ["pipe", "pipe", "pipe"],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: `Python process killed after ${PYTHON_TIMEOUT_MS}ms timeout`,
        code: null,
      });
    }, PYTHON_TIMEOUT_MS);
    child.stdout.on("data", (b) => out.push(b));
    child.stderr.on("data", (b) => err.push(b));
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
        code,
      });
    });
    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  });
}

function parsePythonJson(stdout: string): any {
  const trimmed = stdout.trim();
  if (!trimmed) throw new Error("empty stdout");
  try {
    return JSON.parse(trimmed);
  } catch {
    const lines = trimmed.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (line.startsWith("{") && line.endsWith("}")) return JSON.parse(line);
    }
  }
  throw new Error("no JSON object found in stdout");
}

function sessionToken(req: Request): string | undefined {
  return req.session?.token || undefined;
}

function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!req.session?.token && !process.env.GRIDWEAVE_TOKEN) {
    return res.status(401).json({ message: "Not authenticated" });
  }
  next();
}

async function handleRun(req: Request, res: Response, opts: { demo?: boolean } = {}) {
  const startedAt = new Date();
  const job = normalizeJobConfig(req.body);
  const script = opts.demo ? DEMO_SCRIPT : REAL_SCRIPT;
  const token = opts.demo ? undefined : sessionToken(req);

  let stdout = "";
  let stderr = "";
  let exitCode: number | null = 0;
  try {
    const r = await runPython(script, job, PYTHON_CHECK_TIMEOUT_MS, token);
    stdout = r.stdout;
    stderr = r.stderr;
    exitCode = r.code;
  } catch (e: any) {
    const finishedAt = new Date();
    return res.status(200).json({
      ok: false,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      elapsedMs: finishedAt.getTime() - startedAt.getTime(),
      error: { code: "spawn_failed", message: `Failed to launch Python: ${e?.message || String(e)}.` },
    } satisfies RunCheckResponse);
  }

  const finishedAt = new Date();
  const elapsedMs = finishedAt.getTime() - startedAt.getTime();
  let parsed: any = null;
  try {
    parsed = parsePythonJson(stdout);
  } catch {
    return res.status(200).json({
      ok: false,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      elapsedMs,
      error: {
        code: "bad_python_output",
        message: `Python exited with code ${exitCode}. Could not parse JSON output.\n` +
          (stderr ? `stderr:\n${stderr}\n` : "") + (stdout ? `stdout:\n${stdout}` : ""),
      },
    } satisfies RunCheckResponse);
  }

  if (parsed?.ok === true && parsed.result) {
    return res.status(200).json({
      ok: true,
      demo: Boolean(parsed.demo),
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      elapsedMs,
      result: parsed.result,
    } satisfies RunCheckResponse);
  }

  return res.status(200).json({
    ok: false,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    elapsedMs,
    error: parsed?.error || { code: "unknown", message: "Unknown error" },
  } satisfies RunCheckResponse);
}

export async function registerRoutes(httpServer: Server, app: Express): Promise<Server> {
  // ── Auth ─────────────────────────────────────────────────────────────────
  app.post("/api/login", (req, res) => {
    const token = typeof req.body?.token === "string" ? req.body.token.trim() : "";
    if (!token) return res.status(400).json({ message: "GridWeave token is required." });
    req.session.token = token;
    return res.json({ ok: true });
  });

  app.post("/api/logout", (req, res) => {
    req.session.destroy(() => res.json({ ok: true }));
  });

  app.get("/api/me", (req, res) => {
    const authenticated = Boolean(req.session?.token || process.env.GRIDWEAVE_TOKEN);
    return res.json({ authenticated });
  });

  // ── Config probe ──────────────────────────────────────────────────────────
  app.get("/api/gridweave-config", (req, res) => {
    const tok = req.session?.token || process.env.GRIDWEAVE_TOKEN || "";
    res.json({
      hasToken: Boolean(tok),
      hasAccessKey: Boolean(process.env.GARAGE_ACCESS_KEY),
      hasSecretKey: Boolean(process.env.GARAGE_SECRET_KEY),
      platformUrl: process.env.GRIDWEAVE_PLATFORM_URL || DEFAULTS.GRIDWEAVE_PLATFORM_URL,
      endpoint: process.env.GARAGE_ENDPOINT_URL || "",
      bucket: process.env.GARAGE_BUCKET || "",
      prefix: process.env.GARAGE_PREFIX || "",
      region: process.env.GARAGE_REGION || DEFAULTS.GARAGE_REGION,
      demoForced: false,
    });
  });

  // ── Protected routes ──────────────────────────────────────────────────────
  app.post("/api/run-gridweave-check", requireAuth, (req, res) => {
    void handleRun(req, res);
  });

  app.post("/api/run-gridweave-check/demo", (req, res) => {
    return handleRun(req, res, { demo: true });
  });

  async function handleGaragePrefixes(_req: Request, res: Response) {
    const startedAt = new Date();
    let stdout = "";
    let stderr = "";
    let exitCode: number | null = 0;
    try {
      const job: JobConfig = { vendor: "NVIDIA", vram: "2GB" };
      const r = await runPython(PREFIX_DIRECT_SCRIPT, job, PYTHON_TIMEOUT_MS);
      stdout = r.stdout;
      stderr = r.stderr;
      exitCode = r.code;
      return res.status(200).json(parsePythonJson(stdout));
    } catch (e: any) {
      const elapsedMs = new Date().getTime() - startedAt.getTime();
      return res.status(200).json({
        ok: false,
        prefixes: [],
        error: {
          code: "prefix_list_failed",
          message: `Could not list Garage prefixes after ${elapsedMs}ms. ${e?.message || String(e)}\n` +
            (stderr ? `stderr:\n${stderr}\n` : "") +
            (stdout ? `stdout:\n${stdout}\n` : "") +
            `exitCode=${exitCode}`,
        },
      });
    }
  }

  app.post("/api/garage-prefixes", requireAuth, (req, res) => handleGaragePrefixes(req, res));
  app.get("/api/garage-prefixes", requireAuth, (req, res) => handleGaragePrefixes(req, res));

  app.post("/api/garage-images", requireAuth, async (req, res) => {
    const keys = Array.isArray(req.body?.keys)
      ? (req.body.keys as unknown[]).filter((k): k is string => typeof k === "string" && k.trim().length > 0)
      : [];
    if (keys.length === 0) return res.status(200).json({ ok: true, results: [] });
    const width = typeof req.body?.width === "number" ? req.body.width : 240;
    const job: JobConfig = { vendor: "NVIDIA", vram: "2GB" };
    try {
      const r = await runPythonWithInput(IMAGE_SCRIPT, job, { keys, width }, sessionToken(req));
      return res.status(200).json(parsePythonJson(r.stdout));
    } catch (e: any) {
      return res.status(200).json({
        ok: false, results: [],
        error: { code: "batch_image_failed", message: e?.message || String(e) },
      });
    }
  });

  async function handleGarageWrite(req: Request, res: Response, action: "create_folder" | "upload_files") {
    const startedAt = new Date();
    const job = normalizeJobConfig(req.body);
    const input = req.body && typeof req.body === "object" ? (req.body as Record<string, unknown>) : {};
    const payload = action === "create_folder"
      ? { action, prefix: job.prefix || "", folder_name: typeof input.folder_name === "string" ? input.folder_name : "" }
      : { action, prefix: job.prefix || "", files: Array.isArray(input.files) ? input.files : [] };

    let stdout = "";
    let stderr = "";
    let exitCode: number | null = 0;
    try {
      const r = await runPythonWithInput(WRITE_SCRIPT, job, payload, sessionToken(req));
      stdout = r.stdout;
      stderr = r.stderr;
      exitCode = r.code;
      return res.status(200).json(parsePythonJson(stdout) as GarageWriteResponse);
    } catch (e: any) {
      const elapsedMs = new Date().getTime() - startedAt.getTime();
      return res.status(200).json({
        ok: false,
        action,
        error: {
          code: "garage_write_failed",
          message: `Could not complete Garage write after ${elapsedMs}ms. ${e?.message || String(e)}\n` +
            (stderr ? `stderr:\n${stderr}\n` : "") +
            (stdout ? `stdout:\n${stdout}\n` : "") +
            `exitCode=${exitCode}`,
        },
      } satisfies GarageWriteResponse);
    }
  }

  app.post("/api/garage-create-folder", requireAuth, (req, res) => handleGarageWrite(req, res, "create_folder"));
  app.post("/api/garage-upload", requireAuth, (req, res) => handleGarageWrite(req, res, "upload_files"));

  app.get("/api/versions", async (_req, res) => {
    const pkgNames = [
      "react",
      "express",
      "@aws-sdk/client-s3",
      "@tanstack/react-query",
      "drizzle-orm",
      "tailwindcss",
      "wouter",
      "zod",
      "vite",
      "typescript",
      "better-sqlite3",
    ];

    const versions: Record<string, string> = {
      node: process.version.replace(/^v/, ""),
    };

    const root = path.resolve(process.cwd());
    for (const pkg of pkgNames) {
      try {
        const pkgPath = path.join(root, "node_modules", pkg, "package.json");
        const json = JSON.parse(readFileSync(pkgPath, "utf8"));
        versions[pkg] = json.version as string;
      } catch {
        versions[pkg] = "unknown";
      }
    }

    try {
      const py = process.env.PYTHON_BIN || "python3";
      const child = spawn(py, ["--version"], { stdio: ["ignore", "pipe", "pipe"] });
      const chunks: Buffer[] = [];
      const errChunks: Buffer[] = [];
      await new Promise<void>((resolve) => {
        child.stdout.on("data", (b: Buffer) => chunks.push(b));
        child.stderr.on("data", (b: Buffer) => errChunks.push(b));
        child.on("close", () => resolve());
      });
      const raw = Buffer.concat([...chunks, ...errChunks]).toString().trim();
      const match = raw.match(/Python\s+([\d.]+)/);
      versions.python = match ? match[1] : "unknown";
    } catch {
      versions.python = "unknown";
    }

    res.json(versions);
  });

  app.get("/api/garage-image", async (req, res) => {
    const key = typeof req.query.key === "string" ? req.query.key.trim() : "";
    if (!key) return res.status(400).json({ ok: false, error: { code: "missing_key", message: "key query param is required" } } satisfies GarageImageError);
    const width = typeof req.query.width === "string" ? parseInt(req.query.width, 10) || 0 : 0;
    const job: JobConfig = { vendor: "NVIDIA", vram: "2GB" };
    const payload: Record<string, unknown> = { key };
    if (width > 0) payload.width = width;
    let stderr = "";
    try {
      const r = await runPythonWithInput(IMAGE_SCRIPT, job, payload);
      stderr = r.stderr;
      return res.status(200).json(parsePythonJson(r.stdout) as GarageImageResponse | GarageImageError);
    } catch (e: any) {
      return res.status(200).json({ ok: false, error: { code: "image_fetch_failed", message: `${e?.message || String(e)}\n${stderr}` } } satisfies GarageImageError);
    }
  });

  return httpServer;
}
