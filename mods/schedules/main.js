// Schedules: agents that run on a cadence (hourly, daily or weekly) in a folder, such as the
// flaky-tests check or verification upkeep. Herdr has no scheduler of its own, so the "Schedules"
// button beside the tabs runs the jobs: it is always on screen. A run that was due while the app
// was closed starts once at the next check. Each run is `hc run` of an agent with the job's prompt.
// Roles by props(): { button: true } is the button and the runner; otherwise the panel.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { exec, theme, props, run, shared, setShared, layout, notify, focused, panes, spaces, appHome } from "herdr";

const MOD = "schedules";
const JOBS = "schedules.jobs"; // [{ id, name, dir, cadence, at, day, prompt, enabled, createdAt }]
const RUNS = "schedules.runs"; // { [id]: { at, address?, error? } }
const CHECK_MS = 60000;
const ARM_MS = 4000;
const AGENT = ["claude", "--permission-mode", "auto"];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const HOUR = 3600000;
const PERIOD = { hourly: HOUR, daily: 24 * HOUR, weekly: 7 * 24 * HOUR };
const PRESETS = {
  flaky: {
    name: "Flaky tests", cadence: "daily", at: "07:00", day: 1,
    prompt: "Use the flaky-tests skill on this repo for the last 14 days. Work in a new worktree. Open one draft PR per root cause, then report.",
  },
  verify: {
    name: "Verification upkeep", cadence: "weekly", at: "07:30", day: 1,
    prompt: "Bring the verification models in this repo up to date with the code since their last confirmed commit, rerun them, and open one draft PR if anything changed. Work in a new worktree.",
  },
  custom: { name: "", cadence: "daily", at: "09:00", day: 1, prompt: "" },
};

const jobs = () => shared(JOBS) ?? [];
const runs = () => shared(RUNS) ?? {};
const tilde = (p) => (p ?? "").replace(/^\/Users\/[^/]+/, "~");
const pad = (n) => String(n).padStart(2, "0");

/** The latest time at or before `now` when the job was due. */
export function lastDue(job, now = Date.now()) {
  const [h, m] = (job.at ?? "09:00").split(":").map(Number);
  const d = new Date(now);
  if (job.cadence === "hourly") d.setMinutes(m, 0, 0);
  else d.setHours(h, m, 0, 0);
  if (job.cadence === "weekly") d.setDate(d.getDate() - ((d.getDay() - (job.day ?? 1) + 7) % 7));
  let t = d.getTime();
  while (t > now) t -= PERIOD[job.cadence];
  return t;
}

const isDue = (job, now = Date.now()) => job.enabled && (runs()[job.id]?.at ?? job.createdAt ?? 0) < lastDue(job, now);
const nextDue = (job, now = Date.now()) => lastDue(job, now) + PERIOD[job.cadence];
const when = (job) => job.cadence === "hourly" ? `Hourly at :${job.at.split(":")[1]}` : job.cadence === "weekly" ? `${DAYS[job.day ?? 1]} ${job.at}` : `Daily ${job.at}`;

function span(ms) {
  const m = Math.round(Math.abs(ms) / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h` : `${Math.round(h / 24)}d`;
}

/** The folders to look in for the current repo: the focused terminal's, then the other terminals
 * of the shown tab and space, then the space's own folder. As the PR stack panel does. */
function candidateDirs() {
  const space = spaces().find((s) => s.active);
  const f = focused();
  const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  const tabs = new Set((space?.tabs ?? []).map((x) => x.id));
  const others = panes().filter((p) => p.cwd && (p.tab === f?.tab || tabs.has(p.tab)))
    .sort((a, b) => (b.tab === f?.tab) - (a.tab === f?.tab)).map((p) => p.cwd);
  return [...new Set([pane?.cwd, f?.cwd, ...others, space?.folder].filter(Boolean))];
}

/** The top folder of the first git repo among the candidates, or null. */
async function currentRepo() {
  for (const dir of candidateDirs()) {
    const r = await exec("git", ["rev-parse", "--show-toplevel"], { cwd: dir, timeout: 5000 }).catch(() => null);
    if (r?.code === 0 && r.stdout.trim()) return r.stdout.trim();
  }
  return null;
}

/** Starts the job's agent and records the run. */
async function start(job) {
  const stamp = Date.now().toString(36).slice(-4);
  const name = `sched-${job.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 20)}-${stamp}`;
  const record = (r) => setShared(RUNS, { ...runs(), [job.id]: { at: Date.now(), ...r } });
  try {
    const r = await exec("hc", ["run", "--bg", "--json", "--no-parent", "--name", name, "--cwd", job.dir,
      "--label", `schedules.job=${job.id}`, "--", ...AGENT, job.prompt], { timeout: 30000 });
    const out = JSON.parse(r.stdout || "{}");
    const address = out.address ?? out.terminal?.address;
    if (!address) throw new Error((r.stderr || r.stdout || "hc run failed").trim().split("\n").pop());
    record({ address });
    notify({ title: "Schedules", body: `Started ${job.name}`, level: "info", action: { name: "agent.focus", args: { terminal: address } } });
  } catch (e) {
    record({ error: String(e.message ?? e) });
    notify({ title: "Schedules", body: `${job.name} did not start: ${e.message ?? e}`, level: "error" });
  }
}

export default class Schedules extends View {
  init(_props, cx) {
    this.button = Boolean(props()?.button);
    if (this.button) {
      cx.timer.every(CHECK_MS, () => { for (const job of jobs()) if (isDue(job)) start(job); });
      return;
    }
    this.adding = false;
    this.armed = null; // { key, until }
    this.form = { ...PRESETS.flaky, preset: "flaky" };
    this.inputs = {
      name: InputState.new({ placeholder: "Name" }),
      dir: InputState.new({ placeholder: "Folder: a repo on this computer" }),
      at: InputState.new({ placeholder: "HH:MM" }),
      prompt: InputState.new({ placeholder: "What the agent does on each run" }),
    };
    cx.timer.every(30000, (cx) => cx.notify()); // keeps "in 5h" current
    cx.timer.every(1000, (cx) => { if (this.armed && Date.now() > this.armed.until) { this.armed = null; cx.notify(); } });
  }

  // ---------- form ----------

  openForm(preset, cx) {
    const p = PRESETS[preset];
    this.form = { ...p, preset };
    this.inputs.name.set_value(p.name);
    // The current repo, filled in when found. A folder the person typed meanwhile stays.
    if (!this.adding) {
      this.inputs.dir.set_value("");
      cx.spawn(async (cx) => {
        const repo = await currentRepo();
        if (repo && !this.inputs.dir.value().trim()) { this.inputs.dir.set_value(tilde(repo)); cx.notify(); }
      });
    }
    this.inputs.at.set_value(p.at);
    this.inputs.prompt.set_value(p.prompt);
    this.adding = true;
  }

  save() {
    const home = appHome().replace(/\/\.config\/herdr-app\/?$/, "");
    const dir = this.inputs.dir.value().trim().replace(/^~/, home);
    const at = /^\d{1,2}:\d{2}$/.test(this.inputs.at.value().trim()) ? this.inputs.at.value().trim().padStart(5, "0") : "09:00";
    const job = {
      id: Date.now().toString(36), name: this.inputs.name.value().trim() || "Job", dir, cadence: this.form.cadence, at, day: this.form.day,
      prompt: this.inputs.prompt.value().trim(), enabled: true, createdAt: Date.now(),
    };
    if (!job.dir || !job.prompt) return false;
    setShared(JOBS, [...jobs(), job]);
    this.adding = false;
    return true;
  }

  update(id, change) { setShared(JOBS, jobs().map((j) => (j.id === id ? { ...j, ...change } : j))); }

  remove(id, cx) {
    const key = `remove:${id}`;
    if (this.armed?.key !== key) { this.armed = { key, until: Date.now() + ARM_MS }; cx.notify(); return; }
    this.armed = null;
    setShared(JOBS, jobs().filter((j) => j.id !== id));
  }

  // ---------- render ----------

  chip(id, label, on, t, onClick) {
    return div().id(id).h(24).px(8).flex().items_center().rounded(6).text_size(11).cursor_pointer()
      .border_1().border_color(on ? t.accent : t.border).text_color(on ? t.foreground : t.muted).when(on, (e) => e.bg(t.selected))
      .hover((s) => s.bg(t.hover)).on_click((_e, cx) => { onClick(cx); cx.notify(); }).child(label);
  }

  small(id, label, t, onClick, { solid, danger } = {}) {
    return div().id(id).h(22).px(8).flex().items_center().rounded(5).text_size(11).flex_none().cursor_pointer()
      .when(Boolean(solid) && !danger, (e) => e.bg(t.solid).text_color(t.solid_foreground))
      .when(Boolean(danger), (e) => e.bg(t.ansi1).text_color(t.background))
      .when(!solid && !danger, (e) => e.border_1().border_color(t.border).text_color(t.foreground).hover((s) => s.bg(t.hover)))
      .on_click((_e, cx) => { cx.stop_propagation(); onClick(cx); cx.notify(); }).child(label);
  }

  field(state, label, t) {
    return v_flex().gap(4)
      .child(div().text_size(11).text_color(t.dim).child(label))
      .child(div().h(30).px(8).flex().items_center().rounded(7).border_1().border_color(t.border).bg(t.chrome)
        .child(Input.new(state).h_full().text_size(12).text_color(t.foreground)));
  }

  formView(t) {
    const f = this.form;
    return v_flex().gap(10).p(10).mx(10).rounded(8).border_1().border_color(t.border).bg(t.raised)
      .child(h_flex().gap(5).flex_wrap()
        .child(this.chip("p-flaky", "Flaky tests", f.preset === "flaky", t, (cx) => this.openForm("flaky", cx)))
        .child(this.chip("p-verify", "Verification upkeep", f.preset === "verify", t, (cx) => this.openForm("verify", cx)))
        .child(this.chip("p-custom", "Custom", f.preset === "custom", t, (cx) => this.openForm("custom", cx))))
      .child(this.field(this.inputs.name, "Name", t))
      .child(this.field(this.inputs.dir, "Folder", t))
      .child(v_flex().gap(4).child(div().text_size(11).text_color(t.dim).child("How often"))
        .child(h_flex().gap(5)
          .child(this.chip("c-hourly", "Hourly", f.cadence === "hourly", t, () => { f.cadence = "hourly"; }))
          .child(this.chip("c-daily", "Daily", f.cadence === "daily", t, () => { f.cadence = "daily"; }))
          .child(this.chip("c-weekly", "Weekly", f.cadence === "weekly", t, () => { f.cadence = "weekly"; }))))
      .when(f.cadence === "weekly", (e) => e.child(h_flex().gap(4).flex_wrap()
        .children(DAYS.map((d, i) => this.chip(`d-${i}`, d, f.day === i, t, () => { f.day = i; })))))
      .child(this.field(this.inputs.at, f.cadence === "hourly" ? "Minute past the hour (HH:MM, the hour is ignored)" : "Time (HH:MM)", t))
      .child(this.field(this.inputs.prompt, "Prompt", t))
      .child(h_flex().gap(6)
        .child(this.small("save", "Save", t, () => this.save(), { solid: true }))
        .child(this.small("cancel", "Cancel", t, () => { this.adding = false; })));
  }

  jobRow(job, t, now) {
    const last = runs()[job.id];
    const armed = this.armed?.key === `remove:${job.id}`;
    return v_flex().id(`job-${job.id}`).w_full().px(12).py(8).gap(4).border_b(1).border_color(t.border)
      .child(h_flex().gap(8).items_center()
        .child(div().w(7).h(7).rounded(4).flex_none().bg(!job.enabled ? t.dim : last?.error ? t.ansi1 : t.ansi2))
        .child(div().flex_1().min_w(0).truncate().text_size(13).text_color(job.enabled ? t.foreground : t.dim).child(job.name))
        .child(div().flex_none().text_size(11).text_color(t.muted).child(when(job))))
      .child(div().pl(15).text_size(11).text_color(t.dim).truncate().child(tilde(job.dir)))
      .child(h_flex().pl(15).gap(10).text_size(11).text_color(t.dim)
        .child(div().child(job.enabled ? `next in ${span(nextDue(job, now) - now)}` : "paused"))
        .when(Boolean(last), (e) => e.child(div().id(`last-${job.id}`).text_color(last.error ? t.ansi1 : t.dim)
          .when(Boolean(last.address), (x) => x.cursor_pointer().hover((s) => s.text_color(t.foreground)).on_click(() => run("agent.focus", { terminal: last.address })))
          .child(last.error ? `last run failed ${span(now - last.at)} ago` : `last run ${span(now - last.at)} ago · ${last.address}`))))
      .child(h_flex().pl(15).pt(2).gap(5)
        .child(this.small(`run-${job.id}`, "Run now", t, () => start(job)))
        .child(this.small(`pause-${job.id}`, job.enabled ? "Pause" : "Resume", t, () => this.update(job.id, { enabled: !job.enabled })))
        .child(this.small(`rm-${job.id}`, armed ? "Press again to delete" : "Delete", t, (cx) => this.remove(job.id, cx), { danger: armed })));
  }

  renderButton(t) {
    const find = (n, id) => (n?.id === id ? n : (n?.children ?? []).map((c) => find(c, id)).find(Boolean));
    const root = layout();
    const panel = find(root, "panel");
    const on = panel && !panel.hidden && find(root, "panel-body")?.active === MOD;
    const failed = jobs().some((j) => runs()[j.id]?.error);
    return h_flex().size_full().items_center().justify_center().bg(t.chrome).border_b(1).border_color(t.border)
      .child(h_flex().id("schedules-button").h(26).px(8).gap(5).items_center().rounded(6).text_size(12)
        .bg(on ? t.selected : t.chrome).text_color(on ? t.foreground : t.muted).hover((s) => s.bg(t.hover)).cursor_pointer()
        .on_click(() => {
          if (on) run("layout.hide", { id: "panel" });
          else { run("layout.select", { stack: "panel-body", child: MOD }); run("layout.show", { id: "panel" }); }
        })
        .child(svg(`mods/${MOD}/clock.svg`).size(14))
        .child("Schedules")
        .when(failed, (e) => e.child(div().text_size(10).text_color(t.ansi1).child("▲"))));
  }

  render() {
    const t = theme();
    if (this.button) return this.renderButton(t);
    const now = Date.now();
    const list = jobs();
    return v_flex().id("schedules").size_full().min_h(0).bg(t.chrome).text_color(t.foreground)
      .child(h_flex().h(40).flex_none().px(12).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().font_semibold().child("Schedules"))
        .child(div().text_size(11).text_color(t.dim).child(String(list.length)))
        .child(div().flex_1())
        .when(!this.adding, (e) => e.child(this.small("add", "+ Add", t, (cx) => this.openForm("flaky", cx)))))
      .child(v_flex().id("schedules-body").flex_1().min_h(0).overflow_y_scroll().py(8).gap(6)
        .when(this.adding, (e) => e.child(this.formView(t)))
        .children(list.map((job) => this.jobRow(job, t, now)))
        .when(!list.length && !this.adding, (e) => e.child(div().px(12).py(6).text_size(12).text_color(t.dim)
          .child("No schedules yet. Add one to run an agent every hour, day or week, for example the flaky-tests check."))));
  }
}
