'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../server');

let server, base, dir;
test.before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forms-'));
  server = createApp({ dataDir: dir });
  await new Promise((r) => server.listen(0, r));
  base = `http://localhost:${server.address().port}`;
});
test.after(async () => {
  await new Promise((r) => server.close(r));
  fs.rmSync(dir, { recursive: true, force: true });
});

const call = async (method, url, body) => {
  const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const ct = res.headers.get('content-type') || '';
  return { status: res.status, data: ct.includes('json') ? await res.json() : await res.text() };
};

test('полный сценарий MVP', async () => {
  // страницы
  assert.equal((await call('GET', '/admin')).status, 200);
  assert.equal((await call('GET', '/static/admin.js')).status, 200);

  // валидация конструктора
  assert.equal((await call('POST', '/api/forms', { title: '', fields: [] })).status, 400);
  assert.equal((await call('POST', '/api/forms', { title: 'X', fields: [{ label: 'A', type: 'select', options: ['one'] }] })).status, 400);

  // 1. менеджер создаёт форму
  const created = await call('POST', '/api/forms', {
    title: 'Стажировка',
    fields: [
      { id: 'name', label: 'Имя', type: 'text', required: true },
      { id: 'mail', label: 'Email', type: 'email', required: true },
      { id: 'lang', label: 'Языки', type: 'checkbox', options: ['JS', 'Python'] },
      { id: 'about', label: 'О себе', type: 'textarea' },
    ],
  });
  assert.equal(created.status, 201);
  const { id, slug } = created.data;

  // 2. неопубликованная форма недоступна
  assert.equal((await call('GET', `/api/public/${slug}`)).status, 404);
  await call('POST', `/api/forms/${id}/publish`, { published: true });
  const pub = await call('GET', `/api/public/${slug}`);
  assert.equal(pub.status, 200);
  assert.equal(pub.data.fields.length, 4);
  assert.equal((await call('GET', `/f/${slug}`)).status, 200);

  // 3. студент: аналитика + ответ
  const sid = 'session-aaaa-1111';
  await call('POST', `/api/public/${slug}/track`, { sid, type: 'view' });
  await call('POST', `/api/public/${slug}/track`, { sid, type: 'field', fieldId: 'name' });
  const bad = await call('POST', `/api/public/${slug}/submit`, { sid, answers: { name: '', mail: 'nope' } });
  assert.equal(bad.status, 400);
  assert.ok(bad.data.details.name && bad.data.details.mail);

  const ok = await call('POST', `/api/public/${slug}/submit`, {
    sid, answers: { name: '<script>alert(1)</script>', mail: 'a@b.ru', lang: ['JS', 'Hack'], about: '=cmd|x' },
  });
  assert.equal(ok.status, 201);

  // брошенная сессия
  const sid2 = 'session-bbbb-2222';
  await call('POST', `/api/public/${slug}/track`, { sid: sid2, type: 'view' });
  await call('POST', `/api/public/${slug}/track`, { sid: sid2, type: 'field', fieldId: 'mail' });

  // 4. менеджер смотрит ответы
  const r = await call('GET', `/api/forms/${id}/responses`);
  assert.equal(r.data.responses.length, 1);
  assert.deepEqual(r.data.responses[0].answers.find((a) => a.id === 'lang').value, ['JS']);
  assert.equal(r.data.stats.views, 2);
  assert.equal(r.data.stats.submitted, 1);
  assert.equal(r.data.stats.fields.find((f) => f.id === 'mail').leftHere, 1);

  const csv = await call('GET', `/api/forms/${id}/responses.csv`);
  assert.equal(csv.status, 200);
  assert.ok(csv.data.includes("'=cmd|x"));

  // редактирование не ломает старые ответы
  await call('PUT', `/api/forms/${id}`, { title: 'Стажировка 2', fields: [{ id: 'name', label: 'Имя', type: 'text' }] });
  const r2 = await call('GET', `/api/forms/${id}/responses`);
  assert.ok(r2.data.columns.some((c) => c.label.includes('удалён')));

  // данные переживают перезапуск
  server.flush();
  const copy = createApp({ dataDir: dir });
  await new Promise((res) => copy.listen(0, res));
  const again = await fetch(`http://localhost:${copy.address().port}/api/forms`).then((x) => x.json());
  assert.equal(again.length, 1);
  await new Promise((res) => copy.close(res));

  // удаление
  assert.equal((await call('DELETE', `/api/forms/${id}`)).status, 200);
  assert.equal((await call('GET', `/api/forms/${id}`)).status, 404);
});
