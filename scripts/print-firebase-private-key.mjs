#!/usr/bin/env node

import { readFileSync } from 'node:fs';

const [jsonPath] = process.argv.slice(2);

if (!jsonPath) {
  process.stderr.write(
    'Usage: scripts/print-firebase-private-key.mjs <service-account.json>\n',
  );
  process.exit(64);
}

let serviceAccount;
try {
  serviceAccount = JSON.parse(readFileSync(jsonPath, 'utf8'));
} catch (error) {
  const message = error instanceof Error ? error.message : 'Unknown error';
  process.stderr.write(`Unable to read service account JSON: ${message}\n`);
  process.exit(65);
}

const privateKey = serviceAccount.private_key;
if (
  typeof privateKey !== 'string' ||
  !privateKey.includes('-----BEGIN PRIVATE KEY-----') ||
  !privateKey.includes('-----END PRIVATE KEY-----')
) {
  process.stderr.write('The JSON does not contain a valid private_key field.\n');
  process.exit(66);
}

process.stdout.write(`FIREBASE_PRIVATE_KEY=${JSON.stringify(privateKey)}\n`);
