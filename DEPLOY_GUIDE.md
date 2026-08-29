# AcadCheck production deployment

AcadCheck should be deployed as one same-origin application: Nginx terminates
HTTPS and proxies `/api/` to the Node backend, while the backend serves the
compiled Angular application. Answer sheets must never be exposed as a static
uploads directory.

## Minimum production target

- Node.js 20 or newer
- Python 3.10 or newer with `ml-training/requirements-runtime.txt`
- MySQL 8 or MariaDB equivalent
- 2 CPU cores and 4 GB RAM as a starting point
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
QR_PYTHON=/opt/acadcheck/.scanner-venv/bin/python
PUBLIC_REGISTRATION=false
TRUST_PROXY=true
CORS_ORIGINS=
```

An empty `CORS_ORIGINS` is correct when Nginx serves the browser application
and API from the same origin. If a separate Capacitor/web origin is required,
list exact trusted origins separated by commas. Never use `*`.

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
migrations fail, or OMR/QR workers cannot prewarm.

## Final release checklist

- Production preflight returns `success: true`.
- Frontend and backend production audits report zero vulnerabilities.
- `npm run test:ci` and `npm --prefix backend run test:scanner` pass.
- The full OMR and combined QR/OMR benchmarks pass on the deployment device.
- A labeled field set from the real cameras/printers reaches the approved
  exact-sheet accuracy and rescan-rate targets.
- `/uploads/...` returns 404 without authentication.
- Public registration returns 403 after bootstrap.
- `/api/ready` returns 200 through HTTPS.
- Database backup and restore have been tested.
