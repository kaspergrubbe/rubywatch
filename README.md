# rubywatch

Live tracker at [rubywatch.speedshop.co](https://rubywatch.speedshop.co). It shows how fast each Ruby patch release reaches installers, container images, CI and hosting platforms.

Based on [How fast can you actually patch Ruby?](https://paagman.dev/how-fast-can-you-patch-ruby/) by Dennis Paagman.

## How it works

A Cloudflare Worker runs every minute. It finds the newest patch release of each tracked Ruby series on cache.ruby-lang.org, then checks every target in `src/targets.js` that has not shipped it yet. Results go in a D1 database. The page in `public/` reads them from `/api/status`.

Each source is checked at most once a minute. The Worker creates its own tables.

## Run it locally

```bash
npm install
npm run dev
```

Cron does not fire locally. The page triggers a check when it loads.

## Deploy

`terraform/` is a Terraform module that uploads the Worker, its assets and its cron trigger. [speedshop/infra](https://github.com/speedshop/infra) calls it, pinned to a commit of this repo, and owns the database, DNS record and route. To deploy a change, merge it here, then bump the pinned commit in infra.
