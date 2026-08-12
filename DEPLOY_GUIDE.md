# AcadCheck - DigitalOcean Deployment Guide

## Overview

This project has **two parts** that need to be deployed:

1. **Frontend**: Angular/Ionic app (already built in `www/`)
2. **Backend API**: Node.js/Express server (in `backend/`)

For DigitalOcean, the best approach is to use a **Droplet (VPS)** where you run both the backend API and serve the frontend.

---

## What to Upload via FileZilla

### Connection Details (via FileZilla)
- **Host**: Your Droplet's IP address
- **Username**: `root` (or your sudo user)
- **Password**: Your Droplet root password
- **Port**: 22

### Files to Upload

#### 1. Backend Folder (`backend/`)
Upload the **entire** `backend` folder to your Droplet:

```
backend/
├── server.js              # Main server file
├── package.json           # Dependencies
├── enhanced-scanner.js    # Scanner modules
├── adaptive-form-omr.js
├── perspective-corrector.js
├── exam-sheet-detector.js
├── qr-code-detector.js
├── sequence-detector.js
├── answer-sheet-generator.js
├── onnx-scanner-service.js
├── scanner-trainer.js
├── reference-grid-register.js
├── bubble-calibration.json
├── scan-calibration.json
├── omr/                   # OMR processing files
├── models/                # ONNX models
├── migrations/            # Database migrations
├── templates/             # Templates
├── bubble-model/          # ML bubble models
└── .env                   # Environment variables (CREATE THIS ON SERVER)
```

#### 2. Frontend Build (`www/`)
Upload the pre-built `www` folder:

```
www/
├── index.html
├── main-G7LL6OJG.js
├── polyfills-TDCRLYKL.js
├── styles-YIEB5COJ.css
├── prerendered-routes.json
├── *.js (all chunk files)
└── assets/
    ├── shapes.svg
    └── icon/favicon.png
```

---

## Server Setup (After Uploading Files)

### 1. SSH into your Droplet

Use Terminal/PuTTY or FileZilla's ability to open a terminal.

### 2. Install Node.js (v18 or higher)

```bash
curl -fsSL https://deb.nodesource.com/setup_18.x | bash -
apt-get install -y nodejs
node --version   # Should be 18.x or higher
```

### 3. Navigate to your app directory

```bash
cd /root/acadcheck   # or wherever you uploaded files to
```

### 4. Install Backend Dependencies

```bash
cd backend
npm install
```

### 5. Install PM2 (Process Manager)

```bash
npm install -g pm2
```

### 6. Set Up MySQL Database

```bash
apt-get install mysql-server -y
mysql_secure_installation
```

Then create the database:

```bash
mysql -u root -p
```

```sql
CREATE DATABASE acadcheck_db;
CREATE USER 'acadcheck_user'@'localhost' IDENTIFIED BY 'your-strong-password';
GRANT ALL PRIVILEGES ON acadcheck_db.* TO 'acadcheck_user'@'localhost';
FLUSH PRIVILEGES;
EXIT;
```

Import the schema:

```bash
mysql -u root -p acadcheck_db < /root/acadcheck/acadcheck_db.sql
```

### 7. Create Backend `.env` File

In `backend/.env`, add:

```
PORT=3000
DB_HOST=localhost
DB_USER=acadcheck_user
DB_PASSWORD=your-strong-password
DB_NAME=acadcheck_db
JWT_SECRET=generate-a-random-secret-string-here
```

### 8. Install Nginx (Reverse Proxy)

```bash
apt-get install nginx -y
```

Create Nginx config `/etc/nginx/sites-available/acadcheck`:

```nginx
server {
    listen 80;
    server_name your_domain_or_ip;

    # Serve frontend
    root /root/acadcheck/www;
    index index.html;

    # API proxy to Node.js backend
    location /api/ {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
        client_max_body_size 100M;
    }

    # Uploads
    location /uploads/ {
        proxy_pass http://127.0.0.1:3000/uploads/;
        proxy_set_header Host $host;
        client_max_body_size 100M;
    }

    # Frontend fallback (for Angular routing)
    location / {
        try_files $uri $uri/ /index.html;
    }
}
```

Enable the site:

```bash
ln -s /etc/nginx/sites-available/acadcheck /etc/nginx/sites-enabled/
nginx -t
systemctl restart nginx
```

### 9. Start Backend with PM2

```bash
cd /root/acadcheck/backend
pm2 start server.js --name acadcheck-backend
pm2 save
pm2 startup
```

### 10. Configure Firewall

```bash
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp  # For SSL later
ufw enable
```

---

## Optional: Add SSL/HTTPS (Recommended)

```bash
apt-get install certbot python3-certbot-nginx -y
certbot --nginx -d your_domain.com
```

---

## Summary Checklist

| Item | Details |
|------|---------|
| **Upload via FileZilla** | `backend/` folder + `www/` folder |
| **Do NOT upload** | `node_modules/`, `android/`, `.angular/`, `.git/` |
| **Server OS** | Ubuntu 20.04+ or 22.04+ on DigitalOcean Droplet |
| **Min Spec** | 1 GB RAM, 1 vCPU, 25 GB SSD ($6/mo Droplet) |
| **Rec. Spec** | 2 GB RAM, 2 vCPU ($12/mo Droplet) for production |
| **Node.js** | v18+ |
| **Database** | MySQL 8.0+ |
| **Process Manager** | PM2 |
| **Reverse Proxy** | Nginx |