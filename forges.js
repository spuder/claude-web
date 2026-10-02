// Integrations with GitHub, GitLab and Forgejo/Gitea: settings storage,
// REST calls, normalized repo/issue/PR data, and git auth for cloning/pushing.

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const SETTINGS_FILE =
  process.env.SETTINGS_FILE || path.join(os.homedir(), '.config', 'claude-web', 'settings.json');

const TYPES = {
  github: { label: 'GitHub', defaultUrl: 'https://github.com' },
  gitlab: { label: 'GitLab', defaultUrl: 'https://gitlab.com' },
  forgejo: { label: 'Forgejo / Gitea', defaultUrl: 'https://codeberg.org' },
};

// ---------- settings ----------

function loadSettings() {
  try {
    const s = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    return { integrations: [], ...s };
  } catch {
    return { integrations: [] };
  }
}

function saveSettings(settings) {
  fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true, mode: 0o700 });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), { mode: 0o600 });
  fs.chmodSync(SETTINGS_FILE, 0o600);
}

// What the browser is allowed to see: never the token.
function publicIntegration(i) {
  return { id: i.id, type: i.type, typeLabel: TYPES[i.type].label, baseUrl: i.baseUrl, username: i.username };
}

function getIntegration(id) {
  return loadSettings().integrations.find((i) => i.id === id) || null;
}

async function addIntegration({ type, baseUrl, token }) {
  if (!TYPES[type]) throw new Error('Unknown integration type.');
  if (!token) throw new Error('A token is required.');
  let url;
  try {
    url = new URL(baseUrl || TYPES[type].defaultUrl);
  } catch {
    throw new Error('Invalid base URL.');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('Base URL must be http(s).');

  const integration = {
    id: crypto.randomUUID(),
    type,
    baseUrl: (url.origin + url.pathname).replace(/\/+$/, ''),
    token: token.trim(),
  };
  const user = await api(integration, '/user'); // also verifies the token
  integration.username = user.login || user.username;

  const settings = loadSettings();
  settings.integrations.push(integration);
  saveSettings(settings);
  return publicIntegration(integration);
}

function removeIntegration(id) {
  const settings = loadSettings();
  settings.integrations = settings.integrations.filter((i) => i.id !== id);
  saveSettings(settings);
}

// ---------- REST ----------

function apiBase(i) {
  const u = new URL(i.baseUrl);
  if (i.type === 'github') return u.hostname === 'github.com' ? 'https://api.github.com' : `${i.baseUrl}/api/v3`;
  if (i.type === 'gitlab') return `${i.baseUrl}/api/v4`;
  return `${i.baseUrl}/api/v1`;
}

function authHeaders(i) {
  if (i.type === 'github') return { Authorization: `Bearer ${i.token}`, Accept: 'application/vnd.github+json' };
  if (i.type === 'gitlab') return { 'PRIVATE-TOKEN': i.token };
  return { Authorization: `token ${i.token}` };
}

async function api(i, p) {
  const res = await fetch(apiBase(i) + p, { headers: { ...authHeaders(i), 'User-Agent': 'claude-web' } });
  if (!res.ok) {
    const text = (await res.text()).slice(0, 200);
    throw new Error(`${TYPES[i.type].label} API returned ${res.status}${text ? `: ${text}` : ''}`);
  }
  return res.json();
}

const glId = (repo) => encodeURIComponent(repo);

async function listRepos(i) {
  if (i.type === 'github') {
    const rs = await api(i, '/user/repos?per_page=100&sort=updated');
    return rs.map((r) => ({ fullName: r.full_name, description: r.description, private: r.private }));
  }
  if (i.type === 'gitlab') {
    const rs = await api(i, '/projects?membership=true&order_by=last_activity_at&per_page=100&simple=true');
    return rs.map((r) => ({ fullName: r.path_with_namespace, description: r.description, private: r.visibility !== 'public' }));
  }
  const rs = await api(i, '/user/repos?limit=50');
  return rs.map((r) => ({ fullName: r.full_name, description: r.description, private: r.private }));
}

// Default branch and, for forks, the direct parent repo ("owner/name").
async function getRepoInfo(i, repo) {
  if (i.type === 'gitlab') {
    const r = await api(i, `/projects/${glId(repo)}`);
    return { fullName: r.path_with_namespace, defaultBranch: r.default_branch, parent: r.forked_from_project?.path_with_namespace || null };
  }
  const r = await api(i, `/repos/${repo}`);
  return { fullName: r.full_name, defaultBranch: r.default_branch, parent: r.parent?.full_name || null };
}

// Search all repos the token can see (public ones included), not just your own.
async function searchRepos(i, q) {
  const enc = encodeURIComponent(q);
  if (i.type === 'github') {
    const { items } = await api(i, `/search/repositories?q=${enc}&per_page=30`);
    return items.map((r) => ({ fullName: r.full_name, description: r.description, private: r.private, stars: r.stargazers_count }));
  }
  if (i.type === 'gitlab') {
    const rs = await api(i, `/projects?search=${enc}&search_namespaces=true&order_by=star_count&per_page=30&simple=true`);
    return rs.map((r) => ({ fullName: r.path_with_namespace, description: r.description, private: r.visibility !== 'public', stars: r.star_count }));
  }
  const { data } = await api(i, `/repos/search?q=${enc}&sort=stars&order=desc&limit=30`);
  return data.map((r) => ({ fullName: r.full_name, description: r.description, private: r.private, stars: r.stars_count }));
}

// "Me" filters for issue/PR lists. GitLab's API has no mentions filter.
const FILTERS = ['assigned', 'created', 'mentioned'];
const supportsFilter = (i, filter) => !(i.type === 'gitlab' && filter === 'mentioned');

// Open issues/PRs narrowed to ones assigned to, created by, or mentioning the
// integration's user, optionally also matching free text.
async function filteredItems(i, repo, filter, q = '') {
  if (!supportsFilter(i, filter)) throw new Error("GitLab can't filter by mentions.");
  const u = encodeURIComponent(i.username);
  const enc = encodeURIComponent(q);
  const ghItem = (x) => ({ kind: x.pull_request ? 'pr' : 'issue', number: x.number, title: x.title, url: x.html_url, author: x.user?.login });
  const split = (items) => ({ issues: items.filter((x) => x.kind === 'issue'), prs: items.filter((x) => x.kind === 'pr') });

  if (i.type === 'github') {
    if (q) {
      const qual = { assigned: 'assignee', created: 'author', mentioned: 'mentions' }[filter];
      const { items } = await api(i, `/search/issues?q=${encodeURIComponent(`repo:${repo} is:open ${qual}:${i.username} ${q}`)}&per_page=50`);
      return split(items.map(ghItem));
    }
    const param = { assigned: 'assignee', created: 'creator', mentioned: 'mentioned' }[filter];
    return split((await api(i, `/repos/${repo}/issues?state=open&per_page=50&${param}=${u}`)).map(ghItem));
  }
  if (i.type === 'gitlab') {
    const param = { assigned: 'assignee_username', created: 'author_username' }[filter];
    const extra = `state=opened&per_page=50&${param}=${u}${q ? `&search=${enc}` : ''}`;
    const glItem = (kind) => (x) => ({ kind, number: x.iid, title: x.title, url: x.web_url, author: x.author?.username });
    const [issues, mrs] = await Promise.all([
      api(i, `/projects/${glId(repo)}/issues?${extra}`),
      api(i, `/projects/${glId(repo)}/merge_requests?${extra}`),
    ]);
    return { issues: issues.map(glItem('issue')), prs: mrs.map(glItem('pr')) };
  }
  const param = { assigned: 'assigned_by', created: 'created_by', mentioned: 'mentioned_by' }[filter];
  const extra = `state=open&limit=50&${param}=${u}${q ? `&q=${enc}` : ''}`;
  const [issues, prs] = await Promise.all([
    api(i, `/repos/${repo}/issues?type=issues&${extra}`),
    api(i, `/repos/${repo}/issues?type=pulls&${extra}`),
  ]);
  return { issues: issues.map(ghItem), prs: prs.map(ghItem) };
}

async function listIssuesAndPrs(i, repo, filter) {
  if (filter) return filteredItems(i, repo, filter);
  const item = (kind, number, title, url, author) => ({ kind, number, title, url, author });
  if (i.type === 'github') {
    const [issues, prs] = await Promise.all([
      api(i, `/repos/${repo}/issues?state=open&per_page=50`),
      api(i, `/repos/${repo}/pulls?state=open&per_page=50`),
    ]);
    return {
      issues: issues.filter((x) => !x.pull_request).map((x) => item('issue', x.number, x.title, x.html_url, x.user?.login)),
      prs: prs.map((x) => item('pr', x.number, x.title, x.html_url, x.user?.login)),
    };
  }
  if (i.type === 'gitlab') {
    const [issues, mrs] = await Promise.all([
      api(i, `/projects/${glId(repo)}/issues?state=opened&per_page=50`),
      api(i, `/projects/${glId(repo)}/merge_requests?state=opened&per_page=50`),
    ]);
    return {
      issues: issues.map((x) => item('issue', x.iid, x.title, x.web_url, x.author?.username)),
      prs: mrs.map((x) => item('pr', x.iid, x.title, x.web_url, x.author?.username)),
    };
  }
  const [issues, prs] = await Promise.all([
    api(i, `/repos/${repo}/issues?state=open&type=issues&limit=50`),
    api(i, `/repos/${repo}/pulls?state=open&limit=50`),
  ]);
  return {
    issues: issues.map((x) => item('issue', x.number, x.title, x.html_url, x.user?.login)),
    prs: prs.map((x) => item('pr', x.number, x.title, x.html_url, x.user?.login)),
  };
}

// Open issues/PRs matching free text, or the item(s) with that number (any state).
async function searchItems(i, repo, q, filter) {
  const enc = encodeURIComponent(q);
  const num = /^#?\d+$/.test(q) ? Number(q.replace('#', '')) : null;
  const ghItem = (x) => ({ kind: x.pull_request ? 'pr' : 'issue', number: x.number, title: x.title, url: x.html_url, author: x.user?.login, state: x.state });
  const glItem = (kind) => (x) => ({ kind, number: x.iid, title: x.title, url: x.web_url, author: x.author?.username, state: x.state });
  const split = (items) => ({ issues: items.filter((x) => x.kind === 'issue'), prs: items.filter((x) => x.kind === 'pr') });
  const orNull = (p) => p.catch(() => null);
  // A #number is an exact lookup and ignores filters.
  if (filter && !num) return filteredItems(i, repo, filter, q);

  if (i.type === 'gitlab') {
    const base = `/projects/${glId(repo)}`;
    if (num) {
      const [is, mr] = await Promise.all([orNull(api(i, `${base}/issues/${num}`)), orNull(api(i, `${base}/merge_requests/${num}`))]);
      return { issues: is ? [glItem('issue')(is)] : [], prs: mr ? [glItem('pr')(mr)] : [] };
    }
    const [issues, mrs] = await Promise.all([
      api(i, `${base}/issues?state=opened&search=${enc}&per_page=30`),
      api(i, `${base}/merge_requests?state=opened&search=${enc}&per_page=30`),
    ]);
    return { issues: issues.map(glItem('issue')), prs: mrs.map(glItem('pr')) };
  }
  // GitHub and Forgejo both serve PRs from the issues endpoint, flagged with pull_request.
  if (num) {
    const x = await orNull(api(i, `/repos/${repo}/issues/${num}`));
    return split(x ? [ghItem(x)] : []);
  }
  if (i.type === 'github') {
    const { items } = await api(i, `/search/issues?q=${encodeURIComponent(`repo:${repo} is:open ${q}`)}&per_page=30`);
    return split(items.map(ghItem));
  }
  const items = await api(i, `/repos/${repo}/issues?state=open&q=${enc}&limit=30`);
  return split(items.map(ghItem));
}

async function getItem(i, repo, kind, number) {
  let x;
  if (i.type === 'gitlab') {
    x = await api(i, `/projects/${glId(repo)}/${kind === 'pr' ? 'merge_requests' : 'issues'}/${number}`);
    return { title: x.title, body: x.description, url: x.web_url, author: x.author?.username };
  }
  x = await api(i, `/repos/${repo}/${kind === 'pr' ? 'pulls' : 'issues'}/${number}`);
  return { title: x.title, body: x.body, url: x.html_url, author: x.user?.login };
}

// Ref that holds a PR's head commit on the forge's git remote.
function prRef(i, number) {
  return i.type === 'gitlab' ? `refs/merge-requests/${number}/head` : `refs/pull/${number}/head`;
}

// ---------- git ----------

function cloneUrl(i, repo) {
  return `${i.baseUrl}/${repo}.git`;
}

// Env that authenticates git (and the forge's CLI, if installed) against one or
// more integrations without writing tokens into any repo's .git/config.
function gitAuthEnv(integrations, baseEnv = process.env) {
  const list = [].concat(integrations).filter(Boolean);
  const env = { GIT_TERMINAL_PROMPT: '0' };
  let n = Number(baseEnv.GIT_CONFIG_COUNT || 0);
  const seen = new Set();
  for (const i of list) {
    const origin = new URL(i.baseUrl).origin;
    if (seen.has(origin)) continue;
    seen.add(origin);
    const user = i.type === 'github' ? 'x-access-token' : i.type === 'gitlab' ? 'oauth2' : i.username;
    const basic = Buffer.from(`${user}:${i.token}`).toString('base64');
    env[`GIT_CONFIG_KEY_${n}`] = `http.${origin}/.extraHeader`;
    env[`GIT_CONFIG_VALUE_${n}`] = `Authorization: Basic ${basic}`;
    n++;
    const host = new URL(i.baseUrl).host;
    if (i.type === 'github') {
      if (host === 'github.com') env.GH_TOKEN = i.token;
      else Object.assign(env, { GH_HOST: host, GH_ENTERPRISE_TOKEN: i.token });
    } else if (i.type === 'gitlab') {
      Object.assign(env, { GITLAB_TOKEN: i.token, GITLAB_HOST: origin });
    }
  }
  env.GIT_CONFIG_COUNT = String(n);
  return env;
}

function parseRemote(url) {
  const scp = url.match(/^[\w.-]+@([^:/]+):(.+)$/); // git@host:owner/repo.git
  let host, p;
  if (scp) [, host, p] = scp;
  else {
    try {
      const u = new URL(url);
      host = u.hostname;
      p = u.pathname;
    } catch {
      return null;
    }
  }
  return { host, path: p.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/, '') };
}

// Connected integration + "owner/repo" for a remote URL, or null.
function matchRemoteUrl(url, name) {
  const remote = url && parseRemote(url);
  if (!remote) return null;
  for (const i of loadSettings().integrations) {
    const base = new URL(i.baseUrl);
    if (base.hostname !== remote.host) continue;
    const prefix = base.pathname.replace(/^\/+|\/+$/g, '');
    const repo = prefix && remote.path.startsWith(prefix + '/') ? remote.path.slice(prefix.length + 1) : remote.path;
    return { integration: i, repo, remote: name };
  }
  return null;
}

// Where a project's issues/PRs live, given its remote URLs ({ origin, upstream }).
// For forks with an `upstream` remote that's upstream (unless `prefer` is
// 'origin'); otherwise origin. Both matches are returned so callers can set up
// auth and describe the remotes.
function forgeFromRemotes(remotes = {}, prefer) {
  const origin = matchRemoteUrl(remotes.origin, 'origin');
  const upstream = matchRemoteUrl(remotes.upstream, 'upstream');
  const chosen = prefer === 'origin' ? origin : upstream || origin;
  if (!chosen) return null;
  return { ...chosen, origin, upstream };
}

module.exports = {
  TYPES,
  SETTINGS_FILE,
  loadSettings,
  publicIntegration,
  getIntegration,
  addIntegration,
  removeIntegration,
  listRepos,
  getRepoInfo,
  searchRepos,
  listIssuesAndPrs,
  getItem,
  searchItems,
  FILTERS,
  supportsFilter,
  prRef,
  cloneUrl,
  gitAuthEnv,
  forgeFromRemotes,
};
