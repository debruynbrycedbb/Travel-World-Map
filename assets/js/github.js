// Saving to GitHub.
// All entries live in one file in the repository (assets/data/entries.json) and uploaded photos
// live in assets/images/uploads/. Every change is one commit made through the GitHub API with a
// fine-grained access token that the owner pastes into the site once per device.
// Visitors without a token read the same file from GitHub Pages and can only view.

const CFG_KEY = 'travel-world-map:github';
export const DATA_PATH = 'assets/data/entries.json';
export const UPLOAD_DIR = 'assets/images/uploads/';

export function loadConfig() {
  try {
    const c = JSON.parse(localStorage.getItem(CFG_KEY) || 'null');
    return c && c.owner && c.repo && c.token ? c : null;
  } catch { return null; }
}
export function saveConfig(cfg) {
  try { localStorage.setItem(CFG_KEY, JSON.stringify(cfg)); return true; } catch { return false; }
}
export function clearConfig() {
  try { localStorage.removeItem(CFG_KEY); } catch { /* ignore */ }
}

// "debruynbrycedbb.github.io/Travel-World-Map/" -> debruynbrycedbb / Travel-World-Map
export function guessRepo() {
  const m = location.hostname.match(/^([\w-]+)\.github\.io$/i);
  if (!m) return { owner: '', repo: '' };
  const seg = location.pathname.split('/').filter(Boolean)[0];
  return { owner: m[1], repo: seg || `${m[1]}.github.io` };
}

export class GitHubError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

function b64FromUtf8(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export class GitHubStore {
  constructor({ owner, repo, branch = 'main', token }) {
    this.owner = owner; this.repo = repo; this.branch = branch || 'main'; this.token = token;
    this.queue = Promise.resolve();
  }

  rawUrl(path) {
    return `https://raw.githubusercontent.com/${this.owner}/${this.repo}/${this.branch}/${path.split('/').map(encodeURIComponent).join('/')}`;
  }

  async api(path, { method = 'GET', body, raw = false } = {}) {
    let res;
    try {
      res = await fetch(`https://api.github.com/repos/${this.owner}/${this.repo}/${path}`, {
        method,
        cache: 'no-store',
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw new GitHubError('Can’t reach GitHub. Check your internet connection and try again.', 0);
    }
    if (!res.ok) {
      let msg = '';
      try { msg = (await res.json()).message || ''; } catch { /* ignore */ }
      throw new GitHubError(explain(res.status, msg, this), res.status);
    }
    return raw ? res.text() : res.json();
  }

  async head() {
    const ref = await this.api(`git/ref/heads/${encodeURIComponent(this.branch)}`);
    const commit = await this.api(`git/commits/${ref.object.sha}`);
    return { commitSha: ref.object.sha, treeSha: commit.tree.sha };
  }

  async readEntries(commitSha) {
    try {
      const text = await this.api(`contents/${DATA_PATH}?ref=${commitSha}`, { raw: true });
      const data = JSON.parse(text);
      return Array.isArray(data) ? data : (data.entries || []);
    } catch (err) {
      if (err.status === 404) return [];
      if (err instanceof SyntaxError) throw new GitHubError(`${DATA_PATH} in the repository isn’t valid JSON.`, 0);
      throw err;
    }
  }

  async load() {
    const { commitSha } = await this.head();
    return this.readEntries(commitSha);
  }

  // Apply `change(entries) -> { entries, files, message }` on top of the latest version in the
  // repo and commit it. `files` maps repo paths to base64 content (add/replace) or null (delete).
  // Changes are queued so commits from this tab never overlap; if another device committed in
  // between, the change is re-applied on top of that version.
  commit(change) {
    const run = async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        const { commitSha, treeSha } = await this.head();
        const current = await this.readEntries(commitSha);
        const { entries, files = {}, message } = change(current);
        const json = JSON.stringify({ about: ABOUT, entries }, null, 2) + '\n';

        const tree = [{ path: DATA_PATH, mode: '100644', type: 'blob', content: json }];
        const deletions = [];
        for (const [path, b64] of Object.entries(files)) {
          if (b64 === null) { deletions.push({ path, mode: '100644', type: 'blob', sha: null }); continue; }
          const blob = await this.api('git/blobs', { method: 'POST', body: { content: b64, encoding: 'base64' } });
          tree.push({ path, mode: '100644', type: 'blob', sha: blob.sha });
        }
        let newTree;
        try {
          newTree = await this.api('git/trees', { method: 'POST', body: { base_tree: treeSha, tree: [...tree, ...deletions] } });
        } catch (err) {
          if (err.status !== 422 || !deletions.length) throw err;
          // a photo to remove was already gone; commit without removing files
          newTree = await this.api('git/trees', { method: 'POST', body: { base_tree: treeSha, tree } });
        }
        const commit = await this.api('git/commits', { method: 'POST', body: { message, tree: newTree.sha, parents: [commitSha] } });
        try {
          await this.api(`git/refs/heads/${encodeURIComponent(this.branch)}`, { method: 'PATCH', body: { sha: commit.sha, force: false } });
          return entries;
        } catch (err) {
          if (err.status === 422 && attempt < 2) continue; // someone else committed first: retry on top
          throw err;
        }
      }
      throw new GitHubError('GitHub kept changing while saving. Try again in a moment.', 0);
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => {});
    return p;
  }
}

const ABOUT = 'Travel World Map data. Edited from the site; each change is one commit.';

function explain(status, msg, s) {
  if (status === 401) return 'GitHub didn’t accept the access token. It may have expired or been revoked. Reconnect with a new token in ⋯ → Saving to GitHub.';
  if (status === 403 && /rate limit/i.test(msg)) return 'GitHub’s rate limit was reached. Wait a few minutes and try again.';
  if (status === 403) {
    return `The token can’t write to ${s.owner}/${s.repo}. Give it access to that repository with “Contents: Read and write”.`;
  }
  if (status === 404) return `Couldn’t open ${s.owner}/${s.repo} (branch “${s.branch}”) with this token. Check the repository name and branch, and that the token has access to that repository.`;
  if (status === 409) return 'The repository is empty or the branch is missing.';
  return `GitHub returned an error (${status}${msg ? `: ${msg}` : ''}).`;
}

// data:image/jpeg;base64,xxxx -> xxxx
export function dataUrlToBase64(dataUrl) {
  const i = dataUrl.indexOf(',');
  return i >= 0 ? dataUrl.slice(i + 1) : '';
}
export { b64FromUtf8 };
