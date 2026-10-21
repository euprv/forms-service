'use strict';
/**
 * Сервис форм: конструктор (/admin) + публичная форма (/f/<slug>).
 * Без внешних зависимостей: только встроенные модули Node.js.
 * Данные хранятся в data/db.json (атомарная запись через временный файл).
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PUBLIC_DIR = path.join(__dirname, 'public');
const TYPES = ['text', 'textarea', 'email', 'tel', 'number', 'date', 'select', 'radio', 'checkbox'];
const CHOICE = ['select', 'radio', 'checkbox'];
const MAX_BODY = 1024 * 1024;
const MAX_SESSIONS_PER_FORM = 50000;

class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

const str = (v) => (typeof v === 'string' ? v : '');
const json = (data, status = 200) => ({
  status,
  headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  body: JSON.stringify(data),
});

/* ------------------------------------------------------------------ */
/* Валидация конструктора формы                                        */
/* ------------------------------------------------------------------ */
function cleanForm(input) {
  const errors = [];
  const title = str(input.title).trim().slice(0, 200);
  const description = str(input.description).trim().slice(0, 2000);
  if (!title) errors.push('Укажите название формы');

  const rawFields = Array.isArray(input.fields) ? input.fields.slice(0, 50) : [];
  if (!rawFields.length) errors.push('Добавьте хотя бы один вопрос');

  const used = new Set();
  const fields = rawFields.map((f, i) => {
    f = f && typeof f === 'object' ? f : {};
    const type = TYPES.includes(f.type) ? f.type : 'text';
    const label = str(f.label).trim().slice(0, 300);
    if (!label) errors.push(`Вопрос ${i + 1}: укажите текст вопроса`);

    let id = str(f.id);
    if (!/^[a-z0-9]{4,24}$/.test(id) || used.has(id)) id = crypto.randomBytes(5).toString('hex');
    used.add(id);

    const field = { id, type, label, required: f.required === true };
    if (CHOICE.includes(type)) {
      const options = [...new Set((Array.isArray(f.options) ? f.options : []).map((o) => str(o).trim()).filter(Boolean))]
        .map((o) => o.slice(0, 200))
        .slice(0, 50);
      const min = type === 'checkbox' ? 1 : 2;
      if (options.length < min) errors.push(`Вопрос ${i + 1}: добавьте минимум ${min === 1 ? 'один вариант' : 'два варианта'} ответа`);
      field.options = options;
    }
    return field;
  });

  if (errors.length) throw new HttpError(400, errors[0], errors);
  return { title, description, fields };
}

/* ------------------------------------------------------------------ */
/* Валидация ответа студента                                           */
/* ------------------------------------------------------------------ */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validateAnswers(form, body) {
  const raw = body && body.answers && typeof body.answers === 'object' ? body.answers : {};
  const errors = {};
  const answers = [];

  for (const f of form.fields) {
    const entry = { id: f.id, label: f.label, type: f.type, value: f.type === 'checkbox' ? [] : '' };
    answers.push(entry);
    let v = raw[f.id];
    let empty;

    if (f.type === 'checkbox') {
      v = Array.isArray(v) ? v.filter((x) => typeof x === 'string' && f.options.includes(x)) : [];
      v = [...new Set(v)];
      empty = v.length === 0;
    } else {
      v = typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '';
      empty = v === '';
    }

    if (empty) {
      if (f.required) errors[f.id] = 'Обязательное поле';
      continue;
    }

    let err = null;
    switch (f.type) {
      case 'text': if (v.length > 1000) err = 'Слишком длинный ответ (максимум 1000 символов)'; break;
      case 'textarea': if (v.length > 5000) err = 'Слишком длинный ответ (максимум 5000 символов)'; break;
      case 'email': if (v.length > 254 || !EMAIL_RE.test(v)) err = 'Введите корректный email'; break;
      case 'tel': if (!/^[+()\-\s\d]{5,25}$/.test(v) || v.replace(/\D/g, '').length < 5) err = 'Введите корректный номер телефона'; break;
      case 'number': if (!Number.isFinite(Number(v)) || v.length > 30) err = 'Введите число'; break;
      case 'date': {
        const d = new Date(v + 'T00:00:00Z');
        if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v) err = 'Введите корректную дату';
        break;
      }
      case 'select':
      case 'radio': if (!f.options.includes(v)) err = 'Выберите один из предложенных вариантов'; break;
      default: break;
    }
    if (err) errors[f.id] = err;
    else entry.value = v;
  }

  if (Object.keys(errors).length) throw new HttpError(400, 'Проверьте заполнение формы', errors);
  return answers;
}

/* ------------------------------------------------------------------ */
/* CSV                                                                 */
/* ------------------------------------------------------------------ */
function csvCell(v) {
  let s = Array.isArray(v) ? v.join('; ') : String(v ?? '');
  // защита от formula injection при открытии в Excel
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+([.,]\d+)?$/.test(s)) s = "'" + s;
  return '"' + s.replace(/"/g, '""') + '"';
}

/* ------------------------------------------------------------------ */
/* Приложение                                                          */
/* ------------------------------------------------------------------ */
function createApp({ dataDir = process.env.DATA_DIR || path.join(__dirname, 'data') } = {}) {
  const dbFile = path.join(dataDir, 'db.json');
  fs.mkdirSync(dataDir, { recursive: true });

  // forms[], responses[], sessions: { [formId]: { [sid]: {t, started, last, f:[fieldId], submitted} } }
  const db = { forms: [], responses: [], sessions: {} };
  try {
    Object.assign(db, JSON.parse(fs.readFileSync(dbFile, 'utf8')));
  } catch (e) {
    if (e.code !== 'ENOENT') throw new Error(`Не удалось прочитать ${dbFile}: ${e.message}`);
  }

  let timer = null;
  function persist() {
    clearTimeout(timer);
    timer = null;
    const tmp = dbFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db));
    fs.renameSync(tmp, dbFile);
  }
  // события аналитики приходят часто — сохраняем с задержкой
  function persistSoon() {
    if (!timer) {
      timer = setTimeout(persist, 500);
      timer.unref();
    }
  }

  const findForm = (id) => {
    const f = db.forms.find((x) => x.id === id);
    if (!f) throw new HttpError(404, 'Форма не найдена');
    return f;
  };
  const findPublished = (slug) => {
    const f = db.forms.find((x) => x.slug === slug && x.published);
    if (!f) throw new HttpError(404, 'Форма не найдена или ещё не опубликована');
    return f;
  };
  const newSlug = () => {
    let s;
    do s = crypto.randomBytes(6).toString('base64url'); while (db.forms.some((f) => f.slug === s));
    return s;
  };

  function sessionStats(formId) {
    const list = Object.values(db.sessions[formId] || {});
    return {
      views: list.length,
      started: list.filter((s) => s.started).length,
      submitted: list.filter((s) => s.submitted).length,
    };
  }

  function summary(f) {
    return {
      id: f.id, title: f.title, slug: f.slug, published: f.published,
      createdAt: f.createdAt, updatedAt: f.updatedAt, fieldCount: f.fields.length,
      responses: db.responses.filter((r) => r.formId === f.id).length,
      ...sessionStats(f.id),
    };
  }

  // колонки таблицы ответов: поля текущей формы + «осиротевшие» поля из старых версий формы
  function columnsFor(form, responses) {
    const cols = form.fields.map((f) => ({ id: f.id, label: f.label }));
    const known = new Set(cols.map((c) => c.id));
    for (const r of responses) {
      for (const a of r.answers) {
        if (!known.has(a.id)) { known.add(a.id); cols.push({ id: a.id, label: a.label + ' (удалён)' }); }
      }
    }
    return cols;
  }

  function funnel(form) {
    const list = Object.values(db.sessions[form.id] || {});
    return form.fields.map((f) => ({
      id: f.id,
      label: f.label,
      reached: list.filter((s) => s.f.includes(f.id)).length,
      leftHere: list.filter((s) => s.started && !s.submitted && s.last === f.id).length,
    }));
  }

  /* ------------------------- маршруты ------------------------- */
  const routes = [];
  const route = (method, pattern, handler) => routes.push({ method, re: new RegExp(`^${pattern}$`), handler });
  const ID = '(?<id>[\\w-]+)';

  // --- админка: формы
  route('GET', '/api/forms', () =>
    json([...db.forms].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(summary)));

  route('POST', '/api/forms', ({ body }) => {
    const data = cleanForm(body);
    const now = new Date().toISOString();
    const form = { id: crypto.randomUUID(), slug: newSlug(), ...data, published: body.published === true, createdAt: now, updatedAt: now };
    db.forms.push(form);
    persist();
    return json(form, 201);
  });

  route('GET', `/api/forms/${ID}`, ({ params }) => json(findForm(params.id)));

  route('PUT', `/api/forms/${ID}`, ({ params, body }) => {
    const form = findForm(params.id);
    Object.assign(form, cleanForm(body), { updatedAt: new Date().toISOString() });
    if (typeof body.published === 'boolean') form.published = body.published;
    persist();
    return json(form);
  });

  route('POST', `/api/forms/${ID}/publish`, ({ params, body }) => {
    const form = findForm(params.id);
    form.published = body.published === true;
    form.updatedAt = new Date().toISOString();
    persist();
    return json(summary(form));
  });

  route('DELETE', `/api/forms/${ID}`, ({ params }) => {
    const form = findForm(params.id);
    db.forms = db.forms.filter((f) => f !== form);
    db.responses = db.responses.filter((r) => r.formId !== form.id);
    delete db.sessions[form.id];
    persist();
    return json({ ok: true });
  });

  // --- админка: ответы и аналитика
  route('GET', `/api/forms/${ID}/responses`, ({ params }) => {
    const form = findForm(params.id);
    const responses = db.responses.filter((r) => r.formId === form.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return json({
      form,
      columns: columnsFor(form, responses),
      responses,
      stats: { ...sessionStats(form.id), responses: responses.length, fields: funnel(form) },
    });
  });

  route('GET', `/api/forms/${ID}/responses\\.csv`, ({ params }) => {
    const form = findForm(params.id);
    const responses = db.responses.filter((r) => r.formId === form.id).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const cols = columnsFor(form, responses);
    const lines = [['Дата', ...cols.map((c) => c.label)].map(csvCell).join(',')];
    for (const r of responses) {
      const byId = new Map(r.answers.map((a) => [a.id, a.value]));
      lines.push([new Date(r.createdAt).toLocaleString('ru-RU', { timeZone: 'UTC' }) + ' UTC', ...cols.map((c) => byId.get(c.id) ?? '')].map(csvCell).join(','));
    }
    const name = encodeURIComponent(form.title.replace(/[^\p{L}\p{N}]+/gu, '_').slice(0, 60) || 'responses');
    return {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename*=UTF-8''${name}.csv`,
      },
      body: '\uFEFF' + lines.join('\r\n') + '\r\n',
    };
  });

  // --- публичная часть
  route('GET', '/api/public/(?<slug>[\\w-]+)', ({ params }) => {
    const f = findPublished(params.slug);
    return json({ title: f.title, description: f.description, fields: f.fields });
  });

  route('POST', '/api/public/(?<slug>[\\w-]+)/track', ({ params, body }) => {
    const form = findPublished(params.slug);
    const sid = str(body.sid);
    if (!/^[\w-]{8,64}$/.test(sid)) throw new HttpError(400, 'Некорректный sid');
    const s = touchSession(form, sid);
    if (s) {
      if (body.type === 'field' && form.fields.some((f) => f.id === body.fieldId)) {
        s.started = true;
        s.last = body.fieldId;
        if (!s.f.includes(body.fieldId)) s.f.push(body.fieldId);
      }
      persistSoon();
    }
    return json({ ok: true });
  });

  route('POST', '/api/public/(?<slug>[\\w-]+)/submit', ({ params, body }) => {
    const form = findPublished(params.slug);
    const answers = validateAnswers(form, body);
    db.responses.push({ id: crypto.randomUUID(), formId: form.id, createdAt: new Date().toISOString(), answers });
    const sid = str(body.sid);
    if (/^[\w-]{8,64}$/.test(sid)) {
      const s = touchSession(form, sid);
      if (s) { s.started = true; s.submitted = true; }
    }
    persist();
    return json({ ok: true }, 201);
  });

  function touchSession(form, sid) {
    const map = (db.sessions[form.id] ||= {});
    if (!map[sid]) {
      if (Object.keys(map).length >= MAX_SESSIONS_PER_FORM) return null;
      map[sid] = { t: new Date().toISOString(), started: false, last: null, f: [], submitted: false };
    }
    return map[sid];
  }

  // --- страницы и статика
  const page = (name) => () => {
    try {
      return { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' }, body: fs.readFileSync(path.join(PUBLIC_DIR, name)) };
    } catch {
      throw new HttpError(404, 'Не найдено');
    }
  };
  const MIME = { '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

  route('GET', '/', () => ({ status: 302, headers: { Location: '/admin' }, body: '' }));
  route('GET', '/admin/?', page('admin.html'));
  route('GET', '/f/[\\w-]+', page('form.html'));
  route('GET', '/static/(?<name>[\\w.-]+)', ({ params }) => {
    const ext = path.extname(params.name);
    if (!MIME[ext]) throw new HttpError(404, 'Не найдено');
    try {
      return { status: 200, headers: { 'Content-Type': MIME[ext] }, body: fs.readFileSync(path.join(PUBLIC_DIR, params.name)) };
    } catch {
      throw new HttpError(404, 'Не найдено');
    }
  });

  /* ------------------------- сервер ------------------------- */
  function readJson(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on('data', (c) => {
        size += c.length;
        if (size > MAX_BODY) { reject(new HttpError(413, 'Слишком большой запрос')); req.destroy(); return; }
        chunks.push(c);
      });
      req.on('end', () => {
        if (!chunks.length) return resolve({});
        try {
          const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          resolve(v && typeof v === 'object' && !Array.isArray(v) ? v : {});
        } catch {
          reject(new HttpError(400, 'Некорректный JSON'));
        }
      });
      req.on('error', reject);
    });
  }

  const server = http.createServer(async (req, res) => {
    let out;
    try {
      const { pathname } = new URL(req.url, 'http://localhost');
      const method = req.method === 'HEAD' ? 'GET' : req.method;
      let matched = null;
      let pathExists = false;
      for (const r of routes) {
        const m = r.re.exec(pathname);
        if (!m) continue;
        pathExists = true;
        if (r.method === method) { matched = { r, params: m.groups || {} }; break; }
      }
      if (!matched) throw new HttpError(pathExists ? 405 : 404, pathExists ? 'Метод не поддерживается' : 'Не найдено');
      const body = method === 'GET' || method === 'DELETE' ? {} : await readJson(req);
      out = await matched.r.handler({ params: matched.params, body });
    } catch (e) {
      if (!(e instanceof HttpError)) console.error(e);
      const status = e instanceof HttpError ? e.status : 500;
      const msg = e instanceof HttpError ? e.message : 'Внутренняя ошибка сервера';
      out = json({ error: msg, details: e.details }, status);
    }
    res.writeHead(out.status, {
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'self'",
      ...out.headers,
    });
    res.end(req.method === 'HEAD' ? undefined : out.body);
  });

  server.flush = () => { if (timer) persist(); };
  server.on('close', server.flush);
  return server;
}

module.exports = { createApp };

if (require.main === module) {
  const PORT = Number(process.env.PORT) || 3000;
  const server = createApp();
  server.on('error', (e) => {
    console.error(e.code === 'EADDRINUSE' ? `Порт ${PORT} занят. Задайте другой: PORT=3001 npm start` : e);
    process.exit(1);
  });
  server.listen(PORT, () => {
    console.log(`Сервис форм запущен: http://localhost:${PORT}/admin`);
  });
  const stop = () => {
    server.flush();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
