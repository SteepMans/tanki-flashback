/**
 * Проверка метки места падения золотого ящика.
 *
 *   node webclient/goldzone.js            обычный прогон
 *   node webclient/goldzone.js --headed   с видимым окном
 *
 * Заходит в бой, командой `/bonus gold N` анонсирует сброс золота (сирена + метки) и снимает
 * панораму: метка ставится в случайной зоне карты, поэтому танк крутится на месте, чтобы поймать
 * её в кадр. Снимки — webclient/goldzone-*.png, смотреть глазами: метка выглядит как столб.
 */
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright-core');

const URL = process.env.E2E_URL || 'http://localhost:9999/web/?debug=1';
const HEADED = process.argv.includes('--headed');
const PROFILE = path.join(__dirname, '.e2e-profile');
const GOLDS = Number(process.env.GOLDS || 6);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const POINTS = {
    closeModal: { x: 0.617, y: 0.637 },
    battlesButton: { x: 0.798, y: 0.018 },
    battleRow: { x: 0.50, y: 0.10 },
    battlePlay: { x: 0.71, y: 0.78 },
    confirmJoin: { x: 0.491, y: 0.432 },
};

(async () => {
    const lines = [];
    const context = await chromium.launchPersistentContext(PROFILE, {
        channel: 'chrome',
        headless: !HEADED,
        viewport: { width: 1600, height: 900 },
        args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
               '--autoplay-policy=no-user-gesture-required'],
    });

    const page = context.pages()[0] || (await context.newPage());
    page.on('console', (m) => {
        const t = m.text();
        if (/symphonia|main_data_begin|estimating duration/.test(t)) return;
        lines.push(t);
    });

    const click = async (p) => {
        const size = page.viewportSize();
        await page.mouse.click(Math.round(size.width * p.x), Math.round(size.height * p.y));
        await sleep(700);
    };
    const chat = async (text) => {
        await page.keyboard.press('Enter');
        await sleep(400);
        await page.keyboard.type(text, { delay: 20 });
        await page.keyboard.press('Enter');
        await sleep(700);
    };
    const inBattleNow = async () => {
        const s = await page.evaluate(() => window.ruffleStats || null);
        return !!s && (s.draws || 0) > 0 && (s.sceneWidth || 0) > 900;
    };

    console.log('--- открываем ' + URL);
    await page.goto(URL, { waitUntil: 'domcontentloaded' });
    for (let i = 0; i < 60 && !lines.some((l) => l.includes('Connecting to ws')); i++) await sleep(1000);
    await sleep(16000);
    for (let i = 0; i < 3; i++) await click(POINTS.closeModal);

    console.log('--- заходим в бой');
    for (let i = 0; i < 2; i++) await click(POINTS.closeModal);
    await click(POINTS.battlesButton);
    for (let row = 0; row < 4 && !(await inBattleNow()); row++) {
        await click({ x: POINTS.battleRow.x, y: POINTS.battleRow.y + row * 0.027 });
        await click(POINTS.battlePlay);
        await sleep(5000);
        if (!(await inBattleNow())) { await click(POINTS.confirmJoin); await sleep(4000); }
        if (!(await inBattleNow())) { await click(POINTS.confirmJoin); await sleep(1500); }
    }
    await sleep(6000);

    const saveLog = () => fs.writeFileSync(path.join(__dirname, 'goldzone.log'), lines.join('\n'), 'utf8');
    if (!(await inBattleNow())) {
        console.log('--- ПРОВАЛ: в бой войти не удалось');
        saveLog();
        await context.close();
        process.exit(1);
    }

    console.log('--- анонсируем золото: /bonus gold ' + GOLDS);
    await chat('/bonus gold ' + GOLDS);
    await sleep(1500);

    // Метка стоит в случайной зоне карты — крутимся вокруг себя и снимаем панораму, пока ящик
    // не упал (падение через 30-50 с после анонса и метку снимает).
    let shot = 0;
    for (let i = 0; i < 8; i++) {
        await page.keyboard.down('KeyA');
        await sleep(1200);
        await page.keyboard.up('KeyA');
        await sleep(600);
        await page.screenshot({ path: path.join(__dirname, `goldzone-${++shot}.png`) });
    }

    saveLog();
    console.log(`--- снято кадров: ${shot} (webclient/goldzone-1..${shot}.png), лог: webclient/goldzone.log`);
    await context.close();
})().catch((e) => { console.error(e); process.exit(1); });
