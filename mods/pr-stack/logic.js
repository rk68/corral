// Pure logic shared by the panel (main.js) and the gh/git/hc runner (prs.mjs): PR state from gh's
// JSON, stacks in merge order, what each row says and offers, task prompts and automation limits.
// Ported from the Paseo `factory` plugin (github.com/rk68/paseo-plugins, factory/shared and server).

// ---------- checks and PR state ----------

const FAILED = new Set(["FAILURE", "ERROR", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE"]);
// A cancelled run is superseded, not failed.
const SKIPPED = new Set(["SKIPPED", "NEUTRAL", "STALE", "CANCELLED"]);
const PENDING_STATES = new Set(["PENDING", "EXPECTED"]);
const CHECK_ORDER = { fail: 0, pending: 1, pass: 2, skipped: 3 };

function checkState(check) {
  const outcome = check.conclusion ?? check.state ?? "";
  if (FAILED.has(outcome)) return "fail";
  // CheckRuns report `status`; StatusContexts only report `state`.
  const running = check.status ? check.status !== "COMPLETED" : PENDING_STATES.has(outcome);
  if (running) return "pending";
  return SKIPPED.has(outcome) ? "skipped" : "pass";
}

export function toChecks(rollup) {
  return (rollup ?? [])
    .map((c) => ({ name: c.name ?? c.context ?? "check", state: checkState(c), url: c.detailsUrl ?? c.targetUrl ?? null }))
    .sort((a, b) => CHECK_ORDER[a.state] - CHECK_ORDER[b.state] || a.name.localeCompare(b.name));
}

export function ciStatus(checks) {
  if (checks.some((c) => c.state === "fail")) return "fail";
  if (checks.some((c) => c.state === "pending")) return "pending";
  return checks.some((c) => c.state === "pass") ? "pass" : "none";
}

const REVIEW = { APPROVED: "approved", CHANGES_REQUESTED: "changes_requested", REVIEW_REQUIRED: "review_required" };

export function mergeStatus(pr) {
  if (pr.mergeable === "CONFLICTING" || pr.mergeStateStatus === "DIRTY") return "conflicts";
  switch (pr.mergeStateStatus) {
    case "BEHIND": return "behind";
    case "BLOCKED": return "blocked";
    case "CLEAN": case "UNSTABLE": case "HAS_HOOKS": return "ready";
    default: return "unknown";
  }
}

// ---------- stacks ----------

/** For each PR, the nearest other PR whose head commit is in its branch (the one with most unique commits). */
export function gitStackParents(prs, uniqueCommits) {
  const parents = new Map();
  for (const pr of prs) {
    const commits = uniqueCommits.get(pr.number);
    if (!commits) continue;
    let nearest = null;
    for (const c of prs) {
      if (c.headRefOid === pr.headRefOid || !commits.has(c.headRefOid)) continue;
      const size = uniqueCommits.get(c.number)?.size ?? 0;
      if (!nearest || size > nearest.size) nearest = { number: c.number, size };
    }
    if (nearest) parents.set(pr.number, nearest.number);
  }
  return parents;
}

/** Groups of PRs, each in merge order: a parent always comes before the PRs stacked on it. */
export function buildPrGroups(prs, trunk, gitParents = new Map()) {
  const byNumber = new Map(prs.map((pr) => [pr.number, pr]));
  // A fork's branch names belong to another repository, so only same-repository heads can be a base.
  const byHead = new Map(prs.filter((pr) => !pr.isCrossRepository).map((pr) => [pr.headRefName, pr]));
  const parentOf = (pr) => {
    const parent = byHead.get(pr.baseRefName) ?? byNumber.get(gitParents.get(pr.number) ?? -1);
    return parent && parent.number !== pr.number ? parent : undefined;
  };
  const sorted = [...prs].sort((a, b) => a.number - b.number);
  const children = new Map();
  for (const pr of sorted) {
    const parent = parentOf(pr);
    if (parent) children.set(parent.number, [...(children.get(parent.number) ?? []), pr]);
  }
  const visited = new Set();
  const walk = (pr, depth, parent) => {
    if (visited.has(pr.number)) return [];
    visited.add(pr.number);
    const checks = toChecks(pr.statusCheckRollup);
    const node = {
      number: pr.number, title: pr.title, url: pr.url, head: pr.headRefName, headOid: pr.headRefOid,
      base: pr.baseRefName, createdAt: pr.createdAt, draft: pr.isDraft, cross: pr.isCrossRepository,
      checks, ci: ciStatus(checks), review: REVIEW[pr.reviewDecision] ?? "none", merge: mergeStatus(pr), depth,
      canSquash: false, canAutoMerge: false, autoMerge: pr.autoMergeRequest != null,
      retargetTo: depth === 0 && pr.baseRefName !== trunk ? trunk : null, basePr: null,
      builtOn: parent && parent.headRefName !== pr.baseRefName ? parent.number : null,
      worktree: null, threads: 0, task: null, files: pr.changedFiles ?? 0, add: pr.additions ?? 0, del: pr.deletions ?? 0,
    };
    return [node, ...(children.get(pr.number) ?? []).flatMap((child) => walk(child, depth + 1, pr))];
  };
  const wrongBase = [];
  const stacks = [];
  const independent = [];
  // PRs left after the roots sit in a cycle; walking them as roots still shows each once.
  for (const root of [...sorted.filter((pr) => !parentOf(pr)), ...sorted]) {
    if (visited.has(root.number)) continue;
    const tree = walk(root, 0, undefined);
    if (root.baseRefName !== trunk) wrongBase.push({ kind: "wrong_base", prs: tree });
    else if (tree.length > 1) stacks.push({ kind: "stack", prs: tree });
    else independent.push(...tree);
  }
  const groups = [...wrongBase, ...stacks];
  if (independent.length) groups.push({ kind: "independent", prs: independent });
  return groups;
}

/** A branch's own PR, the PRs it is built on and the PRs built on it, by base or ancestry. */
export function relatedPrs(prs, branch, uniqueCommits) {
  const related = new Set();
  for (const pr of prs) {
    const own = !pr.isCrossRepository && pr.headRefName === branch.name;
    const above = pr.baseRefName === branch.name || uniqueCommits.get(pr.number)?.has(branch.oid);
    const below = branch.commits.has(pr.headRefOid);
    if (own || above || below) related.add(pr.number);
  }
  return related;
}

/** Keeps whole stacks that touch the related PRs, and only the related independent PRs. */
export function scopeGroups(groups, related) {
  return groups.flatMap((g) => {
    if (g.kind === "independent") {
      const prs = g.prs.filter((pr) => related.has(pr.number));
      return prs.length ? [{ kind: g.kind, prs }] : [];
    }
    return g.prs.some((pr) => related.has(pr.number)) ? [g] : [];
  });
}

// ---------- remotes ----------

/** Host and `owner/repo` of a git remote URL: HTTPS, ssh:// or scp-like `host:owner/repo`. */
export function parseRemoteUrl(url) {
  const s = url.trim();
  const full = /^(https?|ssh|git):\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(s);
  if (full) return { host: full[2], ssh: full[1] === "ssh", repo: `${full[3]}/${full[4]}`.toLowerCase() };
  const scp = /^(?:[^@/]+@)?([^/:]+):([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(s);
  return scp ? { host: scp[1], ssh: true, repo: `${scp[2]}/${scp[3]}`.toLowerCase() } : null;
}

/** GitHub serves SSH over port 443 at ssh.github.com; both names are the same forge. */
export const forgeHost = (host) => (host.toLowerCase() === "ssh.github.com" ? "github.com" : host.toLowerCase());

/**
 * The remote whose fetch and push URLs all point at the repository, preferring `origin`. A remote
 * with any URL elsewhere is rejected, because agents fetch and push through it.
 */
export function pickRemote(remoteVerbose, target, resolveHost) {
  const urls = new Map();
  for (const line of remoteVerbose.split("\n")) {
    const [name, url, kind] = line.trim().split(/\s+/);
    if (!name || !url) continue;
    const e = urls.get(name) ?? { fetch: [], push: [] };
    if (kind === "(fetch)") e.fetch.push(url);
    if (kind === "(push)") e.push.push(url);
    urls.set(name, e);
  }
  const repo = target.repo.toLowerCase();
  const host = forgeHost(target.host);
  const ok = (url) => { const p = parseRemoteUrl(url); return p !== null && p.repo === repo && forgeHost(resolveHost(p)) === host; };
  const all = (list) => list.length > 0 && list.every(ok);
  const names = [...urls].filter(([, e]) => all(e.fetch) && all(e.push)).map(([n]) => n);
  return names.includes("origin") ? "origin" : (names[0] ?? null);
}

// ---------- tasks ----------

export const TASK_KINDS = ["conflicts", "ci", "comments"];
export const TASK_TITLE = { conflicts: "Resolve conflicts", ci: "Fix CI", comments: "Address comments" };
export const TASK_RUNNING_LABEL = { conflicts: "Resolving conflicts", ci: "Fixing CI", comments: "Addressing comments" };
export const MAX_ACTIVE_TASKS_PER_REPO = 2;
/** Caps automatic retries when each fix pushes a new head that fails the same way. */
export const MAX_AUTO_ATTEMPTS_PER_TASK = 3;

/** A task agent counts as working while its terminal lives and it works or waits on the person. */
export const isActive = (task) => task != null && task.live && (task.status === "working" || task.status === "blocked" || task.status === "starting");
export const activeTaskCount = (tasks) => tasks.filter(isActive).length;

/** One task per PR at a time, one attempt per kind and head commit, a bounded number of automatic attempts. */
export function mayStartAuto(history, kind, headOid) {
  if (history.some(isActive)) return false;
  if (history.some((t) => t.kind === kind && t.headOid === headOid)) return false;
  return history.filter((t) => t.kind === kind && t.trigger === "auto").length < MAX_AUTO_ATTEMPTS_PER_TASK;
}

function needs(kind, pr, threads, ignored) {
  const checks = toChecks(pr.statusCheckRollup);
  switch (kind) {
    case "conflicts": return pr.mergeable === "CONFLICTING";
    // Waiting for running checks avoids fixing half a picture.
    case "ci": return checks.some((c) => c.state === "fail" && !ignored.has(c.name)) && !checks.some((c) => c.state === "pending");
    // Threads only: the agent resolves them, so a summary-only "changes requested" cannot loop.
    case "comments": return threads > 0;
    default: return false;
  }
}

/** The automatic tasks to start now, at most one per PR, PRs in number order. */
export function nextTasks(prs, threads, tasks, enabled, ignored) {
  let slots = MAX_ACTIVE_TASKS_PER_REPO - activeTaskCount(tasks);
  const picked = [];
  for (const pr of [...prs].sort((a, b) => a.number - b.number)) {
    if (slots <= 0) break;
    if (pr.isCrossRepository) continue;
    const history = tasks.filter((t) => t.number === pr.number);
    const kind = TASK_KINDS.find((k) => enabled[k] && needs(k, pr, threads.get(pr.number) ?? 0, ignored) && mayStartAuto(history, k, pr.headRefOid));
    if (!kind) continue;
    picked.push({ pr, kind });
    slots -= 1;
  }
  return picked;
}

/** Quotes a shell word: branch names may hold characters such as `;` that git accepts. */
export const shellWord = (v) => `'${v.replaceAll("'", `'\\''`)}'`;
const remoteRef = (t, branch) => shellWord(`${t.remote}/${branch}`);

function context(t, problem) {
  return `## Context
- Repository: ${t.host}/${t.repo}. Pull request: ${t.url} ("${t.title}").
- ${problem}
- This worktree is on a new local branch that starts at the PR head fetched from the remote \`${t.remote}\`. Push to the PR branch with the command below, not to the local branch name.`;
}

const syncSteps = (t) => `1. Run \`git fetch ${shellWord(t.remote)}\`.
2. Bring the local branch to the remote branch: \`git merge --ff-only ${remoteRef(t, t.head)}\`. If this fails, stop and report that the local and remote branches diverged.`;

const finishSteps = (t, first, message) => `${first}. Run the fast checks that apply to the changed files, as the repository documents them (format, lint, tests).
${first + 1}. Commit ${message}.
${first + 2}. Push: \`git push ${shellWord(t.remote)} ${shellWord(`HEAD:refs/heads/${t.head}`)}\`.`;

const CONSTRAINTS = `## Constraints
- Do not rebase. Do not force-push. Do not change the base of the PR. Do not merge the PR.
- If a change needs a product decision, stop and explain the options. Do not guess.`;

const PROMPTS = {
  conflicts: (t) => `## Task
Resolve the merge conflicts in pull request #${t.number} so that it can merge into \`${t.base}\`.

${context(t, `GitHub reports that \`${t.head}\` conflicts with \`${t.base}\`.`)}

## Steps
${syncSteps(t)}
3. Merge the base branch: \`git merge ${remoteRef(t, t.base)}\`.
4. Resolve every conflict. Keep the intent of both sides. Read the PR (\`gh pr view ${t.number} --repo ${t.host}/${t.repo}\`) and the commits on both sides before you choose a resolution.
${finishSteps(t, 5, "the merge with the default merge message")}
8. Report each conflicting file and how you resolved it.

${CONSTRAINTS}`,
  ci: (t) => `## Task
Make the failing CI checks pass on pull request #${t.number}.

${context(t, "These checks fail on the current head commit:")}
${t.failingChecks.length ? t.failingChecks.map((c) => `- ${c.name}${c.url ? `: ${c.url}` : ""}`).join("\n") : "- Run `gh pr checks` to list them."}

## Steps
${syncSteps(t)}
3. Read the failure output. For GitHub Actions, run \`gh pr checks ${t.number} --repo ${t.host}/${t.repo}\`, then \`gh run view <run-id> --repo ${t.host}/${t.repo} --log-failed\`. For other checks, open the details URL.
4. Find the root cause and fix the code. If the failure does not come from the code in this PR (a flaky test, an infrastructure fault, or a check that needs PR metadata such as a ticket link), do not change code. Report the cause instead.
5. Run the failing check locally if the repository supports it.
${finishSteps(t, 6, "with a Conventional Commits message, for example `fix(ci): ...`")}
9. Report each failing check, its cause and your fix.

${CONSTRAINTS}
- Do not skip, disable or weaken a test or a check to make it pass.`,
  comments: (t) => {
    const [owner, name] = t.repo.split("/");
    return `## Task
Address the unresolved review comments on pull request #${t.number}.

${context(t, "The PR has unresolved review threads, or a reviewer requested changes.")}

## Steps
${syncSteps(t)}
3. List the unresolved threads with their IDs:
   \`gh api graphql --hostname ${t.host} -f query='{ repository(owner:"${owner}", name:"${name}") { pullRequest(number:${t.number}) { reviewThreads(first:100) { nodes { id isResolved isOutdated path line comments(first:20) { nodes { author { login } body } } } } } } }'\`
   Also read \`gh pr view ${t.number} --repo ${t.host}/${t.repo} --comments\` for review summaries.
4. For each unresolved thread, decide if the comment is correct.
   - If it is correct, change the code.
   - If it is not correct, do not change the code. Reply with the reason: \`gh api graphql --hostname ${t.host} -f query='mutation($id:ID!,$body:String!){ addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$id, body:$body}) { comment { id } } }' -f id=<thread-id> -f body='<reason>'\`.
${finishSteps(t, 5, "with a Conventional Commits message")}
8. Resolve each thread that you fixed or answered: \`gh api graphql --hostname ${t.host} -f query='mutation($id:ID!){ resolveReviewThread(input:{threadId:$id}) { thread { id } } }' -f id=<thread-id>\`.
9. Report each thread and what you did.

${CONSTRAINTS}`;
  },
};

/** A briefing the agent can act on with no other context. */
export function taskPrompt(kind, target, extra) {
  const prompt = PROMPTS[kind](target);
  return extra?.trim() ? `${prompt}\n\n## Extra instructions from the user\n${extra.trim()}` : prompt;
}

// ---------- what a row says and offers ----------

export const TONE_RANK = { danger: 0, warning: 1, success: 2, muted: 3 };
const MAX_NAMED_CHECKS = 2;

export const activeTask = (pr) => (isActive(pr.task) ? pr.task.kind : null);

export function checkCounts(pr) {
  const count = (s) => pr.checks.filter((c) => c.state === s).length;
  return { passed: count("pass"), failed: count("fail"), running: count("pending"), skipped: count("skipped") };
}

function failingNames(pr) {
  const names = [...new Set(pr.checks.filter((c) => c.state === "fail").map((c) => c.name))];
  const shown = names.slice(0, MAX_NAMED_CHECKS).join(", ");
  return names.length > MAX_NAMED_CHECKS ? `${shown} +${names.length - MAX_NAMED_CHECKS}` : shown;
}

function baseSignal(pr) {
  if (pr.retargetTo === null) return null;
  if (!pr.basePr) return { tone: "danger", label: `Base ${pr.base} has no open PR` };
  if (pr.basePr.state === "open") return { tone: "muted", label: `Stacked on #${pr.basePr.number}` };
  return { tone: "danger", label: `Base #${pr.basePr.number} ${pr.basePr.state}` };
}

/** A base that is open belongs to someone else's PR: the stack is real, so it keeps its base. */
const canRetarget = (pr) => pr.retargetTo !== null && pr.basePr?.state !== "open";

export const commentsLabel = (n) => (n === 1 ? "1 unresolved comment" : `${n} unresolved comments`);

function blockingSignals(pr) {
  const task = activeTask(pr);
  const s = [];
  if (task) s.push({ tone: "warning", label: pr.task.status === "blocked" ? `${TASK_TITLE[task]}: agent needs you` : TASK_RUNNING_LABEL[task], busy: pr.task.status !== "blocked" });
  const base = baseSignal(pr);
  if (base) s.push(base);
  if (pr.merge === "conflicts" && task !== "conflicts") s.push({ tone: "danger", label: "Conflicts" });
  if (pr.ci === "fail" && task !== "ci") s.push({ tone: "danger", label: `CI failing: ${failingNames(pr)}` });
  if (pr.review === "changes_requested" && task !== "comments") s.push({ tone: "danger", label: "Changes requested" });
  if (pr.threads > 0 && task !== "comments") s.push({ tone: "warning", label: commentsLabel(pr.threads) });
  if (pr.builtOn !== null) s.push({ tone: "warning", label: `Built on #${pr.builtOn}, targets ${pr.base}` });
  if (pr.merge === "behind") s.push({ tone: "warning", label: "Needs update" });
  if (pr.ci === "pending") {
    const { passed, running } = checkCounts(pr);
    s.push({ tone: "warning", label: `CI running ${passed}/${passed + running}` });
  }
  if (pr.draft) s.push({ tone: "muted", label: "Draft" });
  if (pr.review === "review_required") s.push({ tone: "muted", label: "Review required" });
  if (pr.merge === "blocked" && s.length === 0) s.push({ tone: "muted", label: "Blocked" });
  // GitHub cannot merge a draft, so a draft never reads "Ready to merge"; Mark ready comes first.
  if (pr.merge === "ready" && !pr.draft && s.every((x) => x.tone === "muted")) s.unshift({ tone: "success", label: "Ready to merge" });
  return s;
}

/** What stands between this PR and a merge, most urgent first. */
export function prSignals(pr) {
  const s = blockingSignals(pr);
  // Last, so it never hides "Blocked" or a "Ready to merge" that GitHub is about to act on.
  return pr.autoMerge ? [...s, { tone: "muted", label: "Auto-merge on" }] : s;
}

export const prTone = (pr) => prSignals(pr)[0]?.tone ?? "muted";

/**
 * The one-click actions a PR offers. While an agent works on the PR, only its agent is offered:
 * a second task, a branch update or local edits would race its push.
 */
export function prActions(pr) {
  if (activeTask(pr)) return ["open-agent"];
  const a = [];
  if (canRetarget(pr)) a.push("retarget");
  if (pr.merge === "behind") a.push("update");
  if (pr.merge === "conflicts") a.push("conflicts");
  if (pr.ci === "fail") a.push("ci");
  if (pr.threads > 0 || pr.review === "changes_requested") a.push("comments");
  if (pr.draft) a.push("ready");
  // Only a row that reads "Ready to merge" offers it, so a merge never skips a visible warning.
  const ready = prTone(pr) === "success";
  if (pr.canSquash && ready) a.push("merge");
  // GitHub refuses auto-merge on a PR it could merge now, so a ready row offers the merge instead.
  if (pr.autoMerge) a.push("cancel-auto-merge");
  else if (pr.canAutoMerge && !pr.draft && !ready) a.push("auto-merge");
  a.push("checkout");
  if (pr.task) a.push("open-agent", "archive-task");
  return a;
}

// ---------- order ----------

const byUrgency = (a, b) => TONE_RANK[prTone(a)] - TONE_RANK[prTone(b)] || a.number - b.number;
const byNewest = (a, b) => b.createdAt.localeCompare(a.createdAt) || b.number - a.number;
const newestIn = (g) => g.prs.reduce((m, pr) => (pr.createdAt > m ? pr.createdAt : m), "");
const urgencyOf = (g) => Math.min(...g.prs.map((pr) => TONE_RANK[prTone(pr)]));
const SECTION_ORDER = ["wrong_base", "stack", "independent"];

/** Orders groups inside their sections, and the independent PRs. A stack keeps its merge order. */
export function orderGroups(groups, sort) {
  const cmp = sort === "newest" ? (a, b) => newestIn(b).localeCompare(newestIn(a)) : (a, b) => urgencyOf(a) - urgencyOf(b);
  return SECTION_ORDER.flatMap((kind) => groups.filter((g) => g.kind === kind)
    .map((g) => (kind === "independent" ? { kind, prs: [...g.prs].sort(sort === "newest" ? byNewest : byUrgency) } : g))
    .sort(cmp));
}

export function age(iso, now) {
  const m = Math.floor((now - Date.parse(iso)) / 60000);
  if (!Number.isFinite(m)) return "";
  if (m < 60) return `${Math.max(1, m)}m`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}h` : `${Math.floor(h / 24)}d`;
}
