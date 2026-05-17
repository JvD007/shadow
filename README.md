# GridWeave Inspector

A small full-stack web app that wraps **GridWeave + Garage S3 worker operations** in a friendly dashboard. The app can upload files, create folder marker objects, list prefixes, and run the original GPU/storage/image readiness check.

- **Frontend:** React + TypeScript + Tailwind + shadcn/ui
- **Backend:** Express (TypeScript) — API endpoints that spawn Python helpers
- **Worker:** Python scripts using the `gridweave` SDK and `boto3`; all Garage/S3 reads and writes happen inside GridWeave remote workers

The UI shows a clear status pill (`idle` / `running` / `success` / `error`), worker controls for accelerator vendor and VRAM, a `GARAGE_PREFIX` dropdown populated by a worker-side prefix listing job, upload and folder creation panels, summary cards, a scrollable run-log panel, an image gallery rendered from base64 data URLs, and an object-sample table.

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
| `GARAGE_IMAGE_PREVIEW_LIMIT` | no    | Defaults to `0` meaning all image previews. Set a positive number to cap returned previews. |
| `PYTHON_BIN`              | no       | Python interpreter with `gridweave`, `ray`, `boto3`, `pandas`      |
| `GRIDWEAVE_DEMO`          | no       | Deprecated. Use the `/api/run-gridweave-check/demo` endpoint or the Run demo button for demo mode. |

Copy `.env.example` to `.env` and fill in real values. `.env` is git-ignored.

---

## Quick start — `start.sh`

The easiest way to get running. Works on Linux and macOS with Node.js 18+ and Python 3.10+ already installed.

```bash
bash start.sh
```

On first run it will:

1. Check Node.js and Python versions
2. Copy `.env.example` → `.env` if no `.env` exists (edit it before running real checks)
3. Run `npm install` if `node_modules/` is missing
4. Create a `.venv/` Python virtual environment and install `boto3`, `s3fs`, `pandas`, `Pillow`, and the GridWeave SDK wheel (if the `.whl` is present in the project root)
5. Build the production bundle if `dist/` is missing
6. Start the server at `http://localhost:5000`

Re-running `start.sh` is safe — setup steps are skipped once already done.

### Flags

| Flag | Behaviour |
|------|-----------|
| *(none)* | Auto mode — build if needed, then start production |
| `--dev` | Development mode with hot-reload (tsx + Vite) |
| `--build` | Force a fresh production build, then start |

```bash
bash start.sh --dev    # hot-reload during development
bash start.sh --build  # force rebuild then start production
```

---

## Linux service (Ubuntu 24.04)

Run GridWeave Inspector as a `systemd` service that starts automatically on boot.

### Prerequisites

- Ubuntu 24.04 (tested) — other Debian-based distros may work
- `sudo` / root access
- The GridWeave SDK `.whl` file in the project root (optional but recommended)

### Install

Run the installer from the project root:

```bash
sudo bash install/install.sh
```

The script is safe to re-run — it upgrades in-place. It will:

1. Install Node.js 20 LTS and Python 3 via `apt`
2. Create a dedicated `gridweave` system user
3. Copy the application to `/opt/gridweave-inspector/`
4. Build the production bundle (`npm run build`)
5. Create a Python venv at `/opt/gridweave-inspector/venv/` with `boto3`, `s3fs`, `pandas`, `Pillow`, and the GridWeave SDK
6. Write a config file at `/etc/gridweave-inspector/app.env`
7. Install and start `gridweave-inspector.service` via systemd

### Configure

Edit the config file with your real credentials:

```bash
sudo nano /etc/gridweave-inspector/app.env
```

```ini
GRIDWEAVE_TOKEN=your_jwt_here
GRIDWEAVE_PLATFORM_URL=https://platform.gridweave.ai

GARAGE_ENDPOINT_URL=https://garage.example.com
GARAGE_BUCKET=your-bucket
GARAGE_PREFIX=your/prefix/
GARAGE_ACCESS_KEY=your_access_key
GARAGE_SECRET_KEY=your_secret_key
GARAGE_REGION=garage
```

Then restart the service to apply:

```bash
sudo systemctl restart gridweave-inspector
```

### Installed paths

| Path | Purpose |
|------|---------|
| `/opt/gridweave-inspector/` | Application files |
| `/opt/gridweave-inspector/venv/` | Python virtual environment |
| `/opt/gridweave-inspector/dist/` | Production bundle |
| `/etc/gridweave-inspector/app.env` | Runtime config / secrets |
| `/etc/systemd/system/gridweave-inspector.service` | systemd unit file |

### Service management

```bash
# Check status
sudo systemctl status gridweave-inspector

# Live logs
sudo journalctl -u gridweave-inspector -f

# Start / stop / restart
sudo systemctl start gridweave-inspector
sudo systemctl stop gridweave-inspector
sudo systemctl restart gridweave-inspector

# Enable / disable auto-start on boot
sudo systemctl enable gridweave-inspector
sudo systemctl disable gridweave-inspector
```

The app listens on port **5000** by default. Change `PORT=` in `/etc/gridweave-inspector/app.env` to use a different port.

### Upgrade

Pull the latest source and re-run the installer:

```bash
git pull
sudo bash install/install.sh
```

### Uninstall

```bash
sudo bash install/uninstall.sh
```

Prompts before deleting credentials. Removes the service, app files, system user, and optionally the config directory.

---

## Run locally (manual)

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
| POST   | `/api/garage-prefixes`              | Submits a GridWeave worker job that lists folder-like S3 prefixes for the `GARAGE_PREFIX` dropdown. |
| POST   | `/api/garage-create-folder`         | Submits a GridWeave worker job that creates a zero-byte folder marker object ending in `/`. |
| POST   | `/api/garage-upload`                | Submits a GridWeave worker job that uploads file payloads to the selected bucket/prefix. |
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
2. Define `multi_gpu_check` decorated with the selected `@gridweave.remote(vram=..., vendor=...)`
3. Inside the remote: disable Ray progress bars, run `nvidia-smi -L`, and log server / pandas details
4. List S3 objects under the selected `GARAGE_PREFIX` (paginated)
5. Return the first 20 normalized entries as the object sample
6. Download image-like objects and base64-encode them. By default all images are returned; set `GARAGE_IMAGE_PREVIEW_LIMIT` to cap this.
7. Return `{ output_text, objects_sample, image_previews }`

If the SDK isn't installed or required env vars are missing, the worker exits with a structured `ok: false` error which the UI surfaces in a clear error card.

Prefix discovery also goes through GridWeave: the local app server does not query Garage/S3 directly. The UI posts the selected `vendor` and `vram` to `/api/garage-prefixes`, the backend starts `server/python/garage_prefixes.py`, and that script runs the S3 prefix listing inside `@gridweave.remote(...)`.

Uploads and folder creation follow the same rule. The browser sends file bytes or the requested folder name to the local API, the backend starts `server/python/garage_write.py`, and only the GridWeave remote worker calls `boto3.put_object`. The local server never creates S3 clients and never writes directly to Garage.

---

## Limitations

- The deployed preview cannot make real GridWeave calls without the user's JWT and S3 credentials. The "Run demo" button calls a fallback endpoint that returns synthetic objects and small generated PNGs so the UI demonstrates the full layout without secrets.
- The worker requires a Python interpreter that has `gridweave`, `boto3`, and `pandas` installed. Set `PYTHON_BIN` if it isn't on `PATH`.
- The upload UI sends files through JSON as base64 payloads and enforces a 25 MB per-file worker request limit, with up to 10 files per upload job.
- Returning all image previews can create a large JSON response if the selected folder contains many large images. Use `GARAGE_IMAGE_PREVIEW_LIMIT` if you need a cap.
- The app does not persist run history. Each invocation is independent; no DB is used.
- Browser storage (`localStorage`, `sessionStorage`, cookies) is **not** used — required for the sandboxed deployment target.

---

## Test IDs (for automation)

Key elements expose `data-testid`:

- `button-run-check`, `button-run-demo`, `button-toggle-theme`, `button-upload-files`, `button-create-folder`, `button-clear-files`
- `input-upload-files`, `input-folder-name`, `select-vendor`, `select-garage-prefix`
- `status-idle`, `status-running`, `status-success`, `status-error`
- `text-friendly-status`, `text-started-at`, `text-elapsed`, `text-output-log`, `text-error-message`
- `text-gpu-info`, `text-endpoint`, `text-bucket-prefix`, `text-counts`, `text-pandas`
- `card-config`, `card-error`, `card-output`, `card-gallery`, `card-objects`, `card-worker-upload`, `card-worker-folder`, `card-write-result`
- `button-image-${i}`, `img-preview-${i}`, `text-image-key-${i}`, `dialog-image-preview`
- `scroll-image-gallery`
- `row-object-${i}`, `badge-image-count`, `badge-object-count`
