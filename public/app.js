/* Presenze - logica della pagina.
 * ?demo=<scenario> gira su dati finti, senza server e senza toccare yoU@B:
 *   open | wait | classic | error | empty | login
 */
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
};
const hhmm = (iso) => iso.slice(11, 16);
const DEMO = new URLSearchParams(location.search).get('demo');

// ------------------------------------------------------------------ api

class ApiError extends Error {}

async function api(path, body) {
  if (DEMO) return demoApi(path, body);
  const r = await fetch(path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
  const j = await r.json().catch(() => ({}));
  if (r.status === 401 && !j.relogin) {
    show('login');
    throw new ApiError(j.error || 'Collega yoU@B per continuare.');
  }
  if (!r.ok) throw Object.assign(new ApiError(j.error || r.statusText), { relogin: !!j.relogin });
  return j;
}

// ------------------------------------------------------------------ schermate

function show(screen) {
  $('#screen-login').classList.toggle('hidden', screen !== 'login');
  $('#screen-app').classList.toggle('hidden', screen !== 'app');
}

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 3800);
}

function setView(view) {
  for (const v of ['home', 'log', 'settings']) $('#view-' + v).classList.toggle('hidden', v !== view);
  $$('.tab').forEach((t) => t.setAttribute('aria-selected', String(t.dataset.view === view)));
  store.set('presenze_view', view);
  window.scrollTo({ top: 0 });
}

// ------------------------------------------------------------------ hero

/** Il foglio in cima dice in una riga se l'app sta lavorando per te. */
function heroFor(d) {
  if (d.sessionError)
    return { tone: 'danger', l2: 'non attive', sub: d.sessionError, icon: 'alert', cta: { label: 'Ricollega yoU@B', cls: 'btn-danger', act: 'relogin' } };
  if (d.mode === 'assisted' && d.campus)
    return { tone: 'primary', l2: 'automatiche', sub: 'Sei in Bocconi: registro da solo le lezioni di adesso.', icon: 'ok', pulse: true };
  if (d.mode === 'assisted')
    return { tone: 'idle', l2: 'in attesa', sub: 'Registro da solo appena il telefono entra sul Wi-Fi Bocconi.', icon: 'wait' };
  if (d.mode === 'classic')
    return { tone: 'primary', l2: 'manuali', sub: 'Quando il docente apre la rilevazione, la registri tu con un tocco.', icon: 'ok' };
  return { tone: 'primary', l2: 'attive', sub: 'Modalità impostata fuori dall’app.', icon: 'ok' };
}

function renderHero(d) {
  const h = heroFor(d);
  const hero = $('#hero');
  hero.dataset.tone = h.tone;
  hero.dataset.pulse = String(!!h.pulse);
  $('#hero-l2').textContent = h.l2;
  $('#hero-sub').textContent = h.sub;
  $('#hero-icon').setAttribute('href', `#i-shield-${h.icon}`);
  const cta = $('#hero-cta');
  cta.classList.toggle('hidden', !h.cta);
  cta.innerHTML = h.cta ? `<button class="btn ${h.cta.cls}" data-act="${h.cta.act}">${esc(h.cta.label)}</button>` : '';
}

// ------------------------------------------------------------------ lezioni

const mins = (a, b) => (Date.parse(b + 'Z') - Date.parse(a + 'Z')) / 60000;

function lessonView(l, now) {
  const live = mins(now, l.start) <= 15 && mins(now, l.end) > 0;
  const over = mins(now, l.end) <= 0;
  if (l.state === 'registered') return { pill: ['ok', 'Registrata'], now: false, done: over };
  if (l.state === 'open') return { pill: ['live', 'Rilevazione aperta'], now: true, action: true };
  if (l.state === 'not_found' || l.state === 'error') return { pill: ['bad', 'Non trovata'], now: false };
  if (over) return { pill: ['', 'Finita'], done: true };
  if (live) return { pill: ['warn', 'In attesa del docente'], now: true };
  return { pill: ['', `Alle ${hhmm(l.start)}`] };
}

function renderLessons(d) {
  const box = $('#lessons');
  if (!d.lessons.length) {
    box.innerHTML = `<div class="card empty">
      <div class="empty-icon"><svg width="26" height="26" aria-hidden="true"><use href="#i-cal"/></svg></div>
      <div style="font-weight:800">Nessuna lezione oggi</div>
      <div class="small muted">Il calendario di yoU@B per oggi è vuoto.</div>
    </div>`;
    return;
  }
  box.innerHTML = d.lessons
    .map((l) => {
      const v = lessonView(l, d.now);
      const btn = v.action
        ? `<div class="lesson-action"><button class="btn ${v.now ? 'btn-light' : 'btn-primary'}" data-reg="${esc(l.extcode)}" data-start="${hhmm(l.start)}">Registra la presenza</button></div>`
        : '';
      return `<article class="card lesson${v.now ? ' is-now' : ''}${v.done ? ' is-done' : ''}">
        <div class="lesson-head"><span class="lesson-time">${hhmm(l.start)} – ${hhmm(l.end)}</span><span class="pill ${v.pill[0]}">${esc(v.pill[1])}</span></div>
        <h3 class="lesson-course">${esc(l.course)}</h3>
        <div class="lesson-meta">${esc(l.room)}${l.teachers ? ' · ' + esc(l.teachers) : ''}</div>
        ${btn}
      </article>`;
    })
    .join('');
}

// ------------------------------------------------------------------ attivita' e impostazioni

function renderLog(d) {
  $('#log').innerHTML = d.log.length
    ? d.log.slice(0, 40).map((r) => `<div class="row"><span class="row-t">${hhmm(r.t)}</span><span>${esc(r.msg)}</span></div>`).join('')
    : '<div class="empty small muted">Ancora niente: qui compare ogni presenza registrata.</div>';
}

function renderSettings(d) {
  $$('.mode').forEach((m) => m.setAttribute('aria-checked', String(m.dataset.mode === d.mode)));
  $('#assisted-setup').classList.toggle('hidden', d.mode !== 'assisted');
  $('#campus-state').textContent = d.campus ? `Sì, dalle ${hhmm(d.campus.t)}` : 'Non rilevato';
  $('#acc-user').textContent = d.username || '—';
  $('#acc-session').textContent = d.sessionError ? 'Da ricollegare' : 'Collegato';
  const token = store.get('ab_token');
  const missing = 'Ricollega yoU@B da questo dispositivo per vedere il link.';
  $('#signal-url').textContent = token ? `${location.origin}/api/signal?k=${token}` : missing;
  $('#mcp-url').textContent = token ? `${location.origin}/mcp?k=${token}` : missing;
}

// ------------------------------------------------------------------ ciclo

let current = null;

async function refresh() {
  let d;
  try {
    d = await api('/api/status');
  } catch {
    return;
  }
  current = d;
  show('app');
  renderHero(d);
  renderLessons(d);
  renderLog(d);
  renderSettings(d);
}

// ------------------------------------------------------------------ eventi

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('#login-btn');
  const err = $('#login-error');
  err.textContent = '';
  if (!$('#u').value.trim() || !$('#p').value) {
    err.textContent = 'Inserisci matricola e password.';
    return;
  }
  btn.disabled = true;
  btn.textContent = 'Collego…';
  try {
    const r = await api('/api/login', { username: $('#u').value.trim(), password: $('#p').value });
    if (r.token) store.set('ab_token', r.token);
    $('#p').value = '';
    await refresh();
    toast('yoU@B collegato. Non dovrai più rifare il login.');
  } catch (ex) {
    err.textContent = ex.message;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Collega yoU@B';
  }
});

$$('.tab').forEach((t) => t.addEventListener('click', () => setView(t.dataset.view)));

$$('.mode').forEach((m) =>
  m.addEventListener('click', async () => {
    if (current?.mode === m.dataset.mode) return;
    $$('.mode').forEach((x) => x.setAttribute('aria-checked', String(x === m)));
    try {
      await api('/api/mode', { mode: m.dataset.mode });
      toast(m.dataset.mode === 'assisted' ? 'Assistita: registro da solo quando sei in Bocconi.' : 'Classica: la presenza la metti tu.');
    } catch (ex) {
      toast(ex.message);
    }
    refresh();
  })
);

document.addEventListener('click', async (e) => {
  const act = e.target.closest('[data-act]');
  if (act?.dataset.act === 'relogin') return show('login');

  const reg = e.target.closest('button[data-reg]');
  if (!reg) return;
  reg.disabled = true;
  reg.textContent = 'Registro…';
  try {
    const r = await api('/api/register', { extcode: reg.dataset.reg, start: reg.dataset.start });
    toast(r.msg);
  } catch (ex) {
    toast(ex.message);
  }
  refresh();
});

$('#check-here').addEventListener('click', () => {
  const b = $('#check-here');
  b.disabled = true;
  b.textContent = 'Controllo…';
  const send = async (pos) => {
    try {
      const body = pos ? { lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy } : {};
      toast((await api('/api/signal', body)).msg);
    } catch (ex) {
      toast(ex.message);
    }
    b.disabled = false;
    b.textContent = 'Controlla adesso';
    refresh();
  };
  // Il server vede gia' l'IP da cui arrivi; la posizione e' un segnale in piu', se il browser la concede.
  if (!navigator.geolocation || !isSecureContext) return send(null);
  navigator.geolocation.getCurrentPosition(send, () => send(null), { enableHighAccuracy: true, timeout: 10000 });
});

$('#logout').addEventListener('click', async () => {
  if (!confirm('Scollegare yoU@B? Le credenziali salvate vengono cancellate.')) return;
  try {
    await api('/api/logout', {});
  } catch {}
  show('login');
});

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && current) refresh();
});
setInterval(() => {
  if (!document.hidden && current) refresh();
}, 60000);

setView(['home', 'log', 'settings'].includes(store.get('presenze_view')) ? store.get('presenze_view') : 'home');
refresh();

// ------------------------------------------------------------------ demo

function demoApi(path, body) {
  const S = (demoApi.s ||= demoState(DEMO));
  if (S.screen === 'login' && path !== '/api/login') {
    show('login');
    return Promise.reject(new ApiError('login'));
  }
  if (path === '/api/status') return Promise.resolve(structuredClone(S.d));
  if (path === '/api/login') {
    S.screen = 'app';
    return Promise.resolve({ ok: true, token: 'demo-token' });
  }
  if (path === '/api/mode') S.d.mode = body.mode;
  if (path === '/api/register') {
    const l = S.d.lessons.find((x) => x.extcode === body.extcode);
    l.state = 'registered';
    const row = { t: S.d.now, kind: 'registered', msg: `${l.course}: Presenza registrata.` };
    S.d.log.unshift(row);
    return Promise.resolve(row);
  }
  if (path === '/api/signal') {
    S.d.campus = { t: S.d.now, how: 'wifi', detail: 'rete Bocconi (193.205.20.17)' };
    return Promise.resolve({ msg: 'Sei in Bocconi (rete Bocconi).' });
  }
  if (path === '/api/logout') S.screen = 'login';
  return Promise.resolve({ ok: true });
}

function demoState(kind) {
  const now = '2026-10-05T16:35:00';
  const L = (start, end, course, room, teachers, state) => ({
    extcode: course.slice(0, 5) + '_01_2026',
    start: `2026-10-05T${start}:00`,
    end: `2026-10-05T${end}:00`,
    course,
    room,
    teachers,
    state,
  });
  const lessons = [
    L('08:30', '10:00', 'Fondamenti di organizzazione', 'Aula D · Sarfatti 25', 'Magni M.', 'registered'),
    L('13:00', '14:30', "Gestione della tecnologia, dell'innovazione e delle operations", 'Aula Maggiore · Sarfatti 25, piano 2', 'Vicari S. · Veronesi V.', 'registered'),
    L('16:30', '19:00', 'Strategia competitiva', 'Aula D · Sarfatti 25, pianoterra', 'Dagnino I.', kind === 'wait' ? 'not_open' : 'open'),
    L('19:15', '20:45', 'Venture and development capital', 'Aula 22 · Sarfatti 25, piano 2', 'Zara C.', 'later'),
  ];
  const log = [
    { t: '2026-10-05T13:04:00', kind: 'registered', msg: "Gestione della tecnologia: presenza registrata (rete Bocconi)." },
    { t: '2026-10-05T08:36:00', kind: 'registered', msg: 'Fondamenti di organizzazione: presenza registrata.' },
    { t: '2026-10-05T08:21:00', kind: 'campus', msg: 'Sei in Bocconi (rete Bocconi 193.205.20.17).' },
  ];
  const d = {
    username: '1234567',
    now,
    mode: kind === 'classic' ? 'classic' : 'assisted',
    campus: kind === 'open' ? { t: '2026-10-05T16:22:00', how: 'wifi', detail: 'rete Bocconi' } : null,
    sessionError: kind === 'error' ? 'La sessione yoU@B non risponde: ricollega il tuo account.' : null,
    lessons: kind === 'empty' ? [] : lessons,
    log: kind === 'empty' ? [] : log,
  };
  return { screen: kind === 'login' ? 'login' : 'app', d };
}
