// This week's Claude Code spend on this machine, at API list prices, so Agent Flow can turn
// an agent's spend into a share of the weekly limit. The week comes from the Usage mod's
// cache (~/.cache/agent-usage/claude.json). Each transcript is read once; later runs read
// only the bytes added since, from offsets kept in ~/.cache/agent-flow/week.json.
// Prints { weekStart, cost, pct, at } or { weekStart: null } when the week is unknown.
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { price } = require("./price.cjs");

const home = os.homedir();
const projects = path.join(home, ".claude", "projects");
const cacheFile = path.join(home, ".cache", "agent-flow", "week.json");
const WEEK_MS = 7 * 24 * 3600 * 1000;
const CHUNK = 4 * 1024 * 1024;

const json = (f) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; } };
const usage = json(path.join(home, ".cache", "agent-usage", "claude.json"))?.rate_limits?.seven_day;
if (!usage?.resets_at) { process.stdout.write(JSON.stringify({ weekStart: null })); process.exit(0); }
const weekStart = usage.resets_at * 1000 - WEEK_MS;

let cache = json(cacheFile);
if (cache?.weekStart !== weekStart) cache = { weekStart, files: {} }; // a new week starts over

function* transcripts(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) yield* transcripts(f);
    else if (e.name.endsWith(".jsonl")) yield f;
  }
}

// Reads from the saved offset to the last whole line. Rows of one message repeat its usage,
// and they are written together, so a repeat of the last id is skipped.
function read(f, entry) {
  const fd = fs.openSync(f, "r");
  const size = fs.fstatSync(fd).size;
  if (size < entry.offset) Object.assign(entry, { offset: 0, cost: 0, lastId: null }); // rewritten
  let rest = "";
  const buf = Buffer.alloc(CHUNK);
  let pos = entry.offset;
  while (pos < size) {
    const n = fs.readSync(fd, buf, 0, Math.min(CHUNK, size - pos), pos);
    if (!n) break;
    pos += n;
    const text = rest + buf.toString("utf8", 0, n);
    const lines = text.split("\n");
    rest = lines.pop();
    for (const line of lines) {
      if (!line.includes('"usage"') || !line.includes('"assistant"')) continue;
      let r;
      try { r = JSON.parse(line); } catch { continue; }
      const m = r.message;
      if (r.type !== "assistant" || !m?.usage || !m.id || m.model === "<synthetic>") continue;
      if (m.id === entry.lastId) continue;
      entry.lastId = m.id;
      if ((Date.parse(r.timestamp ?? "") || 0) >= weekStart) entry.cost += price(m.model, m.usage);
    }
  }
  fs.closeSync(fd);
  entry.offset = pos - Buffer.byteLength(rest);
}

let cost = 0;
for (const f of transcripts(projects)) {
  let stat;
  try { stat = fs.statSync(f); } catch { continue; }
  if (stat.mtimeMs < weekStart) continue;
  const entry = cache.files[f] ?? (cache.files[f] = { offset: 0, cost: 0, lastId: null });
  if (stat.size !== entry.offset) {
    try { read(f, entry); } catch { /* a file that went away counts what was read */ }
  }
  cost += entry.cost;
}
for (const f of Object.keys(cache.files)) if (!fs.existsSync(f)) cost += cache.files[f].cost; // deleted, still spent

fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
fs.writeFileSync(cacheFile, JSON.stringify(cache));
process.stdout.write(JSON.stringify({ weekStart, cost: Math.round(cost * 100) / 100, pct: usage.used_percentage, at: Date.now() }));
