// Prints what live coding agents are doing, as JSON: Claude Code sessions from their
// transcripts, opencode's and Codex's from their local SQLite files (opened read-only).
// Arguments: `opencode=<folder>` / `codex=<folder>`, one per terminal running that agent.
// A mod can't stat files or read part of one, and transcripts grow to many MB, so this
// reads only their tails. Read-only. Prompts and tool output are never printed: only
// tool names, a short hint (file name, Bash description, pattern) and subagent descriptions.
// From tool results and replies it also takes short derived facts, never the text itself:
// a PR number, CI check counts and failed check names, an auto-mode denial's reason, context
// resets, and the agent's last question to the person (one line).
const fs = require("fs");
const os = require("os");
const path = require("path");

const root = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
const projects = path.join(root, "projects");
const MAIN_TAIL = 6 * 1024 * 1024; // screenshots put ~1 MB in one row
const SUB_TAIL = 2 * 1024 * 1024; // whole, for almost all: counts stay exact
const HISTORY_MS = 60 * 60000; // how far back the Context and Lanes views reach
const MAX_TICKS = 400;
const { price, rates } = require("./price.cjs");
const MAX_SUBS = 12;
const QUIET_MS = 3 * 60 * 1000; // an unfinished subagent silent this long is reported stale
const EDITS = /^(Edit|MultiEdit|Write|NotebookEdit|apply_patch)$/;
const WAITS = /^(Agent|Task|TaskOutput|Monitor|AskUserQuestion)$/; // a long wait on these is normal
const HUNG_MS = 15 * 60000;
const STALL_MS = 20 * 60000;
const now = Date.now();

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}

function json(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

function tail(file, max) {
  const stat = fs.statSync(file);
  const start = Math.max(0, stat.size - max);
  const fd = fs.openSync(file, "r");
  const buf = Buffer.alloc(stat.size - start);
  try { fs.readSync(fd, buf, 0, buf.length, start); } finally { fs.closeSync(fd); }
  const lines = buf.toString("utf8").split("\n");
  if (start > 0) lines.shift(); // starts mid-line
  const rows = [];
  for (const l of lines) {
    if (!l) continue;
    try { rows.push(JSON.parse(l)); } catch { /* a line still being written */ }
  }
  return { rows, stat, partial: start > 0 };
}

function hint(name, input = {}) {
  const short = (s, n = 46) => { s = String(s ?? "").replace(/\s+/g, " ").trim(); return s.length > n ? s.slice(0, n - 1) + "…" : s; };
  if (input.file_path) return short(path.basename(String(input.file_path)));
  if (name === "Agent" || name === "Task") return short(input.description);
  if (input.description) return short(input.description);
  if (input.pattern) return short(input.pattern);
  if (input.url) { try { return new URL(input.url).host; } catch { return ""; } }
  if (input.command) return short(input.command);
  return "";
}

// Who a tool call is talking to: `hc send <target>` from a shell, or Claude Code's
// SendMessage. Only the target leaves here, never the message.
function target(name, input = {}) {
  if (name === "SendMessage" && input.to) return String(input.to);
  if (typeof input.command !== "string") return null;
  const hit = /(?:^|[\s;&|/\\"'])hc(?:\.exe)?["']?\s+send\s+(?:--?[a-z-]+\s+)*["']?([\w:./-]+)/i.exec(input.command);
  return hit ? hit[1] : null;
}

// Messages arrive tagged <hc from="t7 review">. Only the address leaves here.
function heard(out, text, at) {
  for (const hit of String(text).matchAll(/<hc from=\\?"([^"\\\s]+)/g)) out.recvs.push({ t: at, from: hit[1] });
}

function note(out, item, name, input, at) {
  const to = target(name, input);
  if (!to) return;
  item.name = "Send";
  item.hint = to;
  item.to = to;
  out.sends.push({ t: at, to });
}

// The text of a tool result, which is a string or a list of blocks.
function resultText(b) {
  const c = b.content;
  const t = typeof c === "string" ? c : Array.isArray(c) ? c.map((x) => (x?.type === "text" ? x.text : "")).join("\n") : "";
  return t.length > 200000 ? t.slice(-200000) : t;
}

// CI from a command's output: `gh pr checks` rows (name<TAB>pass|fail...) or the
// PASS / FAIL lines local check scripts print.
function checks(text) {
  let pass = 0, fail = 0, pending = 0;
  const failed = [];
  for (const line of text.split("\n")) {
    const gh = /^([^\t]+)\t(pass|fail|pending|skipping|cancel)\b/i.exec(line);
    // A check script's line names the command it ran; a test runner's FAIL names a file.
    const run = /^\s*(PASS|FAIL)\s+((?:pnpm|npm|yarn|bun|npx|node|make|cargo|go|uv|pytest|ruff|tsc|biome)\b.*)$/.exec(line);
    // Or a summary line an agent writes: "- pnpm typecheck: pass".
    const said = run ? null : /^\s*[-*•]?\s*((?:pnpm|npm|yarn|bun|npx|node|make|cargo|go|uv|pytest|ruff|tsc|biome|check:|skill-suite)[^:]{0,60}):\s*(pass(?:ed|es)?|fail(?:ed|s)?|exit 0)\b/i.exec(line);
    const local = run ? [run[1].toLowerCase(), run[2]] : said ? [/^fail/i.test(said[2]) ? "fail" : "pass", said[1]] : null;
    const state = gh ? gh[2].toLowerCase() : local?.[0];
    if (!state) continue;
    const name = (gh ? gh[1] : local[1]).trim().replace(/^pnpm\s+(--filter\s+\S+\s+)?/, "").slice(0, 32);
    if (state === "pass") pass++;
    else if (state === "fail" || state === "cancel") { fail++; if (failed.length < 3) failed.push(name); }
    else if (state === "pending") pending++;
  }
  return pass + fail + pending ? { pass, fail, pending, failed } : null;
}

const PR_URL = /github\.com\/[\w.-]+\/[\w.-]+\/pull\/(\d+)/g;
const PR_CMD = /\bgh\s+pr\s+(?:view|checks|merge|edit|ready|diff|comment|review)\s+#?(\d+)/;

// The last line of a reply that asks the person something.
function asked(text) {
  const lines = String(text).split("\n").map((l) => l.replace(/^[\s>*#\-\d.)]+/, "").trim()).filter(Boolean);
  const q = [...lines].reverse().find((l) => /\?["')\]]?$/.test(l))
    ?? [...lines].reverse().find((l) => /^(Next[,:]|Decide|Your call|Yours to do|Waiting on you|Need(s)? your)/i.test(l));
  if (!q) return null;
  return q.length > 140 ? q.slice(0, 139) + "…" : q;
}

// CI in a child's report belongs to the child: kept by sender address for the mod to match.
function report(out, text, at) {
  const from = [...text.matchAll(/<hc from=\\?"([^"\\\s]+)/g)].pop()?.[1];
  const ci = from ? checks(text) : null;
  if (ci && ci.pass + ci.fail >= 2) out.reports.push({ from, t: at, ...ci });
}

function digest(rows) {
  const out = { model: null, ctx: 0, tools: 0, turnAt: 0, lastAt: 0, now: null, recent: [], sends: [], recvs: [],
    pr: null, ci: null, reports: [], blocks: [], resets: 0, resetAt: 0, ctxRate: 0, ask: null,
    series: [], ticks: [], resetTimes: [], spend: [], cost: 0, cacheMin: [], misses: [], stuck: [] };
  const open = new Map();
  const costs = new Map(); // message id -> [time, dollars]: one message spans several rows
  const agents = new Map();
  const cmds = new Map();
  const samples = [];
  const msgs = new Map(); // message id -> { t, model, u }, for cache use
  const allResets = [];
  const turnResults = []; // this turn's tool results: { key, name, hint, err }
  const uses = [];    // this turn's tool calls: { key, name, hint, edit }
  let lastEditAt = 0, edits = 0;
  let lastText = null;
  for (const r of rows) {
    const c = r.message?.content;
    const at = Date.parse(r.timestamp ?? "") || 0;
    if (at) out.lastAt = Math.max(out.lastAt, at);
    if (r.type === "assistant") {
      const m = r.message;
      if (m?.model && m.model !== "<synthetic>") out.model = m.model;
      const u = m?.usage;
      if (u) {
        out.ctx = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
        if (at) samples.push([at, out.ctx]);
        if (m.id && m.model !== "<synthetic>") {
          costs.set(m.id, [at, price(m.model, u)]);
          if (!msgs.has(m.id)) msgs.set(m.id, { t: at, model: m.model, u });
        }
      }
      for (const b of Array.isArray(c) ? c : []) if (b.type === "text" && b.text?.trim()) lastText = b.text;
      for (const b of Array.isArray(c) ? c : []) {
        if (b.type !== "tool_use") continue;
        const item = { t: at, name: b.name, hint: hint(b.name, b.input) };
        // What makes two calls the same call: the whole command or path, never printed.
        const key = `${b.name}:${typeof b.input?.command === "string" ? b.input.command.trim().slice(0, 300) : b.input?.file_path ?? b.input?.pattern ?? b.input?.url ?? item.hint}`;
        uses.push({ key, name: b.name, hint: item.hint, edit: EDITS.test(b.name), t: at });
        if (EDITS.test(b.name)) { lastEditAt = at; edits++; }
        if (typeof b.input?.command === "string") {
          cmds.set(b.id, b.input.command);
          const n = PR_CMD.exec(b.input.command)?.[1];
          if (n) out.pr = { n: Number(n), t: at };
        }
        note(out, item, b.name, b.input, at);
        out.tools++;
        out.recent.push(item);
        if (at >= now - HISTORY_MS) out.ticks.push([at, b.name]);
        open.set(b.id, Object.assign(item, { key }));
        if (b.name === "Agent" || b.name === "Task") {
          agents.set(b.id, b.input?.subagent_type ?? "agent");
          item.delegate = b.input?.subagent_type ?? "agent";
        }
      }
    } else if (r.type === "user") {
      const results = Array.isArray(c) ? c.filter((b) => b.type === "tool_result") : [];
      if (typeof c === "string") heard(out, c, at);
      else for (const b of Array.isArray(c) ? c : []) if (b.type === "text") heard(out, b.text, at);
      for (const b of results) {
        const used = open.get(b.tool_use_id);
        const text = resultText(b);
        const denied = /denied by the Claude Code auto mode classifier\. Reason: \[([^\]]+)\]/.exec(text);
        if (denied) out.blocks.push({ t: at, reason: denied[1], name: used?.name ?? "", hint: used?.hint ?? "" });
        const cmd = cmds.get(b.tool_use_id) ?? "";
        if (/\bgh\s+pr\s+create\b/.test(cmd) || /\bgh\s+pr\s+(view|checks)\b/.test(cmd)) {
          const n = [...text.matchAll(PR_URL)].pop()?.[1];
          if (n) out.pr = { n: Number(n), t: at };
        }
        const ci = text.length < 60000 ? checks(text) : null;
        if (ci && (ci.pass + ci.fail >= 2)) out.ci = { ...ci, t: at, gh: /\bgh\s+pr\s+checks\b/.test(cmd) };
        if (used) turnResults.push({ key: used.key, name: used.name, hint: used.hint, err: b.is_error === true });
        open.delete(b.tool_use_id);
        if (agents.has(b.tool_use_id)) {
          out.recent.push({ t: at, name: "back", hint: agents.get(b.tool_use_id), back: true });
        }
      }
      if (r.isCompactSummary) { /* counted at its compact_boundary */ }
      else if (!results.length && !r.isMeta && !r.isSidechain) { out.tools = 0; out.turnAt = at; lastText = null; uses.length = 0; turnResults.length = 0; }
      // Reports from hc children carry CI lines too.
      const said = typeof c === "string" ? c : Array.isArray(c) ? c.map((x) => (x?.type === "text" ? x.text : "")).join("\n") : "";
      if (said.includes("<hc from=")) report(out, said, at);
    } else if (r.type === "queue-operation" && r.operation === "enqueue" && typeof r.content === "string" && r.content.includes("<hc from=")) {
      report(out, r.content, at); // a report typed in while the agent was busy waits in its queue
    } else if (r.type === "system" && r.subtype === "compact_boundary") {
      out.resets++; out.resetAt = at; allResets.push(at);
      if (at >= now - HISTORY_MS) out.resetTimes.push(at);
    }
  }
  // Tokens a minute over the last ten minutes, since the last reset.
  const recent = samples.filter(([t]) => t >= Math.max(now - 600000, out.resetAt));
  if (recent.length >= 2) {
    const [[t0, c0], [t1, c1]] = [recent[0], recent[recent.length - 1]];
    if (t1 - t0 > 30000) out.ctxRate = Math.max(0, Math.round(((c1 - c0) / (t1 - t0)) * 60000));
  }
  // The last hour of context size, one sample per 30 s bucket: a reset still shows as a drop.
  const buckets = new Map();
  for (const [t, c] of samples) if (t >= now - HISTORY_MS) buckets.set(Math.floor(t / 30000), [t, c]);
  out.series = [...buckets.values()];
  out.ticks = out.ticks.slice(-MAX_TICKS);
  const minutes = new Map();
  for (const [t, usd] of costs.values()) {
    out.cost += usd;
    if (t >= now - HISTORY_MS) { const k = Math.floor(t / 60000) * 60000; minutes.set(k, (minutes.get(k) ?? 0) + usd); }
  }
  out.spend = [...minutes.entries()].sort((a, b) => a[0] - b[0]).map(([t, usd]) => [t, Math.round(usd * 10000) / 10000]);
  out.cost = Math.round(out.cost * 100) / 100;
  out.resetTimes = out.resetTimes.slice(-10);
  cache(out, msgs, allResets);
  out.stuck = stuck(out, uses, turnResults, open, { lastEditAt, edits });
  out.ask = lastText ? asked(lastText) : null;
  out.blocks = out.blocks.slice(-3);
  out.reports = out.reports.slice(-12);
  const pending = [...open.values()].pop();
  out.now = pending ? { name: pending.name, hint: pending.hint } : null;
  for (const x of out.recent) delete x.key;
  out.recent = out.recent.slice(-24);
  out.sends = out.sends.slice(-20);
  out.recvs = out.recvs.slice(-20);
  return out;
}

// Cache use per minute over the last hour, and each time the cache was lost: a message that
// wrote most of a large context again instead of reading it. Its waste is the write's price
// over what a read of the same tokens costs. The cause is a guess from the gap before it.
function cache(out, msgs, resets) {
  const minutes = new Map();
  let prev = 0, prevT = 0, prevModel = null;
  for (const { t, model, u } of msgs.values()) {
    const read = u.cache_read_input_tokens ?? 0;
    const w1h = u.cache_creation?.ephemeral_1h_input_tokens ?? 0;
    const w5m = u.cache_creation?.ephemeral_5m_input_tokens ?? Math.max(0, (u.cache_creation_input_tokens ?? 0) - w1h);
    const fresh = u.input_tokens ?? 0;
    const write = w1h + w5m;
    if (t >= now - HISTORY_MS) {
      const k = Math.floor(t / 60000) * 60000;
      const m = minutes.get(k) ?? [k, 0, 0, 0];
      m[1] += read; m[2] += write; m[3] += fresh;
      minutes.set(k, m);
      const reset = resets.some((r) => r > prevT && r <= t);
      if (prev > 30000 && write >= 20000 && read < prev * 0.5 && !reset) {
        const [i, , r] = rates(model) ?? [0, 0, 0];
        const usd = (w5m * i * 1.25 + w1h * i * 2 - write * r) / 1e6;
        const gap = t - prevT;
        const why = model !== prevModel ? "model changed" : gap > 3600000 ? `idle ${Math.round(gap / 60000)}m` : gap > 300000 && w5m > w1h ? `idle ${Math.round(gap / 60000)}m` : "cache lost";
        out.misses.push([t, write, Math.round(usd * 1000) / 1000, why]);
      }
    }
    prev = read + write + fresh; prevT = t; prevModel = model;
  }
  out.cacheMin = [...minutes.values()].sort((a, b) => a[0] - b[0]);
  out.misses = out.misses.slice(-20);
}

// Signs that an agent is going round in circles, from its current turn. Each is a short
// line for the person; the mod shows them only while the agent still runs.
function stuck(out, uses, results, open, { lastEditAt, edits }) {
  const found = [];
  const top = (list) => {
    const n = new Map();
    for (const x of list) n.set(x.key, [x, (n.get(x.key)?.[1] ?? 0) + 1]);
    return [...n.values()].sort((a, b) => b[1] - a[1])[0] ?? [null, 0];
  };
  const [failed, fails] = top(results.slice(-10).filter((x) => x.err));
  if (fails >= 3) found.push({ kind: "fail", text: `${failed.name} failed ${fails}× · ${failed.hint}` });
  const [same, times] = top(uses.slice(-12).filter((x) => !WAITS.test(x.name)));
  if (times >= 6 && same.key !== failed?.key) found.push({ kind: "loop", text: `${same.name} ${times}× in 12 calls · ${same.hint}` });
  const pending = [...open.values()].pop();
  if (pending && now - pending.t > HUNG_MS && !WAITS.test(pending.name) && !/\bhc\s+wait\b|\bsleep\b/.test(pending.key ?? "")) {
    found.push({ kind: "hung", text: `${pending.name} running ${Math.round((now - pending.t) / 60000)}m · ${pending.hint}` });
  }
  const sinceEdit = uses.length - 1 - uses.map((x) => x.edit).lastIndexOf(true);
  if (edits && out.turnAt && now - out.turnAt > STALL_MS && now - Math.max(lastEditAt, out.turnAt) > STALL_MS && sinceEdit >= 40) {
    found.push({ kind: "stall", text: `${sinceEdit} tools in ${Math.round((now - Math.max(lastEditAt, out.turnAt)) / 60000)}m without an edit` });
  }
  const resets = out.resetTimes.filter((t) => t >= now - HISTORY_MS).length;
  if (resets >= 3) found.push({ kind: "thrash", text: `context reset ${resets}× in the last hour` });
  const denied = out.blocks.filter((b) => b.t >= now - 15 * 60000).length;
  if (denied >= 2) found.push({ kind: "denied", text: `auto mode denied ${denied}× in 15m` });
  return found;
}

function transcript(cwd, id) {
  const direct = path.join(projects, cwd.replace(/[^a-zA-Z0-9]/g, "-"), `${id}.jsonl`);
  if (fs.existsSync(direct)) return direct;
  for (const dir of fs.readdirSync(projects)) {
    const file = path.join(projects, dir, `${id}.jsonl`);
    if (fs.existsSync(file)) return file;
  }
  return null;
}

function subagents(file) {
  const dir = path.join(file.slice(0, -".jsonl".length), "subagents");
  let names;
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith(".jsonl")); } catch { return { subs: [], total: 0 }; }
  const list = names.map((name) => {
    const f = path.join(dir, name);
    const stat = fs.statSync(f);
    return { f, name, born: stat.birthtimeMs, seen: stat.mtimeMs };
  }).sort((a, b) => b.born - a.born);
  const subs = list.slice(0, MAX_SUBS).map(({ f, name, born, seen }) => {
    const meta = json(f.replace(/\.jsonl$/, ".meta.json")) ?? {};
    const { rows, partial } = tail(f, SUB_TAIL);
    const d = digest(rows);
    const status = meta.finished === true ? "done" : now - seen > QUIET_MS ? "stale" : "working";
    return {
      id: name.replace(/^agent-|\.jsonl$/g, ""), type: meta.agentType ?? "agent",
      description: meta.description ?? "", status, model: d.model ?? meta.pickedEffortModel ?? null,
      tools: d.tools, more: partial, ctx: d.ctx, now: d.now, recent: d.recent.slice(-8), sends: d.sends,
      pr: d.pr, ci: d.ci, blocks: d.blocks, resets: d.resets, ctxRate: d.ctxRate, ask: d.ask,
      series: d.series, ticks: d.ticks, resetTimes: d.resetTimes, spend: d.spend, cost: d.cost,
      cacheMin: d.cacheMin, misses: d.misses, stuck: d.stuck,
      startedAt: Math.round(born), lastAt: Math.round(seen),
    };
  });
  return { subs, total: list.length };
}

const sameDir = (a, b) => norm(a) === norm(b);
const norm = (p) => String(p ?? "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
const wanted = (agent) => process.argv.slice(2).filter((a) => a.startsWith(`${agent}=`)).map((a) => a.slice(agent.length + 1));

// node:sqlite needs Node 22; without it these agents still show, only without a model.
function database(file) {
  try {
    const { DatabaseSync } = require("node:sqlite");
    return new DatabaseSync(file, { readOnly: true });
  } catch { return null; }
}

// The latest rows for each asked folder: two terminals in one folder take two sessions.
function perFolder(rows, folders, dirOf) {
  const left = [...folders];
  return rows.filter((r) => {
    const i = left.findIndex((f) => sameDir(f, dirOf(r)));
    if (i < 0) return false;
    left.splice(i, 1);
    return true;
  });
}

function digestOpencode(rows) {
  const out = { model: null, ctx: 0, tools: 0, turnAt: 0, lastAt: 0, now: null, recent: [], sends: [], recvs: [] };
  for (const r of rows) {
    out.lastAt = Math.max(out.lastAt, r.time_created);
    if (r.type === "user") { out.tools = 0; out.turnAt = r.time_created; out.now = null; heard(out, r.data, r.time_created); }
    if (r.type !== "assistant") continue;
    let d;
    try { d = JSON.parse(r.data); } catch { continue; }
    if (d.model?.id) out.model = d.model.id;
    for (const b of d.content ?? []) {
      if (b.type !== "tool") continue;
      const given = typeof b.state?.input === "object" ? b.state.input ?? {} : {};
      const name = String(b.name)[0].toUpperCase() + String(b.name).slice(1);
      const item = { t: b.time?.created ?? r.time_created, name, hint: hint(name, { ...given, file_path: given.filePath ?? given.file_path ?? (/^(read|edit|write)/i.test(name) ? given.path : undefined) }) };
      note(out, item, name, given, item.t);
      out.tools++;
      out.recent.push(item);
      out.now = /run|stream|pend/.test(b.state?.status ?? "") ? item : null;
    }
  }
  out.now = out.now ? { name: out.now.name, hint: out.now.hint } : null;
  out.recent = out.recent.slice(-24);
  out.sends = out.sends.slice(-20);
  out.recvs = out.recvs.slice(-20);
  return out;
}

function opencode(folders) {
  if (!folders.length) return [];
  const data = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
  const file = path.join(data, "opencode", "opencode.db");
  const db = fs.existsSync(file) ? database(file) : null;
  if (!db) return [];
  try {
    const messages = db.prepare("select type, data, time_created from session_message where session_id = ? order by seq desc limit 200");
    const load = (id) => digestOpencode(messages.all(id).reverse());
    const roots = db.prepare("select id, directory, time_updated from session_v2 where parent_id is null and time_archived is null order by time_updated desc limit 60").all();
    const children = db.prepare("select id, agent, title, time_created, time_updated, time_idle from session_v2 where parent_id = ? order by time_created desc limit ?");
    return perFolder(roots, folders, (r) => r.directory).map((r) => {
      const subs = children.all(r.id, MAX_SUBS).map((k) => {
        const d = load(k.id);
        const status = k.time_idle != null ? "done" : now - k.time_updated > QUIET_MS ? "stale" : "working";
        return { id: k.id, type: k.agent ?? "subagent", description: k.title ?? "", status, model: d.model, tools: d.tools, more: false, ctx: 0, now: d.now, recent: d.recent.slice(-8), sends: d.sends, startedAt: k.time_created, lastAt: k.time_updated };
      });
      return { id: r.id, agent: "opencode", cwd: r.directory, ...load(r.id), lastAt: r.time_updated, more: false, subs, total: subs.length };
    });
  } catch { return []; } finally { db.close(); }
}

function codex(folders) {
  if (!folders.length) return [];
  const home = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  const blank = { tools: null, ctx: 0, turnAt: 0, now: null, recent: [], sends: [], recvs: [], more: false, subs: [], total: 0 };
  let files = [];
  try { files = fs.readdirSync(home).filter((n) => /^state_\d+\.sqlite$/.test(n)).sort(); } catch { return []; }
  let rows = [];
  const db = files.length ? database(path.join(home, files[files.length - 1])) : null;
  if (db) {
    try { rows = db.prepare("select id, cwd, model, updated_at_ms from threads where archived = 0 order by updated_at_ms desc limit 60").all(); } catch { /* another version's schema */ } finally { db.close(); }
  }
  const found = perFolder(rows, folders, (r) => r.cwd).map((r) => ({ ...blank, id: r.id, agent: "codex", cwd: r.cwd, model: r.model, lastAt: r.updated_at_ms }));
  if (found.length) return found;
  // No thread yet: what it will run with.
  let toml = "";
  try { toml = fs.readFileSync(path.join(home, "config.toml"), "utf8"); } catch { return []; }
  const model = /^model\s*=\s*"([^"]+)"/m.exec(toml)?.[1] ?? null;
  return model ? folders.map((cwd, i) => ({ ...blank, id: `codex-${i}`, agent: "codex", cwd, model, lastAt: 0 })) : [];
}

// Oh My Pi: one JSONL per session in ~/.omp/agent/sessions/<folder>/, the folder named
// after the cwd ("-Code-x" under home, "--private-tmp--" outside it). The model is the
// last assistant message's, or the last model_change before any reply.
function omp(folders) {
  if (!folders.length) return [];
  const home = os.homedir();
  const base = path.join(process.env.PI_CODING_AGENT_DIR || path.join(home, ".omp", "agent"), "sessions");
  const blank = { tools: null, ctx: 0, turnAt: 0, now: null, recent: [], sends: [], recvs: [], more: false, subs: [], total: 0 };
  const used = new Set();
  const out = [];
  for (const cwd of folders) {
    const name = cwd === home ? "-"
      : cwd.startsWith(`${home}/`) ? `-${cwd.slice(home.length + 1).replace(/\//g, "-")}`
      : `--${cwd.replace(/^\//, "").replace(/\//g, "-")}--`;
    let files = [];
    try {
      files = fs.readdirSync(path.join(base, name)).filter((n) => n.endsWith(".jsonl"))
        .map((n) => path.join(base, name, n)).filter((f) => !used.has(f))
        .map((f) => ({ f, m: fs.statSync(f).mtimeMs })).sort((a, b) => b.m - a.m);
    } catch { continue; }
    const pick = files[0];
    if (!pick) continue;
    used.add(pick.f);
    let model = null;
    try {
      for (const r of tail(pick.f, SUB_TAIL).rows) {
        if (r.type === "message" && r.message?.role === "assistant" && r.message.model) model = r.message.model;
        else if (r.type === "model_change" && r.model) model = r.model.split("/").pop();
      }
    } catch { /* the file vanished mid-read */ }
    out.push({ ...blank, id: path.basename(pick.f, ".jsonl"), agent: "omp", cwd, model, lastAt: Math.round(pick.m) });
  }
  return out;
}

const sessions = [];
let dir = [];
try { dir = fs.readdirSync(path.join(root, "sessions")); } catch { /* no live sessions */ }
for (const name of dir) {
  if (!name.endsWith(".json")) continue;
  const s = json(path.join(root, "sessions", name));
  if (!s?.sessionId || !s.cwd || !alive(s.pid)) continue;
  try {
    const file = transcript(s.cwd, s.sessionId);
    if (!file) continue;
    const { rows, stat, partial } = tail(file, MAIN_TAIL);
    const d = digest(rows);
    sessions.push({ id: s.sessionId, pid: s.pid, cwd: s.cwd, startedAt: s.startedAt, ...d, more: partial && !d.turnAt, lastAt: Math.round(stat.mtimeMs), ...subagents(file) });
  } catch { /* a transcript vanished mid-read; the next scan sees the truth */ }
}
for (const s of sessions) s.agent = "claude-code";
sessions.push(...opencode(wanted("opencode")), ...codex(wanted("codex")), ...omp(wanted("omp")));
sessions.sort((a, b) => b.lastAt - a.lastAt);
process.stdout.write(JSON.stringify({ sessions }));
