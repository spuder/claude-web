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

async function listIssuesAndPrs(i, repo) {
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

// Env that authenticates git (and the forge's CLI, if installed) against this
// integration without writing the token into any repo's .git/config.
function gitAuthEnv(i, baseEnv = process.env) {
  const user = i.type === 'github' ? 'x-access-token' : i.type === 'gitlab' ? 'oauth2' : i.username;
  const basic = Buffer.from(`${user}:${i.token}`).toString('base64');
  const n = Number(baseEnv.GIT_CONFIG_COUNT || 0);
  const host = new URL(i.baseUrl).host;
  const env = {
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_COUNT: String(n + 1),
    [`GIT_CONFIG_KEY_${n}`]: `http.${new URL(i.baseUrl).origin}/.extraHeader`,
    [`GIT_CONFIG_VALUE_${n}`]: `Authorization: Basic ${basic}`,
  };
  if (i.type === 'github') {
    if (host === 'github.com') env.GH_TOKEN = i.token;
    else Object.assign(env, { GH_HOST: host, GH_ENTERPRISE_TOKEN: i.token });
  } else if (i.type === 'gitlab') {
    Object.assign(env, { GITLAB_TOKEN: i.token, GITLAB_HOST: new URL(i.baseUrl).origin });
  }
  return env;
}

function readOrigin(dir) {
  try {
    const cfg = fs.readFileSync(path.join(dir, '.git', 'config'), 'utf8');
    const m = cfg.match(/\[remote "origin"\][^[]*?url\s*=\s*(\S+)/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
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

// The connected integration + "owner/repo" for a project dir, based on its origin remote.
function findForge(dir) {
  const origin = readOrigin(dir);
  const remote = origin && parseRemote(origin);
  if (!remote) return null;
  for (const i of loadSettings().integrations) {
    const base = new URL(i.baseUrl);
    if (base.hostname !== remote.host) continue;
    const prefix = base.pathname.replace(/^\/+|\/+$/g, '');
    const repo = prefix && remote.path.startsWith(prefix + '/') ? remote.path.slice(prefix.length + 1) : remote.path;
    return { integration: i, repo };
  }
  return null;
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
  listIssuesAndPrs,
  getItem,
  prRef,
  cloneUrl,
  gitAuthEnv,
  findForge,
};
