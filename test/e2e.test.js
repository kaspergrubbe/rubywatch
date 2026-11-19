import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
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
const LAMBDA_BUILT = "2026-11-19T12:54:36.377829917Z";
const LAMBDA_RUBIES = { "4.0": "4.0.10", "3.4": "3.4.12", "3.3": "3.3.13" };
const ECR = "https://public.ecr.aws/v2/lambda/ruby";

function lambdaRegistry(url) {
  const [kind, ref] = url.pathname.split("/").slice(-2);
  if (kind === "manifests" && ref in LAMBDA_RUBIES) {
    return Response.json({ manifests: [{ digest: `sha256:image-${ref}`, platform: { architecture: "amd64" } }] });
  }
  const series = ref.replace(/^sha256:\w+-/, "");
  if (ref.startsWith("sha256:image-")) {
    return Response.json({
      config: { digest: `sha256:config-${series}` },
      layers: [{ digest: "sha256:os" }, { digest: `sha256:runtime-${series}` }, { digest: "sha256:entrypoint" }],
    });
  }
  if (ref.startsWith("sha256:config-")) return Response.json({ created: LAMBDA_BUILT });
  if (ref.startsWith("sha256:runtime-")) {
    const banner = `ruby ${LAMBDA_RUBIES[series]} (2026-11-19 revision a704b7cd95) +PRISM [x86_64-linux]`;
    return new Response(gzipSync(Buffer.from(`${"\0".repeat(4096)}${banner}${"\0".repeat(4096)}`)), { status: 206 });
  }
  return new Response(null, { status: 404 });
}

const requests = [];

function upstream(request) {
  const url = new URL(request.url);
  requests.push(url.href);
  if (url.href === "https://cache.ruby-lang.org/pub/ruby/index.txt") return new Response(INDEX);
  if (url.hostname === "cache.ruby-lang.org") return new Response(null, { headers: { "last-modified": TARBALL } });
  if (url.href === "https://github.com/rbenv/ruby-build/releases.atom") return new Response("<feed></feed>");
  if (url.href === "https://public.ecr.aws/token/") return Response.json({ token: "token" });
  if (url.href.startsWith(ECR)) return lambdaRegistry(url);
  if (url.pathname.startsWith("/ruby/ruby-builder/releases/download/")) {
    return new Response(null, { headers: { "last-modified": BUILDER } });
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

test("a channel that does not have the release yet is waiting, with the time it was checked", async () => {
  const data = await status();
  for (const result of Object.values(row(data, "ruby-build").results)) {
    assert.equal(result.state, "waiting");
    assert.equal(result.checkedAt, data.lastRun);
  }
});

test("AWS Lambda reads the Ruby inside its base image and times it by the image build", async () => {
  const { results } = row(await status(), "lambda");
  assert.equal(results["4.0.10"].state, "found");
  assert.equal(results["4.0.10"].at, "2026-11-19T12:54:36.377Z");
  assert.equal(results["3.4.13"].state, "waiting");
  assert.equal(results["3.3.14"].state, "waiting");
});

test("a second cron round inside the same minute checks nothing", async () => {
  const before = requests.length;
  await runCron();
  assert.equal(requests.length, before);
});

test("no source is requested more than once in a round", () => {
  assert.equal(new Set(requests).size, requests.length);
});

test("later rounds read an already seen Lambda image without downloading it again", async () => {
  const db = await mf.getD1Database("DB");
  for (let round = 0; round < 4; round++) {
    await db.prepare("UPDATE meta SET value = ? WHERE key = 'last_run'").bind(new Date(Date.now() - 120000).toISOString()).run();
    await runCron();
  }
  const count = (url) => requests.filter((r) => r === url).length;
  assert.ok(count(`${ECR}/manifests/3.4`) > 1, "the 3.4 image index is checked again in later rounds");
  for (const series of ["4.0", "3.4", "3.3"]) assert.ok(count(`${ECR}/blobs/sha256:runtime-${series}`) <= 1, series);
  assert.equal(row(await status(), "lambda").results["3.4.13"].state, "waiting");
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
