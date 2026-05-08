import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useTheme } from "@/lib/theme";
import { Logo } from "@/components/Logo";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  AlertCircle,
  CheckCircle2,
  Cpu,
  Database,
  HardDrive,
  Image as ImageIcon,
  Loader2,
  Moon,
  Play,
  Sparkles,
  Sun,
  TerminalSquare,
} from "lucide-react";
import type { RunCheckResponse } from "@shared/schema";

type Status = "idle" | "running" | "success" | "error";

interface ConfigInfo {
  hasToken: boolean;
  hasAccessKey: boolean;
  hasSecretKey: boolean;
  platformUrl: string;
  endpoint: string;
  bucket: string;
  prefix: string;
  region: string;
  demoForced: boolean;
}

function formatBytes(n: number): string {
  if (!Number.isFinite(n)) return "—";
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2)} ${units[i]}`;
}

function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(2)} s`;
  const m = Math.floor(s / 60);
  return `${m}m ${(s - m * 60).toFixed(1)}s`;
}

function StatusPill({ status }: { status: Status }) {
  const map: Record<Status, { label: string; cls: string; icon: React.ReactNode }> = {
    idle: {
      label: "Idle",
      cls: "bg-muted text-muted-foreground",
      icon: <span className="size-1.5 rounded-full bg-muted-foreground/60" />,
    },
    running: {
      label: "Running",
      cls: "bg-primary/10 text-primary border-primary/30",
      icon: <Loader2 className="size-3 animate-spin" />,
    },
    success: {
      label: "Success",
      cls: "bg-emerald-500/10 text-emerald-600 border-emerald-500/30 dark:text-emerald-400",
      icon: <CheckCircle2 className="size-3" />,
    },
    error: {
      label: "Error",
      cls: "bg-destructive/10 text-destructive border-destructive/30",
      icon: <AlertCircle className="size-3" />,
    },
  };
  const v = map[status];
  return (
    <span
      data-testid={`status-${status}`}
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium ${v.cls}`}
    >
      {v.icon}
      {v.label}
    </span>
  );
}

function SummaryCard({
  icon,
  label,
  value,
  mono,
  testid,
}: {
  icon: React.ReactNode;
  label: string;
  value: React.ReactNode;
  mono?: boolean;
  testid?: string;
}) {
  return (
    <Card className="overflow-hidden">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          <span className="text-primary">{icon}</span>
          {label}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div
          data-testid={testid}
          className={`break-all text-base font-semibold leading-snug ${mono ? "font-mono" : ""}`}
        >
          {value}
        </div>
      </CardContent>
    </Card>
  );
}

/** Parse a few well-known fields out of the python output_text for summary cards. */
function parseOutputText(text: string) {
  const out: { gpus: string[]; cuda: string; pandas: string } = {
    gpus: [],
    cuda: "",
    pandas: "",
  };
  if (!text) return out;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith("nvidia-smi -L:")) {
      // collect following GPU lines until blank/non-GPU
      for (let j = i + 1; j < lines.length; j++) {
        const l = lines[j].trim();
        if (!l) break;
        if (/^GPU\s+\d+:/i.test(l)) out.gpus.push(l);
        else break;
      }
    }
    const cuda = line.match(/^CUDA_VISIBLE_DEVICES=(.*)$/);
    if (cuda) out.cuda = cuda[1];
    const pandas = line.match(/^pandas version:\s*(.*)$/);
    if (pandas) out.pandas = pandas[1];
  }
  return out;
}

export default function Inspector() {
  const { theme, toggle } = useTheme();
  const [status, setStatus] = useState<Status>("idle");
  const [response, setResponse] = useState<RunCheckResponse | null>(null);

  const config = useQuery<ConfigInfo>({
    queryKey: ["/api/gridweave-config"],
  });

  const cfgReady = useMemo(() => {
    const c = config.data;
    if (!c) return false;
    return c.hasToken && c.hasAccessKey && c.hasSecretKey && Boolean(c.endpoint) && Boolean(c.bucket);
  }, [config.data]);

  const run = useMutation({
    mutationFn: async (mode: "real" | "demo") => {
      const url =
        mode === "demo"
          ? "/api/run-gridweave-check/demo"
          : "/api/run-gridweave-check";
      const res = await apiRequest("POST", url, {});
      return (await res.json()) as RunCheckResponse;
    },
    onMutate: () => {
      setStatus("running");
      setResponse(null);
    },
    onSuccess: (data) => {
      setResponse(data);
      setStatus(data.ok ? "success" : "error");
      // Refresh config (in case anything changed).
      queryClient.invalidateQueries({ queryKey: ["/api/gridweave-config"] });
    },
    onError: (err: any) => {
      setResponse({
        ok: false,
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        elapsedMs: 0,
        error: { code: "client_error", message: err?.message || String(err) },
      });
      setStatus("error");
    },
  });

  const ok = response && response.ok ? response : null;
  const errResp = response && !response.ok ? response : null;
  const result = ok?.result ?? null;
  const parsed = useMemo(
    () => parseOutputText(result?.output_text || ""),
    [result?.output_text]
  );

  const friendly: Record<Status, string> = {
    idle: "Ready. Press Run check to authenticate, list objects, and fetch image previews.",
    running: "Authenticating with GridWeave, listing Garage objects, and fetching image previews…",
    success: ok?.demo
      ? "Demo run finished. The values below are synthetic — wire up real credentials to run against your cluster."
      : "Check finished successfully.",
    error: "The check did not finish. See the error panel for details.",
  };

  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* App shell header */}
      <header className="sticky top-0 z-30 border-b border-border bg-background/80 backdrop-blur">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-3">
          <div className="flex items-center gap-3">
            <span className="text-primary"><Logo className="h-7 w-7" /></span>
            <div>
              <div className="text-sm font-semibold leading-none" data-testid="text-brand">
                GridWeave Inspector
              </div>
              <div className="text-[11px] uppercase tracking-wider text-muted-foreground">
                GPU · Garage S3 · Ray Data
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <StatusPill status={status} />
            <Button
              variant="ghost"
              size="icon"
              aria-label="Toggle theme"
              onClick={toggle}
              data-testid="button-toggle-theme"
            >
              {theme === "dark" ? <Sun className="size-4" /> : <Moon className="size-4" />}
            </Button>
          </div>
        </div>
      </header>

      {/* Hero / control panel */}
      <section className="border-b border-border bg-grid">
        <div className="mx-auto max-w-7xl px-6 py-10">
          <div className="grid gap-8 md:grid-cols-[1.4fr_1fr] md:items-end">
            <div>
              <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-border bg-card px-3 py-1 text-xs text-muted-foreground">
                <Sparkles className="size-3 text-primary" />
                Cluster readiness check
              </div>
              <h1 className="text-xl font-semibold tracking-tight md:text-xl">
                Verify GPUs, storage, and image data in one run.
              </h1>
              <p className="mt-2 max-w-2xl text-sm text-muted-foreground" data-testid="text-friendly-status">
                {friendly[status]}
              </p>
              <div className="mt-5 flex flex-wrap items-center gap-3">
                <Button
                  size="lg"
                  onClick={() => run.mutate(cfgReady ? "real" : "demo")}
                  disabled={run.isPending}
                  data-testid="button-run-check"
                  className="gap-2"
                >
                  {run.isPending ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Play className="size-4" />
                  )}
                  {run.isPending ? "Running…" : cfgReady ? "Run check" : "Run demo"}
                </Button>
                <Button
                  size="lg"
                  variant="outline"
                  onClick={() => run.mutate("demo")}
                  disabled={run.isPending}
                  data-testid="button-run-demo"
                  className="gap-2"
                >
                  <Sparkles className="size-4" />
                  Run demo
                </Button>
                {response && (
                  <div className="flex items-center gap-3 text-xs text-muted-foreground">
                    <span data-testid="text-started-at">
                      Started{" "}
                      <span className="font-mono text-foreground">
                        {new Date(response.startedAt).toLocaleTimeString()}
                      </span>
                    </span>
                    <span aria-hidden>·</span>
                    <span data-testid="text-elapsed">
                      Elapsed{" "}
                      <span className="font-mono text-foreground">
                        {formatElapsed(response.elapsedMs)}
                      </span>
                    </span>
                  </div>
                )}
              </div>
            </div>

            <Card className="border-card-border" data-testid="card-config">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium">
                  Environment configuration
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-xs">
                <ConfigRow label="GRIDWEAVE_TOKEN" present={config.data?.hasToken} />
                <ConfigRow label="GARAGE_ACCESS_KEY" present={config.data?.hasAccessKey} />
                <ConfigRow label="GARAGE_SECRET_KEY" present={config.data?.hasSecretKey} />
                <ConfigRow label="GARAGE_ENDPOINT_URL" value={config.data?.endpoint} />
                <ConfigRow label="GARAGE_BUCKET" value={config.data?.bucket} />
                <ConfigRow label="GARAGE_PREFIX" value={config.data?.prefix} />
                <ConfigRow label="GARAGE_REGION" value={config.data?.region} />
                <ConfigRow label="GRIDWEAVE_PLATFORM_URL" value={config.data?.platformUrl} />
                {config.data && !cfgReady && (
                  <p className="mt-2 rounded-md border border-border bg-muted/40 px-2.5 py-2 text-[11px] leading-relaxed text-muted-foreground">
                    Some required values are not set. The Run button will fall back to demo mode so you can preview the UI.
                    See <span className="font-mono">.env.example</span>.
                  </p>
                )}
              </CardContent>
            </Card>
          </div>
        </div>
      </section>

      <main className="mx-auto max-w-7xl space-y-6 px-6 py-8">
        {/* Error banner */}
        {errResp && (
          <Card className="border-destructive/40 bg-destructive/5" data-testid="card-error">
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-sm text-destructive">
                <AlertCircle className="size-4" />
                Check failed — {errResp.error.code}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <pre
                data-testid="text-error-message"
                className="max-h-72 overflow-auto whitespace-pre-wrap rounded-md border border-destructive/30 bg-background p-3 font-mono text-xs leading-relaxed text-foreground"
              >
                {errResp.error.message}
              </pre>
            </CardContent>
          </Card>
        )}

        {/* Summary cards */}
        <section
          className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3"
          data-testid="grid-summary"
        >
          <SummaryCard
            icon={<Cpu className="size-4" />}
            label="GPU info"
            testid="text-gpu-info"
            value={
              parsed.gpus.length > 0 ? (
                <div className="space-y-1">
                  {parsed.gpus.map((g, i) => (
                    <div key={i} className="font-mono text-xs">
                      {g}
                    </div>
                  ))}
                </div>
              ) : (
                <span className="text-muted-foreground">—</span>
              )
            }
          />
          <SummaryCard
            icon={<Cpu className="size-4" />}
            label="CUDA_VISIBLE_DEVICES"
            mono
            testid="text-cuda"
            value={parsed.cuda || <span className="text-muted-foreground">—</span>}
          />
          <SummaryCard
            icon={<HardDrive className="size-4" />}
            label="Garage endpoint"
            mono
            testid="text-endpoint"
            value={config.data?.endpoint || <span className="text-muted-foreground">—</span>}
          />
          <SummaryCard
            icon={<Database className="size-4" />}
            label="Bucket / prefix"
            mono
            testid="text-bucket-prefix"
            value={
              config.data?.bucket ? (
                <>
                  {config.data.bucket}
                  <span className="text-muted-foreground"> / </span>
                  {config.data.prefix || <span className="text-muted-foreground">(root)</span>}
                </>
              ) : (
                <span className="text-muted-foreground">—</span>
              )
            }
          />
          <SummaryCard
            icon={<Database className="size-4" />}
            label="Objects · images"
            testid="text-counts"
            value={
              result ? (
                <div className="flex items-baseline gap-3">
                  <span className="tabular-nums">
                    {extractCount(result.output_text, /Total objects under prefix:\s*(\d+)/) ?? "—"}
                  </span>
                  <span className="text-xs font-normal text-muted-foreground">objects total</span>
                  <span aria-hidden className="text-muted-foreground">·</span>
                  <span className="tabular-nums">
                    {extractCount(result.output_text, /Image-like objects found:\s*(\d+)/) ?? "—"}
                  </span>
                  <span className="text-xs font-normal text-muted-foreground">images</span>
                </div>
              ) : (
                <span className="text-muted-foreground">—</span>
              )
            }
          />
          <SummaryCard
            icon={<TerminalSquare className="size-4" />}
            label="pandas version"
            mono
            testid="text-pandas"
            value={parsed.pandas || <span className="text-muted-foreground">—</span>}
          />
        </section>

        {/* Output log + image gallery side by side on desktop */}
        <section className="grid gap-6 lg:grid-cols-[3fr_2fr]">
          <Card data-testid="card-output">
            <CardHeader className="flex-row items-center justify-between space-y-0 pb-3">
              <CardTitle className="flex items-center gap-2 text-sm font-medium">
                <TerminalSquare className="size-4 text-primary" />
                Run output
              </CardTitle>
              {ok?.demo && (
                <Badge variant="outline" className="text-[10px]">
                  demo data
                </Badge>
              )}
            </CardHeader>
            <CardContent className="p-0">
              <ScrollArea className="h-[26rem]">
                <pre
                  data-testid="text-output-log"
                  className="whitespace-pre-wrap break-words px-5 py-4 font-mono text-xs leading-relaxed text-foreground"
                >
                  {result?.output_text ||
                    (status === "running"
                      ? "Streaming logs will appear here when the run finishes."
                      : "No output yet. Press Run check to start.")}
                </pre>
              </ScrollArea>
            </CardContent>
          </Card>

          <Card data-testid="card-gallery">
            <CardHeader className="flex-row items-center justify-between space-y-0 pb-3">
              <CardTitle className="flex items-center gap-2 text-sm font-medium">
                <ImageIcon className="size-4 text-primary" />
                Image previews
              </CardTitle>
              <Badge variant="secondary" className="tabular-nums" data-testid="badge-image-count">
                {result?.image_previews.length ?? 0}
              </Badge>
            </CardHeader>
            <CardContent>
              {result && result.image_previews.length > 0 ? (
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                  {result.image_previews.map((img, i) => (
                    <figure
                      key={i}
                      className="group overflow-hidden rounded-md border border-border bg-muted"
                      data-testid={`figure-image-${i}`}
                    >
                      <div className="aspect-square w-full overflow-hidden">
                        <img
                          src={`data:${img.mime};base64,${img.base64}`}
                          alt={img.key}
                          loading="lazy"
                          className="h-full w-full object-cover"
                          data-testid={`img-preview-${i}`}
                        />
                      </div>
                      <figcaption
                        className="truncate px-2 py-1.5 font-mono text-[10px] text-muted-foreground"
                        title={img.key}
                        data-testid={`text-image-key-${i}`}
                      >
                        {img.key.split("/").pop()}
                      </figcaption>
                    </figure>
                  ))}
                </div>
              ) : (
                <div className="flex h-[22rem] flex-col items-center justify-center gap-2 rounded-md border border-dashed border-border text-center">
                  <ImageIcon className="size-8 text-muted-foreground/50" />
                  <p className="text-sm text-muted-foreground">No image previews yet.</p>
                  <p className="max-w-xs text-xs text-muted-foreground/80">
                    Image-like objects under the prefix render here as base64 data URLs.
                  </p>
                </div>
              )}
            </CardContent>
          </Card>
        </section>

        {/* Object sample table */}
        <section>
          <Card data-testid="card-objects">
            <CardHeader className="flex-row items-center justify-between space-y-0 pb-3">
              <CardTitle className="flex items-center gap-2 text-sm font-medium">
                <Database className="size-4 text-primary" />
                Object sample
              </CardTitle>
              <Badge variant="secondary" className="tabular-nums" data-testid="badge-object-count">
                {result?.objects_sample.length ?? 0} rows
              </Badge>
            </CardHeader>
            <CardContent className="px-0 pb-0">
              {result && result.objects_sample.length > 0 ? (
                <div className="max-h-[28rem] overflow-auto">
                  <Table>
                    <TableHeader className="sticky top-0 bg-card">
                      <TableRow>
                        <TableHead className="font-mono text-[11px] uppercase tracking-wide">key</TableHead>
                        <TableHead className="text-right font-mono text-[11px] uppercase tracking-wide">size</TableHead>
                        <TableHead className="font-mono text-[11px] uppercase tracking-wide">last_modified</TableHead>
                        <TableHead className="font-mono text-[11px] uppercase tracking-wide">storage_class</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {result.objects_sample.map((row, i) => (
                        <TableRow key={`${row.key}-${i}`} data-testid={`row-object-${i}`}>
                          <TableCell className="max-w-[28rem] truncate font-mono text-xs" title={row.key}>
                            {row.key}
                          </TableCell>
                          <TableCell className="text-right font-mono text-xs tabular-nums">
                            {formatBytes(Number(row.size))}
                          </TableCell>
                          <TableCell className="font-mono text-xs text-muted-foreground">
                            {row.last_modified ?? "—"}
                          </TableCell>
                          <TableCell className="font-mono text-xs">{row.storage_class}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              ) : (
                <div className="flex h-40 items-center justify-center px-5 text-sm text-muted-foreground">
                  No objects to show. Run the check to populate.
                </div>
              )}
            </CardContent>
          </Card>
        </section>

        <footer className="pt-4 text-[11px] text-muted-foreground">
          Wraps a notebook-style GridWeave + Garage S3 + GPU readiness check. Configuration is read
          from environment variables — no secrets are stored in the browser.
        </footer>
      </main>
    </div>
  );
}

function ConfigRow({
  label,
  value,
  present,
}: {
  label: string;
  value?: string;
  present?: boolean;
}) {
  const isBool = present !== undefined;
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="font-mono text-[11px] text-muted-foreground">{label}</span>
      {isBool ? (
        <span
          data-testid={`config-${label.toLowerCase()}`}
          className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium ${
            present
              ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
              : "bg-destructive/10 text-destructive"
          }`}
        >
          {present ? "set" : "missing"}
        </span>
      ) : (
        <span
          data-testid={`config-${label.toLowerCase()}`}
          className="max-w-[60%] truncate font-mono text-[11px] text-foreground"
          title={value || ""}
        >
          {value || <span className="text-muted-foreground">—</span>}
        </span>
      )}
    </div>
  );
}

function extractCount(text: string, re: RegExp): string | null {
  const m = text.match(re);
  return m ? m[1] : null;
}
