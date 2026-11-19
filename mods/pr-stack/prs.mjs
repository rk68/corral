// The PR stack's hands: runs gh, git and hc for the panel and prints one JSON object.
//   list <dir> <branch|all>          your open PRs as stacks, with checks, reviews and task agents
//   act <dir> <action> <n> [headOid] update | ready | retarget | close | merge | auto-merge | cancel-auto-merge
//   task <dir> <n> <kind> [extra]    start an agent (conflicts | ci | comments); extra instructions optional
//   archive <dir> <n>                remove a PR's finished task agents and the worktrees they ran in
//   checkout <dir> <n>               a worktree with the PR branch, made if missing
//   auto <dir> <settings json>       start the automatic tasks that are due: {enabled, prompts, ignored}
//   land-start <dir> <n> [prompts]   merge a stack from PR n down, in a background hc terminal
//   land-stop <dir>                  stop the stack merge of this repository
//   land <dir> <n> [prompts]         the stack merge itself (what land-start runs)
// Task agents run Claude Code in a new worktree that starts at the PR head. Which agents belong to
// which PR is kept in ~/.cache/herdr-pr-stack/tasks.json; their live state comes from `hc ls`.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  buildPrGroups, gitStackParents, relatedPrs, scopeGroups, pickRemote, parseRemoteUrl, toChecks,
  taskPrompt, nextTasks, isActive, activeTaskCount, mayStartAuto, MAX_ACTIVE_TASKS_PER_REPO, TASK_KINDS,
  mergeStatus, ciStatus,
} from "./logic.js";

const sh = promisify(execFile);
const HOME = os.homedir();
const STATE_DIR = path.join(HOME, ".cache", "herdr-pr-stack");
const TASKS_FILE = path.join(STATE_DIR, "tasks.json");
const MAX_PARALLEL_GIT = 8;
const AGENT_ARGV = ["claude", "--model", "opus", "--effort", "high", "--permission-mode", "auto"];

// ---------- processes ----------

async function git(dir, args, timeout = 30000) {
  const { stdout } = await sh("git", args, { cwd: dir, env: { ...process.env, PWD: dir, GIT_TERMINAL_PROMPT: "0" }, timeout, maxBuffer: 16 << 20 });
  return stdout;
}

const mains = new Map();
/** The repository's main checkout, which every worktree of it shares remotes with. */
async function mainCheckout(dir) {
  if (mains.has(dir)) return mains.get(dir);
  const common = (await git(dir, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).catch(() => "")).trim();
  const root = common.endsWith("/.git") ? path.dirname(common) : dir;
  mains.set(dir, root);
  return root;
}

/** gh from the main checkout: wrappers that pick a GitHub account by directory read $PWD. */
async function gh(dir, args) {
  const cwd = await mainCheckout(dir);
  try {
    const { stdout } = await sh("gh", args, { cwd, env: { ...process.env, PWD: cwd }, timeout: 30000, maxBuffer: 16 << 20 });
    return stdout;
  } catch (e) {
    throw new Error(e.stderr?.trim() || e.message);
  }
}

async function hc(args) {
  const { stdout } = await sh("hc", args, { timeout: 30000, maxBuffer: 16 << 20 });
  return stdout;
}

async function mapLimit(items, limit, fn) {
  const out = [];
  for (let i = 0; i < items.length; i += limit) out.push(...(await Promise.all(items.slice(i, i + limit).map(fn))));
  return out;
}

// ---------- repository ----------

const WRITE = new Set(["ADMIN", "MAINTAIN", "WRITE"]);

async function repoInfo(dir) {
  const r = JSON.parse(await gh(dir, ["repo", "view", "--json", "nameWithOwner,url,defaultBranchRef,viewerPermission,squashMergeAllowed"]));
  return {
    nameWithOwner: r.nameWithOwner, host: new URL(r.url).host, trunk: r.defaultBranchRef.name,
    canSquash: r.squashMergeAllowed && WRITE.has(r.viewerPermission ?? ""),
  };
}
const repoId = (r) => `${r.host}/${r.nameWithOwner}`.toLowerCase();

async function autoMergeAllowed(dir, repo) {
  const [owner, name] = repo.nameWithOwner.split("/");
  const out = await gh(dir, ["api", "graphql", "--hostname", repo.host,
    "-f", "query=query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { autoMergeAllowed } }",
    "-f", `owner=${owner}`, "-f", `name=${name}`, "--jq", ".data.repository.autoMergeAllowed"]);
  return out.trim() === "true";
}

const PR_FIELDS = "number,title,url,additions,deletions,changedFiles,headRefName,headRefOid,baseRefName,createdAt,isCrossRepository,isDraft,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup,autoMergeRequest";
const listOpenPrs = async (dir) => JSON.parse(await gh(dir, ["pr", "list", "--author", "@me", "--state", "open", "--limit", "100", "--json", PR_FIELDS]));

const THREADS = `query($q: String!) {
  search(query: $q, type: ISSUE, first: 100) {
    nodes { ... on PullRequest { number reviewThreads(first: 100) { nodes { isResolved isOutdated } } } }
  }
}`;
/** Unresolved, current review threads on your open PRs, by PR number. */
async function unresolvedThreads(dir, repo) {
  const out = JSON.parse(await gh(dir, ["api", "graphql", "--hostname", repo.host, "-f", `q=repo:${repo.nameWithOwner} is:pr is:open author:@me`, "-f", `query=${THREADS}`]));
  const counts = new Map();
  for (const n of out.data.search.nodes) {
    if (n.number === undefined) continue;
    counts.set(n.number, (n.reviewThreads?.nodes ?? []).filter((t) => !t.isResolved && !t.isOutdated).length);
  }
  return counts;
}

const STATE = { OPEN: "open", CLOSED: "closed", MERGED: "merged" };
/** The newest same-repository PR from `branch`, such as a parent that was merged. */
async function newestPrFrom(dir, branch) {
  const list = JSON.parse(await gh(dir, ["pr", "list", "--head", branch, "--state", "all", "--limit", "10", "--json", "number,state,isCrossRepository"]));
  const pr = list.find((c) => !c.isCrossRepository);
  return pr ? { number: pr.number, state: STATE[pr.state] } : null;
}

async function sshHostName(alias) {
  const { stdout } = await sh("ssh", ["-G", "--", alias], { timeout: 10000 }).catch(() => ({ stdout: "" }));
  return /^hostname (\S+)$/im.exec(stdout)?.[1] ?? alias;
}

/** The remote that points at the repository; agents fetch and push through it. */
async function remoteFor(dir, repo) {
  const verbose = await git(dir, ["remote", "-v"]);
  const aliases = new Set();
  for (const line of verbose.split("\n")) {
    const p = parseRemoteUrl(line.trim().split(/\s+/)[1] ?? "");
    if (p?.ssh) aliases.add(p.host);
  }
  const resolved = new Map(await Promise.all([...aliases].map(async (a) => [a, await sshHostName(a)])));
  return pickRemote(verbose, { repo: repo.nameWithOwner, host: repo.host }, (u) => (u.ssh ? (resolved.get(u.host) ?? u.host) : u.host));
}
async function requireRemote(dir, repo) {
  const remote = await remoteFor(dir, repo);
  if (!remote) throw new Error(`No git remote in ${dir} points to ${repo.host}/${repo.nameWithOwner}`);
  return remote;
}

const commitsNotOn = async (dir, ref, trunkOid) =>
  new Set((await git(dir, ["rev-list", "--max-count=500", ref, `^${trunkOid}`]).catch(() => "")).split("\n").filter(Boolean));

/** Each PR's parent PR from commit ancestry, so a branch built on another branch stacks even when it targets trunk. */
async function findGitStack(dir, prs, trunk, remote) {
  if (!remote) return { parents: new Map(), unique: new Map(), trunkOid: null, warning: "No git remote points to this repository, so stacks use PR bases only." };
  const trunkRef = `${remote}/${trunk}`;
  const trunkOid = (await git(dir, ["rev-parse", "--verify", "-q", trunkRef]).catch(() => "")).trim() || null;
  if (!trunkOid) return { parents: new Map(), unique: new Map(), trunkOid, warning: `Stacks from git ancestry need ${trunkRef}. Run git fetch.` };
  const present = await mapLimit(prs, MAX_PARALLEL_GIT, (pr) => git(dir, ["cat-file", "-e", `${pr.headRefOid}^{commit}`]).then(() => true, () => false));
  const missing = prs.filter((_, i) => !present[i]);
  let warning = null;
  if (missing.length) {
    // Fetching into FETCH_HEAD only adds objects; no local branch or ref changes.
    try {
      await git(dir, ["fetch", "--no-tags", "--quiet", remote, ...missing.map((pr) => `pull/${pr.number}/head`)], 60000);
    } catch {
      await Promise.all(missing.map((pr) => git(dir, ["fetch", "--no-tags", "--quiet", remote, `pull/${pr.number}/head`], 60000)
        .catch(() => { warning = `Could not fetch #${pr.number}; its stack may be missing.`; })));
    }
  }
  const sets = await mapLimit(prs, MAX_PARALLEL_GIT, (pr) => commitsNotOn(dir, pr.headRefOid, trunkOid));
  const unique = new Map(prs.map((pr, i) => [pr.number, sets[i]]));
  return { parents: gitStackParents(prs, unique), unique, trunkOid, warning };
}

async function checkedOutBranch(dir, trunk, trunkOid) {
  const name = (await git(dir, ["rev-parse", "--abbrev-ref", "HEAD"]).catch(() => "")).trim();
  if (!name || name === "HEAD" || name === trunk) return null;
  const oid = (await git(dir, ["rev-parse", "HEAD"]).catch(() => "")).trim();
  if (!oid) return null;
  return { name, oid, commits: trunkOid ? await commitsNotOn(dir, "HEAD", trunkOid) : new Set() };
}

async function listWorktrees(dir) {
  const branches = new Map();
  for (const block of (await git(dir, ["worktree", "list", "--porcelain"])).split(/\n\s*\n/)) {
    const p = /^worktree (.+)$/m.exec(block)?.[1];
    const b = /^branch refs\/heads\/(.+)$/m.exec(block)?.[1];
    if (p && b) branches.set(b, p);
  }
  return branches;
}

// Fork PRs get a branch in this mod's own namespace, so they never meet a user branch such as `pr/7`.
const localBranchFor = (pr) => (pr.isCrossRepository ? `pr-stack/fork-pr-${pr.number}` : pr.head);
const remotePrRef = (remote, pr) => (pr.isCrossRepository ? `refs/pr-stack/${remote}/pull/${pr.number}` : `refs/remotes/${remote}/${pr.head}`);

async function fetchPrHead(dir, remote, pr) {
  const ref = remotePrRef(remote, pr);
  const source = pr.isCrossRepository ? `refs/pull/${pr.number}/head` : `refs/heads/${pr.head}`;
  await git(dir, ["fetch", "--no-tags", "--quiet", remote, `+${source}:${ref}`], 60000);
  return (await git(dir, ["rev-parse", "--verify", `${ref}^{commit}`])).trim();
}

/** Herdr's worktree folder (settings.json `worktrees.directory`), then the repository's name. */
async function worktreeFolder(root) {
  let base = "~/.herdr/worktrees";
  try { base = JSON.parse(fs.readFileSync(path.join(HOME, ".config", "herdr-app", "settings.json"), "utf8"))?.worktrees?.directory ?? base; } catch { /* default */ }
  if (base === "~" || base.startsWith("~/")) base = HOME + base.slice(1);
  return path.join(base, path.basename(root));
}
const slug = (s) => s.replace(/[^\p{L}\p{M}\p{N}._-]+/gu, "-").replace(/^-+|-+$/g, "") || "branch";

// ---------- task records ----------

function readTasks() {
  try { return JSON.parse(fs.readFileSync(TASKS_FILE, "utf8")); } catch { return []; }
}
function writeTasks(list) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const tmp = `${TASKS_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(list, null, 1));
  fs.renameSync(tmp, TASKS_FILE);
}

/** Every task of a repository, newest first, with its terminal's live state. */
async function tasksFor(repo) {
  const terms = JSON.parse(await hc(["ls", "--json", "--all"]).catch(() => '{"terminals":[]}')).terminals ?? [];
  const byAddress = new Map(terms.map((t) => [t.address, t]));
  return readTasks().filter((t) => t.repo === repo).map((t) => {
    const term = byAddress.get(t.address);
    return { ...t, live: term?.state === "live", status: term ? (term.state === "live" ? term.status ?? "idle" : "exited") : "gone" };
  }).sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * Runs `work` while holding a lock for the repository, so a manual start and an automatic one
 * cannot both put an agent on one PR. A lock older than two minutes is a crashed run's.
 */
async function withLock(repo, work) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const lock = path.join(STATE_DIR, `${repo.replace(/[^a-z0-9]+/gi, "_")}.lock`);
  for (let i = 0; ; i++) {
    try { fs.mkdirSync(lock); break; } catch {
      try { if (Date.now() - fs.statSync(lock).mtimeMs > 120000) fs.rmSync(lock, { recursive: true, force: true }); } catch { /* gone */ }
      if (i > 300) throw new Error("Another PR stack action is still running for this repository");
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  try { return await work(); } finally { fs.rmSync(lock, { recursive: true, force: true }); }
}

// ---------- list ----------

async function list(dir, scope) {
  const [repo, prs] = await Promise.all([repoInfo(dir), listOpenPrs(dir)]);
  const { trunk } = repo;
  const id = repoId(repo);
  const warnings = [];
  const remote = await remoteFor(dir, repo).catch(() => null);
  const [stack, tasks, threads, worktrees, autoMerge] = await Promise.all([
    findGitStack(dir, prs, trunk, remote),
    tasksFor(id),
    unresolvedThreads(dir, repo).catch((e) => { warnings.push(`Review comments unavailable: ${e.message}`); return new Map(); }),
    listWorktrees(dir).catch(() => new Map()),
    repo.canSquash ? autoMergeAllowed(dir, repo).catch(() => false) : false,
  ]);
  if (stack.warning) warnings.push(stack.warning);
  const branch = await checkedOutBranch(dir, trunk, stack.trunkOid);
  const all = buildPrGroups(prs, trunk, stack.parents);
  const related = scope === "branch" && branch ? relatedPrs(prs, branch, stack.unique) : null;
  const fallback = related !== null && related.size === 0;
  const filtered = related !== null && !fallback;
  const groups = filtered ? scopeGroups(all, related) : all;
  const shown = groups.flatMap((g) => g.prs);
  await Promise.all(shown.filter((pr) => pr.retargetTo !== null).map(async (pr) => { pr.basePr = await newestPrFrom(dir, pr.base).catch(() => null); }));
  for (const pr of shown) {
    pr.threads = threads.get(pr.number) ?? 0;
    pr.canSquash = repo.canSquash && pr.base === trunk && pr.builtOn === null;
    pr.canAutoMerge = pr.canSquash && autoMerge;
    pr.worktree = worktrees.get(localBranchFor({ ...pr, isCrossRepository: pr.cross })) ?? null;
    const t = tasks.find((x) => x.number === pr.number && !x.archived);
    pr.task = t ? { kind: t.kind, address: t.address, status: t.status, live: t.live, trigger: t.trigger } : null;
  }
  return {
    repo: repo.nameWithOwner, host: repo.host, root: await mainCheckout(dir), trunk,
    branch: branch?.name ?? null, filtered, fallback, groups, warnings,
    running: activeTaskCount(tasks), total: prs.length, canSquash: repo.canSquash,
    land: await landState(id),
  };
}

// ---------- actions ----------

const ENABLE_AUTO_MERGE = `mutation($id: ID!, $head: GitObjectID!) {
  enablePullRequestAutoMerge(input: { pullRequestId: $id, mergeMethod: SQUASH, expectedHeadOid: $head }) { clientMutationId }
}`;

async function act(dir, action, n, headOid) {
  switch (action) {
    case "update": return (await gh(dir, ["pr", "update-branch", n])).trim() || `Updated #${n}`;
    case "ready": return (await gh(dir, ["pr", "ready", n])).trim() || `Marked #${n} ready for review`;
    case "retarget": {
      const { trunk } = await repoInfo(dir);
      await gh(dir, ["pr", "edit", n, "--base", trunk]);
      return `Moved #${n} to ${trunk}`;
    }
    // No --delete-branch: a worktree can hold the local branch, and a stacked PR can target it.
    case "close": return (await gh(dir, ["pr", "close", n])).trim() || `Closed #${n}`;
    // The head the person saw: a newer push makes the merge fail instead of merging unseen code.
    case "merge": return (await gh(dir, ["pr", "merge", n, "--squash", "--match-head-commit", headOid])).trim() || `Merged #${n}`;
    // Not `gh pr merge --auto`: gh merges at once when the PR is already mergeable, even with a
    // failing check that is not required. The API refuses that case, so nothing merges early.
    case "auto-merge": {
      const [{ host }, id] = await Promise.all([repoInfo(dir), gh(dir, ["pr", "view", n, "--json", "id", "--jq", ".id"])]);
      await gh(dir, ["api", "graphql", "--hostname", host, "-f", `query=${ENABLE_AUTO_MERGE}`, "-f", `id=${id.trim()}`, "-f", `head=${headOid}`]);
      return `Auto-merge on for #${n}`;
    }
    case "cancel-auto-merge": return (await gh(dir, ["pr", "merge", n, "--disable-auto"])).trim() || `Auto-merge off for #${n}`;
    default: throw new Error(`Unknown action ${action}`);
  }
}

async function taskTarget(dir, number, repo, remote) {
  const pr = JSON.parse(await gh(dir, ["pr", "view", String(number), "--repo", repoId(repo), "--json", "title,url,headRefName,headRefOid,baseRefName,isCrossRepository,statusCheckRollup"]));
  if (pr.isCrossRepository) throw new Error(`#${number} comes from a fork; fix it by hand`);
  return {
    repo: repo.nameWithOwner, host: repo.host, number, title: pr.title, url: pr.url, head: pr.headRefName,
    headOid: pr.headRefOid, base: pr.baseRefName, remote,
    failingChecks: toChecks(pr.statusCheckRollup).filter((c) => c.state === "fail").map(({ name, url }) => ({ name, url })),
  };
}

/** Claude Code asks once per new folder whether to trust it. The worktree is ours, so yes. */
async function acceptTrust(address) {
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const screen = await hc(["read", address, "--lines", "40"]).catch(() => "");
    if (!screen.includes("Yes, I trust this folder")) {
      if (/esc to interrupt|\? for shortcuts|auto mode/i.test(screen)) return;
      continue;
    }
    const onNo = screen.split("\n").some((l) => /❯/.test(l) && /No, exit/.test(l));
    await hc(["keys", address, ...(onNo ? ["down", "enter"] : ["enter"])]);
    return;
  }
}

/** Starts a task agent in a new worktree at the PR head; reuses a running one. Null when an automatic start is not due. */
async function startTask(dir, number, kind, trigger, extra, repoArg) {
  const repo = repoArg ?? (await repoInfo(dir));
  const id = repoId(repo);
  return withLock(id, async () => {
    const remote = await requireRemote(dir, repo);
    const target = await taskTarget(dir, number, repo, remote);
    // The head GitHub reported can move before the fetch; limits and history use the fetched one.
    const headOid = await fetchPrHead(dir, remote, { number, head: target.head, isCrossRepository: false });
    const tasks = await tasksFor(id);
    const history = tasks.filter((t) => t.number === number);
    const running = history.find(isActive);
    if (running) return { address: running.address, reused: true };
    if (trigger === "auto" && (activeTaskCount(tasks) >= MAX_ACTIVE_TASKS_PER_REPO || !mayStartAuto(history, kind, headOid))) return null;

    // A new branch from the fetched head: the person's own branch may hold unpushed commits that a
    // task must never publish, so it is never used or moved.
    const root = await mainCheckout(dir);
    const stamp = Date.now().toString(36).slice(-4);
    const branch = `pr-stack/pr-${number}-${kind}-${stamp}`;
    const worktree = path.join(await worktreeFolder(root), slug(branch));
    fs.mkdirSync(path.dirname(worktree), { recursive: true });
    await git(root, ["worktree", "add", "--quiet", "-b", branch, worktree, headOid], 120000);
    let address;
    try {
      const out = JSON.parse(await hc(["run", "--bg", "--json", "--no-parent", "--name", `pr${number}-${kind}-${stamp}`, "--cwd", worktree,
        "--label", `pr-stack.repo=${id}`, "--label", `pr-stack.pr=${number}`, "--label", `pr-stack.task=${kind}`, ...SPACE_LABEL,
        "--", ...AGENT_ARGV, taskPrompt(kind, { ...target, headOid }, extra)]));
      address = out.address ?? out.terminal?.address;
      if (!address) throw new Error(`hc run gave no address: ${JSON.stringify(out).slice(0, 200)}`);
    } catch (e) {
      await git(root, ["worktree", "remove", "--force", worktree]).catch(() => {});
      await git(root, ["branch", "-D", branch]).catch(() => {});
      throw e;
    }
    writeTasks([...readTasks(), { repo: id, number, kind, headOid, trigger, address, worktree, branch, root, createdAt: Date.now(), archived: false }]);
    await acceptTrust(address);
    return { address, reused: false };
  });
}

/** Removes a PR's finished task agents, their worktrees and the branches made for them. */
async function archive(dir, number) {
  const repo = await repoInfo(dir);
  const id = repoId(repo);
  return withLock(id, async () => {
    const tasks = (await tasksFor(id)).filter((t) => t.number === number && !t.archived);
    if (tasks.some(isActive)) throw new Error(`A task is still running on #${number}`);
    const notes = [];
    for (const t of tasks) {
      if (t.live) await hc(["kill", t.address]).catch(() => {});
      await hc(["rm", t.address]).catch(() => {});
      // Not --force: work an agent left uncommitted stays for the person to look at.
      const removed = await git(t.root, ["worktree", "remove", t.worktree]).then(() => true, () => false);
      if (!removed) { notes.push(`kept ${t.worktree}: it has uncommitted changes`); continue; }
      // The local branch goes only when a remote branch holds its commits, as the agent pushed them.
      const pushed = (await git(t.root, ["branch", "-r", "--contains", t.branch]).catch(() => "")).trim();
      if (pushed) await git(t.root, ["branch", "-D", t.branch]).catch(() => {});
      else notes.push(`kept branch ${t.branch}: its commits are not on a remote`);
    }
    const done = new Set(tasks.map((t) => t.address));
    writeTasks(readTasks().map((t) => (t.repo === id && done.has(t.address) ? { ...t, archived: true } : t)));
    return `Archived ${tasks.length} agent${tasks.length === 1 ? "" : "s"} on #${number}${notes.length ? `; ${notes.join("; ")}` : ""}`;
  });
}

/** The worktree that has the PR branch, made from the fetched head when there is none. */
async function checkout(dir, number) {
  const repo = await repoInfo(dir);
  const remote = await requireRemote(dir, repo);
  const pr = JSON.parse(await gh(dir, ["pr", "view", String(number), "--json", "headRefName,isCrossRepository"]));
  const target = { number, head: pr.headRefName, isCrossRepository: pr.isCrossRepository };
  const branch = localBranchFor(target);
  const root = await mainCheckout(dir);
  const existing = (await listWorktrees(root)).get(branch);
  if (existing) return { path: existing, created: false, branch };
  await fetchPrHead(dir, remote, target);
  // An existing local branch is left as it is: it may hold unpushed work.
  const has = await git(root, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]).then(() => true, () => false);
  if (!has) await git(root, ["branch", "--no-track", branch, remotePrRef(remote, target)]);
  const worktree = path.join(await worktreeFolder(root), slug(branch));
  fs.mkdirSync(path.dirname(worktree), { recursive: true });
  await git(root, ["worktree", "add", "--quiet", worktree, branch], 120000);
  return { path: worktree, created: true, branch };
}

/** Starts the automatic tasks that are due: at most one per PR, two per repository at a time. */
async function auto(dir, raw) {
  const settings = JSON.parse(raw || "{}");
  const enabled = settings.enabled ?? {};
  if (!TASK_KINDS.some((k) => enabled[k])) return { started: [] };
  const [repo, prs] = await Promise.all([repoInfo(dir), listOpenPrs(dir)]);
  const threads = enabled.comments ? await unresolvedThreads(dir, repo) : new Map();
  const ignored = new Set(settings.ignored ?? []);
  const tasks = await tasksFor(repoId(repo));
  const started = [];
  for (const { pr, kind } of nextTasks(prs, threads, tasks, enabled, ignored)) {
    try {
      const s = await startTask(dir, pr.number, kind, "auto", settings.prompts?.[kind] ?? "", repo);
      if (s && !s.reused) started.push({ number: pr.number, kind, address: s.address });
    } catch (e) {
      started.push({ number: pr.number, kind, error: e.message });
    }
  }
  return { started };
}

// ---------- merge a stack ----------

const LAND_DIR = path.join(STATE_DIR, "land");
const LAND_POLL_MS = 30000;
const LAND_FIXES = 2;                 // agent tries per PR and task kind
const LAND_PR_MS = 3 * 3600 * 1000;   // the longest one PR may take to become mergeable
const landFile = (id) => path.join(LAND_DIR, `${id.replace(/[^a-z0-9]+/gi, "_")}.json`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The stack merge of a repository: its steps, and whether its terminal still runs. */
async function landState(id) {
  let s;
  try { s = JSON.parse(fs.readFileSync(landFile(id), "utf8")); } catch { return null; }
  const terms = JSON.parse(await hc(["ls", "--json", "--all"]).catch(() => '{"terminals":[]}')).terminals ?? [];
  s.live = terms.some((t) => t.address === s.address && t.state === "live");
  // A finished or stopped merge stays on screen for an hour.
  if (!s.live && Date.now() - (s.updatedAt ?? 0) > 3600000) return null;
  return s;
}

async function landStart(dir, first, prompts) {
  const repo = await repoInfo(dir);
  const id = repoId(repo);
  if (!repo.canSquash) throw new Error("This repository does not allow squash merges, or you cannot merge");
  const running = await landState(id);
  if (running?.live) throw new Error(`A stack merge already runs here (from #${running.first})`);
  const root = await mainCheckout(dir);
  const out = JSON.parse(await hc(["run", "--bg", "--json", "--no-parent", "--name", `land-${first}-${Date.now().toString(36).slice(-4)}`, "--cwd", root,
    "--label", `pr-stack.land=${id}`, ...SPACE_LABEL, "--", "node", "--no-warnings", path.join(path.dirname(new URL(import.meta.url).pathname), "prs.mjs"), ...SPACE_ARG, "land", root, String(first), prompts ?? "{}"]));
  fs.mkdirSync(LAND_DIR, { recursive: true });
  fs.writeFileSync(landFile(id), JSON.stringify({ repo: id, first, address: out.address, order: [], steps: {}, current: null, done: false, error: null, startedAt: Date.now(), updatedAt: Date.now() }));
  return { address: out.address, message: `Merging the stack from #${first}` };
}

async function landStop(dir) {
  const id = repoId(await repoInfo(dir));
  const s = await landState(id);
  if (!s?.live) return { message: "No stack merge runs here" };
  await hc(["kill", s.address]).catch(() => {});
  s.error = "Stopped"; s.updatedAt = Date.now();
  fs.writeFileSync(landFile(id), JSON.stringify(s));
  return { message: "Stopped the stack merge. Agents it started keep running." };
}

/**
 * Squash-merges a stack into trunk one PR at a time, in merge order. Before each merge the PR
 * moves to trunk, leaves draft, gets an agent for conflicts or failing CI, and waits for its
 * checks. It stops at what it cannot fix: a required review, a closed PR, or a fix that failed twice.
 */
async function land(dir, first, promptsRaw) {
  const prompts = JSON.parse(promptsRaw || "{}");
  const repo = await repoInfo(dir);
  const id = repoId(repo);
  const file = landFile(id);
  const remote = await requireRemote(dir, repo);
  const state = JSON.parse(fs.readFileSync(file, "utf8"));
  const save = () => { state.updatedAt = Date.now(); fs.writeFileSync(file, JSON.stringify(state)); };
  const step = (n, status, note = "") => {
    const was = state.steps[n];
    state.steps[n] = { status, note };
    save();
    if (was?.status !== status || was?.note !== note) console.log(`${new Date().toTimeString().slice(0, 8)}  #${n}  ${status}${note ? `  ${note}` : ""}`);
  };
  try {
    const prs = await listOpenPrs(dir);
    const stack = await findGitStack(dir, prs, repo.trunk, remote);
    const group = buildPrGroups(prs, repo.trunk, stack.parents).find((g) => g.kind !== "independent" && g.prs.some((p) => p.number === first));
    if (!group) throw new Error(`#${first} is not in a stack`);
    state.order = group.prs.slice(group.prs.findIndex((p) => p.number === first)).map((p) => p.number);
    for (const n of state.order) step(n, "waiting");
    console.log(`Merging ${state.order.length} PRs into ${repo.trunk}: ${state.order.map((n) => `#${n}`).join(" → ")}`);
    for (const n of state.order) {
      state.current = n;
      await landOne(dir, repo, id, n, prompts, step);
    }
    state.current = null;
    state.done = true;
    save();
    console.log("Done: every PR of the stack is merged.");
  } catch (e) {
    state.error = e.message;
    save();
    console.log(`Stopped: ${e.message}`);
    process.exitCode = 1;
  }
}

async function landOne(dir, repo, id, n, prompts, step) {
  const fixes = { conflicts: 0, ci: 0 };
  const deadline = Date.now() + LAND_PR_MS;
  let blocked = 0;
  for (;;) {
    if (Date.now() > deadline) throw new Error(`#${n} did not become mergeable in 3 hours`);
    const pr = JSON.parse(await gh(dir, ["pr", "view", String(n), "--json", "state,baseRefName,headRefOid,isDraft,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup"]));
    if (pr.state === "MERGED") return step(n, "merged");
    if (pr.state === "CLOSED") throw new Error(`#${n} is closed`);
    const agent = (await tasksFor(id)).find((t) => t.number === n && isActive(t));
    if (agent) {
      step(n, "fixing", `agent ${agent.address} ${agent.status === "blocked" ? "needs you" : `is on ${agent.kind === "ci" ? "CI" : agent.kind}`}`);
      await sleep(LAND_POLL_MS);
      continue;
    }
    if (pr.baseRefName !== repo.trunk) {
      const base = await newestPrFrom(dir, pr.baseRefName).catch(() => null);
      if (base?.state === "open") { step(n, "waiting", `for #${base.number}`); await sleep(LAND_POLL_MS); continue; }
      step(n, "preparing", `base → ${repo.trunk}`);
      await gh(dir, ["pr", "edit", String(n), "--base", repo.trunk]);
      await sleep(8000);
      continue;
    }
    if (pr.isDraft) { step(n, "preparing", "marking ready"); await gh(dir, ["pr", "ready", String(n)]); continue; }
    // GitHub works out mergeability after each push or base change.
    if (pr.mergeable === "UNKNOWN" || pr.mergeStateStatus === "UNKNOWN") { step(n, "checking", "GitHub is checking"); await sleep(10000); continue; }
    const merge = mergeStatus(pr);
    const checks = toChecks(pr.statusCheckRollup);
    const ci = ciStatus(checks);
    const fix = async (kind, what) => {
      if (fixes[kind] >= LAND_FIXES) throw new Error(`#${n} still has ${what} after ${LAND_FIXES} agent fixes`);
      fixes[kind] += 1;
      step(n, "fixing", `starting an agent for ${what}`);
      await startTask(dir, n, kind, "land", prompts[kind] ?? "", repo);
      await sleep(15000);
    };
    if (merge === "conflicts") { await fix("conflicts", "conflicts"); continue; }
    if (ci === "pending") {
      const pass = checks.filter((c) => c.state === "pass").length;
      step(n, "checks", `CI running ${pass}/${checks.filter((c) => c.state !== "skipped").length}`);
      await sleep(LAND_POLL_MS);
      continue;
    }
    if (ci === "fail") { await fix("ci", "failing checks"); continue; }
    if (merge === "behind") { step(n, "preparing", "updating the branch"); await gh(dir, ["pr", "update-branch", String(n)]); await sleep(10000); continue; }
    if (merge === "blocked") {
      if (pr.reviewDecision === "REVIEW_REQUIRED" || pr.reviewDecision === "CHANGES_REQUESTED") {
        throw new Error(`#${n} needs an approving review before it can merge`);
      }
      // Required checks can report late; after ten looks the block is something else.
      if (++blocked > 10) throw new Error(`GitHub keeps #${n} blocked; open it to see why`);
      step(n, "checks", "waiting for required checks");
      await sleep(LAND_POLL_MS);
      continue;
    }
    if (merge !== "ready") { await sleep(10000); continue; }
    step(n, "merging");
    // The head that passed: a newer push makes the merge fail instead of merging unchecked code.
    await gh(dir, ["pr", "merge", String(n), "--squash", "--match-head-commit", pr.headRefOid]);
    step(n, "merged");
    // GitHub moves or closes the PRs on the merged branch after a moment.
    await sleep(8000);
    return;
  }
}

// ---------- deploys ----------

// What runs on the trunk after a merge: GitHub Actions push runs (CI, a backend deploy) and
// GitHub deployments that hosts such as Vercel report. A finished deployment's state is kept in
// a cache, so only running ones are asked again.
const DEPLOY_DIR = path.join(STATE_DIR, "deploys");
const MAX_COMMITS = 8;
const FINISHED = new Set(["success", "failure", "error", "inactive"]);

function runState(r) {
  if (r.status !== "completed") return r.status === "in_progress" ? "running" : "queued";
  if (r.conclusion === "success") return "success";
  if (r.conclusion === "cancelled") return "cancelled";
  if (r.conclusion === "skipped" || r.conclusion === "neutral") return "skipped";
  return "failure";
}

const deployState = (s) => ({ success: "success", inactive: "success", failure: "failure", error: "failure", in_progress: "running" })[s] ?? "queued";

async function deploys(dir) {
  const repo = await repoInfo(dir);
  const name = repo.nameWithOwner;
  const [runs, deps] = await Promise.all([
    gh(dir, ["api", `repos/${name}/actions/runs?branch=${encodeURIComponent(repo.trunk)}&event=push&per_page=50`]).then((x) => JSON.parse(x).workflow_runs ?? []),
    gh(dir, ["api", `repos/${name}/deployments?per_page=50`]).then((x) => JSON.parse(x)).catch(() => []),
  ]);
  const commits = new Map();
  for (const r of runs) {
    const c = commits.get(r.head_sha) ?? { sha: r.head_sha, title: r.display_title ?? "", at: Date.parse(r.created_at), checks: new Map() };
    c.at = Math.min(c.at, Date.parse(r.created_at));
    const label = r.name.replace(/^Deploy\s+/i, "").replace(/\s*\(.*\)\s*$/, "");
    const old = c.checks.get(`run:${label}`);
    // Re-runs of one workflow: the newest counts.
    if (!old || old.at < Date.parse(r.created_at)) {
      c.checks.set(`run:${label}`, { name: label, kind: label === "CI" ? "ci" : "deploy", state: runState(r), url: r.html_url, at: Date.parse(r.updated_at) });
    }
    commits.set(r.head_sha, c);
  }
  const shown = [...commits.values()].sort((a, b) => b.at - a.at).slice(0, MAX_COMMITS);
  const shas = new Set(shown.map((c) => c.sha));
  const file = path.join(DEPLOY_DIR, `${name.replace("/", "_")}.json`);
  let cache = {};
  try { cache = JSON.parse(fs.readFileSync(file, "utf8")); } catch { /* first read */ }
  const mine = deps.filter((d) => shas.has(d.sha));
  await mapLimit(mine, 6, async (d) => {
    if (cache[d.id] && FINISHED.has(cache[d.id].raw)) return;
    const [st] = JSON.parse(await gh(dir, ["api", `repos/${name}/deployments/${d.id}/statuses?per_page=1`]).catch(() => "[]"));
    cache[d.id] = { raw: st?.state ?? "queued", url: st?.log_url || st?.target_url || st?.environment_url || null, at: Date.parse(st?.updated_at ?? d.updated_at) };
  });
  for (const d of mine) {
    const c = shown.find((x) => x.sha === d.sha);
    // "Production – my-repo-web" becomes "web" in the repository my-repo.
    const repoName = name.split("/")[1];
    const label = d.environment.replace(/^(Production|Preview)\s*[–-]\s*/i, "").replace(new RegExp(`^${repoName}-`), "") || d.environment;
    const key = `dep:${d.environment}`;
    const old = c.checks.get(key);
    if (old && old.id > d.id) continue; // a redeploy of the same commit: the newest counts
    const st = cache[d.id];
    c.checks.set(key, { id: d.id, name: label, kind: "deploy", state: deployState(st.raw), url: st.url, at: st.at, production: /^production/i.test(d.environment) });
  }
  fs.mkdirSync(DEPLOY_DIR, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(cache));
  return {
    repo: name, trunk: repo.trunk,
    commits: shown.map((c) => ({
      sha: c.sha, title: c.title.replace(/\s*\(#\d+\)\s*$/, ""), pr: Number(/\(#(\d+)\)\s*$/.exec(c.title)?.[1]) || null, at: c.at,
      checks: [...c.checks.values()].sort((a, b) => (a.kind === "ci" ? -1 : b.kind === "ci" ? 1 : a.name.localeCompare(b.name))).map(({ id, ...x }) => x),
    })),
  };
}

// ---------- diff ----------

const DIFF_LINES = 3000;   // per file; the rest is on GitHub
const LINE_CHARS = 2000;
const FILES_QUERY = `query($owner: String!, $name: String!, $number: Int!, $after: String) { repository(owner: $owner, name: $name) { pullRequest(number: $number) {
  id files(first: 100, after: $after) { pageInfo { hasNextPage endCursor } nodes { path additions deletions changeType viewerViewedState } } } } }`;
const CHANGE = { ADDED: "A", DELETED: "D", RENAMED: "R", COPIED: "C", CHANGED: "M", MODIFIED: "M" };

/** A unified diff as path -> lines from the first hunk, or a one-line note for a binary file. */
function splitPatch(patch) {
  const out = new Map();
  for (const part of patch.split(/^diff --git /m).slice(1)) {
    const lines = part.split("\n");
    const to = lines.find((l) => l.startsWith("+++ "))?.slice(4);
    const from = lines.find((l) => l.startsWith("--- "))?.slice(4);
    const renamed = lines.find((l) => l.startsWith("rename to "))?.slice(10);
    const file = (to && to !== "/dev/null" ? to.replace(/^b\//, "") : from && from !== "/dev/null" ? from.replace(/^a\//, "") : renamed)
      ?? /^a\/(.*) b\//.exec(lines[0])?.[1];
    if (!file) continue;
    const first = lines.findIndex((l) => l.startsWith("@@"));
    const body = first < 0 ? [lines.some((l) => l.startsWith("Binary files")) ? "Binary file changed" : "No text changes"] : lines.slice(first);
    if (body.at(-1) === "") body.pop();
    out.set(file, body.length > DIFF_LINES
      ? [...body.slice(0, DIFF_LINES), `… ${body.length - DIFF_LINES} more lines on GitHub`]
      : body.map((l) => (l.length > LINE_CHARS ? `${l.slice(0, LINE_CHARS)}… (line cut)` : l)));
  }
  return out;
}

/** The PR's patch from gh. GitHub refuses a diff over 300 files or 20,000 lines: then git
 * compares the PR head with its base from their merge base, as GitHub does. */
async function prPatch(dir, repo, number, base, headOid) {
  try { return await gh(dir, ["pr", "diff", String(number), "--color", "never"]); } catch (e) {
    if (!/too large|maximum|exceeded|406/i.test(e.message)) throw e;
  }
  const root = await mainCheckout(dir);
  const remote = await requireRemote(root, repo);
  await git(root, ["fetch", "--no-tags", remote, `+refs/heads/${base}:refs/remotes/${remote}/${base}`, `refs/pull/${number}/head`], 120000);
  const { stdout } = await sh("git", ["diff", "--no-color", "--no-ext-diff", "--no-textconv", `${remote}/${base}...${headOid}`],
    { cwd: root, timeout: 60000, maxBuffer: 256 << 20 });
  return stdout;
}

async function diff(dir, number) {
  const repo = await repoInfo(dir);
  const [owner, name] = repo.nameWithOwner.split("/");
  const pr = JSON.parse(await gh(dir, ["pr", "view", String(number), "--json", "title,url,headRefName,headRefOid,baseRefName,additions,deletions,changedFiles"]));
  const files = [];
  let id = null;
  for (let after = null; ;) {
    const out = JSON.parse(await gh(dir, ["api", "graphql", "--hostname", repo.host, "-f", `query=${FILES_QUERY}`,
      "-f", `owner=${owner}`, "-f", `name=${name}`, "-F", `number=${number}`, ...(after ? ["-f", `after=${after}`] : [])]));
    const page = out.data.repository.pullRequest;
    id = page.id;
    files.push(...page.files.nodes);
    if (!page.files.pageInfo.hasNextPage || files.length >= 3000) break;
    after = page.files.pageInfo.endCursor;
  }
  const patch = splitPatch(await prPatch(dir, repo, number, pr.baseRefName, pr.headRefOid));
  return {
    repo: repo.nameWithOwner, number, id, title: pr.title, url: pr.url, head: pr.headRefName, base: pr.baseRefName, headOid: pr.headRefOid,
    add: pr.additions, del: pr.deletions, changed: pr.changedFiles,
    files: files.map((f) => ({
      path: f.path, status: CHANGE[f.changeType] ?? "M", add: f.additions, del: f.deletions, anchor: createHash("sha256").update(f.path).digest("hex"),
      viewed: f.viewerViewedState === "VIEWED" ? "yes" : f.viewerViewedState === "DISMISSED" ? "changed" : "no",
      lines: patch.get(f.path) ?? ["No diff for this file"],
    })),
  };
}

/** GitHub's own "Viewed" box on the PR's Files tab, so the two stay in step. */
async function viewed(dir, prId, file, on) {
  const repo = await repoInfo(dir);
  const op = on ? "markFileAsViewed" : "unmarkFileAsViewed";
  await gh(dir, ["api", "graphql", "--hostname", repo.host, "-f", `query=mutation($id: ID!, $path: String!) { ${op}(input: { pullRequestId: $id, path: $path }) { clientMutationId } }`,
    "-f", `id=${prId}`, "-f", `path=${file}`]);
  return { ok: true };
}

// ---------- main ----------

// The space the panel was in. Agents carry it as agent-flow.space so Agent Flow shows them
// there; herdr.space would instead make the window open a tab for each agent.
const SPACE_ARG = process.argv.filter((a) => a.startsWith("--space=")).slice(0, 1);
const SPACE_LABEL = SPACE_ARG.length ? ["--label", `agent-flow.space=${SPACE_ARG[0].slice(8)}`] : [];

const [cmd, dir, ...rest] = process.argv.slice(2).filter((a) => !a.startsWith("--space="));
try {
  if (!dir) throw new Error("usage: prs.mjs <command> <dir> ...");
  let out;
  if (cmd === "list") out = await list(dir, rest[0] === "all" ? "all" : "branch");
  else if (cmd === "act") out = { message: await act(dir, rest[0], rest[1], rest[2]) };
  else if (cmd === "task") {
    const s = await startTask(dir, Number(rest[0]), rest[1], "manual", rest[2] ?? "");
    out = { ...s, message: s.reused ? `An agent already works on #${rest[0]}` : `Started an agent on #${rest[0]}` };
  } else if (cmd === "archive") out = { message: await archive(dir, Number(rest[0])) };
  else if (cmd === "deploys") out = await deploys(dir);
  else if (cmd === "diff") out = await diff(dir, Number(rest[0]));
  else if (cmd === "viewed") out = await viewed(dir, rest[0], rest[1], rest[2] === "on");
  else if (cmd === "checkout") out = await checkout(dir, Number(rest[0]));
  else if (cmd === "auto") out = await auto(dir, rest[0]);
  else if (cmd === "land-start") out = await landStart(dir, Number(rest[0]), rest[1]);
  else if (cmd === "land-stop") out = await landStop(dir);
  else if (cmd === "land") { await land(dir, Number(rest[0]), rest[1]); process.exit(); }
  else throw new Error(`Unknown command ${cmd}`);
  process.stdout.write(JSON.stringify(out));
} catch (e) {
  process.stdout.write(JSON.stringify({ error: e.message }));
  process.exitCode = 1;
}
