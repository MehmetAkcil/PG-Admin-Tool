# pg-admin-tool

A small, self-hosted **PostgreSQL admin UI** built with **Express**, **`pg`**, and plain **HTML / CSS / JavaScript**. No build step, no database for storing credentials—connection strings are kept in memory for the browser session only.

> **Türkçe:** Tek dosyalı Express sunucusu ve statik arayüz ile çalışan, bağlantı bilgisini sunucuda saklamayan hafif bir PostgreSQL yönetim aracıdır. Yedekleme için makinede `pg_dump` / `psql` bulunmalıdır.

---

## Features

- **Connection** — Paste a PostgreSQL URL (`postgresql://user:pass@host:port/dbname` or without `/dbname` to pick a database first).
- **Databases** — List, enter, create, copy (`CREATE DATABASE … WITH TEMPLATE`), and drop (with session termination where needed).
- **Tables** — Browse, multi-select **TRUNCATE** / **DROP** with **CASCADE** or **RESTRICT**.
- **SQL** — Run arbitrary statements against the selected database.
- **Data** — Load rows (limit), **INSERT** / **UPDATE** / **DELETE** via JSON + primary key detection.
- **Backup & restore** — Stream **`pg_dump`** download and **`psql -f`** restore (requires PostgreSQL client tools on the machine running the server).
- **UI** — Tabbed workspace, toasts, and modals (no heavy framework).

---

## Prerequisites

- **Node.js** 18+ recommended  
- A running **PostgreSQL** server you are allowed to manage  
- For backup/restore buttons: **`pg_dump`** and **`psql`** on the server’s **PATH**, **or** set **`PG_BIN`** (or **`PGDIR`**) to the PostgreSQL `bin` directory (e.g. `C:\Program Files\PostgreSQL\16\bin` on Windows).

---

## Quick start

```bash
git clone <your-repo-url>
cd pg-admin-tool
npm install
cp .env.example .env   # optional (Windows CMD: copy .env.example .env)
npm start
```

Open **http://localhost:3840** (or set `PORT` in `.env` or the environment).

```bash
# Custom port (bash), without .env
PORT=3000 npm start

# Windows PowerShell
$env:PORT=3000; npm start
```

### Development

Uses **nodemon** to restart the server when `server.js` changes:

```bash
npm run dev
```

---

## Configuration

Environment variables are read from the process environment. If a **`.env`** file exists in the project root, it is loaded automatically via **[dotenv](https://github.com/motdotla/dotenv)** (safe to omit in production if you inject vars another way). Copy **`.env.example`** to **`.env`** and adjust.

| Variable | Description |
|----------|-------------|
| `PORT` | HTTP port (default **3840**) |
| `PG_BIN` / `PGDIR` | Directory containing `pg_dump` and `psql` if they are not on `PATH` |
| `NODE_ENV` | e.g. `development` / `production` (optional) |

On Windows, the server also tries common install paths under `Program Files\PostgreSQL\<version>\bin` when resolving binaries.

---

## Security

This tool is meant for **trusted networks** (local dev, VPN, private admin hosts). It:

- Sends the connection string to the backend on each request (base64 header) and does **not** persist it server-side by design.
- Can execute **destructive** operations (drop database/table, truncate, raw SQL).

**Do not** expose it to the public internet without authentication, HTTPS, and network restrictions. Prefer SSH tunnels or a reverse proxy with strong access control.

---

## Tech stack

- **Express** — HTTP API + static files  
- **pg** — PostgreSQL driver  
- **multer** — SQL file upload for restore  
- **dotenv** — optional `.env` loading for local config  
- **nodemon** (dev) — auto-restart on server file changes  

---

## License

[MIT](LICENSE) — use at your own risk; always test backups and destructive actions on non-production systems first.

---

## Contributing

Issues and pull requests are welcome. Keep changes focused and match the existing plain-JS / minimal-dependency style unless there is a strong reason to add tooling.
