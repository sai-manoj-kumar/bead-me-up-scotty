# Release notes

## Original project (v0.2.0 – v0.4.0)

The notes in this folder, `v0.2.0.md` through `v0.4.0.md`, are the release notes of
the original project, [Bead Me Up, Scotty](https://github.com/brendan-appstart/bead-me-up-scotty),
which Beadscope is forked from. They are kept unchanged as history. Their links
point at the original repository, and they predate the rename, so when following
their instructions use the new names:

| In the old notes | Now |
| --- | --- |
| `scotty`, `bead-me-up-scotty` (command) | `beadscope` |
| `SCOTTY_*` environment variables | `BEADSCOPE_*` |
| `~/.config/bead-me-up-scotty/` | `~/.config/beadscope/` (copied automatically on first start) |
| `brew install brendan-appstart/tap/bead-me-up-scotty` | not available; see [Quick install](../../README.md#quick-install) |

## Beadscope versions

Beadscope continues the original numbering instead of restarting it. The last
original release this fork is built on is **v0.4.0**.

`package.json` is now at **0.5.0**, the version of the first Beadscope release. It is
a breaking release (new command name, new environment variable names, and a new
config directory with a one-time copy of existing settings), so it gets a
minor-version bump while the project is pre-1.0. Beadscope releases are published on
this repository's [GitHub Releases](https://github.com/sai-manoj-kumar/beadscope/releases)
page, with notes added here as `vX.Y.Z.md`. No Beadscope release has been published
yet: v0.5.0 is not tagged, and its notes are not written.
