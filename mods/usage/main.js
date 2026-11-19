// Plan usage for Claude Code and Codex, plus Codex's banked rate-limit resets.
// Claude: rate_limits that ~/.claude/statusline-usage.sh saves from Claude Code's status line.
// Codex: `codex app-server` through ./codex-usage.mjs (read limits, use a banked reset).

import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, readTextFile, home, appHome, theme, checking, notify, run, nextCommand } from "herdr";

const CLAUDE_EVERY_MS = 30 * 1000;
const CODEX_EVERY_MS = 5 * 60 * 1000;
// Heights of this panel's layout block ("usage" in layouts/herdr-usage.json).
const EXPANDED_PX = 490;
const COLLAPSED_PX = 80;
const CLAUDE_ORANGE = "#d97757";
const CLAUDE_USAGE_URL = "https://claude.ai/settings/usage";

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
    this.claude = null; // { captured_at, rate_limits }
    this.codex = null; // GetAccountRateLimitsResponse
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
    run("layout.resize", { id: "usage", px: this.collapsed ? COLLAPSED_PX : EXPANDED_PX });
    // `herdr-app do usage.toggle` (or a key bound to it) collapses and expands the panel.
    cx.spawn(async (cx) => {
      for (;;) {
        if ((await nextCommand()) === "toggle") this.toggle(cx);
      }
    });
    this.loadClaude(cx);
    this.loadCodex(cx);
    cx.timer.every(CLAUDE_EVERY_MS, (cx) => this.loadClaude(cx));
    cx.timer.every(CODEX_EVERY_MS, (cx) => this.loadCodex(cx));
  }

  loadClaude(cx) {
    cx.spawn(async (cx) => {
      const text = await readTextFile(`${home()}/.cache/agent-usage/claude.json`).catch(() => null);
      try {
        this.claude = text ? JSON.parse(text) : null;
      } catch {
        this.claude = null;
      }
      cx.notify();
    });
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
        this.codex = await this.codexScript(["read"]);
        this.codexError = null;
      } catch (e) {
        this.codexError = String(e?.message ?? e);
      }
      this.codexLoading = false;
      cx.notify();
    });
  }

  redeem(credit, cx) {
    if (this.redeeming) return;
    this.confirming = null;
    this.redeeming = { id: credit.id, key: newKey() };
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const { outcome } = await this.codexScript(["consume", credit.id, this.redeeming.key]);
        const text = {
          reset: ["Codex limits reset", "success"],
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
    run("layout.resize", { id: "usage", px: this.collapsed ? COLLAPSED_PX : EXPANDED_PX });
    cx.notify();
  }

  // Both tools as { five, week, other[] }: each window is { label, pct, resetsAt } or null.
  claudeWindows() {
    const now = Date.now() / 1000;
    const limits = this.claude?.rate_limits ?? {};
    const win = (label, w) => {
      if (!w) return null;
      // A window whose reset time has passed has started again from zero.
      const expired = w.resets_at && w.resets_at <= now;
      return { label, pct: expired ? 0 : w.used_percentage, resetsAt: expired ? null : w.resets_at };
    };
    const spend = win(`Spend (${limits.spend_limit?.period ?? "period"})`, limits.spend_limit);
    return { five: win("5-hour", limits.five_hour), week: win("Weekly", limits.seven_day), other: spend ? [spend] : [] };
  }

  codexWindows() {
    const snap = this.codex?.rateLimits ?? {};
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
    return which === "claude"
      ? svg("icons/claude.svg").size(14).flex_none().text_color(CLAUDE_ORANGE)
      : image("icons/codex.svg").w(14).h(14).flex_none().rounded(3);
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

  claudeSection(t) {
    const ago = this.claude ? div().text_size(10.5).text_color(t.dim).child(agoText(this.claude.captured_at)) : null;
    const out = [this.sectionHeader(t, "claude", "CLAUDE CODE", ago)];
    if (!this.claude) {
      out.push(div().text_color(t.dim).child("No data yet. It appears after a Claude Code reply."));
    } else {
      const w = this.claudeWindows();
      const rows = [w.five, w.week, ...w.other].filter(Boolean);
      for (const row of rows) out.push(this.limitRow(t, row));
      if (rows.length === 0) out.push(div().text_color(t.dim).child("No limits reported."));
    }
    // Claude's banked resets are only on the claude.ai usage page, so this button opens it.
    out.push(
      h_flex()
        .items_center()
        .pt(6)
        .child(div().flex_1().text_color(t.foreground).child("Banked resets"))
        .child(button("claude-usage-page", "Open claude.ai ↗", t.raised, t.foreground, () => exec("open", [CLAUDE_USAGE_URL]))),
    );
    return out;
  }

  codexSection(t) {
    const refresh = div()
      .id("codex-refresh")
      .text_size(10.5)
      .text_color(t.dim)
      .cursor_pointer()
      .hover((s) => s.text_color(t.foreground))
      .on_click((_e, cx) => this.loadCodex(cx))
      .child(this.codexLoading ? "loading…" : "refresh");
    const out = [this.sectionHeader(t, "codex", "CODEX", refresh)];
    if (this.codexError) out.push(div().text_size(11).text_color(t.blocked).child(this.codexError));
    if (!this.codex) {
      if (!this.codexError) out.push(div().text_color(t.dim).child("Loading…"));
      return out;
    }
    const w = this.codexWindows();
    for (const row of [w.five, w.week, ...w.other].filter(Boolean)) out.push(this.limitRow(t, row));
    const credits = this.codex.rateLimits?.credits;
    if (credits?.hasCredits || credits?.unlimited) {
      out.push(div().text_size(11).text_color(t.muted).child(credits.unlimited ? "Credits: unlimited" : `Credits: ${credits.balance ?? "?"}`));
    }

    const resets = this.codex.rateLimitResetCredits;
    const available = (resets?.credits ?? []).filter((c) => c.status === "available" || c.status === "redeeming");
    out.push(
      h_flex()
        .items_center()
        .pt(6)
        .child(div().flex_1().text_color(t.foreground).child("Banked resets"))
        .child(div().text_color(t.muted).child(String(resets?.availableCount ?? 0))),
    );
    for (const c of available) out.push(this.creditRow(t, c));
    return out;
  }

  creditRow(t, c) {
    const busy = this.redeeming?.id === c.id || c.status === "redeeming";
    const confirming = this.confirming === c.id;
    const actions = busy
      ? div().text_size(11).text_color(t.muted).child("Using…")
      : confirming
        ? h_flex()
            .gap(4)
            .child(button(`cancel-${c.id}`, "Cancel", t.raised, t.foreground, (_e, cx) => { this.confirming = null; cx.notify(); }))
            .child(button(`confirm-${c.id}`, "Reset now", t.blocked, t.solid_foreground, (_e, cx) => this.redeem(c, cx)))
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

  // One line per tool: logo, then the 5-hour and weekly meters.
  compactRow(t, which, windows, loaded) {
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
      .when(!loaded, (el) => el.child(div().text_size(11).text_color(t.dim).child("no data yet")))
      .when(loaded, (el) => el.child(meter("5h", windows.five)).child(meter("wk", windows.week)));
  }

  panelHeader(t) {
    return h_flex()
      .id("usage-toggle")
      .items_center()
      .gap(6)
      .cursor_pointer()
      .on_click((_e, cx) => this.toggle(cx))
      .child(svg(`mods/workspace-chrome/chevron-${this.collapsed ? "right" : "down"}.svg`).size(12).text_color(t.dim))
      .child(div().flex_1().text_size(11).text_color(t.muted).child("Usage"))
      .when(this.collapsed && (this.codex?.rateLimitResetCredits?.availableCount ?? 0) > 0, (el) =>
        el.child(div().text_size(10.5).text_color(t.dim).child(`${this.codex.rateLimitResetCredits.availableCount} resets`)),
      );
  }

  render(cx) {
    const t = theme();
    const body = this.collapsed
      ? [this.compactRow(t, "claude", this.claudeWindows(), Boolean(this.claude)), this.compactRow(t, "codex", this.codexWindows(), Boolean(this.codex))]
      : [...this.claudeSection(t), div().h(1).bg(t.border), ...this.codexSection(t)];
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
