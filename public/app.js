const $ = (id) => document.getElementById(id);

let projects = [];
// Live agents (one claude process each), kept running while you switch between them.
const sessions = new Map(); // id -> { id, path, label, ws, term, fit, el, status, running }
const agentCounters = new Map(); // path -> last agent number used
let activeId = null;
let nextId = 1;

const sessionsFor = (path) => [...sessions.values()].filter((s) => s.path === path);
const activeSession = () => sessions.get(activeId);

async function loadProjects() {
  const res = await fetch('/api/projects');
  const data = await res.json();
  if (data.error) {
    $('projects').innerHTML = `<li class="muted">Error: ${data.error}</li>`;
    return;
  }
  $('root').textContent = data.root;
  projects = data.projects;
  renderProjects();
}

function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text != null) e.textContent = text;
  return e;
}

function renderProjects() {
  const q = $('filter').value.toLowerCase();
  const list = $('projects');
  list.innerHTML = '';

  // Agents opened via a custom path aren't in the root listing; show them too.
  const known = new Set(projects.map((p) => p.path));
  const extra = [...new Set([...sessions.values()].map((s) => s.path))]
    .filter((p) => !known.has(p))
    .map((p) => ({ name: p.split('/').filter(Boolean).pop() || p, path: p }));

  const shown = [...extra, ...projects].filter((p) => p.name.toLowerCase().includes(q));
  if (!shown.length) list.innerHTML = '<li class="muted" style="padding:6px 8px">No projects found.</li>';

  const active = activeSession();
  for (const p of shown) {
    const agents = sessionsFor(p.path);

    // Project row: opens its most recent agent, or starts the first one.
    const li = el('li', 'project-row' + (active?.path === p.path ? ' current' : ''));
    li.title = p.path;
    const btn = el('button', 'proj');
    btn.append(el('span', 'dot' + (agents.some((a) => a.running) ? ' running' : '')), el('span', 'name', p.name));
    if (agents.length) btn.append(el('span', 'tag count', String(agents.length)));
    if (p.git) btn.append(el('span', 'tag', 'git'));
    if (p.claudeMd) btn.append(el('span', 'tag', 'md'));
    if (p.forge) btn.append(el('span', 'tag', p.forge.upstream ? `${p.forge.type} fork` : p.forge.type));
    if (p.forge?.upstream) li.title += `\nupstream: ${p.forge.upstream}`;
    btn.onclick = () => (agents.length ? showSession(agents[agents.length - 1].id) : newAgent(p.path));
    li.append(btn);
    list.append(li);

    if (!agents.length) continue;

    for (const a of agents) {
      const row = el('li', 'agent-row' + (a.id === activeId ? ' active' : ''));
      const ab = el('button', 'proj agent');
      ab.append(el('span', 'dot' + (a.running ? ' running' : ' stopped')), el('span', 'name', a.label));
      ab.onclick = () => showSession(a.id);
      const close = el('button', 'close show', '×');
      close.title = 'End agent';
      close.onclick = () => closeSession(a.id);
      row.append(ab, close);
      list.append(row);
    }

    const addRow = el('li', 'agent-row add');
    const add = el('button', 'proj agent', '+ New agent');
    add.onclick = () => newAgent(p.path);
    addRow.append(add);
    list.append(addRow);

    if (p.forge) {
      const itemRow = el('li', 'agent-row add');
      const pick = el('button', 'proj agent', '+ Issue / PR…');
      pick.onclick = () => openItemsDialog(p);
      itemRow.append(pick);
      list.append(itemRow);
    }
  }
}

function showSession(id) {
  activeId = id;
  for (const [sid, s] of sessions) s.el.classList.toggle('hidden', sid !== id);
  const s = sessions.get(id);
  $('empty').classList.toggle('hidden', !!s);
  $('status').classList.toggle('hidden', !s);
  history.replaceState(null, '', s ? '#' + encodeURIComponent(s.path) : location.pathname);

  if (s) {
    setStatus(s.status);
    // Terminal must be visible to measure; fit after layout.
    requestAnimationFrame(() => {
      s.fit.fit();
      s.term.focus();
    });
  }
  renderProjects();
}

// task: optional { kind: 'issue' | 'pr', number, resume } to start the agent on a forge item.
function newAgent(projectPath, label, task) {
  if (!label) {
    const n = (agentCounters.get(projectPath) || 0) + 1;
    agentCounters.set(projectPath, n);
    label = `Agent ${n}`;
  }
  const id = nextId++;

  const container = el('div', 'term');
  $('terminals').append(container);

  const term = new Terminal({
    cursorBlink: true,
    fontFamily: 'ui-monospace, "JetBrains Mono", Menlo, monospace',
    fontSize: 14,
    theme: { background: '#1a1915', foreground: '#ece9e1', cursor: '#d97757' },
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(container);
  fit.fit();

  const params = new URLSearchParams({
    project: projectPath,
    cols: term.cols,
    rows: term.rows,
    continue: $('opt-continue').checked ? '1' : '0',
  });
  if (task) {
    params.set('kind', task.kind);
    if (task.remote) params.set('remote', task.remote);
    params.set('number', task.number);
    if (task.resume) params.set('resume', '1');
  }
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/pty?${params}`);
  const send = (msg) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(msg));

  const s = { id, path: projectPath, label, ws, term, fit, el: container, status: 'Connecting…', running: false };
  sessions.set(id, s);

  const update = (status, running) => {
    s.status = status;
    s.running = running;
    if (activeId === id) setStatus(status);
    renderProjects();
  };

  ws.onopen = () => update(`${label} · starting…`, true);
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === 'output') term.write(msg.data);
    else if (msg.type === 'started') update(`${label} · running claude in ${msg.cwd}`, true);
    else if (msg.type === 'exit') update(`${label} · claude exited (code ${msg.code}). Click × to close, or press Enter to restart.`, false);
  };
  ws.onclose = () => {
    if (s.running) update(`${label} · disconnected.`, false);
  };

  term.onData((data) => {
    // After claude exits, Enter restarts this agent in place (same label). Issue/PR
    // agents resume their conversation in the same worktree instead of re-prompting.
    if (!s.running && ws.readyState !== WebSocket.CONNECTING && data === '\r') {
      closeSession(id, { keepActive: true });
      return newAgent(projectPath, label, task && { ...task, resume: true });
    }
    send({ type: 'input', data });
  });
  term.onResize(({ cols, rows }) => send({ type: 'resize', cols, rows }));

  showSession(id);
}

function closeSession(id, { keepActive = false } = {}) {
  const s = sessions.get(id);
  if (!s) return;
  s.ws.onclose = null;
  s.ws.close();
  s.term.dispose();
  s.el.remove();
  sessions.delete(id);
  if (keepActive) return;
  if (activeId === id) {
    // Fall back to another agent in the same project, if any.
    const sibling = sessionsFor(s.path).pop();
    showSession(sibling ? sibling.id : null);
  } else renderProjects();
}

function setStatus(text) {
  $('status').textContent = text;
}

window.addEventListener('resize', () => activeSession()?.fit.fit());

$('filter').oninput = renderProjects;

$('create').onsubmit = async (e) => {
  e.preventDefault();
  const name = $('create-name').value.trim();
  if (!name) return;
  const err = $('create-error');
  err.classList.add('hidden');
  const res = await fetch('/api/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, git: $('create-git').checked }),
  });
  const data = await res.json();
  if (!res.ok) {
    err.textContent = data.error;
    err.classList.remove('hidden');
    return;
  }
  $('create-name').value = '';
  await loadProjects();
  newAgent(data.path);
};

$('custom').onsubmit = (e) => {
  e.preventDefault();
  const p = $('custom-path').value.trim();
  if (p) {
    $('custom-path').value = '';
    newAgent(p);
  }
};

loadProjects().then(() => {
  if (location.hash.length > 1) newAgent(decodeURIComponent(location.hash.slice(1)));
});

// ---------- dialogs ----------

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function showError(id, err) {
  $(id).textContent = err ? err.message || err : '';
  $(id).classList.toggle('hidden', !err);
}

for (const btn of document.querySelectorAll('[data-close]')) btn.onclick = () => btn.closest('dialog').close();

// Settings

let settings = { types: {}, integrations: [] };

async function loadSettings() {
  settings = await api('GET', '/api/settings');
  $('settings-file').textContent = settings.settingsFile;
  const list = $('integrations');
  list.innerHTML = '';
  if (!settings.integrations.length) list.append(el('li', 'empty-row', 'None connected yet.'));
  for (const i of settings.integrations) {
    const li = el('li');
    li.append(el('span', 'tag', i.typeLabel), el('span', 'grow', `${i.username} @ ${i.baseUrl}`));
    const rm = el('button', 'link', 'Remove');
    rm.onclick = async () => {
      if (!confirm(`Remove ${i.typeLabel} integration for ${i.username}? The stored token is deleted.`)) return;
      await api('DELETE', `/api/integrations?id=${encodeURIComponent(i.id)}`, {});
      await loadSettings();
      loadProjects();
    };
    li.append(rm);
    list.append(li);
  }
  const typeSel = $('int-type');
  if (!typeSel.options.length) {
    for (const [k, t] of Object.entries(settings.types)) typeSel.append(new Option(t.label, k));
    typeSel.onchange = updateIntegrationForm;
    updateIntegrationForm();
  }
}

const TOKEN_HELP = {
  github: 'Create a token at Settings → Developer settings → Personal access tokens. Needs repo access (classic: "repo"; fine-grained: Contents, Issues and Pull requests read).',
  gitlab: 'Create a token at Preferences → Access tokens with the "api" scope (or "read_api" + "read_repository" for read-only).',
  forgejo: 'Create a token at Settings → Applications with repository and issue read access. Use your instance URL, e.g. https://codeberg.org.',
};

function updateIntegrationForm() {
  const type = $('int-type').value;
  $('int-url').value = settings.types[type].defaultUrl;
  $('int-help').textContent = TOKEN_HELP[type];
}

$('btn-settings').onclick = async () => {
  showError('int-error', null);
  await loadSettings();
  $('dlg-settings').showModal();
};

$('add-integration').onsubmit = async (e) => {
  e.preventDefault();
  const btn = e.submitter;
  btn.disabled = true;
  btn.textContent = 'Checking token…';
  showError('int-error', null);
  try {
    await api('POST', '/api/integrations', {
      type: $('int-type').value,
      baseUrl: $('int-url').value.trim(),
      token: $('int-token').value.trim(),
    });
    $('int-token').value = '';
    await loadSettings();
    loadProjects(); // existing clones may now match an integration
  } catch (err) {
    showError('int-error', err);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Connect';
  }
};

// Clone

let cloneRepos = []; // repos you own or belong to
let searchResults = null; // forge-wide search results for the current filter, or null
let searchTimer = null;
let searchSeq = 0;

const cloneIntegration = () => settings.integrations.find((i) => i.id === $('clone-integration').value);

async function loadCloneRepos() {
  const list = $('clone-repos');
  list.innerHTML = '<li class="empty-row">Loading repositories…</li>';
  showError('clone-error', null);
  searchResults = null;
  try {
    cloneRepos = await api('GET', `/api/repos?integration=${encodeURIComponent($('clone-integration').value)}`);
  } catch (err) {
    cloneRepos = [];
    showError('clone-error', err);
  }
  onCloneFilter();
}

// Turn a pasted clone/web URL on the selected forge into "owner/repo".
function repoFromUrl(text) {
  const i = cloneIntegration();
  if (!i) return null;
  const base = new URL(i.baseUrl);
  let host, p;
  const scp = text.match(/^[\w.-]+@([^:/]+):(.+)$/);
  if (scp) [, host, p] = scp;
  else {
    try {
      const u = new URL(text);
      host = u.hostname;
      p = u.pathname;
    } catch {
      return null;
    }
  }
  if (host !== base.hostname) return null;
  p = p.replace(/^\/+|\/+$/g, '').replace(/\.git$/, '');
  const prefix = base.pathname.replace(/^\/+|\/+$/g, '');
  if (prefix && p.startsWith(prefix + '/')) p = p.slice(prefix.length + 1);
  // Drop web UI suffixes like /-/tree/main (GitLab) or /tree/main, /issues (GitHub, Forgejo).
  p = p.split('/-/')[0];
  if (i.type !== 'gitlab') p = p.split('/').slice(0, 2).join('/');
  return /^[\w.-]+(\/[\w.-]+)+$/.test(p) ? p : null;
}

function onCloneFilter() {
  const raw = $('clone-filter').value.trim();
  clearTimeout(searchTimer);

  const fromUrl = /^(https?:\/\/|[\w.-]+@)/.test(raw) ? repoFromUrl(raw) : null;
  if (fromUrl) {
    searchResults = null;
    return selectCloneRepo(fromUrl);
  }
  if (/^[\w.-]+\/[\w.-]+/.test(raw)) selectCloneRepo(raw); // exact owner/repo can be cloned directly

  if (raw.length < 2) {
    searchResults = null;
    return renderCloneRepos();
  }
  searchResults = 'loading';
  renderCloneRepos();
  const seq = ++searchSeq;
  searchTimer = setTimeout(async () => {
    try {
      const rs = await api('GET', `/api/repos?integration=${encodeURIComponent($('clone-integration').value)}&q=${encodeURIComponent(raw)}`);
      if (seq === searchSeq) searchResults = rs;
    } catch (err) {
      if (seq === searchSeq) searchResults = { error: err.message };
    }
    if (seq === searchSeq) renderCloneRepos();
  }, 350);
}

function repoRow(r) {
  const li = el('li', r.fullName === $('clone-repo').value ? 'selected' : '');
  li.append(el('span', 'grow', r.fullName));
  if (r.stars) li.append(el('span', 'num', `★ ${r.stars.toLocaleString()}`));
  if (r.private) li.append(el('span', 'tag', 'private'));
  li.title = r.description || '';
  li.onclick = () => selectCloneRepo(r.fullName);
  li.ondblclick = () => doClone();
  return li;
}

function renderCloneRepos() {
  const q = $('clone-filter').value.trim().toLowerCase();
  const list = $('clone-repos');
  list.innerHTML = '';

  const mine = cloneRepos.filter((r) => r.fullName.toLowerCase().includes(q));
  if (searchResults !== null) list.append(el('li', 'section-row', 'Your repositories'));
  if (!mine.length) list.append(el('li', 'empty-row', q ? 'No matches.' : 'No repositories.'));
  for (const r of mine) list.append(repoRow(r));

  if (searchResults === null) return;
  list.append(el('li', 'section-row', `Search ${cloneIntegration()?.typeLabel || ''}`));
  if (searchResults === 'loading') return list.append(el('li', 'empty-row', 'Searching…'));
  if (searchResults.error) return list.append(el('li', 'empty-row', searchResults.error));
  const own = new Set(cloneRepos.map((r) => r.fullName));
  const others = searchResults.filter((r) => !own.has(r.fullName));
  if (!others.length) list.append(el('li', 'empty-row', 'No other results.'));
  for (const r of others) list.append(repoRow(r));
}

function selectCloneRepo(fullName) {
  const changed = $('clone-repo').value !== fullName;
  $('clone-repo').value = fullName;
  $('clone-name').value = fullName.split('/').pop();
  renderCloneRepos();
  if (changed) checkFork(fullName);
}

// If the selected repo is a fork, offer to add its parent as `upstream`.
let forkSeq = 0;
async function checkFork(fullName) {
  const seq = ++forkSeq;
  $('clone-upstream-row').classList.add('hidden');
  await new Promise((r) => setTimeout(r, 300)); // debounce typing
  if (seq !== forkSeq) return;
  try {
    const info = await api('GET', `/api/repo-info?integration=${encodeURIComponent($('clone-integration').value)}&repo=${encodeURIComponent(fullName)}`);
    if (seq !== forkSeq || !info.parent) return;
    $('clone-upstream-text').textContent = `Fork of ${info.parent}: add it as the "upstream" remote (issues and PRs will come from there)`;
    $('clone-upstream').checked = true;
    $('clone-upstream-row').classList.remove('hidden');
  } catch {
    // Unknown or inaccessible repo; the clone itself will report a clearer error.
  }
}

$('btn-clone').onclick = async () => {
  await loadSettings();
  const has = settings.integrations.length > 0;
  $('clone-none').classList.toggle('hidden', has);
  $('clone-body').classList.toggle('hidden', !has);
  $('dlg-clone').showModal();
  if (!has) return;
  const sel = $('clone-integration');
  const prev = sel.value;
  sel.innerHTML = '';
  for (const i of settings.integrations) sel.append(new Option(`${i.typeLabel}: ${i.username} @ ${new URL(i.baseUrl).host}`, i.id));
  if (prev && settings.integrations.some((i) => i.id === prev)) sel.value = prev;
  $('clone-filter').value = $('clone-repo').value = $('clone-name').value = '';
  $('clone-upstream-row').classList.add('hidden');
  loadCloneRepos();
};

$('clone-open-settings').onclick = () => {
  $('dlg-clone').close();
  $('btn-settings').click();
};
$('clone-integration').onchange = loadCloneRepos;
$('clone-filter').oninput = onCloneFilter;
$('clone-go').onclick = () => doClone();

async function doClone() {
  const btn = $('clone-go');
  const repo = $('clone-repo').value.trim();
  if (!repo || btn.disabled) return;
  btn.disabled = true;
  btn.textContent = 'Cloning…';
  showError('clone-error', null);
  try {
    const data = await api('POST', '/api/clone', {
      integration: $('clone-integration').value,
      repo,
      name: $('clone-name').value.trim(),
      upstream: !$('clone-upstream-row').classList.contains('hidden') && $('clone-upstream').checked,
    });
    $('dlg-clone').close();
    if (data.warning) alert(data.warning);
    await loadProjects();
    newAgent(data.path);
  } catch (err) {
    showError('clone-error', err);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Clone & open';
  }
}

// Issues / PRs

const FILTERS = {
  '': { label: 'All' },
  assigned: { label: 'Assigned to me', empty: 'assigned to' },
  created: { label: 'Created by me', empty: 'created by' },
  mentioned: { label: 'Mentions me', empty: 'mentioning' },
};

// Last-used filter is a per-browser convenience; storage may be unavailable.
function savedFilter() {
  try {
    const f = localStorage.getItem('claudeWeb.itemsFilter') || '';
    return f in FILTERS ? f : '';
  } catch {
    return '';
  }
}
function saveFilter(f) {
  try {
    localStorage.setItem('claudeWeb.itemsFilter', f);
  } catch {}
}

async function openItemsDialog(project, remote, filter = savedFilter()) {
  const dlg = $('dlg-items');
  const isGitlab = project.forge.type === 'gitlab';
  if (isGitlab && filter === 'mentioned') filter = ''; // GitLab can't filter by mentions
  const prNoun = isGitlab ? 'merge requests' : 'pull requests';
  $('items-title').textContent = `Issues & ${prNoun}`;
  $('items-prs-h').textContent = isGitlab ? 'Merge requests' : 'Pull requests';
  $('items-prs').innerHTML = $('items-issues').innerHTML = '';
  itemsCtx = null;
  clearTimeout(itemsTimer); // drop any search still pending for the previous list
  itemsSeq++;
  $('items-remotes').classList.add('hidden');
  $('items-suggest').classList.add('hidden');
  $('items-chips').classList.add('hidden');
  $('items-loading').classList.remove('hidden');
  showError('items-error', null);
  if (!dlg.open) dlg.showModal();

  let data;
  try {
    const qs = new URLSearchParams({ project: project.path });
    if (remote) qs.set('remote', remote);
    if (filter) qs.set('filter', filter);
    data = await api('GET', `/api/forge/items?${qs}`);
  } catch (err) {
    showError('items-error', err);
    return;
  } finally {
    $('items-loading').classList.add('hidden');
  }
  $('items-title').textContent = `${data.repo}: issues & ${prNoun}`;
  if (data.error) showError('items-error', data.error);

  // Fork with upstream: let the user switch which repo's items to list.
  if (data.upstream && data.origin) {
    const seg = $('items-remotes');
    seg.innerHTML = '';
    for (const [r, repo] of [['upstream', data.upstream], ['origin', data.origin]]) {
      const b = el('button', r === data.remote ? 'on' : '', `${r}: ${repo}`);
      b.onclick = () => r !== data.remote && openItemsDialog(project, r, filter);
      seg.append(b);
    }
    seg.classList.remove('hidden');
  }

  // Fork without upstream: offer to add it.
  if (data.suggestUpstream) {
    const banner = $('items-suggest');
    banner.innerHTML = '';
    banner.append(el('span', 'grow', `${data.repo} is a fork of ${data.suggestUpstream}, where its issues usually live.`));
    const add = el('button', 'primary', 'Add upstream');
    add.onclick = async () => {
      add.disabled = true;
      add.textContent = 'Adding…';
      try {
        await api('POST', '/api/upstream', { project: project.path });
        await loadProjects();
        const updated = projects.find((p) => p.path === project.path) || project;
        openItemsDialog(updated);
      } catch (err) {
        showError('items-error', err);
        add.disabled = false;
        add.textContent = 'Add upstream';
      }
    };
    banner.append(add);
    banner.classList.remove('hidden');
  }

  // Filter chips: "me" is the account of the integration this repo is listed through.
  const chips = $('items-chips');
  chips.innerHTML = '';
  for (const f of ['', ...(data.filters || [])]) {
    const b = el('button', f === filter ? 'on' : '', FILTERS[f].label);
    if (f) b.title = `@${data.me}`;
    b.onclick = async () => {
      if (f === filter) return;
      saveFilter(f);
      const q = $('items-filter').value;
      await openItemsDialog(project, data.remote, f);
      if (q && itemsCtx) {
        $('items-filter').value = q;
        $('items-filter').dispatchEvent(new Event('input'));
      }
    };
    chips.append(b);
  }
  chips.classList.remove('hidden');

  itemsCtx = { project, data, filter, prefix: isGitlab ? 'MR' : 'PR', search: null };
  $('items-filter').value = '';
  renderItems();
  $('items-filter').focus();
}

// State for the open Issues / PRs dialog.
let itemsCtx = null;
let itemsTimer = null;
let itemsSeq = 0;
let itemsCursor = 0;

function startItem(it) {
  const { project, data, prefix } = itemsCtx;
  $('dlg-items').close();
  const where = data.upstream && data.remote === 'origin' ? 'origin ' : '';
  const label = `${where}${it.kind === 'pr' ? prefix : 'Issue'} #${it.number} ${it.title}`;
  newAgent(project.path, label, { kind: it.kind, number: it.number, remote: data.remote });
}

function itemMatches(it, q) {
  if (!q) return true;
  const num = q.replace(/^#/, '');
  if (/^\d+$/.test(num)) return String(it.number).startsWith(num);
  return `${it.title} ${it.author || ''}`.toLowerCase().includes(q.toLowerCase());
}

// Local matches from the initial list, plus server search results not already shown.
function visibleItems(kind) {
  const q = $('items-filter').value.trim();
  const key = kind === 'pr' ? 'prs' : 'issues';
  const local = itemsCtx.data[key].filter((it) => itemMatches(it, q));
  const seen = new Set(local.map((it) => it.number));
  const remote = Array.isArray(itemsCtx.search?.[key]) ? itemsCtx.search[key].filter((it) => !seen.has(it.number)) : [];
  return [...local, ...remote];
}

function renderItems() {
  const prs = visibleItems('pr');
  const issues = visibleItems('issue');
  const all = [...prs, ...issues];
  itemsCursor = Math.max(0, Math.min(itemsCursor, all.length - 1));
  const searching = itemsCtx.search === 'loading';

  let idx = 0;
  const fill = (listId, items) => {
    const list = $(listId);
    list.innerHTML = '';
    const none = itemsCtx.filter ? `None open ${FILTERS[itemsCtx.filter].empty} @${itemsCtx.data.me}.` : 'None open.';
    if (!items.length) list.append(el('li', 'empty-row', searching ? 'Searching…' : $('items-filter').value ? 'No matches.' : none));
    for (const it of items) {
      const i = idx++;
      const li = el('li', i === itemsCursor ? 'selected' : '');
      li.append(el('span', 'num', `#${it.number}`), el('span', 'grow', it.title));
      if (it.state && !['open', 'opened'].includes(it.state)) li.append(el('span', 'tag', it.state));
      if (it.author) li.append(el('span', 'tag', it.author));
      li.title = it.url;
      li.onclick = () => startItem(it);
      li.onmouseenter = () => {
        itemsCursor = i;
        for (const x of document.querySelectorAll('#dlg-items .rows.pick li.selected')) x.classList.remove('selected');
        li.classList.add('selected');
      };
      list.append(li);
    }
  };
  fill('items-prs', prs);
  fill('items-issues', issues);
  if (itemsCtx.search?.error) showError('items-error', itemsCtx.search.error);
  return all;
}

$('items-filter').oninput = () => {
  if (!itemsCtx) return;
  itemsCursor = 0;
  clearTimeout(itemsTimer);
  const q = $('items-filter').value.trim();
  itemsCtx.search = q ? 'loading' : null;
  showError('items-error', null);
  renderItems();
  if (!q) return;
  // After a pause, ask the forge too: finds items beyond the first page, and any #number.
  const seq = ++itemsSeq;
  const { project, data } = itemsCtx;
  itemsTimer = setTimeout(async () => {
    let result;
    try {
      const qs = new URLSearchParams({ project: project.path, remote: data.remote, q });
      if (itemsCtx.filter) qs.set('filter', itemsCtx.filter);
      const r = await api('GET', `/api/forge/items?${qs}`);
      result = r.error ? { error: r.error } : { issues: r.issues, prs: r.prs };
    } catch (err) {
      result = { error: err.message };
    }
    if (seq !== itemsSeq) return;
    itemsCtx.search = result;
    renderItems();
  }, 400);
};

$('items-filter').onkeydown = (e) => {
  if (!itemsCtx || !['ArrowDown', 'ArrowUp', 'Enter'].includes(e.key)) return;
  e.preventDefault();
  const all = renderItems();
  if (e.key === 'Enter') {
    if (all[itemsCursor]) startItem(all[itemsCursor]);
    return;
  }
  itemsCursor = Math.max(0, Math.min(all.length - 1, itemsCursor + (e.key === 'ArrowDown' ? 1 : -1)));
  renderItems();
  document.querySelector('#dlg-items .rows.pick li.selected')?.scrollIntoView({ block: 'nearest' });
};
