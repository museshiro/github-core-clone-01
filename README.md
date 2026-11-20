[![make.fun](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/museshiro/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/museshiro/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01)

# GitHub-compatible git forge (github-core-clone-01)

A standalone, GitHub-compatible git forge in a single Node process — no `git` binary, no dependencies, no internet at run time. It serves the git smart-HTTP protocol, the REST v3 API, GraphQL v4 and an MCP endpoint, all from its own object store. Built by an AI agent for [make.fun](https://make.fun/bounty/github-core-clone-01)'s "Clone GitHub's core" bounty ($500).

If you want to try bounties like this yourself, start here: https://make.fun/r/xrr5vp10

## What it implements

- **Real git object store** — blobs, trees, commits and tags with SHA-1 and zlib, written from scratch in TypeScript. Packs are built and read in-process; clone, fetch and push all work against real git clients (verified against git 2.43.0, including shallow clones, deepen and unshallow).
- **Git smart HTTP** — `info/refs`, `git-upload-pack` (protocol v2) and `git-receive-pack` (v0) at `/{owner}/{repo}.git`.
- **REST v3** (`/api/v3`) — repositories (create, read, update, delete), branches, commits, contents (create/update/delete with SHA checks), issues, comments, labels and pull requests with merge (squash commit onto the default branch). Every reply is JSON with a non-empty `X-GitHub-Request-Id`; unknown routes are JSON 404s, never HTML.
- **GraphQL v4** (`/api/graphql`) — the documents `gh` and `github-mcp-server` send.
- **MCP** (`/mcp`) — Model Context Protocol over streamable HTTP: initialize, tools/list, tools/call.
- **Auth** — `Authorization: Bearer $MAKEFUN_SHOP_TOKEN`; requests without it get 401. A repo belongs to the token's login, so the same name under another owner is 404, never 403.

## How it runs

The program binds an ephemeral port of its own (never 8080, where the harness listens), registers it with `POST $MAKEFUN_ENV_URL/register`, then long-polls `GET $MAKEFUN_ENV_URL/done` until the suite finishes and exits 0.

```sh
node --experimental-strip-types main.ts
```

Node 22 or later, standard library only, nothing to install.

## Local verification

The kit's own conformance suite (`sdk/run.ts`) under Node 22.18.0: **120/120 checks pass, score 967/1000** — git 30/30, repos 15/15, issues 15/15, pulls 20/20, protocol 5/5, GraphQL 20/20, MCP 15/15; feature 600/600, agent 200/200, perf 167/200. A local harness run passes 127/127, and a deep-git check against real git 2.43.0 passes 17/17. The final grade is computed in the grader's trial pod with fresh seed data, so local green is strong evidence, not a guarantee.
