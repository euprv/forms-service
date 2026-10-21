'use strict';

const root = document.getElementById('app');
const slug = location.pathname.split('/')[2];

// идентификатор «сессии» — нужен только для аналитики (где бросают форму)
const sidKey = 'sid:' + slug;
let sid = null;
try { sid = sessionStorage.getItem(sidKey); } catch { /* приватный режим */ }
if (!sid) {
  sid = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36);
  try { sessionStorage.setItem(sidKey, sid); } catch { /* ignore */ }
}

function track(type, fieldId) {
  fetch(`/api/public/${slug}/track`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sid, type, fieldId }),
    keepalive: true,
  }).catch(() => {});
}

function control(f) {
  const name = f.id;
  switch (f.type) {
    case 'textarea':
      return h('textarea', { name, rows: 4, maxlength: 5000 });
    case 'select': {
      const s = h('select', { name }, h('option', { value: '' }, '— Выберите —'), f.options.map((o) => h('option', { value: o }, o)));
      return s;
    }
    case 'radio':
    case 'checkbox':
      return h('div', { class: 'choices' }, f.options.map((o) =>
        h('label', { class: 'choice' }, h('input', { type: f.type, name, value: o }), h('span', null, o))));
    case 'number':
      return h('input', { type: 'number', name, step: 'any' });
    case 'email':
      return h('input', { type: 'email', name, maxlength: 254, autocomplete: 'email' });
    case 'tel':
      return h('input', { type: 'tel', name, maxlength: 25, autocomplete: 'tel' });
    case 'date':
      return h('input', { type: 'date', name });
    default:
      return h('input', { type: 'text', name, maxlength: 1000 });
  }
}

function readValue(form, f) {
  if (f.type === 'checkbox') return [...form.querySelectorAll(`input[name="${f.id}"]:checked`)].map((i) => i.value);
  if (f.type === 'radio') {
    const c = form.querySelector(`input[name="${f.id}"]:checked`);
    return c ? c.value : '';
  }
  return form.elements[f.id].value.trim();
}

function showForm(def) {
  document.title = def.title;
  const formEl = h('form', { novalidate: true });
  const wrappers = new Map();

  for (const f of def.fields) {
    const err = h('div', { class: 'error-text', role: 'alert' });
    const wrap = h('div', { class: 'field', 'data-field': f.id },
      h('label', { class: 'label' }, f.label, f.required && h('span', { class: 'req', title: 'Обязательно' }, ' *')),
      control(f), err);
    wrappers.set(f.id, { wrap, err });
    formEl.append(wrap);
  }

  const submit = h('button', { type: 'submit', class: 'btn primary big' }, 'Отправить');
  const general = h('div', { class: 'errors', hidden: true });
  formEl.append(general, submit);

  function setErrors(errors) {
    let first = null;
    for (const f of def.fields) {
      const { wrap, err } = wrappers.get(f.id);
      const msg = errors[f.id] || '';
      err.textContent = msg;
      wrap.classList.toggle('invalid', Boolean(msg));
      if (msg && !first) first = wrap;
    }
    if (first) {
      first.scrollIntoView({ behavior: 'smooth', block: 'center' });
      const input = first.querySelector('input, select, textarea');
      if (input) input.focus({ preventScroll: true });
    }
  }

  // аналитика: фиксируем, к какому вопросу человек перешёл
  let lastTracked = null;
  formEl.addEventListener('focusin', (e) => {
    const wrap = e.target.closest('[data-field]');
    if (!wrap || wrap.dataset.field === lastTracked) return;
    lastTracked = wrap.dataset.field;
    track('field', lastTracked);
  });
  // как только значение изменилось — стираем ошибку у этого поля
  formEl.addEventListener('input', (e) => {
    const wrap = e.target.closest('[data-field]');
    if (!wrap) return;
    wrap.classList.remove('invalid');
    wrappers.get(wrap.dataset.field).err.textContent = '';
  });

  formEl.addEventListener('submit', async (e) => {
    e.preventDefault();
    general.hidden = true;

    const answers = {};
    const errors = {};
    for (const f of def.fields) {
      const v = readValue(formEl, f);
      answers[f.id] = v;
      const empty = Array.isArray(v) ? v.length === 0 : v === '';
      if (empty && f.required) errors[f.id] = 'Обязательное поле';
      else if (!empty && f.type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) errors[f.id] = 'Введите корректный email';
    }
    setErrors(errors);
    if (Object.keys(errors).length) return;

    submit.disabled = true;
    submit.textContent = 'Отправляем…';
    try {
      await api(`/public/${slug}/submit`, { method: 'POST', body: { sid, answers } });
      root.replaceChildren(h('div', { class: 'card thanks' },
        h('div', { class: 'check' }, '✓'),
        h('h1', null, 'Спасибо!'),
        h('p', null, 'Ваш ответ отправлен.')));
      try { sessionStorage.removeItem(sidKey); } catch { /* ignore */ }
    } catch (err) {
      submit.disabled = false;
      submit.textContent = 'Отправить';
      if (err.details && !Array.isArray(err.details)) setErrors(err.details);
      else { general.textContent = err.message; general.hidden = false; }
    }
  });

  root.replaceChildren(h('div', { class: 'card form-card' },
    h('h1', null, def.title),
    def.description && h('p', { class: 'description' }, def.description),
    formEl));
}

(async () => {
  try {
    const def = await api('/public/' + slug);
    showForm(def);
    track('view');
  } catch (e) {
    document.title = 'Форма недоступна';
    root.replaceChildren(h('div', { class: 'card thanks' }, h('h1', null, 'Форма недоступна'), h('p', null, e.message)));
  }
})();
