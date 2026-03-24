(function () {
  'use strict';

  /** @type {string|null} */
  let connectionString = null;

  function utf8ToB64(str) {
    return btoa(unescape(encodeURIComponent(str)));
  }

  function headersWithConn() {
    if (!connectionString) throw new Error('Bağlantı yok');
    return {
      'Content-Type': 'application/json',
      'X-Connection-String': utf8ToB64(connectionString),
    };
  }

  async function api(path, opts) {
    const h = opts?.skipConn ? {} : headersWithConn();
    const res = await fetch(path, {
      ...opts,
      headers: { ...h, ...(opts?.headers || {}) },
    });
    const text = await res.text();
    let data;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { raw: text };
    }
    if (!res.ok) {
      const msg = data.error || data.raw || res.statusText;
      throw new Error(msg);
    }
    return data;
  }

  const $ = (id) => document.getElementById(id);

  function toast(msg, type) {
    const root = $('toast-root');
    const el = document.createElement('div');
    el.className = 'toast toast--' + (type || 'info');
    el.setAttribute('role', 'status');
    el.textContent = msg;
    root.appendChild(el);
    requestAnimationFrame(() => el.classList.add('toast--in'));
    let t = setTimeout(() => dismiss(), 4200);
    function dismiss() {
      clearTimeout(t);
      el.classList.remove('toast--in');
      el.classList.add('toast--out');
      setTimeout(() => el.remove(), 280);
    }
    el.addEventListener('click', dismiss);
  }

  /** @type {((v: boolean) => void) | null} */
  let confirmResolve = null;

  function confirmDialog({ title, message, danger, okText }) {
    return new Promise((resolve) => {
      confirmResolve = resolve;
      $('modal-confirm-title').textContent = title;
      $('modal-confirm-body').textContent = message;
      const ok = $('modal-confirm-ok');
      ok.textContent = okText || 'Tamam';
      ok.className = danger ? 'danger' : 'primary';
      $('modal-confirm').classList.remove('hidden');
    });
  }

  function finishConfirm(val) {
    $('modal-confirm').classList.add('hidden');
    const fn = confirmResolve;
    confirmResolve = null;
    if (fn) fn(val);
  }

  function setStatus(el, text, kind) {
    el.textContent = text || '';
    el.className = 'status' + (kind ? ' ' + kind : '');
  }

  function updateDbBadge() {
    const el = $('db-badge');
    if (!connectionString || !hasDatabaseInConn()) {
      el.classList.add('hidden');
      el.textContent = '';
      return;
    }
    try {
      const u = new URL(connectionString.trim().replace(/^postgres:/i, 'postgresql:'));
      const db = u.pathname.split('/').filter(Boolean)[0] || '';
      el.textContent = db ? 'DB: ' + db : '';
      el.classList.toggle('hidden', !db);
    } catch {
      el.classList.add('hidden');
    }
  }

  function switchTab(name) {
    document.querySelectorAll('.nav-tab').forEach((b) => {
      b.classList.toggle('active', b.getAttribute('data-tab') === name);
      b.setAttribute('aria-current', b.getAttribute('data-tab') === name ? 'page' : 'false');
    });
    document.querySelectorAll('.tab-panel').forEach((p) => {
      const on = p.getAttribute('data-tab') === name;
      p.classList.toggle('hidden', !on);
      p.classList.toggle('active', on);
    });
  }

  function showPanels() {
    const hasConn = Boolean(connectionString);
    const hasDb = hasDatabaseInConn();
    $('panel-databases').classList.toggle('hidden', !hasConn || hasDb);
    $('workspace').classList.toggle('hidden', !hasConn || !hasDb);
    updateDbBadge();
    if (hasConn && hasDb) switchTab('tables');
  }

  function hasDatabaseInConn() {
    if (!connectionString) return false;
    try {
      const u = new URL(connectionString.trim().replace(/^postgres:/i, 'postgresql:'));
      const seg = u.pathname.split('/').filter(Boolean);
      return seg.length > 0;
    } catch {
      return false;
    }
  }

  function withDatabase(dbName) {
    const s = connectionString.trim().replace(/^postgres:/i, 'postgresql:');
    const u = new URL(s);
    u.pathname = '/' + dbName;
    return u.toString();
  }

  function ensureCrudTableOption(schema, name) {
    const val = `${schema}\t${name}`;
    const sel = $('crud-table');
    const exists = Array.from(sel.options).some((o) => o.value === val);
    if (!exists) {
      const opt = document.createElement('option');
      opt.value = val;
      opt.textContent = `${schema}.${name}`;
      sel.appendChild(opt);
    }
    sel.value = val;
  }

  $('workspace-nav').addEventListener('click', (e) => {
    const btn = e.target.closest('.nav-tab');
    if (!btn) return;
    switchTab(btn.getAttribute('data-tab'));
  });

  $('modal-confirm-cancel').addEventListener('click', () => finishConfirm(false));
  $('modal-confirm-backdrop').addEventListener('click', () => finishConfirm(false));
  $('modal-confirm-x').addEventListener('click', () => finishConfirm(false));
  $('modal-confirm-ok').addEventListener('click', () => finishConfirm(true));

  // —— Bağlantı ——
  $('btn-connect').addEventListener('click', async () => {
    const raw = $('conn-input').value.trim();
    if (!raw) {
      setStatus($('conn-status'), 'Connection string girin.', 'err');
      toast('Connection string girin', 'error');
      return;
    }
    setStatus($('conn-status'), 'Bağlanılıyor…');
    try {
      const res = await fetch('/api/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ connectionString: raw }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || 'Bağlantı başarısız');
      connectionString = raw;
      setStatus($('conn-status'), 'Bağlandı.', 'ok');
      toast('Bağlantı kuruldu', 'success');
      showPanels();
      if (!data.hasDatabaseInPath) {
        await loadDatabases();
      } else {
        await loadTables();
        await fillCrudTables();
      }
    } catch (e) {
      connectionString = null;
      setStatus($('conn-status'), e.message, 'err');
      toast(e.message, 'error');
      showPanels();
    }
  });

  $('btn-disconnect').addEventListener('click', () => {
    connectionString = null;
    $('conn-input').value = '';
    setStatus($('conn-status'), 'Bağlantı kesildi.', '');
    $('db-list').innerHTML = '';
    $('tables-body').innerHTML = '';
    $('sql-result').innerHTML = '';
    $('crud-rows').innerHTML = '';
    $('crud-table').innerHTML = '';
    hideEditPanels();
    showPanels();
    toast('Bağlantı kesildi', 'info');
  });

  // —— Veritabanları ——
  async function loadDatabases() {
    const data = await api('/api/databases');
    const ul = $('db-list');
    ul.innerHTML = '';
    data.databases.forEach((d) => {
      const li = document.createElement('li');
      const name = d.name;
      li.innerHTML = `
        <span><code>${escapeHtml(name)}</code></span>
        <span class="db-actions">
          <button type="button" class="primary btn-enter-db" data-db="${escapeHtml(name)}">Gir</button>
          <button type="button" class="btn-copy-db" data-db="${escapeHtml(name)}">Kopyala</button>
          <button type="button" class="danger btn-drop-db" data-db="${escapeHtml(name)}">Sil</button>
        </span>`;
      ul.appendChild(li);
    });
    ul.querySelectorAll('.btn-enter-db').forEach((btn) => {
      btn.addEventListener('click', () => {
        const db = btn.getAttribute('data-db');
        connectionString = withDatabase(db);
        $('conn-input').value = connectionString;
        showPanels();
        loadTables();
        fillCrudTables();
        toast(`Veritabanı: ${db}`, 'success');
      });
    });
    ul.querySelectorAll('.btn-copy-db').forEach((btn) => {
      btn.addEventListener('click', () => {
        const db = btn.getAttribute('data-db');
        openCopyDbModal(db);
      });
    });
    ul.querySelectorAll('.btn-drop-db').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const db = btn.getAttribute('data-db');
        const ok = await confirmDialog({
          title: 'Veritabanını sil',
          message: `"${db}" kalıcı olarak silinecek. Emin misiniz?`,
          danger: true,
          okText: 'Sil',
        });
        if (!ok) return;
        try {
          await api('/api/database/drop', {
            method: 'POST',
            headers: headersWithConn(),
            body: JSON.stringify({ name: db }),
          });
          await loadDatabases();
          setStatus($('conn-status'), `Silindi: ${db}`, 'ok');
          toast(`Veritabanı silindi: ${db}`, 'success');
        } catch (e) {
          toast(e.message, 'error');
        }
      });
    });
  }

  /** @type {string|null} */
  let copyModalSource = null;

  function openCopyDbModal(sourceDb) {
    copyModalSource = sourceDb;
    $('modal-copy-source').textContent = sourceDb;
    $('modal-copy-target').value = `${sourceDb}_copy`;
    $('modal-copy-db').classList.remove('hidden');
    setTimeout(() => $('modal-copy-target').focus(), 50);
  }

  function closeCopyDbModal() {
    copyModalSource = null;
    $('modal-copy-db').classList.add('hidden');
    $('modal-copy-target').value = '';
  }

  $('modal-copy-cancel').addEventListener('click', closeCopyDbModal);
  $('modal-copy-backdrop').addEventListener('click', closeCopyDbModal);
  $('modal-copy-x').addEventListener('click', closeCopyDbModal);
  $('modal-copy-confirm').addEventListener('click', async () => {
    if (!copyModalSource) return;
    const targetName = $('modal-copy-target').value.trim();
    if (!targetName) {
      toast('Yeni veritabanı adını girin', 'error');
      return;
    }
    try {
      await api('/api/database/copy', {
        method: 'POST',
        headers: headersWithConn(),
        body: JSON.stringify({ sourceName: copyModalSource, targetName }),
      });
      closeCopyDbModal();
      await loadDatabases();
      setStatus($('conn-status'), `Kopya: ${targetName}`, 'ok');
      toast(`Kopya oluşturuldu: ${targetName}`, 'success');
    } catch (e) {
      toast(e.message, 'error');
    }
  });

  $('btn-db-create').addEventListener('click', async () => {
    const name = $('new-db-name').value.trim();
    if (!name) {
      toast('Veritabanı adı girin', 'error');
      return;
    }
    try {
      await api('/api/database/create', {
        method: 'POST',
        headers: headersWithConn(),
        body: JSON.stringify({ name }),
      });
      $('new-db-name').value = '';
      await loadDatabases();
      setStatus($('conn-status'), `Oluşturuldu: ${name}`, 'ok');
      toast(`Veritabanı oluşturuldu: ${name}`, 'success');
    } catch (e) {
      toast(e.message, 'error');
    }
  });

  // —— Yedek ——
  $('btn-backup').addEventListener('click', async () => {
    if (!hasDatabaseInConn()) {
      toast('Önce bir veritabanı seçin (URL’de /dbname)', 'error');
      return;
    }
    try {
      const res = await fetch('/api/backup', { headers: headersWithConn() });
      if (!res.ok) {
        const t = await res.text();
        let err = t;
        try {
          err = JSON.parse(t).error || t;
        } catch (_) {}
        throw new Error(err);
      }
      const blob = await res.blob();
      const cd = res.headers.get('Content-Disposition');
      let fname = 'backup.sql';
      if (cd && cd.includes('filename=')) {
        fname = cd.split('filename=')[1].replace(/"/g, '').trim();
      }
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = fname;
      a.click();
      URL.revokeObjectURL(a.href);
      setStatus($('restore-status'), 'İndirildi.', 'ok');
      toast('Yedek dosyası indirildi', 'success');
    } catch (e) {
      setStatus($('restore-status'), e.message, 'err');
      toast(e.message, 'error');
    }
  });

  $('restore-file').addEventListener('change', async (ev) => {
    const file = ev.target.files?.[0];
    ev.target.value = '';
    if (!file || !hasDatabaseInConn()) {
      if (!hasDatabaseInConn()) toast('Önce bir veritabanı seçin', 'error');
      return;
    }
    setStatus($('restore-status'), 'Çalışıyor…');
    const fd = new FormData();
    fd.append('file', file);
    try {
      const res = await fetch('/api/restore', {
        method: 'POST',
        headers: { 'X-Connection-String': utf8ToB64(connectionString) },
        body: fd,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Hata');
      setStatus($('restore-status'), 'Tamamlandı.', 'ok');
      toast('Geri yükleme bitti', 'success');
    } catch (e) {
      setStatus($('restore-status'), e.message, 'err');
      toast(e.message, 'error');
    }
  });

  // —— Tablolar ——
  let tablesCache = [];

  async function loadTables() {
    if (!hasDatabaseInConn()) return;
    const data = await api('/api/tables');
    tablesCache = data.tables || [];
    const tb = $('tables-body');
    tb.innerHTML = '';
    tablesCache.forEach((t, i) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><input type="checkbox" class="tbl-chk" data-i="${i}" /></td>
        <td>${escapeHtml(t.table_schema)}</td>
        <td>${escapeHtml(t.table_name)}</td>
        <td>${escapeHtml(t.table_type)}</td>
        <td><button type="button" class="linkish btn-open-crud" data-i="${i}">Satırlar</button></td>`;
      tb.appendChild(tr);
    });
    tb.querySelectorAll('.btn-open-crud').forEach((btn) => {
      btn.addEventListener('click', () => {
        const i = parseInt(btn.getAttribute('data-i'), 10);
        const t = tablesCache[i];
        ensureCrudTableOption(t.table_schema, t.table_name);
        switchTab('crud');
        loadCrudRows().catch((e) => toast(e.message, 'error'));
        $('panel-crud').scrollIntoView({ behavior: 'smooth' });
      });
    });
  }

  $('btn-refresh-tables').addEventListener('click', () =>
    loadTables().catch((e) => toast(e.message, 'error'))
  );

  $('chk-all-tables').addEventListener('change', (ev) => {
    const on = ev.target.checked;
    document.querySelectorAll('.tbl-chk').forEach((c) => {
      c.checked = on;
    });
  });

  function selectedTableRefs() {
    const out = [];
    document.querySelectorAll('.tbl-chk:checked').forEach((c) => {
      const i = parseInt(c.getAttribute('data-i'), 10);
      const t = tablesCache[i];
      if (t) out.push({ schema: t.table_schema, name: t.table_name });
    });
    return out;
  }

  $('btn-bulk-truncate').addEventListener('click', async () => {
    const tables = selectedTableRefs();
    if (!tables.length) {
      toast('En az bir tablo seçin', 'error');
      return;
    }
    const cascade = $('bulk-cascade').checked;
    const ok = await confirmDialog({
      title: 'TRUNCATE',
      message: `${tables.length} tablo kesilecek (${cascade ? 'CASCADE' : 'RESTRICT'}). Devam?`,
      danger: true,
      okText: 'TRUNCATE',
    });
    if (!ok) return;
    try {
      await api('/api/tables/truncate', {
        method: 'POST',
        headers: headersWithConn(),
        body: JSON.stringify({ tables, cascade }),
      });
      await loadTables();
      setStatus($('conn-status'), 'TRUNCATE tamam.', 'ok');
      toast('TRUNCATE tamamlandı', 'success');
    } catch (e) {
      toast(e.message, 'error');
    }
  });

  $('btn-bulk-drop').addEventListener('click', async () => {
    const tables = selectedTableRefs();
    if (!tables.length) {
      toast('En az bir tablo seçin', 'error');
      return;
    }
    const cascade = $('bulk-cascade').checked;
    const ok = await confirmDialog({
      title: 'Tabloları sil',
      message: `${tables.length} tablo kalıcı silinecek (${cascade ? 'CASCADE' : 'RESTRICT'}). Emin misiniz?`,
      danger: true,
      okText: 'DROP',
    });
    if (!ok) return;
    try {
      await api('/api/tables/drop', {
        method: 'POST',
        headers: headersWithConn(),
        body: JSON.stringify({ tables, cascade }),
      });
      await loadTables();
      await fillCrudTables();
      setStatus($('conn-status'), 'DROP tamam.', 'ok');
      toast('Tablolar silindi', 'success');
    } catch (e) {
      toast(e.message, 'error');
    }
  });

  // —— SQL ——
  $('btn-run-sql').addEventListener('click', async () => {
    const sql = $('sql-input').value.trim();
    if (!sql) return;
    setStatus($('sql-status'), 'Çalışıyor…');
    try {
      const data = await api('/api/query', {
        method: 'POST',
        headers: headersWithConn(),
        body: JSON.stringify({ sql }),
      });
      renderResultTable($('sql-result'), data.rows || [], data.fields);
      setStatus(
        $('sql-status'),
        `${data.command || 'OK'} · ${data.rowCount != null ? data.rowCount + ' satır' : ''}`,
        'ok'
      );
    } catch (e) {
      setStatus($('sql-status'), e.message, 'err');
      toast(e.message, 'error');
    }
  });

  function renderResultTable(tableEl, rows, fields) {
    tableEl.innerHTML = '';
    if (!rows || !rows.length) {
      tableEl.innerHTML = '<tbody><tr><td>(Sonuç yok)</td></tr></tbody>';
      return;
    }
    const cols = fields && fields.length ? fields.map((f) => f.name) : Object.keys(rows[0]);
    const thead = document.createElement('thead');
    thead.innerHTML = '<tr>' + cols.map((c) => `<th>${escapeHtml(c)}</th>`).join('') + '</tr>';
    const tbody = document.createElement('tbody');
    rows.forEach((row) => {
      const tr = document.createElement('tr');
      tr.innerHTML = cols.map((c) => `<td>${escapeHtml(formatCell(row[c]))}</td>`).join('');
      tbody.appendChild(tr);
    });
    tableEl.appendChild(thead);
    tableEl.appendChild(tbody);
  }

  function formatCell(v) {
    if (v === null || v === undefined) return 'NULL';
    if (typeof v === 'object') return JSON.stringify(v);
    return String(v);
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // —— CRUD ——
  async function fillCrudTables() {
    const sel = $('crud-table');
    sel.innerHTML = '';
    if (!hasDatabaseInConn()) return;
    const data = await api('/api/tables');
    (data.tables || []).forEach((t) => {
      if (t.table_type !== 'BASE TABLE') return;
      const opt = document.createElement('option');
      opt.value = `${t.table_schema}\t${t.table_name}`;
      opt.textContent = `${t.table_schema}.${t.table_name}`;
      sel.appendChild(opt);
    });
  }

  $('btn-load-rows').addEventListener('click', () =>
    loadCrudRows().catch((e) => toast(e.message, 'error'))
  );

  async function loadCrudRows() {
    const parsed = parseTableSelect();
    if (!parsed) return;
    const { schema, name } = parsed;
    const sql = `SELECT * FROM "${schema.replace(/"/g, '""')}"."${name.replace(/"/g, '""')}" LIMIT 200`;
    setStatus($('crud-status'), 'Yükleniyor…');
    const data = await api('/api/query', {
      method: 'POST',
      headers: headersWithConn(),
      body: JSON.stringify({ sql }),
    });
    const rows = data.rows || [];
    const cols = rows.length ? Object.keys(rows[0]) : [];
    const table = $('crud-rows');
    table.innerHTML = '';
    if (!cols.length) {
      table.innerHTML = '<tbody><tr><td>(Boş)</td></tr></tbody>';
      setStatus($('crud-status'), '0 satır', 'ok');
      return;
    }
    const pkData = await api(`/api/table/${encodeURIComponent(schema)}/${encodeURIComponent(name)}/primary-keys`);
    const pkCols = pkData.columns || [];

    const thead = document.createElement('thead');
    const hr = document.createElement('tr');
    hr.innerHTML = '<th></th>' + cols.map((c) => `<th>${escapeHtml(c)}</th>`).join('');
    thead.appendChild(hr);
    const tbody = document.createElement('tbody');
    rows.forEach((row) => {
      const tr = document.createElement('tr');
      const btnTd = document.createElement('td');
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'linkish';
      b.textContent = 'Düzenle';
      b.addEventListener('click', () => openEdit(schema, name, row, pkCols));
      btnTd.appendChild(b);
      tr.appendChild(btnTd);
      cols.forEach((c) => {
        const td = document.createElement('td');
        td.textContent = formatCell(row[c]);
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    table.appendChild(thead);
    table.appendChild(tbody);
    setStatus($('crud-status'), `${rows.length} satır (LIMIT 200)`, 'ok');
  }

  function parseTableSelect() {
    const v = $('crud-table').value;
    if (!v) {
      toast('Soldaki listeden tablo seçin veya Tablolar’dan Satırlar’a basın', 'error');
      return null;
    }
    const parts = v.split('\t');
    if (parts.length < 2 || !parts[0] || !parts[1]) {
      toast('Geçersiz tablo seçimi', 'error');
      return null;
    }
    return { schema: parts[0], name: parts[1] };
  }

  function hideEditPanels() {
    $('insert-panel').classList.add('hidden');
    $('edit-panel').classList.add('hidden');
  }

  $('btn-show-insert').addEventListener('click', () => {
    hideEditPanels();
    $('insert-json').value = '{}';
    $('insert-panel').classList.remove('hidden');
  });

  $('btn-insert').addEventListener('click', async () => {
    const parsed = parseTableSelect();
    if (!parsed) return;
    let row;
    try {
      row = JSON.parse($('insert-json').value || '{}');
    } catch {
      toast('Geçerli JSON girin', 'error');
      return;
    }
    try {
      await api(`/api/table/${encodeURIComponent(parsed.schema)}/${encodeURIComponent(parsed.name)}/row`, {
        method: 'POST',
        headers: headersWithConn(),
        body: JSON.stringify({ row }),
      });
      $('insert-panel').classList.add('hidden');
      await loadCrudRows();
      toast('Satır eklendi', 'success');
    } catch (e) {
      toast(e.message, 'error');
    }
  });

  function openEdit(schema, name, row, pkCols) {
    hideEditPanels();
    const pkObj = {};
    if (pkCols.length) {
      pkCols.forEach((c) => {
        pkObj[c] = row[c];
      });
    } else {
      toast('PK yok; pk JSON’u elle doldurun', 'info');
    }
    $('pk-json').value = JSON.stringify(pkObj, null, 2);
    $('upd-json').value = '{}';
    $('edit-panel').classList.remove('hidden');
    $('edit-panel').dataset.schema = schema;
    $('edit-panel').dataset.name = name;
  }

  $('btn-edit-cancel').addEventListener('click', hideEditPanels);

  $('btn-update').addEventListener('click', async () => {
    const panel = $('edit-panel');
    const schema = panel.dataset.schema;
    const name = panel.dataset.name;
    let primaryKey;
    let updates;
    try {
      primaryKey = JSON.parse($('pk-json').value || '{}');
      updates = JSON.parse($('upd-json').value || '{}');
    } catch {
      toast('Geçerli JSON girin', 'error');
      return;
    }
    try {
      await api(`/api/table/${encodeURIComponent(schema)}/${encodeURIComponent(name)}/row`, {
        method: 'PATCH',
        headers: headersWithConn(),
        body: JSON.stringify({ primaryKey, updates }),
      });
      hideEditPanels();
      await loadCrudRows();
      toast('Güncellendi', 'success');
    } catch (e) {
      toast(e.message, 'error');
    }
  });

  $('btn-delete').addEventListener('click', async () => {
    const panel = $('edit-panel');
    const schema = panel.dataset.schema;
    const name = panel.dataset.name;
    let primaryKey;
    try {
      primaryKey = JSON.parse($('pk-json').value || '{}');
    } catch {
      toast('Geçerli pk JSON girin', 'error');
      return;
    }
    const ok = await confirmDialog({
      title: 'Satırı sil',
      message: 'Bu satır kalıcı silinecek.',
      danger: true,
      okText: 'Sil',
    });
    if (!ok) return;
    try {
      await api(`/api/table/${encodeURIComponent(schema)}/${encodeURIComponent(name)}/row`, {
        method: 'DELETE',
        headers: headersWithConn(),
        body: JSON.stringify({ primaryKey }),
      });
      hideEditPanels();
      await loadCrudRows();
      toast('Satır silindi', 'success');
    } catch (e) {
      toast(e.message, 'error');
    }
  });

  document.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Escape') return;
    if (!$('modal-confirm').classList.contains('hidden')) {
      finishConfirm(false);
      return;
    }
    if (!$('modal-copy-db').classList.contains('hidden')) closeCopyDbModal();
  });

  document.addEventListener('DOMContentLoaded', () => {
    connectionString = null;
    $('conn-input').value = '';
    showPanels();
  });

  showPanels();
})();
