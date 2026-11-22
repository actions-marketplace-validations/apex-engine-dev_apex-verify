# Running tests and generated checks in a sandbox

`apex verify` runs two kinds of code from outside your control: **your project's tests** (as any CI does) and **checks written by a model from the task**. A model-written check is untrusted code. Apex verify isolates both where it can, and the verdict says which sandbox ran (`sandbox: ...`).

| Platform | Isolation | Tested |
|---|---|---|
| macOS | Seatbelt: writes only inside the scratch copy, temp folders and package caches; no network except this machine; credential folders (`~/.ssh`, cloud logins, keychains) unreadable | CI (macOS job) |
| Linux | bubblewrap (`bwrap`): read-only filesystem, writable only in the copy, temp folders and caches; no network except localhost (own network namespace); `~/.ssh`, `~/.aws` and similar hidden; own process tree, killed with the parent | CI (`linux-sandbox` job: write outside the copy denied, external network denied, localhost allowed) |
| Container (any host with Docker) | the recipe below | CI (`container` job) |
| Windows | **runs, with no sandbox**: the test suite and a verify run pass on Windows in CI, but checks run as you. For code you do not trust use WSL2 (the Linux sandbox) or the container | - |

**Linux setup.** Install bubblewrap (`apt install bubblewrap`, `dnf install bubblewrap`). Unprivileged user namespaces must be allowed; on Ubuntu 24.04 they are restricted by default (`sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0`, or an AppArmor profile for `bwrap`). If bubblewrap is not usable, Apex verify says `sandbox: none` and still runs; `APEX_TEST_SANDBOX=0` turns the sandbox off.

**This is a safety net, not a security boundary.** Reads are open (interpreters and `node_modules` live all over a machine) and a determined program may find a way out. For code you do not trust, run Apex verify in CI or in a container.

## Container recipe

```sh
docker build -f docker/Dockerfile -t apex-verify .

# the project is mounted read-only; the code under test has no network
docker run --rm --network none -v "$PWD":/work:ro apex-verify "what the change should do" --no-model
```

With a model, the container needs the network for the model call only: run `--no-model` for the deterministic part inside the container, or give the container network access and keep your API key out of the project mount (`-e GEMINI_API_KEY`). Apex verify works on scratch copies and never writes to your project, so a read-only mount is safe.

## What is still not isolated

The model call sends your task and a budgeted excerpt of the relevant source files (about 24 KB) to the checker model you configure. Nothing else leaves the machine; there is no telemetry. If that excerpt must not leave your network, do not use a hosted checker model.
