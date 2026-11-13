# Release notes

Release notes live here as `vX.Y.Z.md`, one file per release. Releases are published
on this repository's
[GitHub Releases](https://github.com/sai-manoj-kumar/beadscope/releases) page.

## Versions

Beadscope's version numbers continue from the release this fork was started from
(**v0.4.0**) instead of restarting at 0.1.0.

`package.json` is at **0.5.0**, the version of the first Beadscope release. It is a
breaking release (new command name, new environment variable names, new config
directory), so it takes a minor-version bump while the project is pre-1.0.

## Releasing

Pushing a `vX.Y.Z` tag runs [`release.yml`](../../.github/workflows/release.yml), which
runs the CI checks, publishes the package to npm, creates the GitHub release from
`docs/releases/vX.Y.Z.md`, and bumps the Homebrew tap formula. To cut a release:

1. Bump `version` in `package.json` and add `docs/releases/vX.Y.Z.md`, in a pull request.
2. After it merges, tag the merge commit and push the tag:
   `git tag vX.Y.Z && git push origin vX.Y.Z`.

The workflow refuses a tag that does not match `package.json` or is not on `main`. Each
step skips itself if its work is already done, so a failed run can simply be re-run.

The workflow publishes with npm trusted publishing (no stored npm token) and updates the
tap with a write-enabled deploy key stored as the `TAP_DEPLOY_KEY` secret.
