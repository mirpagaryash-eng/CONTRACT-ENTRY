import { test, expect } from '@playwright/test';
import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createServer } from 'node:http';

const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined);
test.use({ launchOptions: { ...(executablePath ? { executablePath } : {}), args: ['--no-sandbox'] } });
let server;
let base;
test.beforeAll(async () => {
  // This managed browser blocks file: navigation. Serve the identical single HTML
  // file, without any application API, to verify self-contained browser behavior.
  const html = await readFile(resolve(process.env.PREVIEW_HTML || 'preview-dist/hisab-interactive.html'));
  server = createServer((req, res) => { res.writeHead(200, { 'Content-Type':'text/html; charset=utf-8' }); res.end(html); });
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  base = `http://127.0.0.1:${server.address().port}/`;
});
test.afterAll(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });

test('downloadable frontend works offline, saves records and uses readable mobile text', async ({ page }) => {
  const errors = [];
  const external = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route(/^https?:/, route => {
    if (route.request().url() === base && route.request().isNavigationRequest()) return route.continue();
    external.push(route.request().url()); return route.abort();
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(base);
  await expect(page.getByText('Interactive preview', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Your register, at a glance.' })).toBeVisible();
  await page.getByRole('button', { name: 'Record advance', exact: true }).first().click();
  await page.getByLabel('Advance amount in rupees').fill('1500.25');
  await page.getByLabel('Note', { exact: false }).fill('Interactive frontend test');
  await page.getByRole('button', { name: 'Save advance', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Advance saved' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open WhatsApp', exact: true })).toHaveAttribute('href', /^https:\/\/wa\.me\/\d+\?text=/);
  await expect(page.locator('.whatsapp-preview p')).not.toContainText('file:');
  await page.getByRole('button', { name: 'Close dialog' }).click();
  await page.reload();
  await expect(page.getByText('₹1,500.25').first()).toBeVisible();
  await page.getByRole('button', { name: 'Edit advance for Abhay' }).first().click();
  await page.getByLabel('Advance amount in rupees').fill('1750.50');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Advance saved' })).toBeVisible();
  await page.getByRole('button', { name: 'Close dialog' }).click();
  await page.getByRole('button', { name: 'Worker view', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Hello, Abhay.' })).toBeVisible();
  await expect(page.getByText('₹1,750.50').first()).toBeVisible();
  await expect(page.getByRole('button', { name: /edit advance|save advance/i })).toHaveCount(0);
  await page.getByRole('button', { name: 'Owner', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Your register, at a glance.' })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  if (await page.getByRole('button', { name: 'Dismiss', exact: true }).count()) await page.getByRole('button', { name: 'Dismiss', exact: true }).click();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const smallText = await page.evaluate(() => [...document.querySelectorAll('body *')].filter(el => {
    if (['SCRIPT','STYLE','SVG','PATH'].includes(el.tagName) || ![...el.childNodes].some(n => n.nodeType === Node.TEXT_NODE && n.textContent.trim())) return false;
    const s = getComputedStyle(el); const r = el.getBoundingClientRect();
    return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0 && parseFloat(s.fontSize) < 16;
  }).map(el => ({ tag: el.tagName, className: el.className, size: getComputedStyle(el).fontSize })));
  expect(smallText).toEqual([]);
  await mkdir(process.env.ARTIFACT_DIR || 'test-results/screenshots', { recursive: true });
  await page.screenshot({ path: resolve(process.env.ARTIFACT_DIR || 'test-results/screenshots', 'hisab-interactive-mobile.png'), fullPage: true, animations: 'disabled' });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({ path: resolve(process.env.ARTIFACT_DIR || 'test-results/screenshots', 'hisab-interactive-desktop.png'), fullPage: true, animations: 'disabled' });
  expect(external).toEqual([]);
  expect(errors).toEqual([]);
});
