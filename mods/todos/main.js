// Todos: a list the person adds to, worked by an orchestrator agent. Queued items go to the
// orchestrator as one prompt once it has been idle a while, so it is not pulled off its work for
// each item. It delegates to hc agents (labelled todos.item=<id>, which links them to the item),
// reports progress with todos.mjs, and raises questions with `todos.mjs ask`. Those show under
// "Needs you", and the answer goes back to the orchestrator only.
// Roles by props(): { button: true } is the tab-bar button and the only sender (it is always on
// screen, and mods run only while shown); otherwise the panel. The list is ~/.herdr/todos/todos.json.
import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import {
  exec, theme, props, run, shared, setShared, layout, notify, focused, panes, spaces, agents, terminals,
  appHome, home, checking, readTextFile, writeTextFile, watchFolder,
} from "herdr";
import { DIR, FILE, OPEN, answerMessage, change, empty, imagesOf, message, parse, ready, serialize } from "./logic.js";

const MOD = "todos";
const SEND_NOW = "todos.sendNow"; // the panel asks the button to send now: a time in ms
const QUIET_MS = 20000; // the orchestrator has been idle this long
const GATHER_MS = 15000; // and the newest item is this old, so items typed in a row go together
const RETRY_MS = 60000;
const TICK_MS = 3000;
const ARM_MS = 4000;
const SHOWN_DONE = 6;

const tilde = (p) => (p ?? "").replace(/^\/Users\/[^/]+/, "~");
const folder = () => `${home()}/${DIR}`;
const path = () => `${folder()}/${FILE}`;
const cli = () => `node ${tilde(appHome())}/mods/${MOD}/todos.mjs`;
const term = (address) => terminals().find((x) => x.address === address) ?? null;
const statusOf = (address) => (address ? term(address)?.status ?? null : null);

// Screenshots live in the app's data folder, because image() draws only files under the app folder.
const IMAGES = `data/${MOD}/images`;
const relative = (abs) => abs.slice(appHome().length + 1);

/** Saves the clipboard's image as a PNG and returns its path, or null when it holds none.
 * Herdr's own image paste is for its feedback form only, so this asks macOS directly. */
async function pasteImage() {
  const dir = `${appHome()}/${IMAGES}`;
  const file = `${dir}/${Date.now().toString(36)}.png`;
  await exec("mkdir", ["-p", dir]);
  const r = await exec("osascript", [
    "-e", "set png to the clipboard as «class PNGf»",
    "-e", `set f to open for access POSIX file "${file}" with write permission`,
    "-e", "write png to f",
    "-e", "close access f",
  ]).catch(() => ({ code: 1 }));
  return r.code === 0 ? file : null;
}

const forget = (paths) => { if (paths.length) exec("rm", ["-f", ...paths]).catch(() => null); };

function span(ms) {
  const m = Math.round(Math.abs(ms) / 60000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h` : `${Math.round(h / 24)}d`;
}

/** The list file, read and written with a check that nobody else wrote it in between. */
class Store {
  constructor() { this.text = null; this.state = empty(); }

  async load() {
    this.text = await readTextFile(path());
    this.state = parse(this.text);
  }

  async write(op) {
    for (let attempt = 0; ; attempt++) {
      const next = change(this.state, op);
      const text = serialize(next);
      try {
        await writeTextFile(path(), text, this.text);
        this.text = text;
        this.state = next;
        return;
      } catch (e) {
        if (attempt >= 3) throw e;
        await this.load(); // the CLI wrote meanwhile: apply the step to its version
      }
    }
  }
}

/** The agents working on an item: those it records, and live terminals labelled with its id. */
function agentsFor(item) {
  const all = terminals();
  const labelled = all.filter((x) => x.labels?.["todos.item"] === item.id).map((x) => x.address);
  // The orchestrator may record an agent by name or by address: resolve both to one terminal.
  const found = [...(item.agents ?? []), ...labelled].map((a) => all.find((x) => x.address === a || x.name === a) ?? { address: a, state: "finished" });
  return [...new Map(found.map((x) => [x.address, x])).values()];
}

/** The folders to look in for the current repo, as the Schedules panel does. */
function candidateDirs() {
  const space = spaces().find((s) => s.active);
  const f = focused();
  const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  return [...new Set([pane?.cwd, f?.cwd, space?.folder].filter(Boolean))];
}

async function currentRepo() {
  for (const dir of candidateDirs()) {
    const r = await exec("git", ["rev-parse", "--show-toplevel"], { cwd: dir, timeout: 5000 }).catch(() => null);
    if (r?.code === 0 && r.stdout.trim()) return r.stdout.trim();
  }
  return null;
}

export default class Todos extends View {
  init(_props, cx) {
    this.button = Boolean(props()?.button);
    this.store = new Store();
    cx.spawn(async (cx) => {
      if (!checking()) await exec("mkdir", ["-p", folder()]).catch(() => null);
      await this.store.load();
      cx.notify();
      for (;;) {
        await watchFolder(folder()).catch(() => null);
        await this.store.load();
        cx.notify();
      }
    });
    if (this.button) {
      this.idleSince = null;
      this.watching = null;
      this.busy = false;
      this.failedAt = 0;
      this.handled = shared(SEND_NOW) ?? 0; // a request from before this start is old
      if (!checking()) cx.timer.every(TICK_MS, (cx) => { this.tick().finally(() => cx.notify()); });
      return;
    }
    this.picking = false;
    this.armed = null; // { key, until }
    this.showAllDone = false;
    this.answers = {}; // item id -> InputState, made when the person opens the answer box
    this.answerImages = {}; // item id -> screenshot paths for that answer
    this.pending = []; // screenshots for the todo being typed
    this.input = InputState.new({ placeholder: "Add a todo and press Enter. Paste screenshots here too." });
    this.input.on("submit", (_e, cx) => this.add(cx));
    this.input.on("paste_other", (_e, cx) => this.paste(this.pending, cx));
    cx.timer.every(10000, (cx) => { this.store.load().then(() => cx.notify()); });
    cx.timer.every(1000, (cx) => { if (this.armed && Date.now() > this.armed.until) { this.armed = null; cx.notify(); } });
  }

  // ---------- the sender (button role) ----------

  async tick() {
    if (this.busy) return;
    const s = this.store.state;
    const now = Date.now();
    if (s.orchestrator !== this.watching) { this.watching = s.orchestrator; this.idleSince = null; }
    const status = statusOf(s.orchestrator);
    if (status === "idle" || status === "done") this.idleSince ??= now;
    else this.idleSince = null;

    this.busy = true;
    try {
      // Record agents the orchestrator started with the item's label, so the item shows as doing.
      for (const item of s.items.filter((i) => i.status === "sent" || i.status === "doing")) {
        const known = new Set((item.agents ?? []).flatMap((a) => [a, term(a)?.address, terminals().find((x) => x.name === a)?.address]));
        const fresh = agentsFor(item).map((a) => a.address).filter((a) => !known.has(a));
        if (fresh.length) await this.store.write({ type: "start", id: item.id, agents: fresh });
      }
      const queued = this.store.state.items.filter((i) => i.status === "queued");
      const asked = shared(SEND_NOW) ?? 0;
      const forced = asked > this.handled;
      if (forced) this.handled = asked;
      const due = forced || (now - this.failedAt > RETRY_MS &&
        ready({ queued, status, idleSince: this.idleSince, now, quietMs: QUIET_MS, gatherMs: GATHER_MS }));
      if (due && queued.length && s.orchestrator && status !== "blocked") await this.send(s.orchestrator, queued);
    } catch (e) {
      notify({ title: "Todos", body: String(e.message ?? e), level: "error" });
    } finally {
      this.busy = false;
    }
  }

  async send(orchestrator, queued) {
    const r = await exec("hc", ["send", orchestrator, message(queued, cli())], { timeout: 120000 });
    if (r.code !== 0) {
      this.failedAt = Date.now();
      throw new Error(`Could not send to ${orchestrator}: ${(r.stderr || r.stdout).trim().split("\n").pop()}`);
    }
    await this.store.write({ type: "sent", ids: queued.map((i) => i.id) });
    this.idleSince = null;
  }

  // ---------- panel actions ----------

  paste(into, cx) {
    cx.spawn(async (cx) => {
      const file = await pasteImage();
      if (file) into.push(file);
      else notify({ title: "Todos", body: "The clipboard has no image.", level: "info" });
      cx.notify();
    });
  }

  add(cx) {
    const text = this.input.value().trim();
    if (!text) return;
    const images = this.pending;
    this.input.set_value("");
    this.pending = [];
    cx.spawn(async (cx) => {
      const dir = await currentRepo();
      await this.store.write({ type: "add", text, dir, images }).catch((e) => notify({ title: "Todos", body: String(e.message ?? e), level: "error" }));
      cx.notify();
    });
  }

  step(op, cx) {
    const gone = op.type === "remove" ? this.store.state.items.filter((i) => i.id === op.id)
      : op.type === "clear" ? this.store.state.items.filter((i) => !OPEN.includes(i.status)) : [];
    cx.spawn(async (cx) => {
      if (gone.length) forget(imagesOf(gone));
      await this.store.write(op).catch((e) => notify({ title: "Todos", body: String(e.message ?? e), level: "error" }));
      cx.notify();
    });
  }

  armedFor(key, cx) {
    if (this.armed?.key === key) { this.armed = null; return true; }
    this.armed = { key, until: Date.now() + ARM_MS };
    cx.notify();
    return false;
  }

  /** Sends the person's answer to the orchestrator, then records it on the item. */
  answer(item, cx, picked) {
    const text = (picked ?? this.answers[item.id]?.value() ?? "").trim();
    const orchestrator = this.store.state.orchestrator;
    if (!text || !orchestrator || this.sending === item.id) return;
    this.sending = item.id; // one click sends once
    cx.spawn(async (cx) => {
      const images = this.answerImages[item.id] ?? [];
      const r = await exec("hc", ["send", orchestrator, answerMessage(item, text, images)], { timeout: 120000 }).catch((e) => ({ code: 1, stderr: String(e) }));
      if (r.code !== 0) notify({ title: "Todos", body: `Could not send the answer: ${(r.stderr || r.stdout).trim()}`, level: "error" });
      else { delete this.answers[item.id]; delete this.answerImages[item.id]; await this.store.write({ type: "answer", id: item.id, note: text, images }); }
      this.sending = null;
      cx.notify();
    });
  }

  // ---------- render ----------

  small(id, label, t, onClick, { solid, danger } = {}) {
    return div().id(id).h(22).px(8).flex().items_center().rounded(5).text_size(11).flex_none().cursor_pointer()
      .when(Boolean(solid) && !danger, (e) => e.bg(t.solid).text_color(t.solid_foreground))
      .when(Boolean(danger), (e) => e.bg(t.ansi1).text_color(t.background))
      .when(!solid && !danger, (e) => e.border_1().border_color(t.border).text_color(t.foreground).hover((s) => s.bg(t.hover)))
      .on_click((_e, cx) => { cx.stop_propagation(); onClick(cx); cx.notify(); }).child(label);
  }

  /** Screenshot thumbnails. Click one to open it. With `list`, each has a × that takes it out. */
  thumbs(id, paths, t, list) {
    return h_flex().gap(6).flex_wrap().children(paths.map((p, n) => div().id(`${id}-${n}`).relative().flex_none()
      .child(div().id(`${id}-${n}-img`).w(72).h(48).rounded(5).overflow_hidden().border_1().border_color(t.border).cursor_pointer()
        .hover((s) => s.border_color(t.accent)).on_click(() => exec("open", [p]).catch(() => null))
        .child(image(relative(p)).size_full()))
      .when(Boolean(list), (e) => e.child(div().id(`${id}-${n}-x`).absolute().top(-4).right(-4).w(16).h(16).rounded(8)
        .flex().items_center().justify_center().text_size(10).bg(t.raised).border_1().border_color(t.border).cursor_pointer()
        .on_click((_e, cx) => { list.splice(n, 1); forget([p]); cx.notify(); }).child("×")))));
  }

  dot(status, t) {
    const c = { working: t.ansi4, blocked: t.ansi1, error: t.ansi1, idle: t.ansi2, done: t.ansi2 }[status] ?? t.dim;
    return div().w(7).h(7).rounded(4).flex_none().bg(c);
  }

  orchestratorBar(t, s) {
    const o = s.orchestrator ? term(s.orchestrator) : null;
    const queued = s.items.filter((i) => i.status === "queued").length;
    const status = o?.status ?? null;
    const where = o?.labels?.where ?? tilde(o?.cwd);
    const wait = !queued ? null
      : !s.orchestrator ? "Choose an orchestrator to send the queue to."
      : !o ? `${s.orchestrator} has ended. Choose another orchestrator.`
      : status === "working" ? `${queued} queued. They go to ${s.orchestrator} when it stops working.`
      : status === "blocked" ? `${queued} queued. ${s.orchestrator} is waiting for you.`
      : `${queued} queued. They go to ${s.orchestrator} after ${QUIET_MS / 1000}s idle.`;
    return v_flex().px(12).py(8).gap(6).border_b(1).border_color(t.border)
      .child(h_flex().gap(8).items_center()
        .child(this.dot(status, t))
        .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(o ? t.foreground : t.muted)
          .child(o ? `Orchestrator ${o.name ?? o.address} · ${o.title || where} · ${status ?? "no status"}` : "No orchestrator"))
        .when(Boolean(o), (e) => e.child(this.small("orch-focus", "Open", t, () => run("agent.focus", { terminal: o.address }))))
        .child(this.small("orch-pick", this.picking ? "Close" : "Change", t, () => { this.picking = !this.picking; })))
      .when(Boolean(wait), (e) => e.child(div().pl(15).text_size(11).text_color(t.dim).child(wait)))
      .when(this.picking || !s.orchestrator, (e) => e.child(this.picker(t, s)));
  }

  picker(t, s) {
    // The focused agent first, so "click the pane, then pick the top row" works without its id.
    const list = [...agents()].sort((a, b) => b.focused - a.focused);
    return v_flex().gap(2).pt(2)
      .child(div().text_size(11).text_color(t.dim).child("Pick the agent that runs the list"))
      .children(list.map((a) => h_flex().id(`pick-${a.address}`).py(4).px(6).gap(8).items_center().rounded(5).cursor_pointer()
        .when(a.address === s.orchestrator, (x) => x.bg(t.selected)).hover((x) => x.bg(t.hover))
        .on_click((_e, cx) => { this.picking = false; this.step({ type: "orchestrator", address: a.address }, cx); })
        .child(this.dot(a.status, t))
        .child(v_flex().flex_1().min_w(0)
          .child(div().truncate().text_size(12).child(a.title || a.program?.name || a.address))
          .child(div().truncate().text_size(11).text_color(t.dim).child(`${a.address} · ${a.program?.name ?? ""} · ${a.space_name} / ${a.tab_name}`)))
        .when(a.focused, (x) => x.child(div().flex_none().text_size(10).text_color(t.accent).child("this pane")))))
      .when(!list.length, (x) => x.child(div().text_size(11).text_color(t.dim).child("No agents are running. Start Claude or Codex in a pane first.")));
  }

  agentChips(item, t) {
    return h_flex().pl(22).gap(5).flex_wrap().children(agentsFor(item).map((a) => {
      const gone = a.state === "finished";
      return h_flex().id(`ag-${item.id}-${a.address}`).h(20).px(6).gap(5).items_center().rounded(5).text_size(11)
        .border_1().border_color(t.border).text_color(gone ? t.dim : t.foreground)
        .when(!gone, (x) => x.cursor_pointer().hover((s) => s.bg(t.hover)).on_click(() => run("agent.focus", { terminal: a.address })))
        .child(this.dot(gone ? null : a.status, t))
        .child(`${a.name ?? a.address}${gone ? " · ended" : a.status ? ` · ${a.status}` : ""}`);
    }));
  }

  checkbox(item, t) {
    const closed = !OPEN.includes(item.status);
    return div().id(`cb-${item.id}`).w(14).h(14).mt(2).flex_none().rounded(4).flex().items_center().justify_center()
      .text_size(10).cursor_pointer().border_1()
      .border_color(item.status === "done" ? t.ansi2 : t.border)
      .when(item.status === "done", (e) => e.bg(t.ansi2).text_color(t.background).child("✓"))
      .when(item.status === "dropped", (e) => e.text_color(t.dim).child("×"))
      .on_click((_e, cx) => this.step(closed ? { type: "reopen", id: item.id } : { type: "done", id: item.id, note: "checked off by hand" }, cx));
  }

  row(item, t, now) {
    const closed = !OPEN.includes(item.status);
    const key = `rm:${item.id}`;
    const armed = this.armed?.key === key;
    const since = { queued: item.added, sent: item.sent, doing: item.started }[item.status] ?? item.ended;
    const what = { queued: "queued", sent: `sent to ${this.store.state.orchestrator ?? "the orchestrator"}`, doing: "in progress", done: "done", dropped: "dropped" }[item.status];
    return v_flex().id(`item-${item.id}`).w_full().px(12).py(7).gap(4).border_b(1).border_color(t.border)
      .child(h_flex().gap(8).items_start()
        .child(this.checkbox(item, t))
        .child(div().flex_1().min_w(0).text_size(13).text_color(closed ? t.muted : t.foreground).child(item.text))
        .child(this.small(`rm-${item.id}`, armed ? "Remove?" : "×", t, (cx) => { if (this.armedFor(key, cx)) this.step({ type: "remove", id: item.id }, cx); }, { danger: armed })))
      .child(div().pl(22).text_size(11).text_color(t.dim).truncate()
        .child(`${item.id} · ${what} ${span(now - (since ?? now))}${span(now - (since ?? now)) === "now" ? "" : " ago"}${item.dir ? ` · ${tilde(item.dir)}` : ""}`))
      .when(Boolean(item.images?.length), (e) => e.child(this.thumbs(`im-${item.id}`, item.images, t).pl(22)))
      .when(Boolean(item.note), (e) => e.child(div().pl(22).text_size(11).text_color(t.muted).child(item.note)))
      .when(agentsFor(item).length > 0, (e) => e.child(this.agentChips(item, t)));
  }

  /** An item the orchestrator raised: its question and an answer box. */
  askRow(item, t) {
    const box = this.answers[item.id];
    return v_flex().id(`ask-${item.id}`).mx(10).p(10).gap(6).rounded(8).border_1().border_color(t.ansi3).bg(t.raised)
      .child(h_flex().gap(6).items_center()
        .child(div().text_size(11).text_color(t.ansi3).child(`${item.id} asks`))
        .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(item.text)))
      .child(this.question(item.question, t))
      .when(Boolean(item.options?.length), (e) => e.child(this.options(item, t)))
      .when(Boolean(item.images?.length), (e) => e.child(this.thumbs(`aim-${item.id}`, item.images, t)))
      .when(agentsFor(item).length > 0, (e) => e.child(this.agentChips(item, t).pl(0)))
      .when(!box, (e) => e.child(h_flex().gap(5)
        .child(this.small(`ans-open-${item.id}`, item.options?.length ? "Something else" : "Answer", t, () => {
          const state = InputState.new({ placeholder: "Your answer, Enter to send. Paste screenshots here too." });
          state.on("submit", (_e, cx) => this.answer(item, cx));
          this.answerImages[item.id] = [];
          state.on("paste_other", (_e, cx) => this.paste(this.answerImages[item.id], cx));
          this.answers[item.id] = state;
        }, { solid: !item.options?.length }))
        .child(this.small(`ans-done-${item.id}`, "Mark answered", t, (cx) => this.step({ type: "answer", id: item.id, note: "answered in the orchestrator's terminal" }, cx)))
        .when(Boolean(this.store.state.orchestrator), (x) => x.child(this.small(`ans-go-${item.id}`, "Open orchestrator", t, () => run("agent.focus", { terminal: this.store.state.orchestrator }))))))
      .when(Boolean(box), (e) => e.child(h_flex().gap(6).items_center()
        .child(div().flex_1().h(30).px(8).flex().items_center().rounded(7).border_1().border_color(t.border).bg(t.chrome)
          .child(Input.new(box).h_full().text_size(12).text_color(t.foreground)))
        .child(this.small(`ans-send-${item.id}`, "Send", t, (cx) => this.answer(item, cx), { solid: true }))))
      .when(Boolean(this.answerImages[item.id]?.length), (e) => e.child(this.thumbs(`ans-im-${item.id}`, this.answerImages[item.id], t, this.answerImages[item.id])));
  }

  /** A question as the agent wrote it: the first line is the ask, `- ` lines are bullets, `1.` lines
   * are numbered, and a blank line is a gap. **bold** markers are dropped. */
  question(text, t) {
    const plain = (x) => x.replace(/\*\*(.+?)\*\*/g, "$1");
    let body = String(text ?? "");
    // A one-line question with inline parts "(A) ... (B) ..." gets each part on its own line.
    if (!body.includes("\n") && (body.match(/(^|\s)\(([A-Z]|\d{1,2})\)\s/g) ?? []).length >= 2) {
      body = body.replace(/;?\s+\((?=([A-Z]|\d{1,2})\)\s)/g, "\n(");
    }
    let first = true;
    return v_flex().gap(3).children(body.split("\n").map((raw, n) => {
      const line = raw.trim();
      if (!line) return div().h(4);
      const bullet = /^[-*•]\s+(.*)$/.exec(line);
      const num = /^(\d+)[.)]\s+(.*)$/.exec(line) ?? /^\(([A-Z]|\d{1,2})\)\s+(.*)$/.exec(line);
      if (bullet || num) {
        return h_flex().id(`q-${n}`).gap(6).items_start().pl(4).text_size(12).text_color(t.foreground)
          .child(div().flex_none().min_w(14).text_color(t.dim).child(bullet ? "•" : /\d/.test(num[1]) ? `${num[1]}.` : `${num[1]}`))
          .child(div().flex_1().min_w(0).child(plain(bullet ? bullet[1] : num[2])));
      }
      const head = first;
      first = false;
      return div().text_size(head ? 13 : 12).when(head, (e) => e.font_semibold()).text_color(head ? t.foreground : t.muted).child(plain(line));
    }));
  }

  /** The agent's choices, one button each. A click sends that choice as the answer. */
  options(item, t) {
    const busy = this.sending === item.id;
    return v_flex().gap(4).children(item.options.map((o, n) => h_flex().id(`opt-${item.id}-${n}`).w_full().px(8).py(6).gap(8)
      .items_start().rounded(6).border_1().border_color(t.border).bg(t.chrome).cursor_pointer()
      .hover((s) => s.border_color(t.accent).bg(t.hover))
      .on_click((_e, cx) => { if (!busy) this.answer(item, cx, o); cx.notify(); })
      .child(div().flex_none().w(16).h(16).rounded(4).flex().items_center().justify_center().text_size(10)
        .bg(n === 0 ? t.accent : t.selected).text_color(n === 0 ? t.background : t.foreground).child(String(n + 1)))
      .child(div().flex_1().min_w(0).text_size(12).child(o))));
  }

  section(id, label, count, t, extra) {
    return h_flex().id(id).px(12).pt(10).pb(4).gap(6).items_center()
      .child(div().text_size(11).font_semibold().text_color(t.muted).child(label.toUpperCase()))
      .child(div().text_size(11).text_color(t.dim).child(String(count)))
      .child(div().flex_1())
      .when(Boolean(extra), (e) => e.child(extra));
  }

  renderButton(t) {
    const find = (n, id) => (n?.id === id ? n : (n?.children ?? []).map((c) => find(c, id)).find(Boolean));
    const root = layout();
    const panel = find(root, "panel");
    const on = panel && !panel.hidden && find(root, "panel-body")?.active === MOD;
    const items = this.store.state.items;
    const asks = items.filter((i) => i.question && OPEN.includes(i.status)).length;
    const open = items.filter((i) => OPEN.includes(i.status)).length;
    return h_flex().size_full().items_center().justify_center().bg(t.chrome).border_b(1).border_color(t.border)
      .child(h_flex().id("todos-button").h(26).px(8).gap(5).items_center().rounded(6).text_size(12)
        .bg(on ? t.selected : t.chrome).text_color(on ? t.foreground : t.muted).hover((s) => s.bg(t.hover)).cursor_pointer()
        .on_click(() => {
          if (on) run("layout.hide", { id: "panel" });
          else { run("layout.select", { stack: "panel-body", child: MOD }); run("layout.show", { id: "panel" }); }
        })
        .child(svg(`mods/${MOD}/check.svg`).size(14))
        .child("Todos")
        .when(asks > 0, (e) => e.child(div().px(4).rounded(4).text_size(10).bg(t.ansi3).text_color(t.background).child(`${asks}?`)))
        .when(!asks && open > 0, (e) => e.child(div().text_size(10).text_color(t.dim).child(String(open)))));
  }

  render() {
    const t = theme();
    if (this.button) return this.renderButton(t);
    const now = Date.now();
    const s = this.store.state;
    const asks = s.items.filter((i) => i.question && OPEN.includes(i.status));
    const working = s.items.filter((i) => (i.status === "sent" || i.status === "doing") && !i.question);
    const queued = s.items.filter((i) => i.status === "queued");
    const closed = s.items.filter((i) => !OPEN.includes(i.status)).sort((a, b) => (b.ended ?? 0) - (a.ended ?? 0));
    const shownDone = this.showAllDone ? closed : closed.slice(0, SHOWN_DONE);
    return v_flex().id("todos").size_full().min_h(0).bg(t.chrome).text_color(t.foreground)
      .child(h_flex().h(40).flex_none().px(12).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().font_semibold().child("Todos"))
        .child(div().text_size(11).text_color(t.dim).child(String(asks.length + working.length + queued.length)))
        .child(div().flex_1())
        .when(queued.length > 0 && Boolean(s.orchestrator), (e) => e.child(this.small("send-now", "Send now", t, () => setShared(SEND_NOW, Date.now())))))
      .child(this.orchestratorBar(t, s))
      .child(v_flex().flex_none().px(10).py(8).gap(8).border_b(1).border_color(t.border)
        .child(h_flex().gap(6).items_center()
          .child(div().flex_1().min_w(0).h(30).px(8).flex().items_center().rounded(7).border_1().border_color(t.border).bg(t.background)
            .child(Input.new(this.input).h_full().text_size(12).text_color(t.foreground)))
          .child(this.small("paste", "Paste image", t, (cx) => this.paste(this.pending, cx))))
        .when(this.pending.length > 0, (e) => e.child(this.thumbs("pending", this.pending, t, this.pending))))
      .child(v_flex().id("todos-body").flex_1().min_h(0).overflow_y_scroll().pb(10)
        .when(asks.length > 0, (e) => e.child(this.section("h-asks", "Needs you", asks.length, t)).child(v_flex().gap(6).children(asks.map((i) => this.askRow(i, t)))))
        .when(working.length > 0, (e) => e.child(this.section("h-work", "In progress", working.length, t)).children(working.map((i) => this.row(i, t, now))))
        .when(queued.length > 0, (e) => e.child(this.section("h-queue", "Queued", queued.length, t)).children(queued.map((i) => this.row(i, t, now))))
        .when(closed.length > 0, (e) => e
          .child(this.section("h-done", "Done", closed.length, t, this.small("clear", "Clear", t, (cx) => this.step({ type: "clear" }, cx))))
          .children(shownDone.map((i) => this.row(i, t, now)))
          .when(closed.length > SHOWN_DONE, (x) => x.child(div().id("more-done").px(12).py(6).text_size(11).text_color(t.muted).cursor_pointer()
            .hover((h) => h.text_color(t.foreground)).on_click((_e, cx) => { this.showAllDone = !this.showAllDone; cx.notify(); })
            .child(this.showAllDone ? "Show fewer" : `Show all ${closed.length}`))))
        .when(!s.items.length, (e) => e.child(div().px(12).py(10).text_size(12).text_color(t.dim)
          .child("Nothing on the list. Add a todo above. It waits here until the orchestrator is free, then goes to it with the rest of the queue."))));
  }
}
