// PR stack: your open pull requests in merge order, what stands between each one and a merge,
// and one-click fixes: update, change base, merge, an agent that resolves conflicts, fixes CI or
// answers review comments, or a whole stack merged into trunk one PR at a time.
// prs.mjs runs gh, git and hc; logic.js decides what rows say and offer.
// Roles by props(): { button: true } is the "PRs" button beside the tabs (it also runs the
// automation); otherwise the panel. Ported from the Paseo `factory` plugin.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { spaces, panes, focused, exec, theme, props, run, appHome, notify, shared, setShared, layout } from "herdr";
import { prSignals, prActions, prTone, orderGroups, age, checkCounts, activeTask, TASK_KINDS, TASK_TITLE, TONE_RANK } from "./logic.js";

const MOD = "pr-stack";
const REFRESH_MS = 45000;
const LANDING_MS = 10000;     // refresh while a stack merge runs
const AUTO_MS = 5 * 60000;
const ARM_MS = 4000;          // how long a second press confirms a merge or a close
const SETTINGS = "pr-stack.settings";
const ATTENTION = "pr-stack.attention";
const RAIL = 14;
const ACTION_LABEL = {
  retarget: "Change base to main", update: "Update branch", conflicts: "Resolve conflicts", ci: "Fix CI",
  comments: "Address comments", ready: "Mark ready", merge: "Squash and merge", "auto-merge": "Auto-merge when green",
  "cancel-auto-merge": "Cancel auto-merge", checkout: "Check out", "open-agent": "Open agent", "archive-task": "Archive agent",
  close: "Close PR", github: "Open on GitHub", diff: "Review diff",
};
const QUICK_LABEL = { conflicts: "Resolve", ci: "Fix CI", comments: "Address", merge: "Merge", retarget: "Base → main", update: "Update", "open-agent": "Agent" };
const ARMED = new Set(["merge", "auto-merge", "close"]);
// The most urgent fix first: a wrong base changes what conflicts and what CI runs against.
const PRIMARY = ["open-agent", "retarget", "conflicts", "ci", "comments", "update", "merge", "ready"];
const SECTION = { wrong_base: "Fix base", stack: "Stack", independent: "Independent" };
const DIFF_TARGET = "pr-diff.target"; // read by the pr-diff mod
const kilo = (n) => (n >= 10000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

const isVisible = () => (typeof visible === "function" ? visible() : true);
const tilde = (p) => p.replace(/^\/Users\/[^/]+/, "~");

function location() {
  const space = spaces().find((s) => s.active);
  const f = focused();
  const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  // The focused terminal's folder first, then the other terminals of the shown tab and space,
  // so a terminal in a parent folder still finds the repository.
  const tabs = new Set((space?.tabs ?? []).map((x) => x.id));
  const others = panes().filter((p) => p.cwd && (p.tab === f?.tab || tabs.has(p.tab))).sort((a, b) => (b.tab === f?.tab) - (a.tab === f?.tab)).map((p) => p.cwd);
  const dirs = [...new Set([pane?.cwd, f?.cwd, ...others, space?.folder].filter(Boolean))];
  return { dir: dirs[0] ?? null, dirs, remote: Boolean(space?.machine) };
}
const NOT_REPO = /not a git repository|no git remotes|could not determine|none of the git remotes/i;

const settingsOf = () => {
  const s = shared(SETTINGS) ?? {};
  return { automation: s.automation ?? {}, prompts: s.prompts ?? {}, ignored: s.ignored ?? [] };
};

async function prs(args, timeout = 120000) {
  const space = focused()?.space;
  const r = await exec("node", ["--no-warnings", `${appHome()}/mods/${MOD}/prs.mjs`, ...(space ? [`--space=${space}`] : []), ...args], { timeout });
  let out;
  try { out = JSON.parse(r.stdout); } catch { throw new Error(r.stderr.trim().split("\n").pop() || `prs.mjs exited ${r.code}`); }
  if (out.error) throw new Error(out.error);
  return out;
}

const tones = (t) => ({ danger: t.ansi1, warning: t.ansi3, success: t.ansi2, muted: t.dim });

export default class PrStack extends View {
  init(_props, cx) {
    this.button = Boolean(props()?.button);
    if (this.button) {
      this.autoTick(cx);
      cx.timer.every(AUTO_MS, (cx) => this.autoTick(cx));
      return;
    }
    this.data = null;
    this.error = null;
    this.loading = false;
    this.request = 0;
    this.lastAt = 0;
    this.context = null;
    this.scope = (props()?.scope ?? localStorage.getItem("scope")) === "all" ? "all" : "branch";
    this.sort = localStorage.getItem("sort") === "newest" ? "newest" : "urgency";
    this.open = new Set(props()?.expand ?? []); // expanded PR numbers
    this.folded = new Set();       // collapsed stacks, by their first PR
    this.armed = null;             // { key, until }: the next press on key confirms
    this.working = new Set();      // `${number}:${action}` running now
    this.note = null;              // { text, level, at } of the last action
    this.view = props()?.view === "settings" ? "settings" : "list";
    this.width = 368;
    this.deploys = null;           // the trunk's recent merges and what ran on them, from prs.mjs deploys
    this.deploysBusy = false;
    this.seen = new Map();         // `${sha}:${check}` -> state, to notify when one finishes
    this.mainOpen = false;         // the Main section shows every merge, not the last three
    this.makeInputs();
    this.refresh(cx);
    cx.timer.every(LANDING_MS, (cx) => {
      if (!isVisible()) return;
      if (this.data?.land?.live || Date.now() - this.lastAt > REFRESH_MS) this.refresh(cx, true);
      else if (this.deploys?.commits.some((c) => c.checks.some((x) => x.state === "running" || x.state === "queued"))) this.loadDeploys(cx);
    });
    cx.timer.every(1000, (cx) => { if (this.armed && Date.now() > this.armed.until) { this.armed = null; cx.notify(); } });
  }

  // Text fields need a live host call, so they are made here and kept, never in render.
  makeInputs() {
    const s = settingsOf();
    const save = () => setShared(SETTINGS, {
      ...(shared(SETTINGS) ?? {}),
      prompts: Object.fromEntries(TASK_KINDS.map((k) => [k, this.inputs[k].value()])),
      ignored: this.inputs.ignored.value().split(",").map((x) => x.trim()).filter(Boolean),
    });
    this.inputs = {};
    for (const k of TASK_KINDS) {
      this.inputs[k] = InputState.new({ placeholder: `Extra instructions for ${TASK_TITLE[k].toLowerCase()}`, value: s.prompts[k] ?? "" });
      this.inputs[k].on("change", save);
    }
    this.inputs.ignored = InputState.new({ placeholder: "Check names, comma separated", value: s.ignored.join(", ") });
    this.inputs.ignored.on("change", save);
  }

  // ---------- data ----------

  // The newest request wins: a focus or pane change starts a new one, and an older answer is dropped.
  refresh(cx, quiet) {
    const { dir, dirs, remote } = location();
    const context = `${dirs.join(",")}|${this.scope}`;
    if (context === this.context && this.loading) return;
    this.context = context;
    if (!dir || remote) {
      this.error = remote ? "The PR stack works on this computer's spaces only" : "No folder: focus a terminal in a git repository";
      if (!quiet) cx.notify();
      return;
    }
    const id = ++this.request;
    this.loading = true;
    if (!quiet) cx.notify();
    cx.spawn(async (cx) => {
      let data = null;
      let error = null;
      try {
        for (const [i, d] of dirs.entries()) {
          try { data = await prs(["list", d, this.scope]); this.dir = d; break; } catch (e) { if (!NOT_REPO.test(e.message) || i === dirs.length - 1) throw e; }
        }
      } catch (e) {
        error = NOT_REPO.test(e.message) ? "This folder is not a GitHub repository. Focus a terminal in one." : e.message;
      }
      if (id !== this.request) return;
      this.loading = false;
      this.error = error;
      if (data) {
        // The list stays on screen while it reloads; only a different repository resets it.
        if (this.data && this.data.root !== data.root) { this.open.clear(); this.folded.clear(); }
        const was = this.data?.land;
        if (was?.live && data.land && !data.land.live) {
          this.say(data.land.done ? "The stack is merged" : `Stack merge stopped: ${data.land.error ?? "the runner ended"}`, data.land.done ? "success" : "error");
        }
        this.data = data;
        this.lastAt = Date.now();
        const shown = data.groups.flatMap((g) => g.prs);
        setShared(ATTENTION, { ...(shared(ATTENTION) ?? {}), root: data.root, danger: shown.filter((p) => prTone(p) === "danger").length, running: data.running + (data.land?.live ? 1 : 0) });
        if (this.deploys && this.deploys.root !== data.root) this.deploys = null;
        this.loadDeploys(cx);
      }
      cx.notify();
    });
  }

  // The trunk's recent merges and their CI and deploys. A check that finishes failed, or passes
  // after a failure, raises a notification.
  loadDeploys(cx) {
    const dir = this.dir;
    if (this.deploysBusy || !dir || !this.data) return;
    this.deploysBusy = true;
    const root = this.data.root;
    cx.spawn(async (cx) => {
      try {
        const out = await prs(["deploys", dir], 60000);
        if (this.data?.root !== root) return;
        const first = !this.deploys;
        for (const c of out.commits) for (const x of c.checks) {
          const key = `${c.sha}:${x.name}`;
          const was = this.seen.get(key);
          this.seen.set(key, x.state);
          if (first || !was || was === x.state || (was !== "running" && was !== "queued")) continue;
          const what = `${x.name} on ${c.pr ? `#${c.pr}` : c.sha.slice(0, 7)}`;
          if (x.state === "failure") notify({ title: `${x.kind === "ci" ? "CI failed" : "Deploy failed"}`, body: `${what}: ${c.title}`, level: "error" });
          else if (x.state === "success" && x.kind === "deploy" && this.failing(this.deploys).includes(x.name)) notify({ title: "Deployed", body: `${what} is live again`, level: "success", timeout: 6000 });
        }
        this.deploys = { ...out, root };
        setShared(ATTENTION, { ...(shared(ATTENTION) ?? {}), deploy: this.failing(this.deploys).length });
      } catch { /* the PR list still shows; the next refresh tries again */ }
      this.deploysBusy = false;
      cx.notify();
    });
  }

  // Checks whose newest finished run on the trunk failed: what is broken right now.
  failing(deploys) {
    const last = new Map();
    for (const c of deploys?.commits ?? []) for (const x of c.checks) {
      if (!last.has(x.name) && (x.state === "success" || x.state === "failure")) last.set(x.name, x.state);
    }
    return [...last.entries()].filter(([, st]) => st === "failure").map(([name]) => name);
  }

  // "Main": the last merges, newest first, a chip per check. A click on a chip opens its run.
  mainSection(t, now) {
    const d = this.deploys;
    if (!d?.commits.length) return null;
    const color = { success: t.ansi2, failure: t.ansi1, running: t.working, queued: t.dim, cancelled: t.dim, skipped: t.dim };
    const glyph = { success: "✓", failure: "✗", running: "◐", queued: "○", cancelled: "⊘", skipped: "–" };
    const failing = this.failing(d);
    const running = d.commits.some((c) => c.checks.some((x) => x.state === "running" || x.state === "queued"));
    const summary = failing.length
      ? div().text_size(11).text_color(t.ansi1).child(`✗ ${failing.join(", ")} failing`)
      : running ? div().text_size(11).text_color(t.working).child("deploying…") : div().text_size(11).text_color(t.ansi2).child("✓ all live");
    const shown = this.mainOpen ? d.commits : d.commits.slice(0, 3);
    const chip = (c, x) => h_flex().id(`chk-${c.sha.slice(0, 7)}-${x.name}`).gap(3).items_center().px(4).rounded(4).cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .when(Boolean(x.url), (e) => e.on_click(() => exec("open", [x.url])))
      .child(div().text_size(11).text_color(color[x.state]).child(glyph[x.state] ?? "?")
        .when(x.state === "running", (y) => y.loop("opacity", { from: 0.3, to: 1, period: 900 })))
      .child(div().text_size(11).text_color(x.state === "failure" ? t.ansi1 : t.muted).child(x.name));
    const rows = shown.map((c) => {
      const worst = c.checks.some((x) => x.state === "failure") ? "failure" : c.checks.some((x) => x.state === "running" || x.state === "queued") ? "running" : "success";
      return v_flex().id(`main-${c.sha.slice(0, 7)}`).w_full().px(4).py(4).gap(3).rounded(6)
        .child(h_flex().w_full().min_w(0).gap(6).items_center()
          .child(div().w(6).h(6).rounded(3).flex_none().bg(color[worst]).when(worst === "running", (e) => e.loop("opacity", { from: 0.3, to: 1, period: 900 })))
          .child(div().flex_none().text_size(11).text_color(t.dim).child(c.pr ? `#${c.pr}` : c.sha.slice(0, 7)))
          .child(div().flex_1().min_w(0).truncate().text_size(12).child(c.title))
          .child(div().flex_none().text_size(11).text_color(t.dim).child(age(new Date(c.at).toISOString(), now))))
        .child(h_flex().pl(12).flex_wrap().gap_x(2).gap_y(1).children(c.checks.map((x) => chip(c, x))));
    });
    const toggle = (cx) => { this.mainOpen = !this.mainOpen; cx.notify(); };
    return v_flex().w_full()
      .child(this.head("sec-main", `${d.trunk} · deploys`, "", t, { folded: !this.mainOpen, onToggle: d.commits.length > 3 ? toggle : null, right: [summary] }))
      .children(rows);
  }

  say(text, level = "info") {
    this.note = { text, level, at: Date.now() };
    if (level === "error" || level === "success") notify({ title: "PR stack", body: text, level, timeout: 6000 });
  }

  /** Runs prs.mjs for a press, shows its message, then refreshes the list. */
  perform(key, args, cx, after) {
    this.working.add(key);
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const out = await prs(args, 300000);
        if (after) after(out); else this.say(out.message, "success");
      } catch (e) {
        this.say(e.message, "error");
      }
      this.working.delete(key);
      this.refresh(cx, true);
      cx.notify();
    });
  }

  // Merges, auto-merge, close and a stack merge need a second press within ARM_MS.
  armedFor(key, cx) {
    if (this.armed?.key === key) { this.armed = null; return true; }
    this.armed = { key, until: Date.now() + ARM_MS };
    cx.notify();
    return false;
  }

  press(pr, action, cx) {
    const key = `${pr.number}:${action}`;
    if (ARMED.has(action) && !this.armedFor(key, cx)) return;
    if (action === "github") { exec("open", [pr.url]); return; }
    if (action === "diff") { this.openDiff(pr); return; }
    if (action === "open-agent") { run("agent.focus", { terminal: pr.task.address }); return; }
    const dir = this.dir ?? location().dir;
    const n = String(pr.number);
    if (action === "checkout") {
      this.perform(key, ["checkout", dir, n], cx, (out) => {
        run("space.new", { name: `#${pr.number} ${pr.head}`.slice(0, 40), folder: out.path, focus: true });
        this.say(out.created ? `Made a worktree for #${pr.number}` : `Opened the worktree of #${pr.number}`);
      });
      return;
    }
    if (TASK_KINDS.includes(action)) {
      this.perform(key, ["task", dir, n, action, settingsOf().prompts[action] ?? ""], cx, (out) => {
        this.say(out.message, "success");
        if (out.address) run("agent.focus", { terminal: out.address });
      });
      return;
    }
    this.perform(key, action === "archive-task" ? ["archive", dir, n] : ["act", dir, action, n, pr.headOid], cx);
  }

  landStack(lead, cx) {
    const key = `stack:${lead}:land`;
    if (!this.armedFor(key, cx)) return;
    this.perform(key, ["land-start", this.dir, String(lead), JSON.stringify(settingsOf().prompts)], cx, (out) => this.say(out.message, "success"));
  }

  // ---------- the button (always on screen, so it also runs the automation) ----------

  autoTick(cx) {
    const s = settingsOf();
    for (const [root, enabled] of Object.entries(s.automation)) {
      if (!TASK_KINDS.some((k) => enabled?.[k])) continue;
      cx.spawn(async () => {
        try {
          const out = await prs(["auto", root, JSON.stringify({ enabled, prompts: s.prompts, ignored: s.ignored })], 600000);
          for (const x of out.started ?? []) {
            notify(x.error
              ? { title: "PR stack automation", body: `#${x.number} ${TASK_TITLE[x.kind]}: ${x.error}`, level: "error" }
              : { title: "PR stack automation", body: `Started ${TASK_TITLE[x.kind].toLowerCase()} on #${x.number}`, level: "info", action: { name: "agent.focus", args: { terminal: x.address } } });
          }
        } catch { /* the next tick tries again */ }
      });
    }
  }

  renderButton(t) {
    const find = (n, id) => (n?.id === id ? n : (n?.children ?? []).map((c) => find(c, id)).find(Boolean));
    const root = layout();
    const panel = find(root, "panel");
    const body = find(root, "panel-body");
    const on = panel && !panel.hidden && body?.active === "prs";
    const att = shared(ATTENTION);
    return h_flex().size_full().items_center().justify_center().bg(t.chrome).border_b(1).border_color(t.border)
      .child(h_flex().id("prs-button").h(26).px(8).gap(5).items_center().rounded(6).text_size(12)
        .bg(on ? t.selected : t.chrome).text_color(on ? t.foreground : t.muted).hover((s) => s.bg(t.hover)).cursor_pointer()
        .on_click(() => {
          if (on) run("layout.hide", { id: "panel" });
          else { run("layout.select", { stack: "panel-body", child: "prs" }); run("layout.show", { id: "panel" }); }
        })
        .child(svg(`mods/${MOD}/icons/pr.svg`).size(14))
        .child("PRs")
        .when(att?.deploy > 0, (e) => e.child(div().text_size(10).text_color(t.ansi1).child("▲")))
        .when(att?.danger > 0, (e) => e.child(div().px(4).rounded(4).bg(t.ansi1).text_color(t.background).text_size(10).font_semibold().child(String(att.danger))))
        .when(att?.running > 0, (e) => e.child(div().w(6).h(6).rounded(3).bg(t.working).loop("opacity", { from: 0.3, to: 1, period: 1000 }))));
  }

  // ---------- small pieces ----------

  iconButton(id, label, t, onClick, spin) {
    return div().id(id).w(24).h(24).flex().items_center().justify_center().rounded(6).text_color(t.dim).cursor_pointer().flex_none()
      .hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click(onClick)
      .child(spin ? div().child(label).loop("opacity", { from: 0.3, to: 1, period: 700 }) : label);
  }

  segmented(t) {
    const seg = (id, label) => div().id(`scope-${id}`).px(8).h(20).flex().items_center().rounded(5).text_size(11).cursor_pointer()
      .bg(this.scope === id ? t.raised : "#00000000").text_color(this.scope === id ? t.foreground : t.dim)
      .on_click((_e, cx) => { this.scope = id; localStorage.setItem("scope", id); this.refresh(cx); })
      .child(label);
    return h_flex().p(2).gap(1).rounded(7).bg(t.chrome).border_1().border_color(t.border).flex_none()
      .child(seg("branch", "Branch")).child(seg("all", "All"));
  }

  small(id, label, t, onClick, { solid, danger, busy } = {}) {
    return div().id(id).h(22).px(8).flex().items_center().rounded(5).text_size(11).flex_none().cursor_pointer()
      .when(Boolean(solid) && !danger, (e) => e.bg(t.solid).text_color(t.solid_foreground).hover((s) => s.opacity(0.88)))
      .when(Boolean(danger), (e) => e.bg(t.ansi1).text_color(t.background))
      .when(!solid && !danger, (e) => e.border_1().border_color(t.border).text_color(t.foreground).hover((s) => s.bg(t.hover)))
      .when(Boolean(busy), (e) => e.opacity(0.55))
      .on_click((_e, cx) => { cx.stop_propagation(); if (!busy) onClick(cx); })
      .child(label);
  }

  // One segment per PR in its tone; PRs a stack merge has merged are green.
  healthBar(group, t, land, width) {
    const tone = tones(t);
    return h_flex().w(width).h(4).gap(1).flex_none().rounded(2).overflow_hidden()
      .children(group.prs.map((pr) => {
        const merged = land?.steps?.[pr.number]?.status === "merged";
        const tn = prTone(pr);
        return div().flex_1().h_full().bg(merged ? t.ansi2 : tone[tn]).opacity(merged || tn !== "muted" ? 1 : 0.5);
      }));
  }

  // ---------- rows ----------

  row(pr, t, now, { inStack = false, first = false, last = false, parent = null, land = null } = {}) {
    const signals = prSignals(pr);
    const tone = tones(t);
    const top = signals[0];
    const open = this.open.has(pr.number);
    const actions = prActions(pr);
    const quick = PRIMARY.find((a) => a !== "ready" && actions.includes(a) && !(a === "merge" && land?.live));
    const narrow = this.width < 320;
    const step = land?.steps?.[pr.number];
    const landing = Boolean(land?.live && land.current === pr.number);
    const dot = step?.status === "merged" ? t.ansi2 : landing ? t.accent : tone[prTone(pr)];

    const status = step && (step.status !== "waiting" || landing)
      ? { text: step.status === "merged" ? "Merged" : `${step.status[0].toUpperCase()}${step.status.slice(1)}${step.note ? ` · ${step.note}` : ""}`, color: step.status === "merged" ? t.ansi2 : t.accent }
      : { text: top ? top.label : "No checks yet", color: top ? tone[top.tone] : t.dim };

    const rail = div().relative().w(RAIL).flex_none().self_stretch()
      .when(inStack && !first, (e) => e.child(div().absolute().left(6).top(0).w(2).h(13).bg(t.border)))
      .when(inStack && !last, (e) => e.child(div().absolute().left(6).top(13).bottom(0).w(2).bg(t.border)))
      .child(div().absolute().left(3).top(9).w(8).h(8).rounded(4).bg(dot)
        .when(landing || Boolean(activeTask(pr) && pr.task.status !== "blocked"), (e) => e.loop("opacity", { from: 0.3, to: 1, period: 900 })));

    const titleLine = h_flex().w_full().min_w(0).gap(8).items_center()
      .child(div().flex_1().min_w(0).truncate().text_size(13).child(pr.title))
      .when(Boolean(quick) && !open && !narrow, (e) => e.child(this.quickButton(pr, quick, t)))
      .when((!quick || narrow) && !open, (e) => e.child(div().flex_none().text_size(11).text_color(t.dim).child(age(pr.createdAt, now))));
    const statusLine = h_flex().w_full().min_w(0).gap(6).items_center().text_size(12)
      .child(div().flex_none().text_color(t.dim).child(`#${pr.number}`))
      .child(div().min_w(0).truncate().text_color(status.color).child(status.text))
      .when(signals.length > 1 && !step, (e) => e.child(div().flex_none().text_color(t.dim).child(`+${signals.length - 1}`)))
      .when(Boolean(parent), (e) => e.child(div().flex_none().text_color(t.dim).child(`on #${parent}`)))
      .child(div().flex_1())
      .child(this.diffStat(pr, t, narrow));

    return h_flex().id(`pr-${pr.number}`).w_full().items_start().rounded(7).cursor_pointer().pr(8)
      .when(open, (e) => e.bg(t.hover)).hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => { if (this.open.has(pr.number)) this.open.delete(pr.number); else this.open.add(pr.number); cx.notify(); })
      .child(rail)
      .child(v_flex().flex_1().min_w(0).py(6).gap(2).child(titleLine).child(statusLine)
        .when(open, (e) => e.child(this.details(pr, signals, actions, t, now))));
  }

  // Files and lines changed; a click opens the PR's diff in a pane.
  diffStat(pr, t, narrow) {
    return h_flex().id(`diffstat-${pr.number}`).flex_none().gap(4).px(4).rounded(4).text_size(11).cursor_pointer()
      .hover((s) => s.bg(t.selected))
      .on_click((_e, cx) => { cx.stop_propagation(); this.openDiff(pr); })
      .when(!narrow, (e) => e.child(div().text_color(t.dim).child(`${pr.files} ${pr.files === 1 ? "file" : "files"}`)))
      .child(div().text_color(t.ansi2).child(`+${kilo(pr.add)}`))
      .child(div().text_color(t.ansi1).child(`−${kilo(pr.del)}`));
  }

  // One diff pane per tab: a pane already open in this tab switches to the PR.
  openDiff(pr) {
    setShared(DIFF_TARGET, { dir: this.dir ?? location().dir, number: pr.number, at: Date.now() });
    const tab = focused()?.tab;
    const open = panes().find((p) => p.mod === "pr-diff" && p.tab === tab);
    if (open) run("pane.focus", { pane: open.pane });
    else run("pane.split", { direction: "right", mod: "pr-diff" });
  }

  quickButton(pr, action, t) {
    const key = `${pr.number}:${action}`;
    const armed = this.armed?.key === key;
    const busy = this.working.has(key);
    return this.small(`quick-${pr.number}`, armed ? "Confirm" : busy ? `${QUICK_LABEL[action]}…` : QUICK_LABEL[action], t,
      (cx) => this.press(pr, action, cx), { danger: armed, busy });
  }

  details(pr, signals, actions, t, now) {
    const tone = tones(t);
    const { passed, failed, running, skipped } = checkCounts(pr);
    const shownChecks = pr.checks.filter((c) => c.state === "fail" || c.state === "pending").slice(0, 6);
    const later = ["open-agent", "checkout", "archive-task"];
    const buttons = [...actions.filter((a) => !later.includes(a)), ...actions.filter((a) => later.includes(a)), "diff", "github", ...(activeTask(pr) ? [] : ["close"])];
    const first = buttons.find((a) => PRIMARY.includes(a));
    const meta = [
      `${pr.head} → ${pr.base}`,
      pr.checks.length ? [passed && `${passed} passed`, failed && `${failed} failed`, running && `${running} running`, skipped && `${skipped} skipped`].filter(Boolean).join(" · ") : "No checks",
      `opened ${age(pr.createdAt, now)} ago`,
      pr.worktree && `worktree ${tilde(pr.worktree)}`,
      pr.task && `agent ${pr.task.address} · ${TASK_TITLE[pr.task.kind].toLowerCase()} · ${pr.task.status}${pr.task.trigger === "auto" ? " · automatic" : ""}`,
    ].filter(Boolean);
    return v_flex().w_full().gap(8).pt(6).pb(2)
      .when(signals.length > 1, (e) => e.child(v_flex().gap(2).children(signals.map((s, i) =>
        h_flex().id(`sig-${pr.number}-${i}`).gap(6).items_center().text_size(12)
          .child(div().w(5).h(5).rounded(3).bg(tone[s.tone])).child(div().text_color(t.muted).child(s.label))))))
      .child(v_flex().gap(1).text_size(11).text_color(t.dim).children(meta.map((m, i) => div().id(`meta-${pr.number}-${i}`).truncate().child(m))))
      .when(shownChecks.length > 0, (e) => e.child(v_flex().children(shownChecks.map((c, i) =>
        h_flex().id(`check-${pr.number}-${i}`).gap(6).items_center().px(4).h(20).rounded(4).text_size(11)
          .when(Boolean(c.url), (x) => x.cursor_pointer().hover((s) => s.bg(t.selected)).on_click((_e, cx) => { cx.stop_propagation(); exec("open", [c.url]); }))
          .child(div().w(8).flex_none().text_color(c.state === "fail" ? t.ansi1 : t.ansi3).child(c.state === "fail" ? "✕" : "◌"))
          .child(div().flex_1().min_w(0).truncate().child(c.name))
          .when(Boolean(c.url), (x) => x.child(div().text_color(t.dim).child("↗")))))))
      .child(h_flex().flex_wrap().gap(5).children(buttons.map((a) => this.actionButton(pr, a, t, a === first))));
  }

  actionButton(pr, action, t, primary) {
    const key = `${pr.number}:${action}`;
    const armed = this.armed?.key === key;
    const busy = this.working.has(key);
    const label = busy ? `${ACTION_LABEL[action]}…` : armed ? `Press again: ${ACTION_LABEL[action].toLowerCase()}` : action === "checkout" && pr.worktree ? "Open worktree" : ACTION_LABEL[action];
    return div().id(`act-${key}`).h(26).px(10).flex().items_center().rounded(6).text_size(12).flex_none().cursor_pointer()
      .when(primary && !armed, (e) => e.bg(t.solid).text_color(t.solid_foreground).hover((s) => s.opacity(0.88)))
      .when(armed, (e) => e.bg(t.ansi1).text_color(t.background))
      .when(!primary && !armed, (e) => e.border_1().border_color(t.border).text_color(action === "close" ? t.ansi1 : t.foreground).hover((s) => s.bg(t.hover)))
      .when(busy, (e) => e.opacity(0.55))
      .on_click((_e, cx) => { cx.stop_propagation(); if (!busy) this.press(pr, action, cx); })
      .child(label);
  }

  // ---------- sections ----------

  head(id, label, count, t, { folded, onToggle, right } = {}) {
    return h_flex().id(id).w_full().h(26).px(2).gap(6).items_center().rounded(6)
      .when(Boolean(onToggle), (e) => e.cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => onToggle(cx)))
      .child(div().w(10).text_size(9).text_color(t.dim).child(onToggle ? (folded ? "▶" : "▼") : ""))
      .child(div().text_size(11).font_semibold().text_color(t.muted).child(label.toUpperCase()))
      .child(div().text_size(11).text_color(t.dim).child(String(count)))
      .child(div().flex_1())
      .children(right ?? []);
  }

  // A running or finished stack merge: progress, the step it is on, its log and a stop button.
  landCard(land, t) {
    const order = land.order ?? [];
    const merged = order.filter((n) => land.steps?.[n]?.status === "merged").length;
    const total = order.length || 1;
    const step = land.current ? land.steps?.[land.current] : null;
    const color = land.done ? t.ansi2 : land.error ? t.ansi1 : t.accent;
    const title = land.done ? `Merged ${merged} PRs into main` : land.error ? `Stopped after ${merged} of ${total}` : `Merging ${Math.min(merged + 1, total)} of ${total} into main`;
    const detail = land.error ?? (step ? `#${land.current} · ${step.status}${step.note ? ` · ${step.note}` : ""}` : land.done ? "" : "Reading the stack…");
    return v_flex().mx(2).my(4).p(8).gap(6).rounded(8).bg(t.raised).border_1().border_color(t.border)
      .child(h_flex().gap(6).items_center()
        .child(div().w(6).h(6).rounded(3).bg(color).when(Boolean(land.live), (e) => e.loop("opacity", { from: 0.3, to: 1, period: 900 })))
        .child(div().flex_1().min_w(0).truncate().text_size(12).font_semibold().child(title))
        .when(Boolean(land.live), (e) => e.child(this.small("land-log", "Log", t, () => run("terminal.keep", { terminal: land.address, place: "down" })))
          .child(this.small("land-stop", "Stop", t, (cx) => this.perform("land-stop", ["land-stop", this.dir], cx), { busy: this.working.has("land-stop") }))))
      .child(div().h(3).w_full().rounded(2).bg(t.border).child(div().h_full().rounded(2).bg(color).w((100 * merged) / total + "%")))
      .when(Boolean(detail), (e) => e.child(div().text_size(11).text_color(land.error ? t.ansi1 : t.muted).child(detail)));
  }

  section(group, t, now) {
    const count = group.prs.length;
    if (group.kind === "independent") {
      return v_flex().w_full().child(this.head("sec-independent", SECTION.independent, count, t)).children(group.prs.map((pr) => this.row(pr, t, now)));
    }
    const lead = group.prs[0].number;
    const folded = this.folded.has(lead);
    const land = this.data.land && group.prs.some((p) => (this.data.land.order ?? []).includes(p.number) || this.data.land.first === p.number) ? this.data.land : null;
    const key = `stack:${lead}:land`;
    const armed = this.armed?.key === key;
    const canLand = count > 1 && this.data.canSquash && !this.data.land?.live && this.width >= 300;
    const right = [this.healthBar(group, t, land, Math.min(64, count * 8))];
    if (canLand) right.push(this.small(`land-${lead}`, armed ? `Merge ${count} PRs?` : this.working.has(key) ? "Starting…" : "Merge stack", t, (cx) => this.landStack(lead, cx), { danger: armed, busy: this.working.has(key) }));
    const toggle = (cx) => { if (folded) this.folded.delete(lead); else this.folded.add(lead); cx.notify(); };
    const box = v_flex().w_full().child(this.head(`sec-${lead}`, SECTION[group.kind], count, t, { folded, onToggle: toggle, right }));
    if (land) box.child(this.landCard(land, t));
    if (folded) {
      const tone = tones(t);
      return box.child(h_flex().w_full().flex_wrap().gap_x(8).gap_y(2).pl(18).pb(4).text_size(11).children(group.prs.map((pr) =>
        h_flex().gap(4).items_center().child(div().w(6).h(6).rounded(3).bg(tone[prTone(pr)])).child(div().text_color(t.muted).child(`#${pr.number}`)))));
    }
    // A PR whose parent is not the row above it sits on a branch of the stack.
    const parentOf = (i) => {
      for (let j = i - 1; j >= 0; j--) if (group.prs[j].depth === group.prs[i].depth - 1) return group.prs[j].number;
      return null;
    };
    return box.children(group.prs.map((pr, i) => {
      const parent = parentOf(i);
      return this.row(pr, t, now, { inStack: true, first: i === 0, last: i === count - 1, parent: parent !== null && i > 0 && group.prs[i - 1].number !== parent ? parent : null, land });
    }));
  }

  // ---------- settings ----------

  toggle(root, kind, t) {
    const on = Boolean(settingsOf().automation[root]?.[kind]);
    const what = { conflicts: "When GitHub reports conflicts", ci: "When checks fail and none still run", comments: "When review threads are unresolved" }[kind];
    return h_flex().id(`auto-${kind}`).w_full().gap(10).items_center().px(8).py(7).rounded(7).cursor_pointer().hover((x) => x.bg(t.hover))
      .on_click((_e, cx) => {
        const cur = shared(SETTINGS) ?? {};
        setShared(SETTINGS, { ...cur, automation: { ...(cur.automation ?? {}), [root]: { ...(cur.automation?.[root] ?? {}), [kind]: !on } } });
        cx.notify();
      })
      .child(div().w(28).h(16).flex_none().rounded(8).relative().bg(on ? t.accent : t.input)
        .child(div().absolute().top(2).left(on ? 14 : 2).w(12).h(12).rounded(6).bg(on ? t.accent_foreground : t.muted)))
      .child(v_flex().flex_1().min_w(0)
        .child(div().text_size(13).child(TASK_TITLE[kind]))
        .child(div().text_size(11).text_color(t.dim).child(what)));
  }

  settingsView(t) {
    const root = this.data?.root;
    const label = (text) => div().text_size(11).font_semibold().text_color(t.muted).child(text);
    const field = (state, text) => v_flex().gap(4)
      .child(div().text_size(11).text_color(t.dim).child(text))
      .child(div().h(30).px(8).flex().items_center().rounded(7).border_1().border_color(t.border).bg(t.chrome)
        .child(Input.new(state).h_full().text_size(12).text_color(t.foreground)));
    return v_flex().id("prs-settings").flex_1().min_h(0).overflow_y_scroll().px(10).py(10).gap(16)
      .child(v_flex().gap(4)
        .child(label("AUTOMATIC AGENTS"))
        .child(div().text_size(11).text_color(t.dim).child(root ? `${this.data.repo}, checked every 5 minutes while Herdr is open.` : "Open the panel in a repository first."))
        .when(Boolean(root), (e) => e.children(TASK_KINDS.map((k) => this.toggle(root, k, t))))
        .child(div().pt(2).text_size(11).text_color(t.dim).child("One agent per PR, 2 per repository at a time, one per head commit, 3 automatic tries per PR and task.")))
      .child(v_flex().gap(10).child(label("AGENT INSTRUCTIONS")).children(TASK_KINDS.map((k) => field(this.inputs[k], TASK_TITLE[k]))))
      .child(field(this.inputs.ignored, "Failing checks that never start an automatic CI fix"))
      .child(div().text_size(11).text_color(t.dim).child("Agents run Claude Code (Opus, high effort, auto mode) in a new worktree at the PR head. They merge, never rebase or force-push, and never change a base or merge a PR. Merge stack does the merging itself, after each PR's checks pass."));
  }

  // ---------- render ----------

  render(cx) {
    const t = theme();
    if (this.button) return this.renderButton(t);
    const { dir, dirs } = location();
    // From render, so quiet: a render may not ask for another one.
    if (`${dirs.join(",")}|${this.scope}` !== this.context) this.refresh(cx, true);
    const now = Date.now();
    const d = this.data;
    const total = d ? d.groups.reduce((n, g) => n + g.prs.length, 0) : 0;
    const groups = d ? orderGroups(d.groups, this.sort) : [];
    const autoOn = d && TASK_KINDS.some((k) => settingsOf().automation[d.root]?.[k]);
    const settings = this.view === "settings";

    const header = h_flex().h(40).flex_none().pl(12).pr(8).gap(6).items_center()
      .child(div().font_semibold().child(settings ? "Automation" : "Pull requests"))
      .when(Boolean(d) && !settings, (e) => e.child(div().text_size(12).text_color(t.dim).child(String(total))))
      .when(d?.running > 0 && !settings, (e) => e.child(div().w(6).h(6).rounded(3).bg(t.working).loop("opacity", { from: 0.3, to: 1, period: 1000 })))
      .child(div().flex_1())
      .when(!settings && this.width >= 280, (e) => e.child(this.segmented(t)))
      .when(!settings, (e) => e.child(this.iconButton("refresh", "↻", t, (_e, cx) => this.refresh(cx), this.loading)))
      .child(this.iconButton("gear", settings ? "✕" : "⚙", t, (_e, cx) => { this.view = settings ? "list" : "settings"; cx.notify(); }));

    const root = v_flex().id("pr-stack").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border)
      .text_color(t.foreground).text_size(13)
      .on_size_change((size, cx) => { if (Math.abs(size.width - this.width) > 1) { this.width = size.width; cx.notify(); } })
      .child(header);
    if (settings) return root.child(div().h(1).bg(t.border).flex_none()).child(this.settingsView(t));

    const where = d ? `${d.repo.split("/").pop()} · ${d.branch ?? d.trunk}` : dir ? tilde(dir) : "";
    const context = h_flex().flex_none().px(12).pb(8).gap(8).items_center().text_size(11).text_color(t.dim).border_b(1).border_color(t.border)
      .child(div().flex_1().min_w(0).truncate().child(where))
      .when(Boolean(autoOn), (e) => e.child(div().flex_none().text_color(t.accent).child("auto")))
      .child(div().id("sort").flex_none().cursor_pointer().hover((s) => s.text_color(t.foreground))
        .on_click((_e, cx) => { this.sort = this.sort === "urgency" ? "newest" : "urgency"; localStorage.setItem("sort", this.sort); cx.notify(); })
        .child(this.sort === "urgency" ? "Urgent first" : "Newest first"));

    const notes = [];
    if (d?.filtered) notes.push(h_flex().id("scope-note").gap(4).child(div().text_color(t.dim).child("Related to this branch."))
      .child(div().id("show-all").text_color(t.accent).cursor_pointer().on_click((_e, cx) => { this.scope = "all"; localStorage.setItem("scope", "all"); this.refresh(cx); }).child("Show all")));
    if (d?.fallback) notes.push(div().text_color(t.dim).child("No PR relates to this branch, so all show."));
    for (const w of d?.warnings ?? []) notes.push(div().text_color(t.ansi3).child(w));

    const body = v_flex().id("pr-list").flex_1().min_h(0).overflow_y_scroll().px(6).py(6).gap(10)
      .when(notes.length > 0, (e) => e.child(v_flex().px(4).gap(2).text_size(11).children(notes)));
    const main = d ? this.mainSection(t, now) : null;
    if (main) body.child(main);
    if (this.error && !d) body.child(div().p(8).text_size(12).text_color(t.dim).child(this.error));
    else if (!d) body.child(div().p(8).text_size(12).text_color(t.dim).child("Reading your pull requests…"));
    else if (!groups.length) body.child(div().p(8).text_size(12).text_color(t.dim).child("No open pull requests by you"));
    else body.children(groups.map((g) => this.section(g, t, now)));

    // The footer shows only what needs reading: the last action's result or an error.
    const message = this.note && now - this.note.at < 30000 ? this.note : this.error && d ? { text: this.error, level: "error" } : null;
    return root.child(context).child(body)
      .when(Boolean(message), (e) => e.child(h_flex().flex_none().px(12).py(6).border_t(1).border_color(t.border).text_size(11)
        .text_color(message.level === "error" ? t.ansi1 : message.level === "success" ? t.ansi2 : t.muted)
        .child(div().flex_1().min_w(0).truncate().child(message.text))));
  }
}
