// Plan usage for every Claude Code and Codex account, and Codex's banked resets.
// Claude: ./accounts-usage.mjs. If ~/.local/bin/agent-account is installed (not part of this mod),
// the panel also adds, signs in and starts extra accounts.
// Codex: `codex app-server` through ./codex-usage.mjs, one account per ~/.local/bin/codex-<name>
// launcher that sets CODEX_HOME (read limits, use a banked reset).

import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, appHome, home, theme, checking, notify, run, nextCommand } from "herdr";

const ACCOUNTS_EVERY_MS = 60 * 1000;
const CODEX_EVERY_MS = 5 * 60 * 1000;
// Heights of this panel's layout block ("usage" in layouts/herdr-usage.json).
const EXPANDED_PX = 490;
const COLLAPSED_ROW_PX = 22;
const COLLAPSED_BASE_PX = 36;
const CLAUDE_ORANGE = "#d97757";
const CLAUDE_USAGE_URL = "https://claude.ai/settings/usage";
// While a sign-in tab is open, refresh this often, this many times (3 minutes).
const SIGN_IN_POLL_MS = 5000;
const SIGN_IN_POLLS = 36;

const button = (id, label, bg, fg, onClick) =>
  h_flex()
    .id(id)
    .h(22)
    .px(8)
    .items_center()
    .rounded(6)
    .bg(bg)
    .text_color(fg)
    .text_size(11)
    .cursor_pointer()
    .hover((s) => s.opacity(0.85))
    .on_click(onClick)
    .child(label);

function untilText(epochSeconds) {
  const ms = epochSeconds * 1000 - Date.now();
  if (ms <= 0) return "now";
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

function agoText(epochSeconds) {
  const m = Math.floor((Date.now() / 1000 - epochSeconds) / 60);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const dateText = (epochSeconds) => {
  const d = new Date(epochSeconds * 1000);
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
};

function windowLabel(mins) {
  if (mins === 300) return "5-hour";
  if (mins === 10080) return "Weekly";
  if (!mins) return "Limit";
  return mins % 1440 === 0 ? `${mins / 1440}-day` : `${Math.round(mins / 60)}-hour`;
}

// The idempotency key stays with one click, so a retry of the same attempt can't spend twice.
const newKey = () => `herdr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

export default class Usage extends View {
  init(_props, cx) {
    this.accounts = null; // accounts-usage.mjs output
    this.accountsError = null;
    this.adding = false;
    this.canManage = false; // ~/.local/bin/agent-account is installed: show Add account and Sign in
    this.codexAccounts = null; // codex-usage.mjs read output
    this.codexError = null;
    this.codexLoading = false;
    this.confirming = null; // credit id waiting for a second click
    this.redeeming = null; // { id, key }
    this.collapsed = false;
    try {
      this.collapsed = localStorage.getItem("collapsed") === "1";
    } catch {}
    if (checking()) return;
    // The layout file holds one height: match it to the remembered state.
    this.resize();
    // `herdr-app do usage.toggle` (or a key bound to it) collapses and expands the panel.
    cx.spawn(async (cx) => {
      for (;;) {
        if ((await nextCommand()) === "toggle") this.toggle(cx);
      }
    });
    cx.spawn(async (cx) => {
      this.canManage = (await exec("test", ["-x", `${home()}/.local/bin/agent-account`])).code === 0;
      cx.notify();
    });
    this.loadAccounts(cx);
    this.loadCodex(cx);
    cx.timer.every(ACCOUNTS_EVERY_MS, (cx) => this.loadAccounts(cx));
    cx.timer.every(CODEX_EVERY_MS, (cx) => this.loadCodex(cx));
  }

  loadAccounts(cx) {
    cx.spawn(async (cx) => {
      try {
        const r = await exec("node", [`${appHome()}/mods/usage/accounts-usage.mjs`], { timeout: 40000 });
        if (r.code !== 0) throw new Error(r.stderr.trim() || `exit ${r.code}`);
        const count = this.accounts?.length;
        this.accounts = JSON.parse(r.stdout.trim().split("\n").pop());
        this.accountsError = null;
        if (this.collapsed && count !== this.accounts.length) this.resize();
      } catch (e) {
        this.accountsError = String(e?.message ?? e);
      }
      cx.notify();
    });
  }

  agentAccount(args) {
    return exec(`${home()}/.local/bin/agent-account`, args, { timeout: 15000 }).then((r) => {
      if (r.code !== 0) throw new Error(r.stderr.trim() || `exit ${r.code}`);
      return r.stdout.trim();
    });
  }

  // A new tab in the shown space runs the browser sign-in, so the person sees its prompts.
  signIn(name, cx) {
    run("tab.new", { name: `Sign in: Claude ${name}`, argv: [`${home()}/.local/bin/agent-account`, "login", name] });
    this.pollSoon(cx, SIGN_IN_POLLS);
  }

  pollSoon(cx, times) {
    cx.timer.after(SIGN_IN_POLL_MS, (cx) => {
      this.loadAccounts(cx);
      if (times > 1 && this.accounts?.some((a) => a.needsLogin)) this.pollSoon(cx, times - 1);
    });
  }

  addAccount(cx) {
    if (this.adding) return;
    this.adding = true;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const name = await this.agentAccount(["add"]);
        this.signIn(name, cx);
        this.loadAccounts(cx);
      } catch (e) {
        notify({ title: "Could not add a Claude account", body: String(e?.message ?? e), level: "error" });
      }
      this.adding = false;
      cx.notify();
    });
  }

  startCodex(a) {
    const argv = a.name === "default" ? ["codex"] : [`${home()}/.local/bin/codex-${a.name}`];
    run("tab.new", { name: `Codex ${a.name}`, argv });
  }

  startAccount(a) {
    // The default login has a launcher only once it is named (agent-account rename default work).
    const argv = a.isDefault && a.name === "default" ? ["claude"] : [`${home()}/.local/bin/claude-${a.name}`];
    run("tab.new", { name: `Claude ${a.name}`, argv });
  }

  // The layout file holds one height: match it to the state and the number of rows.
  resize() {
    const rows = (this.accounts?.length ?? 1) + (this.codexAccounts?.length ?? 1);
    run("layout.resize", { id: "usage", px: this.collapsed ? COLLAPSED_BASE_PX + rows * COLLAPSED_ROW_PX : EXPANDED_PX });
  }

  codexScript(args) {
    return exec("node", [`${appHome()}/mods/usage/codex-usage.mjs`, ...args], { timeout: 40000 }).then((r) => {
      const out = JSON.parse(r.stdout.trim().split("\n").pop() || "{}");
      if (r.code !== 0 || out.error) throw new Error(out.error ?? (r.stderr.trim() || `exit ${r.code}`));
      return out;
    });
  }

  loadCodex(cx) {
    if (this.codexLoading) return;
    this.codexLoading = true;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const count = this.codexAccounts?.length;
        this.codexAccounts = await this.codexScript(["read"]);
        this.codexError = null;
        if (this.collapsed && count !== this.codexAccounts.length) this.resize();
      } catch (e) {
        this.codexError = String(e?.message ?? e);
      }
      this.codexLoading = false;
      cx.notify();
    });
  }

  redeem(credit, a, cx) {
    if (this.redeeming) return;
    this.confirming = null;
    this.redeeming = { id: credit.id, key: newKey() };
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const { outcome } = await this.codexScript(["consume", credit.id, this.redeeming.key, a.home]);
        const text = {
          reset: [`Codex ${a.name} limits reset`, "success"],
          nothingToReset: ["Nothing to reset: the reset was not used", "info"],
          noCredit: ["That reset is no longer available", "warning"],
          alreadyRedeemed: ["That reset was already used", "warning"],
        }[outcome] ?? [`Reset result: ${outcome}`, "info"];
        notify({ title: text[0], level: text[1], timeout: 6000 });
      } catch (e) {
        notify({ title: "Codex reset failed", body: String(e?.message ?? e), level: "error" });
      }
      this.redeeming = null;
      this.loadCodex(cx);
    });
  }

  toggle(cx) {
    this.collapsed = !this.collapsed;
    try {
      localStorage.setItem("collapsed", this.collapsed ? "1" : "0");
    } catch {}
    this.resize();
    cx.notify();
  }

  // A Codex account as { five, week, other[] }: each window is { label, pct, resetsAt } or null.
  codexWindows(a) {
    const snap = a?.rateLimits ?? {};
    const out = { five: null, week: null, other: [] };
    for (const w of [snap.primary, snap.secondary].filter(Boolean)) {
      const win = { label: windowLabel(w.windowDurationMins), pct: w.usedPercent, resetsAt: w.resetsAt };
      if (w.windowDurationMins === 300) out.five = win;
      else if (w.windowDurationMins === 10080) out.week = win;
      else out.other.push(win);
    }
    return out;
  }

  logo(which) {
    if (which === "claude") return svg("icons/claude.svg").size(14).flex_none().text_color(CLAUDE_ORANGE);
    return image(`icons/${which}.svg`).w(14).h(14).flex_none().rounded(3);
  }

  bar(t, pct) {
    const used = Math.min(100, Math.max(0, pct ?? 0));
    const color = used >= 90 ? t.blocked : used >= 70 ? t.ansi3 : t.accent;
    return div().w_full().h(4).rounded(2).bg(t.raised).child(div().w(`${used}%`).h(4).rounded(2).bg(color));
  }

  limitRow(t, w) {
    return v_flex()
      .gap(4)
      .child(
        h_flex()
          .items_center()
          .child(div().flex_1().text_color(t.foreground).child(w.label))
          .child(div().text_color(t.muted).child(w.pct == null ? "-" : `${Math.round(w.pct)}%`)),
      )
      .child(this.bar(t, w.pct))
      .when(Boolean(w.resetsAt), (el) => el.child(div().text_size(10.5).text_color(t.dim).child(`resets in ${untilText(w.resetsAt)}`)));
  }

  sectionHeader(t, which, title, right) {
    return h_flex()
      .items_center()
      .gap(6)
      .pt(2)
      .child(this.logo(which))
      .child(div().flex_1().text_size(11).font_semibold().text_color(t.muted).child(title))
      .when(Boolean(right), (el) => el.child(right));
  }

  accountSection(t, a) {
    const title = a.name === "default" ? "CLAUDE CODE" : `CLAUDE CODE · ${a.name.toUpperCase()}`;
    const action = !a.needsLogin
      ? button(`start-${a.name}`, "Start", t.raised, t.foreground, () => this.startAccount(a))
      : this.canManage
      ? button(`sign-in-${a.name}`, "Sign in", t.accent, t.solid_foreground, (_e, cx) => this.signIn(a.name, cx))
      : null;
    const out = [this.sectionHeader(t, "claude", title, action)];
    if (a.email || a.updatedAt) {
      out.push(
        h_flex()
          .gap(6)
          .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.muted).child(a.email ?? ""))
          .when(Boolean(a.updatedAt), (el) => el.child(div().flex_none().text_size(10.5).text_color(t.dim).child(agoText(a.updatedAt)))),
      );
    }
    if (a.error) out.push(div().text_size(11).text_color(a.needsLogin ? t.dim : t.blocked).child(a.error));
    for (const w of a.windows) out.push(this.limitRow(t, w));
    if (!a.error && a.windows.length === 0) out.push(div().text_color(t.dim).child("No limits reported."));
    return out;
  }

  accountsSections(t) {
    const out = [];
    if (this.accountsError) out.push(div().text_size(11).text_color(t.blocked).child(this.accountsError));
    if (!this.accounts) {
      if (!this.accountsError) out.push(div().text_color(t.dim).child("Loading accounts…"));
      return out;
    }
    for (const a of this.accounts) {
      if (out.length) out.push(div().h(1).bg(t.border));
      out.push(...this.accountSection(t, a));
    }
    if (this.canManage) out.push(
      h_flex()
        .pt(6)
        .child(div().flex_1())
        .child(button("add-account", this.adding ? "Adding…" : "+ Add account", t.raised, t.foreground, (_e, cx) => this.addAccount(cx))),
    );
    // Claude's banked resets are only on the claude.ai usage page, so this button opens it.
    out.push(
      h_flex()
        .items_center()
        .pt(6)
        .child(div().flex_1().text_color(t.foreground).child("Claude banked resets"))
        .child(button("claude-usage-page", "Open claude.ai ↗", t.raised, t.foreground, () => exec("open", [CLAUDE_USAGE_URL]))),
    );
    return out;
  }

  codexSections(t) {
    const refresh = div()
      .id("codex-refresh")
      .text_size(10.5)
      .text_color(t.dim)
      .cursor_pointer()
      .hover((s) => s.text_color(t.foreground))
      .on_click((_e, cx) => this.loadCodex(cx))
      .child(this.codexLoading ? "loading…" : "refresh");
    const out = [];
    if (this.codexError) out.push(this.sectionHeader(t, "codex", "CODEX", refresh), div().text_size(11).text_color(t.blocked).child(this.codexError));
    if (!this.codexAccounts) {
      if (!this.codexError) out.push(this.sectionHeader(t, "codex", "CODEX", refresh), div().text_color(t.dim).child("Loading…"));
      return out;
    }
    this.codexAccounts.forEach((a, i) => {
      if (i > 0) out.push(div().h(1).bg(t.border));
      out.push(...this.codexSection(t, a, i === 0 && !this.codexError ? refresh : null));
    });
    return out;
  }

  codexSection(t, a, refresh) {
    const title = a.name === "default" ? "CODEX" : `CODEX · ${a.name.toUpperCase()}`;
    const right = h_flex()
      .items_center()
      .gap(8)
      .when(Boolean(refresh), (el) => el.child(refresh))
      .child(button(`codex-start-${a.name}`, "Start", t.raised, t.foreground, () => this.startCodex(a)));
    const out = [this.sectionHeader(t, "codex", title, right)];
    if (a.email) out.push(div().truncate().text_size(11).text_color(t.muted).child(a.email));
    if (a.error) {
      out.push(div().text_size(11).text_color(t.blocked).child(a.error));
      return out;
    }
    const w = this.codexWindows(a);
    for (const row of [w.five, w.week, ...w.other].filter(Boolean)) out.push(this.limitRow(t, row));
    const credits = a.rateLimits?.credits;
    if (credits?.hasCredits || credits?.unlimited) {
      out.push(div().text_size(11).text_color(t.muted).child(credits.unlimited ? "Credits: unlimited" : `Credits: ${credits.balance ?? "?"}`));
    }

    const resets = a.rateLimitResetCredits;
    const available = (resets?.credits ?? []).filter((c) => c.status === "available" || c.status === "redeeming");
    out.push(
      h_flex()
        .items_center()
        .pt(6)
        .child(div().flex_1().text_color(t.foreground).child("Banked resets"))
        .child(div().text_color(t.muted).child(String(resets?.availableCount ?? 0))),
    );
    for (const c of available) out.push(this.creditRow(t, c, a));
    return out;
  }

  creditRow(t, c, a) {
    const busy = this.redeeming?.id === c.id || c.status === "redeeming";
    const confirming = this.confirming === c.id;
    const actions = busy
      ? div().text_size(11).text_color(t.muted).child("Using…")
      : confirming
        ? h_flex()
            .gap(4)
            .child(button(`cancel-${c.id}`, "Cancel", t.raised, t.foreground, (_e, cx) => { this.confirming = null; cx.notify(); }))
            .child(button(`confirm-${c.id}`, "Reset now", t.blocked, t.solid_foreground, (_e, cx) => this.redeem(c, a, cx)))
        : button(`use-${c.id}`, "Use", t.raised, t.foreground, (_e, cx) => {
            if (this.redeeming) return;
            this.confirming = c.id;
            cx.notify();
          });
    return h_flex()
      .items_center()
      .gap(6)
      .child(
        v_flex()
          .flex_1()
          .min_w(0)
          .child(div().truncate().text_color(t.foreground).child(c.title ?? "Reset"))
          .child(div().text_size(10.5).text_color(t.dim).child(c.expiresAt ? `expires ${dateText(c.expiresAt)}` : "no expiry")),
      )
      .child(actions);
  }

  // One line per account: logo, then its two main meters.
  compactRow(t, which, windows, loaded, label) {
    const meter = (short, w) =>
      h_flex()
        .flex_1()
        .min_w(0)
        .gap(5)
        .items_center()
        .child(div().text_size(10.5).text_color(t.dim).child(short))
        .child(div().flex_1().min_w(12).child(this.bar(t, w?.pct)))
        .child(div().w(30).text_size(11).text_color(w ? t.foreground : t.dim).child(w ? `${Math.round(w.pct)}%` : "-"));
    return h_flex()
      .items_center()
      .gap(8)
      .child(this.logo(which))
      .when(Boolean(label), (el) => el.child(div().w(54).truncate().text_size(10.5).text_color(t.muted).child(label)))
      .when(!loaded, (el) => el.child(div().text_size(11).text_color(t.dim).child("no data yet")))
      .when(loaded, (el) => el.child(meter(windows.fiveLabel ?? "5h", windows.five)).child(meter(windows.weekLabel ?? "wk", windows.week)));
  }

  // An account's first two windows for the collapsed row (Claude: 5-hour and weekly).
  compactWindows(a) {
    const [first, second] = a.windows;
    const short = (w) => (w?.label === "5-hour" ? "5h" : w?.label === "Weekly" ? "wk" : w?.label?.split(" ")[0].toLowerCase());
    return { five: first ?? null, week: second ?? null, fiveLabel: short(first) ?? "5h", weekLabel: short(second) ?? "wk" };
  }

  panelHeader(t) {
    const codexResets = (this.codexAccounts ?? []).reduce((n, a) => n + (a.rateLimitResetCredits?.availableCount ?? 0), 0);
    return h_flex()
      .id("usage-toggle")
      .items_center()
      .gap(6)
      .cursor_pointer()
      .on_click((_e, cx) => this.toggle(cx))
      .child(svg(`mods/workspace-chrome/chevron-${this.collapsed ? "right" : "down"}.svg`).size(12).text_color(t.dim))
      .child(div().flex_1().text_size(11).text_color(t.muted).child("Usage"))
      .when(this.collapsed && codexResets > 0, (el) => el.child(div().text_size(10.5).text_color(t.dim).child(`${codexResets} Codex resets`)));
  }

  render(cx) {
    const t = theme();
    const body = this.collapsed
      ? [
          ...(this.accounts ?? []).map((a) => this.compactRow(t, "claude", this.compactWindows(a), !a.error, a.name)),
          ...(this.codexAccounts ?? []).map((a) => this.compactRow(t, "codex", this.codexWindows(a), !a.error, a.name === "default" ? "codex" : a.name)),
        ]
      : [...this.accountsSections(t), div().h(1).bg(t.border), ...this.codexSections(t)];
    return v_flex()
      .id("root")
      .size_full()
      .min_h(0)
      .overflow_y_scrollbar()
      .bg(t.chrome)
      .border_t(1)
      .border_color(t.border)
      .px(14)
      .py(8)
      .gap(this.collapsed ? 7 : 8)
      .text_size(12)
      .child(this.panelHeader(t))
      .children(body);
  }
}
