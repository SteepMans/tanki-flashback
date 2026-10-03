/**
 * Проверка гаража: вход, переход в гараж, снимки и разбор картинки.
 *
 *   node webclient/garage.js            снимки webclient/g*.png + сводка
 *   node webclient/garage.js --headed   с окном
 *
 * Печатает средний цвет области превью танка: если там ровный фон, значит модель не нарисована.
 * Счётчик Stage3D на самой странице показывает, дошло ли дело до вызовов отрисовки.
 */
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright-core');

// Тесты открывают стенд в режиме отладки: снизу полоса логов, поверх боя счётчик кадров.
// Заодно это фиксирует раскладку окна, по которой выверены координаты кликов.
const URL = process.env.E2E_URL || 'http://localhost:9999/web/?debug=1';
const LOGIN = process.env.E2E_LOGIN || 'e2e';
const PASSWORD = process.env.E2E_PASSWORD || 'e2e12345';
const HEADED = process.argv.includes('--headed');
const PROFILE = path.join(__dirname, '.e2e-profile');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const POINTS = {
    loginTab: { x: 0.506, y: 0.21 },
    loginField: { x: 0.525, y: 0.377 },
    passField: { x: 0.525, y: 0.418 },
    remember: { x: 0.459, y: 0.473 },
    submit: { x: 0.570, y: 0.473 },
    closeModal: { x: 0.617, y: 0.637 },
    garageButton: { x: 0.854, y: 0.018 },
};

(async () => {
    const lines = [];
    const context = await chromium.launchPersistentContext(PROFILE, {
        channel: 'chrome',
        headless: !HEADED,
        viewport: { width: 1600, height: 900 },
        args: [
            '--use-gl=angle',
            '--use-angle=swiftshader',
            '--enable-unsafe-swiftshader',
            '--autoplay-policy=no-user-gesture-required',
        ],
    });

    const page = context.pages()[0] || (await context.newPage());
    page.on('console', (msg) => {
        const text = msg.text();
        if (/symphonia|main_data_begin|estimating duration/.test(text)) return;
        lines.push(text);
        if (/draw #/.test(text)) {
            console.log(text.replace(/%c/g, '').replace(/ color:[^;]*;?/g, '').trim().slice(0, 300));
        }
        if (/ERROR|panicked|Error #/.test(text)) {
            console.log(text.replace(/%c/g, '').replace(/ color:[^;]*;?/g, '').trim().slice(0, 400));
        }
    });

    const click = async (point) => {
        const size = page.viewportSize();
        await page.mouse.click(Math.round(size.width * point.x), Math.round(size.height * point.y));
        await sleep(700);
    };

    console.log('--- открываем ' + URL);
    await page.goto(URL, { waitUntil: 'domcontentloaded' });
    for (let i = 0; i < 60 && !lines.some((l) => l.includes('Connecting to ws')); i++) await sleep(1000);
    await sleep(14000);

    // Профиль браузера помнит вход, но сервер держит один сеанс на логин: если аккаунт занят
    // другим прогоном, клиент показывает форму. Отличаем экран входа от лобби по цвету пикселя
    // слева по центру — там либо тёмный фон формы, либо зелёная панель чата.
    const stats = async () => page.evaluate(() => window.ruffleStats || null);
    const atLoginScreen = async () => {
        const shot = await page.screenshot({ clip: { x: 150, y: 430, width: 4, height: 4 } });
        const { PNG } = require('pngjs');
        const png = PNG.sync.read(shot);
        const [r, g, b] = [png.data[0], png.data[1], png.data[2]];
        return !(g > r + 8 && g > b + 8);   // зелёный означает, что лобби уже на экране
    };
    if (await atLoginScreen()) {
        console.log('--- вводим ' + LOGIN);
        await click({ x: 0.08, y: 0.5 });
        await click(POINTS.loginTab);
        // Поля могут быть уже заполнены сохранённым входом — чистим, иначе текст допишется
        // к старому и сервер ответит «пароль неверный».
        await click(POINTS.loginField);
        await page.keyboard.press('Control+A');
        await page.keyboard.type(LOGIN, { delay: 60 });
        await click(POINTS.passField);
        await page.keyboard.press('Control+A');
        await page.keyboard.type(PASSWORD, { delay: 60 });
        await click(POINTS.remember);
        await click(POINTS.submit);
        await sleep(15000);
    }

    // Всплывающие окна (приглашения, миссии) модальные: пока они открыты, клики по верхней
    // панели не доходят. Жмём «Закрыть» несколько раз — окно может появиться и после входа.
    for (let i = 0; i < 3; i++) {
        await click(POINTS.closeModal);
        await sleep(900);
    }

    console.log('--- лобби: ' + JSON.stringify(await stats()));
    await page.screenshot({ path: path.join(__dirname, 'g0-lobby.png') });

    // Просим движок печатать разбор вызовов отрисовки — по нему видно, чем рисуется превью.
    await page.evaluate(() => { window.ruffleTraceDraws = true; });

    console.log('--- жмём Гараж');
    await click(POINTS.garageButton);
    await sleep(2500);
    await click(POINTS.garageButton);

    // Снимаем гараж с разным числом разрешённых вызовов отрисовки: так видно, что рисует каждый
    // и какой из них перекрывает остальные.
    for (const limit of [null, 0, 1, 5]) {
        await page.evaluate((n) => { window.ruffleDrawLimit = n === null ? undefined : n; }, limit);
        await sleep(3500);
        await page.screenshot({ path: path.join(__dirname, `g-limit-${limit === null ? 'all' : limit}.png`) });
        console.log(`--- лимит ${limit}: ` + JSON.stringify(await stats()));
    }

    fs.writeFileSync(path.join(__dirname, 'garage.log'), lines.join('\n'), 'utf8');
    console.log('--- лог: webclient/garage.log');
    await context.close();
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
