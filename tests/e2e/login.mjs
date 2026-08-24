/**
 * One-time interactive sign-in for the e2e tests.
 *
 * Split out from run.mjs because the device flow needs a human at a browser:
 * run this once in a terminal you control, and every later `npm run test:e2e`
 * uses the cached token non-interactively.
 */
import { getAccessToken, loadConfig } from "./config.mjs";
import { loadEngine } from "./load-engine.mjs";

const config = await loadConfig();
const engine = await loadEngine();
const token = await getAccessToken(config, engine);

const client = new engine.GitHubClient(engine.hostFromWebBase(config.webBase), token);
const user = await client.currentUser();
const branch = config.branch || (await client.defaultBranch(config.owner, config.repo));

console.log(`\nSigned in as ${user.login}.`);
console.log(`${config.owner}/${config.repo} is reachable; default branch is ${branch}.`);
console.log(`Run: npm run test:e2e`);
