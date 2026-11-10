// hangnail: catches a test file that never finishes, so a hung suite fails in minutes instead of
// spinning for hours. MIT License, (c) 2026 1UP Creative.
//
// Runners like `node --test` give every test file its own process. Every few seconds hangnail lists
// the test files still running under your command. One that runs past the per-file limit (or a run
// past the total limit) stops everything the command started, and hangnail names the file.
//
// Why a file hangs: its tests can all pass while the file never exits, because something keeps
// the process alive. Usually an open timer or socket, or a database call that lands after teardown
// closed the pool.
import { execFileSync, spawn } from "node:child_process";

const DEFAULT_MATCH = /\S+\.(?:test|spec)\.[cm]?[jt]sx?$/;
/** polls in a row that may fail to read `ps` before hangnail stops the run rather than go blind */
const PS_FAILS_ALLOWED = 3;
const MIN_POLL_MS = 500;

/** ps elapsed time ("ss", "mm:ss", "hh:mm:ss" or "d-hh:mm:ss") as seconds */
export function etimeSeconds(etime) {
  const [days, clock] = etime.includes("-") ? etime.split("-") : ["0", etime];
  return Number(days) * 86_400 + clock.split(":").reduce((s, part) => s * 60 + Number(part), 0);
}

// -ww: never cut long command lines; a big buffer: a busy machine's process list runs to megabytes
const readPs = () => execFileSync("ps", ["-ww", "-A", "-o", "pid=,ppid=,pgid=,etime=,command="], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

/** Every process the run started: children of `rootPid` by parent, plus anything left in its
 *  process group after its parent died. `rootPid` itself is included. */
export function processTree(rootPid, psText = readPs()) {
  const rows = psText.split("\n").map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/)).filter(Boolean)
    .map(([, pid, ppid, pgid, etime, command]) => ({ pid: Number(pid), ppid: Number(ppid), pgid: Number(pgid), etime, command }));
  const under = new Set([rootPid, ...rows.filter((r) => r.pgid === rootPid).map((r) => r.pid)]);
  for (let grew = true; grew;) {
    grew = false;
    for (const r of rows) if (under.has(r.ppid) && !under.has(r.pid)) { under.add(r.pid); grew = true; }
  }
  return rows.filter((r) => under.has(r.pid));
}

/** The test files running in `tree`, each with how long it has run (its oldest process wins).
 *  A test file's process names exactly one test file and is not a runner: a `--test` runner, or
 *  a shell or npm script that lists several files, is as old as the whole run. */
export function testFilesIn(tree, match = DEFAULT_MATCH) {
  const files = [];
  for (const r of tree) {
    const tokens = r.command.split(/\s+/);
    if (tokens.includes("--test")) continue;
    const named = tokens.filter((token) => match.test(token));
    if (named.length !== 1) continue;
    const seconds = etimeSeconds(r.etime);
    const seen = files.find((f) => f.file === named[0]);
    if (!seen) files.push({ file: named[0], seconds });
    else seen.seconds = Math.max(seen.seconds, seconds);
  }
  return files;
}

/** The test files still running under `rootPid`. */
export function runningTestFiles(rootPid, { match = DEFAULT_MATCH, psText } = {}) {
  return testFilesIn(processTree(rootPid, psText), match);
}

const STOP_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"];

/**
 * Run `cmd args` and watch it.
 * Resolves { status, signal, out, hung, timedOut, blind }: `hung` lists the test files still
 * running when the run was stopped (empty when it finished on its own); `blind` is true when `ps`
 * kept failing and hangnail stopped the run instead of watching nothing; `out` is everything it
 * printed. Options: fileLimitS (default 300), totalLimitS (default 0 = none), pollMs (default 5000,
 * at least 500), match (RegExp for one command-line token naming a test file), cwd, env, and echo
 * (also stream the output live).
 * If this process gets SIGINT, SIGTERM or SIGHUP, hangnail stops everything the run started first,
 * then lets the signal through.
 */
export function watch(cmd, args = [], { fileLimitS = 300, totalLimitS = 0, pollMs = 5000, match = DEFAULT_MATCH, cwd, env = process.env, echo = false } = {}) {
  return new Promise((resolve, reject) => {
    // a runner started from inside another `node --test` run would skip its files: drop the marker
    const { NODE_TEST_CONTEXT: _nested, ...childEnv } = env;
    // its own process group, so a stop reaches the runner and every test file under it
    const child = spawn(cmd, args, { cwd, env: childEnv, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const chunks = [];
    child.stdout.on("data", (d) => { chunks.push(d); if (echo) process.stdout.write(d); });
    child.stderr.on("data", (d) => { chunks.push(d); if (echo) process.stderr.write(d); });
    const started = Date.now();
    let hung = [];
    let timedOut = false;
    let blind = false;
    let stopping = false;
    let psFails = 0;
    let seen = new Set(); // every pid the run has shown, for helpers that left the group

    const killAll = (sig) => {
      try { process.kill(-child.pid, sig); } catch { /* group already gone */ }
      if (sig === "SIGKILL") for (const pid of seen) { try { process.kill(pid, sig); } catch { /* gone */ } }
    };
    const stop = () => {
      if (stopping) return;
      stopping = true;
      killAll("SIGTERM");
      setTimeout(() => killAll("SIGKILL"), 3000).unref();
    };
    const look = () => {
      try { seen = new Set([...seen, ...processTree(child.pid).map((r) => r.pid)]); } catch { /* best effort */ }
    };
    // this process is being stopped: take the run down with it, then let the signal through
    const onSignal = (sig) => {
      look();
      killAll("SIGKILL");
      for (const s of STOP_SIGNALS) process.off(s, onSignal);
      process.kill(process.pid, sig);
    };
    for (const s of STOP_SIGNALS) process.on(s, onSignal);

    const timer = setInterval(() => {
      timedOut = totalLimitS > 0 && (Date.now() - started) / 1000 >= totalLimitS;
      let tree = null;
      try { tree = processTree(child.pid); psFails = 0; } catch { psFails++; }
      if (tree) {
        for (const r of tree) seen.add(r.pid);
        const over = testFilesIn(tree, match).filter((f) => f.seconds >= fileLimitS);
        if (over.length) hung = over;
        else if (timedOut) hung = testFilesIn(tree, match);
      } else if (psFails >= PS_FAILS_ALLOWED) blind = true;
      if (hung.length || timedOut || blind) { clearInterval(timer); stop(); }
    }, Math.max(MIN_POLL_MS, pollMs));

    const done = () => {
      clearInterval(timer);
      for (const s of STOP_SIGNALS) process.off(s, onSignal);
    };
    child.on("error", (err) => { done(); reject(err); });
    child.on("close", (status, signal) => {
      done();
      // anything that shrugged off SIGTERM, or slipped out of the group, goes now
      if (stopping) { look(); killAll("SIGKILL"); }
      resolve({ status, signal, out: Buffer.concat(chunks).toString("utf8"), hung, timedOut, blind });
    });
  });
}

const minSec = (s) => `${Math.floor(s / 60)}m ${s % 60}s`;

/** A short plain report of a stopped run: which files, how long, where to look. */
export function report({ hung, timedOut, blind }, { fileLimitS = 300 } = {}) {
  if (blind) return "STOPPED: hangnail couldn't read the process list (ps), so it stopped the run instead of watching nothing.";
  const head = timedOut && !hung.some((f) => f.seconds >= fileLimitS)
    ? "HUNG: the whole run passed its time limit"
    : `HUNG: a test file ran past ${minSec(fileLimitS)} without finishing`;
  if (!hung.length) return `${head}\n  No test file was running, so the command itself stalled. Run it alone and watch where it stops.`;
  return `${head}\n${hung.map((f) => `  ${f.file} (running ${minSec(f.seconds)})`).join("\n")}\n` +
    "  Its tests may all pass while the file never exits. Look for an open timer or socket, or a\n" +
    "  database call that lands after teardown closed the pool. Run that file alone to see it.";
}
