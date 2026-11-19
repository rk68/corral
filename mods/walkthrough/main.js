// Walkthrough: plays a timeline of window commands, shared values and captions, for recording
// a walkthrough, and shows the current caption. It runs only while its pane is on screen.
// props().steps = [[ms, "run", command, args] | [ms, "shared", key, value] | [ms, "caption", text, detail]].
// props().log names a file that gets one line per step played.
import { View, div } from "gpui-kit";
import { v_flex } from "gpui-base";
import { props, run, setShared, writeTextFile, theme } from "herdr";

export default class Walkthrough extends View {
  init(_props, cx) {
    const { steps = [], log } = props() ?? {};
    const lines = [];
    this.caption = ""; this.detail = "";
    const start = Date.now();
    for (const [ms, kind, a, b] of steps) {
      cx.timer.after(ms, (cx) => {
        if (kind === "run") run(a, b ?? {});
        else if (kind === "shared") setShared(a, b);
        else if (kind === "caption") { this.caption = a; this.detail = b ?? ""; }
        lines.push(`${Date.now() - start} ${kind} ${a}`);
        if (log) writeTextFile(log, lines.join("\n") + "\n");
        cx.notify();
      });
    }
  }

  render() {
    const t = theme();
    return v_flex().size_full().justify_center().px(18).gap(4).bg(t.background)
      .child(div().text_size(20).font_semibold().text_color(t.foreground).child(this.caption))
      .child(div().text_size(13).text_color(t.muted).child(this.detail));
  }
}
