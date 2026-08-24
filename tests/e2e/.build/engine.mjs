// tests/e2e/obsidian-shim.mjs
function normalizePath(p) {
  return p.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\/|\/$/g, "");
}
async function requestUrl(options) {
  const { url, method = "GET", headers = {}, body, throw: doThrow = true } = options;
  const res = await fetch(url, { method, headers, body });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : void 0;
  } catch {
    json = void 0;
  }
  if (doThrow && res.status >= 400) {
    throw new Error(`Request failed, status ${res.status}`);
  }
  return { status: res.status, text, json, headers: Object.fromEntries(res.headers) };
}

// src/gitHash.ts
var encoder = new TextEncoder();
async function gitBlobSha(content) {
  const header = encoder.encode(`blob ${content.byteLength}\0`);
  const payload = new Uint8Array(header.byteLength + content.byteLength);
  payload.set(header, 0);
  payload.set(new Uint8Array(content), header.byteLength);
  const digest = await crypto.subtle.digest("SHA-1", payload);
  return hex(digest);
}
async function gitBlobShaOfText(text) {
  const bytes = encoder.encode(text);
  return gitBlobSha(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}
function hex(buffer) {
  return Array.from(new Uint8Array(buffer)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
function base64ToBytes(base64) {
  const clean = base64.replace(/\s/g, "");
  const binary = atob(clean);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}
function bytesToBase64(content) {
  const bytes = new Uint8Array(content);
  let binary = "";
  const CHUNK = 32768;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

// src/github.ts
function errorStatus(err) {
  return err instanceof Error ? err.status : void 0;
}
var GitHubClient = class {
  constructor(host, token) {
    this.host = host;
    this.token = token;
  }
  async api(path) {
    return this.request("GET", path);
  }
  async request(method, path, body) {
    const res = await requestUrl({
      url: `${this.host.apiBase}${path}`,
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...body === void 0 ? {} : { "Content-Type": "application/json" }
      },
      body: body === void 0 ? void 0 : JSON.stringify(body),
      throw: false
    });
    if (res.status >= 400) {
      const message = res.json?.message ?? res.text ?? "";
      const err = new Error(`GitHub API ${res.status} on ${path}: ${message}`);
      err.status = res.status;
      throw err;
    }
    return res.json;
  }
  /** The authenticated user's login — the cheapest proof the token works. */
  async currentUser() {
    return this.api("/user");
  }
  async listDirectory(owner, repo, dirPath = "") {
    const suffix = dirPath ? `/${encodeURI(dirPath.replace(/^\/+/, ""))}` : "";
    const json = await this.api(`/repos/${owner}/${repo}/contents${suffix}`);
    if (!Array.isArray(json)) throw new Error(`${dirPath || "/"} is a file, not a directory.`);
    return json;
  }
  /** Read a text file's contents. Uses the raw media type, so no base64 decode. */
  async readFile(owner, repo, filePath) {
    const res = await requestUrl({
      url: `${this.host.apiBase}/repos/${owner}/${repo}/contents/${encodeURI(filePath.replace(/^\/+/, ""))}`,
      method: "GET",
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/vnd.github.raw+json",
        "X-GitHub-Api-Version": "2022-11-28"
      },
      throw: false
    });
    if (res.status >= 400) throw new Error(`GitHub API ${res.status} reading ${filePath}`);
    return res.text;
  }
  /** Resolve a branch name to its current head commit SHA. */
  async branchHead(owner, repo, branch) {
    const json = await this.api(`/repos/${owner}/${repo}/branches/${encodeURIComponent(branch)}`);
    return json.commit.sha;
  }
  /** The repo's default branch, used when the user hasn't picked one. */
  async defaultBranch(owner, repo) {
    const json = await this.api(`/repos/${owner}/${repo}`);
    return json.default_branch;
  }
  /**
   * Every blob in a commit, one request. This is the full-sync path and the
   * fallback when a diff is unusable.
   */
  async listTree(owner, repo, commitSha) {
    const json = await this.api(
      `/repos/${owner}/${repo}/git/trees/${commitSha}?recursive=1`
    );
    if (json.truncated) {
      throw new Error(
        "Repository tree exceeds GitHub's listing limit \u2014 too large to sync as a single tree."
      );
    }
    return json.tree.filter((e) => e.type === "blob").map((e) => ({ path: e.path, sha: e.sha, size: e.size ?? 0 }));
  }
  /**
   * Changed paths between two commits — the heart of incremental sync.
   *
   * One request replaces walking the whole tree, so a sync that changed three
   * notes costs three downloads instead of re-listing thousands of files.
   */
  async compare(owner, repo, base, head) {
    const json = await this.api(
      `/repos/${owner}/${repo}/compare/${base}...${head}?per_page=300`
    );
    const files = json.files ?? [];
    return {
      status: json.status,
      files,
      // GitHub silently caps the file list at 300; beyond that the diff lies
      // by omission, so callers must fall back to a full tree comparison.
      truncated: files.length >= 300,
      total_commits: json.total_commits ?? 0
    };
  }
  /**
   * Fetch a blob by SHA rather than by path.
   *
   * Path-based reads resolve against a branch tip, which can move mid-sync and
   * silently hand back content from a different commit than the diff described.
   * Addressing the blob directly pins the bytes to the commit we planned
   * against. Returns base64 for binary safety.
   */
  async readBlob(owner, repo, blobSha) {
    const json = await this.api(`/repos/${owner}/${repo}/git/blobs/${blobSha}`);
    if (json.encoding !== "base64") {
      throw new Error(`Unexpected blob encoding "${json.encoding}" for ${blobSha}`);
    }
    return base64ToBytes(json.content);
  }
  /**
   * Upload raw bytes as a blob and return its SHA.
   *
   * Everything goes up base64-encoded rather than as inline UTF-8 text: a vault
   * holds images and PDFs alongside notes, and even a note can contain bytes
   * that don't survive a JSON round-trip intact.
   */
  async createBlob(owner, repo, content) {
    const json = await this.request("POST", `/repos/${owner}/${repo}/git/blobs`, {
      content: bytesToBase64(content),
      encoding: "base64"
    });
    return json.sha;
  }
  /**
   * Create a tree layered on top of `baseTree`, so only changed paths need
   * listing. Entries with `sha: null` remove a path.
   */
  async createTree(owner, repo, baseTree, entries) {
    const json = await this.request("POST", `/repos/${owner}/${repo}/git/trees`, {
      base_tree: baseTree,
      tree: entries
    });
    return json.sha;
  }
  async createCommit(owner, repo, message, treeSha, parents) {
    const json = await this.request("POST", `/repos/${owner}/${repo}/git/commits`, {
      message,
      tree: treeSha,
      parents
    });
    return json.sha;
  }
  /**
   * Move a branch to `commitSha`, refusing anything but a fast-forward.
   *
   * `force: false` is the whole concurrency story: if someone else pushed since
   * we read the head, GitHub rejects with 422 and we re-plan against the new
   * head instead of clobbering their commit.
   */
  async updateRef(owner, repo, branch, commitSha) {
    await this.request("PATCH", `/repos/${owner}/${repo}/git/refs/heads/${branch}`, {
      sha: commitSha,
      force: false
    });
  }
};

// src/sync.ts
function isRefused(path) {
  return path === ".obsidian" || path.startsWith(".obsidian/") || path.includes("/.obsidian/");
}
var MAX_DELETION_FRACTION = 0.1;
var MIN_DELETIONS_BEFORE_GUARD = 5;
function conflictStamp() {
  const d = /* @__PURE__ */ new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}.${pad(d.getMinutes())}`;
}
var SyncEngine = class {
  constructor(vault, client, opts) {
    this.vault = vault;
    this.client = client;
    this.opts = opts;
    this.adapter = vault.adapter;
  }
  /** Map a repo path to its vault path, or null if outside the synced subtree. */
  toVaultPath(repoPath) {
    const prefix = this.opts.remoteFolder ? `${this.opts.remoteFolder.replace(/\/+$/, "")}/` : "";
    if (prefix && !repoPath.startsWith(prefix)) return null;
    const relative = repoPath.slice(prefix.length);
    if (!relative || isRefused(relative)) return null;
    const folder = this.opts.targetFolder.replace(/\/+$/, "");
    return normalizePath(folder ? `${folder}/${relative}` : relative);
  }
  /**
   * Decide what to do. Incremental when we have a known-good previous commit
   * and GitHub can describe the diff; full otherwise.
   */
  async plan(state) {
    const { owner, repo, branch } = this.opts;
    const head = await this.client.branchHead(owner, repo, branch);
    if (state?.commit === head) {
      return {
        mode: "incremental",
        reason: "Already at the latest commit.",
        targetCommit: head,
        writes: [],
        deletes: [],
        unchanged: Object.keys(state.blobs).length
      };
    }
    if (state?.commit) {
      const incremental = await this.tryIncrementalPlan(state, head);
      if (incremental) return incremental;
    }
    return this.fullPlan(head, state?.commit ? "Diff unusable \u2014 falling back to a full sync." : "First sync.");
  }
  /** Returns null when the diff can't be trusted and a full sync is required. */
  async tryIncrementalPlan(state, head) {
    const { owner, repo } = this.opts;
    let comparison;
    try {
      comparison = await this.client.compare(owner, repo, state.commit, head);
    } catch (err) {
      console.warn("[github-sync] compare failed, will full-sync", err);
      return null;
    }
    if (comparison.status === "diverged") return null;
    if (comparison.truncated) return null;
    const writes = [];
    const deletes = [];
    for (const file of comparison.files) {
      this.applyCompareEntry(file, writes, deletes);
    }
    return {
      mode: "incremental",
      reason: `${comparison.total_commits} commit(s), ${comparison.files.length} changed path(s).`,
      targetCommit: head,
      writes,
      deletes,
      unchanged: Object.keys(state.blobs).length - writes.length - deletes.length
    };
  }
  applyCompareEntry(file, writes, deletes) {
    const vaultPath = this.toVaultPath(file.filename);
    if (file.status === "removed") {
      if (vaultPath) deletes.push(vaultPath);
      return;
    }
    if (file.status === "renamed" && file.previous_filename) {
      const oldPath = this.toVaultPath(file.previous_filename);
      if (oldPath) deletes.push(oldPath);
    }
    if (file.status === "unchanged") return;
    if (vaultPath) writes.push({ path: vaultPath, blobSha: file.sha });
  }
  async fullPlan(head, reason) {
    const tree = await this.client.listTree(this.opts.owner, this.opts.repo, head);
    const writes = [];
    for (const blob of tree) {
      const vaultPath = this.toVaultPath(blob.path);
      if (vaultPath) writes.push({ path: vaultPath, blobSha: blob.sha });
    }
    return { mode: "full", reason, targetCommit: head, writes, deletes: [], unchanged: 0 };
  }
  /**
   * Apply a plan, verifying every written file.
   *
   * Verification recomputes each file's git blob SHA from what actually landed
   * on disk and compares it to the SHA GitHub published. That catches truncated
   * writes and encoding damage without a single extra network request.
   */
  async apply(plan, state, onProgress) {
    const blobs = { ...state?.blobs ?? {} };
    const report = {
      mode: plan.mode,
      commit: plan.targetCommit,
      added: 0,
      updated: 0,
      deleted: 0,
      unchanged: plan.unchanged,
      skippedLocalEdits: [],
      conflicts: [],
      verifiedFiles: 0,
      integrityFailures: [],
      reason: plan.reason
    };
    const total = plan.writes.length + plan.deletes.length;
    let done = 0;
    for (const write of plan.writes) {
      const exists = await this.adapter.exists(write.path);
      if (exists && blobs[write.path] === write.blobSha) {
        if (await this.hashOnDisk(write.path) === write.blobSha) {
          report.unchanged++;
          onProgress?.(++done, total);
          continue;
        }
      }
      if (exists && blobs[write.path]) {
        const onDisk = await this.hashOnDisk(write.path);
        if (onDisk !== blobs[write.path]) {
          const copy = await this.makeConflictCopy(write.path);
          if (copy) {
            report.conflicts.push(copy);
          } else {
            report.skippedLocalEdits.push(write.path);
            onProgress?.(++done, total);
            continue;
          }
        }
      }
      const content = await this.client.readBlob(this.opts.owner, this.opts.repo, write.blobSha);
      await this.ensureParentFolder(write.path);
      await this.writeFile(write.path, content);
      if (exists) report.updated++;
      else report.added++;
      const actual = await this.hashOnDisk(write.path);
      if (actual === write.blobSha) {
        blobs[write.path] = write.blobSha;
        report.verifiedFiles++;
      } else {
        report.integrityFailures.push(
          actual === null ? `${write.path} (missing after write)` : `${write.path} (sha mismatch)`
        );
        delete blobs[write.path];
      }
      onProgress?.(++done, total);
    }
    for (const path of plan.deletes) {
      if (await this.removeFile(path)) report.deleted++;
      delete blobs[path];
      onProgress?.(++done, total);
    }
    if (plan.mode === "full") {
      const planned = new Set(plan.writes.map((w) => w.path));
      for (const tracked of Object.keys(blobs)) {
        if (planned.has(tracked)) continue;
        if (await this.removeFile(tracked)) report.deleted++;
        delete blobs[tracked];
      }
    }
    const clean = report.integrityFailures.length === 0 && report.skippedLocalEdits.length === 0;
    const newState = {
      commit: clean ? plan.targetCommit : state?.commit ?? "",
      blobs,
      lastSyncedAt: Date.now()
    };
    return { report, state: newState };
  }
  /**
   * Push local changes to the branch via the Git Data API.
   *
   * Must run *after* a clean pull: `state.commit` has to be the branch head, so
   * every difference between the disk and `state.blobs` is genuinely a local
   * change rather than a remote one we haven't fetched. The whole push is one
   * commit, and the ref update is a fast-forward-only compare-and-swap, so a
   * concurrent push from another device is detected rather than clobbered.
   */
  async push(state, onProgress) {
    const { owner, repo, branch } = this.opts;
    const report = { uploaded: [], removed: [], commit: null, raced: false, blocked: null };
    const head = await this.client.branchHead(owner, repo, branch);
    if (head !== state.commit) {
      report.raced = true;
      return { report, state };
    }
    const changes = await this.detectLocalChanges(state);
    if (changes.changed.length === 0 && changes.removed.length === 0) {
      return { report, state };
    }
    const tracked = Object.keys(state.blobs).length;
    if (tracked > 0 && changes.removed.length > MIN_DELETIONS_BEFORE_GUARD && changes.removed.length / tracked > MAX_DELETION_FRACTION) {
      report.blocked = `Refusing to push: ${changes.removed.length} of ${tracked} synced files are missing locally. Run a full resync if this is intentional.`;
      return { report, state };
    }
    const total = changes.changed.length + 1;
    let done = 0;
    const entries = [];
    const newBlobs = { ...state.blobs };
    for (const path of changes.changed) {
      const content = await this.adapter.readBinary(path);
      const sha = await this.client.createBlob(owner, repo, content);
      entries.push({ path: this.toRepoPath(path), mode: "100644", type: "blob", sha });
      newBlobs[path] = await gitBlobSha(content);
      report.uploaded.push(path);
      onProgress?.(++done, total);
    }
    for (const path of changes.removed) {
      entries.push({ path: this.toRepoPath(path), mode: "100644", type: "blob", sha: null });
      delete newBlobs[path];
      report.removed.push(path);
    }
    const message = this.commitMessage(report);
    const treeSha = await this.client.createTree(owner, repo, head, entries);
    const commitSha = await this.client.createCommit(owner, repo, message, treeSha, [head]);
    try {
      await this.client.updateRef(owner, repo, branch, commitSha);
    } catch (err) {
      if (errorStatus(err) === 422) {
        report.raced = true;
        return { report, state };
      }
      throw err;
    }
    onProgress?.(++done, total);
    report.commit = commitSha;
    return {
      report,
      state: { commit: commitSha, blobs: newBlobs, lastSyncedAt: Date.now() }
    };
  }
  commitMessage(report) {
    const parts = [];
    if (report.uploaded.length) parts.push(`${report.uploaded.length} updated`);
    if (report.removed.length) parts.push(`${report.removed.length} removed`);
    const detail = parts.join(", ");
    const only = report.uploaded.length + report.removed.length === 1;
    const subject = only ? `Update ${report.uploaded[0] ?? report.removed[0]}` : `Sync ${detail}`;
    return `${subject}

From ${this.opts.deviceLabel} via obsidian-github-sync.`;
  }
  /**
   * Compare the disk against the last-synced blob SHAs.
   *
   * `changed` covers both edits and brand-new files; `removed` is a path we
   * previously synced that is no longer on disk. An untracked file that isn't
   * on disk simply never appears.
   */
  async detectLocalChanges(state) {
    const changed = [];
    const removed = [];
    const onDisk = await this.listLocalFiles();
    for (const path of onDisk) {
      const sha = await this.hashOnDisk(path);
      if (sha && sha !== state.blobs[path]) changed.push(path);
    }
    const present = new Set(onDisk);
    for (const path of Object.keys(state.blobs)) {
      if (!present.has(path)) removed.push(path);
    }
    return { changed, removed };
  }
  /**
   * Every syncable file under the target folder, listed from the filesystem.
   *
   * The Vault index is not used here for the same reason writes don't use it:
   * a file the user just created may not be indexed yet, and silently not
   * pushing it is worse than a slightly slower walk.
   */
  async listLocalFiles() {
    const root = this.opts.targetFolder.replace(/\/+$/, "");
    const found = [];
    const queue = [root];
    while (queue.length) {
      const dir = queue.shift();
      if (dir && !await this.adapter.exists(dir)) continue;
      const listing = await this.adapter.list(dir === "" ? "/" : dir);
      for (const folder of listing.folders) {
        if (this.isSkippedFolder(folder)) continue;
        queue.push(folder);
      }
      for (const file of listing.files) {
        const relative = root ? file.slice(root.length + 1) : file;
        if (isRefused(relative)) continue;
        found.push(file);
      }
    }
    return found;
  }
  /** Obsidian's own state and trash are never the user's notes. */
  isSkippedFolder(folder) {
    const name = folder.split("/").pop() ?? "";
    return name === ".obsidian" || name === ".trash" || name === ".git";
  }
  /** Inverse of toVaultPath: vault path -> path inside the repo. */
  toRepoPath(vaultPath) {
    const target = this.opts.targetFolder.replace(/\/+$/, "");
    const relative = target && vaultPath.startsWith(`${target}/`) ? vaultPath.slice(target.length + 1) : vaultPath;
    const remote = this.opts.remoteFolder.replace(/\/+$/, "");
    return remote ? `${remote}/${relative}` : relative;
  }
  /**
   * Copy the on-disk version aside before a remote version overwrites it.
   *
   * Naming mirrors what Obsidian Sync does: the user ends up with two files
   * side by side in the same folder and merges them by hand. Returns the new
   * path, or null if the copy itself failed — in which case the caller must
   * not overwrite the original.
   */
  async makeConflictCopy(path) {
    try {
      const content = await this.adapter.readBinary(path);
      const dot = path.lastIndexOf(".");
      const slash = path.lastIndexOf("/");
      const hasExt = dot > slash;
      const stem = hasExt ? path.slice(0, dot) : path;
      const ext = hasExt ? path.slice(dot) : "";
      const target = `${stem} (conflict ${conflictStamp()} ${this.opts.deviceLabel})${ext}`;
      await this.adapter.writeBinary(target, content);
      return target;
    } catch (err) {
      console.warn("[github-sync] could not write conflict copy for", path, err);
      return null;
    }
  }
  /**
   * Write through the adapter rather than `Vault.createBinary`.
   *
   * The Vault API is index-first: it decides a path is free by consulting its
   * in-memory file list, which lags behind the disk right after a sync writes a
   * batch of files, and on mobile can lag by a lot. `createBinary` on a path the
   * index hasn't caught up to throws "File already exists" — the incremental
   * update is then lost even though the file is plainly there. The adapter talks
   * to the filesystem, so create and overwrite are the same call and no
   * existence check can go stale between the check and the write.
   */
  async writeFile(path, content) {
    await this.adapter.writeBinary(path, content);
  }
  /** Git blob SHA of what's on disk, or null if the path isn't there. */
  async hashOnDisk(path) {
    if (!await this.adapter.exists(path)) return null;
    return gitBlobSha(await this.adapter.readBinary(path));
  }
  /** Returns true if a file was actually removed. */
  async removeFile(path) {
    if (!await this.adapter.exists(path)) return false;
    await this.adapter.trashLocal(path);
    return true;
  }
  /** A binary write fails if the parent folder doesn't exist yet. */
  async ensureParentFolder(path) {
    const slash = path.lastIndexOf("/");
    if (slash <= 0) return;
    const parts = path.slice(0, slash).split("/");
    let folder = "";
    for (const part of parts) {
      folder = folder ? `${folder}/${part}` : part;
      if (await this.adapter.exists(folder)) continue;
      try {
        await this.adapter.mkdir(folder);
      } catch {
      }
    }
  }
};

// src/auth.ts
function hostFromWebBase(webBase) {
  const base = webBase.replace(/\/+$/, "");
  const isDotCom = /^https:\/\/(www\.)?github\.com$/i.test(base);
  return {
    webBase: base,
    apiBase: isDotCom ? "https://api.github.com" : `${base}/api/v3`
  };
}
async function refreshAccessToken(host, clientId, refreshToken) {
  const res = await requestUrl({
    url: `${host.webBase}/login/oauth/access_token`,
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: clientId,
      refresh_token: refreshToken,
      grant_type: "refresh_token"
    }),
    throw: false
  });
  const json = res.json ?? {};
  if (!json.access_token) {
    throw new Error(
      json.error_description ?? json.error ?? `Token refresh failed (HTTP ${res.status})`
    );
  }
  return json;
}
async function requestDeviceCode(host, clientId, scope) {
  const res = await requestUrl({
    url: `${host.webBase}/login/device/code`,
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: clientId, scope }),
    throw: false
  });
  const json = res.json ?? {};
  if (res.status >= 400 || json.error) {
    throw new Error(
      json.error_description ?? json.error ?? `Device code request failed (HTTP ${res.status})`
    );
  }
  return json;
}
async function pollOnce(host, clientId, deviceCode) {
  const res = await requestUrl({
    url: `${host.webBase}/login/oauth/access_token`,
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: clientId,
      device_code: deviceCode,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code"
    }),
    throw: false
  });
  const json = res.json ?? {};
  if (json.access_token) return { token: json };
  switch (json.error) {
    case "authorization_pending":
      return {};
    case "slow_down":
      return { slowDown: true };
    case "expired_token":
      throw new Error("The device code expired. Start sign-in again.");
    case "access_denied":
      throw new Error("Authorization was denied in the browser.");
    default:
      throw new Error(
        json.error_description ?? json.error ?? `Token request failed (HTTP ${res.status})`
      );
  }
}
async function pollForToken(host, clientId, device, signal) {
  let intervalMs = Math.max(device.interval, 5) * 1e3;
  const deadline = Date.now() + device.expires_in * 1e3;
  while (Date.now() < deadline) {
    await sleep(intervalMs, signal);
    if (signal.aborted) throw new Error("Sign-in cancelled.");
    const { token, slowDown } = await pollOnce(host, clientId, device.device_code);
    if (token) return token;
    if (slowDown) intervalMs += 5e3;
  }
  throw new Error("The device code expired. Start sign-in again.");
}
function sleep(ms, signal) {
  return new Promise((resolve) => {
    const timer = window.setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      window.clearTimeout(timer);
      resolve();
    });
  });
}
export {
  GitHubClient,
  SyncEngine,
  base64ToBytes,
  bytesToBase64,
  errorStatus,
  gitBlobSha,
  gitBlobShaOfText,
  hostFromWebBase,
  pollForToken,
  refreshAccessToken,
  requestDeviceCode
};
