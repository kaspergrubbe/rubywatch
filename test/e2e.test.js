import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, test } from "node:test";
import { convertV4MiniflareOptions, Miniflare, Response } from "miniflare";

const root = new URL("..", import.meta.url).pathname;
const wrangler = JSON.parse(readFileSync(`${root}wrangler.json`, "utf8"));

const INDEX = [
  "ruby-4.0.9\thttps://cache.ruby-lang.org/pub/ruby/4.0/ruby-4.0.9.tar.gz\tsha",
  "ruby-4.0.10\thttps://cache.ruby-lang.org/pub/ruby/4.0/ruby-4.0.10.tar.gz\tsha",
  "ruby-4.0.11\thttps://cache.ruby-lang.org/pub/ruby/4.0/ruby-4.0.11.tar.xz\tsha",
  "ruby-3.4.13\thttps://cache.ruby-lang.org/pub/ruby/3.4/ruby-3.4.13.tar.gz\tsha",
  "ruby-3.3.14\thttps://cache.ruby-lang.org/pub/ruby/3.3/ruby-3.3.14.tar.gz\tsha",
  "",
].join("\n");
const TARBALL = "Wed, 18 Nov 2026 23:34:42 GMT";
const BUILDER = "Wed, 18 Nov 2026 23:45:42 GMT";

const requests = [];

function upstream(request) {
  const url = new URL(request.url);
  requests.push(url.href);
  if (url.href === "https://cache.ruby-lang.org/pub/ruby/index.txt") return new Response(INDEX);
  if (url.hostname === "cache.ruby-lang.org") return new Response(null, { headers: { "last-modified": TARBALL } });
  if (url.href === "https://github.com/rbenv/ruby-build/releases.atom") return new Response("<feed></feed>");
  if (url.pathname.startsWith("/ruby/ruby-builder/releases/download/")) {
    return new Response(null, { headers: { "last-modified": BUILDER } });
  }
  if (url.hostname === "hub.docker.com" && url.pathname.startsWith("/v2/repositories/phusion/passenger-ruby")) {
    return Response.json({ results: [{ name: "latest", digest: "sha256:published" }, { name: "3.2.3", digest: "sha256:published" }] });
  }
  if (url.href === "https://raw.githubusercontent.com/phusion/passenger-docker/rel-3.2.3/image/ruby-4.0.10.sh") {
    return new Response(null);
  }
  return new Response(null, { status: 404 });
}

let mf;
let worker;

const get = (path) => mf.dispatchFetch(`https://rubywatch.test${path}`);
const runCron = () => worker.scheduled({ cron: "* * * * *" });

async function status() {
  const response = await get(`/api/status?${requests.length}-${Date.now()}`);
  assert.equal(response.status, 200);
  return response.json();
}

const row = (data, id) => data.groups.flatMap((g) => g.targets).find((t) => t.id === id);

before(async () => {
  mf = new Miniflare(
    convertV4MiniflareOptions({
      modulesRoot: `${root}src`,
      modules: ["index.js", "net.js", "targets.js", "page.html"].map((name) => ({
        type: name.endsWith(".js") ? "ESModule" : "Text",
        path: `${root}src/${name}`,
      })),
      compatibilityDate: wrangler.compatibility_date,
      d1Databases: ["DB"],
      outboundService: upstream,
    }),
  );
  worker = await mf.getWorker();
  await runCron();
});

after(() => mf?.dispose());

test("a cron round finds the newest release of each series and when it came out", async () => {
  const data = await status();
  assert.deepEqual(
    data.releases.map((r) => [r.version, r.released_at]),
    [
      ["4.0.10", "2026-11-18T23:34:42.000Z"],
      ["3.4.13", "2026-11-18T23:34:42.000Z"],
      ["3.3.14", "2026-11-18T23:34:42.000Z"],
    ],
  );
});

test("a channel that has the release reports the time its source gives", async () => {
  const data = await status();
  const result = row(data, "ruby-builder").results["4.0.10"];
  assert.equal(result.state, "found");
  assert.equal(result.at, "2026-11-18T23:45:42.000Z");
  assert.equal(result.exact, true);
});

test("a round stays inside its request budget", () => {
  assert.ok(requests.length <= 44, `${requests.length} requests`);
});

test("Passenger reports the Ruby in the published image, without claiming an exact release time", async () => {
  const data = await status();
  const passenger = row(data, "passenger");
  assert.equal(passenger.results["4.0.10"].state, "found");
  assert.equal(passenger.results["4.0.10"].exact, false);
  assert.equal(passenger.results["3.4.13"].state, "waiting");
  assert.equal(passenger.results["3.4.13"].checkedAt, data.lastRun);
});

test("a channel that does not have the release yet is waiting, with the time it was checked", async () => {
  const data = await status();
  for (const result of Object.values(row(data, "ruby-build").results)) {
    assert.equal(result.state, "waiting");
    assert.equal(result.checkedAt, data.lastRun);
  }
});

test("a channel with no source is listed with the reason", async () => {
  const data = await status();
  assert.match(row(data, "lambda").unsourced, /No source/);
});

test("a second cron round inside the same minute checks nothing", async () => {
  const before = requests.length;
  await runCron();
  assert.equal(requests.length, before);
});

test("no source is requested more than once in a round", () => {
  assert.equal(new Set(requests).size, requests.length);
});

test("the page arrives with its data, the Speedshop link and a cache lifetime", async () => {
  const response = await get("/");
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/html/);
  assert.match(response.headers.get("cache-control"), /^public, max-age=\d+$/);
  const embedded = JSON.parse(html.match(/<script id="data" type="application\/json">(.*?)<\/script>/s)[1]);
  assert.deepEqual(embedded.releases.map((r) => r.version), ["4.0.10", "3.4.13", "3.3.14"]);
  assert.match(html, /href="https:\/\/www\.speedshop\.co\/"/);
  assert.match(html, /<link rel="icon"/);
});

test("other paths and methods are not found", async () => {
  assert.equal((await get("/nope")).status, 404);
  assert.equal((await mf.dispatchFetch("https://rubywatch.test/", { method: "POST" })).status, 404);
});
