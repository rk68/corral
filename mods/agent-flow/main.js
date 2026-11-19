// A live diagram of how agents work together: one lead, what it delegated, what came back.
// Herdr gives the agents, their `hc run` children and plain terminals; scan.cjs adds each
// agent's model and tools, and the subagents Claude Code and opencode run inside their own
// process. Agents draw as boxes in the flow, plain terminals only as a list under it: they
// run things, they don't take part. There's no real percentage for an agent's work, so bars
// show running or finished, and numbers are counted, never guessed.

import { View, div, image, svg, PathBuilder } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { agents, terminals, panes, spaces, focused, theme, props, run, exec, appHome, closeOverlay, layout, shared } from "herdr";
import * as team from "./examples/team.js";
import * as platform from "./examples/platform.js";
import { SHAPES, choose } from "./shapes.js";

const MOD = "agent-flow";
const FONT = "JetBrains Mono";
const SCAN_MS = 3000;
const WEEK_SCAN_MS = 5 * 60000;
const LOG_ROWS = 40;
const KID_MIN = 128;     // narrowest a box gets before the diagram adds a row
const SHORT = 620;      // below this height the log gives its rows to the diagram
const NARROW = 500;     // below this the flow becomes a list: a side panel is 368 wide
const LINK_MS = 10 * 60000; // how long a message between agents stays drawn
const LINK_LIVE_MS = 90000; // and how long it counts as happening now
const MAX_LANES = 3;
const EXAMPLES = { team: { data: team, name: "billing" }, platform: { data: platform, name: "payments-platform" } };
const VIEWS = { diagram: "Diagram", states: "States", map: "Map", timeline: "Timeline", context: "Context", lanes: "Lanes", cost: "Cost" };
const SPANS = { "15m": 15 * 60000, "30m": 30 * 60000, "60m": 60 * 60000 }; // what the Context and Lanes views show; scan.cjs keeps an hour
const money = (usd) => (usd < 0.005 ? "$0" : usd < 10 ? `$${usd.toFixed(2)}` : usd < 100 ? `$${usd.toFixed(1)}` : `$${Math.round(usd)}`);
const pct = (x) => (x < 0.1 ? "<0.1%" : `${x < 10 ? x.toFixed(1) : Math.round(x)}%`);
const span = (ms) => (ms >= 86400000 ? `${Math.floor(ms / 86400000)}d ${Math.round((ms % 86400000) / 3600000)}h` : ms >= 3600000 ? `${Math.round(ms / 3600000)}h` : `${Math.max(1, Math.round(ms / 60000))}m`);
// Tokens read from cache over all input tokens: low means the agent pays to write it again.
const hitRate = (mins) => { const [r, w, f] = mins.reduce((a, m) => [a[0] + m[1], a[1] + m[2], a[2] + m[3]], [0, 0, 0]); return r + w + f > 20000 ? r / (r + w + f) : null; };
const kindColor = (kind, t) => ({ shell: t.ansi3, read: t.ansi4, edit: t.ansi2, web: t.ansi6, delegate: t.ansi5 })[kind] ?? t.muted;
// The States view: where each agent is in its loop. Thinking is the hub; a tool call goes out
// along a spoke and comes back. Order is clockwise from the top.
const STATES = [
  { id: "needs", label: "needs you", glyph: "◆" },
  { id: "think", label: "thinking", glyph: "◎" },
  { id: "shell", label: "shell", glyph: "$", re: /^(Bash|BashOutput|KillShell|Monitor|exec_command|shell|local_shell|write_stdin)/ },
  { id: "read", label: "read", glyph: "≡", re: /^(Read|Grep|Glob|LS|ToolSearch|Search|NotebookRead|view_image)/ },
  { id: "edit", label: "edit", glyph: "✎", re: /^(Edit|MultiEdit|Write|apply_patch|NotebookEdit)/ },
  { id: "done", label: "done", glyph: "✓" },
  { id: "web", label: "web", glyph: "⇣", re: /^(Web|mcp__.*(browser|chrome))/ },
  { id: "other", label: "other", glyph: "◇" },
  { id: "delegate", label: "delegate", glyph: "⇢", re: /^(Agent|Task|SendMessage|mcp__paseo__(create_agent|send_agent_prompt))/ },
  { id: "wait", label: "waiting", glyph: "⧗" },
];
const stateIcon = (id) => (id === "shell" ? "icons/shell.svg" : `mods/${MOD}/icons/${id}.svg`);
// Extras the settings menu turns on and off, all on by default.
const EXTRAS = { pr: "PR · CI", blocks: "auto-mode blocks", ctx: "context resets", next: "next up" };
const BLOCK_MS = 10 * 60000; // how long an auto-mode denial stays shown
const kindOf = (name) => STATES.find((st) => st.re?.test(name ?? ""))?.id ?? "other";
const SHAPE_NAMES = { auto: "Auto", tree: "Tree", stages: "Stages", radial: "Radial", organic: "Organic" };
const NODE_H = 44;
const SPIN = ["◐", "◓", "◑", "◒"];
const RANK = { blocked: 0, working: 1, done: 2, idle: 3 };
const SCANNED = ["opencode", "codex", "omp"]; // agents whose folder scan.cjs must be told

function modelName(m) {
  const hit = /claude-([a-z]+)-(\d{1,2})(?:-(\d{1,2}))?(?!\d)/.exec(m ?? "");
  if (!hit) return m ?? null;
  return `${hit[1][0].toUpperCase()}${hit[1].slice(1)} ${hit[2]}${hit[3] ? `.${hit[3]}` : ""}`;
}

function tone(model, t, app) {
  if (/opus/.test(model ?? "")) return t.ansi5;
  if (/sonnet/.test(model ?? "")) return t.ansi3;
  if (/haiku/.test(model ?? "")) return t.ansi4;
  if (/fable/.test(model ?? "")) return t.ansi2;
  if (app === "opencode") return t.ansi6;
  if (app === "codex") return t.ansi2;
  return t.accent;
}

const stateColor = (s, t) => ({ working: t.working, blocked: t.blocked, done: t.done, idle: t.idle, stale: t.unknown })[s] ?? t.dim;
const stateWord = (s) => ({ working: "running", blocked: "needs you", done: "done", idle: "idle", stale: "no activity" })[s] ?? s ?? "";

const tokens = (n) => (n >= 1000 ? `${Math.round(n / 1000)}k` : `${n ?? 0}`);
const clock = (ms) => new Date(ms).toTimeString().slice(0, 8);
const count = (n, more) => `${more ? "≥" : ""}${n} tool${n === 1 ? "" : "s"}`;
const GLYPH = [[/^(Bash|exec_command|shell|local_shell)/, "$"], [/^Read/, "≡"], [/^(Edit|MultiEdit|apply_patch|NotebookEdit)/, "✎"],
  [/^Write/, "+"], [/^(Grep|Glob|Search|LS|ToolSearch)/, "⌕"], [/^(Agent|Task)/, "⇢"], [/^Web/, "⇣"], [/^Todo/, "☐"], [/^Skill/, "✦"]];
const glyph = (name) => GLYPH.find(([re]) => re.test(name ?? ""))?.[1] ?? "›";
const toolLine = (x) => (x ? `${x.name}${x.hint ? ` ${x.hint}` : ""}` : "");
const clean = (s) => (s ?? "").replace(/^OC \| /, "").replace(/^[^\p{L}\p{N}]+/u, "").trim();

function elapsed(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

// What the scanner adds about PRs, CI, auto mode, context and questions.
const facts = (s) => ({ pr: s?.pr ?? null, ci: s?.ci ?? null, blocks: s?.blocks ?? [], resets: s?.resets ?? 0, ctxRate: s?.ctxRate ?? 0, ask: s?.ask ?? null });

const norm = (p) => (p ?? "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

function appOf(k) {
  const app = k.report?.app ?? k.program?.key ?? null;
  return app === "claude" ? "claude-code" : app === "pi" ? "omp" : app;
}

const isAgent = (k) => !!(k.report || k.program?.agent);

function icon(p, size, color) {
  if (!p?.icon) return null;
  return p.tint ? svg(p.icon).size(size).flex_none().text_color(color) : image(p.icon).w(size).h(size).flex_none();
}

// Whether a copy in the layout is on screen: copies stay alive hidden, and scanning for a
// closed panel would run node every few seconds for nothing. Not in the layout (an overlay,
// a pane) means it's up.
function has(node) {
  return node?.content?.mod === MOD || (node?.children ?? []).some(has);
}
function showing(node) {
  if (node?.content?.mod === MOD) return true;
  return (node?.children ?? []).some((c) => !c.hidden && (node.type !== "stack" || node.active === c.id) && showing(c));
}
const visible = () => props()?.overlay || panes().some((p) => p.mod === MOD) || !has(layout()) || showing(layout());

// Sessions pair with terminals by process id, else by agent and folder; with several of
// one agent in a folder, the busiest terminal takes the most recently active session.
function pair(list, sessions) {
  const free = [...sessions];
  const found = new Map();
  for (const a of [...list].sort((x, y) => (RANK[x.status] ?? 9) - (RANK[y.status] ?? 9))) {
    // The process id is exact; the folder is the program's own (a shell started in ~ may run
    // the agent elsewhere).
    let i = a.pid ? free.findIndex((s) => s.pid === a.pid) : -1;
    if (i < 0) i = free.findIndex((s) => s.agent === a.app && norm(s.cwd) === norm(a.cwd));
    if (i >= 0) found.set(a.address, free.splice(i, 1)[0]);
  }
  return found;
}

// A turn's subagents, or else the last ones that finished in the past quarter hour.
function visibleSubs(s) {
  if (!s?.subs) return [];
  const turn = s.subs.filter((k) => k.status === "working" || k.lastAt >= s.turnAt);
  return turn.length ? turn : s.subs.filter((k) => Date.now() - k.lastAt < 15 * 60000);
}

// Every agent in the space and subagent in a session, and what passed between them. `to`
// in a send is an address, a terminal name, a subagent id or type, so it resolves here; a
// target that isn't one (another space, a finished terminal) stays in the log only. Agents
// with no transcript show through the tags on what they sent to agents that have one.
function graph(list, sessions, t) {
  const nodes = [];
  for (const a of list) {
    const s = sessions.get(a.address);
    nodes.push({ key: a.address, name: a.name, role: a.label, title: a.title, model: s?.model ?? null, status: a.status, color: tone(s?.model, t, a.app), program: a.program, parent: a.parent, session: s, terminal: a.address, names: [a.address, a.label] });
    for (const k of visibleSubs(s)) {
      nodes.push({ key: k.id, name: k.type, role: k.type, model: k.model, status: k.status, color: tone(k.model, t, a.app), program: a.program, parent: a.address, session: k, names: [k.id, k.type] });
    }
  }
  const find = (to) => nodes.find((n) => n.names.includes(to));
  const events = [];
  for (const n of nodes) {
    const s = n.session;
    for (const m of s?.sends ?? []) {
      const to = find(m.to);
      if (to && to !== n) events.push({ t: m.t, from: n.key, to: to.key, kind: "message" });
    }
    for (const m of s?.recvs ?? []) {
      const from = find(m.from);
      if (from && from !== n && !from.session) events.push({ t: m.t, from: from.key, to: n.key, kind: "message" });
    }
    for (const x of s?.recent ?? []) {
      const sub = find(x.delegate ?? x.hint);
      if (x.delegate && sub) events.push({ t: x.t, from: n.key, to: sub.key, kind: "delegates", label: x.hint });
      if (x.back && sub) events.push({ t: x.t, from: sub.key, to: n.key, kind: "came back" });
    }
  }
  return { nodes, events: events.filter((e) => e.t).sort((x, y) => x.t - y.t) };
}

// Messages lately, one per direction between two agents.
function links(g, now) {
  const found = new Map();
  const node = (key) => g.nodes.find((n) => n.key === key);
  const name = (key) => node(key)?.name ?? key;
  const role = (key) => node(key)?.role ?? name(key);
  for (const e of g.events) {
    if (e.kind !== "message" || now - e.t > LINK_MS) continue;
    const id = `${e.from}>${e.to}`;
    const l = found.get(id) ?? { from: e.from, to: e.to, fromName: name(e.from), toName: name(e.to), fromRole: role(e.from), toRole: role(e.to), n: 0, last: 0 };
    l.n++;
    l.last = Math.max(l.last, e.t);
    found.set(id, l);
  }
  return [...found.values()].sort((x, y) => y.last - x.last);
}

export default class AgentFlow extends View {
  init(_props, cx) {
    this.sample = EXAMPLES[props()?.example] ?? null; // made-up data instead of live agents
    this.pick = this.sample ? "t1" : null; // the chosen lead; null follows focus
    this.space = null;      // the space shown; changing it starts over
    this.lastLead = null;
    this.kid = null;        // the box shown in the side panel; null is the lead
    this.scan = this.sample ? this.sample.data.scan : { sessions: [] };
    this.raw = "";
    this.busy = false;
    this.error = null;
    this.status = {};       // address -> last status, to log changes
    this.events = [];
    this.view = [props()?.view, localStorage.getItem("view")].find((v) => VIEWS[v]) ?? "diagram";
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem("extras") ?? "{}") ?? {}; } catch { /* a bad value starts fresh */ }
    this.extras = Object.fromEntries(Object.keys(EXTRAS).map((k) => [k, saved[k] !== false]));
    this.settings = false;  // the settings row is open
    this.shape = [props()?.shape, localStorage.getItem("shape")].find((v) => SHAPE_NAMES[v]) ?? "auto";
    this.placed = null;     // the Map's last layout; it only moves when the graph does
    this.width = 900;
    this.height = 800;
    this.statesH = 0;
    this.plot = { w: 0, h: 0 }; // the Context and Lanes drawing area, measured
    this.span = [localStorage.getItem("span")].find((v) => SPANS[v]) ?? "30m";
    this.hot = null;      // the agent whose line the pointer is on in the Context view
    this.flowH = 0;       // the diagram's own height, measured, so it can fit without scrolling
    this.week = null;     // this week's spend and weekly limit use, from week.cjs
    this.allChips = false; // the lead row shows every lead, not one line
    if (this.sample) return;
    this.refresh(cx);
    cx.timer.every(SCAN_MS, (cx) => this.refresh(cx));
    this.weekly(cx);
    cx.timer.every(WEEK_SCAN_MS, (cx) => this.weekly(cx));
  }

  now() {
    return this.sample ? this.sample.data.now : Date.now();
  }

  refresh(cx) {
    if (this.busy || !visible()) return;
    const list = this.world().agents;
    const asks = list.filter((a) => SCANNED.includes(a.app)).map((a) => `${a.app}=${a.cwd}`);
    if (!asks.length && !list.some((a) => a.app === "claude-code")) {
      if (this.scan.sessions.length) { this.scan = { sessions: [] }; this.raw = ""; cx.notify(); }
      return;
    }
    this.busy = true;
    cx.spawn(async (cx) => {
      try {
        const r = await exec("node", ["--no-warnings", `${appHome()}/mods/${MOD}/scan.cjs`, ...asks]);
        const error = r.code ? r.stderr.trim().split("\n").pop() : null;
        if (!r.code && r.stdout !== this.raw) {
          this.raw = r.stdout;
          this.scan = JSON.parse(r.stdout);
          cx.notify();
        }
        if (error !== this.error) { this.error = error; cx.notify(); }
      } catch (e) {
        this.error = String(e?.message ?? e);
        cx.notify();
      }
      this.busy = false;
    });
  }

  weekly(cx) {
    cx.spawn(async (cx) => {
      try {
        const r = await exec("node", ["--no-warnings", `${appHome()}/mods/${MOD}/week.cjs`], { timeout: 120000 });
        const w = r.code ? null : JSON.parse(r.stdout);
        this.week = w?.cost > 0 && w.pct > 0 ? w : null;
        cx.notify();
      } catch { /* without it, Lanes shows dollars only */ }
    });
  }

  // An agent's dollars as a share of the weekly limit: this week's spend on this machine is
  // taken to be what moved the meter, so it over-counts when claude.ai or another machine
  // also used the limit.
  weekShare(usd) {
    if (!this.week || usd < 0.005) return "";
    const pct = (usd * this.week.pct) / this.week.cost;
    return pct < 0.1 ? "<0.1%" : `${pct.toFixed(1)}%`;
  }

  // Every live terminal as one shape, split into agents and plain terminals.
  world() {
    const raw = (this.sample ? this.sample.data.terminals : terminals()).filter((k) => k.state === "live");
    const listed = new Map((this.sample ? [] : agents()).map((a) => [a.address, a]));
    const all = raw.map((k) => {
      const seen = listed.get(k.address);
      const word = seen?.status ?? k.status;
      return {
        address: k.address, parent: k.parent ?? null, cwd: k.foreground?.cwd ?? k.cwd ?? null, pid: k.foreground?.pid ?? null, app: appOf(k), program: k.program,
        status: word === "error" ? "blocked" : word, label: k.name ?? null, seq: seen?.seq ?? 0,
        // agent-flow.space: a background agent with no pane names the space it works for.
        space: seen?.space ?? k.labels?.["herdr.space"] ?? k.labels?.["agent-flow.space"] ?? null,
        name: k.program?.name ?? k.report?.app ?? k.address,
        title: clean(k.report?.title) || clean(seen?.title) || clean(k.title),
      };
    });
    // A sub-agent without a pane may carry no space: it lives in its parent's.
    const byAddress = new Map(all.map((k) => [k.address, k]));
    for (const k of all) k.space ??= byAddress.get(k.parent)?.space ?? null;
    const flags = new Map(raw.map((k) => [k.address, isAgent(k)]));
    return { agents: all.filter((k) => flags.get(k.address)), plain: all.filter((k) => !flags.get(k.address)) };
  }

  chosen(leads, list) {
    const f = this.sample ? null : focused()?.terminal;
    const asked = list.find((a) => a.address === (this.pick ?? f));
    const top = asked?.parent && leads.find((a) => a.address === asked.parent);
    const lead = top ?? leads.find((a) => a.address === asked?.address) ?? leads.find((a) => a.address === this.lastLead) ?? leads[0] ?? null;
    this.lastLead = lead?.address ?? null;
    return lead;
  }

  // Agents it started and subagents inside its process, as one list of boxes.
  kids(lead, list, sessions, t) {
    const inner = visibleSubs(sessions.get(lead.address)).map((k) => ({
      id: k.id, title: k.type, agent: lead.name, sub: k.description, status: k.status, model: k.model, ...facts(k),
      tools: k.tools, more: k.more, ctx: k.ctx, now: k.now, recent: k.recent, color: tone(k.model, t, lead.app),
      startedAt: k.startedAt, lastAt: k.lastAt, program: lead.program, nested: [],
    }));
    const started = list.filter((k) => k.parent === lead.address).map((k) => {
      const s = sessions.get(k.address);
      // A second tier: what this agent delegated in turn.
      const nested = [
        ...list.filter((g) => g.parent === k.address).map((g) => {
          const gs = sessions.get(g.address);
          return { id: g.address, address: g.address, name: g.label ?? g.name, model: gs?.model ?? null, status: g.status, color: tone(gs?.model, t, g.app) };
        }),
        ...visibleSubs(s).map((g) => ({ id: g.id, name: g.type, model: g.model, status: g.status, color: tone(g.model, t, k.app) })),
      ];
      return {
        id: k.address, address: k.address, title: k.label ?? k.name, label: k.label, agent: k.name, sub: k.title, status: k.status,
        model: s?.model ?? null, tools: s?.tools ?? null, ctx: s?.ctx ?? 0, now: s?.now, recent: s?.recent ?? [],
        color: tone(s?.model, t, k.app), lastAt: s?.lastAt, program: k.program, nested, ...facts(s),
      };
    });
    return [...started, ...inner].sort((a, b) => (RANK[a.status] ?? 2) - (RANK[b.status] ?? 2) || (b.startedAt ?? 0) - (a.startedAt ?? 0));
  }

  track(list) {
    for (const a of list) {
      const was = this.status[a.address];
      if (was && was !== a.status) {
        this.events.push({ t: Date.now(), address: a.address, who: a.name, text: `${a.address} ${was} → ${a.status}`, status: a.status });
        this.events = this.events.slice(-LOG_ROWS);
      }
      this.status[a.address] = a.status;
    }
  }

  logRows(lead, session, kids, list, t) {
    const who = modelName(session?.model) ?? lead.name;
    const color = tone(session?.model, t, lead.app);
    const named = (to) => (to === lead.address ? lead.name : kids.find((k) => [k.address, k.label, k.id, k.title].includes(to))?.agent) ?? to;
    const said = (x) => (x.to ? `messages ${named(x.to)}` : toolLine(x));
    const here = new Set(list.map((a) => a.address));
    const rows = this.events.filter((e) => here.has(e.address)).map((e) => ({ t: e.t, who: e.who, text: e.text, color: stateColor(e.status, t) }));
    for (const x of session?.recent ?? []) {
      rows.push({ t: x.t, who, color, text: x.delegate ? `delegates to ${x.delegate} · ${x.hint}` : x.back ? `${x.hint} came back` : said(x) });
    }
    for (const k of session?.subs ?? []) {
      for (const x of k.recent ?? []) rows.push({ t: x.t, who: k.type, color: tone(k.model, t, lead.app), text: said(x) });
    }
    for (const k of kids) {
      if (k.address) for (const x of k.recent ?? []) rows.push({ t: x.t, who: k.agent, color: k.color, text: said(x) });
    }
    return rows.filter((r) => r.t).sort((a, b) => a.t - b.t).slice(-LOG_ROWS);
  }

  /* ------- pieces ------- */

  button(id, label, t, fn) {
    return div().id(id).px(6).rounded(3).text_color(t.muted).cursor_pointer()
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_click((_e, cx) => { fn(cx); cx.notify(); }).child(label);
  }

  dot(color, live) {
    return div().w(7).h(7).rounded(4).flex_none().bg(color).when(live, (e) => e.loop("opacity", { from: 0.35, to: 1, period: 1200 }));
  }

  mark(status, t) {
    const el = div().text_color(stateColor(status, t)).flex_none();
    return status === "working" ? el.frames(SPIN, 160) : el.child(status === "done" ? "●" : status === "blocked" ? "◆" : "○");
  }

  // Running slides, because nothing knows how far along it is; finished is full.
  bar(status, color, t, width) {
    const track = div().w_full().h(6).flex_none().rounded(2).bg(t.raised).overflow_hidden().relative();
    if (status === "working") return track.child(div().absolute().top(0).w(56).h(6).rounded(2).bg(color).loop("left", { from: -56, to: width, period: 1800 }));
    if (status === "done") return track.child(div().size_full().bg(color));
    if (status === "blocked") return track.child(div().size_full().bg(color).loop("opacity", { from: 0.4, to: 1, period: 900 }));
    return track;
  }

  // Lines joining one point to n boxes (or, with `up`, n boxes back to one point). Dots run
  // along the lines of what's live.
  fan(kids, t, up, h = 20) {
    const clear = "#00000000";
    const mid = (kids.length - 1) / 2;
    // A live box's path runs along the bar from the middle to it: the color of the first
    // one whose path covers this piece, in cell positions.
    const along = (from, to) => kids.find((k, i) => k.status === "working" && Math.min(i, mid) <= from && to <= Math.max(i, mid))?.color ?? t.border;
    return h_flex().w_full().h(h).flex_none().children(kids.map((k, i) => {
      const half = (show, from, to) => div().flex_1().h_full().flex().flex_col().when(up, (e) => e.justify_end())
        .child(div().w_full().h(1).bg(show ? along(from, to) : clear));
      const live = k.status === "working";
      const stem = div().w(1).h_full().bg(live ? k.color : t.border).relative()
        .when(live, (e) => e.child(div().absolute().left(-2).w(5).h(5).rounded(3).bg(k.color)
          .loop("top", { from: 0, to: h - 6, period: 1500 + i * 170, easing: "linear" })));
      return h_flex().flex_1().h_full().child(half(i > 0, i - 0.5, i)).child(stem).child(half(i < kids.length - 1, i, i + 0.5));
    }));
  }

  // Messages between siblings: a line of its own under the boxes, an arrow at the receiver,
  // a dot running while it's happening.
  peerLanes(shown, list, t, room, bg) {
    const cell = room / shown.length;
    const x = (id) => (shown.findIndex((k) => k.id === id) + 0.5) * cell;
    const now = this.now();
    return v_flex().w_full().flex_none().children(list.slice(0, MAX_LANES).map((l, i) => {
      const a = Math.round(x(l.from));
      const b = Math.round(x(l.to));
      const left = Math.min(a, b);
      const right = Math.max(a, b);
      const live = now - l.last < LINK_LIVE_MS;
      const color = live ? shown.find((k) => k.id === l.from).color : t.dim;
      const tick = (at) => div().absolute().top(0).left(at).w(1).h(8).bg(color);
      return div().id(`lane-${i}`).relative().w_full().h(18).flex_none()
        .child(tick(left)).child(tick(right))
        .child(div().absolute().top(8).left(left).w(right - left).h(1).bg(color))
        .when(live, (e) => e.child(div().absolute().top(6).w(5).h(5).rounded(3).bg(color).loop("left", { from: left, to: right, period: 1600, easing: "linear" })))
        .child(div().absolute().top(2).left(b - 4).text_size(9).text_color(color).child(b > a ? "▶" : "◀"))
        .child(h_flex().absolute().top(0).left(left).w(right - left).h(16).justify_center().items_center()
          .child(div().px(5).bg(bg).max_w(right - left - 20).truncate().text_size(11).text_color(live ? t.foreground : t.muted)
            .child(`${l.fromName} → ${l.toName}${l.n > 1 ? ` ×${l.n}` : ""}`)));
    }));
  }

  // What a box delegated in turn, as rows inside it.
  nested(k, t) {
    return (k.nested ?? []).slice(0, 3).map((n) => h_flex().id(`nested-${n.id}`).w_full().gap(5).items_center()
      .when(!!n.address, (e) => e.cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => { cx.stop_propagation(); this.peek(n.address); }))
      .child(div().flex_none().text_color(t.dim).child("└"))
      .child(this.mark(n.status, t))
      .child(div().flex_1().min_w(0).truncate().text_color(n.color).child(`${n.name}${n.model ? ` · ${modelName(n.model)}` : ""}`)))
      .concat((k.nested?.length ?? 0) > 3 ? [div().pl(14).text_color(t.dim).child(`+${k.nested.length - 3} more`)] : []);
  }

  // Messages with the lead, on the box: sent up and received.
  talk(k, flows, lead) {
    const up = flows.find((l) => l.from === k.id && l.to === lead)?.n ?? 0;
    const down = flows.find((l) => l.from === lead && l.to === k.id)?.n ?? 0;
    return [up ? `↑${up}` : "", down ? `↓${down}` : ""].filter(Boolean).join(" ");
  }

  stem(color, h = 14) {
    return div().w(1).h(h).bg(color).flex_none();
  }

  // The two lines every agent gets: which agent, and which model.
  who(name, model, program, color, t) {
    return v_flex().items_center().gap(1).w_full()
      .child(h_flex().gap(6).items_center().max_w_full()
        .child(icon(program, 14, color) ?? div())
        .child(div().truncate().font_semibold().text_color(t.foreground).child(name)))
      .child(div().w_full().text_center().truncate().text_color(model ? color : t.dim).child(modelName(model) ?? "model unknown"));
  }

  leadBox(lead, session, t, full) {
    const color = tone(session?.model, t, lead.app);
    const tools = session?.tools;
    return v_flex().id("lead").when(full, (e) => e.w_full()).when(!full, (e) => e.w(300).max_w_full()).p(9).gap(3).items_center().flex_none().bg(t.background)
      .border(this.kid === null ? 2 : 1).border_color(color).cursor_pointer()
      .on_click((_e, cx) => { this.kid = null; cx.notify(); })
      .child(this.who(lead.name, session?.model, lead.program, color, t))
      .child(div().w_full().text_center().truncate().text_color(t.foreground).child(lead.title || lead.address))
      .child(h_flex().gap(6).max_w_full().items_center().text_color(t.muted)
        .child(this.mark(lead.status, t))
        .child(div().truncate().child(session?.now ? toolLine(session.now) : stateWord(lead.status))))
      .when(tools != null, (e) => e.child(h_flex().gap(10).text_color(t.dim)
        .child(`${count(tools, session.more)} this turn`)
        .when(session.ctx > 0, (x) => x.child(`ctx ${tokens(session.ctx)}`))));
  }

  backBox(lead, session, kids, t, full) {
    const open = kids.filter((k) => k.status === "working").length;
    const color = tone(session?.model, t, lead.app);
    return v_flex().when(full, (e) => e.w_full()).when(!full, (e) => e.w(300).max_w_full()).p(7).items_center().flex_none().bg(t.background)
      .border(1).border_color(open ? t.border : color)
      .child(div().text_color(open ? t.muted : color).font_semibold().child(`back to ${lead.name}`))
      .child(div().text_color(t.dim).child(open ? `waiting on ${open} of ${kids.length}` : `${kids.length} of ${kids.length} back`));
  }

  // Tools of the box that's open, in narrow views, where there's no side panel to show them.
  details(k, t) {
    return v_flex().gap(1).pt(2).children([
      ...(k.sub ? [div().text_color(t.muted).child(k.sub)] : []),
      ...(k.recent ?? []).slice(-5).map((x) => div().truncate().text_color(t.foreground).child(`» ${toolLine(x)}`)),
      ...(k.address ? [this.button(`peek-${k.id}`, "peek terminal", t, () => this.peek(k.address))] : []),
    ]);
  }

  // The rail down the left edge carries a live box's color from the lead to that box.
  listRow(k, t, rail, flows) {
    const open = this.kid === k.id;
    const name = k.address ? k.agent : `${k.agent} · ${k.title}`;
    return h_flex().w_full().items_stretch().child(div().w(1).flex_none().bg(rail))
      .child(div().w(13).h(1).mt(16).flex_none().bg(k.status === "working" ? k.color : t.border))
      .child(v_flex().id(`kid-${k.id}`).flex_1().min_w(0).mb(6).p(7).gap(3).bg(t.background)
        .border(open ? 2 : 1).border_color(k.status === "stale" ? t.border : k.color).cursor_pointer().hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => { this.kid = open ? null : k.id; cx.notify(); })
        .child(h_flex().gap(6).items_center().min_w(0)
          .child(this.mark(k.status, t))
          .child(icon(k.program, 13, k.color) ?? div())
          .child(div().flex_1().min_w(0).truncate().font_semibold().child(name))
          .when(k.tools != null, (e) => e.child(div().flex_none().text_color(t.dim).child(count(k.tools, k.more)))))
        .child(div().truncate().text_color(k.model ? k.color : t.dim).child(modelName(k.model) ?? "model unknown"))
        .child(this.bar(k.status, k.color, t, this.width))
        .child(div().truncate().text_color(t.muted).child(k.now ? toolLine(k.now) : k.sub || stateWord(k.status)))
        .when(!!this.talk(k, flows, this.lastLead), (e) => e.child(div().text_color(t.foreground).child(this.talk(k, flows, this.lastLead))))
        .children(this.nested(k, t))
        .when(open, (e) => e.child(this.details(k, t))));
  }

  // Not agents: what the lead started to run. Flat chips under the flow, never part of it.
  plainList(list, t) {
    return h_flex().w_full().flex_none().flex_wrap().gap(6).items_center()
      .child(div().flex_none().text_color(t.dim).child("terminals"))
      .children(list.map((k) => h_flex().id(`term-${k.address}`).gap(5).px(5).items_center().rounded(3).cursor_pointer()
        .hover((s) => s.bg(t.hover)).on_click(() => this.peek(k.address))
        .child(div().flex_none().text_color(t.dim).child("›_"))
        .child(div().max_w(150).truncate().text_color(t.muted).child(k.label ?? k.name))));
  }

  // A sequence diagram of the whole space: a column per agent, a row per thing that passed
  // between two of them, oldest on top. Flows that never touch the chosen lead show too.
  timeline(lead, g, t, room, bg) {
    const gutter = room >= 560 ? 64 : 0;
    const active = new Set(g.events.flatMap((e) => [e.from, e.to]));
    const cols = [...g.nodes].sort((a, b) => (b.key === lead.address) - (a.key === lead.address) || active.has(b.key) - active.has(a.key))
      .slice(0, Math.max(2, Math.floor((room - gutter) / 92)));
    const cell = (room - gutter) / cols.length;
    const x = (key) => Math.round(gutter + (cols.findIndex((c) => c.key === key) + 0.5) * cell);
    const shown = new Set(cols.map((c) => c.key));
    const rows = g.events.filter((e) => shown.has(e.from) && shown.has(e.to)).slice(-Math.max(4, Math.floor((this.height - 330) / 24)));
    const now = this.now();
    const lifelines = () => cols.map((c) => div().absolute().top(0).left(x(c.key)).w(1).h_full().bg(t.border));
    const header = div().relative().w_full().h(40).flex_none().children(cols.map((c, i) =>
      v_flex().absolute().top(0).left(Math.round(gutter + i * cell)).w(Math.floor(cell)).px(3).items_center()
        .child(h_flex().gap(4).max_w_full().items_center().child(icon(c.program, 12, c.color) ?? div())
          .child(div().truncate().font_semibold().child(c.role ?? c.name)))
        .child(div().max_w_full().truncate().text_color(c.model ? c.color : t.dim).child(modelName(c.model) ?? "model unknown"))));
    const line = (e, i) => {
      const a = x(e.from);
      const b = x(e.to);
      const left = Math.min(a, b);
      const width = Math.max(a, b) - left;
      const color = e.kind === "came back" ? t.dim : g.nodes.find((n) => n.key === e.from).color;
      const live = now - e.t < LINK_LIVE_MS;
      return div().id(`row-${i}`).relative().w_full().h(24).flex_none().children(lifelines())
        .when(gutter > 0, (r) => r.child(div().absolute().top(4).left(0).text_color(t.dim).child(clock(e.t))))
        .child(div().absolute().top(12).left(left).w(width).h(1).bg(color))
        .when(live, (r) => r.child(div().absolute().top(10).w(5).h(5).rounded(3).bg(color).loop("left", { from: left, to: left + width, period: 1600, easing: "linear" })))
        .child(div().absolute().top(6).left(b - 4).text_size(9).text_color(color).child(b > a ? "▶" : "◀"))
        .child(h_flex().absolute().top(3).left(left).w(width).justify_center()
          .child(div().px(5).bg(bg).max_w(Math.max(30, width - 20)).truncate().text_size(11).text_color(t.muted).child(e.label ?? e.kind)));
    };
    const flow = v_flex().id("flow").flex_1().min_w(0).h_full().overflow_y_scroll().child(header);
    if (!rows.length) return flow.child(v_flex().w_full().pt(20).items_center().text_color(t.dim).child("Nothing has passed between agents yet"));
    return flow.child(div().relative().w_full().h(8).flex_none().children(lifelines())).children(rows.map(line));
  }

  // Every agent at any depth, placed by the shape of the work rather than in rows: Auto
  // picks from who talks to whom, so the arrangement changes as the work does.
  map(lead, g, t, room, h) {
    const now = this.now();
    const flows = links(g, now);
    const byKey = new Map(g.nodes.map((n) => [n.key, n]));
    const family = (l) => byKey.get(l.to)?.parent === l.from || byKey.get(l.from)?.parent === l.to;
    const routes = flows.filter((l) => !family(l));
    const shape = this.shape === "auto" ? choose(g.nodes, routes) : this.shape;
    const wide = room >= 700 ? 168 : room >= 480 ? 136 : 112;
    const sig = [shape, Math.round(room), Math.round(h), lead.address, ...g.nodes.map((n) => `${n.key}<${n.parent}`), ...routes.map((l) => `${l.from}>${l.to}`).sort()].join("|");
    if (this.placed?.sig !== sig) {
      this.placed = { sig, ...SHAPES[shape](g.nodes, routes, { lead: lead.address, room, W: wide, H: NODE_H, height: h }) };
    }
    const { pos, height, marks: columns = [], W = wide } = this.placed;

    // A curve leaves from the side facing the other node, so lines cross as little as they can.
    const anchor = (a, b, sideways) => {
      const ax = a.x + W / 2; const ay = a.y + NODE_H / 2;
      const bx = b.x + W / 2; const by = b.y + NODE_H / 2;
      if (sideways || Math.abs(bx - ax) / W >= Math.abs(by - ay) / NODE_H) {
        const s = bx > ax ? 1 : -1;
        return { x1: ax + s * W / 2, y1: ay, x2: bx - s * W / 2, y2: by, dx: s, dy: 0 };
      }
      const s = by > ay ? 1 : -1;
      return { x1: ax, y1: ay + s * NODE_H / 2, x2: bx, y2: by - s * NODE_H / 2, dx: 0, dy: s };
    };
    const curve = (e, a) => {
      const reach = Math.max(24, (Math.abs(a.x2 - a.x1) + Math.abs(a.y2 - a.y1)) / 2.4);
      return e.move_to(a.x1, a.y1).cubic_bezier_to(a.x2, a.y2, a.x1 + a.dx * reach, a.y1 + a.dy * reach, a.x2 - a.dx * reach, a.y2 - a.dy * reach);
    };
    const paint = (path, color) => window.paint_path(path.build(), color).absolute().top(0).left(0).size_full();
    const paths = new Map();
    const stroke = (color, width, dash) => {
      const id = `${color}/${width}/${dash}`;
      if (!paths.has(id)) paths.set(id, { color, path: dash ? PathBuilder.stroke(width).dash_array([4, 4]) : PathBuilder.stroke(width) });
      return paths.get(id);
    };
    for (const n of g.nodes) {
      if (!pos.has(n.key) || !pos.has(n.parent)) continue;
      const line = stroke(n.status === "working" ? n.color : t.border, 1, false);
      line.path = curve(line.path, anchor(pos.get(n.parent), pos.get(n.key), shape === "tree" || shape === "stages"));
    }
    const marks = [];
    for (const l of routes) {
      const a = pos.get(l.from);
      const b = pos.get(l.to);
      if (!a || !b) continue;
      const live = now - l.last < LINK_LIVE_MS;
      const color = live ? byKey.get(l.from).color : t.dim;
      const line = stroke(color, live ? 1.5 : 1, !live);
      const at = anchor(a, b);
      line.path = curve(line.path, at);
      const head = PathBuilder.fill().add_polygon([[at.x2, at.y2], [at.x2 - at.dx * 7 - at.dy * 3.5, at.y2 - at.dy * 7 - at.dx * 3.5], [at.x2 - at.dx * 7 + at.dy * 3.5, at.y2 - at.dy * 7 + at.dx * 3.5]], true);
      marks.push(paint(head, color));
      if (live) marks.push(div().absolute().left(at.x2 - 3).top(at.y2 - 3).w(6).h(6).rounded(3).bg(color).loop("opacity", { from: 0.2, to: 1, period: 1100 }));
    }

    const up = (key) => flows.filter((l) => l.from === key && byKey.get(key)?.parent === l.to).reduce((n, l) => n + l.n, 0);
    const nodes = g.nodes.filter((n) => pos.has(n.key)).map((n) => {
      const p = pos.get(n.key);
      const quiet = n.status === "idle" || n.status === "stale";
      return v_flex().id(`node-${n.key}`).absolute().left(Math.round(p.x)).top(Math.round(p.y)).w(W).h(NODE_H).px(6).justify_center().bg(t.background)
        .transition("left", { duration: 450 }).transition("top", { duration: 450 })
        .border(!n.parent || !byKey.has(n.parent) ? 2 : 1).border_color(quiet ? t.border : n.status === "blocked" ? t.blocked : n.color)
        .when(!!n.terminal, (e) => e.cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => {
          if (!n.parent || !byKey.has(n.parent)) { this.pick = n.key; this.kid = null; cx.notify(); } else this.peek(n.terminal);
        }))
        .child(h_flex().gap(4).items_center().min_w(0)
          .child(this.mark(n.status, t))
          .child(icon(n.program, 11, n.color) ?? div())
          .child(div().flex_1().min_w(0).truncate().font_semibold().child(n.role ?? n.name))
          .when(up(n.key) > 0, (e) => e.child(div().flex_none().text_color(t.muted).child(`↑${up(n.key)}`))))
        .child(div().truncate().text_size(11).text_color(n.model ? n.color : t.dim).child(modelName(n.model) ?? n.name));
    });

    const labels = columns.map((c) => div().absolute().top(0).left(c.x).text_size(11).text_color(t.dim).child(c.text));
    const running = g.nodes.filter((n) => n.status === "working").length;
    const pickShape = ([id, label]) => div().id(`shape-${id}`).px(5).rounded(3).cursor_pointer()
      .bg(this.shape === id ? t.selected : "#00000000").text_color(this.shape === id ? t.foreground : t.muted)
      .hover((e) => e.bg(t.hover)).on_click((_e, cx) => { this.shape = id; localStorage.setItem("shape", id); cx.notify(); })
      .child(id === "auto" && this.shape === "auto" ? `Auto: ${SHAPE_NAMES[shape]}` : label);
    return v_flex().id("flow").flex_1().min_w(0).h_full().gap(6).overflow_y_scroll()
      .child(h_flex().flex_none().flex_wrap().justify_between().gap(8)
        .child(h_flex().flex_none().gap(12).text_color(t.dim)
          .child(`${g.nodes.length} agents`).child(`${running} running`).child(`${routes.length} direct route${routes.length === 1 ? "" : "s"}`))
        .child(h_flex().flex_none().gap(2).children(Object.entries(SHAPE_NAMES).map(pickShape))))
      .child(div().relative().w_full().h(Math.max(height, h)).flex_none()
        .children([...paths.values()].map((e) => paint(e.path, e.color))).children(labels).children(marks).children(nodes))
      .when(routes.length > 0, (e) => e.child(h_flex().flex_none().flex_wrap().gap(10).pt(2).children(routes.slice(0, 7).map((l) =>
        div().flex_none().text_color(now - l.last < LINK_LIVE_MS ? t.foreground : t.dim).child(`⇄ ${l.fromRole} → ${l.toRole}${l.n > 1 ? ` ×${l.n}` : ""}`)))));
  }

  flow(lead, session, kids, g, t, room, bg) {
    const narrow = room < NARROW;
    const flows = links(g, this.now());
    if (!narrow) return this.compact(lead, session, kids, flows, t, room, bg);
    const flow = v_flex().id("flow").flex_1().min_w(0).h_full().items_center().overflow_y_scroll().child(this.leadBox(lead, session, t, narrow));
    if (!kids.length) return flow.child(this.stem(t.border, 16)).child(div().text_color(t.dim).pb(4).child("no agents delegated"));
      const railAt = (i) => kids.slice(i).find((k) => k.status === "working")?.color ?? t.border;
      return flow.child(h_flex().w_full().child(this.stem(railAt(0), 10)))
        .child(v_flex().w_full().children(kids.map((k, i) => this.listRow(k, t, railAt(i), flows))))
        .child(v_flex().w_full().flex_none().children(flows.filter((l) => l.from !== lead.address && l.to !== lead.address && kids.some((k) => k.id === l.from || k.id === l.to)).slice(0, MAX_LANES).map((l) =>
          div().pl(14).truncate().text_color(t.muted).child(`⇄ ${l.fromName} → ${l.toName}${l.n > 1 ? ` ×${l.n}` : ""}`))))
        .child(h_flex().w_full().child(this.stem(t.border, 4)))
        .child(this.backBox(lead, session, kids, t, true));
  }

  // A blinking block cursor: the terminal's sign that something is being typed right now.
  cursor(color) {
    return div().flex_none().text_color(color).child("▌").loop("opacity", { from: 0, to: 1, period: 1000 });
  }

  // What an agent is doing, as one terminal line: the tool's glyph, the call, a cursor while live.
  activity(k, t) {
    const line = h_flex().w_full().min_w(0).gap(5).items_center();
    if (k.status === "blocked") return line.child(div().truncate().text_color(t.blocked).child("◆ needs you").loop("opacity", { from: 0.35, to: 1, period: 900 }));
    const denied = this.blocked(k);
    if (denied && (k.status !== "working" || this.now() - denied.t < 90000)) {
      return line.child(div().flex_none().text_color(t.working).child("⊘").loop("opacity", { from: 0.3, to: 1, period: 700 }))
        .child(div().min_w(0).truncate().text_color(t.working).child(`auto mode: ${denied.reason}${denied.hint ? ` · ${denied.hint}` : ""}`));
    }
    if (this.extras.next && k.ask && k.status !== "working") {
      return line.child(div().flex_none().text_color(t.working).child("?")).child(div().min_w(0).truncate().text_color(t.foreground).child(k.ask));
    }
    if (k.status === "working" && k.now) {
      return line.child(div().flex_none().text_color(k.color).child(glyph(k.now.name)))
        .child(div().min_w(0).truncate().text_color(t.foreground).child(toolLine(k.now))).child(this.cursor(k.color));
    }
    if (k.status === "working") return line.child(div().min_w(0).truncate().text_color(t.muted).child(k.sub || "thinking")).child(this.cursor(k.color));
    const fresh = k.status === "done" && k.lastAt && this.now() - k.lastAt < 20000;
    const tail = [k.tools != null ? count(k.tools, k.more) : "", k.sub ?? ""].filter(Boolean).join(" · ");
    return line.child(div().flex_none().text_color(stateColor(k.status, t)).child(k.status === "done" ? "✓" : "·")
      .when(!!fresh, (e) => e.loop("opacity", { from: 0.2, to: 1, period: 500 })))
      .child(div().min_w(0).truncate().text_color(t.dim).child(tail || stateWord(k.status)));
  }

  // A thin scanning line under a live card; full under a finished one.
  scanLine(k, t) {
    const track = div().w_full().h(2).flex_none().bg(t.raised).overflow_hidden().relative();
    if (k.status === "working") return track.child(div().absolute().top(0).w(40).h(2).bg(k.color).loop("left", { from: -40, to: 400, period: 1700 }));
    if (k.status === "done") return track.child(div().size_full().bg(k.color));
    return track;
  }

  // The lead as a two-line header: who and on what, then what it's running now.
  leadLine(lead, session, t) {
    const color = tone(session?.model, t, lead.app);
    const me = { ...session, ...facts(session), status: lead.status, color, sub: null, now: session?.now };
    const note = this.ctxNote(session);
    return v_flex().id("lead").w_full().flex_none().px(8).py(5).gap(2).bg(t.background)
      .border(this.kid === null ? 2 : 1).border_color(color).cursor_pointer()
      .on_click((_e, cx) => { this.kid = null; cx.notify(); })
      .child(h_flex().w_full().min_w(0).gap(6).items_center()
        .child(this.mark(lead.status, t)).child(icon(lead.program, 13, color) ?? div())
        .child(div().flex_none().font_semibold().child(lead.name))
        .child(div().flex_none().text_color(session?.model ? color : t.dim).child(modelName(session?.model) ?? "model unknown"))
        .child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(lead.title || lead.address))
        .child(this.prChip(session, t) ?? div())
        .when(session?.tools != null, (e) => e.child(div().flex_none().text_color(t.dim)
          .child(`${count(session.tools, session.more)}${session.ctx ? ` · ctx ${tokens(session.ctx)}` : ""}${note ? ` · ${note}` : ""}`))))
      .child(h_flex().w_full().min_w(0).pl(19).child(this.activity(me, t)));
  }

  // One agent the lead started or a subagent inside it. `dense` packs it into one line.
  card(k, t, flows, dense, nest) {
    const quiet = k.status === "stale";
    const name = k.address ? k.agent : k.title;
    const talk = this.talk(k, flows, this.lastLead);
    const box = v_flex().id(`kid-${k.id}`).w_full().min_w(0).bg(t.background)
      .border(this.kid === k.id ? 2 : 1).border_color(quiet ? t.border : k.status === "blocked" ? t.blocked : k.color)
      .cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => { this.kid = this.kid === k.id ? null : k.id; cx.notify(); });
    const head = h_flex().w_full().min_w(0).gap(5).items_center()
      .child(this.mark(k.status, t)).child(icon(k.program, 12, k.color) ?? div())
      .child(div().flex_1().min_w(0).truncate().font_semibold().child(k.address ? (k.label || k.title || name) : name))
      .child(this.prChip(k, t) ?? div())
      .child(div().min_w(0).max_w(130).truncate().text_color(k.model ? k.color : t.dim).child(modelName(k.model) ?? "?"));
    if (dense) return box.px(6).py(2).gap(1).child(head).child(this.scanLine(k, t));
    const more = (k.nested?.length ?? 0) - nest;
    const doing = h_flex().w_full().min_w(0).gap(6).items_center().child(div().flex_1().min_w(0).child(this.activity(k, t)))
      .when(!!talk, (e) => e.child(div().flex_none().text_color(t.foreground).child(talk)))
      .when(more > 0, (e) => e.child(div().flex_none().text_color(t.dim).child(`+${more} more`)));
    return box.px(7).pt(4).pb(3).gap(2).child(head).child(doing)
      .children((k.nested ?? []).slice(0, nest).map((n) => h_flex().id(`nested-${n.id}`).w_full().min_w(0).gap(5).items_center()
        .when(!!n.address, (e) => e.cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => { cx.stop_propagation(); this.peek(n.address); }))
        .child(div().flex_none().text_color(t.dim).child("└")).child(this.mark(n.status, t))
        .child(div().flex_1().min_w(0).truncate().text_color(n.color).child(`${n.name}${n.model ? ` · ${modelName(n.model)}` : ""}`))))
      .child(this.scanLine(k, t));
  }

  // The flow fitted to the room it has: cards wrap into rows, and when even three-line cards
  // would overflow, they drop to one line each. Nothing here scrolls.
  compact(lead, session, kids, flows, t, room, bg) {
    const area = v_flex().id("flow").flex_1().min_w(0).h_full().overflow_hidden()
      .on_size_change((size, cx) => { if (Math.abs(size.height - this.flowH) > 1) { this.flowH = size.height; cx.notify(); } })
      .child(this.leadLine(lead, session, t));
    if (!kids.length) return area.child(h_flex().w_full().pl(12).child(this.stem(t.border, 10))).child(div().pl(8).text_color(t.dim).child("no agents delegated"));
    const avail = (this.flowH || this.height - 260) - 46 - 8 - 10 - 10 - 4 - 24; // header, stems, fans, the back line
    const layout = (min, most = Infinity) => {
      const fit = Math.max(1, Math.floor(room / min), Math.ceil(kids.length / most));
      const per = Math.ceil(kids.length / Math.ceil(kids.length / fit));
      const rows = [];
      for (let i = 0; i < kids.length; i += per) rows.push(kids.slice(i, i + per));
      return rows;
    };
    const most = Math.min(2, Math.max(0, ...kids.map((k) => k.nested?.length ?? 0)));
    const tall = (rows, nest) => rows.length * (48 + nest * 16 + 6);
    let rows = layout(KID_MIN);
    let nest = most;
    while (nest > 0 && tall(rows, nest) > avail) nest--;
    const dense = tall(rows, 0) > avail;
    if (dense) rows = layout(104, Math.max(1, Math.floor(avail / 25))); // one-line rows: as many as the height holds
    const trunk = kids.find((k) => k.status === "working")?.color ?? t.border;
    const row = (shown, r) => {
      const ids = new Set(shown.map((k) => k.id));
      const peers = dense ? [] : flows.filter((l) => ids.has(l.from) && ids.has(l.to));
      return v_flex().id(`row-${r}`).w_full().flex_none()
        .child(h_flex().w_full().items_stretch().children(shown.map((k) => h_flex().flex_1().min_w(0).px(3).items_stretch()
          .child(this.card(k, t, flows, dense, nest)))))
        .when(peers.length > 0, (e) => e.child(this.peerLanes(shown, peers, t, room, bg)));
    };
    const back = kids.filter((k) => k.status === "done" || k.status === "idle").length;
    const open = kids.filter((k) => k.status === "working").length;
    const blocks = kids.map((k) => div().flex_none().w(7).h(7).bg(k.status === "done" || k.status === "idle" ? k.color : k.status === "working" ? t.raised : k.status === "blocked" ? t.blocked : t.border)
      .when(k.status === "working", (e) => e.loop("opacity", { from: 0.3, to: 1, period: 1400 })));
    return area
      .child(h_flex().w_full().justify_center().child(this.stem(trunk, 8)))
      .child(this.fan(rows[0], t, false, 10))
      .child(v_flex().w_full().flex_none().gap(dense ? 3 : 6).children(rows.map(row)))
      .child(this.fan(rows[rows.length - 1], t, true, 10))
      .child(h_flex().w_full().justify_center().child(this.stem(trunk, 4)))
      .child(h_flex().w_full().flex_none().justify_center().gap(8).items_center().text_color(t.dim)
        .child(div().flex_none().child(`└─ back to ${lead.name}`))
        .child(h_flex().flex_none().gap(2).children(blocks))
        .child(div().flex_none().text_color(open ? t.muted : t.done).child(open ? `${back}/${kids.length} back · ${open} running` : `all ${kids.length} back`)));
  }

  // Which state of the loop an agent is in now.
  stateOf(n, nodes) {
    if (n.status === "blocked") return "needs";
    if (n.status !== "working") return "done";
    if (n.session?.now) return kindOf(n.session.now.name);
    return nodes.some((c) => c.parent === n.key && c.status === "working") ? "wait" : "think";
  }

  // An agent as a chip inside a state: its program's logo, spinner and name. A subagent,
  // which lives inside another agent's process, is marked ↳ and drawn dimmer.
  token(n, t, w, mine) {
    const sub = !n.terminal;
    const quiet = n.status === "done" || n.status === "idle" || n.status === "stale";
    return h_flex().id(`tok-${n.key}`).max_w(w).min_w(0).gap(3).items_center().px(3).rounded(2).bg(t.raised)
      .when(!!mine, (e) => e.border_l(2).border_color(mine))
      .when(!!n.terminal, (e) => e.cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => { cx.stop_propagation(); this.peek(n.terminal); }))
      .when(sub, (e) => e.child(div().flex_none().text_color(t.dim).child("↳")))
      .child(icon(n.program, 10, quiet ? t.muted : n.color) ?? div())
      .when(n.status === "working" || n.status === "blocked", (e) => e.child(this.mark(n.status, t)))
      .when(!!this.blocked(n.session), (e) => e.child(div().flex_none().text_color(t.working).child("⊘").loop("opacity", { from: 0.3, to: 1, period: 700 })))
      .child(div().min_w(0).truncate().text_size(sub ? 11 : 12).text_color(quiet ? t.muted : sub ? t.foreground : n.color).child(n.role || n.name));
  }

  // Agent states as a hub and spokes, with agents as tokens in the state they're in, and a
  // column of what needs a look: who waits on you, who's been running longest, who's
  // nearly out of context, and each agent's recent tools as a trace.
  // Bracket corners, heads-up-display style, laid over a box.
  corners(color, n = 7) {
    const c = (pos) => div().absolute().w(n).h(n).border_color(color)
      .when(pos[0] === "t", (e) => e.top(-1).border_t(2)).when(pos[0] === "b", (e) => e.bottom(-1).border_b(2))
      .when(pos[1] === "l", (e) => e.left(-1).border_l(2)).when(pos[1] === "r", (e) => e.right(-1).border_r(2));
    return ["tl", "tr", "bl", "br"].map(c);
  }

  // Agent states around the orchestrator: it sits in the middle, every state is a box on a
  // ring, and its agents are chips in the state they're in now. A line runs from it to each
  // state its agents are in (solid to its own), with a dot running while they work.
  states(lead, g, t, room) {
    const now = this.now();
    const nodes = g.nodes;
    const where = new Map(nodes.map((n) => [n.key, this.stateOf(n, nodes)]));
    const used = new Map();
    for (const n of nodes) for (const x of n.session?.recent ?? []) if (x.name && !x.to) used.set(kindOf(x.name), (used.get(kindOf(x.name)) ?? 0) + 1);
    const rail = room >= 680;
    const gw = rail ? room - 262 : room;
    const gh = Math.max(220, this.statesH || this.height - 240);
    const fits = gh < 380 ? 1 : gh < 520 ? 2 : 3; // chip rows per state the height has room for
    const boss = nodes.find((n) => n.key === lead.address) ?? null;
    const tree = new Set();
    if (boss) {
      for (let grew = true; grew;) {
        grew = false;
        for (const n of nodes) if (!tree.has(n.key) && (n.parent === boss.key || tree.has(n.parent))) { tree.add(n.key); grew = true; }
      }
    }
    const bossColor = boss?.color ?? t.accent;
    const cx = gw / 2;
    const cy = gh / 2 - 6;
    const BW = Math.max(118, Math.min(176, gw * 0.21));
    const rx = Math.max(80, cx - BW / 2 - 4);
    const ry = Math.max(70, cy - 30);
    const pos = new Map(STATES.map((st, i) => {
      const a = -Math.PI / 2 + (i * 2 * Math.PI) / STATES.length;
      return [st.id, { x: cx + rx * Math.cos(a), y: cy + ry * Math.sin(a) }];
    }));
    const at = (id) => nodes.filter((n) => n !== boss && where.get(n.key) === id).sort((a, b) => tree.has(b.key) - tree.has(a.key));

    // Lines from the orchestrator: solid to its own state, dashed to its agents' states.
    const fade = (c) => (/^#[0-9a-f]{6}$/i.test(c) ? `${c}80` : c);
    const paths = [];
    const dots = [];
    const own = boss ? where.get(boss.key) : null;
    for (const st of STATES) {
      const p = pos.get(st.id);
      const here = at(st.id);
      const mine = here.filter((n) => tree.has(n.key));
      const working = here.filter((n) => n.status === "working");
      // A faint spoke wherever an agent is at work, so its dot has a track.
      if (working.length && st.id !== own && !mine.length) {
        paths.push(window.paint_path(PathBuilder.stroke(1).dash_array([2, 5]).move_to(cx, cy).line_to(p.x, p.y).build(), t.border).absolute().top(0).left(0).size_full());
      }
      if (st.id === own || mine.length) {
        const busy = mine.some((n) => n.status === "working");
        const path = (st.id === own || busy ? PathBuilder.stroke(1.5) : PathBuilder.stroke(1).dash_array([3, 4])).move_to(cx, cy).line_to(p.x, p.y);
        paths.push(window.paint_path(path.build(), st.id === own || busy ? bossColor : fade(bossColor)).absolute().top(0).left(0).size_full());
      }
      // Every working agent sends a dot out to its state and back in, each at its own pace.
      working.slice(0, 4).forEach((n, k) => {
        const period = 1400 + k * 380 + (n.key.length % 5) * 90;
        dots.push(div().absolute().w(6).h(6).rounded(3).bg(n.color)
          .loop("left", { from: cx - 3, to: p.x - 3, period, easing: "linear" })
          .loop("top", { from: cy - 3, to: p.y - 3, period, easing: "linear" }));
      });
    }
    const orbit = PathBuilder.stroke(1).dash_array([2, 7]).move_to(cx + rx, cy).arc_to(rx, ry, 0, false, true, cx - rx, cy).arc_to(rx, ry, 0, false, true, cx + rx, cy);

    // A state: a full box when agents are in it, a faint label when not.
    const box = (st) => {
      const p = pos.get(st.id);
      const here = at(st.id);
      const calls = used.get(st.id) ?? 0;
      if (!here.length) {
        const lit = st.id === own; // the orchestrator itself is here
        return h_flex().id(`st-${st.id}`).absolute().left(Math.round(p.x - BW / 2)).top(Math.round(p.y - 9)).w(BW).h(18).justify_center().gap(4).items_center()
          .bg(t.chrome).text_color(lit ? bossColor : t.dim)
          .child(svg(stateIcon(st.id)).size(11).flex_none().text_color(lit ? bossColor : t.dim))
          .child(div().flex_none().text_size(11).child(st.label.toUpperCase()))
          .when(calls > 0, (e) => e.child(div().flex_none().text_size(10).child(`×${calls}`)));
      }
      const on = here.find((n) => n.status === "working" || n.status === "blocked");
      const accent = st.id === "needs" ? t.blocked : on ? on.color : t.muted;
      const perRow = Math.max(1, Math.floor((BW - 8) / 60));
      const shown = here.slice(0, perRow * fits);
      const rows = Math.ceil(shown.length / perRow);
      return v_flex().id(`st-${st.id}`).absolute().left(Math.round(p.x - BW / 2)).top(Math.round(p.y - 12 - rows * 10)).w(BW)
        .p(4).gap(2).bg(t.background).border(1).border_color(t.border).children(this.corners(accent))
        .when(st.id === "needs", (e) => e.child(div().absolute().top(0).left(0).size_full().bg(t.blocked).loop("opacity", { from: 0, to: 0.18, period: 900 })))
        .child(h_flex().w_full().gap(5).items_center()
          .child(svg(stateIcon(st.id)).size(12).flex_none().text_color(accent))
          .child(div().flex_1().min_w(0).truncate().font_semibold().text_size(11).text_color(accent).child(st.label.toUpperCase()))
          .when(calls > 0, (e) => e.child(div().flex_none().text_size(10).text_color(t.dim).child(`×${calls}`)))
          .child(div().flex_none().text_color(t.muted).child(String(here.length))))
        .child(h_flex().w_full().flex_wrap().gap(3).children(shown.map((n) => this.token(n, t, Math.floor((BW - 8) / perRow) - 3, tree.has(n.key) ? bossColor : null))))
        .when(here.length > shown.length, (e) => e.child(div().pl(3).text_size(11).text_color(t.dim).child(`+${here.length - shown.length} more`)));
    };

    // The orchestrator in the middle: who, what it's doing, how much it has handed out.
    const W = Math.min(300, Math.max(190, gw * 0.4));
    const center = [];
    if (boss) {
      const s0 = boss.session;
      const busy = [...tree].filter((k) => nodes.find((n) => n.key === k)?.status === "working").length;
      const me = { ...s0, ...facts(s0), status: boss.status, color: bossColor, sub: own === "wait" ? `waiting on ${busy} agent${busy === 1 ? "" : "s"}` : null, now: s0?.now };
      center.push(v_flex().id("boss").absolute().left(Math.round(cx - W / 2)).top(Math.round(cy - 30)).w(Math.round(W)).h(60).px(8).py(5).gap(2).justify_center()
        .bg(t.background).border(1).border_color(fade(bossColor)).cursor_pointer().on_click(() => this.peek(boss.terminal))
        .children(this.corners(bossColor, 10))
        .when(boss.status === "working", (e) => e.child(div().absolute().top(0).left(0).size_full().border(1).border_color(bossColor).loop("opacity", { from: 0, to: 0.8, period: 2200 })))
        .child(h_flex().w_full().min_w(0).gap(6).items_center()
          .child(this.mark(boss.status, t)).child(icon(boss.program, 13, bossColor) ?? div())
          .child(div().flex_1().min_w(0).truncate().font_semibold().child(boss.role || boss.name))
          .child(this.prChip(s0, t) ?? div()))
        .child(h_flex().w_full().min_w(0).gap(6).items_center().text_size(11)
          .child(div().flex_none().px(4).rounded(2).bg(t.raised).text_color(bossColor).child("ORCHESTRATOR"))
          .child(div().flex_1().min_w(0).truncate().text_color(t.dim).child(`${tree.size} delegated · ${busy} busy`)))
        .child(div().w_full().min_w(0).text_size(11).child(this.activity(me, t))));
    }
    const calls = [...used.values()].reduce((a, b) => a + b, 0);
    const graph = div().id("states").relative().flex_1().min_w(0).h_full().overflow_hidden()
      .on_size_change((size, cx2) => { if (Math.abs(size.height - this.statesH) > 1) { this.statesH = size.height; cx2.notify(); } })
      .child(window.paint_path(orbit.build(), t.border).absolute().top(0).left(0).size_full())
      .children(paths).children(dots).children(center).children(STATES.map(box))
      .child(div().absolute().bottom(0).left(0).text_size(10).text_color(t.dim)
        .child(`${nodes.length} agents · ${calls} recent tool calls · ×N per state`));
    if (!rail) return graph;
    return h_flex().flex_1().min_w(0).h_full().gap(12).items_start().child(graph).child(this.glance(nodes, where, t, now));
  }

  // One color per agent: the lead keeps its model color, the rest take distinct ANSI colors,
  // since agents on the same model would otherwise draw the same line.
  hues(g, lead, t) {
    const pool = [t.ansi12, t.ansi13, t.ansi11, t.ansi10, t.ansi14, t.ansi9, t.ansi5, t.ansi3, t.ansi2, t.ansi6, t.ansi4, t.ansi1];
    let i = 0;
    return new Map(g.nodes.map((n) => [n.key, n.key === lead.address ? n.color : pool[i++ % pool.length]]));
  }

  // The view's own top line: what it shows, and the time range.
  spanBar(title, t) {
    const chip = (id) => div().id(`span-${id}`).px(6).rounded(3).cursor_pointer()
      .bg(this.span === id ? t.selected : "#00000000").text_color(this.span === id ? t.foreground : t.dim)
      .hover((s) => s.bg(t.hover))
      .on_click(() => { this.span = id; try { localStorage.setItem("span", id); } catch { /* still works this run */ } })
      .child(id);
    return h_flex().w_full().flex_none().justify_between().items_center().text_size(11)
      .child(div().text_color(t.dim).truncate().child(title))
      .child(h_flex().gap(2).flex_none().children(Object.keys(SPANS).map(chip)));
  }

  measured(el) {
    return el.on_size_change((size, cx2) => {
      if (Math.abs(size.width - this.plot.w) > 1 || Math.abs(size.height - this.plot.h) > 1) { this.plot = { w: size.width, h: size.height }; cx2.notify(); }
    });
  }

  // Context size over time, one line per agent. A sharp drop is a reset (compaction).
  context(lead, g, t, room) {
    const now = this.now();
    const span = SPANS[this.span];
    const from = now - span;
    const hue = this.hues(g, lead, t);
    const rail = room >= 640;
    const W = Math.max(200, this.plot.w || (rail ? room - 222 : room));
    const H = Math.max(140, this.plot.h || this.height - 280);
    const L = 40; const R = 8; const T = 8; const B = 18;
    const lines = g.nodes.map((n) => {
      const all = n.session?.series ?? [];
      const pts = all.filter(([at]) => at >= from);
      const before = all.filter(([at]) => at < from).pop();
      if (before) pts.unshift([from, before[1]]);
      const last = pts[pts.length - 1];
      const end = n.status === "working" ? now : Math.min(now, n.session?.lastAt ?? 0);
      if (last && end > last[0]) pts.push([end, last[1]]);
      return { n, color: hue.get(n.key), pts, resets: (n.session?.resetTimes ?? []).filter((at) => at >= from) };
    }).filter((l) => l.pts.length);
    const bar = this.spanBar("Context · tokens in each agent's window · a drop is a reset", t);
    if (!lines.length) {
      return v_flex().flex_1().min_w(0).h_full().gap(6).child(bar)
        .child(v_flex().flex_1().items_center().justify_center().text_color(t.dim).child(`No context samples in the last ${this.span}`));
    }
    const peak = Math.max(50000, ...lines.flatMap((l) => l.pts.map((p) => p[1])));
    const step = [25000, 50000, 100000, 200000, 250000, 500000, 1000000].find((s) => peak * 1.08 / s <= 5) ?? 1000000;
    const top = Math.ceil((peak * 1.08) / step) * step;
    const x = (at) => L + ((at - from) / span) * (W - L - R);
    const y = (c) => T + (1 - c / top) * (H - T - B);
    const grid = [];
    for (let v = 0; v <= top; v += step) {
      grid.push(div().absolute().left(L).top(Math.round(y(v))).w(W - L - R).h(1).bg(t.border).opacity(v === 0 ? 1 : 0.5));
      grid.push(div().absolute().left(0).top(Math.round(y(v)) - 7).w(L - 6).text_size(10).text_color(t.dim).flex().justify_end().child(tokens(v)));
    }
    const every = span / 3;
    for (let k = 0; k <= 3; k++) {
      const at = from + k * every;
      grid.push(div().absolute().left(Math.round(x(at)) - (k === 3 ? 22 : 12)).top(H - B + 4).text_size(10).text_color(t.dim)
        .child(k === 3 ? "now" : `-${Math.round((now - at) / 60000)}m`));
    }
    const paths = [];
    const marks = [];
    const order = [...lines].sort((a, b) => (a.n.key === this.hot) - (b.n.key === this.hot));
    for (const l of order) {
      const hot = this.hot === l.n.key;
      const color = this.hot && !hot ? `${l.color}50` : l.color;
      let path = PathBuilder.stroke(hot ? 2.5 : 1.5).move_to(x(l.pts[0][0]), y(l.pts[0][1]));
      for (const [at, c] of l.pts.slice(1)) path = path.line_to(x(at), y(c));
      paths.push(window.paint_path(path.build(), color).absolute().top(0).left(0).size_full());
      const [ex, ey] = [x(l.pts[l.pts.length - 1][0]), y(l.pts[l.pts.length - 1][1])];
      marks.push(div().absolute().left(Math.round(ex) - 3).top(Math.round(ey) - 3).w(6).h(6).rounded(3).bg(color)
        .when(l.n.status === "working", (e) => e.loop("opacity", { from: 0.3, to: 1, period: 1200 })));
      for (const at of l.resets) {
        marks.push(div().absolute().left(Math.round(x(at))).top(T).w(1).h(H - T - B).bg(color).opacity(0.35));
        marks.push(div().absolute().left(Math.round(x(at)) - 4).top(0).text_size(10).text_color(color).child("⟲"));
      }
    }
    const plot = this.measured(div().id("ctx-plot").relative().flex_1().min_h(0).w_full())
      .children(grid).children(paths).children(marks);
    const legend = [...lines].sort((a, b) => (b.n.session?.ctx ?? 0) - (a.n.session?.ctx ?? 0)).map((l) => {
      const s = l.n.session ?? {};
      const note = [s.resets ? `⟲${s.resets}` : "", s.ctxRate >= 1000 ? `+${tokens(s.ctxRate)}/m` : ""].filter(Boolean).join(" ");
      return h_flex().id(`ctxl-${l.n.key}`).w_full().min_w(0).gap(6).items_center().px(3).rounded(3)
        .bg(this.hot === l.n.key ? t.hover : "#00000000").cursor_pointer()
        .on_hover((on, cx2) => { const next = on ? l.n.key : this.hot === l.n.key ? null : this.hot; if (next !== this.hot) { this.hot = next; cx2.notify(); } })
        .when(!!l.n.terminal, (e) => e.on_click(() => this.peek(l.n.terminal)))
        .child(div().w(10).h(3).flex_none().rounded(1).bg(l.color))
        .child(this.mark(l.n.status, t))
        .child(div().flex_1().min_w(0).truncate().child(l.n.role || l.n.name))
        .when(!!note, (e) => e.child(div().flex_none().text_size(10).text_color(t.dim).child(note)))
        .child(div().flex_none().text_color(t.muted).child(tokens(s.ctx ?? 0)));
    });
    const graph = v_flex().flex_1().min_w(0).h_full().gap(6).child(bar).child(plot);
    if (!rail) return graph.child(h_flex().flex_wrap().gap_x(10).gap_y(2).flex_none().children(legend.slice(0, 8).map((e) => e.max_w(200))));
    return h_flex().flex_1().min_w(0).h_full().gap(12).items_start().child(graph)
      .child(v_flex().id("ctx-legend").w(210).flex_none().h_full().gap(2).overflow_y_scroll()
        .child(h_flex().w_full().justify_between().text_color(t.dim).pb(2).child("NOW").child("largest first"))
        .children(legend));
  }

  // A lane per agent, in tree order, with every tool call as a tick in its kind's color.
  // Gaps are time spent thinking or waiting; a line drops from a parent to a child it started.
  // Under the ticks, a bar per minute shows what the agent spent, at API list prices.
  lanes(lead, g, t, room) {
    const now = this.now();
    const span = SPANS[this.span];
    const from = now - span;
    const hue = this.hues(g, lead, t);
    const NAME = room >= 520 ? 150 : 96;
    const COST = this.week ? 116 : 72;
    const W = Math.max(200, this.plot.w || room);
    const TW = W - NAME - 14 - COST;
    const x = (at) => NAME + 8 + Math.max(0, Math.min(1, (at - from) / span)) * TW;
    const LH = 30;
    // Tree order: the lead, then each agent under the one that started it.
    const order = [];
    const seen = new Set();
    const walk = (n, depth) => {
      if (seen.has(n.key)) return;
      seen.add(n.key); order.push({ n, depth });
      for (const k of g.nodes.filter((c) => c.parent === n.key)) walk(k, depth + 1);
    };
    const root = g.nodes.find((n) => n.key === lead.address);
    if (root) walk(root, 0);
    for (const n of g.nodes) if (!seen.has(n.key) && !g.nodes.some((p) => p.key === n.parent)) walk(n, 0);
    for (const n of g.nodes) walk(n, 0);
    const shown = order.filter(({ n }) => (n.session?.ticks ?? []).some(([at]) => at >= from) || n.status === "working" || n.status === "blocked" || n.key === lead.address);
    const idx = new Map(shown.map((o, i) => [o.n.key, i]));
    const spent = (n) => (n.session?.spend ?? []).filter(([at]) => at >= from - 60000).reduce((a, [, usd]) => a + usd, 0);
    const own = new Map(g.nodes.map((n) => [n.key, spent(n)]));
    const below = (key) => g.nodes.filter((c) => c.parent === key).reduce((a, c) => a + own.get(c.key) + below(c.key), 0);
    const peak = Math.max(0.01, ...g.nodes.flatMap((n) => (n.session?.spend ?? []).filter(([at]) => at >= from - 60000).map(([, usd]) => usd)));
    const total = [...own.values()].reduce((a, b) => a + b, 0);
    const recent = g.nodes.reduce((a, n) => a + (n.session?.spend ?? []).filter(([at]) => at >= now - 10 * 60000).reduce((b, [, usd]) => b + usd, 0), 0);
    const barW = Math.max(2, Math.floor((TW * 60000) / span) - 1);
    const items = [];
    const links = [];
    shown.forEach(({ n, depth }, i) => {
      const s = n.session ?? {};
      const color = hue.get(n.key);
      const mid = i * LH + 11;
      const ticks = (s.ticks ?? []).filter(([at]) => at >= from);
      const first = Math.max(from, s.startedAt ?? ticks[0]?.[0] ?? from);
      const last = n.status === "working" ? now : Math.min(now, s.lastAt ?? ticks[ticks.length - 1]?.[0] ?? now);
      items.push(h_flex().id(`lane-${n.key}`).absolute().left(0).top(i * LH).w(NAME).h(LH).gap(5).items_center().pl(depth * 10)
        .when(!!n.terminal, (e) => e.cursor_pointer().hover((st) => st.bg(t.hover)).on_click(() => this.peek(n.terminal)))
        .child(this.mark(n.status, t))
        .when(this.stuck(n).length > 0, (e) => e.child(div().flex_none().text_color(t.blocked).child("⚠")))
        .child(div().flex_1().min_w(0).truncate().text_color(color).child(`${depth ? "↳ " : ""}${n.role || n.title || n.name}`)));
      items.push(div().absolute().left(NAME + 8).top(Math.round(mid)).w(TW).h(1).bg(t.border).opacity(0.5));
      if (last > first) items.push(div().absolute().left(Math.round(x(first))).top(Math.round(mid) - 5).w(Math.max(2, Math.round(x(last) - x(first)))).h(10).rounded(2).bg(color).opacity(0.12));
      const px = new Set();
      for (const [at, name] of ticks) {
        const kind = kindOf(name);
        const key = `${Math.round(x(at))}/${kind}`;
        if (px.has(key)) continue;
        px.add(key);
        items.push(div().absolute().left(Math.round(x(at))).top(Math.round(mid) - 6).w(2).h(12).bg(kindColor(kind, t)));
      }
      for (const [at, usd] of s.spend ?? []) {
        if (at < from - 60000 || usd <= 0) continue;
        const h = Math.max(1, Math.round((8 * usd) / peak));
        items.push(div().absolute().left(Math.round(x(Math.max(from, at)))).top(i * LH + LH - 2 - h).w(barW).h(h).bg(color).opacity(0.45));
      }
      const sub = below(n.key);
      items.push(v_flex().absolute().left(W - COST).top(i * LH + 2).w(COST).items_end()
        .child(h_flex().gap(5).text_size(11)
          .when(!!this.weekShare(own.get(n.key)), (e) => e.child(div().text_color(t.accent).child(this.weekShare(own.get(n.key)))))
          .child(div().text_color(own.get(n.key) >= 0.005 ? t.foreground : t.dim).child(money(own.get(n.key)))))
        .when(sub >= 0.005, (e) => e.child(div().text_size(10).text_color(t.dim)
          .child(`+${money(sub)}${this.weekShare(sub) ? ` · ${this.weekShare(sub)}` : ""} kids`))));
      for (const b of s.blocks ?? []) if (b.t >= from) items.push(div().absolute().left(Math.round(x(b.t)) - 4).top(Math.round(mid) - 8).text_size(10).text_color(t.blocked).child("▲"));
      for (const at of s.resetTimes ?? []) if (at >= from) items.push(div().absolute().left(Math.round(x(at)) - 4).top(Math.round(mid) - 8).text_size(10).text_color(t.muted).child("⟲"));
      if (n.status === "working") items.push(div().absolute().left(Math.round(x(now)) - 3).top(Math.round(mid) - 3).w(7).h(7).rounded(4).bg(color).loop("opacity", { from: 0.25, to: 1, period: 1100 }));
      if (n.status === "blocked") items.push(div().absolute().left(Math.round(x(now)) - 5).top(Math.round(mid) - 8).text_color(t.blocked).child("◆").loop("opacity", { from: 0.3, to: 1, period: 900 }));
      // The parent's line down to this lane, where the child started.
      const p = idx.get(n.parent);
      if (p !== undefined && p < i) {
        const sx = Math.round(x(Math.max(from, s.startedAt ?? first)));
        links.push(div().absolute().left(sx).top(p * LH + LH / 2 + 6).w(1).h((i - p) * LH - 12).bg(color).opacity(0.6));
        links.push(div().absolute().left(sx - 2).top(Math.round(mid) - 8).w(5).h(2).bg(color).opacity(0.6));
      }
    });
    items.push(div().absolute().left(Math.round(x(now))).top(0).w(1).h(shown.length * LH).bg(t.dim).opacity(0.6));
    const totals = h_flex().w_full().flex_none().justify_between().gap(12).text_size(11)
      .child(div().flex_none().text_color(t.foreground).child(`${money(total)} in ${this.span}${this.weekShare(total) ? ` · ${this.weekShare(total)} of your week` : ""} · ${money(recent / 10)}/min lately`))
      .child(div().flex_1().min_w(0).text_color(t.dim).truncate().child(this.week
        ? `% of week ≈ share of this week's ${money(this.week.cost)} = ${this.week.pct}% · API list prices`
        : "API list prices, not your plan's bill"));
    const axis = div().relative().w_full().h(14).flex_none().text_size(10).text_color(t.dim)
      .children([0, 1, 2, 3].map((k) => {
        const at = from + (k * span) / 3;
        return div().absolute().top(0).left(Math.round(x(at)) - (k === 3 ? 22 : 12)).child(k === 3 ? "now" : `-${Math.round((now - at) / 60000)}m`);
      }));
    const key = h_flex().flex_wrap().gap_x(10).gap_y(2).flex_none().text_size(10).text_color(t.dim)
      .children(["shell", "read", "edit", "web", "delegate", "other"].map((k) => h_flex().gap(4).items_center()
        .child(div().w(2).h(10).bg(kindColor(k, t))).child(k)))
      .child(h_flex().gap(4).child(div().text_color(t.blocked).child("▲")).child("auto-mode block"))
      .child(h_flex().gap(4).child("⟲").child("context reset"))
      .child(h_flex().gap(4).child(div().text_color(t.blocked).child("◆")).child("needs you"))
      .child(h_flex().gap(4).child(div().text_color(t.blocked).child("⚠")).child("looks stuck"));
    const stuck = shown.flatMap(({ n }) => this.stuck(n).map((x) => ({ n, x })));
    return v_flex().flex_1().min_w(0).h_full().gap(6)
      .child(this.spanBar("Lanes · ticks are tool calls · bars are spend per minute", t))
      .child(totals)
      .when(stuck.length > 0, (e) => e.child(this.stuckList(stuck.slice(0, 4), hue, t)))
      .child(this.measured(v_flex().id("lanes").flex_1().min_h(0).w_full().overflow_y_scroll())
        .child(div().relative().w_full().h(shown.length * LH).flex_none().children(links).children(items)))
      .child(axis)
      .child(key);
  }

  // Signs from scan.cjs that a running agent goes round in circles. A finished agent has none.
  stuck(n) {
    return n.status === "working" || n.status === "stale" ? n.session?.stuck ?? [] : [];
  }

  // Spend since the start of the range, one line per agent and subagent, and the total.
  // ✕ marks a cache miss: the agent wrote its whole context to the cache again.
  cost(lead, g, t, room) {
    const now = this.now();
    const range = SPANS[this.span];
    const from = now - range;
    const hue = this.hues(g, lead, t);
    const rail = room >= 640;
    // Every subagent this scan saw, not only the turn's: their money is spent all the same.
    const rows = [];
    for (const n of g.nodes.filter((x) => x.terminal)) {
      rows.push({ key: n.key, name: n.role || n.title || n.name, status: n.status, color: hue.get(n.key) ?? n.color, s: n.session ?? {}, depth: 0, terminal: n.terminal });
      for (const k of n.session?.subs ?? []) rows.push({ key: k.id, name: k.type, status: k.status, color: hue.get(k.id), s: k, depth: 1, parent: n.key });
    }
    const extra = [t.ansi10, t.ansi14, t.ansi11, t.ansi13, t.ansi9, t.ansi12];
    rows.filter((r) => !r.color).forEach((r, i) => { r.color = extra[i % extra.length]; }); // subagents from an earlier turn
    const inSpan = (list) => (list ?? []).filter(([at]) => at >= from - 60000);
    for (const r of rows) {
      r.usd = inSpan(r.s.spend).reduce((a, [, usd]) => a + usd, 0);
      r.rate = (r.s.spend ?? []).filter(([at]) => at >= now - 5 * 60000).reduce((a, [, usd]) => a + usd, 0) / 5;
      r.hit = hitRate(inSpan(r.s.cacheMin));
      r.misses = (r.s.misses ?? []).filter(([at]) => at >= from);
      r.waste = r.misses.reduce((a, m) => a + m[2], 0);
      let cum = 0;
      r.pts = [[from, 0]];
      for (const [at, usd] of inSpan(r.s.spend)) { r.pts.push([Math.max(from, at), cum]); cum += usd; r.pts.push([Math.min(now, Math.max(from, at) + 60000), cum]); }
      r.pts.push([r.status === "working" ? now : Math.min(now, Math.max(r.pts[r.pts.length - 1][0], r.s.lastAt ?? 0)), cum]);
      r.at = (at) => { let c = 0; for (const [x, y] of r.pts) if (x <= at) c = y; return c; };
    }
    const spent = rows.filter((r) => r.usd >= 0.005);
    const total = spent.reduce((a, r) => a + r.usd, 0);
    // The pace over the last 10 minutes, from every Claude Code agent on this Mac, against the week.
    const machine = this.scan.sessions.flatMap((x) => [x, ...(x.subs ?? [])])
      .reduce((a, x) => a + (x.spend ?? []).filter(([at]) => at >= now - 10 * 60000).reduce((b, [, usd]) => b + usd, 0), 0) / 10;
    const w = this.week;
    let pace = `${money(machine)}/min on this Mac lately`;
    let warn = false;
    if (w && machine > 0) {
      const perHour = machine * 60 * (w.pct / w.cost);
      const left = ((100 - w.pct) / perHour) * 3600000;
      const reset = w.weekStart + 7 * 86400000 - now;
      warn = left < reset;
      pace += ` ≈ ${pct(perHour)} of your week an hour · ${warn ? `100% in ${span(left)}, before the reset in ${span(reset)}` : `stays under the limit until the reset in ${span(reset)}`}`;
    } else if (w) pace = `nothing spent in 10m · ${w.pct}% of your week used`;
    const head = v_flex().w_full().flex_none().gap(1).text_size(11)
      .child(div().text_color(t.foreground).child(`${money(total)} in ${this.span} in this space${this.weekShare(total) ? ` · ${this.weekShare(total)} of your week` : ""}`))
      .child(div().w_full().text_color(warn ? t.blocked : t.dim).child(`${warn ? "⚠ " : ""}${pace}`));
    const bar = this.spanBar("Cost · spend since the start of the range · ✕ is a cache miss · API list prices", t);
    if (!spent.length) {
      return v_flex().flex_1().min_w(0).h_full().gap(6).child(bar).child(head)
        .child(v_flex().flex_1().items_center().justify_center().text_color(t.dim).child(`No spend in the last ${this.span}`));
    }
    const W = Math.max(200, this.plot.w || (rail ? room - 262 : room));
    const H = Math.max(140, this.plot.h || this.height - 300);
    const L = 44; const R = 8; const T = 8; const B = 18;
    const steps = [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500];
    const step = steps.find((v) => (total * 1.08) / v <= 5) ?? 1000;
    const top = Math.max(step, Math.ceil((total * 1.08) / step) * step);
    const x = (at) => L + ((at - from) / range) * (W - L - R);
    const y = (usd) => T + (1 - usd / top) * (H - T - B);
    const grid = [];
    for (let v = 0; v <= top + 1e-9; v += step) {
      grid.push(div().absolute().left(L).top(Math.round(y(v))).w(W - L - R).h(1).bg(t.border).opacity(v === 0 ? 1 : 0.5));
      grid.push(div().absolute().left(0).top(Math.round(y(v)) - 7).w(L - 6).text_size(10).text_color(t.dim).flex().justify_end().child(money(v)));
    }
    for (let k = 0; k <= 3; k++) {
      const at = from + (k * range) / 3;
      grid.push(div().absolute().left(Math.round(x(at)) - (k === 3 ? 22 : 12)).top(H - B + 4).text_size(10).text_color(t.dim)
        .child(k === 3 ? "now" : `-${Math.round((now - at) / 60000)}m`));
    }
    // The total: every agent's minutes added up.
    const times = [...new Set(spent.flatMap((r) => r.pts.map(([at]) => at)))].sort((a, b) => a - b);
    const sum = times.map((at) => [at, spent.reduce((a, r) => a + r.at(at), 0)]);
    const paths = [];
    const marks = [];
    const line = (pts, color, width) => {
      let p = PathBuilder.stroke(width).move_to(x(pts[0][0]), y(pts[0][1]));
      for (const [at, v] of pts.slice(1)) p = p.line_to(x(at), y(v));
      paths.push(window.paint_path(p.build(), color).absolute().top(0).left(0).size_full());
    };
    if (spent.length > 1) line(sum, this.hot ? `${t.foreground}40` : t.foreground, 2);
    for (const r of [...spent].sort((a, b) => (a.key === this.hot) - (b.key === this.hot))) {
      const hot = this.hot === r.key;
      const color = this.hot && !hot ? `${r.color}50` : r.color;
      line(r.pts, color, hot ? 2.5 : 1.5);
      const end = r.pts[r.pts.length - 1];
      marks.push(div().absolute().left(Math.round(x(end[0])) - 3).top(Math.round(y(end[1])) - 3).w(6).h(6).rounded(3).bg(color)
        .when(r.status === "working", (e) => e.loop("opacity", { from: 0.3, to: 1, period: 1200 })));
      for (const [at] of r.misses) marks.push(div().absolute().left(Math.round(x(at)) - 4).top(Math.round(y(r.at(at))) - 8).text_size(11).text_color(t.blocked).child("✕"));
    }
    if (spent.length > 1) marks.push(div().absolute().left(Math.max(L, Math.round(x(now)) - 74)).top(Math.max(0, Math.round(y(total)) - 16)).text_size(10).text_color(t.foreground).child(`all ${money(total)}`));
    const plot = this.measured(div().id("cost-plot").relative().flex_1().min_h(0).w_full()).children(grid).children(paths).children(marks);

    const sectionHead = (a, b) => h_flex().w_full().justify_between().pt(4).text_color(t.dim).child(a).child(b ?? "");
    const hover = (el, key) => el.on_hover((on, cx2) => { const next = on ? key : this.hot === key ? null : this.hot; if (next !== this.hot) { this.hot = next; cx2.notify(); } });
    const top8 = [...spent].sort((a, b) => b.usd - a.usd);
    const ranked = top8.map((r) => hover(v_flex().id(`cost-${r.key}`).w_full().min_w(0).px(3).rounded(3).bg(this.hot === r.key ? t.hover : "#00000000")
      .when(!!r.terminal, (e) => e.cursor_pointer().on_click(() => this.peek(r.terminal)))
      .child(h_flex().w_full().min_w(0).gap(6).items_center()
        .child(div().w(10).h(3).flex_none().rounded(1).bg(r.color))
        .child(this.mark(r.status, t))
        .child(div().flex_1().min_w(0).truncate().child(`${r.depth ? "↳ " : ""}${r.name}`))
        .when(!!this.weekShare(r.usd), (e) => e.child(div().flex_none().text_size(10).text_color(t.accent).child(this.weekShare(r.usd))))
        .child(div().flex_none().text_color(t.foreground).child(money(r.usd))))
      .child(div().ml(16).h(2).bg(t.raised).child(div().h_full().w(Math.max(2, Math.round(200 * r.usd / top8[0].usd))).bg(r.color)))
      .when(r.rate >= 0.005, (e) => e.child(div().ml(16).text_size(10).text_color(t.dim).child(`${money(r.rate)}/min now`))), r.key));
    const hits = rows.filter((r) => r.hit != null);
    const all = hitRate(rows.flatMap((r) => inSpan(r.s.cacheMin)));
    const hitColor = (h) => (h >= 0.9 ? t.done : h >= 0.7 ? t.working : t.blocked);
    const misses = rows.flatMap((r) => r.misses.map((m) => ({ r, m }))).sort((a, b) => b.m[0] - a.m[0]);
    const waste = misses.reduce((a, x) => a + x.m[2], 0);
    const cache = [
      sectionHead("CACHE", all == null ? "" : `${Math.round(all * 100)}% read from cache`),
      ...hits.sort((a, b) => a.hit - b.hit).slice(0, 6).map((r) => hover(h_flex().id(`hit-${r.key}`).w_full().min_w(0).gap(6).items_center().px(3).rounded(3)
        .bg(this.hot === r.key ? t.hover : "#00000000")
        .child(div().w(10).h(3).flex_none().rounded(1).bg(r.color))
        .child(div().flex_1().min_w(0).truncate().child(`${r.depth ? "↳ " : ""}${r.name}`))
        .when(r.misses.length > 0, (e) => e.child(div().flex_none().text_size(10).text_color(t.blocked).child(`✕${r.misses.length} ${money(r.waste)}`)))
        .child(div().flex_none().text_color(hitColor(r.hit)).child(`${Math.round(r.hit * 100)}%`)), `h-${r.key}`)),
      misses.length
        ? sectionHead("MISSES", `${money(waste)} extra`)
        : div().text_color(t.done).child("✓ no cache misses in range"),
      ...misses.slice(0, 5).map(({ r, m }) => v_flex().w_full().min_w(0)
        .child(h_flex().w_full().min_w(0).gap(6)
          .child(div().flex_none().text_color(t.dim).child(clock(m[0]).slice(0, 5)))
          .child(div().flex_1().min_w(0).truncate().text_color(r.color).child(r.name))
          .child(div().flex_none().text_color(t.blocked).child(money(m[2]))))
        .child(div().pl(42).text_size(10).text_color(t.dim).truncate().child(`${tokens(m[1])} written again · ${m[3]}`))),
    ];
    const graphCol = v_flex().flex_1().min_w(0).min_h(0).gap(6).when(rail, (e) => e.h_full()).child(bar).child(head).child(plot);
    const side = (w) => v_flex().id("cost-rail").w(w).flex_none().h_full().gap(2).overflow_y_scroll()
      .child(sectionHead(`SPEND · ${this.span}`, "% of week"))
      .children(ranked).children(cache);
    if (rail) return h_flex().flex_1().min_w(0).h_full().gap(12).items_start().child(graphCol).child(side(250));
    return v_flex().flex_1().min_w(0).h_full().gap(6).child(graphCol)
      .child(v_flex().id("cost-under").w_full().h(Math.min(220, Math.round(this.height * 0.35))).flex_none().gap(2).overflow_y_scroll()
        .child(sectionHead(`SPEND · ${this.span}`, "% of week")).children(ranked.slice(0, 6)).children(cache));
  }

  // "⚠ reviewer · Bash failed 4× · pnpm test": one line per sign, a click peeks the agent.
  stuckList(items, hue, t) {
    return v_flex().w_full().flex_none().gap(1).px(6).py(3).rounded(3).border(1).border_color(t.blocked).bg(t.background)
      .children(items.map(({ n, x }, i) => h_flex().id(`stuck-${i}`).w_full().min_w(0).gap(6).items_center().text_size(11)
        .when(!!(n.terminal ?? n.parent), (e) => e.cursor_pointer().hover((st) => st.bg(t.hover)).on_click(() => this.peek(n.terminal ?? n.parent)))
        .child(div().flex_none().text_color(t.blocked).child("⚠"))
        .child(div().flex_none().max_w(140).truncate().text_color(hue?.get(n.key) ?? n.color).child(n.role || n.name))
        .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(x.text))));
  }

  // The column beside the States graph: the questions asked most about running agents.
  glance(nodes, where, t, now) {
    const head = (text, extra) => h_flex().w_full().justify_between().pt(4).text_color(t.dim).child(text).child(extra ?? "");
    const line = (n, right, color) => h_flex().id(`gl-${n.key}-${right}`).w_full().min_w(0).gap(5).items_center()
      .when(!!n.terminal, (e) => e.cursor_pointer().hover((s) => s.bg(t.hover)).on_click(() => this.peek(n.terminal)))
      .child(this.mark(n.status, t))
      .child(div().flex_1().min_w(0).truncate().text_color(n.color).child(n.role || n.name))
      .child(div().flex_none().text_color(color ?? t.muted).child(right));
    const since = (n) => n.session?.turnAt || n.session?.startedAt || 0;
    const needs = nodes.filter((n) => n.status === "blocked");
    const stuck = nodes.flatMap((n) => this.stuck(n).map((x) => ({ n, x })));
    const running = nodes.filter((n) => n.status === "working").sort((a, b) => (since(a) || now) - (since(b) || now));
    const ctx = nodes.filter((n) => n.session?.ctx > 0).sort((a, b) => b.session.ctx - a.session.ctx).slice(0, 4);
    const top = ctx[0]?.session.ctx ?? 1;
    const asks = this.extras.next ? nodes.filter((n) => n.status !== "working" && n.session?.ask) : [];
    const denials = nodes.map((n) => ({ n, b: this.blocked(n.session) })).filter((x) => x.b).sort((a, b) => b.b.t - a.b.t);
    const prs = this.extras.pr ? nodes.filter((n) => n.session?.pr || n.session?.ci).sort((a, b) => (b.session.ci?.t ?? b.session.pr?.t ?? 0) - (a.session.ci?.t ?? a.session.pr?.t ?? 0)) : [];
    const traces = nodes.filter((n) => (n.session?.recent ?? []).some((x) => x.name)).sort((a, b) => (b.session.lastAt ?? 0) - (a.session.lastAt ?? 0)).slice(0, 5);
    const glyphOf = (id) => (id === "think" ? "◎" : STATES.find((st) => st.id === id)?.glyph ?? "›");
    return v_flex().id("glance").w(250).h_full().flex_none().p(9).gap(3).bg(t.background).border(1).border_color(t.border).overflow_hidden()
      .child(head("NEEDS YOU", needs.length ? String(needs.length) : ""))
      .children(needs.length
        ? needs.map((n) => line(n, n.session?.lastAt ? `waiting ${elapsed(now - n.session.lastAt)}` : "waiting", t.blocked))
        : [div().text_color(t.done).child("✓ nothing waits on you")])
      .when(stuck.length > 0, (e) => e.child(head("LOOKS STUCK", String(stuck.length)))
        .children(stuck.slice(0, 3).map(({ n, x }, i) => v_flex().id(`gst-${i}`).w_full().min_w(0)
          .when(!!(n.terminal ?? n.parent), (y) => y.cursor_pointer().hover((st) => st.bg(t.hover)).on_click(() => this.peek(n.terminal ?? n.parent)))
          .child(h_flex().gap(5).items_center().child(div().flex_none().text_color(t.blocked).child("⚠"))
            .child(div().truncate().text_color(n.color).child(n.role || n.name)))
          .child(div().pl(12).w_full().text_size(11).truncate().text_color(t.foreground).child(x.text)))))
      .when(this.extras.next && asks.length > 0, (e) => e.child(head("NEXT UP", String(asks.length)))
        .children(asks.slice(0, 3).map((n) => v_flex().id(`ask-${n.key}`).w_full().min_w(0).cursor_pointer().hover((s) => s.bg(t.hover))
          .on_click(() => n.terminal && this.peek(n.terminal))
          .child(h_flex().gap(5).items_center().child(div().flex_none().text_color(t.working).child("?"))
            .child(div().truncate().text_color(n.color).child(n.role || n.name)))
          .child(div().pl(12).w_full().text_size(11).text_color(t.foreground).truncate().child(n.session.ask)))))
      .when(denials.length > 0, (e) => e.child(head("AUTO MODE", `${denials.length} blocked`))
        .children(denials.slice(0, 3).map(({ n, b }) => v_flex().w_full().min_w(0)
          .child(line(n, `${elapsed(now - b.t)} ago`, t.working))
          .child(div().pl(12).w_full().text_size(11).truncate().text_color(t.working).child(`⊘ ${b.reason}${b.hint ? ` · ${b.hint}` : ""}`)))))
      .child(head("RUNNING", running.length ? String(running.length) : ""))
      .children(running.length
        ? running.slice(0, 5).map((n) => line(n, `${glyphOf(where.get(n.key))} ${since(n) ? elapsed(now - since(n)) : ""}`))
        : [div().text_color(t.dim).child("nothing running")])
      .when(running.length > 5, (e) => e.child(div().text_color(t.dim).child(`+${running.length - 5} more`)))
      .when(prs.length > 0, (e) => e.child(head("PRS · CI", ""))
        .children(prs.slice(0, 4).map((n) => v_flex().w_full().min_w(0)
          .child(h_flex().id(`pr-${n.key}`).w_full().min_w(0).gap(5).items_center()
            .when(!!n.terminal, (x) => x.cursor_pointer().hover((s) => s.bg(t.hover)).on_click(() => this.peek(n.terminal)))
            .child(this.mark(n.status, t))
            .child(div().flex_1().min_w(0).truncate().text_color(n.color).child(n.role || n.name))
            .child(this.prChip(n.session, t) ?? div()))
          .when((n.session.ci?.failed?.length ?? 0) > 0, (x) => x.child(div().pl(12).w_full().text_size(11).truncate().text_color(t.blocked)
            .child(`✗ ${n.session.ci.failed.join(", ")}`))))))
      .when(ctx.length > 0, (e) => e.child(head("CONTEXT", "largest first"))
        .children(ctx.map((n) => v_flex().w_full().gap(1)
          .child(line(n, `${this.ctxNote(n.session) ? `${this.ctxNote(n.session)} · ` : ""}${tokens(n.session.ctx)}`, t.foreground))
          .child(div().w_full().h(2).bg(t.raised).child(div().h_full().w(Math.max(2, Math.round(228 * n.session.ctx / top))).bg(n.color))))))
      .when(traces.length > 0, (e) => e.child(head("TRACE", "newest right"))
        .children(traces.map((n) => h_flex().w_full().min_w(0).gap(6).items_center()
          .child(div().w(84).flex_none().truncate().text_color(n.color).child(n.role || n.name))
          .child(h_flex().flex_1().min_w(0).gap(3).justify_end().overflow_hidden().children(
            n.session.recent.filter((x) => x.name).slice(-12).map((x, i, all) => {
              const k = kindOf(x.name);
              const last = i === all.length - 1 && n.status === "working";
              return div().flex_none().text_color(k === "edit" ? t.done : k === "shell" ? n.color : k === "delegate" ? t.working : t.muted)
                .child(glyphOf(k)).when(last, (x2) => x2.loop("opacity", { from: 0.25, to: 1, period: 800 }));
            }))))));
  }

  // The settings row: a terminal-style checkbox per extra, saved for this pane's views.
  settingsRow(t) {
    return h_flex().w_full().flex_none().flex_wrap().gap(10).items_center().px(8).py(4).bg(t.background).border(1).border_color(t.border)
      .child(div().flex_none().text_color(t.dim).child("show"))
      .children(Object.entries(EXTRAS).map(([k, label]) => div().id(`opt-${k}`).flex_none().cursor_pointer().rounded(2).px(4)
        .hover((s) => s.bg(t.hover)).text_color(this.extras[k] ? t.foreground : t.dim)
        .on_click((_e, cx) => {
          this.extras[k] = !this.extras[k];
          try { localStorage.setItem("extras", JSON.stringify(this.extras)); } catch { /* storage may be off */ }
          cx.notify();
        })
        .child(`[${this.extras[k] ? "✓" : " "}] ${label}`)));
  }

  // "#744 ✓6 ✗1": a PR and its last CI result, as a chip.
  prChip(x, t) {
    if (!this.extras.pr || (!x?.pr && !x?.ci)) return null;
    const ci = x.ci;
    return h_flex().flex_none().gap(4).items_center()
      .when(!!x.pr, (e) => e.child(div().text_color(t.muted).child(`#${x.pr.n}`)))
      .when(!!ci, (e) => e
        .when(ci.pass > 0, (y) => y.child(div().text_color(t.done).child(`✓${ci.pass}`)))
        .when(ci.fail > 0, (y) => y.child(div().text_color(t.blocked).child(`✗${ci.fail}`)))
        .when(ci.pending > 0, (y) => y.child(div().text_color(t.working).child(`…${ci.pending}`))));
  }

  // The last auto-mode denial, while it's recent.
  blocked(x) {
    const b = this.extras.blocks ? x?.blocks?.[x.blocks.length - 1] : null;
    return b && this.now() - b.t < BLOCK_MS ? b : null;
  }

  // "⟲2 · +6k/m": context resets and how fast the context grows.
  ctxNote(x) {
    if (!this.extras.ctx || !x) return "";
    return [x.resets ? `⟲${x.resets}` : "", x.ctxRate >= 1000 ? `+${tokens(x.ctxRate)}/m` : ""].filter(Boolean).join(" ");
  }

  row(key, value, t, color) {
    return h_flex().justify_between().gap(8).child(div().text_color(t.dim).flex_none().child(key))
      .child(div().truncate().text_color(color ?? t.foreground).child(String(value)));
  }

  side(lead, session, kids, t) {
    const k = kids.find((x) => x.id === this.kid) ?? null;
    const model = k ? k.model : session?.model;
    const color = k ? k.color : tone(model, t, lead.app);
    const list = (k ? k.recent : session?.recent) ?? [];
    const tools = k ? k.tools : session?.tools;
    const panel = v_flex().w(226).h_full().flex_none().p(10).gap(5).bg(t.background).border(1).border_color(color).overflow_hidden()
      .child(this.who(k ? k.agent : lead.name, model, k ? k.program : lead.program, color, t))
      .child(div().truncate().text_center().text_color(t.muted).child(k ? (k.address ? `${k.title} · ${k.address}` : `${k.title} · subagent`) : `${lead.address} · lead`))
      .child(div().h(1).bg(t.border).flex_none())
      .child(this.row("state", stateWord(k ? k.status : lead.status), t, stateColor(k ? k.status : lead.status, t)));
    if (tools != null) panel.child(this.row("tools", `${(k ?? session).more ? "≥" : ""}${tools}${k ? "" : " this turn"}`, t));
    if ((k ?? session)?.ctx) panel.child(this.row("context", tokens((k ?? session).ctx), t));
    if (k?.startedAt) panel.child(this.row("ran for", elapsed((k.status === "working" ? Date.now() : k.lastAt) - k.startedAt), t));
    if (!k && session?.total) panel.child(this.row("subagents", session.total, t));
    if (k?.sub) panel.child(div().mt(4).text_color(t.muted).child(k.sub));
    panel.child(div().mt(4).text_color(t.dim).child("last tools"));
    panel.child(v_flex().flex_1().min_h(0).gap(1).overflow_hidden().children(
      (list.length ? list.filter((x) => !x.back).slice(-8) : [{ name: "none seen", hint: "" }]).map((x, i) =>
        div().id(`tool-${i}`).truncate().text_color(t.foreground).child(`» ${toolLine(x)}`))));
    if (!k || k.address) {
      panel.child(this.button("go", k ? "peek terminal" : "go to terminal", t, () => {
        if (this.sample) return;
        if (k) this.peek(k.address);
        else { run("agent.focus", { terminal: lead.address }); this.close(); }
      }));
    }
    return panel;
  }

  peek(address) {
    if (!this.sample) run("terminal.peek", { terminal: address });
  }

  switcher(t) {
    const tab = ([id, label]) => div().id(`view-${id}`).px(6).rounded(3).cursor_pointer()
      .bg(this.view === id ? t.selected : "#00000000").text_color(this.view === id ? t.foreground : t.muted)
      .hover((s) => s.bg(t.hover)).on_click((_e, cx) => { this.view = id; localStorage.setItem("view", id); cx.notify(); }).child(label);
    return h_flex().gap(2).flex_none().children(Object.entries(VIEWS).map(tab));
  }

  close() {
    const o = props()?.overlay;
    if (o) closeOverlay(o);
  }

  // One line of leads: the chosen one and the busiest first, then "+N more" for the rest.
  // Background agents (a PR stack's, say) can add dozens.
  chips(leads, lead, t) {
    const fits = Math.max(2, Math.floor((this.width - 24) / 200));
    const order = [lead, ...leads.filter((a) => a !== lead)];
    const shown = this.allChips || leads.length <= fits ? leads : order.slice(0, fits - 1);
    const more = leads.length - shown.length;
    const toggle = div().id("lead-more").px(7).py(2).rounded(3).cursor_pointer().bg(t.background).hover((s) => s.bg(t.hover)).text_color(t.muted)
      .on_click((_e, cx) => { this.allChips = !this.allChips; cx.notify(); })
      .child(this.allChips ? "fewer" : `+${more} more`);
    return h_flex().gap(6).flex_wrap().flex_none().when(this.allChips, (e) => e.max_h(160).overflow_y_scroll()).id("leads").children(shown.map((a) => {
      const on = a.address === lead.address;
      return h_flex().id(`lead-${a.address}`).gap(5).px(7).py(2).items_center().rounded(3).cursor_pointer()
        .bg(on ? t.selected : t.background).hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => { this.pick = a.address; this.kid = null; cx.notify(); })
        .child(this.dot(stateColor(a.status, t), a.status === "working"))
        .child(icon(a.program, 12, t.muted) ?? div())
        .child(div().text_color(on ? t.foreground : t.muted).max_w(170).truncate().child(a.label ? a.label : `${a.name} · ${a.title || a.address}`));
    })).when(more > 0 || this.allChips, (e) => e.child(toggle));
  }

  logBox(rows, t, narrow) {
    const short = this.height < SHORT;
    return v_flex().id("log").h(short ? 96 : 132).flex_none().p(8).gap(1).bg(t.background).border(1).border_color(t.border).overflow_hidden()
      .child(div().text_color(t.dim).child("session log"))
      .child(v_flex().flex_1().min_h(0).justify_end().overflow_hidden().children(rows.slice(short ? -3 : -6).map((r) =>
        h_flex().gap(narrow ? 6 : 10).when(!narrow, (e) => e.child(div().flex_none().text_color(t.dim).child(clock(r.t))))
          .child(div().w(narrow ? 76 : 92).flex_none().truncate().text_color(r.color).child(r.who))
          .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(r.text)))));
  }

  render() {
    const t = theme();
    // A copy opened with props { follow: true } takes its view from shared("agent-flow.view") =
    // { view, at }, so another mod can drive it (a recorded walkthrough). Other copies ignore it.
    const ask = props()?.follow ? shared("agent-flow.view") : null;
    if (ask && ask.at !== this.asked && VIEWS[ask.view]) { this.asked = ask.at; this.view = ask.view; }
    const { agents: all, plain } = this.world();
    // The space it's called from: props().space pins a copy to one space.
    const spaceId = this.sample ? null : props()?.space ?? focused()?.space ?? null;
    if (spaceId !== this.space) { this.space = spaceId; this.pick = this.sample ? "t1" : null; this.lastLead = null; this.kid = null; }
    const list = this.sample ? all : all.filter((a) => a.space === spaceId);
    const spaceName = this.sample ? this.sample.name : spaces().find((p) => p.id === spaceId)?.name ?? "this space";
    const live = new Set(list.map((a) => a.address));
    const leads = list.filter((a) => !a.parent || !live.has(a.parent))
      .sort((a, b) => (RANK[a.status] ?? 9) - (RANK[b.status] ?? 9) || b.seq - a.seq);
    const overlay = !!props()?.overlay;
    const root = v_flex().id("root").size_full().p(12).gap(9).bg(overlay ? t.canvas : t.chrome).font_family(FONT).text_size(12).text_color(t.foreground)
      .on_size_change((size, cx) => { this.width = size.width; this.height = size.height; cx.notify(); });
    const closer = overlay ? this.button("close", "✕", t, () => this.close()) : div();
    const lead = this.chosen(leads, list);
    if (!lead) {
      return root.child(h_flex().justify_between().child(div().font_semibold().child(spaceName)).child(closer))
        .child(v_flex().flex_1().items_center().justify_center().gap(4)
          .child(div().text_color(t.muted).child(`No agents in ${spaceName}`))
          .child(div().text_color(t.dim).child("Start one from the + menu and its work shows here")));
    }
    if (!this.sample) this.track(all);
    const sessions = pair(all, this.scan.sessions);
    // A child's CI often arrives as a report to its lead: give it to the child that sent it.
    const reported = new Map();
    for (const x of this.scan.sessions) for (const r of x.reports ?? []) if ((reported.get(r.from)?.t ?? 0) < r.t) reported.set(r.from, r);
    for (const [address, x] of sessions) {
      const r = reported.get(address);
      if (r && (x.ci?.t ?? 0) < r.t) x.ci = r;
    }
    const session = sessions.get(lead.address) ?? null;
    const kids = this.kids(lead, list, sessions, t);
    const g = graph(list, sessions, t);
    const mine = plain.filter((k) => k.parent === lead.address);
    // Every agent and subagent of the space at work, the lead included; the same count as the Map's.
    const working = g.nodes.filter((n) => n.status === "working").length;
    const stuckN = g.nodes.filter((n) => this.stuck(n).length).length;
    const wide = this.width >= 640;
    const narrow = this.width < NARROW;
    const beside = wide && !["map", "states", "context", "lanes", "cost"].includes(this.view);
    const room = this.width - 24 - (beside ? 236 : 0);
    const bg = overlay ? t.canvas : t.chrome;
    const mapHeight = Math.max(360, this.height - (narrow ? 280 : 330) - (mine.length ? 26 : 0));
    const body = this.view === "states" ? this.states(lead, g, t, room) : this.view === "map" ? this.map(lead, g, t, room, mapHeight) : this.view === "timeline" ? this.timeline(lead, g, t, room, bg) : this.view === "context" ? this.context(lead, g, t, room) : this.view === "lanes" ? this.lanes(lead, g, t, room) : this.view === "cost" ? this.cost(lead, g, t, room) : this.flow(lead, session, kids, g, t, room, bg);
    const color = tone(session?.model, t, lead.app);

    return root
      .child(h_flex().items_center().justify_between().gap(10).flex_none()
        .child(h_flex().gap(8).flex_1().min_w(0).text_size(13).font_semibold()
          .child(div().max_w(180).truncate().flex_none().child(spaceName))
          .when(this.width >= 340, (e) => e.child(div().flex_none().text_color(t.dim).child("·"))
            .child(div().flex_1().min_w(0).truncate().text_color(color).child(modelName(session?.model) ?? lead.name)))
          .when(this.width >= 620, (e) => e.child(div().flex_none().text_color(working ? t.working : t.muted).child(`${working} RUNNING`)))
          .when(this.width >= 620 && stuckN > 0, (e) => e.child(div().id("stuck-n").flex_none().text_color(t.blocked).cursor_pointer()
            .on_click((_e, cx) => { this.view = "lanes"; cx.notify(); }).child(`⚠ ${stuckN} STUCK`))))
        .child(h_flex().gap(8).items_center().flex_none()
          .when(!!this.error, (e) => e.child(div().max_w(320).truncate().text_color(t.blocked).child(`no scan: ${this.error}`)))
          .child(this.button("gear", this.settings ? "⚙ ✕" : "⚙", t, () => { this.settings = !this.settings; }))
          .child(this.switcher(t))
          .child(closer)))
      .when(this.settings, (e) => e.child(this.settingsRow(t)))
      .child(this.chips(leads, lead, t))
      .child(h_flex().flex_1().min_h(0).gap(10).items_start()
        .when(beside, (e) => e.child(this.side(lead, session, kids, t)))
        .child(body))
      .when(mine.length > 0, (e) => e.child(this.plainList(mine, t)))
      .when(this.height >= 460, (e) => e.child(this.logBox(this.logRows(lead, session, kids, list, t), t, narrow)));
  }
}
