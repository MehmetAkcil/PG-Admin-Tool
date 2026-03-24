require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const multer = require('multer');
const { Pool, Client } = require('pg');

const app = express();
const PORT = process.env.PORT || 3840;

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({ dest: os.tmpdir(), limits: { fileSize: 512 * 1024 * 1024 } });

function decodeConnectionHeader(req) {
  const raw = req.headers['x-connection-string'];
  if (!raw || typeof raw !== 'string') return null;
  try {
    return Buffer.from(raw, 'base64').toString('utf8');
  } catch {
    try {
      return Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    } catch {
      return null;
    }
  }
}

function parseConnectionString(connStr) {
  const trimmed = String(connStr || '').trim();
  if (!trimmed) throw new Error('Bağlantı dizesi boş');

  let url;
  try {
    url = new URL(trimmed.replace(/^postgres:/i, 'postgresql:'));
  } catch {
    throw new Error('Geçersiz bağlantı URL biçimi');
  }

  const protocol = url.protocol.replace(':', '');
  if (protocol !== 'postgresql' && protocol !== 'postgres') {
    throw new Error('Sadece postgresql:// veya postgres:// desteklenir');
  }

  const host = url.hostname || 'localhost';
  const port = url.port ? parseInt(url.port, 10) : 5432;
  const user = decodeURIComponent(url.username || '');
  const password = decodeURIComponent(url.password || '');
  const pathname = url.pathname || '';
  const segments = pathname.split('/').filter(Boolean);
  const databaseFromPath = segments.length ? segments[0] : null;

  const search = url.searchParams;
  const sslmode = search.get('sslmode');

  const config = {
    host,
    port,
    user: user || undefined,
    password: password || undefined,
    database: databaseFromPath || undefined,
  };

  if (sslmode === 'require' || sslmode === 'verify-full' || sslmode === 'verify-ca') {
    config.ssl = { rejectUnauthorized: sslmode !== 'require' };
  } else if (search.get('ssl') === 'true') {
    config.ssl = { rejectUnauthorized: false };
  }

  return {
    config,
    hasDatabaseInPath: Boolean(databaseFromPath),
    databaseName: databaseFromPath,
  };
}

async function withPool(connStr, fn) {
  const { config } = parseConnectionString(connStr);
  if (!config.database) {
    config.database = 'postgres';
  }
  const pool = new Pool(config);
  try {
    return await fn(pool);
  } finally {
    await pool.end().catch(() => {});
  }
}

async function withAdminPool(connStr, fn) {
  const parsed = parseConnectionString(connStr);
  const cfg = { ...parsed.config, database: 'postgres' };
  const pool = new Pool(cfg);
  try {
    return await fn(pool, parsed);
  } finally {
    await pool.end().catch(() => {});
  }
}

function quoteIdent(name) {
  return '"' + String(name).replace(/"/g, '""') + '"';
}

/** Harf, rakam, _ ve - (tire); ilk karakter tire olamaz. Tırnaklı identifier ile SQL'e yazılır. */
function isValidDbName(name) {
  return /^[a-zA-Z0-9_][a-zA-Z0-9_-]*$/.test(String(name || ''));
}

app.post('/api/connect', async (req, res) => {
  try {
    const connStr = String(req.body?.connectionString || '').trim();
    const parsed = parseConnectionString(connStr);
    const testCfg = { ...parsed.config };
    if (!testCfg.database) testCfg.database = 'postgres';

    const c = new Client(testCfg);
    await c.connect();
    await c.query('SELECT 1');
    await c.end();

    res.json({
      ok: true,
      hasDatabaseInPath: parsed.hasDatabaseInPath,
      databaseName: parsed.databaseName || null,
    });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.get('/api/databases', async (req, res) => {
  const connStr = decodeConnectionHeader(req);
  if (!connStr) return res.status(400).json({ error: 'X-Connection-String gerekli' });
  try {
    const rows = await withAdminPool(connStr, async (pool) => {
      const r = await pool.query(
        `SELECT datname AS name
         FROM pg_database
         WHERE datistemplate = false AND datallowconn = true
         ORDER BY datname`
      );
      return r.rows;
    });
    res.json({ databases: rows });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/database/create', async (req, res) => {
  const connStr = decodeConnectionHeader(req);
  if (!connStr) return res.status(400).json({ error: 'X-Connection-String gerekli' });
  const name = String(req.body?.name || '').trim();
  if (!name || !isValidDbName(name)) {
    return res.status(400).json({
      error: 'Geçersiz veritabanı adı (harf, rakam, alt çizgi, tire; ilk karakter tire olamaz)',
    });
  }
  try {
    await withAdminPool(connStr, async (pool) => {
      await pool.query(`CREATE DATABASE ${quoteIdent(name)}`);
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/database/drop', async (req, res) => {
  const connStr = decodeConnectionHeader(req);
  if (!connStr) return res.status(400).json({ error: 'X-Connection-String gerekli' });
  const name = String(req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Ad gerekli' });
  try {
    await withAdminPool(connStr, async (pool) => {
      await pool.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [name]
      );
      await pool.query(`DROP DATABASE ${quoteIdent(name)}`);
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/database/copy', async (req, res) => {
  const connStr = decodeConnectionHeader(req);
  if (!connStr) return res.status(400).json({ error: 'X-Connection-String gerekli' });
  const sourceName = String(req.body?.sourceName || '').trim();
  const targetName = String(req.body?.targetName || '').trim();
  if (!sourceName || !targetName) {
    return res.status(400).json({ error: 'Kaynak ve hedef veritabanı adı gerekli' });
  }
  if (sourceName === targetName) {
    return res.status(400).json({ error: 'Kaynak ve hedef aynı olamaz' });
  }
  if (!isValidDbName(sourceName) || !isValidDbName(targetName)) {
    return res.status(400).json({
      error: 'Geçersiz ad (harf, rakam, alt çizgi, tire; ilk karakter tire olamaz)',
    });
  }
  try {
    await withAdminPool(connStr, async (pool) => {
      await pool.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [sourceName]
      );
      await pool.query(
        `CREATE DATABASE ${quoteIdent(targetName)} WITH TEMPLATE ${quoteIdent(sourceName)}`
      );
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/api/tables', async (req, res) => {
  const connStr = decodeConnectionHeader(req);
  if (!connStr) return res.status(400).json({ error: 'X-Connection-String gerekli' });
  try {
    const parsed = parseConnectionString(connStr);
    if (!parsed.hasDatabaseInPath) {
      return res.status(400).json({ error: 'Önce bir veritabanı seçin veya URL içinde /dbname kullanın' });
    }
    const rows = await withPool(connStr, async (pool) => {
      const r = await pool.query(
        `SELECT table_schema, table_name, table_type
         FROM information_schema.tables
         WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
         ORDER BY table_schema, table_name`
      );
      return r.rows;
    });
    res.json({ tables: rows });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/tables/drop', async (req, res) => {
  const connStr = decodeConnectionHeader(req);
  if (!connStr) return res.status(400).json({ error: 'X-Connection-String gerekli' });
  const tables = req.body?.tables;
  const cascade = Boolean(req.body?.cascade);
  if (!Array.isArray(tables) || !tables.length) {
    return res.status(400).json({ error: 'Tablo listesi gerekli' });
  }
  try {
    await withPool(connStr, async (pool) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        for (const t of tables) {
          const schema = String(t.schema || 'public');
          const name = String(t.name || '');
          if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(schema) || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
            throw new Error('Geçersiz şema veya tablo adı');
          }
          const sql = `DROP TABLE IF EXISTS ${quoteIdent(schema)}.${quoteIdent(name)} ${cascade ? 'CASCADE' : 'RESTRICT'}`;
          await client.query(sql);
        }
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/tables/truncate', async (req, res) => {
  const connStr = decodeConnectionHeader(req);
  if (!connStr) return res.status(400).json({ error: 'X-Connection-String gerekli' });
  const tables = req.body?.tables;
  const cascade = Boolean(req.body?.cascade);
  if (!Array.isArray(tables) || !tables.length) {
    return res.status(400).json({ error: 'Tablo listesi gerekli' });
  }
  try {
    await withPool(connStr, async (pool) => {
      const parts = [];
      for (const t of tables) {
        const schema = String(t.schema || 'public');
        const name = String(t.name || '');
        if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(schema) || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
          throw new Error('Geçersiz şema veya tablo adı');
        }
        parts.push(`${quoteIdent(schema)}.${quoteIdent(name)}`);
      }
      const sql = `TRUNCATE TABLE ${parts.join(', ')} ${cascade ? 'CASCADE' : 'RESTRICT'}`;
      await pool.query(sql);
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/query', async (req, res) => {
  const connStr = decodeConnectionHeader(req);
  if (!connStr) return res.status(400).json({ error: 'X-Connection-String gerekli' });
  const sql = String(req.body?.sql || '').trim();
  if (!sql) return res.status(400).json({ error: 'SQL gerekli' });
  try {
    const parsed = parseConnectionString(connStr);
    if (!parsed.hasDatabaseInPath) {
      return res.status(400).json({ error: 'Önce bir veritabanı seçin' });
    }
    const result = await withPool(connStr, async (pool) => {
      return pool.query(sql);
    });
    res.json({
      rows: result.rows,
      rowCount: result.rowCount,
      fields: (result.fields || []).map((f) => ({ name: f.name, dataTypeID: f.dataTypeID })),
      command: result.command,
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/api/table/:schema/:name/columns', async (req, res) => {
  const connStr = decodeConnectionHeader(req);
  if (!connStr) return res.status(400).json({ error: 'X-Connection-String gerekli' });
  const schema = String(req.params.schema || 'public');
  const name = String(req.params.name || '');
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(schema) || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
    return res.status(400).json({ error: 'Geçersiz ad' });
  }
  try {
    const rows = await withPool(connStr, async (pool) => {
      const r = await pool.query(
        `SELECT column_name, data_type, is_nullable, column_default
         FROM information_schema.columns
         WHERE table_schema = $1 AND table_name = $2
         ORDER BY ordinal_position`,
        [schema, name]
      );
      return r.rows;
    });
    res.json({ columns: rows });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/table/:schema/:name/row', async (req, res) => {
  const connStr = decodeConnectionHeader(req);
  if (!connStr) return res.status(400).json({ error: 'X-Connection-String gerekli' });
  const schema = String(req.params.schema || 'public');
  const name = String(req.params.name || '');
  const row = req.body?.row;
  if (!row || typeof row !== 'object') return res.status(400).json({ error: 'Satır verisi gerekli' });
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(schema) || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
    return res.status(400).json({ error: 'Geçersiz ad' });
  }
  try {
    const cols = Object.keys(row).filter((k) => /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(k));
    if (!cols.length) return res.status(400).json({ error: 'En az bir sütun gerekli' });
    const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
    const values = cols.map((c) => row[c]);
    const sql = `INSERT INTO ${quoteIdent(schema)}.${quoteIdent(name)} (${cols.map(quoteIdent).join(', ')}) VALUES (${placeholders}) RETURNING *`;
    const result = await withPool(connStr, async (pool) => pool.query(sql, values));
    res.json({ row: result.rows[0] });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.patch('/api/table/:schema/:name/row', async (req, res) => {
  const connStr = decodeConnectionHeader(req);
  if (!connStr) return res.status(400).json({ error: 'X-Connection-String gerekli' });
  const schema = String(req.params.schema || 'public');
  const name = String(req.params.name || '');
  const pk = req.body?.primaryKey;
  const updates = req.body?.updates;
  if (!pk || typeof pk !== 'object' || !updates || typeof updates !== 'object') {
    return res.status(400).json({ error: 'primaryKey ve updates gerekli' });
  }
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(schema) || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
    return res.status(400).json({ error: 'Geçersiz ad' });
  }
  const pkCols = Object.keys(pk).filter((k) => /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(k));
  const updCols = Object.keys(updates).filter((k) => /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(k));
  if (!pkCols.length || !updCols.length) {
    return res.status(400).json({ error: 'Geçerli sütun adları gerekli' });
  }
  try {
    const setParts = updCols.map((c, i) => `${quoteIdent(c)} = $${i + 1}`);
    const whereParts = pkCols.map((c, i) => `${quoteIdent(c)} = $${updCols.length + i + 1}`);
    const values = [...updCols.map((c) => updates[c]), ...pkCols.map((c) => pk[c])];
    const sql = `UPDATE ${quoteIdent(schema)}.${quoteIdent(name)} SET ${setParts.join(', ')} WHERE ${whereParts.join(' AND ')} RETURNING *`;
    const result = await withPool(connStr, async (pool) => pool.query(sql, values));
    res.json({ row: result.rows[0], rowCount: result.rowCount });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/api/table/:schema/:name/primary-keys', async (req, res) => {
  const connStr = decodeConnectionHeader(req);
  if (!connStr) return res.status(400).json({ error: 'X-Connection-String gerekli' });
  const schema = String(req.params.schema || 'public');
  const name = String(req.params.name || '');
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(schema) || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
    return res.status(400).json({ error: 'Geçersiz ad' });
  }
  try {
    const rows = await withPool(connStr, async (pool) => {
      const r = await pool.query(
        `SELECT kcu.column_name
         FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu
           ON tc.constraint_name = kcu.constraint_name
          AND tc.table_schema = kcu.table_schema
          AND tc.table_name = kcu.table_name
         WHERE tc.table_schema = $1 AND tc.table_name = $2 AND tc.constraint_type = 'PRIMARY KEY'
         ORDER BY kcu.ordinal_position`,
        [schema, name]
      );
      return r.rows;
    });
    res.json({ columns: rows.map((x) => x.column_name) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete('/api/table/:schema/:name/row', async (req, res) => {
  const connStr = decodeConnectionHeader(req);
  if (!connStr) return res.status(400).json({ error: 'X-Connection-String gerekli' });
  const schema = String(req.params.schema || 'public');
  const name = String(req.params.name || '');
  const pk = req.body?.primaryKey;
  if (!pk || typeof pk !== 'object') return res.status(400).json({ error: 'primaryKey gerekli' });
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(schema) || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
    return res.status(400).json({ error: 'Geçersiz ad' });
  }
  const pkCols = Object.keys(pk).filter((k) => /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(k));
  if (!pkCols.length) return res.status(400).json({ error: 'primaryKey sütunları gerekli' });
  try {
    const whereParts = pkCols.map((c, i) => `${quoteIdent(c)} = $${i + 1}`);
    const values = pkCols.map((c) => pk[c]);
    const sql = `DELETE FROM ${quoteIdent(schema)}.${quoteIdent(name)} WHERE ${whereParts.join(' AND ')} RETURNING *`;
    const result = await withPool(connStr, async (pool) => pool.query(sql, values));
    res.json({ row: result.rows[0], rowCount: result.rowCount });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

function buildPgUrl(connStr) {
  const trimmed = String(connStr || '').trim();
  if (trimmed.startsWith('postgres://') || trimmed.startsWith('postgresql://')) {
    return trimmed.replace(/^postgres:/i, 'postgresql:');
  }
  return trimmed;
}

/** Windows’ta PATH’te olmayan pg_dump/psql için yaygın kurulum yolları + PG_BIN */
function resolvePgBin(cmd) {
  const isWin = process.platform === 'win32';
  const exe = isWin ? `${cmd}.exe` : cmd;

  const pgBin = process.env.PG_BIN || process.env.PGDIR;
  if (pgBin) {
    const p = path.join(pgBin, exe);
    if (fs.existsSync(p)) return p;
  }

  if (isWin) {
    const bases = [
      process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'PostgreSQL'),
      'C:\\Program Files\\PostgreSQL',
      'C:\\Program Files (x86)\\PostgreSQL',
    ].filter(Boolean);
    for (const base of bases) {
      try {
        if (!fs.existsSync(base)) continue;
        const dirs = fs.readdirSync(base);
        dirs.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
        for (const d of dirs) {
          const candidate = path.join(base, d, 'bin', exe);
          if (fs.existsSync(candidate)) return candidate;
        }
      } catch (_) {}
    }
  }
  return cmd;
}

app.get('/api/backup', async (req, res) => {
  const connStr = decodeConnectionHeader(req);
  if (!connStr) return res.status(400).json({ error: 'X-Connection-String gerekli' });
  const parsed = parseConnectionString(connStr);
  if (!parsed.hasDatabaseInPath) {
    return res.status(400).json({ error: 'Yedek için URL içinde veritabanı adı olmalı' });
  }
  const dbName = parsed.databaseName;
  const filename = `backup-${dbName}-${Date.now()}.sql`;

  const pgDump = resolvePgBin('pg_dump');
  const args = ['--format=plain', '--no-owner', '--no-acl', buildPgUrl(connStr)];

  const child = spawn(pgDump, args, { env: process.env });

  child.on('error', (err) => {
    if (!res.headersSent) {
      const hint =
        err.code === 'ENOENT'
          ? ' PostgreSQL client kurulu olmalı; PATH’e ekleyin veya PG_BIN ortam değişkeni ile bin klasörünü verin (örn. C:\\Program Files\\PostgreSQL\\16\\bin).'
          : '';
      res.status(500).json({ error: 'pg_dump bulunamadı veya çalıştırılamadı: ' + err.message + hint });
    }
  });

  res.setHeader('Content-Type', 'application/sql');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  child.stdout.pipe(res);

  child.on('close', (code) => {
    if (code !== 0 && !res.writableEnded) {
      try {
        res.destroy();
      } catch (_) {}
    }
  });
});

app.post('/api/restore', upload.single('file'), async (req, res) => {
  const connStr = decodeConnectionHeader(req);
  if (!connStr) return res.status(400).json({ error: 'X-Connection-String gerekli' });
  if (!req.file?.path) return res.status(400).json({ error: 'Dosya gerekli' });

  const parsed = parseConnectionString(connStr);
  if (!parsed.hasDatabaseInPath) {
    fs.unlink(req.file.path, () => {});
    return res.status(400).json({ error: 'Geri yükleme için URL içinde veritabanı adı olmalı' });
  }

  const psql = resolvePgBin('psql');
  const url = buildPgUrl(connStr);
  const child = spawn(psql, [url, '-v', 'ON_ERROR_STOP=1', '-f', req.file.path], {
    env: process.env,
  });
  let errOut = '';
  child.stderr.on('data', (b) => {
    errOut += b.toString();
  });
  child.on('error', (err) => {
    fs.unlink(req.file.path, () => {});
    const hint =
      err.code === 'ENOENT'
        ? ' PATH veya PG_BIN (PostgreSQL bin klasörü) ayarlayın.'
        : '';
    res.status(500).json({ error: 'psql bulunamadı veya çalıştırılamadı: ' + err.message + hint });
  });
  child.on('close', (code) => {
    fs.unlink(req.file.path, () => {});
    if (code === 0) res.json({ ok: true });
    else res.status(400).json({ error: errOut || `psql çıkış kodu: ${code}` });
  });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const server = app.listen(PORT, () => {
  console.log(`PG Admin Tool http://localhost:${PORT}`);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(
      `[pg-admin-tool] Port ${PORT} dolu (EADDRINUSE). Genelde önceki sunucu hâlâ açık.\n` +
        `  • O terminalde Ctrl+C ile durdurun, veya\n` +
        `  • Başka port: PowerShell: $env:PORT=3841; npm start   |   bash: PORT=3841 npm start`
    );
    process.exit(1);
  }
  throw err;
});
