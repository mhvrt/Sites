import fs from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.join(here, 'run-bing-antminer-referral-v8.mjs');
const generatedPath = path.join(here, '.run-bing-antminer-referral-v9.generated.mjs');
let source = await fs.readFile(sourcePath, 'utf8');

source = source.replace(
`  if (popup) {\n    await popup.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {}); await popup.waitForTimeout(600).catch(() => {});\n    attempt.popupOpened = true; attempt.popupUrl = popup.url(); if (isTarget(popup.url())) dest = popup;\n  }`,
`  if (popup) {\n    await popup.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});\n    await popup.waitForURL((u) => isTarget(u.toString()), { timeout: 18000, waitUntil: 'domcontentloaded' }).catch(() => {});\n    await popup.waitForTimeout(500).catch(() => {});\n    attempt.popupOpened = true; attempt.popupUrl = popup.url(); if (isTarget(popup.url())) dest = popup;\n  }`,
);

source = source.replace(
`  if (popup) {\n    await popup.waitForLoadState('domcontentloaded', { timeout: 12000 }).catch(() => {}); await popup.waitForTimeout(450).catch(() => {});\n    if (isLeafArticle(popup.url()) && popup.url() !== before) return popup;\n    await popup.close().catch(() => {});\n  }`,
`  if (popup) {\n    await popup.waitForLoadState('domcontentloaded', { timeout: 12000 }).catch(() => {});\n    await popup.waitForURL((u) => isLeafArticle(u.toString()) && u.toString() !== before, { timeout: 16000, waitUntil: 'domcontentloaded' }).catch(() => {});\n    await popup.waitForTimeout(400).catch(() => {});\n    if (isLeafArticle(popup.url()) && popup.url() !== before) return popup;\n    await popup.close().catch(() => {});\n  }`,
);

await fs.writeFile(generatedPath, source);
await import(pathToFileURL(generatedPath).href + `?v=${Date.now()}`);
