# GridWeave Inspector

A small full-stack web app that wraps a notebook-style **GridWeave + Garage S3 + GPU readiness check** in a friendly dashboard.

- **Frontend:** React + TypeScript + Tailwind + shadcn/ui
- **Backend:** Express (TypeScript) — single endpoint that spawns a Python worker
- **Worker:** Python script using the `gridweave` SDK, `boto3`, `ray.data`, and `pandas`

The UI shows a clear status pill (`idle` / `running` / `success` / `error`), summary cards (GPU info, `CUDA_VISIBLE_DEVICES`, Garage endpoint, bucket/prefix, object & image counts, pandas version), a scrollable run-log panel, an image gallery rendered from base64 data URLs, and a sortable object-sample table.

---

## Configuration — environment variables

**Never hard-code secrets.** All sensitive values come from the environment. See `.env.example` for the full list:

| Variable                  | Required | Notes                                                              |
| ------------------------- | -------- | ------------------------------------------------------------------ |
| `GRIDWEAVE_TOKEN`         | yes      | JWT for `gridweave.authenticate`                                   |
| `GRIDWEAVE_PLATFORM_URL`  | no       | Defaults to `https://platform.gridweave.ai`                        |
| `GARAGE_ENDPOINT_URL`     | yes      | S3-compatible Garage endpoint                                      |
| `GARAGE_BUCKET`           | yes      | Bucket to list                                                     |
| `GARAGE_PREFIX`           | no       | Defaults to `""` (whole bucket)                                    |
| `GARAGE_ACCESS_KEY`       | yes      | S3 access key                                                      |
| `GARAGE_SECRET_KEY`       | yes      | S3 secret key                                                      |
| `GARAGE_REGION`           | no       | Defaults to `garage`                                               |
| `PYTHON_BIN`              | no       | Python interpreter with `gridweave`, `ray`, `boto3`, `pandas`      |
| `GRIDWEAVE_DEMO`          | no       | Set to `1` to force demo mode regardless of which endpoint is hit  |

Copy `.env.example` to `.env` and fill in real values. `.env` is git-ignored.

---

## Run locally

```bash
npm install
cp .env.example .env   # fill in real values
npm run dev            # http://localhost:5000
```

The dev server runs Express + Vite on the same port.

### Production build

```bash
npm run build          # builds client into dist/public and bundles server to dist/index.cjs
npm start              # NODE_ENV=production node dist/index.cjs
```

The build copies `server/python/` into `dist/python/` so the spawned worker still resolves at runtime.

---

## API

| Method | Path                                | Purpose                                                                     |
| ------ | ----------------------------------- | --------------------------------------------------------------------------- |
| POST   | `/api/run-gridweave-check`          | Run the real check using env vars. Always returns 200 with structured JSON. |
| POST   | `/api/run-gridweave-check/demo`     | Run the no-secret demo fallback that returns synthetic data + tiny PNGs.    |
| GET    | `/api/gridweave-config`             | Returns booleans for which env vars are set + non-secret values.            |

Response shape (success):
```jsonc
{
  "ok": true,
  "demo": false,
  "startedAt": "...",
  "finishedAt": "...",
  "elapsedMs": 1234,
  "result": {
    "output_text": "nvidia-smi -L: ...",
    "objects_sample": [{ "key": "...", "size": 0, "last_modified": "...", "storage_class": "STANDARD" }],
    "image_previews": [{ "key": "...", "mime": "image/png", "base64": "..." }]
  }
}
```

Response shape (error — also returned with HTTP 200 so the UI can render it):
```jsonc
{
  "ok": false,
  "startedAt": "...",
  "finishedAt": "...",
  "elapsedMs": 12,
  "error": { "code": "missing_env" | "sdk_missing" | "auth_failed" | "remote_failed" | ..., "message": "..." }
}
```

---

## Behavior preserved from the source notebook

The Python worker (`server/python/gridweave_check.py`) reproduces the original flow:

1. `gridweave.authenticate(token=..., platform_url=...)`
2. Define `multi_gpu_check` decorated with `@gridweave.remote(vram="2GB")`
3. Inside the remote: disable Ray progress bars, run `nvidia-smi -L`, log `CUDA_VISIBLE_DEVICES` and `pandas.__version__`
4. List S3 objects under `GARAGE_PREFIX` (paginated)
5. Convert the first 20 entries to a pandas DataFrame via `ray.data.from_items(...).to_pandas()`
6. Download up to 6 image-like objects and base64-encode them
7. Return `{ output_text, objects_sample, image_previews }`

If the SDK isn't installed or required env vars are missing, the worker exits with a structured `ok: false` error which the UI surfaces in a clear error card.

---

## Limitations

- The deployed preview cannot make real GridWeave calls without the user's JWT and S3 credentials. The "Run demo" button calls a fallback endpoint that returns synthetic objects and small generated PNGs so the UI demonstrates the full layout without secrets.
- The worker requires a Python interpreter that has `gridweave`, `ray`, `boto3`, and `pandas` installed. Set `PYTHON_BIN` if it isn't on `PATH`.
- The app does not persist run history. Each invocation is independent; no DB is used.
- Browser storage (`localStorage`, `sessionStorage`, cookies) is **not** used — required for the sandboxed deployment target.

---

## Test IDs (for automation)

Key elements expose `data-testid`:

- `button-run-check`, `button-run-demo`, `button-toggle-theme`
- `status-idle`, `status-running`, `status-success`, `status-error`
- `text-friendly-status`, `text-started-at`, `text-elapsed`, `text-output-log`, `text-error-message`
- `text-gpu-info`, `text-cuda`, `text-endpoint`, `text-bucket-prefix`, `text-counts`, `text-pandas`
- `card-config`, `card-error`, `card-output`, `card-gallery`, `card-objects`
- `figure-image-${i}`, `img-preview-${i}`, `text-image-key-${i}`
- `row-object-${i}`, `badge-image-count`, `badge-object-count`
