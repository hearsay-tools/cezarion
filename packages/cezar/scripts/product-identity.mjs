#!/usr/bin/env node
import { productIdentity } from '../src/home/identity.ts';

const args = process.argv.slice(2);
if (args.length === 0) {
  console.log(JSON.stringify(productIdentity()));
} else if (args.length === 2 && args[0] === '--rebrand' && ['on', 'off'].includes(args[1])) {
  console.log(JSON.stringify(productIdentity(args[1] === 'on')));
} else {
  console.error('Usage: node product-identity.mjs [--rebrand on|off]');
  process.exitCode = 1;
}
