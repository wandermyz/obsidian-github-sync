# obsidian-github-sync

An Obsidian plugin that pulls notes from a GitHub repository — including GitHub
Enterprise Server — over the **GitHub REST API**. There is no Git
implementation in JavaScript and no native code, so it works on mobile,
including Obsidian on iOS.

Status: **early**. One-way sync (GitHub → vault) works, with incremental
updates, integrity verification, and automatic syncing. Pushing local changes
back to GitHub is not implemented yet.

## Why this exists

Obsidian's own sync isn't always an option — some notes live in repositories
that can't leave a particular GitHub instance. The existing Git plugins shell
out to a real Git binary or bundle `isomorphic-git`, neither of which is a good
fit on iOS. This plugin talks to the REST API instead, so the only thing it
needs is HTTPS.

## How it works

### Authentication: OAuth device flow

Obsidian on iOS has no usable redirect target for a normal authorization-code
flow, and embedding a web view to collect SSO credentials is both fragile and a
bad idea. The [device
flow](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#device-flow)
avoids both: the plugin shows a short code, `window.open` hands the URL to the
**device's own browser** (Safari on iOS), and the plugin polls GitHub until you
finish. Any SSO session already present in that browser is reused.

There is no embedded web view anywhere in this codebase.

If the OAuth app has expiring user tokens enabled, the device flow returns an
access token valid ~8 hours plus a refresh token valid ~6 months. Every API
call goes through `validAccessToken()`, which exchanges the refresh token when
the access token is within five minutes of expiry. GitHub **rotates the refresh
token on each use**, so both halves of the response are persisted together —
dropping the new refresh token would strand the plugin at the next renewal.
Once the refresh token itself lapses, you sign in again. With non-expiring
tokens, `expires_in` is absent and the refresh path is simply never taken.

### Incremental sync

The plugin records the commit SHA it last synced, plus the blob SHA of every
file it wrote. On the next run it asks GitHub to compare that commit against the
branch head and turns the resulting file list into writes and deletes, fetching
only the blobs that actually changed. Renames delete the old path; removals
delete the file.

It falls back to a full tree walk when the comparison can't be trusted:

- the stored base commit no longer exists (force-push, or garbage collected),
- the histories have diverged,
- more than 300 files changed — GitHub silently truncates the file list at that
  point, and a truncated diff would leave the vault quietly incomplete.

Blobs are fetched **by SHA rather than by path**, so a branch that moves
mid-sync can't hand back bytes belonging to a different commit than the one
being applied.

### Integrity verification

After each file is written, it is read back from the vault and hashed as a Git
blob — `SHA1("blob " + byteLength + "\0" + bytes)` — which is exactly the SHA
GitHub already publishes for that blob. Verification therefore costs one local
hash and no extra network request. A mismatch is reported and that file's SHA is
not recorded, so the next sync fetches it again.

The stored commit pointer only advances when every file verified and nothing was
skipped. Otherwise the next sync would compute its diff from a commit the vault
doesn't actually match, and the missing files would never be noticed again.

### What it won't touch

- Files you edited locally since the last sync are **skipped**, not overwritten,
  and reported. Since there's no push yet, the plugin never destroys work it
  can't restore.
- Anything under `.obsidian/` is refused outright, so a repository can't
  overwrite your plugin configuration — including the `data.json` holding your
  access token.

## Setup

Register a GitHub OAuth app with **"Enable Device Flow"** checked (Settings →
Developer settings → OAuth Apps). No callback URL is needed for this flow.

Then in Obsidian: **Settings → GitHub Sync**

| Setting | Value |
| --- | --- |
| GitHub host | `https://github.com`, or `https://github.example.com` for Enterprise Server |
| OAuth app Client ID | from your OAuth app |
| Scopes | `repo read:org` (default) |
| Repository | `owner/repo` to sync from |
| Branch | empty for the repository's default branch |
| Remote folder | sync only this subfolder of the repo; empty for the whole repo |
| Vault folder | where files land in the vault; empty for the vault root |

Press **Sign in**, copy the code, tap **Open browser**, authorize.

For repositories behind SAML SSO on github.com, you may additionally need to
authorize the OAuth app for the organization from its settings page.

### Automatic sync

- **Sync on startup** — runs shortly after Obsidian finishes loading (deferred
  so it doesn't compete with initial indexing).
- **Periodic sync** — runs on a timer while Obsidian is open, at a configurable
  interval.

Background runs stay quiet unless something changed. Failures, integrity
mismatches, and skipped local edits always raise a notice.

## Commands

- **Sync now**
- **Full resync (rebuild from scratch)** — ignores stored state and walks the
  whole tree
- **Sign in to GitHub (device flow)**
- **Verify GitHub access** — calls `/user`, lists a repo root, reads a file
- **Sign out of GitHub**

## Verifying without Obsidian

```bash
node scripts/device-flow-test.mjs <client_id> owner/repo [https://github.example.com]
```

Runs the identical request sequence from a terminal — useful to confirm the
OAuth app is configured correctly before installing the plugin.

## Build and install

```bash
npm install
npm run build     # produces main.js
npm run dev       # watch mode
npm run deploy    # build, then copy into plugins-dev-vault/
```

For a manual install, copy `main.js` and `manifest.json` into
`<vault>/.obsidian/plugins/obsidian-github-sync/` and enable the plugin under
Settings → Community plugins.

On mobile, [BRAT](https://github.com/TfTHacker/obsidian42-brat) is the easiest
route: install BRAT, then add this repository as a beta plugin.

### Local test vault

`plugins-dev-vault/` is a gitignored Obsidian vault for testing. Open it as a
vault ("Open folder as vault"), turn off Restricted Mode, and enable the plugin.
After a redeploy, toggle the plugin off and on to load the new build.

It is gitignored deliberately: once you sign in, the access token is written to
`.obsidian/plugins/obsidian-github-sync/data.json` inside that vault. To deploy
elsewhere:

```bash
node scripts/deploy-dev.mjs /path/to/other/vault
```

## Security note

The access token is stored in the plugin's `data.json` inside the vault, in
plaintext — the same place every Obsidian plugin keeps its credentials. If the
vault itself syncs somewhere, the token goes with it.

## Layout

```
src/
  auth.ts             device flow: request code, poll for token, refresh, host resolution
  deviceFlowModal.ts  sign-in UI; opens the system browser only
  github.ts           REST client: user, tree, compare, blobs
  gitHash.ts          git blob SHA-1, used for integrity checks
  sync.ts             sync engine: plan (incremental or full), apply, verify
  main.ts             plugin entry, commands, settings, auto-sync timers
scripts/
  device-flow-test.mjs  standalone CLI check
  deploy-dev.mjs        copy build into a vault
```

## License

[MIT](LICENSE)
