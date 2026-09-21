// Uses the private data repo as the source of truth: every hike save/delete
// is a single git commit (via the Git Data API: blobs -> tree -> commit -> ref),
// and other devices pick up changes by pulling the latest tree.
// No server: every call here runs from the browser using a repo-scoped token.
const GitHubSync = (() => {
  const API = 'https://api.github.com';
  const CFG_KEY = 'trail-log-gh-config'; // { owner, repo, branch, token }

  function getConfig() {
    try { return JSON.parse(localStorage.getItem(CFG_KEY)) || null; }
    catch { return null; }
  }

  function setConfig(cfg) {
    localStorage.setItem(CFG_KEY, JSON.stringify(cfg));
  }

  function clearConfig() {
    localStorage.removeItem(CFG_KEY);
  }

  function isConfigured() {
    const c = getConfig();
    return !!(c && c.owner && c.repo && c.token);
  }

  async function api(path, options = {}) {
    const cfg = getConfig();
    if (!cfg) throw new Error('Not connected to GitHub');
    const res = await fetch(`${API}${path}`, {
      ...options,
      headers: {
        'Authorization': `Bearer ${cfg.token}`,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...options.headers,
      },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const err = new Error(`GitHub API ${res.status} on ${path}: ${body.slice(0, 200)}`);
      err.status = res.status;
      throw err;
    }
    if (res.status === 204) return null;
    return res.json();
  }

  // ---------- unicode-safe base64 helpers ----------
  function b64FromString(str) {
    const bytes = new TextEncoder().encode(str);
    let binary = '';
    bytes.forEach(b => { binary += String.fromCharCode(b); });
    return btoa(binary);
  }
  function stringFromB64(b64) {
    const binary = atob(b64.replace(/\n/g, ''));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }
  function dataUrlToBase64(dataUrl) {
    const idx = dataUrl.indexOf(',');
    return idx >= 0 ? dataUrl.slice(idx + 1) : dataUrl;
  }

  // ---------- connection test ----------
  async function testConnection(cfg) {
    const prev = getConfig();
    setConfig(cfg);
    try {
      const repoInfo = await api(`/repos/${cfg.owner}/${cfg.repo}`);
      const branch = repoInfo.default_branch || 'main';
      setConfig({ ...cfg, branch });
      return { ok: true, branch, private: repoInfo.private };
    } catch (err) {
      if (prev) setConfig(prev); else clearConfig();
      throw err;
    }
  }

  // ---------- low-level git data api ----------
  async function getRef(cfg) {
    try {
      return await api(`/repos/${cfg.owner}/${cfg.repo}/git/ref/heads/${cfg.branch}`);
    } catch (err) {
      if (err.status === 404) return null; // empty repo, branch doesn't exist yet
      throw err;
    }
  }

  async function getTree(cfg, treeSha) {
    return api(`/repos/${cfg.owner}/${cfg.repo}/git/trees/${treeSha}?recursive=1`);
  }

  async function createBlob(cfg, contentBase64) {
    const res = await api(`/repos/${cfg.owner}/${cfg.repo}/git/blobs`, {
      method: 'POST',
      body: JSON.stringify({ content: contentBase64, encoding: 'base64' }),
    });
    return res.sha;
  }

  async function fetchBlobContent(cfg, sha) {
    const cached = await TrailDB.blobGet(sha);
    if (cached) return cached.contentBase64;
    const res = await api(`/repos/${cfg.owner}/${cfg.repo}/git/blobs/${sha}`);
    await TrailDB.blobPut(sha, res.content, null);
    return res.content;
  }

  // ---------- remote tree state ----------
  // Returns { commitSha, treeSha, files: Map(path -> sha) } or null for an empty repo.
  async function getRemoteState(cfg) {
    const ref = await getRef(cfg);
    if (!ref) return null;
    const commit = await api(`/repos/${cfg.owner}/${cfg.repo}/git/commits/${ref.object.sha}`);
    const tree = await getTree(cfg, commit.tree.sha);
    const files = new Map();
    tree.tree.forEach(entry => {
      if (entry.type === 'blob') files.set(entry.path, entry.sha);
    });
    return { commitSha: ref.object.sha, treeSha: commit.tree.sha, files };
  }

  // ---------- pull: hydrate local IndexedDB from the repo ----------
  async function pull(onProgress) {
    const cfg = getConfig();
    if (!cfg) throw new Error('Not connected to GitHub');
    const remote = await getRemoteState(cfg);
    if (!remote) return { hikeCount: 0 }; // repo has no commits yet

    const hikePaths = Array.from(remote.files.keys()).filter(p => p.startsWith('hikes/') && p.endsWith('.json'));
    const localHikes = await TrailDB.getAll();
    const localIds = new Set(localHikes.map(h => h.id));
    const remoteIds = new Set();

    let done = 0;
    for (const path of hikePaths) {
      const id = path.slice('hikes/'.length, -'.json'.length);
      remoteIds.add(id);
      const sha = remote.files.get(path);
      const existing = localHikes.find(h => h.id === id);
      if (existing && existing._remoteSha === sha) { done++; continue; } // unchanged

      const jsonB64 = await fetchBlobContent(cfg, sha);
      const hike = JSON.parse(stringFromB64(jsonB64));
      hike._remoteSha = sha;

      // hydrate photo data URLs from the tree's current blob shas
      for (const photo of hike.photos || []) {
        const photoSha = remote.files.get(photo.path);
        if (!photoSha) continue; // referenced file missing from tree; skip
        const photoB64 = await fetchBlobContent(cfg, photoSha);
        photo.dataUrl = `data:image/jpeg;base64,${photoB64.replace(/\n/g, '')}`;
      }

      await TrailDB.put(hike);
      done++;
      if (onProgress) onProgress(done, hikePaths.length);
    }

    // remove local hikes that were deleted remotely (on another device)
    for (const id of localIds) {
      if (!remoteIds.has(id) && !(await isPendingLocalOnly(id))) {
        await TrailDB.remove(id);
      }
    }

    await TrailDB.metaSet('lastSync', Date.now());
    return { hikeCount: hikePaths.length };
  }

  async function isPendingLocalOnly(id) {
    const h = await TrailDB.get(id);
    return !!(h && h._pendingSync);
  }

  // ---------- push: commit a hike save (create or update) as one commit ----------
  async function commitHike(hike, previousPhotoPaths) {
    const cfg = getConfig();
    if (!cfg) throw new Error('Not connected to GitHub');
    const remote = await getRemoteState(cfg); // null if empty repo

    const treeEntries = [];
    const outgoingPhotos = [];

    for (const photo of hike.photos || []) {
      if (photo.path) {
        // already committed previously (edit flow, photo untouched)
        outgoingPhotos.push({ id: photo.id, path: photo.path });
        continue;
      }
      const path = `photos/${hike.id}/${photo.id}.jpg`;
      const blobSha = await createBlob(cfg, dataUrlToBase64(photo.dataUrl));
      treeEntries.push({ path, mode: '100644', type: 'blob', sha: blobSha });
      outgoingPhotos.push({ id: photo.id, path });
    }

    // remove photos that existed before this edit but were deleted in the UI
    const keptPaths = new Set(outgoingPhotos.map(p => p.path));
    (previousPhotoPaths || []).forEach(path => {
      if (!keptPaths.has(path)) treeEntries.push({ path, mode: '100644', type: 'blob', sha: null });
    });

    const hikeForRemote = { ...hike, photos: outgoingPhotos };
    delete hikeForRemote._remoteSha;
    delete hikeForRemote._pendingSync;
    const hikeJsonPath = `hikes/${hike.id}.json`;
    const jsonBlobSha = await createBlob(cfg, b64FromString(JSON.stringify(hikeForRemote, null, 2)));
    treeEntries.push({ path: hikeJsonPath, mode: '100644', type: 'blob', sha: jsonBlobSha });

    const newTree = await api(`/repos/${cfg.owner}/${cfg.repo}/git/trees`, {
      method: 'POST',
      body: JSON.stringify({
        ...(remote ? { base_tree: remote.treeSha } : {}),
        tree: treeEntries,
      }),
    });

    const commit = await api(`/repos/${cfg.owner}/${cfg.repo}/git/commits`, {
      method: 'POST',
      body: JSON.stringify({
        message: `${previousPhotoPaths ? 'Update' : 'Add'} hike: ${hike.trailName}`,
        tree: newTree.sha,
        parents: remote ? [remote.commitSha] : [],
      }),
    });

    if (remote) {
      await api(`/repos/${cfg.owner}/${cfg.repo}/git/refs/heads/${cfg.branch}`, {
        method: 'PATCH',
        body: JSON.stringify({ sha: commit.sha }),
      });
    } else {
      await api(`/repos/${cfg.owner}/${cfg.repo}/git/refs`, {
        method: 'POST',
        body: JSON.stringify({ ref: `refs/heads/${cfg.branch}`, sha: commit.sha }),
      });
    }

    const mergedPhotos = outgoingPhotos.map(op => ({
      ...op,
      dataUrl: (hike.photos.find(p => p.id === op.id) || {}).dataUrl,
    }));
    return { ...hikeForRemote, photos: mergedPhotos, _remoteSha: jsonBlobSha };
  }

  // ---------- push: commit a hike deletion ----------
  async function commitDeleteHike(hike) {
    const cfg = getConfig();
    if (!cfg) throw new Error('Not connected to GitHub');
    const remote = await getRemoteState(cfg);
    if (!remote) return; // nothing committed yet, nothing to delete

    const hikeJsonPath = `hikes/${hike.id}.json`;
    const treeEntries = [];
    if (remote.files.has(hikeJsonPath)) treeEntries.push({ path: hikeJsonPath, mode: '100644', type: 'blob', sha: null });
    (hike.photos || []).forEach(p => {
      if (p.path && remote.files.has(p.path)) treeEntries.push({ path: p.path, mode: '100644', type: 'blob', sha: null });
    });
    if (!treeEntries.length) return;

    const newTree = await api(`/repos/${cfg.owner}/${cfg.repo}/git/trees`, {
      method: 'POST',
      body: JSON.stringify({ base_tree: remote.treeSha, tree: treeEntries }),
    });
    const commit = await api(`/repos/${cfg.owner}/${cfg.repo}/git/commits`, {
      method: 'POST',
      body: JSON.stringify({
        message: `Delete hike: ${hike.trailName}`,
        tree: newTree.sha,
        parents: [remote.commitSha],
      }),
    });
    await api(`/repos/${cfg.owner}/${cfg.repo}/git/refs/heads/${cfg.branch}`, {
      method: 'PATCH',
      body: JSON.stringify({ sha: commit.sha }),
    });
  }

  return {
    getConfig, setConfig, clearConfig, isConfigured,
    testConnection, pull, commitHike, commitDeleteHike,
  };
})();
