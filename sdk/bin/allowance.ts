#!/usr/bin/env node
import { main } from '../src/cli.ts';

process.exitCode = await main(process.argv.slice(2), {
  out: (line) => console.log(line),
  err: (line) => console.error(line),
  env: process.env,
  columns: process.stdout.isTTY ? process.stdout.columns : undefined,
});
