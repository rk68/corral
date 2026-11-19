// Your GitHub contributions for the last year.
//   fetch.mjs calendar  the profile's own calendar from GraphQL: exact counts per day, private
//                       work included when the profile shows it. One request.
//                       Prints { login, total, weeks: [[[date, count, level 0-4], ...7], ...] }.
//   fetch.mjs detail    what the counts are made of, from GitHub search: commits on default
//                       branches, PRs and issues opened, PRs reviewed, and the repos. The calendar
//                       gives private work as one number, search sees each item. Search allows 30
//                       requests a minute, so months are cached in ~/.cache/herdr-contributions/
//                       and only recent ones are fetched again.
//                       Prints { days: { "YYYY-MM-DD": [commits, prs, issues, reviews] }, repos, at }.
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DIR = path.join(os.homedir(), ".cache", "herdr-contributions");
const CACHE = path.join(DIR, "cache.json");
const LOCK = path.join(DIR, "lock");
const FRESH_MS = 10 * 60000;   // how long a recent month's results stay good
const FINAL_MS = 2 * 86400000; // a month this long over is never fetched again
const force = process.argv.includes("--force");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const day = (iso) => new Date(iso).toLocaleDateString("en-CA"); // local YYYY-MM-DD
const ymd = (d) => d.toISOString().slice(0, 10);

function gh(args) {
  return new Promise((resolve, reject) => {
    execFile("gh", args, { maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => (err ? reject(new Error((stderr || err.message).trim())) : resolve(stdout)));
  });
}

// One search request, waiting out the search rate limit when it runs out.
async function search(kind, q, page) {
  for (let tries = 0; ; tries++) {
    try {
      return JSON.parse(await gh(["api", "-X", "GET", `search/${kind}`, "-f", `q=${q}`, "-f", "per_page=100", "-f", `page=${page}`]));
    } catch (e) {
      if (tries >= 6 || !/rate limit|secondary|abuse|403|429/i.test(e.message)) throw e;
      let wait = 61000;
      try { wait = Math.max(2000, JSON.parse(await gh(["api", "rate_limit"])).resources.search.reset * 1000 - Date.now() + 1500); } catch { /* the default wait */ }
      await sleep(Math.min(wait, 65000));
    }
  }
}

// Every hit in a date range as [day, repo]. Search returns at most 1000 hits, so a fuller range
// is split in two.
async function hits(kind, query, field, from, to) {
  const q = `${query} ${field}:${ymd(from)}..${ymd(to)}`;
  const first = await search(kind, q, 1);
  if (first.total_count > 1000 && to - from > 86400000) {
    const mid = new Date(from.getTime() + Math.floor((to - from) / 86400000 / 2) * 86400000);
    const next = new Date(mid.getTime() + 86400000);
    return [...await hits(kind, query, field, from, mid), ...await hits(kind, query, field, next, to)];
  }
  const items = [...first.items];
  for (let page = 2; items.length < Math.min(first.total_count, 1000); page++) {
    const more = await search(kind, q, page);
    if (!more.items.length) break;
    items.push(...more.items);
  }
  return items.map((x) => kind === "commits"
    ? [day(x.commit.author.date), x.repository.full_name]
    : [day(x.created_at), x.repository_url.replace(/^.*\/repos\//, "")]);
}

// Reviews: search finds the PRs, each PR's reviews give the days. One per PR and day.
async function reviews(login, from, cache) {
  const found = [];
  let page = 1, total = 1;
  while (found.length < Math.min(total, 1000)) {
    const r = await search("issues", `reviewed-by:@me -author:@me type:pr updated:>=${ymd(from)}`, page++);
    total = r.total_count;
    if (!r.items.length) break;
    found.push(...r.items);
  }
  const out = [];
  for (const pr of found) {
    const repo = pr.repository_url.replace(/^.*\/repos\//, "");
    const key = `${repo}#${pr.number}`;
    let seen = cache.reviews[key];
    if (seen?.updated !== pr.updated_at) {
      const list = JSON.parse(await gh(["api", "--paginate", "--slurp", `repos/${repo}/pulls/${pr.number}/reviews?per_page=100`])).flat();
      const days = [...new Set(list.filter((x) => x.user?.login === login && x.submitted_at).map((x) => day(x.submitted_at)))];
      seen = cache.reviews[key] = { updated: pr.updated_at, days };
    }
    for (const d of seen.days) out.push([d, repo]);
  }
  return out;
}

async function lock() {
  fs.mkdirSync(DIR, { recursive: true });
  for (let i = 0; ; i++) {
    try { fs.mkdirSync(LOCK); return true; } catch {
      let age = 0;
      try { age = Date.now() - fs.statSync(LOCK).mtimeMs; } catch { continue; }
      if (age > 10 * 60000) { fs.rmSync(LOCK, { recursive: true, force: true }); continue; } // left by a crash
      if (i > 300) return false;
      await sleep(2000); // another copy is fetching: wait, then use its cache
    }
  }
}

const LEVEL = { NONE: 0, FIRST_QUARTILE: 1, SECOND_QUARTILE: 2, THIRD_QUARTILE: 3, FOURTH_QUARTILE: 4 };

async function calendar() {
  const q = "query{viewer{login contributionsCollection{contributionCalendar{totalContributions weeks{contributionDays{date contributionCount contributionLevel}}}}}}";
  const v = JSON.parse(await gh(["api", "graphql", "-f", `query=${q}`])).data.viewer;
  const cal = v.contributionsCollection.contributionCalendar;
  process.stdout.write(JSON.stringify({
    login: v.login, total: cal.totalContributions, at: Date.now(),
    weeks: cal.weeks.map((w) => w.contributionDays.map((d) => [d.date, d.contributionCount, LEVEL[d.contributionLevel] ?? 0])),
  }));
}

async function detail() {
  const login = (await gh(["api", "user", "--jq", ".login"])).trim();
  const today = new Date();
  // The profile's range: 53 columns, the first starting on a Sunday.
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 364);
  start.setDate(start.getDate() - start.getDay());
  const fetching = await lock();
  let cache = {};
  try { cache = JSON.parse(fs.readFileSync(CACHE, "utf8")); } catch { /* first run */ }
  if (cache.login !== login) cache = { login, months: {}, reviews: {} };
  cache.reviews ??= {};
  try {
    if (fetching) {
      const kinds = [
        ["commits", "commits", "author:@me", "committer-date"],
        ["prs", "issues", "author:@me type:pr", "created"],
        ["issues", "issues", "author:@me type:issue", "created"],
      ];
      for (let m = new Date(start.getFullYear(), start.getMonth(), 1); m <= today; m = new Date(m.getFullYear(), m.getMonth() + 1, 1)) {
        const end = new Date(m.getFullYear(), m.getMonth() + 1, 0);
        const id = `${m.getFullYear()}-${String(m.getMonth() + 1).padStart(2, "0")}`;
        for (const [name, kind, query, field] of kinds) {
          const key = `${name}:${id}`;
          const old = cache.months[key];
          const final = old && old.at - end.getTime() > FINAL_MS;
          if (old && (final || (!force && Date.now() - old.at < FRESH_MS))) continue;
          // UTC dates one day wider on each side: hits are put on local days afterwards.
          const from = new Date(Date.UTC(m.getFullYear(), m.getMonth(), 1) - 86400000);
          const to = new Date(Date.UTC(end.getFullYear(), end.getMonth(), end.getDate()) + 86400000);
          cache.months[key] = { at: Date.now(), items: await hits(kind, query, field, from, to) };
          fs.writeFileSync(CACHE, JSON.stringify(cache)); // progress survives a timeout
        }
      }
      if (force || Date.now() - (cache.reviewsAt ?? 0) > FRESH_MS) {
        cache.reviewItems = await reviews(login, start, cache);
        cache.reviewsAt = Date.now();
      }
      cache.at = Date.now();
      fs.writeFileSync(CACHE, JSON.stringify(cache));
    }
  } finally {
    if (fetching) fs.rmSync(LOCK, { recursive: true, force: true });
  }
  const first = start.toLocaleDateString("en-CA");
  const last = today.toLocaleDateString("en-CA");
  const days = {};
  const repos = new Map();
  const add = (slot, items, seen) => {
    for (const [d, repo] of items) {
      if (d < first || d > last) continue;
      const id = `${slot}|${d}|${repo}|${seen ? "" : Math.random()}`;
      if (seen?.has(id)) continue; // a month queried one day wide on each side sees some hits twice
      seen?.add(id);
      (days[d] ??= [0, 0, 0, 0])[slot]++;
      repos.set(repo, (repos.get(repo) ?? 0) + 1);
    }
  };
  for (const [key, v] of Object.entries(cache.months)) {
    const slot = { commits: 0, prs: 1, issues: 2 }[key.split(":")[0]];
    // Months overlap by a day, so a hit is counted only in its own month.
    const own = key.split(":")[1];
    add(slot, v.items.filter(([d]) => d.slice(0, 7) === own));
  }
  add(3, cache.reviewItems ?? []);
  process.stdout.write(JSON.stringify({
    days,
    repos: [...repos.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8),
    at: cache.at ?? Date.now(),
  }));
}

(process.argv[2] === "calendar" ? calendar() : detail()).catch((e) => { process.stdout.write(JSON.stringify({ error: String(e.message ?? e).split("\n").pop() })); process.exitCode = 1; });
