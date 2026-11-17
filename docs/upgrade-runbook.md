# lansync upgrade runbook

`scripts/upgrade.js` is the supported upgrade path. Humans run one command;
the script owns the ordering, the safety gates, and the rollback.

## Model

| Channel | Role | Config | Default port |
| --- | --- | --- | --- |
| `lansync` | target / production | `~/.lansync` | 8001 |
| `lansyncopt` | control / last known good | `~/.lansyncopt` | 8002 |

Rules the script enforces:

- The control channel must be reachable before anything destructive happens.
- Never stop the channel that is serving the current command.
- Production is not touched until the canary smoke test passes.
- `server.json` is preserved across the switch: the token, root, and port stay
  the same, so clients do not need to reconfigure.
- The repo version must be newer than the running `lansync` on both ends.

## One command

```bash
node scripts/upgrade.js                 # prompts once on a TTY
node scripts/upgrade.js --yes           # unattended
node scripts/upgrade.js --bump=patch --yes
node scripts/upgrade.js --stop-control  # stop lansyncopt after the upgrade
node scripts/upgrade.js stop-control    # explicit stop, config preserved
```

Internal steps (not meant to be driven by hand):

1. `preflight` — discover both channels, upload the remote helper, assert
   versions, assert the control server root is this checkout.
2. `push` — `lansync push --no-delete` through the control channel, then
   verify the remote repo version.
3. `remote-tests` — `node --check` and `npm test` on the remote.
4. `canary` — install the new code into a staging app, start it on a spare
   port, and run the smoke matrix:
   push/pull/diff, deletions, unicode and percent paths, anchored ignore
   (`/rss/*` must not hide nested `rss/`), and `exec`.
5. `switch` — back up, stop, install, restart, and health-check `lansync` on
   the remote, then locally. Any failure restores `app.bak-*`.
6. `finish` — update both `lansyncopt` installs to the new version and leave
   the remote control daemon running. It is the control/fallback channel for
   the next upgrade; stop it explicitly with `--stop-control` or
   `node scripts/upgrade.js stop-control` (this preserves `server.json`).

## Exit codes

| Code | Meaning | Production state |
| --- | --- | --- |
| 0 | success | new version running |
| 2 | preflight failed | unchanged |
| 3 | control channel / remote helper failed | unchanged |
| 4 | push or remote repo verification failed | unchanged |
| 5 | remote tests failed | unchanged |
| 6 | publish/switch or end-to-end health failed | rolled back when possible |
| 7 | canary failed | unchanged |
| 8 | rollback failed | needs attention |

## Artifacts

```text
~/.lansync-upgrade/state.json    # resumable state
~/.lansync-upgrade/report.json   # machine-readable; hand this to an agent
~/.lansync-upgrade/report.md     # human summary
~/.lansync-upgrade/upgrade.log   # append-only log
```

Tokens are never written to these files.

## Failure handling

- Preflight, push, remote tests, or canary failure: production was never
  touched. Fix the reported cause and re-run.
- Switch or health failure: `app.bak-<old version>` is restored and the old
  service is restarted automatically.
- Interrupted run: the state file records the phase. `rollback` restores the
  newest backup on both ends.
- Rollback failure (exit 8): send `report.json` to an agent; do not start a
  second upgrade.

## Agent handoff

If the one-click run exits non-zero:

```text
1. Read ~/.lansync-upgrade/report.json.
2. Check status, phase, error, remoteTests, remoteSwitch, and health.
3. Run `node scripts/upgrade.js rollback` if the report says production is
   not healthy.
4. Fix the cause, then re-run `node scripts/upgrade.js --yes`.
```

## Versioning

- `lansync` gets the plain repo version (for example `1.6.1`).
- `lansyncopt` gets the same version with `-opt` (for example `1.6.1-opt`).
- The script refuses to deploy a version that is not newer than the running
  `lansync` unless `--allow-same-version` is passed.