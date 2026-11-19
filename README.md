# rubywatch

Live tracker at [rubywatch.speedshop.co](https://rubywatch.speedshop.co). It shows how fast each Ruby patch release reaches installers, container images, CI and hosting platforms.

Based on [How fast can you actually patch Ruby?](https://paagman.dev/how-fast-can-you-patch-ruby/) by Dennis Paagman.

## How it works

A Cloudflare Worker runs every minute. It finds the newest patch release of each tracked Ruby series on cache.ruby-lang.org, then checks every target in `src/targets.js` that has not shipped it yet. Results go in a D1 database. The Worker serves the page in `src/page.html` with the current results already in it, and the page refreshes them from `/api/status` every minute.

Each source is checked at most once a minute. The Worker creates its own tables.

## Add a release channel

Pull requests that add a channel are welcome. Add an entry to its group in `src/targets.js`. An entry needs an `id`, a `name`, a `url` to link, and a `probe` that returns `found(date)` when the release is there and `null` when it is not. Use `found()` with no date when the source has no timestamp. Each probe may use only a few requests, because one round has a budget of 44.

## Run it locally

```bash
mise install
aube install
mise run serve
```

Cron does not fire locally. Run one round of checks with:

```bash
curl http://localhost:8787/cdn-cgi/local/scheduled
```

## Test

```bash
mise run test
mise run lint
```

The tests in `test/` run the Worker in Miniflare, Cloudflare's local runtime, with a local D1 database. Every outbound request goes to a stub, so the tests need no network.

## Deploy

`terraform/` is a Terraform module that uploads the Worker and its cron trigger. [speedshop/infra](https://github.com/speedshop/infra) calls it, pinned to a commit of this repo, and owns the database, DNS record and route. To deploy a change, merge it here, then bump the pinned commit in infra.
