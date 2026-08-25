/**
 * Offline tests for plan(), driven by a stub client.
 *
 * Planning is pure decision-making over API responses, so it can be pinned
 * without touching the network — which lets these cover shapes the live e2e
 * repo can't produce on demand, like a compare entry with no blob SHA.
 */
import assert from "node:assert/strict";
import { loadEngine } from "../e2e/load-engine.mjs";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const HEAD = "c".repeat(40);

/** A vault adapter that does nothing; plan() never touches the disk. */
const vault = { adapter: {} };

const OPTS = {
	owner: "o",
	repo: "r",
	branch: "main",
	targetFolder: "",
	remoteFolder: "",
	deviceLabel: "test",
};

function stubClient(overrides) {
	return {
		branchHead: async () => HEAD,
		compare: async () => ({ status: "ahead", files: [], truncated: false, total_commits: 1 }),
		listTree: async () => [],
		...overrides,
	};
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test("a compare entry with a null sha forces a full sync", async (engine) => {
	let listedTree = false;
	const client = stubClient({
		compare: async () => ({
			status: "ahead",
			total_commits: 1,
			truncated: false,
			files: [
				{ filename: "notes/kept.md", status: "modified", sha: SHA_A },
				// GitHub omits the blob SHA for entries it won't attribute to a
				// blob. This used to be interpolated straight into the request URL,
				// producing GET /git/blobs/null and a 422.
				{ filename: "vendor/thing", status: "added", sha: null },
			],
		}),
		listTree: async () => {
			listedTree = true;
			return [{ path: "notes/kept.md", sha: SHA_A, size: 1 }];
		},
	});

	const plan = await new engine.SyncEngine(vault, client, OPTS).plan({
		commit: SHA_B,
		blobs: {},
	});

	assert.equal(plan.mode, "full", "should abandon the diff, not plan a null-sha write");
	assert.ok(listedTree, "the full plan should come from the tree listing");
	for (const write of plan.writes) {
		assert.match(write.blobSha, /^[0-9a-f]{40}$/, `bad sha planned for ${write.path}`);
	}
});

test("a missing sha field is treated the same as an explicit null", async (engine) => {
	const client = stubClient({
		compare: async () => ({
			status: "ahead",
			total_commits: 1,
			truncated: false,
			files: [{ filename: "notes/a.md", status: "modified" }],
		}),
	});

	const plan = await new engine.SyncEngine(vault, client, OPTS).plan({
		commit: SHA_B,
		blobs: {},
	});
	assert.equal(plan.mode, "full");
});

test("a normal diff still plans incrementally", async (engine) => {
	const client = stubClient({
		compare: async () => ({
			status: "ahead",
			total_commits: 1,
			truncated: false,
			files: [
				{ filename: "notes/a.md", status: "modified", sha: SHA_A },
				{ filename: "notes/gone.md", status: "removed", sha: SHA_B },
			],
		}),
		listTree: async () => {
			throw new Error("should not fall back to a full sync");
		},
	});

	const plan = await new engine.SyncEngine(vault, client, OPTS).plan({
		commit: SHA_B,
		blobs: {},
	});

	assert.equal(plan.mode, "incremental");
	assert.deepEqual(plan.writes, [{ path: "notes/a.md", blobSha: SHA_A }]);
	assert.deepEqual(plan.deletes, ["notes/gone.md"]);
});

test("readBlob rejects a malformed sha before issuing a request", async (engine) => {
	const client = new engine.GitHubClient({ api: "https://api.github.com" }, "token");
	await assert.rejects(
		() => client.readBlob("o", "r", null),
		/malformed SHA/,
		"should fail locally rather than 422 at the API",
	);
});

const engine = await loadEngine();
let failed = 0;

for (const { name, fn } of tests) {
	try {
		await fn(engine);
		console.log(`  ok   ${name}`);
	} catch (err) {
		failed++;
		console.error(`  FAIL ${name}\n       ${err.message}`);
	}
}

console.log(`\n${tests.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
