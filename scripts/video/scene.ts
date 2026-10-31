/**
 * Video helper for docs/demo.tape (run by `make video`, not by the demo).
 *
 * `make demo-manual` runs live in the background of the recording and writes
 * its output to a log. This prints one scene of that real output at reading
 * pace: it waits until the lines between --from and --to exist in the log,
 * clears the screen, prints a caption, then the lines (optionally filtered),
 * cut to the terminal width so nothing wraps. It never changes the text of a
 * line, apart from that cut and from shortening the repository path.
 *
 *   node scripts/video/scene.ts --log <file> --title <text> [--note <text>]
 *        --from <regex> --to <regex> [--after <regex>] [--keep <regex>]
 *        [--drop <regex>] [--delay <ms>] [--timeout <s>]
 */
import { existsSync, readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    log: { type: 'string' },
    title: { type: 'string', default: '' },
    note: { type: 'string', default: '' },
    from: { type: 'string' },
    to: { type: 'string' },
    after: { type: 'string' },
    keep: { type: 'string' },
    drop: { type: 'string' },
    delay: { type: 'string', default: '120' },
    timeout: { type: 'string', default: '240' },
  },
});

function fail(message: string): never {
  console.error(`scene: ${message}`);
  process.exit(1);
}

const log = values.log ?? fail('--log is required');
const from = new RegExp(values.from ?? fail('--from is required'));
const to = new RegExp(values.to ?? fail('--to is required'));
const after = values.after ? new RegExp(values.after) : null;
const keep = values.keep ? new RegExp(values.keep) : null;
const drop = values.drop ? new RegExp(values.drop) : null;
const delayMs = Number(values.delay);
const deadline = Date.now() + Number(values.timeout) * 1000;
const columns = process.stdout.columns || 120;
const repo = process.cwd();

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** The lines of the scene, or null while the log does not contain them yet. */
function slice(text: string): string[] | null {
  const lines = text.split('\n');
  let i = 0;
  if (after) {
    while (i < lines.length && !after.test(lines[i] ?? '')) i++;
    if (i === lines.length) return null;
    i++;
  }
  while (i < lines.length && !from.test(lines[i] ?? '')) i++;
  if (i === lines.length) return null;
  for (let j = i; j < lines.length - 1; j++) {
    // lines.length - 1: the last element may be a line still being written.
    if (to.test(lines[j] ?? '')) return lines.slice(i, j + 1);
  }
  return null;
}

let scene: string[] | null = null;
while (scene === null) {
  if (existsSync(log)) scene = slice(readFileSync(log, 'utf8'));
  if (scene !== null) break;
  if (Date.now() > deadline) fail(`timed out waiting for ${String(from)} .. ${String(to)} in ${log}`);
  await sleep(250);
}

const shown = scene
  .filter((l) => (keep ? keep.test(l) : true) && !(drop && drop.test(l)))
  .map((l) => l.split(repo).join('.'))
  .map((l) => (l.length >= columns ? `${l.slice(0, columns - 2)}~` : l));

process.stdout.write('\x1b[2J\x1b[3J\x1b[H');
if (values.title) process.stdout.write(`\x1b[1;30;46m ${values.title} \x1b[0m\n`);
if (values.note) process.stdout.write(`\x1b[36m${values.note}\x1b[0m\n`);
if (values.title || values.note) process.stdout.write('\n');
for (const line of shown) {
  const color = line.startsWith('[api]') ? '\x1b[33m' : line.startsWith('[owner]') ? '\x1b[35m' : line.startsWith('===') ? '\x1b[1m' : /\bBLOCK\b|REFUSED|refused|rejected/.test(line) ? '\x1b[31m' : '';
  process.stdout.write(`${color}${line}${color ? '\x1b[0m' : ''}\n`);
  await sleep(delayMs);
}
