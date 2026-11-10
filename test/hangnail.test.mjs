// npm test: hangnail stops a test file that passes but never exits, names it, and leaves a normal
// run alone.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
    "100 1 01:00 npm test",
    "101 100 00:59 sh -c node --test tests/slow.test.ts tests/quick.test.ts tests/last.test.ts",
    "102 101 00:59 node --test --test-concurrency=2 tests/slow.test.ts tests/quick.test.ts tests/last.test.ts",
    "103 102 14:13 node --import tsx tests/slow.test.ts",
    "104 102 00:02 node --import tsx tests/quick.test.ts",
    "105 103 14:20 node --import tsx tests/slow.test.ts",
    "106 102 00:30 node scripts/helper.mjs",
    "200 1 30:00 node --test someone-else.test.ts",
  ].join("\n");
  assert.deepEqual(runningTestFiles(100, { psText }), [
    { file: "tests/slow.test.ts", seconds: 860 },
    { file: "tests/quick.test.ts", seconds: 2 },
  ]);
});

test("the runner that lists every file is never taken for its last file", () => {
  // the runner's command ends in a test file path and is as old as the whole run
  const psText = [
    "100 1 05:00 node --test a.test.ts b.test.ts last.test.ts",
    "101 100 00:01 node a.test.ts",
  ].join("\n");
  assert.deepEqual(runningTestFiles(100, { psText }), [{ file: "a.test.ts", seconds: 1 }]);
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

test("cli: exits 124 and names the file on a hang; passes the command's own code through", () => {
  const { NODE_TEST_CONTEXT: _nested, ...env } = process.env;
  const hung = spawnSync(process.execPath, [cli, "--file-limit", "3", "--poll", "0.5", "--", process.execPath, "--test", stuck], { cwd: dir, env, encoding: "utf8" });
  assert.equal(hung.status, 124);
  assert.match(hung.stderr, /HUNG[\s\S]*stuck\.test\.mjs/);
  const ok = spawnSync(process.execPath, [cli, "--", process.execPath, "-e", "process.exit(3)"], { env, encoding: "utf8" });
  assert.equal(ok.status, 3);
  const help = spawnSync(process.execPath, [cli], { env, encoding: "utf8" });
  assert.equal(help.status, 2);
  assert.match(help.stdout, /hangnail \[options\] -- <command/);
});
