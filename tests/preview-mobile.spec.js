import { test, expect } from '@playwright/test';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { resolve } from 'node:path';

const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined);
test.use({ viewport: { width:390, height:844 }, isMobile:true, hasTouch:true, deviceScaleFactor:3, launchOptions:{ ...(executablePath ? {executablePath} : {}), args:['--no-sandbox'] } });
let server;
let base;
test.beforeAll(async () => {
  const html = await readFile(resolve(process.env.PREVIEW_HTML || 'preview-dist/hisab-interactive.html'));
  server = createServer((req,res) => { res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'}); res.end(html); });
  await new Promise(done => server.listen(0,'127.0.0.1',done));
  base = `http://127.0.0.1:${server.address().port}/`;
});

test('a viewer that disables JavaScript shows browser-opening instructions', async ({browser}) => {
  const context = await browser.newContext({javaScriptEnabled:false,viewport:{width:390,height:844}});
  try {
    const page = await context.newPage();
    await page.goto(base);
    await expect(page.getByRole('heading',{name:'Open Hisab in a web browser'})).toBeVisible();
    await expect(page.getByText('This interactive file needs JavaScript for its buttons.',{exact:false})).toBeVisible();
    await expect(page.getByRole('button',{name:'Record advance',exact:true})).toHaveCount(0);
  } finally { await context.close(); }
});
test.afterAll(async () => { server.closeAllConnections(); await new Promise(done => server.close(done)); });

test('mobile touch can add a worker, save and edit an advance', async ({page}) => {
  const errors=[]; const outbound=[];
  page.on('pageerror',e => errors.push(e.message));
  await page.route(/^https?:/, route => {
    if(route.request().url() === base && route.request().isNavigationRequest()) return route.continue();
    outbound.push(route.request().url()); return route.abort();
  });
  await page.goto(base);
  await expect(page.getByRole('heading',{name:'Your register, at a glance.'})).toBeVisible();
  await page.getByRole('button',{name:'Add worker',exact:true}).first().tap();
  await page.getByLabel('Worker’s name').fill('MobileWorker');
  await page.getByLabel('WhatsApp number').fill('+12025550188');
  await page.getByRole('dialog').getByRole('button',{name:'Add worker',exact:true}).tap();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button',{name:'Record advance',exact:true}).first().tap();
  await page.getByRole('dialog').locator('select[name=workerId]').selectOption({label:'MobileWorker · SANJYOT'});
  await page.getByLabel('Advance amount in rupees').fill('500.25');
  await page.getByRole('button',{name:'Save advance',exact:true}).tap();
  await expect(page.getByRole('heading',{name:'Advance saved'})).toBeVisible();
  await expect(page.getByRole('link',{name:'Open WhatsApp',exact:true})).toHaveAttribute('href',/^https:\/\/wa\.me\/12025550188\?text=/);
  await page.getByRole('button',{name:'Close dialog'}).tap();
  await expect(page.locator('.mobile-advance-list').getByText('₹500.25')).toBeVisible();
  await page.locator('.mobile-advance-list').getByRole('button',{name:'Edit advance for MobileWorker'}).tap();
  await page.getByLabel('Advance amount in rupees').fill('750.50');
  await page.getByRole('button',{name:'Save changes',exact:true}).tap();
  await expect(page.getByRole('heading',{name:'Advance saved'})).toBeVisible();
  await page.getByRole('button',{name:'Close dialog'}).tap();
  await expect(page.locator('.mobile-advance-list').getByText('₹750.50')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
  expect(outbound).toEqual([]);
});
