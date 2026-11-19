import { Net, OutOfBudget } from "./net.js";
import { groups, targets } from "./targets.js";

const SERIES = ["4.0", "3.4", "3.3"];
const INTERVAL = 60000;
const BUDGET = 44;
const PARALLEL = 6;

const SCHEMA = [
  "CREATE TABLE IF NOT EXISTS releases (version TEXT PRIMARY KEY, series TEXT NOT NULL, released_at TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS checks (version TEXT NOT NULL, target TEXT NOT NULL, missing_at TEXT, found_at TEXT, exact INTEGER NOT NULL DEFAULT 0, checked_at TEXT, PRIMARY KEY (version, target))",
  "CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
  "INSERT INTO meta (key, value) VALUES ('last_run', '') ON CONFLICT DO NOTHING",
];

const ensureSchema = (env) => env.DB.batch(SCHEMA.map((sql) => env.DB.prepare(sql)));

async function latestReleases(env, net) {
  const index = await net.text("https://cache.ruby-lang.org/pub/ruby/index.txt");
  const statements = [];
  for (const series of SERIES) {
    const patches = [...index.matchAll(new RegExp(`^ruby-${series.replace(".", "\\.")}\\.(\\d+)\\t\\S+\\.tar\\.gz\\t`, "gm"))];
    const version = `${series}.${Math.max(...patches.map((m) => Number(m[1])))}`;
    if (await env.DB.prepare("SELECT 1 FROM releases WHERE version = ?").bind(version).first()) continue;
    const tarball = await net.head(`https://cache.ruby-lang.org/pub/ruby/${series}/ruby-${version}.tar.gz`);
    statements.push(
      env.DB.prepare("INSERT INTO releases (version, series, released_at) VALUES (?, ?, ?)").bind(
        version,
        series,
        tarball.modified.toISOString(),
      ),
    );
  }
  if (statements.length) await env.DB.batch(statements);
}

async function currentReleases(env) {
  const { results } = await env.DB.prepare("SELECT * FROM releases").all();
  const patch = (r) => Number(r.version.split(".")[2]);
  return SERIES.map((s) => results.filter((r) => r.series === s).sort((a, b) => patch(b) - patch(a))[0]).filter(Boolean);
}

async function announcements(env) {
  return JSON.parse((await env.DB.prepare("SELECT value FROM meta WHERE key = 'announcements'").first("value")) ?? "{}");
}

async function findAnnouncements(env, net, releases) {
  const known = await announcements(env);
  if (releases.every((r) => known[r.version])) return;
  const feed = await net.text("https://www.ruby-lang.org/en/feeds/news.rss");
  for (const release of releases) {
    const slug = `ruby-${release.version.replaceAll(".", "-")}-released`;
    const link = feed?.match(new RegExp(`<link>([^<]*/${slug}/)</link>`))?.[1];
    if (link) known[release.version] = link;
  }
  await env.DB.prepare("INSERT INTO meta (key, value) VALUES ('announcements', ?1) ON CONFLICT (key) DO UPDATE SET value = ?1")
    .bind(JSON.stringify(known))
    .run();
}

async function currentChecks(env, releases) {
  if (!releases.length) return [];
  const marks = releases.map(() => "?").join(",");
  const { results } = await env.DB.prepare(`SELECT * FROM checks WHERE version IN (${marks})`)
    .bind(...releases.map((r) => r.version))
    .all();
  return results;
}

async function runProbe(env, net, now, { target, release, check }) {
  let result;
  try {
    result = await target.probe(net, release);
  } catch (error) {
    if (!(error instanceof OutOfBudget)) console.log(`${target.id} ${release.version}: ${error.message}`);
    return null;
  }
  if (!result) {
    return env.DB.prepare(
      "INSERT INTO checks (version, target, missing_at, checked_at) VALUES (?1, ?2, ?3, ?3) ON CONFLICT (version, target) DO UPDATE SET checked_at = excluded.checked_at",
    ).bind(release.version, target.id, now.toISOString());
  }
  const exact = result.at || check?.missing_at ? 1 : 0;
  return env.DB.prepare(
    "INSERT INTO checks (version, target, found_at, exact, checked_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (version, target) DO UPDATE SET found_at = excluded.found_at, exact = excluded.exact, checked_at = excluded.checked_at",
  ).bind(release.version, target.id, (result.at ?? now).toISOString(), exact, now.toISOString());
}

async function tick(env) {
  await ensureSchema(env);
  const last = await env.DB.prepare("SELECT value FROM meta WHERE key = 'last_run'").first("value");
  const wait = last ? new Date(last).getTime() + INTERVAL - Date.now() : 0;
  if (wait > 5000) return;
  if (wait > 0) await scheduler.wait(wait);
  const now = new Date();
  const claimed = await env.DB.prepare("UPDATE meta SET value = ? WHERE key = 'last_run' AND value <= ?")
    .bind(now.toISOString(), new Date(now - INTERVAL).toISOString())
    .run();
  if (!claimed.meta.changes) return;

  const net = new Net(BUDGET);
  await latestReleases(env, net);
  const releases = await currentReleases(env);
  await findAnnouncements(env, net, releases);
  const checks = await currentChecks(env, releases);
  const pending = [];
  for (const release of releases) {
    for (const target of targets) {
      if (!target.probe || (target.series && !target.series.includes(release.series))) continue;
      const check = checks.find((c) => c.version === release.version && c.target === target.id);
      if (!check?.found_at) pending.push({ target, release, check });
    }
  }
  const queue = pending.sort((a, b) => (a.check?.checked_at ?? "").localeCompare(b.check?.checked_at ?? ""));
  const statements = [];
  while (queue.length) {
    const results = await Promise.all(queue.splice(0, PARALLEL).map((p) => runProbe(env, net, now, p)));
    statements.push(...results.filter(Boolean));
  }
  if (statements.length) await env.DB.batch(statements);
}

async function status(env) {
  const releases = await currentReleases(env);
  const checks = await currentChecks(env, releases);
  const lastRun = await env.DB.prepare("SELECT value FROM meta WHERE key = 'last_run'").first("value");
  const announced = await announcements(env);
  const result = (target, release) => {
    if (target.unsourced || (target.series && !target.series.includes(release.series))) return { state: "none" };
    if (target.immediate) return { state: "found", at: release.released_at, exact: true };
    const id = target.sameAs ?? target.id;
    const check = checks.find((c) => c.version === release.version && c.target === id);
    if (!check?.found_at) return { state: "waiting", checkedAt: check?.checked_at };
    return { state: "found", at: check.found_at, exact: Boolean(check.exact), checkedAt: check.checked_at };
  };
  return {
    lastRun,
    releases: releases.map((r) => ({
      ...r,
      tarball: `https://cache.ruby-lang.org/pub/ruby/${r.series}/`,
      announcement: announced[r.version],
    })),
    groups: groups.map((group) => ({
      name: group.name,
      targets: group.targets.map((target) => ({
        id: target.id,
        name: target.name,
        note: target.note,
        url: target.url,
        unsourced: target.unsourced,
        results: Object.fromEntries(releases.map((r) => [r.version, result(target, r)])),
      })),
    })),
  };
}

export default {
  async fetch(request, env, ctx) {
    if (new URL(request.url).pathname !== "/api/status") return new Response("Not found", { status: 404 });
    const cached = await caches.default.match(request);
    if (cached) return cached;
    await ensureSchema(env);
    const response = Response.json(await status(env), { headers: { "cache-control": "public, max-age=15" } });
    ctx.waitUntil(caches.default.put(request, response.clone()));
    return response;
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(tick(env));
  },
};
