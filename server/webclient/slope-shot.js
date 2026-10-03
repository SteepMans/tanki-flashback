/**
 * Кадры «бот на склоне»: встаёт у известного пандуса, приманивает туда ботов припасами и снимает их,
 * пока они заезжают и съезжают. Так проверяется, что корпус бота лежит НА ЗЕМЛЕ (тангаж и крен по
 * рельефу), а не едет плашмя.
 *
 *   node webclient/slope-shot.js --preset sandbox [--seconds 180]
 *   node webclient/slope-shot.js --preset zone
 *
 * Требует уже сохранённого входа в профиле webclient/.bots-profile (его греет bots.js) и прав с
 * локального адреса (/tp, /bonus, /bounds, /god — см. command.service.ts).
 */
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright-core');

const URL = process.env.E2E_URL || 'http://localhost:9999/web/?debug=1&log=debug';
const LOGIN = process.env.E2E_LOGIN || 'botsqa';
const PROFILE = path.join(__dirname, '.bots-profile');
const SERVER_LOGS = path.join(__dirname, '..', 'logs');

const arg = (name, fallback) => {
    const i = process.argv.indexOf(name);
    return i !== -1 ? Number(process.argv[i + 1]) : fallback;
};
const SECONDS = arg('--seconds', 180);
const PRESET = (() => {
    const i = process.argv.indexOf('--preset');
    return i !== -1 ? process.argv[i + 1] : 'sandbox';
})();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Точки съёмки у пандусов. Припасы кидаем на ОБА конца склона, чтобы боты сновали по нему туда-сюда.
 * Координаты пандусов взяты из коллизии карт, а места, где боты реально накреняются, — из прогона
 * ИИ на синтетических часах (тот же такт, что и в бою).
 */
const PRESETS = {
    // Песочница: коридор x -2386..-1614 при y 100..900, снизу пол z=0, сверху площадка z=300 (21 градус).
    sandbox: {
        row: 4,
        lures: [[-2600, 500, 100], [-1500, 500, 400], [-2600, 700, 100]],
        views: [
            { name: 'onramp-s', tp: [-2000, 260, 250] },
            { name: 'onramp-n', tp: [-2000, 740, 250] },
            { name: 'foot', tp: [-2480, 500, 100] },
            { name: 'crest', tp: [-1560, 500, 400] },
        ],
    },
    // Зона: угловой въезд на площадку у (-4000, 2250) — самое «кренящее» место карты по прогону ИИ.
    zone: {
        row: 0,
        lures: [[-3900, 2400, 150], [-4000, 1800, 400], [-4200, 2250, 250]],
        views: [
            { name: 'onramp', tp: [-3700, 2150, 300] },
            { name: 'foot', tp: [-3850, 2400, 150] },
            { name: 'crest', tp: [-4000, 1850, 390] },
            { name: 'side', tp: [-4200, 2250, 240] },
        ],
    },
};

const plan = PRESETS[PRESET];
if (!plan) {
    console.error('Неизвестный набор точек: ' + PRESET + '. Доступные: ' + Object.keys(PRESETS).join(', '));
    process.exit(2);
}

const POINTS = {
    closeModal: { x: 0.617, y: 0.637 },
    closeNews: { x: 0.500, y: 0.494 },
    exitYes: { x: 0.4625, y: 0.4222 },
    battlesButton: { x: 0.798, y: 0.018 },
    battleRow: { x: 0.50, y: 0.10 },
    battlePlay: { x: 0.71, y: 0.78 },
    confirmJoin: { x: 0.491, y: 0.432 },
};

const lines = [];
const reports = [];
const REPORT_URL = /755779336|aborigine|\/web\/noop/;

function serverLogTail() {
    const t = new Date();
    const stamp = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
    const file = path.join(SERVER_LOGS, `app-${stamp}.log`);
    if (!fs.existsSync(file)) return '';
    const size = fs.statSync(file).size;
    const start = Math.max(0, size - 8 * 1024 * 1024);
    const fd = fs.openSync(file, 'r');
    const buffer = Buffer.alloc(size - start);
    fs.readSync(fd, buffer, 0, buffer.length, start);
    fs.closeSync(fd);
    return buffer.toString('utf8');
}

function joinedBattle() {
    const text = serverLogTail();
    const joins = [...text.matchAll(new RegExp(`(\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2}).*User ${LOGIN} added to battle ([0-9a-f]+)`, 'g'))];
    if (joins.length === 0) return null;
    const last = joins[joins.length - 1];
    const at = new Date(last[1].replace(' ', 'T')).getTime();
    return Date.now() - at < 90000 ? { battleId: last[2], at } : null;
}

(async () => {
    const context = await chromium.launchPersistentContext(PROFILE, {
        channel: 'chrome',
        headless: true,
        viewport: { width: 1600, height: 900 },
        args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'],
    });
    const page = context.pages()[0] || (await context.newPage());
    page.on('console', (m) => lines.push(m.text()));
    await page.route((url) => REPORT_URL.test(url.href), async (route) => {
        reports.push(route.request().postData() || '(empty)');
        await route.continue();
    });

    const stats = async () => {
        try {
            return await Promise.race([page.evaluate(() => window.ruffleStats || null), new Promise((r) => setTimeout(() => r(null), 15000))]);
        } catch { return null; }
    };
    const inBattle = async () => {
        if (!joinedBattle()) return false;
        const s = await stats();
        return !!s && (s.draws || 0) > 0;
    };
    const click = async (p) => {
        const size = page.viewportSize();
        await page.mouse.click(Math.round(size.width * p.x), Math.round(size.height * p.y));
        await sleep(700);
    };
    const chat = async (text, settle = 1500) => {
        await page.keyboard.press('Enter');
        await sleep(350);
        await page.keyboard.type(text, { delay: 15 });
        await page.keyboard.press('Enter');
        await sleep(settle);
    };
    let shot = 0;
    const snap = async (label) => {
        const file = path.join(__dirname, `slope-${PRESET}-${String(++shot).padStart(2, '0')}-${label}.png`);
        try { await page.screenshot({ path: file, timeout: 60000 }); return file; } catch { return null; }
    };
    const hold = async (key, ms) => { await page.keyboard.down(key); await sleep(ms); await page.keyboard.up(key); };

    console.log('--- открываем ' + URL);
    await page.goto(URL, { waitUntil: 'domcontentloaded' });
    for (let i = 0; i < 60 && !lines.some((l) => l.includes('Connecting to ws')); i++) await sleep(1000);
    await sleep(18000);
    await click({ x: 0.08, y: 0.5 });  // первый клик уходит на фокус холста
    for (let i = 0; i < 3; i++) { await page.keyboard.press('Escape'); await sleep(400); }
    for (let i = 0; i < 2; i++) { await click(POINTS.closeNews); await click(POINTS.closeModal); }

    if (await inBattle()) {
        await page.keyboard.press('Escape');
        await sleep(1500);
        await click(POINTS.exitYes);
        await sleep(5000);
    }

    console.log('--- заходим в бой (' + PRESET + ', строка ' + plan.row + ')');
    await click(POINTS.battlesButton);
    await sleep(2000);
    for (let row = plan.row; row < plan.row + 3 && !(await inBattle()); row++) {
        await click(POINTS.closeNews);
        await click(POINTS.closeModal);
        await click({ x: POINTS.battleRow.x, y: POINTS.battleRow.y + row * 0.027 });
        await click(POINTS.battlePlay);
        for (let wait = 0; wait < 8 && !(await inBattle()); wait++) await sleep(3000);
        if (!(await inBattle())) { await click(POINTS.confirmJoin); await sleep(6000); }
    }
    const joined = joinedBattle();
    if (!joined) {
        console.log('--- ПРОВАЛ: в бой войти не удалось, кадр: ' + (await snap('fail')));
        await context.close();
        process.exit(1);
    }
    console.log('--- бой ' + joined.battleId);

    // Ждём, пока танк реально появится на поле: телепорт до активации кидает игрока за пределы карты.
    await sleep(12000);
    await chat('/bounds off', 1200);   // иначе точка съёмки у пандуса попадает в зону kick
    await chat('/god', 1200);          // чтобы не выбивали с точки съёмки
    await chat('/bots 14', 4000);
    await snap('start');

    const disconnected = async () => {
        try {
            return await page.evaluate(() => {
                const host = document.querySelector('#player > *');
                const text = (host && host.shadowRoot && host.shadowRoot.textContent) || '';
                return /Connection closed|соединение/i.test(text);
            });
        } catch { return false; }
    };

    const startedAt = Date.now();
    let step = 0;
    while (Date.now() - startedAt < SECONDS * 1000) {
        if (await disconnected()) { console.log('--- ПРОВАЛ: сервер разорвал соединение'); break; }
        const view = plan.views[step % plan.views.length];
        await chat(`/tp ${view.tp[0]} ${view.tp[1]} ${view.tp[2]}`, 900);
        // Приманка: припасы, кристаллы и золото. Золото заодно проверяет подбор — клиент пишет на
        // экран, кто его забрал, так что на кадре видно, что боты собирают ящики, а не объезжают.
        const kinds = ['damage', 'crystal', 'gold'];
        for (let i = 0; i < plan.lures.length; i++) {
            const l = plan.lures[i];
            await chat(`/bonus ${kinds[i % kinds.length]} pos ${l[0]} ${l[1]} ${l[2]}`, 500);
        }
        // Обводим камерой пандус: башня (а с ней и камера) крутится клавишами Z/X.
        for (let sweep = 0; sweep < 4; sweep++) {
            await hold(sweep % 2 === 0 ? 'KeyZ' : 'KeyX', 400 + sweep * 200);
            await snap(view.name);
        }
        // Серия подряд с коротким шагом: по ней видно, что башня БОТА доворачивается понемногу за кадр,
        // а не прыгает на цель. Камеру при этом не трогаем, иначе не с чем сравнивать.
        for (let burst = 0; burst < 3; burst++) {
            await sleep(350);
            await snap(view.name + '-burst');
        }
        step++;
    }

    console.log('--- баг-репортов клиента: ' + reports.length);
    const bad = lines.filter((l) => /#1009|Error #\d+|panicked|No packet class found/.test(l));
    console.log('--- ошибок в консоли движка: ' + bad.length);
    bad.slice(0, 5).forEach((l) => console.log('    ' + l.slice(0, 200)));
    console.log('--- кадров: ' + shot);
    await context.close();
})().catch((e) => { console.error(e); process.exit(1); });
