# Permission policy

The default policy allows `read` tools and asks for every other risk class. When it asks, `run()` emits and persists `permission.requested`, then remains suspended until the host calls `resolvePermission()`, the signal is aborted, or the timeout expires. A decision is emitted once as `permission.resolved`.

`allow-once` only permits the pending call. `allow-with-rule` is written through the optional `PermissionStore`; hosts must validate that rules are narrowly scoped by workspace, path prefix, or parsed argv prefix before accepting them. Never persist authorization for shell strings, unlimited wildcards, credential access, destructive deletes, deployments, `git push`, or external data exfiltration.

The Node `bash` reference tool accepts `{ executable, args, cwd }`, calls `spawn` with `shell: false`, constrains cwd to the workspace, uses an explicit environment, and has a capped output buffer. It is an execution adapter, not a sandbox.
