# GridWeave Inspector — Ubuntu 24.04 Install Kit

Fully automated install/uninstall for running GridWeave Inspector as a
`systemd` service on Ubuntu 24.04.

---

## Quick start

```bash
# Clone / copy the project to the server, then:
cd gridweave-s3-browser
sudo bash install/install.sh
```

The script is safe to re-run — it upgrades in-place.

---

## What gets installed

| Path | Purpose |
|------|---------|
| `/opt/gridweave-inspector/` | Application files + Python venv |
| `/opt/gridweave-inspector/venv/` | Python virtual env (boto3, s3fs, pandas, gridweave SDK) |
| `/opt/gridweave-inspector/dist/` | Built production bundle |
| `/etc/gridweave-inspector/app.env` | **Runtime secrets / config** |
| `/etc/systemd/system/gridweave-inspector.service` | systemd unit |

A dedicated system user `gridweave` owns all application files.

---

## Configuration

Edit `/etc/gridweave-inspector/app.env` and fill in your real values:

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

After editing:

```bash
sudo systemctl restart gridweave-inspector
```

---

## Service management

```bash
# Status
sudo systemctl status gridweave-inspector

# Live logs
sudo journalctl -u gridweave-inspector -f

# Start / stop / restart
sudo systemctl start gridweave-inspector
sudo systemctl stop gridweave-inspector
sudo systemctl restart gridweave-inspector

# Disable auto-start on boot
sudo systemctl disable gridweave-inspector
```

---

## Upgrading

Pull the new source onto the server and re-run the installer:

```bash
git pull
sudo bash install/install.sh
```

---

## Uninstall

```bash
sudo bash install/uninstall.sh
```

Prompts before deleting credentials — app directory is removed automatically.

---

## Port / firewall

The server listens on port **5000** by default.  Change `PORT=` in
`/etc/gridweave-inspector/app.env` to use another port.

To expose via UFW:

```bash
sudo ufw allow 5000/tcp comment "GridWeave Inspector"
```

Or put Nginx in front as a reverse proxy (recommended for HTTPS):

```nginx
server {
    listen 80;
    server_name inspector.example.com;

    location / {
        proxy_pass http://127.0.0.1:5000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_cache_bypass $http_upgrade;
    }
}
```

---

## Python SDK

The install script automatically installs the `gridweave_sdk-*.whl` wheel
found in the project root.  To install a newer version later:

```bash
sudo /opt/gridweave-inspector/venv/bin/pip install gridweave_sdk-X.Y.Z-py3-none-any.whl
sudo systemctl restart gridweave-inspector
```
