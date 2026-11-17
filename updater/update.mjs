// Подсчёт игровых постов для форума на mybb/rusff.
// Запускается в GitHub Actions (Node 20+, без зависимостей).
//
// Логика: у каждой темы есть отпечаток (last_post_id + num_replies).
// Пересчитываем только темы, у которых отпечаток изменился.
// Обычный запуск берёт темы всех разделов, отсортированные по последнему посту, и читает
// только верх списка — темы, где писали после прошлого запуска (с запасом в час).
// Так видны и новые посты в архивах, и эпизоды, унесённые в архив сразу после поста.
// Полная проверка (FULL=true или первый запуск) читает все темы и убирает удалённые.
// Первый пост темы (наименьший id) не считается. Посты гостя (user_id <= 1) не считаются.
//
// Ограничение нагрузки:
//  - запросы строго по одному, с паузой MIN_INTERVAL_MS между ними;
//  - не больше MAX_REQUESTS запросов за запуск; что не успели — досчитается в следующий запуск;
//  - при 429/5xx/сетевой ошибке — пауза с нарастанием; после 3 ошибок подряд запуск
//    останавливается и сохраняет то, что успел посчитать.

import fs from 'node:fs';
import path from 'node:path';

const env = process.env;
const FORUM_URL = (env.FORUM_URL || '').replace(/\/+$/, '');
const LOGIN = env.FORUM_LOGIN || '';
const PASSWORD = env.FORUM_PASSWORD || '';
const FORUMS = (env.FORUMS || '19,20,21,65').split(',').map(Number);
const FULL = env.FULL === 'true';
const DATA_DIR = env.DATA_DIR || 'data';
const MAX_REQUESTS = +env.MAX_REQUESTS || 400;
const MIN_INTERVAL_MS = +env.MIN_INTERVAL_MS || 1500;
const DRY_RUN = env.DRY_RUN === 'true';
const CHECK_UIDS = (env.CHECK_UIDS || '').split(',').filter(Boolean);
const PAGE = 100;
const OVERLAP_S = 3600; // запас по времени при чтении «свежих» тем

if (!FORUM_URL || !LOGIN || !PASSWORD) {
  console.error('Нужны FORUM_URL, FORUM_LOGIN, FORUM_PASSWORD');
  process.exit(1);
}

// ---------- HTTP с ограничением частоты ----------

const cookies = new Map();
let requestsUsed = 0;
let lastRequestAt = 0;

class BudgetExhausted extends Error {}
class StopRun extends Error {}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function saveCookies(res) {
  const list = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  for (const c of list) {
    const [pair] = c.split(';');
    const i = pair.indexOf('=');
    if (i > 0) cookies.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
  }
}

async function request(url, options = {}) {
  let failures = 0;
  for (;;) {
    if (requestsUsed >= MAX_REQUESTS) throw new BudgetExhausted();
    const wait = lastRequestAt + MIN_INTERVAL_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastRequestAt = Date.now();
    requestsUsed++;

    let res;
    try {
      res = await fetch(url, {
        ...options,
        redirect: 'manual',
        headers: {
          'User-Agent': 'gamepost-counter (GitHub Actions)',
          Cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join('; '),
          ...(options.headers || {}),
        },
      });
      saveCookies(res);
      if (res.status === 429 || res.status >= 500) throw new Error('HTTP ' + res.status);
      return res;
    } catch (e) {
      failures++;
      if (failures >= 3) throw new StopRun('Три ошибки подряд: ' + e.message);
      const retryAfter = res && +res.headers.get('retry-after');
      const pause = retryAfter ? retryAfter * 1000 : 10000 * 3 ** (failures - 1); // 10 с, 30 с
      console.warn(`${e.message}, пауза ${pause / 1000} с`);
      await sleep(pause);
    }
  }
}

async function api(params) {
  const url = `${FORUM_URL}/api.php?` + new URLSearchParams(params);
  const res = await request(url);
  const json = JSON.parse(await res.text());
  if (json.error) throw new StopRun(`API ${params.method}: ${json.error.message}`);
  return json.response || [];
}

// ---------- Вход под аккаунтом-читателем ----------

async function login() {
  // Берём скрытые поля формы входа, чтобы не зависеть от их состава.
  const page = await (await request(`${FORUM_URL}/login.php`)).text();
  const form = (page.match(/<form[^>]*id="login"[\s\S]*?<\/form>/i) || [page])[0];
  const body = new URLSearchParams();
  for (const m of form.matchAll(/<input[^>]*type="hidden"[^>]*>/gi)) {
    const name = (m[0].match(/name="([^"]*)"/) || [])[1];
    const value = (m[0].match(/value="([^"]*)"/) || [, ''])[1];
    if (name) body.set(name, value);
  }
  body.set('form_sent', '1');
  body.set('req_username', LOGIN);
  body.set('req_password', PASSWORD);
  await request(`${FORUM_URL}/login.php?action=in`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const probe = await api({ method: 'topic.get', forum_id: FORUMS[0], limit: 1 });
  if (!probe.length) throw new StopRun('Вход не удался или у читателя нет доступа к разделу ' + FORUMS[0]);
}

// ---------- Подсчёт ----------

// Все темы раздела. Форум не даёт листать дальше skip = 10000, поэтому большой раздел
// читаем с двух концов одного и того же порядка (по последнему посту): сначала от старых,
// потом от новых — пока не встретим уже прочитанную тему.
const MAX_SKIP = 10000;

function checkOrder(page, forumId, dir) {
  let prev = dir === 'asc' ? -Infinity : Infinity;
  for (const t of page) {
    if (t.sticky === '1') continue; // закреплённые могут стоять вне сортировки
    const d = +t.last_post_date;
    if (dir === 'asc' ? d < prev : d > prev) {
      throw new StopRun(`Раздел ${forumId}: темы пришли не по дате последнего поста (${dir}).`);
    }
    prev = d;
  }
}

async function listTopics(forumId) {
  const seen = new Map();
  const params = { method: 'topic.get', forum_id: forumId, limit: PAGE, sort_by: 'last_post' };
  for (let skip = 0; ; skip += PAGE) {
    const page = await api({ ...params, sort_dir: 'asc', skip });
    checkOrder(page, forumId, 'asc');
    for (const t of page) seen.set(t.id, t);
    if (page.length < PAGE) return [...seen.values()]; // раздел прочитан целиком
    if (skip + PAGE > MAX_SKIP) break;
  }
  for (let skip = 0; ; skip += PAGE) {
    const page = await api({ ...params, sort_dir: 'desc', skip });
    checkOrder(page, forumId, 'desc');
    let met = false;
    for (const t of page) {
      if (seen.has(t.id)) { if (t.sticky !== '1') met = true; } else seen.set(t.id, t);
    }
    if (met || page.length < PAGE) return [...seen.values()];
    if (skip + PAGE > MAX_SKIP) throw new StopRun(`Раздел ${forumId}: больше ${2 * (MAX_SKIP + PAGE)} тем, полная проверка невозможна.`);
  }
}

// Темы раздела, где писали не раньше since (сортировка по последнему посту).
async function listRecent(forumId, since) {
  const out = [];
  for (let skip = 0; ; skip += PAGE) {
    const page = await api({ method: 'topic.get', forum_id: forumId, limit: PAGE, skip, sort_by: 'last_post', sort_dir: 'desc' });
    // Защита: если форум перестал сортировать, без неё мы бы молча пропускали темы.
    // Проверяем порядок на всей странице до того, как решать, где остановиться.
    checkOrder(page, forumId, 'desc');
    for (const t of page) {
      if (t.sticky === '1') { out.push(t); continue; }
      if (+t.last_post_date < since) return out;
      out.push(t);
    }
    if (page.length < PAGE) return out;
  }
}

// Посты пачки тем (сумма постов в пачке <= 100) или одной большой темы постранично.
async function fetchPosts(topicIds, expectedTotal) {
  const params = { method: 'post.get', topic_id: topicIds.join(','), fields: 'id,topic_id,user_id', limit: PAGE };
  if (expectedTotal <= PAGE) return api(params);
  const out = [];
  for (let skip = 0; ; skip += PAGE) {
    const page = await api({ ...params, skip });
    out.push(...page);
    if (page.length < PAGE) return out;
  }
}

function countByUser(posts) {
  const byTopic = new Map();
  for (const p of posts) {
    if (!byTopic.has(p.topic_id)) byTopic.set(p.topic_id, []);
    byTopic.get(p.topic_id).push(p);
  }
  const result = new Map();
  for (const [tid, list] of byTopic) {
    const firstId = Math.min(...list.map((p) => +p.id));
    const c = {};
    for (const p of list) {
      if (+p.id === firstId || +p.user_id <= 1) continue;
      c[p.user_id] = (c[p.user_id] || 0) + 1;
    }
    result.set(tid, { c, n: list.length, lp: Math.max(...list.map((p) => +p.id)) });
  }
  return result;
}

function packBatches(queue) {
  const batches = [];
  let cur = [], sum = 0;
  for (const t of queue) {
    const n = t.nr + 1;
    if (n > PAGE) { batches.push([t]); continue; }
    if (sum + n > PAGE) { batches.push(cur); cur = []; sum = 0; }
    cur.push(t); sum += n;
  }
  if (cur.length) batches.push(cur);
  return batches;
}

// ---------- Основной запуск ----------

const statePath = path.join(DATA_DIR, 'state.json');
const publicPath = path.join(DATA_DIR, 'postcount.json');
const state = fs.existsSync(statePath)
  ? JSON.parse(fs.readFileSync(statePath, 'utf8'))
  : { topics: {} };
// topics[id] = { f: раздел, lp, nr: отпечаток, c: {user_id: постов}, ok: счёт соответствует отпечатку }

const isFull = FULL || !Object.keys(state.topics).length;
let stopReason = '';
let listingComplete = false;
const listed = {};

try {
  await login();

  const since = (state.checkpoint || 0) - OVERLAP_S;
  let newest = state.checkpoint || 0;
  const sizes = {};
  for (const f of FORUMS) {
    const topics = isFull ? await listTopics(f) : await listRecent(f, since);
    sizes[f] = topics.length;
    for (const t of topics) {
      listed[t.id] = { f, lp: +t.last_post_id, nr: +t.num_replies };
      newest = Math.max(newest, +t.last_post_date);
    }
  }

  if (isFull) {
    // Защита: если тем резко стало меньше, скорее всего пропал доступ — ничего не удаляем.
    const total = Object.keys(listed).length;
    const prevTotal = state.totalTopics || 0;
    if (prevTotal > 50 && total < prevTotal * 0.95) {
      throw new StopRun(`Было ${prevTotal} тем, пришло ${total}. Проверьте доступ читателя.`);
    }
    for (const f of FORUMS) {
      const prev = (state.forumSizes || {})[f] || 0;
      if (prev >= 10 && sizes[f] === 0) throw new StopRun(`Раздел ${f}: было ${prev} тем, пришло 0. Проверьте доступ читателя.`);
    }
    state.totalTopics = total;
    state.forumSizes = sizes;
    for (const tid of Object.keys(state.topics)) if (!listed[tid]) delete state.topics[tid];
  }
  // Отметка двигается только после того, как списки получены целиком.
  // Найденные темы стоят в очереди (ok: false) и досчитаются, даже если этот запуск прервётся.
  state.checkpoint = newest;
  listingComplete = true;

  for (const [tid, t] of Object.entries(listed)) {
    const s = state.topics[tid];
    if (!s) state.topics[tid] = { f: t.f, lp: t.lp, nr: t.nr, c: null, ok: false };
    else {
      s.f = t.f;
      if (s.lp !== t.lp || s.nr !== t.nr) Object.assign(s, { lp: t.lp, nr: t.nr, ok: false });
    }
  }

  // Очередь: всё, что ещё не посчитано или изменилось.
  const queue = Object.entries(state.topics)
    .filter(([, s]) => !s.ok)
    .map(([tid, s]) => ({ tid, f: s.f, nr: s.nr }));
  queue.sort((a, b) => a.tid - b.tid);
  console.log(`${isFull ? 'Полная проверка' : 'Свежие темы'}: тем в списке ${Object.keys(listed).length}, на пересчёт ${queue.length}`);

  for (const batch of packBatches(queue)) {
    const expected = batch.reduce((s, t) => s + t.nr + 1, 0);
    const counted = countByUser(await fetchPosts(batch.map((t) => t.tid), expected));
    for (const t of batch) {
      let r = counted.get(String(t.tid));
      // Тема изменилась между списком и запросом постов — перечитываем её отдельно, целиком.
      if ((!r || r.n !== t.nr + 1) && !(batch.length === 1 && expected > PAGE)) {
        r = countByUser(await fetchPosts([t.tid], Infinity)).get(String(t.tid));
      }
      const s = state.topics[t.tid];
      if (!r) Object.assign(s, { c: {}, ok: true }); // тему удалили — уберётся при полной проверке
      else Object.assign(s, { c: r.c, nr: r.n - 1, lp: r.lp, ok: true });
    }
  }
} catch (e) {
  if (e instanceof BudgetExhausted) stopReason = `исчерпан лимит запросов (${MAX_REQUESTS}), продолжим в следующий запуск`;
  else if (e instanceof StopRun) stopReason = e.message;
  else throw e;
}

// ---------- Итоги и запись ----------

const totals = {};
let pending = 0;
for (const t of Object.values(state.topics)) {
  if (!t.ok) pending++;
  if (t.c) for (const [uid, n] of Object.entries(t.c)) totals[uid] = (totals[uid] || 0) + n;
}

console.log(`Запросов: ${requestsUsed}. Тем без актуального счёта: ${pending}.`);
if (stopReason) console.warn('Остановка: ' + stopReason);
for (const uid of CHECK_UIDS) console.log(`Игрок ${uid}: ${totals[uid] || 0}`);

if (!listingComplete && !Object.keys(state.topics).length) process.exit(1);

if (!DRY_RUN) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  state.updated = Math.floor(Date.now() / 1000);
  fs.writeFileSync(statePath, JSON.stringify(state));
  fs.writeFileSync(publicPath, JSON.stringify({ updated: state.updated, pending, totals }));
}
if (stopReason && !stopReason.startsWith('исчерпан')) process.exitCode = 1;
