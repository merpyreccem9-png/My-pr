// Коннектор GitHub (только чтение): токен пользователя + функции, которые модель вызывает сама.
// Токен хранится в kv (`gh.<userId>`), используется только для GET-запросов к api.github.com.

import { fetch } from 'sdk';
import { kvGetMany, kvSet } from './store.js';

const API = 'https://api.github.com';
const MAX_OUT = 12000;            // символов в ответе функции модели
const UA = 'LunaBot-GitHub-Connector';

export const ghKey = (id) => `gh.${id}`;
export const getGhToken = async (userId) => (await kvGetMany([ghKey(userId)]))[ghKey(userId)] || null;
const loginKey = (id) => `ghlogin.${id}`;
export const getGhLogin = async (userId) => (await kvGetMany([loginKey(userId)]))[loginKey(userId)] || null;
export async function setGhToken(userId, token, login = '') {
  await kvSet(ghKey(userId), token || '');
  await kvSet(loginKey(userId), token ? login : '');
}

export class GhError extends Error {
  constructor(status, detail = '') {
    super(`GitHub ${status}`);
    this.status = status;
    this.detail = detail;
  }
}

const cap = (s, n = MAX_OUT) => (s.length > n ? `${s.slice(0, n)}\n…[обрезано, всего ${s.length} символов]` : s);
const day = (iso) => String(iso ?? '').slice(0, 10);

async function call(token, path, { accept = 'application/vnd.github+json' } = {}) {
  const res = await fetch(`${API}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: accept,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': UA,
    },
  });
  if (!res.ok) {
    const raw = await res.text().catch(() => '');
    throw new GhError(res.status, raw.slice(0, 200));
  }
  return res;
}

const json = async (token, path, opts) => (await call(token, path, opts)).json();

export function ghErrorText(e) {
  if (!(e instanceof GhError)) return String(e?.message ?? e);
  if (e.status === 401) return 'токен недействителен или отозван';
  if (e.status === 403) return /rate limit/i.test(e.detail) ? 'лимит запросов GitHub, подождите' : 'нет прав на это (проверьте доступ токена к репозиторию)';
  if (e.status === 404) return 'не найдено или у токена нет доступа';
  if (e.status === 422) return 'запрос не принят GitHub (проверьте параметры)';
  return `ошибка GitHub ${e.status}`;
}

// Проверка токена. → { login, scopes } или бросает GhError.
export async function ghWhoami(token) {
  const res = await call(token, '/user');
  const me = await res.json();
  return { login: me.login, scopes: res.headers?.get?.('x-oauth-scopes') ?? '' };
}

// «owner/name» из строки или ссылки github.com
function repoOf(v) {
  const m = String(v ?? '').trim().match(/(?:github\.com\/)?([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:[/?#].*)?$/);
  if (!m) throw new Error('укажите репозиторий как owner/name');
  return `${m[1]}/${m[2]}`;
}

const q = (v) => encodeURIComponent(String(v));
const pathOf = (p) => String(p ?? '').replace(/^\/+|\/+$/g, '').split('/').filter(Boolean).map(encodeURIComponent).join('/');

// ── Функции для модели ─────────────────────────────────────────────────────

const fn = (name, description, properties, required = []) => ({
  type: 'function',
  function: { name, description, parameters: { type: 'object', properties, required } },
});
const REPO = { type: 'string', description: 'Репозиторий: owner/name или ссылка на него.' };

export const GH_TOOLS = [
  fn('github_list_repos', 'Список репозиториев пользователя (свои, коллабораций, организаций), свежие сверху.',
    { query: { type: 'string', description: 'Необязательно: фильтр по подстроке в названии/описании.' } }),
  fn('github_read_file', 'Прочитать файл репозитория или показать содержимое папки (path пустой — корень).',
    { repo: REPO, path: { type: 'string', description: 'Путь к файлу или папке.' }, ref: { type: 'string', description: 'Ветка, тег или коммит (по умолчанию — основная ветка).' } },
    ['repo']),
  fn('github_search_code', 'Поиск по коду. Лучше сужать репозиторием.',
    { query: { type: 'string', description: 'Что искать.' }, repo: REPO }, ['query']),
  fn('github_list_issues', 'Issues и pull request’ы репозитория (поиск).',
    {
      repo: REPO,
      state: { type: 'string', enum: ['open', 'closed', 'all'] },
      type: { type: 'string', enum: ['issue', 'pr', 'any'] },
      query: { type: 'string', description: 'Необязательно: слова для поиска.' },
    }, ['repo']),
  fn('github_get_issue', 'Один issue или pull request: описание и последние комментарии.',
    { repo: REPO, number: { type: 'integer' } }, ['repo', 'number']),
  fn('github_list_commits', 'Последние коммиты (можно по ветке или по файлу).',
    { repo: REPO, ref: { type: 'string' }, path: { type: 'string' } }, ['repo']),
  fn('github_list_branches', 'Ветки репозитория.', { repo: REPO }, ['repo']),
];

const NAMES = new Set(GH_TOOLS.map((t) => t.function.name));
export const isGhTool = (name) => NAMES.has(name);

// Короткая подпись действия для статуса и панели «команды».
export function ghLabel(name, a = {}) {
  const r = a.repo ? String(a.repo).replace(/^https?:\/\/github\.com\//, '') : '';
  switch (name) {
    case 'github_list_repos': return 'Смотрю список репозиториев';
    case 'github_read_file': return `Читаю ${r}${a.path ? `/${String(a.path).replace(/^\/+/, '')}` : ''}`;
    case 'github_search_code': return `Ищу в коде «${String(a.query ?? '').slice(0, 40)}»${r ? ` (${r})` : ''}`;
    case 'github_list_issues': return `Смотрю issues/PR ${r}`;
    case 'github_get_issue': return `Открываю #${a.number} ${r}`;
    case 'github_list_commits': return `Смотрю коммиты ${r}`;
    case 'github_list_branches': return `Смотрю ветки ${r}`;
    default: return name;
  }
}

async function listRepos(token, { query } = {}) {
  const rows = await json(token, '/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member');
  const needle = String(query ?? '').toLowerCase();
  const list = rows
    .filter((r) => !needle || `${r.full_name} ${r.description ?? ''}`.toLowerCase().includes(needle))
    .slice(0, 40)
    .map((r) => `${r.full_name}${r.private ? ' 🔒' : ''}${r.language ? ` [${r.language}]` : ''} — ${(r.description ?? '').slice(0, 100)} (обновлён ${day(r.pushed_at)}, ветка ${r.default_branch})`);
  return list.length ? list.join('\n') : 'Репозиториев не найдено.';
}

async function readFile(token, { repo, path, ref }) {
  const r = repoOf(repo);
  const res = await call(token, `/repos/${r}/contents/${pathOf(path)}${ref ? `?ref=${q(ref)}` : ''}`, { accept: 'application/vnd.github.raw+json' });
  const type = res.headers?.get?.('content-type') ?? '';
  const text = await res.text();
  if (/application\/json/i.test(type) && text.trimStart().startsWith('[')) {
    const items = JSON.parse(text);
    return items.map((i) => `${i.type === 'dir' ? '📁' : '📄'} ${i.path}${i.type === 'file' ? ` (${i.size} Б)` : ''}`).join('\n') || 'Папка пуста.';
  }
  if (text.includes('\u0000')) return 'Это бинарный файл — показать нечего.';
  return cap(text);
}

async function searchCode(token, { query, repo }) {
  const scope = repo ? `+repo:${repoOf(repo)}` : '+user:@me';
  const data = await json(token, `/search/code?q=${q(query)}${scope}&per_page=10`, { accept: 'application/vnd.github.text-match+json' });
  const items = data.items ?? [];
  if (!items.length) return 'Ничего не найдено.';
  return cap(items.map((i) => {
    const frag = (i.text_matches?.[0]?.fragment ?? '').replace(/\s+/g, ' ').slice(0, 240);
    return `${i.repository.full_name}: ${i.path}${frag ? `\n   …${frag}…` : ''}`;
  }).join('\n'));
}

async function listIssues(token, { repo, state = 'open', type = 'any', query }) {
  const parts = [`repo:${repoOf(repo)}`];
  if (state !== 'all') parts.push(`state:${state}`);
  if (type === 'issue') parts.push('is:issue');
  if (type === 'pr') parts.push('is:pr');
  if (query) parts.push(String(query));
  const data = await json(token, `/search/issues?q=${q(parts.join(' '))}&sort=updated&per_page=25`);
  const items = data.items ?? [];
  if (!items.length) return 'Ничего не найдено.';
  return cap(items.map((i) => `#${i.number} ${i.pull_request ? '[PR]' : '[issue]'} ${i.state} — ${i.title} (@${i.user?.login}, обновлён ${day(i.updated_at)})`).join('\n'));
}

async function getIssue(token, { repo, number }) {
  const r = repoOf(repo);
  const [issue, comments] = await Promise.all([
    json(token, `/repos/${r}/issues/${Number(number)}`),
    json(token, `/repos/${r}/issues/${Number(number)}/comments?per_page=30`).catch(() => []),
  ]);
  const head = `#${issue.number} ${issue.pull_request ? '[PR]' : '[issue]'} ${issue.state}: ${issue.title}\nавтор @${issue.user?.login}, ${day(issue.created_at)}\n\n${issue.body ?? '(без описания)'}`;
  const tail = comments.slice(-10).map((c) => `— @${c.user?.login} (${day(c.created_at)}): ${String(c.body ?? '').slice(0, 800)}`).join('\n\n');
  return cap(tail ? `${head}\n\nКомментарии:\n${tail}` : head);
}

async function listCommits(token, { repo, ref, path }) {
  const qs = [`per_page=15`, ref ? `sha=${q(ref)}` : '', path ? `path=${q(path)}` : ''].filter(Boolean).join('&');
  const rows = await json(token, `/repos/${repoOf(repo)}/commits?${qs}`);
  return rows.map((c) => `${c.sha.slice(0, 7)} ${day(c.commit.author?.date)} ${c.commit.author?.name}: ${c.commit.message.split('\n')[0].slice(0, 120)}`).join('\n') || 'Коммитов нет.';
}

async function listBranches(token, { repo }) {
  const rows = await json(token, `/repos/${repoOf(repo)}/branches?per_page=50`);
  return rows.map((b) => `${b.name}${b.protected ? ' 🔒' : ''}`).join('\n') || 'Веток нет.';
}

const RUNNERS = {
  github_list_repos: listRepos,
  github_read_file: readFile,
  github_search_code: searchCode,
  github_list_issues: listIssues,
  github_get_issue: getIssue,
  github_list_commits: listCommits,
  github_list_branches: listBranches,
};

// Выполняет функцию модели. Ошибки возвращает текстом (модель сама объяснит пользователю), не бросает.
export async function runGhTool(token, name, args) {
  const run = RUNNERS[name];
  if (!run) return `Неизвестная функция ${name}`;
  try {
    return await run(token, args ?? {});
  } catch (e) {
    return `Ошибка: ${ghErrorText(e)}`;
  }
}
