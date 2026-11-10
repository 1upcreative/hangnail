#!/usr/bin/env node
// hangnail [--file-limit <s>] [--total-limit <s>] [--poll <s>] [--match <regex>] -- <command...>
// Runs the command with its output live. Exits with the command's own code, or 124 when a test
// file hung and hangnail stopped the run.
import { constants } from "node:os";
import { report, watch } from "../src/index.mjs";

const HELP = `hangnail: stop a test run when a test file hangs, and name the file.

  hangnail [options] -- <command...>

  --file-limit <s>   stop when one test file runs this long (default 300, env HANGNAIL_FILE_LIMIT)
  --total-limit <s>  stop when the whole run takes this long (default none, env HANGNAIL_TOTAL_LIMIT)
  --poll <s>         how often to look (default 5, at least 0.5)
  --match <regex>    what a test file path looks like (default *.test.* and *.spec.*)

  Exit code: the command's own, or 124 when hangnail stopped a hung run.
  Example: hangnail --file-limit 120 -- node --test`;

const argv = process.argv.slice(2);
const dash = argv.indexOf("--");
const flags = dash === -1 ? argv : argv.slice(0, dash);
const command = dash === -1 ? [] : argv.slice(dash + 1);
if (!command.length || flags.includes("-h") || flags.includes("--help")) {
  console.log(HELP);
  process.exit(command.length ? 0 : 2);
}
const flag = (name) => { const i = flags.indexOf(name); return i === -1 ? undefined : flags[i + 1]; };
const seconds = (value, fallback) => {
  if (value === undefined || value === "") return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) { console.error(`hangnail: "${value}" is not a number of seconds`); process.exit(2); }
  return n;
};
const fileLimitS = seconds(flag("--file-limit") ?? process.env.HANGNAIL_FILE_LIMIT, 300);
const totalLimitS = seconds(flag("--total-limit") ?? process.env.HANGNAIL_TOTAL_LIMIT, 0);
const pollMs = seconds(flag("--poll"), 5) * 1000;
const match = flag("--match") ? new RegExp(flag("--match")) : undefined;

try {
  const result = await watch(command[0], command.slice(1), { fileLimitS, totalLimitS, pollMs, match, echo: true });
  if (result.hung.length || result.timedOut || result.blind) {
    console.error(`\n💅 ${report(result, { fileLimitS })}`);
    process.exit(124);
  }
  // a command killed by a signal exits the shell way: 128 + the signal's number
  if (result.status === null && result.signal) process.exit(128 + (constants.signals[result.signal] ?? 0));
  process.exit(result.status ?? 1);
} catch (err) {
  console.error(`hangnail: could not start "${command[0]}": ${err.message}`);
  process.exit(127);
}
