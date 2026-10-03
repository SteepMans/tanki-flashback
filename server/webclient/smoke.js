/**
 * Быстрая проверка страницы: грузит /web/, 20 секунд слушает консоль и печатает всё, включая
 * неудавшиеся запросы. Нужна, когда экран пустой и непонятно, дошло ли дело до Ruffle.
 *
 *   node webclient/smoke.js
 */
const path = require('path');
const { chromium } = require('playwright-core');

// Тесты открывают стенд в режиме отладки: снизу полоса логов, поверх боя счётчик кадров.
// Заодно это фиксирует раскладку окна, по которой выверены координаты кликов.
const URL = process.env.E2E_URL || 'http://localhost:9999/web/?debug=1';

(async () => {
    const context = await chromium.launchPersistentContext(path.join(__dirname, '.smoke-profile'), {
        channel: 'chrome',
        headless: true,
        viewport: { width: 1280, height: 720 },
        args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
    });

    const page = context.pages()[0] || (await context.newPage());
    page.on('console', (m) => {
        const t = m.text();
        if (/symphonia|main_data_begin|estimating duration/.test(t)) return;
        console.log('[console] ' + t.replace(/%c/g, '').replace(/ color:[^;]*;?/g, '').slice(0, 300));
    });
    page.on('pageerror', (e) => console.log('[pageerror] ' + e.message));
    page.on('requestfailed', (r) => console.log('[failed] ' + r.url() + ' — ' + r.failure()?.errorText));
    page.on('response', (r) => {
        if (r.status() >= 400) console.log('[' + r.status() + '] ' + r.url());
    });

    await page.goto(URL, { waitUntil: 'domcontentloaded' });
    await new Promise((r) => setTimeout(r, 20000));
    await context.close();
})();
