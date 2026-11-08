# stellarium-cli

A command-line tool for interacting with the Stellarium network. Run [RequestScript](https://github.com/qualletio/requestscript-js) queries on a [Stellarium node](https://github.com/qualletio/stellarium-ts), deploy contracts, events and structs from `.req` files, and discover the resources it can call.

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

## Deploy contracts, events and structs

`stellarium deploy` publishes `.req` files to the node. Give it files, directories to search for `.req` files, or both.

```sh
stellarium deploy stellarium/                 # every .req file under stellarium/
stellarium deploy structs/Address.req contracts/ShippingLabel.req
stellarium deploy --dry-run stellarium/       # report what would deploy, without deploying
```

```
STATUS     KIND      NAME                             FILE
deployed   struct    com.example.Address@1            stellarium/Address.req
deployed   event     com.example.OrderPlaced@1        stellarium/OrderPlaced.req
unchanged  contract  com.example.ShippingLabel@1      stellarium/ShippingLabel.req

2 deployed, 1 unchanged
```

- **Order.** Structs deploy first, with a struct before any struct that names it, then event types, then contracts.
- **Deploying again is safe.** Versions the node already has with the same content are left alone and cost nothing.
- **Versions are immutable.** If a file changed but its version didn't, nothing is deployed and the command exits with code 4. Give the declaration a new version, such as `@2`.
- **A failure stops the deploy.** Files before it stay deployed. Fix the file and run the command again.
- **Requests** found in a directory are skipped. Naming one directly is an error.
- **Who can deploy.** Any organization with an API client for the node can deploy contracts, and may pay the node's deploy fee. Event types and structs belong to the node's organization, so they need an API client of that organization.
- **`--dry-run`** reads each file's declaration and compares it with the node's public routes, so it needs only a node URL. The node checks the rest of the script when you deploy.

### Tutorial: deploy from GitHub Actions

This workflow checks every pull request and deploys when a change reaches `main`.

**1. Put your declarations in one directory**, such as `stellarium/`:

```kotlin
// stellarium/Address.req
struct com.example.Address@1(street: string, zip: int32)
```

```kotlin
// stellarium/OrderPlaced.req
event com.example.OrderPlaced@1(orderId: string, shipTo: com.example.Address@1)
```

```kotlin
// stellarium/ShippingLabel.req
contract com.example.ShippingLabel@1(to: com.example.Address@1): string {
    return "Ship to ${to.street}"
}
```

**2. Create an API client** for your node on the [Stellarium Platform](https://platform.stellarium.sh). To deploy event types or structs, create it in the organization the node is enrolled in.

**3. Add its details to your GitHub repository**, under **Settings → Secrets and variables → Actions**:

| Name                       | Kind     | Value                               |
| -------------------------- | -------- | ----------------------------------- |
| `STELLARIUM_NODE_URL`      | Variable | Node origin, without `/v1`          |
| `STELLARIUM_OPERATOR_URL`  | Variable | Operator base URL, including `/v1`  |
| `STELLARIUM_CLIENT_ID`     | Secret   | API client id                       |
| `STELLARIUM_CLIENT_SECRET` | Secret   | API client secret                   |

**4. Add the workflow** as `.github/workflows/stellarium.yml`:

```yaml
name: Stellarium

on:
  push:
    branches: [main]
    paths: ['stellarium/**', '.github/workflows/stellarium.yml']
  pull_request:
    paths: ['stellarium/**', '.github/workflows/stellarium.yml']

permissions:
  contents: read

env:
  STELLARIUM_NODE_URL: ${{ vars.STELLARIUM_NODE_URL }}

jobs:
  check:
    if: github.event_name == 'pull_request'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npm install -g stellarium-cli
      - run: stellarium --output agent deploy --dry-run stellarium/

  deploy:
    if: github.event_name == 'push'
    runs-on: ubuntu-latest
    concurrency:
      group: stellarium-deploy
      cancel-in-progress: false
    env:
      STELLARIUM_OPERATOR_URL: ${{ vars.STELLARIUM_OPERATOR_URL }}
      STELLARIUM_CLIENT_ID: ${{ secrets.STELLARIUM_CLIENT_ID }}
      STELLARIUM_CLIENT_SECRET: ${{ secrets.STELLARIUM_CLIENT_SECRET }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npm install -g stellarium-cli
      - run: stellarium --output agent deploy stellarium/
```

The `check` job needs no secrets, so it also works on pull requests from forks. It fails if a pull request changes a declaration without giving it a new version. `concurrency` runs one deploy at a time, and `--output agent` prints plain text to the job log instead of the JSON used when output is piped.

**5. Ship a change.** Edit a declaration, give it a new version such as `contract com.example.ShippingLabel@2(...)`, and merge. The job deploys the new version and reports the others as `unchanged`.

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
| 4    | The script is invalid (400), failed while running (422), or a deploy conflicts with a deployed version (409) |
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
