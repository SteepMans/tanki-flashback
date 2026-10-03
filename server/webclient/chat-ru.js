/**
 * Проверка перевода: заходит в игру, вводит команды в чат и снимает ответы сервера.
 *
 *   node webclient/chat-ru.js
 *
 * Нужен, чтобы видеть, что игрок получает русский текст, а не английский или португальский.
 */
const path = require('path');
const { chromium } = require('playwright-core');

const URL = process.env.E2E_URL || 'http://localhost:9999/web/?debug=1';
const PROFILE = path.join(__dirname, '.e2e-profile');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const POINTS = { closeModal: { x: 0.617, y: 0.637 } };

(async () => {
    const context = await chromium.launchPersistentContext(PROFILE, {
        channel: 'chrome',
        headless: true,
        viewport: { width: 1600, height: 900 },
        args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
               '--autoplay-policy=no-user-gesture-required'],
    });

    const page = context.pages()[0] || (await context.newPage());
    const lines = [];
    page.on('console', (m) => lines.push(m.text()));

    const click = async (p) => {
        const size = page.viewportSize();
        await page.mouse.click(Math.round(size.width * p.x), Math.round(size.height * p.y));
        await sleep(700);
    };

    await page.goto(URL, { waitUntil: 'domcontentloaded' });
    for (let i = 0; i < 60 && !lines.some((l) => l.includes('Connecting to ws')); i++) await sleep(1000);
    await sleep(16000);
    for (let i = 0; i < 3; i++) await click(POINTS.closeModal);

    // Чат лобби: поле ввода внизу слева.
    await click({ x: 0.14, y: 0.792 });
    for (const cmd of ['/help', '/whois e2e', '/online', '/setrank', '/unknowncmd']) {
        await page.keyboard.type(cmd, { delay: 15 });
        await page.keyboard.press('Enter');
        await sleep(1200);
    }
    await sleep(1500);
    await page.screenshot({ path: path.join(__dirname, 'chat-ru.png') });
    console.log('--- снимок: webclient/chat-ru.png');
    await context.close();
})().catch((e) => { console.error(e); process.exit(1); });
