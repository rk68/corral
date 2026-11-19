// Contributions: your GitHub contribution calendar, as on your profile, drawn as pixel art in
// the app's colors, with streaks, what the work was (commits, PRs, reviews, issues) and where.
// Roles by props(): { button: true } is the "Activity" button beside the tabs; { pane: true }
// is a copy opened in a pane; otherwise the sidebar panel. fetch.mjs reads GitHub through gh.
// The pixel fonts are Herdr 98's (mods/win98/fonts/), which the app loads at start.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, theme, props, run, appHome, shared, setShared, layout } from "herdr";

const MOD = "contributions";
const CAL_MS = 10 * 60000;
const DETAIL_MS = 30 * 60000;
const TODAY = "contributions.today";
const BIG = "PxPlus IBM VGA 8x16";      // crisp at 16 and 32
const SMALL = "Pixelated MS Sans Serif"; // crisp at 11
const KINDS = ["Commits", "Pull requests", "Issues", "Reviews"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const GAP = 2;
const LABEL_W = 28;
const BLOCK = 6;   // one segment of a bar
const STACK = 8;   // blocks in a weekday column
const COMPACT_H = 300; // below this height the pane shows the squares only
const isVisible = () => (typeof visible === "function" ? visible() : true);
const num = (n) => n.toLocaleString("en-US");
const plural = (n, word) => `${num(n)} ${word}${n === 1 ? "" : "s"}`;
const dateOf = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
const nice = (s) => { const d = dateOf(s); return `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`; };
const ago = (ms) => (ms < 60000 ? "just now" : ms < 3600000 ? `${Math.round(ms / 60000)}m ago` : `${Math.round(ms / 3600000)}h ago`);
const small = (el) => el.font_family(SMALL).text_size(11);
const big = (el, size = 16) => el.font_family(BIG).text_size(size).line_height(`${size}px`);

// A folder whose GitHub account to show, for a gh wrapper that picks the account by folder.
// Unset: the app's own folder.
const ACCOUNT = "contributions.dir";
const accountDir = () => shared(ACCOUNT) || null;
// Repo names to leave out of "Where", for screen sharing: shared("contributions.hideRepos") = ["text", ...].
const shownRepos = (repos) => {
  const hide = (shared("contributions.hideRepos") ?? []).map((x) => String(x).toLowerCase());
  return repos.filter(([repo]) => !hide.some((x) => repo.toLowerCase().includes(x)));
};

async function fetchJson(arg, timeout, cwd) {
  const r = await exec("node", ["--no-warnings", `${appHome()}/mods/${MOD}/fetch.mjs`, arg], { timeout, ...(cwd ? { cwd } : {}) });
  let out;
  try { out = JSON.parse(r.stdout); } catch { throw new Error(r.stderr.trim().split("\n").pop() || `fetch.mjs exited ${r.code}`); }
  if (out.error) throw new Error(out.error);
  return out;
}

// Streaks over the calendar's days. Today with nothing yet does not end the current streak.
function streaks(days) {
  let best = 0, run = 0, bestEnd = null;
  for (const [date, n] of days) {
    run = n > 0 ? run + 1 : 0;
    if (run > best) { best = run; bestEnd = date; }
  }
  let current = 0;
  for (let i = days.length - 1; i >= 0; i--) {
    if (days[i][1] > 0) current++;
    else if (i === days.length - 1) continue;
    else break;
  }
  return { best, bestEnd, current };
}

export default class Contributions extends View {
  init(_props, cx) {
    this.button = Boolean(props()?.button);
    if (this.button) return;
    this.cal = null;
    this.detail = null;
    this.error = null;
    this.loading = false;
    this.loadingDetail = false;
    this.hover = null;   // the day under the pointer
    this.pinned = null;  // the day clicked
    this.width = 360;
    this.height = 800;
    this.inner = 332;    // the content column's width
    this.account = accountDir();
    this.load(cx, false);
    cx.timer.every(CAL_MS, (cx) => { if (isVisible()) this.load(cx, false); });
  }

  load(cx, force) {
    if (this.loading) return;
    this.loading = true;
    const account = this.account;
    cx.spawn(async (cx) => {
      try {
        const cal = await fetchJson("calendar", 60000, account);
        if (account !== this.account) { this.loading = false; this.load(cx, false); return; }
        this.cal = cal;
        this.error = null;
        const today = this.cal.weeks.at(-1)?.at(-1);
        setShared(TODAY, { count: today?.[1] ?? 0, total: this.cal.total });
      } catch (e) { this.error = String(e.message ?? e); }
      this.loading = false;
      cx.notify();
      if (force || !this.detail || Date.now() - this.detail.at > DETAIL_MS) this.loadDetail(cx, force);
    });
  }

  loadDetail(cx, force) {
    if (this.loadingDetail) return;
    this.loadingDetail = true;
    cx.notify();
    cx.spawn(async (cx) => {
      const account = this.account;
      try {
        const detail = await fetchJson(force ? "--force" : "detail", 600000, account);
        if (account === this.account) this.detail = detail;
      } catch { /* the calendar still shows */ }
      this.loadingDetail = false;
      if (account !== this.account) this.loadDetail(cx, false);
      cx.notify();
    });
  }

  // ---------- the button ----------

  renderButton(t) {
    const find = (n, id) => (n?.id === id ? n : (n?.children ?? []).map((c) => find(c, id)).find(Boolean));
    const root = layout();
    const panel = find(root, "panel");
    const on = panel && !panel.hidden && find(root, "panel-body")?.active === "activity";
    const today = shared(TODAY);
    return h_flex().size_full().items_center().justify_center().bg(t.chrome).border_b(1).border_color(t.border)
      .child(h_flex().id("activity-button").h(26).px(8).gap(5).items_center().rounded(6).text_size(12)
        .bg(on ? t.selected : t.chrome).text_color(on ? t.foreground : t.muted).hover((s) => s.bg(t.hover)).cursor_pointer()
        .on_click(() => {
          if (on) run("layout.hide", { id: "panel" });
          else { run("layout.select", { stack: "panel-body", child: "activity" }); run("layout.show", { id: "panel" }); }
        })
        .child(svg(`mods/${MOD}/icons/grid.svg`).size(14))
        .child("Activity")
        .when(today?.count > 0, (e) => e.child(div().text_size(10).text_color(t.accent).child(String(today.count)))));
  }

  // ---------- pixel pieces ----------

  levelColor(level, t) {
    return [t.raised, `${t.accent}38`, `${t.accent}70`, `${t.accent}b0`, t.accent][level] ?? t.raised;
  }

  // A box with square corners and a hard shadow down and to the right.
  box(el, t) {
    return div().relative().pr(3).pb(3)
      .child(div().absolute().left(3).top(3).right(0).bottom(0).bg(`${t.accent}26`))
      .child(el.relative().border(1).border_color(t.border).bg(t.background));
  }

  // "░▒▓ TITLE" on the left, a note on the right.
  section(title, extra, t) {
    return h_flex().w_full().justify_between().items_center().pt(8)
      .child(h_flex().gap(6).items_center()
        .child(small(div()).text_color(`${t.accent}90`).child("░▒▓"))
        .child(small(div()).text_color(t.muted).child(title.toUpperCase())))
      .child(small(div()).text_color(t.dim).child(extra ?? ""));
  }

  // A bar made of square segments, filled from the left.
  blocks(value, max, color, t) {
    const count = Math.max(4, Math.floor((this.inner + 2) / (BLOCK + 2)));
    const lit = value > 0 ? Math.max(1, Math.round((count * value) / Math.max(1, max))) : 0;
    return h_flex().gap(2).children(Array.from({ length: count }, (_, i) => div().w(BLOCK).h(BLOCK).bg(i < lit ? color : t.raised)));
  }

  barRow(label, value, max, color, t) {
    return v_flex().w_full().gap(3)
      .child(h_flex().w_full().gap(6)
        .child(small(div()).flex_1().min_w(0).truncate().text_color(t.foreground).child(label))
        .child(small(div()).flex_none().text_color(t.muted).child(num(value))))
      .child(this.blocks(value, max, color, t));
  }

  tile(label, value, sub, t, color) {
    return this.box(v_flex().p(8).gap(4)
      .child(small(div()).text_color(t.dim).child(label.toUpperCase()))
      .child(big(div(), 16).text_color(color ?? t.foreground).child(value))
      .child(small(div()).text_color(t.dim).truncate().child(sub)), t).flex_1().min_w(0);
  }

  // The calendar: as many recent weeks as fit, a column per week, Sunday on top.
  grid(t) {
    const all = this.cal.weeks;
    const room = this.width - 28 - 22 - LABEL_W;
    const cell = Math.max(8, Math.min(14, Math.floor(room / all.length) - GAP));
    const fit = Math.max(8, Math.floor((room + GAP) / (cell + GAP)));
    const weeks = all.slice(-fit);
    const today = all.at(-1).at(-1)[0];
    const selected = this.hover ?? this.pinned;
    let lastMonth = -1;
    const months = weeks.map((w, i) => {
      const m = dateOf(w[0][0]).getMonth();
      const show = m !== lastMonth && (i > 0 || dateOf(w[0][0]).getDate() <= 7) && i < weeks.length - 2;
      lastMonth = m;
      return small(div()).absolute().left(LABEL_W + i * (cell + GAP)).top(0).text_color(t.dim).child(show ? MONTHS[m] : "");
    });
    const top = 16;
    const labels = [1, 3, 5].map((d) => small(div()).absolute().left(0).top(top + d * (cell + GAP) + Math.round(cell / 2) - 7).text_color(t.dim).child(DAYS[d]));
    const cells = weeks.flatMap((w, i) => w.flatMap(([date, , level], d) => {
      const x = LABEL_W + i * (cell + GAP);
      const y = top + d * (cell + GAP);
      const cellEl = div().id(`day-${date}`).absolute().left(x).top(y).w(cell).h(cell).bg(this.levelColor(level, t)).cursor_pointer()
        .when(selected === date, (e) => e.border(1).border_color(t.foreground))
        .on_hover((over, cx) => { const next = over ? date : this.hover === date ? null : this.hover; if (next !== this.hover) { this.hover = next; cx.notify(); } })
        .on_click((_e, cx) => { this.pinned = this.pinned === date ? null : date; cx.notify(); });
      if (date !== today) return [cellEl];
      // Today: a block cursor that blinks around the cell.
      return [cellEl, div().absolute().left(x - 2).top(y - 2).w(cell + 4).h(cell + 4).border(1).border_color(t.foreground)
        .loop("opacity", { from: 0.15, to: 1, period: 1000 })];
    }));
    const height = top + 7 * (cell + GAP);
    const w = LABEL_W + weeks.length * (cell + GAP);
    return { el: div().relative().w(w).h(height).flex_none().children(months).children(labels).children(cells), shown: weeks.length, w };
  }

  // A short pane shows the squares only: no labels, header or stats, as big as the pane allows.
  bare(t) {
    const all = this.cal.weeks;
    const pad = 4;
    // Rows split the height. Columns get about the rows' height each, so a narrow pane shows
    // fewer, recent weeks and a wide one all 53. Both then stretch to fill the pane exactly.
    const row = (this.height - 2 * pad + GAP) / 7 - GAP;
    const count = Math.max(8, Math.min(all.length, Math.round((this.width - 2 * pad + GAP) / (row + GAP))));
    const weeks = all.slice(-count);
    const today = all.at(-1).at(-1)[0];
    return h_flex().id("bare").size_full().p(pad).gap(GAP)
      .children(weeks.map((w) => v_flex().flex_1().h_full().gap(GAP).children(Array.from({ length: 7 }, (_, d) => {
        const day = w[d];
        if (!day) return div().flex_1(); // days after today in this week
        const [date, , level] = day;
        return div().id(`b-${date}`).flex_1().w_full().bg(this.levelColor(level, t))
          .when(date === today, (e) => e.border(1).border_color(t.foreground).loop("opacity", { from: 0.35, to: 1, period: 1000 }));
      }))));
  }

  dayLine(t) {
    const date = this.hover ?? this.pinned;
    const line = v_flex().h(34).gap(3);
    if (!date) return line.child(small(div()).text_color(t.dim).child("> point at a day. click to keep it_"));
    const n = this.cal.weeks.flat().find((d) => d[0] === date)?.[1] ?? 0;
    const k = this.detail?.days?.[date];
    const parts = k ? k.map((v, i) => (v ? `${v} ${["commit", "PR", "issue", "review"][i]}${v === 1 ? "" : "s"}` : "")).filter(Boolean) : [];
    return line
      .child(h_flex().gap(8).items_center()
        .child(big(div()).text_color(n ? t.accent : t.muted).child(plural(n, "contribution")))
        .child(small(div()).text_color(t.muted).child(nice(date))))
      .child(small(div()).text_color(t.dim).truncate().child(parts.join(" · ") || (n ? "no detail from search for this day" : "")));
  }

  iconButton(id, label, t, onClick, spin) {
    return div().id(id).w(24).h(24).flex().items_center().justify_center().text_color(t.dim).cursor_pointer().flex_none()
      .hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click(onClick)
      .child(spin ? div().child(label).loop("opacity", { from: 0.3, to: 1, period: 700 }) : label);
  }

  // ---------- the panel ----------

  render(cx) {
    const t = theme();
    if (this.button) return this.renderButton(t);
    if (accountDir() !== this.account) {
      this.account = accountDir(); this.cal = null; this.detail = null; this.pinned = null;
      this.load(cx, false);
    }
    const root = v_flex().id("contrib").size_full().bg(t.chrome).text_color(t.foreground)
      .on_size_change((size, cx) => {
        if (Math.abs(size.width - this.width) > 1 || Math.abs(size.height - this.height) > 1) { this.width = size.width; this.height = size.height; cx.notify(); }
      });
    if (this.cal && this.height < COMPACT_H) return root.child(this.bare(t));
    const header = h_flex().h(40).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
      .child(div().w(8).h(8).bg(t.accent))
      .child(big(div()).child("ACTIVITY"))
      .when(!!this.cal, (e) => e.child(small(div()).text_color(t.dim).truncate().child(this.cal.login)))
      .child(div().flex_1())
      .when(!props()?.pane, (e) => e.child(this.iconButton("pane", "⧉", t, () => run("pane.split", { direction: "right", mod: MOD, props: { pane: true } }))))
      .when(!!this.cal, (e) => e.child(this.iconButton("profile", "↗", t, () => exec("open", [`https://github.com/${this.cal.login}`]))))
      .child(this.iconButton("refresh", "↻", t, (_e, cx) => this.load(cx, true), this.loading || this.loadingDetail));
    if (!this.cal) {
      return root.child(header).child(v_flex().flex_1().items_center().justify_center().gap(6).px(20).text_center()
        .child(big(div()).text_color(this.error ? t.blocked : t.muted).child(this.error ? "NO SIGNAL" : "LOADING..."))
        .child(small(div()).text_color(t.dim).child(this.error ?? "Reading your year from GitHub"))
        .when(!this.error, (e) => e.child(div().w(10).h(10).bg(t.accent).loop("opacity", { from: 0.1, to: 1, period: 600 }))));
    }
    const days = this.cal.weeks.flat();
    const today = days.at(-1);
    const week = this.cal.weeks.at(-1).reduce((a, d) => a + d[1], 0);
    const s = streaks(days);
    const busiest = days.reduce((a, d) => (d[1] > a[1] ? d : a), days[0]);
    const { el, shown, w } = this.grid(t);
    // In a wide pane the column stops at the calendar's width, so bars and tiles stay readable.
    this.inner = Math.min(this.width - 28, Math.max(332, w + 22));
    const span = shown >= this.cal.weeks.length ? "last 12 months" : `last ${Math.round(shown / 4.35)} months`;
    // Average per weekday over the year, Monday first, as a column of blocks.
    const perDay = [1, 2, 3, 4, 5, 6, 0].map((wd) => { const list = days.filter(([d]) => dateOf(d).getDay() === wd); return [wd, list.reduce((a, d) => a + d[1], 0) / Math.max(1, list.length)]; });
    const peak = Math.max(...perDay.map((x) => x[1]), 1);
    const totals = [0, 1, 2, 3].map((i) => Object.values(this.detail?.days ?? {}).reduce((a, v) => a + v[i], 0));
    const kindColors = [t.accent, t.ansi13, t.ansi11, t.ansi10];
    const col = v_flex().w(this.inner).gap(8)
      .child(h_flex().gap(10).items_end()
        .child(big(div(), 32).text_color(t.accent).child(num(this.cal.total)))
        .child(v_flex().pb(1)
          .child(small(div()).text_color(t.muted).child("contributions"))
          .child(small(div()).text_color(t.dim).child("in the last year"))))
      .child(this.box(v_flex().w_full().gap(6).p(10)
        .child(el)
        .child(h_flex().w_full().justify_between().items_center()
          .child(small(div()).text_color(t.dim).child(span))
          .child(h_flex().gap(3).items_center().child(small(div()).text_color(t.dim).mr(2).child("less"))
            .children([0, 1, 2, 3, 4].map((l) => div().w(9).h(9).bg(this.levelColor(l, t))))
            .child(small(div()).text_color(t.dim).ml(2).child("more")))), t))
      .child(this.dayLine(t))
      .child(h_flex().w_full().gap(8)
        .child(this.tile("Today", num(today[1]), `${num(week)} this week`, t, today[1] ? t.accent : t.muted))
        .child(this.tile("Streak", `${s.current}d`, s.current ? "and counting" : "start one today", t, s.current ? t.done : t.muted)))
      .child(h_flex().w_full().gap(8)
        .child(this.tile("Longest", `${s.best}d`, s.bestEnd ? `ended ${nice(s.bestEnd).slice(4)}` : "", t))
        .child(this.tile("Best day", num(busiest[1]), nice(busiest[0]).slice(4), t)))
      .child(this.section("By weekday", "average a day", t))
      .child(h_flex().w_full().gap(6).items_end().children(perDay.map(([wd, avg]) => {
        const lit = Math.max(avg > 0 ? 1 : 0, Math.round((STACK * avg) / peak));
        return v_flex().flex_1().items_center().gap(3)
          .child(v_flex().w_full().gap(2).children(Array.from({ length: STACK }, (_, i) =>
            div().w_full().h(5).bg(STACK - i <= lit ? (avg === peak ? t.accent : `${t.accent}80`) : t.raised))))
          .child(small(div()).text_color(avg === peak ? t.accent : t.dim).child(DAYS[wd].slice(0, 2)));
      })));
    if (this.detail) {
      const most = Math.max(...totals, 1);
      col.child(this.section("What it was", "from search", t))
        .children(KINDS.map((k, i) => this.barRow(k, totals[i], most, kindColors[i], t)))
        .child(this.section("Where", "top repos", t))
        .children(shownRepos(this.detail.repos).slice(0, 5).map(([repo, n], _i, all) => this.barRow(repo.replace(/^[^/]+\//, ""), n, all[0][1], `${t.accent}b0`, t)));
    } else {
      col.child(this.section("What it was", "", t))
        .child(small(div()).text_color(t.dim).child(this.loadingDetail ? "> counting commits, PRs and reviews_ the first time takes a few minutes" : "no detail yet"));
    }
    const body = v_flex().id("contrib-body").flex_1().min_h(0).py(12).items_center().overflow_y_scroll().child(col);
    const footer = h_flex().h(24).flex_none().px(14).items_center().justify_between().border_t(1).border_color(t.border)
      .child(small(div()).text_color(t.dim).child(`updated ${ago(Date.now() - this.cal.at)}`))
      .when(!!this.error, (e) => e.child(small(div()).text_color(t.blocked).truncate().child(this.error)));
    return root.child(header).child(body).child(footer);
  }
}
