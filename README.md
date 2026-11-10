<p align="center"><img src="hangnail.svg" width="180" alt="hangnail: a worried fingernail with a hangnail"></p>

# hangnail

Your test suite takes a minute. One night it sits there for six hours. Every test passed, but one file never exited, and nothing told you.

hangnail runs your test command and watches each test file. If a file runs past its time limit, hangnail stops the run and names the file, so you lose minutes instead of the night.

```
💅 HUNG: a test file ran past 5m 0s without finishing
  tests/payments.test.ts (running 5m 10s)
  Its tests may all pass while the file never exits. Look for an open timer or socket, or a
  database call that lands after teardown closed the pool. Run that file alone to see it.
```

## Install

```bash
npm i -D github:1upcreative/hangnail
```

## Use it

Put `hangnail --` in front of your test command:

```bash
npx hangnail -- node --test
```

```json
{ "scripts": { "test": "hangnail --file-limit 120 -- node --test" } }
```

Your output still shows live. hangnail exits with your command's own exit code (128 + the signal number if a signal killed it). If it had to stop a hung run, it exits with 124.

| Option | Default | What it does |
| --- | --- | --- |
| `--file-limit <s>` | 300 | Stop when one test file runs this many seconds. Env: `HANGNAIL_FILE_LIMIT` |
| `--total-limit <s>` | none | Stop when the whole run takes this many seconds. Env: `HANGNAIL_TOTAL_LIMIT` |
| `--poll <s>` | 5 | How often hangnail checks (at least 0.5) |
| `--match <regex>` | `*.test.*`, `*.spec.*` | What a test file path looks like |

Set the file limit well above your slowest file. If your whole suite takes a minute, 2 to 5 minutes is plenty.

## From code

```js
import { watch, report } from "hangnail";

const run = await watch("npm", ["test"], { fileLimitS: 300, totalLimitS: 1200 });
if (run.hung.length || run.timedOut || run.blind) console.error(report(run));
```

`watch` resolves to `{ status, signal, out, hung, timedOut, blind, unwatched, signalled }`. `out` holds everything the command printed. `blind` means `ps` stopped working mid-run, so hangnail stopped the run. `unwatched` means `ps` never worked on this machine, so only the total limit applied. `signalled` names the signal that stopped hangnail itself. Pass `echo: true` to also stream the output live.

## How it works

`node --test` runs each test file in its own process, with the file's path in the command line. Every few seconds, hangnail reads `ps`, finds the test-file processes under your command, and checks how long each one has run. When one passes the limit, hangnail stops everything the command started, including helpers that left its process group. If hangnail itself gets stopped (Ctrl-C, SIGTERM, a closed terminal), it takes the run down with it first. If `ps` stops working mid-run, it stops the run rather than watch nothing. On a machine where `ps` never works, it keeps the run going on `--total-limit` alone and says so. Before it kills a process by its ID, it checks that the ID still runs the same command, so it never hits a process that reused the ID.

## Why files hang

A file hangs when something keeps its process alive after the last test:

- a `setInterval`, or a `setTimeout` that nobody cleared
- an open socket or server
- a database pool that teardown closed, then something queried again and reopened it

Run the named file alone and look at what its teardown leaves open.

## Limits

- Per-file checks need a runner that gives each test file its own process with the path in the command line. `node --test` works. Runners with shared worker pools, like Jest and Vitest, don't show file paths per process. Use `--total-limit` with them.
- macOS and Linux only. hangnail reads `ps` and stops process groups, and Windows has neither.
- Time counts by the clock. If your laptop sleeps mid-run, a file can look hung when you wake it.

## License

MIT © 1UP Creative
