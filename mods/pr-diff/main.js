// PR diff: one pull request's changes, to review in Herdr. The PR stack panel picks the PR
// through shared(TARGET) and opens this pane. It lists the changed files and shows one file's
// diff at a time. Each file has GitHub's own "Viewed" box, so ticks here show on the PR's Files
// tab and the other way round. Data comes from ../pr-stack/prs.mjs diff.
// Keys when the pane has focus: n / p next and previous file, v viewed (then the next unviewed
// file), o this file on GitHub.
import { View, div } from "gpui-kit";
import { v_flex, h_flex, Scrollbar, v_virtual_list, VirtualListScrollHandle } from "gpui-base";
import { exec, theme, settings, appHome, shared, props } from "herdr";

const TARGET = "pr-diff.target"; // { dir, number, at }, set by the PR stack panel
const WIDE = 720;                // from this width the file list sits beside the diff
const LIST_W = 300;
const SLIM = 520;                // below this width the header and file bar drop their extras
const ROW = 20;

const untab = (text) => text.replace(/[^\t]*\t/g, (s) => s.slice(0, -1).padEnd((s.length - 1) - (s.length - 1) % 4 + 4));

// Numbers each diff line once, so a frame only draws the rows on screen.
function diffRows(lines) {
  let old = 0, next = 0;
  return lines.map((line) => {
    const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
    if (match) { old = +match[1]; next = +match[2]; return { kind: "@", text: line }; }
    const kind = line[0];
    if (kind === "-") return { kind, old: old++, text: untab(line.slice(1)) || " " };
    if (kind === "+") return { kind, next: next++, text: untab(line.slice(1)) || " " };
    if (kind === " ") return { kind, old: old++, next: next++, text: untab(line.slice(1)) || " " };
    return { kind: "", text: line };
  });
}

async function prs(args, timeout) {
  const r = await exec("node", ["--no-warnings", `${appHome()}/mods/pr-stack/prs.mjs`, ...args], { timeout });
  let out;
  try { out = JSON.parse(r.stdout); } catch { throw new Error(r.stderr.trim().split("\n").pop() || `prs.mjs exited ${r.code}`); }
  if (out.error) throw new Error(out.error);
  return out;
}

const targetKey = (x) => (x ? `${x.dir}#${x.number}@${x.at}` : null);

export default class PrDiff extends View {
  init(_props, cx) {
    this.pr = null; this.open = null; this.rows = []; this.diffWidth = 0;
    this.error = null; this.note = null; this.loading = false; this.loaded = null;
    this.width = 900;
    this.handle = cx.focus_handle();
    this.scroll = VirtualListScrollHandle.new();
  }

  load(target, cx, keep) {
    this.loaded = targetKey(target);
    this.loading = true; this.error = null; this.note = null;
    if (!keep) { this.pr = null; this.open = null; this.setLines([]); }
    const key = this.loaded;
    cx.spawn(async (cx) => {
      try {
        const pr = await prs(["diff", target.dir, String(target.number)], 180000);
        if (key !== this.loaded) return;
        pr.dir = target.dir;
        this.pr = pr;
        const still = keep && pr.files.find((f) => f.path === this.open);
        this.pick(still ? still.path : (pr.files.find((f) => f.viewed !== "yes") ?? pr.files[0])?.path ?? null);
      } catch (e) { if (key === this.loaded) this.error = e.message; }
      finally { if (key === this.loaded) this.loading = false; cx.notify(); }
    });
  }

  setLines(lines) {
    this.rows = diffRows(lines);
    this.diffWidth = Math.max(300, ...this.rows.map((r) => (r.text.length + 1) * 7 + 90));
  }

  pick(path) {
    this.open = path;
    const file = this.pr?.files.find((f) => f.path === path);
    this.setLines(file?.lines ?? []);
    this.scroll.scroll_to_item(0);
  }

  step(by) {
    const files = this.pr?.files ?? [];
    if (!files.length) return;
    const i = files.findIndex((f) => f.path === this.open);
    this.pick(files[Math.min(files.length - 1, Math.max(0, i + by))].path);
  }

  // Ticks at once, then tells GitHub. A refused change puts the tick back.
  toggleViewed(file, cx, advance) {
    const pr = this.pr, before = file.viewed, on = before !== "yes";
    file.viewed = on ? "yes" : "no";
    if (on && advance) {
      const files = pr.files, i = files.indexOf(file);
      const next = [...files.slice(i + 1), ...files.slice(0, i)].find((f) => f.viewed !== "yes");
      if (next) this.pick(next.path);
    }
    cx.spawn(async (cx) => {
      try { await prs(["viewed", pr.dir, pr.id, file.path, on ? "on" : "off"], 30000); }
      catch (e) { file.viewed = before; this.note = `GitHub did not save "Viewed" for ${file.path}: ${e.message}`; }
      cx.notify();
    });
    cx.notify();
  }

  github(file) {
    if (!this.pr) return;
    exec("open", [file ? `${this.pr.url}/files#diff-${file.anchor}` : `${this.pr.url}/files`]);
  }

  // ---------- render ----------

  button(id, label, t, onClick, { active = false, title } = {}) {
    return div().id(id).h(24).px(8).flex().flex_none().items_center().rounded(6).text_size(11).cursor_pointer()
      .border_1().border_color(active ? t.ansi2 : t.border).text_color(active ? t.ansi2 : t.muted)
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_click((_e, cx) => { cx.stop_propagation(); onClick(cx); })
      .child(label);
  }

  box(file, t) {
    const mark = file.viewed === "yes" ? "☑" : file.viewed === "changed" ? "◐" : "☐";
    return div().id(`viewed-${file.path}`).w(16).flex_none().text_size(13).cursor_pointer()
      .text_color(file.viewed === "yes" ? t.ansi2 : file.viewed === "changed" ? t.ansi3 : t.dim).hover((s) => s.text_color(t.foreground))
      .on_click((_e, cx) => { cx.stop_propagation(); this.toggleViewed(file, cx, false); })
      .child(mark);
  }

  fileRow(f, t) {
    const parts = f.path.split("/"), name = parts.pop();
    const color = { A: t.ansi2, D: t.ansi1, R: t.accent, C: t.accent }[f.status] ?? t.ansi3;
    return h_flex().id(`file-${f.path}`).h(28).flex_none().px(8).gap(8).items_center().rounded(7).cursor_pointer()
      .when(this.open === f.path, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => { this.pick(f.path); this.handle.focus(); cx.notify(); })
      .child(this.box(f, t))
      .child(div().w(12).flex_none().text_size(11).text_color(color).child(f.status))
      .child(h_flex().flex_1().min_w(0).when(f.viewed === "yes", (e) => e.opacity(0.5))
        .child(div().min_w(0).text_color(t.dim).truncate().child(parts.length ? `${parts.join("/")}/` : ""))
        .child(div().min_w(0).truncate().child(name)))
      .when(f.add > 0, (e) => e.child(div().flex_none().text_size(11).text_color(t.ansi2).child(`+${f.add}`)))
      .when(f.del > 0, (e) => e.child(div().flex_none().text_size(11).text_color(t.ansi1).child(`−${f.del}`)));
  }

  diffRow({ kind, old, next, text }, t) {
    if (kind === "@") return div().w_full().px(12).h(ROW).flex_none().truncate().bg(t.raised).text_color(t.dim).child(text);
    const n = (x) => div().w(34).flex_none().text_right().text_color(t.dim).child(x === undefined ? "" : String(x));
    return h_flex().w_full().h(ROW).flex_none().gap(8)
      .when(kind === "+", (e) => e.bg(t.ansi2 + "18")).when(kind === "-", (e) => e.bg(t.ansi1 + "18"))
      .child(n(old)).child(n(next))
      .child(div().w(10).flex_none().text_color(kind === "+" ? t.ansi2 : kind === "-" ? t.ansi1 : t.dim).child(kind === "+" || kind === "-" ? kind : ""))
      .child(div().flex_1().min_w(0).truncate().text_color(kind ? t.foreground : t.dim).child(text));
  }

  render(cx) {
    const t = theme();
    const target = props()?.target ?? shared(TARGET); // props: a pane opened for one PR by a command
    if (target && targetKey(target) !== this.loaded) this.load(target, cx, false);
    const pr = this.pr;
    const files = pr?.files ?? [];
    const file = files.find((f) => f.path === this.open);
    const seen = files.filter((f) => f.viewed === "yes").length;
    const wide = this.width >= WIDE, slim = this.width < SLIM;
    const mono = settings().font_family ?? "JetBrains Mono";

    const header = h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
      .child(div().flex_none().text_color(t.dim).child(pr ? `#${pr.number}` : target ? `#${target.number}` : ""))
      .child(div().flex_1().min_w(0).truncate().font_semibold().child(pr?.title ?? (this.loading ? "Loading the diff…" : "PR diff")))
      .when(Boolean(pr) && !slim, (e) => e
        .child(div().flex_none().px(5).py(1).rounded(4).border_1().border_color(t.border).text_size(10).text_color(t.muted).child(`${pr.changed} files`))
        .child(div().flex_none().text_size(11).text_color(t.ansi2).child(`+${pr.add}`))
        .child(div().flex_none().text_size(11).text_color(t.ansi1).child(`−${pr.del}`)))
      .when(Boolean(pr), (e) => e
        .child(div().flex_none().text_size(11).text_color(seen === files.length ? t.ansi2 : t.muted).child(`${seen}/${files.length} viewed`))
        .child(this.button("reload", this.loading ? "…" : "↻", t, (cx) => { if (!this.loading) this.load(shared(TARGET), cx, true); }))
        .child(this.button("github", "↗", t, () => this.github(null))));
    const progress = div().h(2).flex_none().w_full().bg(t.border)
      .child(div().h_full().bg(t.ansi2).w(files.length ? `${(100 * seen) / files.length}%` : "0%"));

    const list = v_flex().id("pr-diff-files").absolute().inset_0().overflow_y_scroll().p(6)
      .children(files.map((f) => this.fileRow(f, t)))
      .when(!files.length, (e) => e.child(div().p(8).text_color(t.dim)
        .child(this.error ?? (this.loading ? "Loading the diff…" : target ? "No changed files" : "Pick a PR's file count in the PR stack panel"))));
    const listBox = div().relative()
      .when(wide, (e) => e.w(LIST_W).flex_none().h_full().border_r(1).border_color(t.border))
      .when(!wide, (e) => e.w_full().flex_none().h(Math.min(files.length * 28 + 12, 220)).min_h(44).border_b(1).border_color(t.border))
      .child(list).child(Scrollbar.vertical("pr-diff-files").absolute().inset_0());

    const fileBar = h_flex().h(34).flex_none().px(10).gap(8).items_center().border_b(1).border_color(t.border).text_size(12)
      .when(Boolean(file), (e) => e
        .child(this.box(file, t))
        .child(div().flex_1().min_w(0).truncate().font_family(mono).text_size(11).child(file.path))
        .when(!slim, (e) => e
          .child(div().flex_none().text_size(11).text_color(t.ansi2).child(`+${file.add}`))
          .child(div().flex_none().text_size(11).text_color(t.ansi1).child(`−${file.del}`))
          .child(this.button("prev", "‹", t, (cx) => { this.step(-1); cx.notify(); }))
          .child(this.button("next", "›", t, (cx) => { this.step(1); cx.notify(); })))
        .child(this.button("mark", slim ? "✓" : file.viewed === "yes" ? "Viewed" : "Mark viewed", t, (cx) => this.toggleViewed(file, cx, true), { active: file.viewed === "yes" }))
        .child(this.button("file-github", "↗", t, () => this.github(file))));

    const diff = div().flex_1().min_h(0).relative().font_family(mono).text_size(11)
      .child(div().id("pr-diff-x").size_full().overflow_x_scrollbar()
        .child(div().w_full().min_w(this.diffWidth).h_full().child(v_virtual_list("pr-diff-diff", this.rows.length, ROW, (i) => String(i),
          (range) => this.rows.slice(range.start, range.end).map((row) => this.diffRow(row, t))).track_scroll(this.scroll).size_full())))
      .child(Scrollbar.vertical("pr-diff-diff").viewport_from_layout().absolute().inset_0());

    const right = v_flex().flex_1().min_w(0).min_h(0).when(wide, (e) => e.h_full()).child(fileBar).child(diff)
      .when(Boolean(file) && !slim, (e) => e.child(div().px(10).py(3).flex_none().border_t(1).border_color(t.border).text_size(10).text_color(t.dim)
        .child("n / p  file    v  viewed, then the next file    o  open on GitHub")));

    return v_flex().id("pr-diff").size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(13).track_focus(this.handle)
      .on_size_change((size, cx) => { if (Math.abs(size.width - this.width) > 1) { this.width = size.width; cx.notify(); } })
      .on_mouse_down("left", () => this.handle.focus())
      .on_key_down((e, cx) => {
        const k = e.key;
        if (k === "n" || k === "j") this.step(1);
        else if (k === "p" || k === "k") this.step(-1);
        else if (k === "v" && file) this.toggleViewed(file, cx, true);
        else if (k === "o" && file) this.github(file);
        else return;
        cx.stop_propagation(); cx.notify();
      })
      .child(header).child(progress)
      .when(Boolean(this.note), (e) => e.child(div().px(12).py(4).flex_none().text_size(11).text_color(t.ansi1).child(this.note)))
      .child((wide ? h_flex() : v_flex()).flex_1().min_h(0).child(listBox).child(right));
  }
}
