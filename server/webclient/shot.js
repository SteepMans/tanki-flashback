/** Снимает лобби с заданными параметрами: node shot.js "render=2" <файл> */
const path = require('path');
const { chromium } = require('playwright-core');
const quality = process.argv[2] || 'render=1';
const out = process.argv[3] || 'shot.png';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
    const ctx = await chromium.launchPersistentContext(
        'C:/work/other/tanki-classic-2/server/webclient/.e2e-profile', {
        channel: 'chrome', headless: true, viewport: { width: 1600, height: 900 },
        args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
               '--autoplay-policy=no-user-gesture-required'],
    });
    const page = ctx.pages()[0] || (await ctx.newPage());
    const lines = [];
    page.on('console', (m) => lines.push(m.text()));
    await page.goto('http://localhost:9999/web/?debug=1&' + quality, { waitUntil: 'domcontentloaded' });
    for (let i = 0; i < 60 && !lines.some((l) => l.includes('Connecting to ws')); i++) await sleep(1000);
    await sleep(18000);
    console.log(await page.evaluate(() => {
        const host = document.querySelector('#player > *');
        const canvas = host && host.shadowRoot && host.shadowRoot.querySelector('canvas');
        return 'холст: ' + (canvas ? canvas.width + 'x' + canvas.height : 'нет') +
               ', масштаб: ' + window.ruffleRenderScale;
    }));
    await page.screenshot({ path: out });
    console.log('снято:', out);
    await ctx.close();
})();
