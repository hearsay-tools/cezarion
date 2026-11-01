# Recovery checkpoint

Use this procedure when teardown requires preservation. The retained Cezar
result and bounded `diffSnapshot` are evidence, not a complete recovery copy.
Run each command block in Bash with `set -euo pipefail`; a failure stops the
procedure.

1. Confirm the worker is settled and no process is writing its worktree.
   Collect again if its revision or head changed. Set `worker` to the verified
   worktree path, `coordinator` to this worktree, and `sha` to the available
   collected `head.sha`. Require `git -C "$worker" rev-parse HEAD` to equal
   `sha`. Stop for an unavailable head or an unverified writer.
2. Create a new directory outside the worker worktree, under the coordinator's
   `.ai/qa/campaign/checkpoints/<worker-id>/<revision>/`. Set `checkpoint` to
   its absolute path and `ref` to a unique
   `refs/campaign-checkpoints/<campaign-id>/<worker-id>/<revision>`.
   Require both to be new. Submodules or nested repositories with local work
   need separate checkpoints using this procedure before teardown can proceed.
3. Inventory required reports, proof and artifacts from the collected result
   and campaign state. Write their worktree-relative paths, including required
   ignored files, as NUL-separated entries in `$checkpoint/required.paths`;
   use an empty file when there are none. Expand directories to their files.
   Include symlinks themselves and any target bytes a required artifact needs.
   Review the list before copying; credentials
   stay in the environment. For required artifacts outside the worktree, make
   a separate archive from their source directory and apply the same inventory,
   copy and comparison checks below. A missing required artifact blocks teardown.

   ```bash
   git -C "$worker" ls-files --others --exclude-standard -z > "$checkpoint/untracked.paths"
   cat "$checkpoint/untracked.paths" "$checkpoint/required.paths" > "$checkpoint/files.paths"
   ```

   Review the untracked inventory too. Expand directory entries to checked
   files before continuing; checkpoint nested repositories separately.
4. Save the exact commit, index changes, worktree changes and file copies.
   Run these commands with failure stopping the procedure:

   ```bash
   git -C "$coordinator" update-ref "$ref" "$sha" ""
   git -C "$coordinator" bundle create "$checkpoint/head.bundle" "$ref"
   git -C "$worker" diff --binary --full-index --cached "$sha" -- > "$checkpoint/index.patch"
   git -C "$worker" diff --binary --full-index -- > "$checkpoint/worktree.patch"
   tar -C "$worker" --no-recursion --null --verbatim-files-from -T "$checkpoint/files.paths" -cf "$checkpoint/files.tar"
   ```

   Keep the inventory files with the snapshot.
5. Verify recovery before recording success:

   ```bash
   test "$(git -C "$coordinator" rev-parse "$ref")" = "$sha"
   git -C "$coordinator" bundle verify "$checkpoint/head.bundle"
   tar -C "$worker" --compare -f "$checkpoint/files.tar"
   git init "$checkpoint/restore"
   git -C "$checkpoint/restore" fetch "$checkpoint/head.bundle" "$ref"
   git -C "$checkpoint/restore" checkout --detach "$sha"
   if test -s "$checkpoint/index.patch"; then
     git -C "$checkpoint/restore" apply --index "$checkpoint/index.patch"
   fi
   if test -s "$checkpoint/worktree.patch"; then
     git -C "$checkpoint/restore" apply "$checkpoint/worktree.patch"
   fi
   tar -C "$checkpoint/restore" -xf "$checkpoint/files.tar"
   tar -C "$checkpoint/restore" --compare -f "$checkpoint/files.tar"
   ```

   Re-read the worker's head, both binary diffs and untracked inventory; require
   exact equality with `sha` and the saved files. Compare both restored diffs
   with the saved patches too. Verify every required artifact against its
   inventory and archive. Any mismatch or failed command stops checkout and
   destruction; retain the worker and record the blocker.
6. Record the worker id and collected revision, `sha`, `ref`, absolute snapshot
   and inventory paths, verification results, and repair owner or explicit
   disposition in campaign state. Save and re-read that record before teardown.

Done when the saved record locates a verified recovery copy for every required
input. Retain the ref and snapshots until the repair owner accepts the work or
the owner approves their disposition.
