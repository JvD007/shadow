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
  base64: string;
}

export interface GridWeaveResult {
  output_text: string;
  objects_sample: ObjectSampleRow[];
  image_previews: ImagePreview[];
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
