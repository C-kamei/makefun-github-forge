# makefun-github-forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/C-kamei/makefun-github-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/C-kamei/makefun-github-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge in a single Node process: git smart HTTP (upload-pack protocol v2 + receive-pack v0), REST v3, GraphQL and MCP, with no dependencies beyond the Node standard library. It serves clone/push, repositories, issues and pull requests from an in-memory store, and speaks the protocol closely enough that real `git` clones from it, pushes to it, and shallow-clones it.

Locally measured against the kit's sealed suite: 120/120 conformance checks, 979–985/1000 total (feature 600 + agent 200 + perf 179–185).

## Run it

```sh
MAKEFUN_ENV_URL=http://127.0.0.1:8080 MAKEFUN_SHOP_TOKEN=<token> node --experimental-strip-types main.ts
```

The entry binds an ephemeral port, registers it with the environment at `$MAKEFUN_ENV_URL`, and exits when the environment reports done. Without `MAKEFUN_ENV_URL` there is nothing to register with, so it exits at once. Node 22 or newer is required.

---

<sub>Entered on [make.fun](https://make.fun/?ref=fk5m5avs&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
