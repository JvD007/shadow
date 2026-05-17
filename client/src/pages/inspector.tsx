import { Fragment, useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
import { useMutation, useQuery } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useTheme } from "@/lib/theme";
import { Logo } from "@/components/Logo";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  Cpu,
  Database,
  FileUp,
  Folder,
  FolderOpen,
  FolderPlus,
  HardDrive,
  Image as ImageIcon,
  Loader2,
  LogOut,
  Moon,
  Monitor,
  Play,
  Server,
  Sparkles,
  Sun,
  TerminalSquare,
  Upload,
  Workflow,
} from "lucide-react";
import type {
  AcceleratorVendor,
  FolderContentsResponse,
  GarageImageError,
  GarageImageResponse,
  GaragePrefixListResponse,
  GarageWriteResponse,
  ImagePreview,
  LayerTimings,
  ObjectSampleRow,
  RunCheckResponse,
} from "@shared/schema";

interface FlowTimings extends LayerTimings {
  http_ms?: number;
}

type Status = "idle" | "running" | "success" | "error";
type LastOp = "run_check" | "demo" | "browse" | "upload" | "create_folder";

const ACCELERATOR_VENDORS: AcceleratorVendor[] = ["NVIDIA", "AMD", "Axelera", "Lumai"];
const ROOT_PREFIX_VALUE = "__root__";

const OP_META: Record<LastOp, { title: string; workerDesc: string; s3Label: string; returnLabel: string }> = {
  run_check:     { title: "Run Check",     workerDesc: "GPU probe · list_objects", s3Label: "list_objects_v2", returnLabel: "objects · GPU data" },
  demo:          { title: "Demo Run",      workerDesc: "synthetic data (no S3)",   s3Label: "— demo",          returnLabel: "synthetic result" },
  browse:        { title: "Browse Folder", workerDesc: "list_objects_v2",          s3Label: "list_objects_v2", returnLabel: "prefixes · objects" },
  upload:        { title: "Upload Files",  workerDesc: "s3fs PutObject",           s3Label: "PutObject",       returnLabel: "write confirmed" },
  create_folder: { title: "Create Folder", workerDesc: "s3fs PutObject",           s3Label: "PutObject",       returnLabel: "folder created" },
};

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

function fileToBase64Payload(file: File): Promise<{ name: string; mime: string; size: number; base64: string }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error || new Error(`Could not read ${file.name}`));
    reader.onload = () => {
      const value = String(reader.result || "");
      const comma = value.indexOf(",");
      resolve({
        name: file.name,
        mime: file.type || "application/octet-stream",
        size: file.size,
        base64: comma >= 0 ? value.slice(comma + 1) : value,
      });
    };
    reader.readAsDataURL(file);
  });
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
  const out: {
    gpus: string[];
    pandas: string;
    serverModel: string;
    cpuCores: string;
    memoryGb: string;
  } = {
    gpus: [],
    pandas: "",
    serverModel: "",
    cpuCores: "",
    memoryGb: "",
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
    const pandas = line.match(/^pandas version:\s*(.*)$/);
    if (pandas) out.pandas = pandas[1];
    const serverModel = line.match(/^Server model:\s*(.*)$/);
    if (serverModel) out.serverModel = serverModel[1];
    const cpuCores = line.match(/^CPU cores:\s*(.*)$/);
    if (cpuCores) out.cpuCores = cpuCores[1];
    const memoryGb = line.match(/^Total memory GB:\s*(.*)$/);
    if (memoryGb) out.memoryGb = memoryGb[1];
  }
  return out;
}

export default function Inspector() {
  const { theme, toggle } = useTheme();
  const [, navigate] = useLocation();

  async function handleLogout() {
    await fetch("/api/logout", { method: "POST" });
    queryClient.clear();
    navigate("/login");
  }
  const [hasRun, setHasRun] = useState(false);
  const [lastOp, setLastOp] = useState<LastOp | null>(null);
  const [status, setStatus] = useState<Status>("idle");
  const [response, setResponse] = useState<RunCheckResponse | null>(null);
  const [jobVendor, setJobVendor] = useState<AcceleratorVendor>("NVIDIA");
  const [jobVram, setJobVram] = useState("2GB");
  const [selectedPrefix, setSelectedPrefix] = useState("");
  const [prefixTouched, setPrefixTouched] = useState(false);
  const [selectedImage, setSelectedImage] = useState<ImagePreview | null>(null);
  const [selectedThumb, setSelectedThumb] = useState<{ base64: string; mime: string } | null>(null);
  const [folderName, setFolderName] = useState("");
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [writeResponse, setWriteResponse] = useState<GarageWriteResponse | null>(null);
  const [flowTimings, setFlowTimings] = useState<FlowTimings | null>(null);

  const flowDispatchMs = useMemo(() => {
    if (flowTimings?.job_ms != null && flowTimings?.s3_ms != null) {
      return Math.max(0, flowTimings.job_ms - flowTimings.s3_ms);
    }
    return undefined;
  }, [flowTimings]);

  const config = useQuery<ConfigInfo>({
    queryKey: ["/api/gridweave-config"],
  });

  const cfgReady = useMemo(() => {
    const c = config.data;
    if (!c) return false;
    return c.hasToken && c.hasAccessKey && c.hasSecretKey && Boolean(c.endpoint) && Boolean(c.bucket);
  }, [config.data]);

  const prefixDiscoveryReady = useMemo(() => {
    const c = config.data;
    if (!c) return false;
    return c.hasToken && c.hasAccessKey && c.hasSecretKey && Boolean(c.endpoint) && Boolean(c.bucket);
  }, [config.data]);

  const prefixQuery = useQuery<GaragePrefixListResponse>({
    queryKey: ["/api/garage-prefixes", jobVendor, jobVram],
    enabled: hasRun && prefixDiscoveryReady,
    queryFn: async () => {
      const t0 = performance.now();
      const res = await apiRequest("POST", "/api/garage-prefixes", {
        vendor: jobVendor,
        vram: jobVram,
        prefix: selectedPrefix,
      });
      const data = (await res.json()) as GaragePrefixListResponse;
      const http_ms = Math.round(performance.now() - t0);
      setFlowTimings((prev) => ({ ...(prev ?? {}), ...(data.timings ?? {}), http_ms }));
      return data;
    },
  });

  useEffect(() => {
    if (!prefixTouched && config.data?.prefix && selectedPrefix === "") {
      setSelectedPrefix(config.data.prefix);
    }
  }, [config.data?.prefix, prefixTouched, selectedPrefix]);

  const prefixOptions = useMemo(() => {
    const values = new Set<string>();
    values.add("");
    if (config.data?.prefix) values.add(config.data.prefix);
    for (const prefix of prefixQuery.data?.prefixes || []) {
      values.add(prefix);
    }
    return Array.from(values);
  }, [config.data?.prefix, prefixQuery.data?.prefixes]);

  const run = useMutation({
    mutationFn: async (mode: "real" | "demo") => {
      const url =
        mode === "demo"
          ? "/api/run-gridweave-check/demo"
          : "/api/run-gridweave-check";
      const t0 = performance.now();
      const res = await apiRequest("POST", url, {
        vendor: jobVendor,
        vram: jobVram,
        prefix: selectedPrefix,
      });
      const data = (await res.json()) as RunCheckResponse;
      const http_ms = Math.round(performance.now() - t0);
      const serverTimings = data.ok ? (data as import("@shared/schema").RunCheckSuccess).timings : undefined;
      setFlowTimings((prev) => ({ ...(prev ?? {}), ...(serverTimings ?? {}), http_ms }));
      return data;
    },
    onMutate: () => {
      setStatus("running");
      setResponse(null);
      // Show the timing card immediately with placeholders
      setFlowTimings({});
      // Force a fresh fetch of prefix/objects queries
      queryClient.invalidateQueries({ queryKey: ["/api/garage-prefixes"] });
      queryClient.invalidateQueries({ queryKey: ["/api/garage-objects"] });
    },
    onSuccess: (data) => {
      setResponse(data);
      setStatus(data.ok ? "success" : "error");
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

  const createFolder = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/garage-create-folder", {
        vendor: jobVendor,
        vram: jobVram,
        prefix: selectedPrefix,
        folder_name: folderName,
      });
      return (await res.json()) as GarageWriteResponse;
    },
    onMutate: () => {
      setWriteResponse(null);
    },
    onSuccess: (data) => {
      setWriteResponse(data);
      if (data.ok) {
        setFolderName("");
        queryClient.invalidateQueries({ queryKey: ["/api/garage-prefixes", jobVendor, jobVram] });
      }
    },
    onError: (err: any) => {
      setWriteResponse({
        ok: false,
        action: "create_folder",
        error: { code: "client_error", message: err?.message || String(err) },
      });
    },
  });

  const uploadFiles = useMutation({
    mutationFn: async () => {
      const files = await Promise.all(selectedFiles.map(fileToBase64Payload));
      const res = await apiRequest("POST", "/api/garage-upload", {
        vendor: jobVendor,
        vram: jobVram,
        prefix: selectedPrefix,
        files,
      });
      return (await res.json()) as GarageWriteResponse;
    },
    onMutate: () => {
      setWriteResponse(null);
    },
    onSuccess: (data) => {
      setWriteResponse(data);
      if (data.ok) {
        setSelectedFiles([]);
        queryClient.invalidateQueries({ queryKey: ["/api/garage-prefixes", jobVendor, jobVram] });
      }
    },
    onError: (err: any) => {
      setWriteResponse({
        ok: false,
        action: "upload_files",
        error: { code: "client_error", message: err?.message || String(err) },
      });
    },
  });

  const fullImageQuery = useQuery<GarageImageResponse | GarageImageError>({
    queryKey: ["/api/garage-image", selectedImage?.key],
    enabled: Boolean(selectedImage),
    queryFn: async () => {
      const res = await fetch(`/api/garage-image?key=${encodeURIComponent(selectedImage!.key)}`);
      return res.json();
    },
    staleTime: 5 * 60 * 1000,
    retry: false,
  });

  const ok = response && response.ok ? response : null;
  const errResp = response && !response.ok ? response : null;
  const result = ok?.result ?? null;
  const parsed = useMemo(
    () => parseOutputText(result?.output_text || ""),
    [result?.output_text]
  );

  const imageKeys = useMemo(
    () => result?.image_previews?.filter((img) => !img.base64).map((img) => img.key) ?? [],
    [result]
  );

  const batchThumbQuery = useQuery<{ ok: boolean; results?: Array<{ ok: boolean; key: string; base64?: string; mime?: string }> }>({
    queryKey: ["/api/garage-images", imageKeys],
    enabled: imageKeys.length > 0,
    queryFn: async () => {
      const res = await apiRequest("POST", "/api/garage-images", { keys: imageKeys, width: 240 });
      return res.json();
    },
    staleTime: 5 * 60 * 1000,
    retry: false,
  });

  const thumbMap = useMemo(() => {
    const map: Record<string, { base64: string; mime: string }> = {};
    if (batchThumbQuery.data?.ok && Array.isArray(batchThumbQuery.data.results)) {
      for (const item of batchThumbQuery.data.results) {
        if (item.ok && item.key && item.base64) {
          map[item.key] = { base64: item.base64, mime: item.mime! };
        }
      }
    }
    return map;
  }, [batchThumbQuery.data]);
  const folderContentsQuery = useQuery<FolderContentsResponse>({
    queryKey: ["/api/garage-objects", selectedPrefix],
    enabled: hasRun && prefixDiscoveryReady,
    queryFn: async () => {
      const t0 = performance.now();
      const res = await apiRequest("POST", "/api/garage-objects", { prefix: selectedPrefix });
      const data: FolderContentsResponse = await res.json();
      const http_ms = Math.round(performance.now() - t0);
      setFlowTimings((prev) => ({ ...(prev ?? {}), ...(data.timings ?? {}), http_ms }));
      return data;
    },
    staleTime: 60 * 1000,
    retry: false,
  });

  const folderImages = folderContentsQuery.data?.image_previews ?? [];
  const folderObjects = folderContentsQuery.data?.objects ?? [];

  const folderImageKeys = useMemo(
    () => folderImages.filter((img) => !img.base64).map((img) => img.key),
    [folderImages]
  );

  const folderThumbQuery = useQuery<{ ok: boolean; results?: Array<{ ok: boolean; key: string; base64?: string; mime?: string }> }>({
    queryKey: ["/api/garage-images", folderImageKeys],
    enabled: hasRun && folderImageKeys.length > 0,
    queryFn: async () => {
      const res = await apiRequest("POST", "/api/garage-images", { keys: folderImageKeys, width: 240 });
      return res.json();
    },
    staleTime: 5 * 60 * 1000,
    retry: false,
  });

  const folderThumbMap = useMemo(() => {
    const map: Record<string, { base64: string; mime: string }> = {};
    if (folderThumbQuery.data?.ok && Array.isArray(folderThumbQuery.data.results)) {
      for (const item of folderThumbQuery.data.results) {
        if (item.ok && item.key && item.base64) {
          map[item.key] = { base64: item.base64, mime: item.mime! };
        }
      }
    }
    return map;
  }, [folderThumbQuery.data]);

  const selectedFilesSize = useMemo(
    () => selectedFiles.reduce((sum, file) => sum + file.size, 0),
    [selectedFiles]
  );
  const writePending = createFolder.isPending || uploadFiles.isPending;
  const friendly: Record<Status, string> = {
    idle: "Ready. Upload files, create folders, or run a worker-side listing check.",
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
            <Button
              variant="ghost"
              size="icon"
              aria-label="Sign out"
              onClick={handleLogout}
              data-testid="button-logout"
            >
              <LogOut className="size-4" />
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
                Worker-only S3 writes
              </div>
              <h1 className="text-xl font-semibold tracking-tight md:text-xl">
                Upload files and create Garage folders through GridWeave workers.
              </h1>
              <p className="mt-2 max-w-2xl text-sm text-muted-foreground" data-testid="text-friendly-status">
                {friendly[status]}
              </p>
              <Card className="mt-5 max-w-2xl border-card-border bg-card/70">
                <CardHeader className="pb-3">
                  <CardTitle className="text-sm font-medium">Remote worker request</CardTitle>
                </CardHeader>
                <CardContent className="grid gap-3 sm:grid-cols-[1fr_1fr]">
                  <label className="space-y-1.5 text-xs font-medium text-muted-foreground">
                    Accelerator vendor
                    <Select
                      value={jobVendor}
                      onValueChange={(value) => setJobVendor(value as AcceleratorVendor)}
                    >
                      <SelectTrigger data-testid="select-vendor" className="bg-background">
                        <SelectValue placeholder="Select vendor" />
                      </SelectTrigger>
                      <SelectContent>
                        {ACCELERATOR_VENDORS.map((vendor) => (
                          <SelectItem key={vendor} value={vendor}>
                            {vendor}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </label>
                  <label className="space-y-1.5 text-xs font-medium text-muted-foreground">
                    VRAM request
                    <Input
                      value={jobVram}
                      onChange={(event) => setJobVram(event.target.value)}
                      placeholder="40GB"
                      data-testid="input-vram"
                      className="bg-background font-mono"
                    />
                  </label>
                  <label className="space-y-1.5 text-xs font-medium text-muted-foreground sm:col-span-2">
                    GARAGE_PREFIX
                    <Select
                      value={selectedPrefix || ROOT_PREFIX_VALUE}
                      onValueChange={(value) => {
                        setPrefixTouched(true);
                        setSelectedPrefix(value === ROOT_PREFIX_VALUE ? "" : value);
                      }}
                      disabled={!prefixDiscoveryReady || prefixQuery.isLoading}
                    >
                      <SelectTrigger data-testid="select-garage-prefix" className="bg-background font-mono">
                        <SelectValue placeholder={prefixQuery.isLoading ? "Loading folders…" : "Select folder prefix"} />
                      </SelectTrigger>
                      <SelectContent className="max-h-[260px] overflow-y-auto">
                        {prefixOptions.map((prefix) => (
                          <SelectItem key={prefix || ROOT_PREFIX_VALUE} value={prefix || ROOT_PREFIX_VALUE}>
                            {prefix || "(root / no prefix)"}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {prefixQuery.data?.ok === false && (
                      <span className="block text-[11px] font-normal text-destructive" data-testid="text-prefix-error">
                        {prefixQuery.data.error?.message || "Could not load prefixes."}
                      </span>
                    )}
                    {prefixDiscoveryReady && prefixQuery.data?.ok && (
                      <span className="block text-[11px] font-normal text-muted-foreground" data-testid="text-prefix-count">
                        {prefixOptions.length} folder option{prefixOptions.length === 1 ? "" : "s"} loaded by the selected worker profile. The menu scrolls after the first 10.
                      </span>
                    )}
                  </label>
                </CardContent>
              </Card>
              <div className="mt-5 flex flex-wrap items-center gap-3">
                <Button
                  size="lg"
                  onClick={() => { setHasRun(true); setLastOp("run_check"); run.mutate("real"); }}
                  disabled={run.isPending}
                  data-testid="button-run-check"
                  className="gap-2"
                >
                  {run.isPending ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Play className="size-4" />
                  )}
                  {run.isPending ? "Running…" : "Run check"}
                </Button>
                <Button
                  size="lg"
                  variant="outline"
                  onClick={() => { setHasRun(true); setLastOp("demo"); run.mutate("demo"); }}
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
                <ConfigRow label="GARAGE_PREFIX" value={selectedPrefix} />
                <ConfigRow label="GARAGE_REGION" value={config.data?.region} />
                <ConfigRow label="GRIDWEAVE_PLATFORM_URL" value={config.data?.platformUrl} />
                {config.data && !cfgReady && (
                  <p className="mt-2 rounded-md border border-border bg-muted/40 px-2.5 py-2 text-[11px] leading-relaxed text-muted-foreground">
                    Some required values are not set. Run check will attempt the real remote job and report any missing configuration.
                    Use Run demo only when you want synthetic preview data.
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

        {/* Workflow diagram */}
        <WorkflowDiagram />

        {/* Active operation flow — dynamic, only shown after Run Check */}
        <ActiveFlowPanel
          hasRun={hasRun}
          status={status}
          bucket={config.data?.bucket ?? ""}
          prefix={selectedPrefix}
          vendor={jobVendor}
          vram={jobVram}
          lastOp={lastOp}
          flowTimings={flowTimings}
        />

        {/* Dedicated timing card — separate from Active Operations */}
        {hasRun && (
          <TimingFlowCard
            flowTimings={flowTimings ?? {}}
            dispatchMs={flowDispatchMs}
            bucket={config.data?.bucket ?? ""}
            prefix={selectedPrefix}
          />
        )}

        {/* Folder browser + contents */}
        <FolderBrowser
          selectedPrefix={selectedPrefix}
          onSelect={(prefix) => {
            setPrefixTouched(true);
            setSelectedPrefix(prefix);
            setLastOp("browse");
          }}
          enabled={hasRun && prefixDiscoveryReady}
        />
        <FolderContents
          prefix={selectedPrefix}
          enabled={hasRun && prefixDiscoveryReady}
          thumbMap={folderThumbMap}
          thumbsLoading={folderThumbQuery.isPending && folderImageKeys.length > 0}
          onSelectImage={(img, thumb) => {
            setSelectedImage(img);
            setSelectedThumb(thumb ?? null);
          }}
        />

        <section className="grid gap-6 lg:grid-cols-[1.15fr_0.85fr]">
          <Card data-testid="card-worker-upload" className="border-card-border">
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-sm font-medium">
                <Upload className="size-4 text-primary" />
                Worker upload
              </CardTitle>
              <p className="text-xs leading-relaxed text-muted-foreground">
                Files are read by the browser and sent to the local API as a job payload. The Garage/S3 write happens only inside the selected GridWeave worker.
              </p>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
                Destination:{" "}
                <span className="font-mono text-foreground">
                  s3://{config.data?.bucket || "GARAGE_BUCKET"}/{selectedPrefix || ""}
                </span>
              </div>
              <label className="block space-y-2 text-xs font-medium text-muted-foreground">
                Select files
                <Input
                  key={selectedFiles.length === 0 ? "upload-empty" : "upload-selected"}
                  type="file"
                  multiple
                  onChange={(event) => setSelectedFiles(Array.from(event.target.files || []))}
                  data-testid="input-upload-files"
                  className="bg-background"
                />
              </label>
              {selectedFiles.length > 0 ? (
                <div className="rounded-md border border-border">
                  <div className="flex items-center justify-between border-b border-border px-3 py-2 text-xs">
                    <span className="font-medium text-foreground">
                      {selectedFiles.length} file{selectedFiles.length === 1 ? "" : "s"} selected
                    </span>
                    <span className="font-mono text-muted-foreground">{formatBytes(selectedFilesSize)}</span>
                  </div>
                  <ScrollArea className="max-h-36">
                    <div className="divide-y divide-border">
                      {selectedFiles.map((file, index) => (
                        <div key={`${file.name}-${index}`} className="flex items-center justify-between gap-3 px-3 py-2 text-xs">
                          <span className="truncate font-mono" title={file.name} data-testid={`text-selected-file-${index}`}>
                            {file.name}
                          </span>
                          <span className="shrink-0 font-mono text-muted-foreground">{formatBytes(file.size)}</span>
                        </div>
                      ))}
                    </div>
                  </ScrollArea>
                </div>
              ) : (
                <div className="flex h-24 items-center justify-center rounded-md border border-dashed border-border text-center text-xs text-muted-foreground">
                  Choose one or more files to upload with the worker.
                </div>
              )}
              <div className="flex flex-wrap gap-3">
                <Button
                  onClick={() => { setLastOp("upload"); uploadFiles.mutate(); }}
                  disabled={writePending || selectedFiles.length === 0}
                  data-testid="button-upload-files"
                  className="gap-2"
                >
                  {uploadFiles.isPending ? <Loader2 className="size-4 animate-spin" /> : <FileUp className="size-4" />}
                  {uploadFiles.isPending ? "Uploading…" : "Upload via worker"}
                </Button>
                <Button
                  variant="outline"
                  onClick={() => setSelectedFiles([])}
                  disabled={writePending || selectedFiles.length === 0}
                  data-testid="button-clear-files"
                >
                  Clear
                </Button>
              </div>
            </CardContent>
          </Card>

          <Card data-testid="card-worker-folder" className="border-card-border">
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-sm font-medium">
                <FolderPlus className="size-4 text-primary" />
                Create folder
              </CardTitle>
              <p className="text-xs leading-relaxed text-muted-foreground">
                Creates a zero-byte object ending in <span className="font-mono">/</span> from the remote worker, using the selected destination prefix.
              </p>
            </CardHeader>
            <CardContent className="space-y-4">
              <label className="block space-y-2 text-xs font-medium text-muted-foreground">
                New folder name
                <Input
                  value={folderName}
                  onChange={(event) => setFolderName(event.target.value)}
                  placeholder="new-folder"
                  data-testid="input-folder-name"
                  className="bg-background font-mono"
                />
              </label>
              <Button
                onClick={() => { setLastOp("create_folder"); createFolder.mutate(); }}
                disabled={writePending || !folderName.trim()}
                data-testid="button-create-folder"
                className="w-full gap-2"
              >
                {createFolder.isPending ? <Loader2 className="size-4 animate-spin" /> : <FolderPlus className="size-4" />}
                {createFolder.isPending ? "Creating…" : "Create folder via worker"}
              </Button>
              {writeResponse && (
                <div
                  className={`rounded-md border px-3 py-3 text-xs ${
                    writeResponse.ok
                      ? "border-emerald-500/30 bg-emerald-500/5"
                      : "border-destructive/30 bg-destructive/5"
                  }`}
                  data-testid="card-write-result"
                >
                  {writeResponse.ok ? (
                    <div className="space-y-2">
                      <div className="flex items-center gap-2 font-medium text-emerald-700 dark:text-emerald-300">
                        <CheckCircle2 className="size-4" />
                        {writeResponse.message}
                      </div>
                      <div className="space-y-1">
                        {writeResponse.objects.map((object, index) => (
                          <div key={`${object.key}-${index}`} className="break-all font-mono text-muted-foreground" data-testid={`text-written-object-${index}`}>
                            {object.key} · {formatBytes(object.size)}
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : (
                    <div className="space-y-2">
                      <div className="flex items-center gap-2 font-medium text-destructive">
                        <AlertCircle className="size-4" />
                        {writeResponse.error.code}
                      </div>
                      <pre className="whitespace-pre-wrap break-words font-mono text-[11px]" data-testid="text-write-error">
                        {writeResponse.error.message}
                      </pre>
                    </div>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        </section>

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
            icon={<Server className="size-4" />}
            label="Server"
            testid="text-server-info"
            value={
              result?.server_info ? (
                <div className="space-y-1">
                  <div className="font-mono text-xs">{result.server_info.model}</div>
                  <div className="text-sm text-muted-foreground">
                    <span className="tabular-nums">{result.server_info.cpu_cores}</span> cores ·{" "}
                    <span className="tabular-nums">{result.server_info.memory_gb}</span> GB RAM
                  </div>
                </div>
              ) : parsed.serverModel || parsed.cpuCores || parsed.memoryGb ? (
                <div className="space-y-1">
                  <div className="font-mono text-xs">{parsed.serverModel || "Unknown server"}</div>
                  <div className="text-sm text-muted-foreground">
                    {parsed.cpuCores || "—"} cores · {parsed.memoryGb || "—"} GB RAM
                  </div>
                </div>
              ) : (
                <span className="text-muted-foreground">—</span>
              )
            }
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
                  {selectedPrefix || <span className="text-muted-foreground">(root)</span>}
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
                <span className="font-mono text-[11px] text-muted-foreground">
                  {selectedPrefix || "(root)"}
                </span>
              </CardTitle>
              <div className="flex items-center gap-2">
                {folderContentsQuery.isFetching && <Loader2 className="size-3 animate-spin text-muted-foreground" />}
                <Badge variant="secondary" className="tabular-nums" data-testid="badge-image-count">
                  {folderImages.length}
                </Badge>
              </div>
            </CardHeader>
            <CardContent>
              {folderImages.length > 0 ? (
                <ScrollArea className="h-[34rem] pr-3" data-testid="scroll-image-gallery">
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                    {folderImages.map((img, i) => (
                      <ImageCard
                        key={img.key}
                        img={img}
                        index={i}
                        thumbData={img.base64 ? { base64: img.base64, mime: img.mime } : folderThumbMap[img.key]}
                        batchLoading={folderThumbQuery.isPending && folderImageKeys.length > 0}
                        onSelect={(thumb) => {
                          setSelectedImage(img);
                          setSelectedThumb(thumb ?? null);
                        }}
                      />
                    ))}
                  </div>
                </ScrollArea>
              ) : (
                <div className="flex h-[22rem] flex-col items-center justify-center gap-2 rounded-md border border-dashed border-border text-center">
                  <ImageIcon className="size-8 text-muted-foreground/50" />
                  <p className="text-sm text-muted-foreground">
                    {folderContentsQuery.isLoading ? "Loading images…" : "No images in this folder."}
                  </p>
                  <p className="max-w-xs text-xs text-muted-foreground/80">
                    Image files in the selected folder appear here as thumbnails.
                  </p>
                </div>
              )}
            </CardContent>
          </Card>

          <Dialog
            open={Boolean(selectedImage)}
            onOpenChange={(open) => { if (!open) { setSelectedImage(null); setSelectedThumb(null); } }}
          >
            <DialogContent className="max-w-5xl p-0" data-testid="dialog-image-preview">
              <DialogHeader className="px-5 pt-5">
                <DialogTitle className="text-sm">Image preview</DialogTitle>
                <DialogDescription className="break-all font-mono text-xs" data-testid="text-selected-image-key">
                  {selectedImage?.key}
                </DialogDescription>
              </DialogHeader>
              {selectedImage && (() => {
                const fullOk = fullImageQuery.data?.ok ? fullImageQuery.data as GarageImageResponse : null;
                const thumbSrc = selectedThumb
                  ? `data:${selectedThumb.mime};base64,${selectedThumb.base64}`
                  : selectedImage.base64
                  ? `data:${selectedImage.mime};base64,${selectedImage.base64}`
                  : null;
                return (
                  <div className="px-5 pb-5">
                    <div className="relative flex min-h-[180px] max-h-[75vh] items-center justify-center overflow-auto rounded-md border border-border bg-muted/40 p-2">
                      {fullOk ? (
                        <img
                          src={`data:${fullOk.mime};base64,${fullOk.base64}`}
                          alt={selectedImage.key}
                          className="max-h-[72vh] max-w-full object-contain"
                          data-testid="img-selected-preview"
                        />
                      ) : thumbSrc ? (
                        <>
                          <img
                            src={thumbSrc}
                            alt={selectedImage.key}
                            className="max-h-[72vh] max-w-full object-contain blur-sm"
                            data-testid="img-selected-preview"
                          />
                          <div className="absolute inset-0 flex items-center justify-center">
                            <div className="flex items-center gap-2 rounded-lg bg-background/85 px-3 py-2 text-xs text-muted-foreground shadow">
                              <Loader2 className="size-4 animate-spin text-primary" />
                              Loading full image…
                            </div>
                          </div>
                        </>
                      ) : (
                        <div className="flex flex-col items-center gap-2 text-muted-foreground">
                          <Loader2 className="size-8 animate-spin text-primary" />
                          <span className="text-xs">Loading image…</span>
                        </div>
                      )}
                      {!fullImageQuery.isPending && fullImageQuery.data && !fullImageQuery.data.ok && (
                        <div className="absolute bottom-2 left-2 right-2 rounded bg-destructive/80 px-2 py-1 text-center text-xs text-white">
                          Full image unavailable — showing thumbnail
                        </div>
                      )}
                    </div>
                  </div>
                );
              })()}
            </DialogContent>
          </Dialog>
        </section>

        {/* Object sample table */}
        <section>
          <Card data-testid="card-objects">
            <CardHeader className="flex-row items-center justify-between space-y-0 pb-3">
              <CardTitle className="flex items-center gap-2 text-sm font-medium">
                <Database className="size-4 text-primary" />
                Object sample
                <span className="font-mono text-[11px] text-muted-foreground">
                  {selectedPrefix || "(root)"}
                </span>
              </CardTitle>
              <div className="flex items-center gap-2">
                {folderContentsQuery.isFetching && <Loader2 className="size-3 animate-spin text-muted-foreground" />}
                <Badge variant="secondary" className="tabular-nums" data-testid="badge-object-count">
                  {folderObjects.length} rows
                </Badge>
              </div>
            </CardHeader>
            <CardContent className="px-0 pb-0">
              {folderObjects.length > 0 ? (
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
                      {folderObjects.map((row, i) => (
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
                  {folderContentsQuery.isLoading
                    ? "Loading objects…"
                    : `No objects in ${selectedPrefix || "root"}.`}
                </div>
              )}
            </CardContent>
          </Card>
        </section>

        <footer className="space-y-4 pt-4">
          <p className="text-[11px] text-muted-foreground">
            Wraps a notebook-style GridWeave + Garage S3 + GPU readiness check. Configuration is read
            from environment variables — no secrets are stored in the browser.
          </p>
          <VersionsPanel />
        </footer>
      </main>
    </div>
  );
}

function FlowNode({
  label,
  sublabel,
  color,
  icon,
}: {
  label: string;
  sublabel?: string;
  color: string;
  icon: React.ReactNode;
}) {
  return (
    <div className={`flex flex-col items-center gap-1.5 rounded-xl border-2 px-4 py-3 text-center ${color}`} style={{ minWidth: "9rem" }}>
      <span className="text-xl">{icon}</span>
      <span className="text-[11px] font-semibold leading-tight">{label}</span>
      {sublabel && <span className="text-[10px] leading-tight opacity-70">{sublabel}</span>}
    </div>
  );
}

function fmtMs(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(2)} s`;
}

/** Simple arrow for the static WorkflowDiagram — no timing. */
function FlowArrow({ label, dir = "right" }: { label?: string; dir?: "right" | "left" }) {
  return (
    <div className="flex flex-col items-center justify-center gap-0.5 shrink-0">
      {label && <span className="text-[9px] font-medium text-muted-foreground whitespace-nowrap">{label}</span>}
      {dir === "right"
        ? <ArrowRight className="size-4 text-muted-foreground" />
        : <ArrowLeft  className="size-4 text-muted-foreground" />}
    </div>
  );
}

function TimingFlowCard({
  flowTimings,
  dispatchMs,
  bucket,
  prefix,
}: {
  flowTimings: FlowTimings;
  dispatchMs?: number;
  bucket: string;
  prefix: string;
}) {
  const nodes = [
    { label: "Browser",    color: "border-sky-500/50 bg-sky-500/10 text-sky-700 dark:text-sky-300" },
    { label: "App Server", color: "border-blue-500/50 bg-blue-500/10 text-blue-700 dark:text-blue-300" },
    { label: "GridWeave",  color: "border-violet-500/50 bg-violet-500/10 text-violet-700 dark:text-violet-300" },
    { label: "Worker",     color: "border-emerald-500/50 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300" },
    { label: "Garage S3",  color: "border-amber-500/50 bg-amber-500/10 text-amber-700 dark:text-amber-300" },
  ];
  const connectors = [
    { timing: flowTimings.http_ms,  label: "HTTP" },
    { timing: flowTimings.auth_ms,  label: "SDK auth" },
    { timing: dispatchMs,           label: "dispatch" },
    { timing: flowTimings.s3_ms,    label: "S3 operation" },
  ];

  return (
    <Card className="border-card-border" data-testid="card-timing-flow">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-sm font-medium">
          <Workflow className="size-4 text-primary" />
          Layer timing
          {bucket && (
            <span className="font-mono text-[11px] font-normal text-muted-foreground">
              s3://{bucket}/{prefix}
            </span>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Pipeline row */}
        <div className="flex items-center overflow-x-auto rounded-xl border border-border bg-muted/10 p-4">
          {nodes.map((node, i) => (
            <Fragment key={i}>
              {/* Node chip */}
              <div className={`shrink-0 rounded-lg border-2 px-4 py-2 text-center text-xs font-bold whitespace-nowrap ${node.color}`}>
                {node.label}
              </div>

              {/* Connector with timing */}
              {i < connectors.length && (() => {
                const { timing, label } = connectors[i];
                return (
                  <div className="flex min-w-[110px] flex-1 flex-col items-center gap-1.5 px-2">
                    {/* Timing badge — always visible */}
                    <span className={`rounded-lg border-2 px-3 py-1 text-sm font-mono font-bold whitespace-nowrap tabular-nums ${
                      timing != null
                        ? "border-primary/60 bg-primary/15 text-primary"
                        : "border-border bg-muted/50 text-muted-foreground"
                    }`}>
                      {timing != null ? fmtMs(timing) : "— ms"}
                    </span>
                    {/* Arrow line */}
                    <div className="flex w-full items-center">
                      <div className="h-0.5 flex-1 bg-border" />
                      <ArrowRight className="size-4 shrink-0 text-muted-foreground" />
                    </div>
                    {/* Label */}
                    <span className="text-[11px] font-medium text-muted-foreground whitespace-nowrap">
                      {label}
                    </span>
                  </div>
                );
              })()}
            </Fragment>
          ))}
        </div>

        {/* Summary row */}
        <div className="flex flex-wrap gap-4 text-xs">
          {[
            { label: "HTTP round-trip", value: flowTimings.http_ms, color: "text-sky-600 dark:text-sky-400" },
            { label: "SDK auth",        value: flowTimings.auth_ms, color: "text-violet-600 dark:text-violet-400" },
            { label: "Worker job",      value: flowTimings.job_ms,  color: "text-emerald-600 dark:text-emerald-400" },
            { label: "S3 operation",    value: flowTimings.s3_ms,   color: "text-amber-600 dark:text-amber-400" },
            { label: "Server total",    value: flowTimings.total_ms, color: "text-blue-600 dark:text-blue-400" },
          ].filter(t => t.value != null).map(({ label, value, color }) => (
            <div key={label} className="flex items-center gap-1.5">
              <span className="text-muted-foreground">{label}:</span>
              <span className={`font-mono font-bold tabular-nums ${color}`}>
                {fmtMs(value!)}
              </span>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

/** Connector segment between two pipeline nodes. Timing sits above the arrow line. */
function PipelineConnector({
  label,
  timing,
  dir = "right",
}: {
  label?: string;
  timing?: number;
  dir?: "right" | "left";
}) {
  return (
    <div className="flex flex-1 min-w-[88px] flex-col items-center gap-1.5 px-1">
      {/* Timing badge — always rendered, never invisible */}
      <span
        className={`rounded-md border px-3 py-1 text-xs font-mono font-bold whitespace-nowrap tabular-nums ${
          timing != null
            ? "border-primary/60 bg-primary/10 text-primary"
            : "border-border bg-muted/50 text-muted-foreground"
        }`}
      >
        {timing != null ? fmtMs(timing) : "— ms"}
      </span>
      {/* Arrow line */}
      <div className="flex w-full items-center">
        {dir === "left" && <ArrowLeft className="size-4 shrink-0 text-muted-foreground" />}
        <div className="h-px flex-1 bg-border" />
        {dir === "right" && <ArrowRight className="size-4 shrink-0 text-muted-foreground" />}
      </div>
      {/* Connection label */}
      {label && (
        <span className="text-[10px] font-medium text-muted-foreground whitespace-nowrap">
          {label}
        </span>
      )}
    </div>
  );
}

function WorkflowDiagram() {
  const [open, setOpen] = useState(true);

  return (
    <Card className="border-card-border" data-testid="card-workflow">
      <CardHeader className="pb-2">
        <button
          className="flex w-full items-center justify-between text-left"
          onClick={() => setOpen((v) => !v)}
        >
          <CardTitle className="flex items-center gap-2 text-sm font-medium">
            <Workflow className="size-4 text-primary" />
            System workflow
          </CardTitle>
          <span className="text-[11px] text-muted-foreground">{open ? "Hide" : "Show"}</span>
        </button>
      </CardHeader>

      {open && (
        <CardContent className="space-y-6 pt-1">
          {/* ── All operations — worker path ─────────────────────────── */}
          <div className="space-y-2">
            <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
              All operations — GridWeave worker path
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <FlowNode
                label="Browser"
                sublabel="React UI"
                color="border-sky-500/40 bg-sky-500/5 text-sky-700 dark:text-sky-300"
                icon={<Monitor className="size-5" />}
              />
              <FlowArrow label="HTTP" />
              <FlowNode
                label="App Server"
                sublabel="Express / Node"
                color="border-blue-500/40 bg-blue-500/5 text-blue-700 dark:text-blue-300"
                icon={<Server className="size-5" />}
              />
              <FlowArrow label="GridWeave SDK" />
              <FlowNode
                label="GridWeave Platform"
                sublabel="Job scheduler"
                color="border-violet-500/40 bg-violet-500/5 text-violet-700 dark:text-violet-300"
                icon={<Sparkles className="size-5" />}
              />
              <FlowArrow label="dispatch" />
              <FlowNode
                label="Remote Worker"
                sublabel="GPU node"
                color="border-emerald-500/40 bg-emerald-500/5 text-emerald-700 dark:text-emerald-300"
                icon={<Cpu className="size-5" />}
              />
              <FlowArrow label="boto3 / s3fs" />
              <FlowNode
                label="Garage S3"
                sublabel="Object store"
                color="border-amber-500/40 bg-amber-500/5 text-amber-700 dark:text-amber-300"
                icon={<Database className="size-5" />}
              />
            </div>
            <p className="text-[10px] text-muted-foreground pl-1">
              Every operation — folder browsing, object listing, image thumbnails, uploads,
              folder creation, and run checks — is dispatched through the GridWeave SDK to a
              remote GPU worker. The app server never contacts Garage/S3 directly.
            </p>
          </div>

          {/* ── Operation types ──────────────────────────────────────── */}
          <div className="grid gap-3 sm:grid-cols-2 border-t border-border pt-4">
            {[
              { label: "Browse / List", desc: "Folder browser, sub-folder listing, object listing" },
              { label: "Image previews", desc: "Thumbnail generation and full image fetch" },
              { label: "Upload files", desc: "File bytes travel via GridWeave to the worker" },
              { label: "Create folder", desc: "Zero-byte marker object written by the worker" },
              { label: "Run check", desc: "GPU info, S3 connectivity, pandas version" },
            ].map(({ label, desc }) => (
              <div key={label} className="flex items-start gap-2 text-[10px]">
                <span className="mt-0.5 size-1.5 shrink-0 rounded-full bg-emerald-500" />
                <div>
                  <span className="font-semibold text-foreground">{label}: </span>
                  <span className="text-muted-foreground">{desc}</span>
                </div>
              </div>
            ))}
          </div>

          {/* ── Legend ──────────────────────────────────────────────── */}
          <div className="flex flex-wrap gap-3 border-t border-border pt-3">
            {[
              { color: "bg-sky-500/20 border-sky-500/40 text-sky-700 dark:text-sky-300", label: "Client (browser)" },
              { color: "bg-blue-500/20 border-blue-500/40 text-blue-700 dark:text-blue-300", label: "App server (local)" },
              { color: "bg-violet-500/20 border-violet-500/40 text-violet-700 dark:text-violet-300", label: "GridWeave platform" },
              { color: "bg-emerald-500/20 border-emerald-500/40 text-emerald-700 dark:text-emerald-300", label: "Remote GPU worker" },
              { color: "bg-amber-500/20 border-amber-500/40 text-amber-700 dark:text-amber-300", label: "Garage S3 storage" },
            ].map(({ color, label }) => (
              <div key={label} className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px] font-medium ${color}`}>
                {label}
              </div>
            ))}
          </div>
        </CardContent>
      )}
    </Card>
  );
}

function ActiveFlowPanel({
  hasRun,
  status,
  bucket,
  prefix,
  vendor,
  vram,
  lastOp,
  flowTimings,
}: {
  hasRun: boolean;
  status: Status;
  bucket: string;
  prefix: string;
  vendor: AcceleratorVendor;
  vram: string;
  lastOp: LastOp | null;
  flowTimings?: FlowTimings | null;
}) {
  const [open, setOpen] = useState(true);
  if (!hasRun) return null;

  const meta = lastOp ? OP_META[lastOp] : OP_META.browse;
  const folderName = prefix
    ? (prefix.replace(/\/$/, "").split("/").pop() || prefix)
    : "(root)";
  const s3Path = bucket ? `s3://${bucket}/${prefix}` : "(not configured)";
  const isRunning = status === "running";

  const dispatch_ms =
    flowTimings?.job_ms != null && flowTimings?.s3_ms != null
      ? Math.max(0, flowTimings.job_ms - flowTimings.s3_ms)
      : undefined;

  return (
    <Card className="border-card-border" data-testid="card-active-flow">
      <CardHeader className="pb-2">
        <button
          className="flex w-full items-center justify-between text-left"
          onClick={() => setOpen((v) => !v)}
        >
          <CardTitle className="flex items-center gap-2 text-sm font-medium">
            <Workflow className="size-4 text-primary" />
            Active operation
            {lastOp && (
              <Badge variant="outline" className="ml-1 text-[10px]">
                {meta.title}
              </Badge>
            )}
            {isRunning && <Loader2 className="size-3 animate-spin text-primary" />}
          </CardTitle>
          <span className="text-[11px] text-muted-foreground">{open ? "Hide" : "Show"}</span>
        </button>

        {/* Live S3 path bar — always visible */}
        <div className="mt-2 flex items-center gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-1.5 text-[11px]">
          <Database className="size-3 shrink-0 text-amber-600 dark:text-amber-400" />
          <span className="flex-1 truncate font-mono text-foreground">{s3Path}</span>
          {isRunning && <Loader2 className="size-3 animate-spin text-primary shrink-0" />}
        </div>
      </CardHeader>

      {open && (
        <CardContent className="space-y-3 pt-1">
          {/* ── Request row (left → right) ────────────────────── */}
          <div className="space-y-1">
            <p className="text-[9px] font-semibold uppercase tracking-widest text-muted-foreground/60">Request ↓</p>
            <div className="flex items-center overflow-x-auto rounded-lg border border-border bg-muted/10 p-3">
              <div className="shrink-0">
                <FlowNode label="Browser" sublabel="GridWeave Inspector"
                  color="border-sky-500/40 bg-sky-500/5 text-sky-700 dark:text-sky-300"
                  icon={<Monitor className="size-5" />} />
              </div>
              <PipelineConnector label="HTTP" timing={flowTimings?.http_ms} />
              <div className="shrink-0">
                <FlowNode label="App Server" sublabel="Express / Node"
                  color="border-blue-500/40 bg-blue-500/5 text-blue-700 dark:text-blue-300"
                  icon={<Server className="size-5" />} />
              </div>
              <PipelineConnector label="GridWeave SDK" timing={flowTimings?.auth_ms} />
              <div className="shrink-0">
                <FlowNode label="GridWeave" sublabel={`${vendor} · ${vram}`}
                  color="border-violet-500/40 bg-violet-500/5 text-violet-700 dark:text-violet-300"
                  icon={<Sparkles className="size-5" />} />
              </div>
              <PipelineConnector label="dispatch" timing={dispatch_ms} />
              <div className="shrink-0">
                <FlowNode label="Remote Worker" sublabel={meta.workerDesc}
                  color="border-emerald-500/40 bg-emerald-500/5 text-emerald-700 dark:text-emerald-300"
                  icon={isRunning ? <Loader2 className="size-5 animate-spin" /> : <Cpu className="size-5" />} />
              </div>
              <PipelineConnector label={meta.s3Label} timing={flowTimings?.s3_ms} />
              <div className="shrink-0">
                <FlowNode label={folderName} sublabel={bucket ? `s3://${bucket}/` : "S3"}
                  color="border-amber-500/40 bg-amber-500/5 text-amber-700 dark:text-amber-300"
                  icon={<Database className="size-5" />} />
              </div>
            </div>
          </div>

          {/* ── Response row (right → left) ───────────────────── */}
          <div className="space-y-1">
            <p className="text-[9px] font-semibold uppercase tracking-widest text-muted-foreground/60">Response ↑</p>
            <div className="flex items-center overflow-x-auto rounded-lg border border-border bg-muted/10 p-3">
              <div className="shrink-0">
                <FlowNode label={meta.title} sublabel="GridWeave Inspector"
                  color="border-sky-500/40 bg-sky-500/5 text-sky-700 dark:text-sky-300"
                  icon={<Monitor className="size-5" />} />
              </div>
              <PipelineConnector label="HTTP response" timing={flowTimings?.http_ms} dir="left" />
              <div className="shrink-0">
                <FlowNode label="App Server" sublabel="JSON → browser"
                  color="border-blue-500/40 bg-blue-500/5 text-blue-700 dark:text-blue-300"
                  icon={<Server className="size-5" />} />
              </div>
              <PipelineConnector label="server total" timing={flowTimings?.total_ms} dir="left" />
              <div className="shrink-0">
                <FlowNode label="GridWeave" sublabel="job result"
                  color="border-violet-500/40 bg-violet-500/5 text-violet-700 dark:text-violet-300"
                  icon={<Sparkles className="size-5" />} />
              </div>
              <PipelineConnector label="worker job" timing={flowTimings?.job_ms} dir="left" />
              <div className="shrink-0">
                <FlowNode label="Remote Worker" sublabel="serialise result"
                  color="border-emerald-500/40 bg-emerald-500/5 text-emerald-700 dark:text-emerald-300"
                  icon={<Cpu className="size-5" />} />
              </div>
              <PipelineConnector label={meta.returnLabel} timing={flowTimings?.s3_ms} dir="left" />
              <div className="shrink-0">
                <FlowNode label={folderName} sublabel={bucket ? `s3://${bucket}/` : "S3"}
                  color="border-amber-500/40 bg-amber-500/5 text-amber-700 dark:text-amber-300"
                  icon={<Database className="size-5" />} />
              </div>
            </div>
          </div>

          {/* Status row */}
          <div className={`flex items-center gap-1.5 rounded-md border px-3 py-2 text-[11px] ${
            status === "success" ? "border-emerald-500/30 bg-emerald-500/5 text-emerald-700 dark:text-emerald-300" :
            status === "error"   ? "border-destructive/30 bg-destructive/5 text-destructive" :
            status === "running" ? "border-primary/30 bg-primary/5 text-primary" :
            "border-border bg-muted/30 text-muted-foreground"
          }`}>
            {status === "running" && <Loader2 className="size-3 animate-spin" />}
            {status === "success" && <CheckCircle2 className="size-3" />}
            {status === "error"   && <AlertCircle className="size-3" />}
            {status === "idle"    && <span className="inline-block size-1.5 rounded-full bg-current opacity-50" />}
            <span>
              {status === "running" && `${meta.title} running on remote worker…`}
              {status === "success" && `${meta.title} completed successfully.`}
              {status === "error"   && `${meta.title} failed — see error panel above.`}
              {status === "idle"    && lastOp && `Last: ${meta.title} · folder: ${s3Path}`}
            </span>
          </div>

          {/* Timing summary */}
          <div className="rounded-md border border-border bg-muted/20 px-4 py-3">
            <p className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
              Layer timings
            </p>
            <div className="flex flex-wrap gap-3">
              {[
                { label: "HTTP round-trip", value: flowTimings?.http_ms, color: "text-sky-600 dark:text-sky-400 border-sky-500/40 bg-sky-500/10" },
                { label: "SDK auth", value: flowTimings?.auth_ms, color: "text-violet-600 dark:text-violet-400 border-violet-500/40 bg-violet-500/10" },
                { label: "Worker job", value: flowTimings?.job_ms, color: "text-emerald-600 dark:text-emerald-400 border-emerald-500/40 bg-emerald-500/10" },
                { label: "S3 operation", value: flowTimings?.s3_ms, color: "text-amber-600 dark:text-amber-400 border-amber-500/40 bg-amber-500/10" },
                { label: "Server total", value: flowTimings?.total_ms, color: "text-blue-600 dark:text-blue-400 border-blue-500/40 bg-blue-500/10" },
              ].map(({ label, value, color }) => (
                <div key={label} className="flex flex-col items-center gap-1">
                  <span className="text-[10px] text-muted-foreground whitespace-nowrap">{label}</span>
                  {value != null ? (
                    <span className={`rounded-full border px-3 py-1 text-xs font-mono font-bold tabular-nums ${color}`}>
                      {fmtMs(value)}
                    </span>
                  ) : (
                    <span className="rounded-full border border-border bg-muted/40 px-3 py-1 text-xs font-mono text-muted-foreground/50 tabular-nums">
                      — ms
                    </span>
                  )}
                </div>
              ))}
            </div>
          </div>
        </CardContent>
      )}
    </Card>
  );
}

const IMAGE_RE = /\.(jpe?g|png|gif|webp|bmp|tiff?)$/i;

function FolderContents({
  prefix,
  enabled,
  thumbMap,
  thumbsLoading,
  onSelectImage,
}: {
  prefix: string;
  enabled: boolean;
  thumbMap: Record<string, { base64: string; mime: string }>;
  thumbsLoading: boolean;
  onSelectImage: (img: ImagePreview, thumb: { base64: string; mime: string } | undefined) => void;
}) {
  const [selectedObj, setSelectedObj] = useState<ObjectSampleRow | null>(null);

  const contentsQuery = useQuery<FolderContentsResponse>({
    queryKey: ["/api/garage-objects", prefix],
    enabled,
    queryFn: async () => {
      const res = await apiRequest("POST", "/api/garage-objects", { prefix });
      return res.json();
    },
    staleTime: 60 * 1000,
    retry: false,
  });

  const objects = contentsQuery.data?.objects ?? [];
  const imagePreviews = contentsQuery.data?.image_previews ?? [];

  if (!enabled) return null;

  return (
    <Card className="border-card-border" data-testid="card-folder-contents">
      <CardHeader className="flex-row items-center justify-between space-y-0 pb-3">
        <CardTitle className="flex items-center gap-2 text-sm font-medium">
          <Database className="size-4 text-primary" />
          Folder contents
          <span className="font-mono text-[11px] text-muted-foreground">
            {prefix || "(root)"}
          </span>
        </CardTitle>
        <div className="flex items-center gap-2">
          {contentsQuery.isFetching && <Loader2 className="size-3 animate-spin text-muted-foreground" />}
          <Badge variant="secondary" className="tabular-nums">{objects.length} objects</Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-4 p-0 pb-4">
        {/* Image strip */}
        {imagePreviews.length > 0 && (
          <div className="flex gap-2 overflow-x-auto px-5 pb-1">
            {imagePreviews.map((img, i) => {
              const thumb = img.base64 ? { base64: img.base64, mime: img.mime } : thumbMap[img.key];
              return (
                <button
                  key={img.key}
                  onClick={() => onSelectImage(img, thumb)}
                  className="group shrink-0 overflow-hidden rounded-md border border-border bg-muted transition hover:border-primary/60"
                  title={img.key}
                  data-testid={`button-fc-image-${i}`}
                >
                  {thumb ? (
                    <img
                      src={`data:${thumb.mime};base64,${thumb.base64}`}
                      alt={img.key}
                      className="h-20 w-20 object-cover transition group-hover:scale-[1.04]"
                    />
                  ) : (
                    <div className="flex h-20 w-20 items-center justify-center">
                      {thumbsLoading
                        ? <Loader2 className="size-5 animate-spin text-muted-foreground/40" />
                        : <ImageIcon className="size-6 text-muted-foreground/40" />}
                    </div>
                  )}
                </button>
              );
            })}
          </div>
        )}

        {/* Object table */}
        {contentsQuery.isLoading ? (
          <div className="flex items-center gap-2 px-5 text-xs text-muted-foreground">
            <Loader2 className="size-3 animate-spin" />
            Loading objects…
          </div>
        ) : objects.length > 0 ? (
          <div className="max-h-72 overflow-auto">
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
                {objects.map((row, i) => {
                  const isImg = IMAGE_RE.test(row.key);
                  return (
                    <TableRow
                      key={`${row.key}-${i}`}
                      className="cursor-pointer transition hover:bg-muted/50"
                      onClick={() => {
                        if (isImg) {
                          const img: ImagePreview = { key: row.key, mime: thumbMap[row.key]?.mime || "image/jpeg", base64: thumbMap[row.key]?.base64 };
                          onSelectImage(img, thumbMap[row.key] ?? undefined);
                        } else {
                          setSelectedObj(row);
                        }
                      }}
                      data-testid={`row-fc-object-${i}`}
                    >
                      <TableCell className="max-w-[28rem] truncate font-mono text-xs" title={row.key}>
                        <span className="flex items-center gap-1.5">
                          {isImg && <ImageIcon className="size-3 shrink-0 text-primary/60" />}
                          {row.key}
                        </span>
                      </TableCell>
                      <TableCell className="text-right font-mono text-xs tabular-nums">{formatBytes(Number(row.size))}</TableCell>
                      <TableCell className="font-mono text-xs text-muted-foreground">{row.last_modified ?? "—"}</TableCell>
                      <TableCell className="font-mono text-xs">{row.storage_class}</TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        ) : (
          <p className="px-5 text-xs text-muted-foreground" data-testid="text-fc-empty">
            {contentsQuery.data?.ok === false
              ? (contentsQuery.data.error?.message || "Could not load objects.")
              : "No objects in this folder."}
          </p>
        )}
      </CardContent>

      {/* Object detail dialog */}
      <Dialog open={Boolean(selectedObj)} onOpenChange={(open) => { if (!open) setSelectedObj(null); }}>
        <DialogContent data-testid="dialog-object-detail">
          <DialogHeader>
            <DialogTitle className="text-sm">Object details</DialogTitle>
            <DialogDescription className="break-all font-mono text-xs">{selectedObj?.key}</DialogDescription>
          </DialogHeader>
          {selectedObj && (
            <div className="space-y-2 text-xs">
              {[
                ["Key", selectedObj.key],
                ["Size", formatBytes(Number(selectedObj.size))],
                ["Last modified", selectedObj.last_modified ?? "—"],
                ["Storage class", selectedObj.storage_class],
              ].map(([label, value]) => (
                <div key={label} className="flex justify-between gap-4 border-b border-border pb-1.5 last:border-0">
                  <span className="text-muted-foreground">{label}</span>
                  <span className="break-all font-mono text-right">{value}</span>
                </div>
              ))}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </Card>
  );
}

function FolderBrowser({
  selectedPrefix,
  onSelect,
  enabled,
}: {
  selectedPrefix: string;
  onSelect: (prefix: string) => void;
  enabled: boolean;
}) {
  const subQuery = useQuery<GaragePrefixListResponse>({
    queryKey: ["/api/garage-prefixes/browse", selectedPrefix],
    enabled,
    queryFn: async () => {
      const res = await apiRequest("POST", "/api/garage-prefixes", {
        vendor: "NVIDIA",
        vram: "2GB",
        prefix: selectedPrefix,
      });
      return res.json();
    },
    staleTime: 60 * 1000,
    retry: false,
  });

  const subFolders = useMemo(() => {
    if (!subQuery.data?.ok) return [];
    return (subQuery.data.prefixes ?? []).filter((p) => p !== "" && p !== selectedPrefix);
  }, [subQuery.data, selectedPrefix]);

  const crumbs = useMemo(
    () => selectedPrefix.split("/").filter(Boolean),
    [selectedPrefix]
  );

  function crumbPrefix(index: number) {
    return crumbs.slice(0, index + 1).join("/") + "/";
  }

  if (!enabled) return null;

  return (
    <Card className="border-card-border" data-testid="card-folder-browser">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-sm font-medium">
          <FolderOpen className="size-4 text-primary" />
          Folder browser
        </CardTitle>
        <p className="text-xs leading-relaxed text-muted-foreground">
          Click a folder to navigate into it. The selected prefix updates automatically.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Breadcrumb trail */}
        <div className="flex flex-wrap items-center gap-1 rounded-md border border-border bg-muted/30 px-3 py-2 text-xs">
          <button
            onClick={() => onSelect("")}
            className="rounded px-1.5 py-0.5 text-primary hover:bg-muted transition-colors"
            data-testid="breadcrumb-root"
          >
            root
          </button>
          {crumbs.map((crumb, i) => (
            <Fragment key={crumbPrefix(i)}>
              <span className="text-muted-foreground">/</span>
              <button
                onClick={() => onSelect(crumbPrefix(i))}
                className={`rounded px-1.5 py-0.5 transition-colors hover:bg-muted ${
                  i === crumbs.length - 1
                    ? "font-medium text-foreground"
                    : "text-primary"
                }`}
                data-testid={`breadcrumb-${crumb}`}
              >
                {crumb}
              </button>
            </Fragment>
          ))}
        </div>

        {/* Sub-folder grid */}
        {subQuery.isLoading ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="size-3 animate-spin" />
            Loading sub-folders…
          </div>
        ) : subFolders.length > 0 ? (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
            {subFolders.map((folder) => {
              const name = folder.replace(selectedPrefix, "").replace(/\/$/, "");
              return (
                <button
                  key={folder}
                  onClick={() => { onSelect(folder); }}
                  className="flex items-center gap-2 rounded-md border border-border bg-muted/30 px-3 py-2 text-left text-xs transition hover:border-primary/60 hover:bg-muted"
                  data-testid={`button-folder-${name}`}
                >
                  <Folder className="size-3.5 shrink-0 text-primary" />
                  <span className="truncate font-mono">{name}/</span>
                </button>
              );
            })}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground" data-testid="text-no-subfolders">
            No sub-folders found in{" "}
            <span className="font-mono font-medium">{selectedPrefix || "root"}</span>.
          </p>
        )}

        {subQuery.data?.ok === false && (
          <p className="text-xs text-destructive" data-testid="text-folder-browser-error">
            {subQuery.data.error?.message || "Could not load sub-folders."}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

const VERSION_GROUPS: Array<{ label: string; keys: string[] }> = [
  { label: "Runtime", keys: ["node", "python", "gridweave-sdk"] },
  { label: "Frontend", keys: ["react", "vite", "typescript", "tailwindcss", "@tanstack/react-query", "wouter"] },
  { label: "Backend", keys: ["express", "@aws-sdk/client-s3", "drizzle-orm", "better-sqlite3", "zod"] },
  { label: "Worker Software", keys: ["boto3", "s3fs", "pandas", "Pillow", "ray", "cloudpickle", "httpx"] },
];

const VERSION_LABELS: Record<string, string> = {
  node: "Node.js",
  python: "Python",
  "gridweave-sdk": "GridWeave SDK",
  react: "React",
  vite: "Vite",
  typescript: "TypeScript",
  tailwindcss: "Tailwind CSS",
  "@tanstack/react-query": "TanStack Query",
  wouter: "Wouter",
  express: "Express",
  "@aws-sdk/client-s3": "AWS SDK S3",
  "drizzle-orm": "Drizzle ORM",
  "better-sqlite3": "SQLite",
  zod: "Zod",
  boto3: "boto3",
  s3fs: "s3fs",
  pandas: "pandas",
  Pillow: "Pillow (PIL)",
  ray: "Ray",
  cloudpickle: "cloudpickle",
  httpx: "httpx",
};

function VersionsPanel() {
  const { data, isLoading } = useQuery<Record<string, string>>({
    queryKey: ["/api/versions"],
    staleTime: Infinity,
  });

  return (
    <Card className="border-card-border" data-testid="card-versions">
      <CardHeader className="pb-2">
        <CardTitle className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          Software versions
        </CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="size-3 animate-spin" />
            Loading…
          </div>
        ) : (
          <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
            {VERSION_GROUPS.map((group) => (
              <div key={group.label}>
                <p className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/70">
                  {group.label}
                </p>
                <div className="space-y-1.5">
                  {group.keys.map((key) => (
                    <div key={key} className="flex items-center justify-between gap-2">
                      <span className="text-[11px] text-muted-foreground">
                        {VERSION_LABELS[key] ?? key}
                      </span>
                      <span className="font-mono text-[11px] text-foreground">
                        {data?.[key] ?? "—"}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function ImageCard({
  img,
  index,
  thumbData,
  batchLoading,
  onSelect,
}: {
  img: ImagePreview;
  index: number;
  thumbData?: { base64: string; mime: string };
  batchLoading: boolean;
  onSelect: (thumb: { base64: string; mime: string } | undefined) => void;
}) {
  const thumbSrc = thumbData ? `data:${thumbData.mime};base64,${thumbData.base64}` : null;
  const isLoading = batchLoading && !thumbData;

  return (
    <button
      type="button"
      onClick={() => onSelect(thumbData)}
      className="group overflow-hidden rounded-md border border-border bg-muted text-left transition hover:border-primary/60 hover:shadow-sm focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
      data-testid={`button-image-${index}`}
      aria-label={`Open larger preview for ${img.key}`}
    >
      <div className="aspect-square w-full overflow-hidden bg-muted">
        {thumbSrc ? (
          <img
            src={thumbSrc}
            alt={img.key}
            className="h-full w-full object-cover transition duration-200 group-hover:scale-[1.03]"
            data-testid={`img-preview-${index}`}
          />
        ) : isLoading ? (
          <div className="flex h-full items-center justify-center">
            <Loader2 className="size-5 animate-spin text-muted-foreground/40" />
          </div>
        ) : (
          <div className="flex h-full items-center justify-center">
            <ImageIcon className="size-8 text-muted-foreground/20" />
          </div>
        )}
      </div>
      <span
        className="block truncate px-2 py-1.5 font-mono text-[10px] text-muted-foreground"
        title={img.key}
        data-testid={`text-image-key-${index}`}
      >
        {img.key.split("/").pop()}
      </span>
    </button>
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
