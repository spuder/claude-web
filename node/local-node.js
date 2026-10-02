// A "node" is a machine that hosts projects and runs agents. LocalNode is the
// one in this process. Every method is async and takes/returns plain JSON, so a
// remote node can expose the same interface over SSH or a WebSocket. Nodes
// never call forge APIs or store tokens: the hub passes git auth in `env` for
// the one operation that needs it.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { SessionManager } = require('./sessions');

const run = promisify(execFile);
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const GIT_TIMEOUT = 10 * 60 * 1000;

// Drop session markers inherited when the server is itself started from a
// Claude Code session, so each spawned claude is a fresh top-level session.
const INHERITED_SESSION_VARS = [
  'CLAUDECODE', 'CLAUDE_PID', 'CLAUDE_EFFORT', 'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_SESSION_ATTENDED', 'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXECPATH', 'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN',
];

class NodeError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const gitMessage = (err) => (err.stderr || err.message || '').trim().slice(0, 300);

class LocalNode {
  constructor({ id = 'local', name = os.hostname(), root, claudeBin = 'claude', stateDir }) {
    this.id = id;
    this.name = name;
    this.root = root;
    this.worktreesRoot = path.join(root, '.worktrees'); // hidden, so not listed as a project
    this.claudeBin = claudeBin;
    this.sessions = new SessionManager({ stateDir });
  }

  async init() {
    await this.sessions.restore();
  }

  async info() {
    return { id: this.id, name: this.name, root: this.root };
  }

  // ---------- projects ----------

  readRemotes(dir) {
    const remotes = {};
    try {
      const cfg = fs.readFileSync(path.join(dir, '.git', 'config'), 'utf8');
      for (const m of cfg.matchAll(/\[remote "([^"]+)"\]([^[]*)/g)) {
        const url = m[2].match(/url\s*=\s*(\S+)/);
        if (url) remotes[m[1]] = url[1];
      }
    } catch {}
    return remotes;
  }

  describe(full) {
    return {
      name: path.basename(full),
      path: full,
      git: fs.existsSync(path.join(full, '.git')),
      claudeMd: fs.existsSync(path.join(full, 'CLAUDE.md')),
      remotes: this.readRemotes(full),
    };
  }

  async listProjects() {
    return fs
      .readdirSync(this.root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
      .map((d) => this.describe(path.join(this.root, d.name)))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  // Any directory on this machine (not only under root), or null.
  async getProject(p) {
    if (!p) return null;
    const full = path.resolve(String(p).replace(/^~/, os.homedir()));
    try {
      return fs.statSync(full).isDirectory() ? this.describe(full) : null;
    } catch {
      return null;
    }
  }

  newProjectDir(name) {
    name = String(name || '').trim();
    if (!NAME_RE.test(name)) {
      throw new NodeError(400, 'Use letters, numbers, ".", "_" or "-" (must start with a letter or number).');
    }
    const full = path.join(this.root, name);
    if (fs.existsSync(full)) throw new NodeError(409, `"${name}" already exists.`);
    return full;
  }

  async createProject({ name, git }) {
    const full = this.newProjectDir(name);
    fs.mkdirSync(full);
    if (git) await run('git', ['init', '-q'], { cwd: full });
    console.log(`[create] ${full}${git ? ' (git)' : ''}`);
    return { name: path.basename(full), path: full };
  }

  async clone({ url, name, env }) {
    const full = this.newProjectDir(name);
    console.log(`[clone] ${url} -> ${full}`);
    try {
      await run('git', ['clone', '--', url, full], { env: { ...process.env, ...env }, timeout: GIT_TIMEOUT });
    } catch (err) {
      fs.rmSync(full, { recursive: true, force: true });
      throw new NodeError(502, `git clone failed: ${gitMessage(err)}`);
    }
    return { name: path.basename(full), path: full };
  }

  async addRemote({ path: dir, name, url, fetch, env }) {
    try {
      await run('git', ['remote', 'add', name, url], { cwd: dir });
      if (fetch) await run('git', ['fetch', '--quiet', name], { cwd: dir, env: { ...process.env, ...env }, timeout: GIT_TIMEOUT });
    } catch (err) {
      throw new NodeError(502, `Adding remote "${name}" failed: ${gitMessage(err)}`);
    }
    console.log(`[remote] ${dir}: ${name} -> ${url}`);
  }

  // A dedicated worktree per issue/PR so parallel agents don't fight over one
  // checkout. Reopening the same slug reuses it.
  //   prFetch: { remote, ref } to check out a PR head
  //   base:    { remote, branch } to start a new branch from (default HEAD)
  async prepareWorktree({ project, slug, prFetch, base, env }) {
    if (!/^[\w.-]+$/.test(slug)) throw new NodeError(400, 'Invalid worktree name.');
    const wt = path.join(this.worktreesRoot, path.basename(project), slug);
    if (fs.existsSync(wt)) return { dir: wt, branch: slug };

    fs.mkdirSync(path.dirname(wt), { recursive: true });
    const git = (args) => run('git', args, { cwd: project, env: { ...process.env, ...env }, timeout: GIT_TIMEOUT });
    try {
      if (prFetch) {
        // Force-update the local branch to the PR's current head.
        await git(['fetch', prFetch.remote, `+${prFetch.ref}:refs/heads/${slug}`]);
        await git(['worktree', 'add', wt, slug]);
        return { dir: wt, branch: slug };
      }
      const branchExists = await git(['rev-parse', '--verify', '--quiet', `refs/heads/${slug}`]).then(
        () => true,
        () => false
      );
      if (branchExists) {
        await git(['worktree', 'add', wt, slug]);
        return { dir: wt, branch: slug };
      }
      let from = 'HEAD';
      if (base) {
        await git(['fetch', '--quiet', base.remote, base.branch]);
        from = `${base.remote}/${base.branch}`;
      }
      await git(['worktree', 'add', '--no-track', '-b', slug, wt, from]);
      return { dir: wt, branch: slug, base: from };
    } catch (err) {
      throw new NodeError(502, gitMessage(err));
    }
  }

  // ---------- sessions ----------

  async listSessions() {
    return this.sessions.list();
  }

  async startSession({ cwd, args = [], env = {}, cols, rows, meta }) {
    const base = { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' };
    for (const k of INHERITED_SESSION_VARS) delete base[k];
    try {
      return await this.sessions.start({ cwd, command: this.claudeBin, args, env: { ...base, ...env }, cols, rows, meta });
    } catch (err) {
      throw new NodeError(500, `Failed to start claude: ${gitMessage(err)}`);
    }
  }

  // Not JSON: a remote transport turns this into a stream of messages.
  attachSession(id, onEvent) {
    return this.sessions.attach(id, onEvent);
  }

  async killSession(id) {
    await this.sessions.kill(id);
  }
}

module.exports = { LocalNode, NodeError };
