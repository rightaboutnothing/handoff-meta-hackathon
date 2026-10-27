import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(root, 'dashboard', 'package.json'));
const { chromium } = require('@playwright/test');
const phase = process.argv[2];
if (!['before', 'after'].includes(phase)) throw new Error('Usage: node scripts/character-screenshots.mjs before|after');
const directory = path.join(root, 'docs', 'screenshots', `characters-${phase}`);
await mkdir(directory, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
page.setDefaultTimeout(20000);
const errors = [];
const externalRequests = [];
page.on('pageerror', error => errors.push(error.message));
page.on('request', request => { if (!request.url().startsWith('http://127.0.0.1:4173') && !request.url().startsWith('data:')) externalRequests.push(new URL(request.url()).origin); });
const report = { phase, viewport: '1920x1080', scenarios: [], errors, externalRequests };
try {
  await page.addInitScript(() => {
    window.__characterStates = [];
    const record = () => {
      for (const node of document.querySelectorAll('.character-wrap[data-state]')) {
        if (!window.__characterStates.includes(node.dataset.state)) window.__characterStates.push(node.dataset.state);
      }
    };
    new MutationObserver(record).observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-state'] });
  });
  await page.goto('http://127.0.0.1:4173/', { waitUntil: 'networkidle' });
  await page.getByLabel('Sample prompts').waitFor();
  for (const [index, name] of [[0, 'local-answer'], [1, 'handoff'], [2, 'guard-blocking']]) {
    await page.getByLabel('Sample prompts').selectOption(String(index));
    await page.getByRole('button', { name: 'Run Handoff' }).click();
    await page.locator(index === 2 ? '.blocked-banner' : '.answer-panel').waitFor();
    await page.waitForTimeout(phase === 'after' ? 1350 : 700);
    await page.screenshot({ path: path.join(directory, `${name}.png`), animations: 'disabled' });
    report.scenarios.push({ name, passed: true });
  }
  if (phase === 'after') {
    report.observedStates = await page.evaluate(() => window.__characterStates);
    const expectedStates = ['idle', 'receive', 'think', 'confident', 'unsure', 'hand_off', 'answer', 'block', 'celebrate'];
    if (expectedStates.some(state => !report.observedStates.includes(state))) throw new Error('A character state was not observed');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.waitForTimeout(250);
    report.reducedMotion = await page.evaluate(() => ({
      emulated: matchMedia('(prefers-reduced-motion: reduce)').matches,
      runningLoops: document.getAnimations().filter(animation => animation.playState === 'running' && animation.effect?.getTiming().iterations === Infinity).length,
    }));
    if (report.reducedMotion.runningLoops !== 0) throw new Error('Reduced motion left a looping animation running');
    const characters = [];
    report.flatSvg = [];
    const collect = async selector => {
      const locator = page.locator(selector);
      const capture = await locator.evaluate(node => ({
        markup: node.outerHTML,
        info: {
          label: node.querySelector('svg').getAttribute('aria-label'),
          shapeCount: node.querySelectorAll('path, rect, circle, ellipse, line, polygon, polyline, text, use').length,
          prohibitedElements: node.querySelectorAll('linearGradient, radialGradient, filter, feGaussianBlur').length,
        },
      }));
      report.flatSvg.push(capture.info);
      return capture.markup;
    };
    await page.getByLabel('Sample prompts').selectOption('0');
    await page.getByRole('button', { name: 'Run Handoff' }).click();
    await page.locator('.local-character .character-wrap[data-state="idle"]').waitFor();
    await page.waitForTimeout(250);
    characters.push(await collect('.local-character .character-wrap'));
    const muse = await collect('.cloud-character .character-wrap');
    await page.locator('.guard-position .character-wrap[data-state="idle"]').waitFor();
    await page.waitForTimeout(250);
    const guard = await collect('.guard-position .character-wrap');
    await page.getByLabel('Pairing').selectOption('gemma-grok');
    await page.getByRole('button', { name: 'Run Handoff' }).click();
    await page.locator('.local-character .character-wrap[data-state="idle"]').waitFor();
    await page.waitForTimeout(250);
    characters.push(await collect('.local-character .character-wrap'), guard, muse, await collect('.cloud-character .character-wrap'));
    if (report.flatSvg.some(svg => svg.prohibitedElements > 0)) throw new Error('A character contains prohibited shading elements');
    if (report.flatSvg.some(svg => svg.shapeCount > 15)) throw new Error('An idle character exceeds the shape budget');
    await page.evaluate(markup => {
      const gallery = document.createElement('section');
      gallery.id = 'character-contact-sheet';
      Object.assign(gallery.style, { position: 'fixed', left: '200px', top: '240px', width: '1360px', height: '400px', zIndex: '1000', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '40px', background: '#10213A', padding: '48px' });
      for (const html of markup) { const cell = document.createElement('div'); cell.style.width = '210px'; cell.innerHTML = html; gallery.append(cell); }
      document.body.append(gallery);
    }, characters);
    await page.locator('#character-contact-sheet').screenshot({ path: path.join(directory, 'character-family.png'), animations: 'disabled' });
  }
  if (errors.length || externalRequests.length) throw new Error('Unexpected browser errors or external requests');
  await writeFile(path.join(directory, 'verification.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally { await browser.close(); }
