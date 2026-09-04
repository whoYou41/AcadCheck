# AcadCheck production deployment

AcadCheck should be deployed as one same-origin application: Nginx terminates
HTTPS and proxies `/api/` to the Node backend, while the backend serves the
compiled Angular application. Answer sheets must never be exposed as a static
uploads directory.

## Minimum production target

- Node.js 20 or newer
- Python 3.10 or newer with `ml-training/requirements-runtime.txt`
- MySQL 8 or MariaDB equivalent
- 1 shared CPU and 2 GB RAM for one active scanner, with the one-vCPU limits
  below; use 2 CPU cores and 4 GB RAM for concurrent scanners
- Persistent storage for MySQL and `uploads/scans`
- HTTPS certificate and automated database backups

Measure scanner p95 latency and temperature on the actual target. Do not infer
Raspberry Pi performance from a development computer.

## Install

Use a non-root service account and deploy the repository to a fixed path such
as `/opt/acadcheck`.

```bash
cd /opt/acadcheck
npm ci
npm --prefix backend ci
python3 -m venv .scanner-venv
.scanner-venv/bin/pip install -r ml-training/requirements-runtime.txt
npm run build
```

Import `acadcheck_db.sql` into a dedicated MySQL database and grant the
application user access only to that database. The backend applies the files
in `backend/migrations/` during startup.

## Environment

Copy `backend/.env.example` to `backend/.env`, restrict it to the service
account, and configure at least:

```dotenv
NODE_ENV=production
PORT=3000
DB_HOST=127.0.0.1
DB_PORT=3306
DB_NAME=acadcheck_db
DB_USER=acadcheck_user
DB_PASSWORD=<unique database password>
JWT_SECRET=<at least 32 random characters>
OMR_PYTHON=/opt/acadcheck/.scanner-venv/bin/python
OMR_FAST_TIMEOUT_MS=8000
OMR_OPENCV_THREADS=1
OMR_MAX_PENDING_REQUESTS=2
TESSERACT_POOL_SIZE=1
PUBLIC_REGISTRATION=false
TRUST_PROXY=true
CORS_ORIGINS=
```

An empty `CORS_ORIGINS` is correct when Nginx serves the browser application
and API from the same origin. If a separate Capacitor/web origin is required,
list exact trusted origins separated by commas. Never use `*`.

## Private camera tunnel (required for hosted scanning)

The production browser calls the same-origin authenticated path
`/api/camera/*`. The Node backend then reaches the Raspberry Pi over a private
WireGuard or Tailscale address. This avoids HTTPS mixed-content failures and
keeps the unauthenticated Pi camera service off the public internet.

1. Join the Droplet and Raspberry Pi to the same private WireGuard/Tailscale
   network and confirm the Droplet can reach `http://<private-pi-ip>:5000/status`.
2. Bind or firewall port 5000 so it is reachable only through that private
   interface.
3. Set `PI_CAMERA_URL=http://<private-pi-ip>:5000` in `backend/.env`.
4. Set `REQUIRE_PI_CAMERA=true` so deployment preflight proves both
   `/status` and a real 1440px capture can cross the tunnel.
5. Leave the scanner page on `/api/camera`; do not enter the Pi address in a
   production browser.

The camera sends a 1440-pixel-wide quality-92 capture through the tunnel. That
resolution preserves the tested OMR grid while avoiding repeated 4K JPEG
transfers. Concurrent preview/detection requests share the same in-flight
capture, preventing tunnel queues from making a one-vCPU Droplet lag.

These scanner limits are required when Node, MySQL, phpMyAdmin/PHP-FPM, and the
scanner worker share a one-vCPU/2 GB Droplet. They prevent OpenCV and OCR from
oversubscribing the CPU and reject stale excess camera frames instead of
building a delay-producing queue. Keep only one scanner session active on this
plan. The worker is prewarmed at startup, so do not route traffic until
`/api/ready` returns HTTP 200.

For a new empty database, temporarily configure a random
`BOOTSTRAP_ADMIN_TOKEN` of at least 24 characters and create the first account
as documented in `README.md`. Remove the token afterward.

## Required preflight

```bash
cd /opt/acadcheck
npm run verify:deploy
npm --prefix backend audit --omit=dev
npm audit --omit=dev
```

Do not start accepting examination traffic unless every command succeeds.

## Nginx

```nginx
server {
    listen 443 ssl http2;
    server_name acadcheck.example.edu;

    ssl_certificate /etc/letsencrypt/live/acadcheck.example.edu/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/acadcheck.example.edu/privkey.pem;

    client_max_body_size 15m;

    location /api/ {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 190s;
        proxy_buffering off;
    }

    # The Node service owns frontend routing and authenticated image access.
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}

server {
    listen 80;
    server_name acadcheck.example.edu;
    return 301 https://$host$request_uri;
}
```

Do not add an Nginx `location /uploads/`; those files contain student data.

## Service readiness

Run the backend under systemd, PM2, or another service manager that sends
`SIGTERM` and waits at least 10 seconds. Monitor:

- `GET /api/health` for process liveness
- `GET /api/ready` for database, migrations, and scanner-worker readiness

The backend fails startup when its secret is weak, Python/OpenCV is missing,
migrations fail, or the OMR worker cannot prewarm.

## Final release checklist

- Production preflight returns `success: true`.
- Frontend and backend production audits report zero vulnerabilities.
- `npm run test:ci` and `npm --prefix backend run test:scanner` pass.
- The full OMR benchmarks pass on the deployment device.
- A labeled field set from the real cameras/printers reaches the approved
  exact-sheet accuracy and rescan-rate targets.
- `/uploads/...` returns 404 without authentication.
- Public registration returns 403 after bootstrap.
- `/api/ready` returns 200 through HTTPS.
- Database backup and restore have been tested.
