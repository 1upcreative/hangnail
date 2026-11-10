// npm test: hangnail stops a test file that passes but never exits, names it, and leaves a normal
// run alone.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { etimeSeconds, report, runningTestFiles, watch } from "../src/index.mjs";

const dir = mkdtempSync(join(tmpdir(), "hangnail-"));
test.after(() => rmSync(dir, { recursive: true, force: true }));
const quick = join(dir, "quick.test.mjs");
const stuck = join(dir, "stuck.test.mjs");
writeFileSync(quick, `import test from "node:test";\ntest("quick", () => {});\n`);
// passes, then keeps the process alive the way an open socket or timer does
writeFileSync(stuck, `import test from "node:test";\ntest("passes", () => { setInterval(() => {}, 1000); });\n`);
const cli = fileURLToPath(new URL("../bin/hangnail.mjs", import.meta.url));

test("ps elapsed times read as seconds", () => {
  assert.equal(etimeSeconds("05"), 5);
  assert.equal(etimeSeconds("14:13"), 853);
  assert.equal(etimeSeconds("01:02:03"), 3723);
  assert.equal(etimeSeconds("2-00:00:10"), 172_810);
});

test("only test files under the run are listed, once each, at their longest", () => {
  const psText = [
    "100 1 100 01:00 npm test",
    "101 100 100 00:59 sh -c node --test tests/slow.test.ts tests/quick.test.ts tests/last.test.ts",
    "102 101 100 00:59 node --test --test-concurrency=2 tests/slow.test.ts tests/quick.test.ts tests/last.test.ts",
    "103 102 100 14:13 node --import tsx tests/slow.test.ts",
    "104 102 100 00:02 node --import tsx tests/quick.test.ts",
    "105 103 100 14:20 node --import tsx tests/slow.test.ts",
    "106 102 100 00:30 node scripts/helper.mjs",
    "200 1 200 30:00 node someone-else.test.ts",
  ].join("\n");
  assert.deepEqual(runningTestFiles(100, { psText }), [
    { file: "tests/slow.test.ts", seconds: 860 },
    { file: "tests/quick.test.ts", seconds: 2 },
  ]);
});

test("a runner is never taken for a test file, even when it names just one", () => {
  const psText = [
    "100 1 100 05:00 node --test tests/**/*.test.ts",
    "101 100 100 00:01 node a.test.ts",
  ].join("\n");
  assert.deepEqual(runningTestFiles(100, { psText }), [{ file: "a.test.ts", seconds: 1 }]);
});

test("the command itself can be the test file, and a file whose parent died is still watched", () => {
  assert.deepEqual(runningTestFiles(100, { psText: "100 1 100 06:00 node stuck.test.mjs" }), [{ file: "stuck.test.mjs", seconds: 360 }]);
  // the runner is gone and the file was handed to pid 1, but it is still in the run's group
  assert.deepEqual(runningTestFiles(100, { psText: "300 1 100 07:00 node tests/orphan.test.ts" }), [{ file: "tests/orphan.test.ts", seconds: 420 }]);
});

test("a file that never exits is stopped and named; the quick one is not", async () => {
  const t0 = Date.now();
  const r = await watch(process.execPath, ["--test", "--test-concurrency=2", quick, stuck], { cwd: dir, fileLimitS: 3, pollMs: 500 });
  assert.ok(Date.now() - t0 < 15_000, "stopped within seconds, not left to spin");
  assert.deepEqual(r.hung.map((f) => f.file), [stuck]);
  assert.equal(r.timedOut, false);
  assert.match(report(r, { fileLimitS: 3 }), /HUNG[\s\S]*stuck\.test\.mjs/);
});

test("a normal run finishes on its own and nothing is flagged", async () => {
  const r = await watch(process.execPath, ["--test", quick], { cwd: dir, fileLimitS: 3, pollMs: 500 });
  assert.equal(r.status, 0);
  assert.deepEqual(r.hung, []);
  assert.match(r.out, /pass 1/);
});

test("the total limit stops a run even when no single file is over", async () => {
  const r = await watch(process.execPath, ["--test", stuck], { cwd: dir, fileLimitS: 60, totalLimitS: 2, pollMs: 500 });
  assert.equal(r.timedOut, true);
  assert.match(report(r, { fileLimitS: 60 }), /whole run passed its time limit/);
});

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const waitGone = async (pid) => { for (let i = 0; i < 40 && alive(pid); i++) await new Promise((r) => setTimeout(r, 100)); return !alive(pid); };

test("a helper that left the run's process group is still stopped", async () => {
  const pidFile = join(dir, "helper.pid");
  const sneaky = join(dir, "sneaky.test.mjs");
  writeFileSync(sneaky, `import test from "node:test";\nimport { spawn } from "node:child_process";\nimport { writeFileSync } from "node:fs";\n` +
    `test("starts a helper in its own group", () => { const h = spawn("sleep", ["60"], { detached: true, stdio: "ignore" }); writeFileSync(${JSON.stringify(pidFile)}, String(h.pid)); setInterval(() => {}, 1000); });\n`);
  const r = await watch(process.execPath, ["--test", sneaky], { cwd: dir, fileLimitS: 2, pollMs: 500 });
  assert.deepEqual(r.hung.map((f) => f.file), [sneaky]);
  const helper = Number(readFileSync(pidFile, "utf8"));
  assert.ok(await waitGone(helper), "the detached helper did not outlive the stop");
});

test("stopping hangnail itself stops the whole run", async () => {
  const pidFile = join(dir, "victim.pid");
  const victim = join(dir, "victim.test.mjs");
  writeFileSync(victim, `import test from "node:test";\nimport { writeFileSync } from "node:fs";\ntest("waits", () => { writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000); });\n`);
  const { NODE_TEST_CONTEXT: _nested, ...env } = process.env;
  const h = spawn(process.execPath, [cli, "--", process.execPath, "--test", victim], { cwd: dir, env, stdio: "ignore" });
  for (let i = 0; i < 50 && !existsSync(pidFile); i++) await new Promise((r) => setTimeout(r, 100));
  const testPid = Number(readFileSync(pidFile, "utf8"));
  h.kill("SIGTERM");
  const [, signal] = await once(h, "exit");
  assert.equal(signal, "SIGTERM", "hangnail lets the signal through after cleaning up");
  assert.ok(await waitGone(testPid), "the test file did not keep running after hangnail was stopped");
});

test("cli: exits 124 and names the file on a hang; passes the command's own code through", () => {
  const { NODE_TEST_CONTEXT: _nested, ...env } = process.env;
  const hung = spawnSync(process.execPath, [cli, "--file-limit", "3", "--poll", "0.5", "--", process.execPath, "--test", stuck], { cwd: dir, env, encoding: "utf8" });
  assert.equal(hung.status, 124);
  assert.match(hung.stderr, /HUNG[\s\S]*stuck\.test\.mjs/);
  const ok = spawnSync(process.execPath, [cli, "--", process.execPath, "-e", "process.exit(3)"], { env, encoding: "utf8" });
  assert.equal(ok.status, 3);
  const killed = spawnSync(process.execPath, [cli, "--", process.execPath, "-e", "process.kill(process.pid, 'SIGTERM')"], { env, encoding: "utf8" });
  assert.equal(killed.status, 143, "a command killed by SIGTERM exits 128 + 15");
  const help = spawnSync(process.execPath, [cli], { env, encoding: "utf8" });
  assert.equal(help.status, 2);
  assert.match(help.stdout, /hangnail \[options\] -- <command/);
});
