import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(root, 'dashboard', 'package.json'));
const { chromium } = require('@playwright/test');
const phase = process.argv[2];
if (!['before', 'after'].includes(phase)) throw new Error('Usage: node scripts/screenshots.mjs before|after');
const directory = path.join(root, 'docs', 'screenshots', phase);
await mkdir(directory, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
const page = await context.newPage();
page.setDefaultTimeout(15000);
page.setDefaultNavigationTimeout(20000);
const errors = [];
const externalRequests = [];
page.on('pageerror', error => errors.push(error.message));
page.on('request', request => { if (!request.url().startsWith('http://127.0.0.1:4173') && !request.url().startsWith('data:')) externalRequests.push(new URL(request.url()).origin); });
const report = { phase, viewport: '1920x1080', scenarios: [], errors, externalRequests };
try {
  await page.goto('http://127.0.0.1:4173/', { waitUntil: 'networkidle' });
  await page.getByLabel('Sample prompts').waitFor();
  for (const [index, name] of [[0, 'local-answer'], [1, 'muse-spark-handoff'], [2, 'guard-blocking']]) {
    await page.getByLabel('Sample prompts').selectOption(String(index));
    await page.getByRole('button', { name: 'Run Handoff' }).click();
    // A blocked route ends at Safety screen by design and never reaches Answer.
    await page.locator(index === 2 ? '.blocked-banner' : '.answer-panel').waitFor({ timeout: 30000 });
    await page.waitForTimeout(900);
    await page.screenshot({ path: path.join(directory, `${name}.png`), animations: 'disabled' });
    report.scenarios.push({ name, terminal: index === 2 ? 'blocked' : 'answered', passed: true });
  }
  await page.locator('.results-section').scrollIntoViewIfNeeded();
  await page.waitForTimeout(1400);
  await page.screenshot({ path: path.join(directory, 'results.png'), animations: 'disabled' });
  if (phase === 'after') {
    await page.setViewportSize({ width: 390, height: 1100 });
    await page.getByLabel('Sample prompts').selectOption('0');
    await page.getByRole('button', { name: 'Run Handoff' }).click();
    await page.locator('.answer-panel').waitFor({ timeout: 30000 });
    await page.locator('.stage-shell').evaluate(element => element.scrollIntoView({ block: 'start', behavior: 'instant' }));
    await page.screenshot({ path: path.join(directory, 'mobile-hero.png'), animations: 'disabled' });
    report.mobileOverflowPx = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.getByLabel('Sample prompts').selectOption('2');
    await page.getByRole('button', { name: 'Run Handoff' }).click();
    await page.locator('.blocked-banner').waitFor({ timeout: 30000 });
    report.reducedMotion = await page.evaluate(() => ({
      emulated: matchMedia('(prefers-reduced-motion: reduce)').matches,
      runningLoops: document.getAnimations().filter(animation => animation.playState === 'running' && animation.effect?.getTiming().iterations === Infinity).length,
    }));
    if (!report.reducedMotion.emulated || report.reducedMotion.runningLoops !== 0) throw new Error('Reduced motion left a looping animation running');
    if (report.mobileOverflowPx !== 0) throw new Error('Mobile layout overflows horizontally');
    await page.screenshot({ path: path.join(directory, 'reduced-motion.png'), animations: 'disabled' });
    await page.getByRole('button', { name: 'Steps', exact: true }).click();
    await page.locator('.steps-shell').waitFor();
    report.stepsView = (await page.locator('.technical-step').count()) === 6;
    await page.getByRole('button', { name: 'Characters', exact: true }).click();
    await page.getByLabel('Sample prompts').selectOption('1');
    await page.getByLabel('Speed').selectOption('2');
    report.cloudLabels = [];
    for (const [pairing, label] of [['meta-meta', 'Muse Spark'], ['meta-grok', 'Grok 4.7'], ['gemma-meta', 'Muse Spark'], ['gemma-grok', 'Grok 4.7']]) {
      await page.getByLabel('Pairing').selectOption(pairing);
      await page.getByRole('button', { name: 'Run Handoff' }).click();
      await page.locator('.answer-panel').waitFor({ timeout: 20000 });
      const actual = await page.locator('.cloud-character .character-name').innerText();
      const attribution = await page.locator('.answer-meta strong').innerText();
      if (actual !== label || !attribution.includes(label)) throw new Error(`Incorrect cloud model label for ${pairing}`);
      report.cloudLabels.push({ pairing, label, passed: true });
    }
    await page.getByRole('button', { name: 'By pairing', exact: true }).click();
    report.chartToggle = await page.locator('[aria-label="Accuracy grouped by pairing"]').count() === 1;
    await page.getByRole('button', { name: 'Presentation mode', exact: true }).click();
    await page.waitForFunction(() => document.body.classList.contains('presentation-mode'), undefined, { timeout: 15000 });
    report.presentationCycle = [];
    for (const title of ['Easy local answer', 'Thoughtful cloud handoff', 'Protected locally', 'Easy local answer']) {
      await page.getByRole('heading', { name: title, exact: true }).waitFor({ timeout: 20000 });
      report.presentationCycle.push(title);
    }
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.body.classList.contains('presentation-mode'), undefined, { timeout: 15000 });
    report.escapeExitsPresentation = true;
  }
  if (errors.length) throw new Error(`${errors.length} browser errors`);
  if (externalRequests.length) throw new Error('Unexpected external requests');
  await writeFile(path.join(directory, 'verification.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally { await browser.close(); }
