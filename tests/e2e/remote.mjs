/**
 * Test scaffolding that commits straight to the test branch.
 *
 * Several suites (and CI runs) share one branch, so between reading the head
 * and moving the ref another run can land a commit, and GitHub rejects the
 * update as not a fast-forward. Each run only touches its own folder, so the
 * fix is simply to rebuild the commit on the new head and try again.
 */
export async function commitEntries(client, ctx, entries, message, { attempts = 5 } = {}) {
	for (let attempt = 1; ; attempt++) {
		const head = await client.branchHead(ctx.owner, ctx.repo, ctx.branch);
		const tree = await client.createTree(ctx.owner, ctx.repo, head, entries);
		const commit = await client.createCommit(ctx.owner, ctx.repo, message, tree, [head]);
		try {
			await client.updateRef(ctx.owner, ctx.repo, ctx.branch, commit);
			return commit;
		} catch (err) {
			if (err.status !== 422 || attempt >= attempts) throw err;
			await new Promise((r) => setTimeout(r, 500 * attempt));
		}
	}
}
