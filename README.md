# stellarium-cli

A command-line tool for interacting with the Stellarium network. Run [RequestScript](https://github.com/qualletio/requestscript-js) queries on a [Stellarium node](https://github.com/qualletio/stellarium-ts) and discover the resources it can call.

The CLI gets and refreshes run tokens for you, turns HTTP failures into clear errors with hints, and prints results for people (tables and colors) or for agents (JSON or compact text).

## Install

Requires Node.js 20+.

```sh
npm install -g stellarium-cli
stellarium --help
```

## Set up

The CLI authenticates with an **API client** from the [Stellarium Platform](https://platform.stellarium.sh). A client is issued for one node, and the CLI exchanges its id and secret for 15-minute run tokens at the operator.

```sh
stellarium config init
# Node URL (without /v1): https://node.example.com
# Operator URL (with /v1): https://operator.example.com/v1
# API client id: cli_...
# API client secret: (hidden)
# ✓ Saved profile default to ~/.config/stellarium/config.json
# ✓ Reached node example and got a run token
```

Without a terminal, pass everything as flags: `stellarium config init --no-input --node-url ... --operator-url ... --client-id ... --client-secret ...`.

### Profiles

Each profile holds `nodeUrl`, `operatorUrl`, `clientId` and `clientSecret`. Profiles live in `~/.config/stellarium/config.json` (or `$XDG_CONFIG_HOME/stellarium`), readable only by you.

```sh
stellarium --profile staging config init   # create another profile
stellarium config use staging              # make it the default
stellarium config list                     # secrets masked
stellarium config set nodeUrl https://other-node.example.com
stellarium config get clientId
stellarium config test                     # check the node and credentials
stellarium config remove staging
```

Values are resolved in this order: flags (`--profile`, `--node`), then environment variables, then the profile.

| Variable                   | Purpose                                       |
| -------------------------- | --------------------------------------------- |
| `STELLARIUM_PROFILE`       | Profile to use                                |
| `STELLARIUM_NODE_URL`      | Node origin, without `/v1`                    |
| `STELLARIUM_OPERATOR_URL`  | Operator base URL, including `/v1`            |
| `STELLARIUM_CLIENT_ID`     | API client id                                 |
| `STELLARIUM_CLIENT_SECRET` | API client secret                             |
| `STELLARIUM_NO_UPDATE_CHECK` | Set to skip checking npm for a newer version |
| `STELLARIUM_CONFIG_DIR`, `STELLARIUM_CACHE_DIR` | Override where config and cached tokens live |

With all four connection variables set, no config file is needed, which suits CI and agents.

## Run scripts

```sh
stellarium run weather.txt
stellarium run -e 'request Temperature {
    const weather: com.example.Weather
    return weather.temperature(city: "Oslo")
}'
cat script.txt | stellarium run
stellarium run --raw script.txt     # only the return value, as JSON
```

The result is printed with the script tokens used. Each resource call in a script evaluates to `{ value, error }`, and calls that failed are listed below the result.

## Discover resources

```sh
stellarium resources list                     # every resource the node knows
stellarium resources list --path com.example --paid
stellarium resources search weather
stellarium resources show com.example.Weather # functions, prices, and an example script
```

`resources show` ends with a request you can fill in and run:

```
request Example {
    const weather: com.example.Weather

    return weather.temperature(city: "...")
}
```

Discovery uses the node's public routes and needs only a node URL.

## Output

| Mode     | When                                   | What                                                                 |
| -------- | -------------------------------------- | -------------------------------------------------------------------- |
| `pretty` | Default on a terminal                  | Tables and colors                                                    |
| `json`   | Default when piped, or `--json`        | `{ "ok": true, "data": ... }` or `{ "ok": false, "error": { "code", "message", "hint", "status", "details" } }` |
| `agent`  | `--output agent`                       | Compact plain text: resource signatures inline, `error[code]:` and `hint:` lines |

Data goes to stdout. Errors and notices go to stderr, except in JSON mode, where they are in the envelope.

### Exit codes

| Code | Meaning                                                     |
| ---- | ----------------------------------------------------------- |
| 0    | Success                                                     |
| 1    | Unexpected error                                            |
| 2    | Usage or configuration error, or resource not found         |
| 3    | Authentication failed                                       |
| 4    | The script is invalid (400) or failed while running (422)   |
| 5    | Network error, timeout, rate limit or server error          |
| 6    | Payment required: the operator refused to pay for the run   |

## Updates

Once a day the CLI checks npm for a newer version in the background, without slowing commands down. When one is available it prints a notice on stderr, or adds `"update": { "current", "latest" }` to the JSON envelope. `stellarium version` checks right away. Disable with `--no-update-check`, `STELLARIUM_NO_UPDATE_CHECK=1`, or in CI (`CI` set).

## Development

```sh
pnpm install
pnpm build        # tsc -> dist/
pnpm test         # builds, then vitest (the e2e test runs dist/index.js)
pnpm lint
pnpm check-types
pnpm dev -- resources list   # run from source (Node 23+)
```
