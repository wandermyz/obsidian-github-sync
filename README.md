# obsidian-github-sync

An Obsidian plugin that syncs notes with GitHub — including GitHub Enterprise
Server — over the **GitHub REST API**. No Git implementation in JavaScript, so
it works on mobile, including Obsidian on iOS.

Current status: **OAuth device flow + repo read verification.** Sync itself is
not implemented yet.

## Why the device flow

Obsidian on iOS has no usable redirect target for a normal OAuth authorization
code flow, and embedding a web view to collect enterprise SSO credentials is
both fragile and a bad idea. The [device
flow](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#device-flow)
avoids both: the plugin shows a short code, `window.open` hands the URL to the
**device's own browser** (Safari on iOS), and the plugin polls GitHub until the
user finishes. Any existing enterprise SSO session in that browser is reused.

There is no embedded web view anywhere in this codebase.

## Setup

Your GitHub OAuth app must have **"Enable Device Flow"** checked
(Settings → Developer settings → OAuth Apps → your app). No callback URL is
needed for this flow.

Then in Obsidian: **Settings → GitHub Sync**

| Setting | Value |
| --- | --- |
| GitHub host | `https://github.com`, or `https://github.mycorp.com` for Enterprise Server |
| OAuth app Client ID | from your OAuth app |
| Scopes | `repo read:org` (default) |
| Test repository | `owner/repo` for the verify command |

Press **Sign in**, copy the code, tap **Open browser**, authorize. The plugin
then automatically runs verification.

For enterprise repos behind SAML SSO on github.com, you may additionally need to
authorize the OAuth app for your org from the org's settings page.

## Commands

- **Sign in to GitHub (device flow)**
- **Verify GitHub access** — calls `/user`, lists the test repo's root, and
  reads the first file it finds. Notices report the result; full output goes to
  the developer console.
- **Sign out of GitHub**

## Verifying without Obsidian

```bash
node scripts/device-flow-test.mjs <client_id> owner/repo [https://github.mycorp.com]
```

Runs the identical request sequence from a terminal — useful to confirm the
OAuth app is configured correctly before installing the plugin.

## Build and install

```bash
npm install
npm run build     # produces main.js
npm run dev       # watch mode
```

Copy `main.js` and `manifest.json` into
`<vault>/.obsidian/plugins/obsidian-github-sync/` and enable the plugin.

To test on iOS, sync that folder to the mobile vault (iCloud/Obsidian Sync) and
enable the plugin there.

## Security note

The access token is stored in the plugin's `data.json` inside the vault, in
plaintext — the same place every Obsidian plugin keeps its credentials. If the
vault itself syncs somewhere, the token goes with it. `data.json` is gitignored
in this repo.

## Layout

```
src/
  auth.ts             device flow: request code, poll for token, host resolution
  deviceFlowModal.ts  sign-in UI; opens the system browser only
  github.ts           REST client: /user, list directory, read file
  main.ts             plugin entry, commands, settings tab
scripts/
  device-flow-test.mjs  standalone CLI check
```
