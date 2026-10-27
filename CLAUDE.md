# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

`stellarium-cli` is a Node CLI (`stellarium`) for running RequestScript requests on a Stellarium node and discovering its resources. The node and operator live in `../stellarium-ts` (`packages/stellarium-ts/src/routes.ts`, `apps/operator/src/routes/oauth.ts`); keep the request and response shapes here in sync with them.

## Commands

```sh
pnpm install
pnpm build          # rm -rf dist && tsc -p tsconfig.build.json
pnpm test           # builds first: src/tests/cli.e2e.test.ts runs dist/index.js against a stub server
pnpm exec vitest run src/tests/client.test.ts -t "401"
pnpm lint           # biome lint src (formatter disabled)
pnpm check-types
```

## Architecture

- `src/index.ts`: commander program, global flags, and the `runner` that wraps every action: it builds the `Context` and `Output`, starts the update check, prints the `CommandResult` or the error, and sets the exit code. Commands never print or exit themselves.
- Commands (`src/commands/`) return `CommandResult { data, render(style, { agent, width }), raw? }`. `data` is the JSON payload; `render` produces pretty or agent text. Agent mode gets `plainStyle`.
- `src/errors.ts`: `CliError` with a stable `code`, optional `hint`, `status` and `details`. Each code maps to an exit code (documented in the README, so changing them is a breaking change). Anything else becomes `unexpected`.
- `src/config.ts`: profiles in `config.json` (0600). Flags > `STELLARIUM_*` env > profile. `resolveNodeUrl` for public routes, `resolveConfig` when credentials are needed.
- `src/auth.ts`: `TokenProvider` gets run tokens from `{operatorUrl}/oauth/token` (client_credentials) and caches them in `tokens.json`, keyed by operator and client id, until a minute before expiry.
- `src/client.ts`: `NodeClient`. `run` retries once with a fresh token after a 401 and maps 400/402/422 to script and payment errors. `listResources` follows `nextOffset`.
- `src/http.ts`: `send` wraps fetch with a timeout and `--verbose` logging, and throws only for transport failures.
- `src/update.ts`: npm update check, cached for 24h in `update-check.json`. The runner waits at most 300 ms for it after a command, then aborts it.
- Data goes to stdout and diagnostics to stderr. JSON mode writes one envelope `{ ok, data | error, update? }` and nothing to stderr.
