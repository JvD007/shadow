// Shared types between client and server for GridWeave Inspector.
// No persisted DB models — the check is stateless and run on demand.

export interface ObjectSampleRow {
  key: string;
  size: number;
  last_modified: string | null;
  storage_class: string;
}

export interface ImagePreview {
  key: string;
  mime: string;
  base64?: string;      // absent for real checks; present in demo mode
  thumbnail?: boolean;
}

export interface GarageImageResponse {
  ok: true;
  key: string;
  mime: string;
  base64: string;
}

export interface GarageImageError {
  ok: false;
  error: { code: string; message: string };
}

export interface ServerInfo {
  model: string;
  cpu_cores: number;
  memory_gb: number;
}

export type AcceleratorVendor = "NVIDIA" | "AMD" | "Axelera" | "Lumai";

export interface JobConfig {
  vendor: AcceleratorVendor;
  vram: string;
  prefix?: string;
}

export interface GaragePrefixListResponse {
  ok: boolean;
  prefixes: string[];
  bucket?: string;
  error?: { code: string; message: string };
}

export interface FolderContentsResponse {
  ok: boolean;
  bucket?: string;
  prefix?: string;
  objects: ObjectSampleRow[];
  image_previews: ImagePreview[];
  error?: { code: string; message: string };
}

export interface GarageWriteObjectResult {
  key: string;
  size: number;
  content_type?: string;
  etag?: string;
}

export interface GarageWriteSuccess {
  ok: true;
  action: "create_folder" | "upload_files";
  bucket: string;
  prefix: string;
  objects: GarageWriteObjectResult[];
  message: string;
}

export interface GarageWriteError {
  ok: false;
  action?: "create_folder" | "upload_files";
  error: { code: string; message: string };
}

export type GarageWriteResponse = GarageWriteSuccess | GarageWriteError;

export interface GridWeaveResult {
  output_text: string;
  objects_sample: ObjectSampleRow[];
  image_previews: ImagePreview[];
  server_info?: ServerInfo;
  job_config?: JobConfig;
}

export interface RunCheckSuccess {
  ok: true;
  demo?: boolean;
  startedAt: string;
  finishedAt: string;
  elapsedMs: number;
  result: GridWeaveResult;
}

export interface RunCheckError {
  ok: false;
  startedAt: string;
  finishedAt: string;
  elapsedMs: number;
  error: { code: string; message: string };
}

export type RunCheckResponse = RunCheckSuccess | RunCheckError;
