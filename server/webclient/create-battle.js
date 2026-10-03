/**
 * Снимок окна создания битвы: нужен, чтобы видеть диапазон званий на ползунке.
 *
 *   node webclient/create-battle.js            снимок webclient/create-battle.png
 *   node webclient/create-battle.js --headed   с видимым окном
 */
const path = require('path');
const { chromium } = require('playwright-core');

// Тесты открывают стенд в режиме отладки: снизу полоса логов, поверх боя счётчик кадров.
// Заодно это фиксирует раскладку окна, по которой выверены координаты кликов.
const URL = process.env.E2E_URL || 'http://localhost:9999/web/?debug=1';
const HEADED = process.argv.includes('--headed');
const PROFILE = path.join(__dirname, '.e2e-profile');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const POINTS = {
    closeModal: { x: 0.617, y: 0.637 },
    battlesButton: { x: 0.798, y: 0.018 },
    createButton: { x: 0.629, y: 0.792 },  // «Создать» под списком битв
};

(async () => {
    const context = await chromium.launchPersistentContext(PROFILE, {
        channel: 'chrome',
        headless: !HEADED,
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
        await sleep(800);
    };

    await page.goto(URL, { waitUntil: 'domcontentloaded' });
    for (let i = 0; i < 60 && !lines.some((l) => l.includes('Connecting to ws')); i++) await sleep(1000);
    await sleep(16000);
    for (let i = 0; i < 3; i++) await click(POINTS.closeModal);

    await click(POINTS.battlesButton);
    await sleep(1500);
    await click(POINTS.createButton);
    await sleep(2500);
    // Клик по вкладке закрывает раскрывшийся список карт, который перекрывает ползунок званий.
    // Открываем список карт: он и нужен на снимке.
    await click({ x: 0.74, y: 0.10 });
    await sleep(1200);

    const file = path.join(__dirname, 'create-battle.png');
    await page.screenshot({ path: file });
    console.log('--- снимок: ' + file);
    await context.close();
})().catch((e) => { console.error(e); process.exit(1); });
