'use strict';

const app = document.getElementById('app');
const TYPE_LABELS = {
  text: 'Короткий ответ',
  textarea: 'Длинный ответ',
  email: 'Email',
  tel: 'Телефон',
  number: 'Число',
  date: 'Дата',
  select: 'Выпадающий список',
  radio: 'Один вариант',
  checkbox: 'Несколько вариантов',
};
const CHOICE = ['select', 'radio', 'checkbox'];

const newFieldId = () => 'f' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const newField = () => ({ id: newFieldId(), label: '', type: 'text', required: false, options: [] });
const fmtDate = (iso) => new Date(iso).toLocaleString('ru-RU');
const pct = (a, b) => (b ? Math.round((a / b) * 100) + '%' : '—');
const linkFor = (slug) => `${location.origin}/f/${slug}`;

let toastTimer;
function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
}

async function copyLink(slug) {
  const url = linkFor(slug);
  try {
    await navigator.clipboard.writeText(url);
    toast('Ссылка скопирована');
  } catch {
    window.prompt('Скопируйте ссылку:', url);
  }
}

const btn = (text, onclick, cls = '') => h('button', { type: 'button', class: 'btn ' + cls, onclick }, text);

/* ------------------------------ список форм ------------------------------ */
async function listView() {
  const forms = await api('/forms');
  const head = h('div', { class: 'page-head' },
    h('h1', null, 'Формы'),
    h('a', { class: 'btn primary', href: '#/new' }, '+ Создать форму'));

  if (!forms.length) {
    app.replaceChildren(head, h('div', { class: 'card empty' },
      h('p', null, 'Пока нет ни одной формы.'),
      h('p', { class: 'muted' }, 'Создайте первую форму отклика — это займёт пару минут.')));
    return;
  }

  const rows = forms.map((f) => h('tr', null,
    h('td', null,
      h('a', { class: 'title-link', href: `#/edit/${f.id}` }, f.title),
      h('div', { class: 'muted small' }, `Создана ${fmtDate(f.createdAt)} · вопросов: ${f.fieldCount}`)),
    h('td', null, h('span', { class: 'badge ' + (f.published ? 'ok' : '') }, f.published ? 'Опубликована' : 'Черновик')),
    h('td', { class: 'num' }, String(f.responses)),
    h('td', { class: 'num' }, f.views ? `${pct(f.submitted, f.views)}` : '—'),
    h('td', { class: 'actions' },
      h('a', { class: 'btn small', href: `#/responses/${f.id}` }, 'Ответы'),
      h('a', { class: 'btn small', href: `#/edit/${f.id}` }, 'Изменить'),
      btn('Ссылка', () => copyLink(f.slug), 'small'),
      btn(f.published ? 'Снять с публикации' : 'Опубликовать', async () => {
        await api(`/forms/${f.id}/publish`, { method: 'POST', body: { published: !f.published } });
        toast(f.published ? 'Форма снята с публикации' : 'Форма опубликована');
        listView();
      }, 'small'),
      btn('Удалить', async () => {
        if (!confirm(`Удалить форму «${f.title}» и все ответы на неё?`)) return;
        await api(`/forms/${f.id}`, { method: 'DELETE' });
        listView();
      }, 'small danger'))));

  app.replaceChildren(head, h('div', { class: 'card table-wrap' },
    h('table', null,
      h('thead', null, h('tr', null,
        h('th', null, 'Название'), h('th', null, 'Статус'),
        h('th', { class: 'num' }, 'Ответов'), h('th', { class: 'num', title: 'Отправили / открыли форму' }, 'Конверсия'),
        h('th', null, ''))),
      h('tbody', null, rows))));
}

/* --------------------------- конструктор формы --------------------------- */
async function editorView(id) {
  let form = id
    ? await api('/forms/' + id)
    : { title: '', description: '', published: false, fields: [newField()] };

  const errBox = h('div', { class: 'errors', hidden: true });
  const fieldsBox = h('div', { class: 'fields' });

  function move(i, d) {
    const j = i + d;
    if (j < 0 || j >= form.fields.length) return;
    [form.fields[i], form.fields[j]] = [form.fields[j], form.fields[i]];
    renderFields();
  }

  function fieldCard(f, i) {
    const typeSel = h('select', {
      onchange: (e) => {
        f.type = e.target.value;
        if (CHOICE.includes(f.type) && !f.options) f.options = [];
        renderFields();
      },
    }, Object.entries(TYPE_LABELS).map(([v, l]) => h('option', { value: v }, l)));
    typeSel.value = f.type;

    f.options = f.options || [];
    return h('div', { class: 'card field-card' },
      h('div', { class: 'row' },
        h('span', { class: 'num-badge' }, String(i + 1)),
        h('input', {
          type: 'text', class: 'grow', maxlength: 300, placeholder: 'Текст вопроса',
          value: f.label, oninput: (e) => { f.label = e.target.value; },
        }),
        typeSel),
      CHOICE.includes(f.type) && h('textarea', {
        rows: 4, placeholder: 'Варианты ответа — по одному в строке',
        value: f.options.join('\n'),
        oninput: (e) => { f.options = e.target.value.split('\n'); },
      }),
      h('div', { class: 'row between' },
        h('label', { class: 'inline' },
          h('input', { type: 'checkbox', checked: f.required, onchange: (e) => { f.required = e.target.checked; } }),
          'Обязательный вопрос'),
        h('div', { class: 'row' },
          btn('↑', () => move(i, -1), 'small'),
          btn('↓', () => move(i, 1), 'small'),
          btn('Удалить', () => { form.fields.splice(i, 1); renderFields(); }, 'small danger'))));
  }

  function renderFields() {
    fieldsBox.replaceChildren(...form.fields.map(fieldCard));
  }

  const linkBox = h('div');
  function renderLink() {
    if (!form.slug) { linkBox.replaceChildren(); return; }
    const url = linkFor(form.slug);
    linkBox.replaceChildren(h('div', { class: 'card link-card' },
      h('strong', null, 'Ссылка для студентов'),
      h('div', { class: 'row' },
        h('input', { type: 'text', class: 'grow', readonly: true, value: url, onclick: (e) => e.target.select() }),
        btn('Копировать', () => copyLink(form.slug)),
        h('a', { class: 'btn', href: url, target: '_blank', rel: 'noopener' }, 'Открыть')),
      !form.published && h('p', { class: 'muted small' }, 'Форма сейчас черновик — по ссылке она станет доступна после публикации.')));
  }

  async function save() {
    errBox.hidden = true;
    const payload = { title: form.title, description: form.description, published: form.published, fields: form.fields };
    try {
      const saved = id
        ? await api('/forms/' + id, { method: 'PUT', body: payload })
        : await api('/forms', { method: 'POST', body: payload });
      toast('Сохранено');
      if (id) { form = saved; render(); } else location.hash = '#/edit/' + saved.id;
    } catch (e) {
      const list = Array.isArray(e.details) ? e.details : [e.message];
      errBox.replaceChildren(...list.map((m) => h('div', null, m)));
      errBox.hidden = false;
      errBox.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }

  function render() {
    renderFields();
    renderLink();
    app.replaceChildren(
      h('div', { class: 'page-head' },
        h('div', null, h('a', { href: '#/', class: 'muted' }, '← К списку форм'),
          h('h1', null, id ? 'Редактирование формы' : 'Новая форма')),
        id && h('a', { class: 'btn', href: `#/responses/${id}` }, 'Ответы')),
      linkBox,
      h('div', { class: 'card' },
        h('label', { class: 'label' }, 'Название формы'),
        h('input', {
          type: 'text', maxlength: 200, placeholder: 'Например: Отклик на стажировку «Frontend»',
          value: form.title, oninput: (e) => { form.title = e.target.value; },
        }),
        h('label', { class: 'label' }, 'Описание (необязательно)'),
        h('textarea', {
          rows: 3, maxlength: 2000, placeholder: 'Пара слов для студента: о чём форма, до какого числа принимаем отклики…',
          value: form.description, oninput: (e) => { form.description = e.target.value; },
        })),
      h('h2', null, 'Вопросы'),
      fieldsBox,
      btn('+ Добавить вопрос', () => { form.fields.push(newField()); renderFields(); }, 'add'),
      errBox,
      h('div', { class: 'card save-bar' },
        h('label', { class: 'inline' },
          h('input', { type: 'checkbox', checked: form.published, onchange: (e) => { form.published = e.target.checked; } }),
          'Опубликована (доступна по ссылке)'),
        btn('Сохранить', save, 'primary')));
  }

  render();
}

/* ------------------------------ ответы + аналитика ------------------------------ */
async function responsesView(id) {
  const { form, columns, responses, stats } = await api(`/forms/${id}/responses`);

  const stat = (label, value, hint) => h('div', { class: 'stat' },
    h('div', { class: 'stat-value' }, String(value)),
    h('div', { class: 'stat-label' }, label),
    hint && h('div', { class: 'muted small' }, hint));

  const funnelRows = stats.fields.map((f, i) => h('tr', null,
    h('td', null, `${i + 1}. ${f.label}`),
    h('td', { class: 'num' }, String(f.reached)),
    h('td', { class: 'num' }, pct(f.reached, stats.views)),
    h('td', { class: 'num' }, f.leftHere ? h('span', { class: 'badge warn' }, String(f.leftHere)) : '0')));

  const header = h('tr', null, h('th', null, 'Дата'), columns.map((c) => h('th', null, c.label)));
  const body = responses.map((r) => {
    const byId = new Map(r.answers.map((a) => [a.id, a.value]));
    return h('tr', null,
      h('td', { class: 'nowrap' }, fmtDate(r.createdAt)),
      columns.map((c) => {
        const v = byId.get(c.id);
        return h('td', { class: 'answer' }, Array.isArray(v) ? v.join(', ') : v ?? '');
      }));
  });

  app.replaceChildren(
    h('div', { class: 'page-head' },
      h('div', null, h('a', { href: '#/', class: 'muted' }, '← К списку форм'), h('h1', null, form.title)),
      h('div', { class: 'row' },
        h('a', { class: 'btn', href: `#/edit/${form.id}` }, 'Изменить форму'),
        responses.length > 0 && h('a', { class: 'btn primary', href: `/api/forms/${form.id}/responses.csv` }, 'Скачать CSV'))),

    h('div', { class: 'stats' },
      stat('Открыли форму', stats.views),
      stat('Начали заполнять', stats.started, pct(stats.started, stats.views) + ' от открывших'),
      stat('Отправили', stats.submitted, pct(stats.submitted, stats.views) + ' конверсия'),
      stat('Всего ответов', stats.responses)),

    h('h2', null, 'Где студенты бросают форму'),
    stats.views === 0
      ? h('div', { class: 'card muted' }, 'Данных пока нет — они появятся, когда студенты начнут открывать форму по ссылке.')
      : h('div', { class: 'card table-wrap' },
        h('table', null,
          h('thead', null, h('tr', null,
            h('th', null, 'Вопрос'),
            h('th', { class: 'num', title: 'Сколько человек дошли до этого вопроса' }, 'Дошли'),
            h('th', { class: 'num' }, '% от открывших'),
            h('th', { class: 'num', title: 'Последний вопрос, с которым работал человек, не отправивший форму' }, 'Ушли здесь'))),
          h('tbody', null, funnelRows)),
        h('p', { class: 'muted small pad' }, '«Ушли здесь» — люди, которые начали заполнять форму, не отправили её, и чей последний открытый вопрос — этот. Вопрос с высоким числом — кандидат на упрощение или удаление.')),

    h('h2', null, `Ответы (${responses.length})`),
    responses.length === 0
      ? h('div', { class: 'card muted' }, 'Ответов пока нет.')
      : h('div', { class: 'card table-wrap' }, h('table', null, h('thead', null, header), h('tbody', null, body))));
}

/* ------------------------------ роутер ------------------------------ */
async function router() {
  const hash = location.hash.replace(/^#/, '') || '/';
  app.replaceChildren(h('p', { class: 'muted' }, 'Загрузка…'));
  window.scrollTo(0, 0);
  try {
    let m;
    if (hash === '/') await listView();
    else if (hash === '/new') await editorView(null);
    else if ((m = hash.match(/^\/edit\/([\w-]+)$/))) await editorView(m[1]);
    else if ((m = hash.match(/^\/responses\/([\w-]+)$/))) await responsesView(m[1]);
    else location.hash = '#/';
  } catch (e) {
    app.replaceChildren(h('div', { class: 'card error-card' },
      h('p', null, e.message),
      h('a', { href: '#/', class: 'btn' }, 'К списку форм')));
  }
}

window.addEventListener('hashchange', router);
router();
