// hangnail: catches a test file that never finishes, so a hung suite fails in minutes instead of
// spinning for hours. MIT License, (c) 2026 1UP Creative.
//
// Runners like `node --test` give every test file its own process. Every few seconds hangnail lists
// the test files still running under your command. One that runs past the per-file limit (or a run
// past the total limit) stops the whole process group, and hangnail names the file.
//
// Why a file hangs: its tests can all pass while the file never exits, because something keeps
// the process alive. Usually an open timer or socket, or a database call that lands after teardown
// closed the pool.
import { execFileSync, spawn } from "node:child_process";

const DEFAULT_MATCH = /\S+\.(?:test|spec)\.[cm]?[jt]sx?$/;

/** ps elapsed time ("ss", "mm:ss", "hh:mm:ss" or "d-hh:mm:ss") as seconds */
export function etimeSeconds(etime) {
  const [days, clock] = etime.includes("-") ? etime.split("-") : ["0", etime];
  return Number(days) * 86_400 + clock.split(":").reduce((s, part) => s * 60 + Number(part), 0);
}

const readPs = () => execFileSync("ps", ["-A", "-o", "pid=,ppid=,etime=,command="], { encoding: "utf8" });

/** The test files still running under `rootPid`, each with how long it has run, oldest process wins. */
export function runningTestFiles(rootPid, { match = DEFAULT_MATCH, psText = readPs() } = {}) {
  const rows = psText.split("\n").map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/)).filter(Boolean)
    .map(([, pid, ppid, etime, command]) => ({ pid: Number(pid), ppid: Number(ppid), etime, command }));
  const under = new Set([rootPid]);
  for (let grew = true; grew;) {
    grew = false;
    for (const r of rows) if (under.has(r.ppid) && !under.has(r.pid)) { under.add(r.pid); grew = true; }
  }
  const files = [];
  for (const r of rows) {
    if (!under.has(r.pid) || r.pid === rootPid) continue;
    // a test file's own process names exactly one test file; a runner (or an npm script) that
    // lists several is the parent of the run, not a file, and its age is the whole run's
    const named = r.command.split(/\s+/).filter((token) => match.test(token));
    if (named.length !== 1) continue;
    const file = named[0];
    const seconds = etimeSeconds(r.etime);
    const seen = files.find((f) => f.file === file);
    if (!seen) files.push({ file, seconds });
    else seen.seconds = Math.max(seen.seconds, seconds);
  }
  return files;
}

/**
 * Run `cmd args` and watch it.
 * Resolves { status, out, hung, timedOut }: `hung` lists the test files still running when the run
 * was stopped (empty when it finished on its own); `out` is everything it printed.
 * Options: fileLimitS (default 300), totalLimitS (default 0 = none), pollMs (default 5000),
 * match (RegExp for a test file path in a process's command line), cwd, env, and echo (also stream
 * the output live to this process's stdout and stderr).
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
    const signal = (sig) => { try { process.kill(-child.pid, sig); } catch { /* already gone */ } };
    const stop = () => { signal("SIGTERM"); setTimeout(() => signal("SIGKILL"), 3000).unref(); };
    const onInterrupt = () => stop();
    process.once("SIGINT", onInterrupt);
    const timer = setInterval(() => {
      let running;
      try { running = runningTestFiles(child.pid, { match }); } catch { return; } // ps hiccup: look again
      const over = running.filter((f) => f.seconds >= fileLimitS);
      timedOut = totalLimitS > 0 && (Date.now() - started) / 1000 >= totalLimitS;
      if (over.length || timedOut) {
        hung = over.length ? over : running;
        clearInterval(timer);
        stop();
      }
    }, pollMs);
    child.on("error", (err) => { clearInterval(timer); process.off("SIGINT", onInterrupt); reject(err); });
    child.on("close", (status) => {
      clearInterval(timer);
      process.off("SIGINT", onInterrupt);
      resolve({ status, out: Buffer.concat(chunks).toString("utf8"), hung, timedOut });
    });
  });
}

const minSec = (s) => `${Math.floor(s / 60)}m ${s % 60}s`;

/** A short plain report of a stopped run: which files, how long, where to look. */
export function report({ hung, timedOut }, { fileLimitS = 300 } = {}) {
  const head = timedOut && !hung.some((f) => f.seconds >= fileLimitS)
    ? "HUNG: the whole run passed its time limit"
    : `HUNG: a test file ran past ${minSec(fileLimitS)} without finishing`;
  const lines = hung.map((f) => `  ${f.file} (running ${minSec(f.seconds)})`);
  return `${head}\n${lines.join("\n") || "  (no test file was running: the command itself stalled)"}\n` +
    "  Its tests may all pass while the file never exits. Look for an open timer or socket, or a\n" +
    "  database call that lands after teardown closed the pool. Run that file alone to see it.";
}
