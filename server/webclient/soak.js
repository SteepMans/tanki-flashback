/**
 * Длинный прогон боя с ботами: ищем, ЧТО копится со временем и роняет кадры.
 *
 *   node webclient/soak.js --minutes 15 --bots 30      обычный прогон
 *   node webclient/soak.js --minutes 15 --idle         стоим на месте (что копится само)
 *   node webclient/soak.js --minutes 15 --methods      + счётчик горячих методов игры
 *   node webclient/soak.js --minutes 15 --rounds 5     пять заходов в бой подряд: копится ли
 *                                                      что-то МЕЖДУ боями, а не внутри одного
 *   node webclient/soak.js --row 7                     с какой строки списка битв перебирать
 *   node webclient/soak.js --tag after --out /tmp/x    метка и каталог для файлов прогона
 *   node webclient/soak.js --nogod                     не включать бессмертие (по умолчанию /god:
 *                                                      пока танк лежит, замер меряет не бой)
 *   node webclient/soak.js --tracelog                  ?log=debug: поток отладочных строк движка
 *
 * Раз в SAMPLE секунд снимает:
 *   - замеры движка (window.ruffleStats): FPS, ActionScript, отрисовка, худший кадр, вызовы;
 *   - кучу JS страницы (performance.memory);
 *   - РАЗМЕР ЛИНЕЙНОЙ ПАМЯТИ WASM — в ней живут все объекты AVM2, поэтому её рост это прямой
 *     признак того, что игра копит объекты и не отдаёт их сборщику;
 *   - при --methods список самых горячих методов игры с числом ВЫЗОВОВ в секунду: если у метода
 *     растут вызовы, значит растёт коллекция, по которой он бегает. Это и есть улика.
 *
 * Результат: таблица в консоли, CSV рядом (soak-<tag>.csv) и сводка «первая треть / последняя треть».
 */
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright-core');

const arg = (name, fallback) => {
    const i = process.argv.indexOf(name);
    return i !== -1 ? process.argv[i + 1] : fallback;
};
const has = (name) => process.argv.includes(name);

const TAG = arg('--tag', 'soak');
const MINUTES = Number(arg('--minutes', 15));
const SAMPLE = Number(arg('--sample', 5));           // секунд между замерами
const BOTS = arg('--bots', null);                    // сколько ботов просить в бою
const FIRST_ROW = Number(arg('--row', 0));
const IDLE = has('--idle');
const ROUNDS = Number(arg('--rounds', 1));           // сколько раз зайти в бой за прогон
const METHODS = has('--methods');
const HEADED = has('--headed');
const RENDER = arg('--render', '1');                 // множитель разрешения: 1, чтобы софтверный GL не съел всё
const OUT = arg('--out', __dirname);

// Аккаунт по умолчанию тот же, что у bots.js: он уже прошёл вступительные окна, которые на новом
// логине закрывают весь экран и не дают дойти до списка битв.
const LOGIN = process.env.SOAK_LOGIN || 'botsqa';
const PASSWORD = process.env.SOAK_PASSWORD || 'bots12345';
const PROFILE = path.join(__dirname, '.soak-profile');
const SERVER_LOGS = path.join(__dirname, '..', 'logs');
// `?debug=1` оставлен всегда: под ним свёрстаны координаты кликов (полоса логов забирает 160 px
// снизу), и именно так стенд открывают руками, чтобы видеть счётчик кадров. Подробность логов
// движка по умолчанию обычная; --tracelog поднимает её до debug (поток строк на каждый кадр).
const URL = process.env.SOAK_URL || ('http://localhost:9999/web/?debug=1&render=' + RENDER +
    (has('--tracelog') ? '&log=debug' : ''));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lines = [];
const NOISE = /symphonia|main_data_begin|estimating duration|Ignoring unsupported|WebGL|Compiled shader|Using ANGLE|GPU stall/;
const clean = (line) => line.replace(/%c/g, '').replace(/ ?color:[^;]*;?/g, '').trim();

const POINTS = {
    loginTab: { x: 0.506, y: 0.21 },
    loginField: { x: 0.525, y: 0.377 },
    passField: { x: 0.525, y: 0.418 },
    remember: { x: 0.459, y: 0.473 },
    submit: { x: 0.570, y: 0.473 },
    closeModal: { x: 0.617, y: 0.637 },
    closeNews: { x: 0.500, y: 0.494 },
    exitYes: { x: 0.4625, y: 0.4222 },
    battlesButton: { x: 0.798, y: 0.018 },
    battleRow: { x: 0.50, y: 0.10 },
    battlePlay: { x: 0.71, y: 0.78 },
    battlePlayRight: { x: 0.952, y: 0.782 },
    confirmJoin: { x: 0.491, y: 0.432 },
};

/** Хвост сегодняшнего журнала сервера: по нему видно, вошли ли мы и в какой бой. */
function serverLogTail() {
    const today = new Date();
    const stamp = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
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
function lastEventAt(pattern) {
    const hits = [...serverLogTail().matchAll(new RegExp(`(\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2}).*${pattern}`, 'g'))];
    return hits.length === 0 ? 0 : new Date(hits[hits.length - 1][1].replace(' ', 'T')).getTime();
}
function readBattleFromServerLog(login) {
    const text = serverLogTail();
    if (!text) return null;
    const joins = [...text.matchAll(new RegExp(`(\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2}).*User ${login} added to battle ([0-9a-f]+)`, 'g'))];
    if (joins.length === 0) return null;
    const last = joins[joins.length - 1];
    const battleId = last[2];
    const at = new Date(last[1].replace(' ', 'T')).getTime();
    const bots = new Set([...text.matchAll(new RegExp(`Bot ([\\w-]+) joined battle ${battleId}`, 'g'))].map((m) => m[1]));
    const left = new Set([...text.matchAll(new RegExp(`Bot ([\\w-]+) left battle ${battleId}`, 'g'))].map((m) => m[1]));
    for (const name of left) bots.delete(name);
    // Загрузка боя занимает секунд двадцать; пока она идёт, игра ещё в лобби. Признак готовности —
    // строка о догруженных ресурсах боя или о посадке танка на карту. Номер боя в шаблон НЕ
    // подставляем: при возврате в свой бой («Вернуться в битву») сервер пишет те же строки, а
    // привязка к последнему `added to battle` тогда промахивается.
    const readyAt = [...text.matchAll(new RegExp(
        `(\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2}).*(?:User ${login} finished loading all battle resources` +
        `|Client ${login} is ready to spawn in battle)`, 'g'))];
    const ready = readyAt.length > 0 ? new Date(readyAt[readyAt.length - 1][1].replace(' ', 'T')).getTime() : 0;
    return { battleId, at, ready, bots: [...bots] };
}

async function launch() {
    const options = {
        channel: 'chrome',
        headless: !HEADED,
        viewport: { width: 1600, height: 900 },
        args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
               '--autoplay-policy=no-user-gesture-required', '--js-flags=--expose-gc'],
    };
    for (let attempt = 1; ; attempt++) {
        try { return await chromium.launchPersistentContext(PROFILE, options); }
        catch (e) {
            if (attempt >= 5) throw e;
            console.log(`--- Chrome не стартовал (попытка ${attempt}) — ждём`);
            await sleep(5000);
        }
    }
}

(async () => {
    const context = await launch();

    // Ссылку на линейную память WASM перехватываем ДО загрузки Ruffle: иначе изнутри страницы к ней
    // не подобраться, а именно её рост показывает, что игра копит объекты.
    await context.addInitScript(() => {
        const grab = (res) => {
            try {
                const inst = res && res.instance ? res.instance : res;
                const mem = inst && inst.exports && inst.exports.memory;
                if (mem && mem.buffer) window.__wasmMem = mem;
            } catch (e) { /* не тот модуль */ }
            return res;
        };
        const streaming = WebAssembly.instantiateStreaming;
        if (streaming) {
            WebAssembly.instantiateStreaming = function (...a) {
                return streaming.apply(WebAssembly, a).then(grab);
            };
        }
        const plain = WebAssembly.instantiate;
        WebAssembly.instantiate = function (...a) { return plain.apply(WebAssembly, a).then(grab); };
    });

    const page = context.pages()[0] || (await context.newPage());
    page.on('console', (m) => { const t = m.text(); if (!NOISE.test(t)) lines.push(t); });
    page.on('pageerror', (e) => lines.push('PAGEERROR ' + e.message));
    // Баг-репорты клиента стенд уводит на /web/noop — пропускаем дальше, но считаем.
    let reports = 0;
    await page.route((url) => /755779336|aborigine|\/web\/noop/.test(url.href), async (route) => {
        reports++;
        await route.continue();
    });

    const evaluate = async (fn, timeout = 20000) => {
        try {
            return await Promise.race([
                page.evaluate(fn),
                new Promise((resolve) => setTimeout(() => resolve(null), timeout)),
            ]);
        } catch { return null; }
    };
    const stats = () => evaluate(() => window.ruffleStats || null);
    const click = async (p) => {
        const size = page.viewportSize();
        await page.mouse.click(Math.round(size.width * p.x), Math.round(size.height * p.y));
        await sleep(700);
    };
    const drive = async (keys, ms) => {
        for (const k of keys) await page.keyboard.down(k);
        await sleep(ms);
        for (const k of keys) await page.keyboard.up(k);
    };
    const chat = async (text, settle = 3000) => {
        await page.keyboard.press('Enter');
        await sleep(400);
        await page.keyboard.type(text, { delay: 20 });
        await page.keyboard.press('Enter');
        await sleep(settle);
    };
    let shot = 0;
    const snap = async (label) => {
        try {
            await page.screenshot({ path: path.join(OUT, `soak-${TAG}-${String(++shot).padStart(2, '0')}-${label}.png`), timeout: 60000 });
        } catch { /* клиент не отвечает — кадр не важнее лога */ }
    };
    const die = async (message) => {
        console.log('--- ПРОВАЛ: ' + message);
        fs.writeFileSync(path.join(OUT, `soak-${TAG}.log`), lines.map(clean).join('\n'), 'utf8');
        try { await page.screenshot({ path: path.join(OUT, `soak-${TAG}-fail.png`), timeout: 30000 }); } catch {}
        await context.close();
        process.exit(1);
    };

    console.log('--- открываем ' + URL);
    await page.goto(URL, { waitUntil: 'domcontentloaded' });
    for (let i = 0; i < 60 && !lines.some((l) => l.includes('Connecting to ws')); i++) await sleep(1000);
    await sleep(16000);

    const loggedIn = () => Date.now() - lastEventAt(`login .* for user ${LOGIN}\\b`) < 90000;
    if (!loggedIn()) {
        console.log('--- входим как ' + LOGIN);
        await click({ x: 0.08, y: 0.5 });
        await click(POINTS.loginTab);
        // Поля могут быть уже заполнены («Запомнить меня» прошлого прогона) — чистим, иначе логин
        // склеивается сам с собой и сервер отвечает «Failed login attempt for botsqabotsqa».
        const clearField = async (point) => {
            await click(point);
            await page.keyboard.press('End');
            for (let i = 0; i < 28; i++) await page.keyboard.press('Backspace');
        };
        await clearField(POINTS.loginField);
        await page.keyboard.type(LOGIN, { delay: 60 });
        await clearField(POINTS.passField);
        await page.keyboard.type(PASSWORD, { delay: 60 });
        await click(POINTS.remember);
        await click(POINTS.submit);
        await sleep(15000);
        if (!loggedIn()) await die('войти под ' + LOGIN + ' не удалось');
    }
    for (let i = 0; i < 3; i++) { await page.keyboard.press('Escape'); await sleep(400); }
    for (let i = 0; i < 2; i++) { await click(POINTS.closeNews); await click(POINTS.closeModal); }
    await snap('lobby');

    const joinedBattle = () => {
        const joined = readBattleFromServerLog(LOGIN);
        return joined && Date.now() - joined.at < 20 * 60000 ? joined : null;
    };
    /**
     * Мы в бою? Замерам движка это больше не доверяем: набор полей в них меняется от сборки к сборке
     * (в одних есть `draws`, в других нет), и сценарий из-за этого «не входил» в уже загруженный бой.
     * Достоверный признак — журнал СЕРВЕРА: вход + строка о догруженных ресурсах боя.
     */
    // Отсчёт ведём от запуска сценария: в журнале сервера ещё лежат события ПРОШЛОГО прогона, и
    // без этой отсечки сценарий считал себя в бою, стоя в лобби, — и честно мерил лобби шесть минут.
    let leftAt = Date.now();
    const inBattle = async () => {
        const joined = joinedBattle();
        if (!joined || !joined.ready || joined.ready < joined.at || joined.ready < leftAt) return false;
        return !!(await stats());
    };
    const leaveBattle = async () => {
        if (!(await inBattle())) return;
        for (let attempt = 1; attempt <= 3; attempt++) {
            // Клик по полю боя снимает фокус с чата: пока он держит ввод, Escape закрывает чат,
            // а не открывает диалог выхода, и сценарий остаётся в бою навсегда.
            await click({ x: 0.5, y: 0.45 });
            await page.keyboard.press('Escape');
            await sleep(1500);
            if (attempt > 1) await snap('exit-dialog');
            await click(POINTS.exitYes);
            await sleep(5000);
            // Вышли — сервер пишет об этом отдельной строкой.
            if (Date.now() - lastEventAt(`User ${LOGIN} removed from battle`) < 20000) break;
            console.log('--- выйти из битвы с ' + attempt + '-й попытки не вышло');
        }
        leftAt = Date.now();
    };
    // На старте выходить НЕ пробуем. Журнал сервера ещё помнит прошлый прогон, и сценарий решал,
    // что он в бою, будучи в лобби; там Escape открывает не «выйти из битвы», а «выйти из игры»,
    // и «Да» стоит ровно под той же кнопкой. Если место в бою за нами ещё держится, вход всё равно
    // сработает: в панели боя на месте «Играть» будет «Вернуться в битву», а жмём мы обе точки.

    const enterBattle = async () => {
        console.log('--- заходим в бой');
        await click(POINTS.battlesButton);
        await sleep(2000);
        await snap('battle-list');
        // Строки списка идут с шагом 20 px от 84-й при окне 1600x900 с полосой логов (?debug=1).
        for (let row = FIRST_ROW; row < FIRST_ROW + 6 && !(await inBattle()); row++) {
            await click(POINTS.closeNews);
            await click(POINTS.closeModal);
            await click({ x: POINTS.battleRow.x, y: 0.0933 + row * 0.02222 });
            // Кнопок в панели боя две: своя команда слева, чужая справа; в режиме «все против всех»
            // одна. А сразу после выхода на их месте стоит «Вернуться в битву» (сервер держит место
            // ещё минуту) — она справа. Жмём обе точки: лишний клик по пустому месту безвреден.
            await click(POINTS.battlePlay);
            await click(POINTS.battlePlayRight);
            await sleep(2500);
            // Для битв с нестандартными настройками клиент спрашивает подтверждение — жмём «Войти».
            // Наугад не жмём: без диалога этот клик попадает в список битв и выбирает другую строку.
            if (Date.now() - lastEventAt(`User ${LOGIN} is entering battle`) > 20000) {
                await click(POINTS.confirmJoin);
                await sleep(2500);
            }
            // Загрузка боя в браузере занимает секунд двадцать-сорок: ждём терпеливо.
            for (let wait = 0; wait < 16 && !(await inBattle()); wait++) await sleep(3000);
        }
        await sleep(6000);
        if (!(await inBattle())) await die('в бой войти не удалось: ' + JSON.stringify(await stats()));

        const joined = joinedBattle();
        console.log(`--- бой ${joined.battleId}, ботов сейчас: ${joined.bots.length}`);
        if (BOTS !== null) {
            await chat('/bots ' + BOTS, 8000);
            console.log('--- запросили ботов: ' + BOTS);
        }
        // Смерть выбивает замер: пока танк лежит, его физику никто не считает, время ActionScript
        // падает втрое и прогон меряет уже не бой. Бессмертие делает заходы сравнимыми между собой.
        if (!has('--nogod')) await chat('/god', 2000);
    };

    // Какой сборкой движка мерили. Рядом идёт работа над самим Ruffle, и .wasm меняется по
    // несколько раз за ночь — без этой строки два прогона «до/после» сравнивать нельзя.
    const build = await evaluate(() => (performance.getEntriesByType('resource') || [])
        .map((r) => r.name).filter((n) => n.endsWith('.wasm')).pop() || '?');
    console.log('--- сборка движка: ' + String(build).replace(/^.*\//, ''));

    await enterBattle();
    if (METHODS) {
        await page.evaluate(() => { window.ruffleTraceMethods = true; });
        console.log('--- включён счётчик горячих методов');
    }
    // Прогрев: первые секунды в бою уходят на догрузку моделей и текстур, их в статистику не берём.
    console.log('--- прогрев 30 с');
    await sleep(30000);
    // Последняя проверка перед замером: в бою движок рисует сцену Stage3D, в лобби вызовов нет.
    // Без неё прогон способен шесть минут честно мерить пустое лобби.
    const warm = await stats();
    if (!warm || !(warm.draws > 0)) {
        await snap('not-in-battle');
        await die('после входа сцена боя не рисуется: ' + JSON.stringify(warm));
    }

    // --wasmprof N: CPU-профиль самого wasm (функции интерпретатора, не AS-методы) через CDP.
    // Снимается один раз после прогрева, пишется в OUT/soak-<tag>.cpuprofile — открывается
    // в Chrome DevTools (Performance -> Load profile) или разбирается скриптом.
    if (arg('--wasmprof', null)) {
        const seconds = Number(arg('--wasmprof', 60));
        console.log(`--- CPU-профиль wasm: ${seconds} c`);
        const cdp = await page.context().newCDPSession(page);
        await cdp.send('Profiler.enable');
        await cdp.send('Profiler.setSamplingInterval', { interval: 200 });
        await cdp.send('Profiler.start');
        await sleep(seconds * 1000);
        const { profile } = await cdp.send('Profiler.stop');
        const file = path.join(OUT, `soak-${TAG}.cpuprofile`);
        fs.writeFileSync(file, JSON.stringify(profile));
        console.log('--- профиль сохранён: ' + file);
    }

    const size = page.viewportSize();
    await page.mouse.move(size.width / 2, size.height / 2);

    const plan = [
        { keys: ['KeyW'], ms: 1800 },
        { keys: ['KeyW', 'KeyA'], ms: 1400 },
        { keys: ['KeyW'], ms: 1800 },
        { keys: ['KeyW', 'KeyD'], ms: 1400 },
        { keys: ['KeyS'], ms: 1200 },
        { keys: ['KeyA'], ms: 1000 },
        { keys: ['KeyD'], ms: 1000 },
    ];

    const rows = [];
    let lastValidation = null;
    const methodHistory = [];
    let lastLineCount = lines.length;
    const startedAt = Date.now();
    const total = MINUTES * 60 * 1000;
    let step = 0;
    let round = 1;
    // --rounds N: несколько заходов в бой подряд с выходом в лобби между ними. Так проверяется
    // не «портится ли бой со временем», а «портится ли КЛИЕНТ от захода к заходу»: если разбор
    // сцены оставляет за собой объекты, второй бой стартует дороже первого.
    const roundMs = ROUNDS > 1 ? total / ROUNDS : total;
    let roundEndsAt = Date.now() + roundMs;

    console.log(`--- замер ${MINUTES} мин${ROUNDS > 1 ? ` (${ROUNDS} заходов по ${(roundMs / 60000).toFixed(1)} мин)` : ''}, замеры раз в ${SAMPLE} с`);
    console.log('   мин    FPS   AS мс   рендер  Stage3D  худший  провалов  вызовов   WASM МБ   JS куча МБ');

    while (Date.now() - startedAt < total) {
        if (ROUNDS > 1 && Date.now() > roundEndsAt && round < ROUNDS) {
            round++;
            console.log(`--- выходим в лобби и заходим снова (заход ${round} из ${ROUNDS})`);
            await leaveBattle();
            await sleep(3000);
            await enterBattle();
            await sleep(20000);
            roundEndsAt = Date.now() + roundMs;
        }
        const until = Date.now() + SAMPLE * 1000;
        if (IDLE) {
            await sleep(SAMPLE * 1000);
        } else {
            // Катаемся и стреляем всё отведённое между замерами время: неподвижная сцена не
            // показывает реальную нагрузку и не рождает эффектов.
            while (Date.now() < until) {
                const move = plan[step++ % plan.length];
                await drive(move.keys, Math.min(move.ms, Math.max(200, until - Date.now())));
                if (Date.now() >= until) break;
                await page.keyboard.press('Space');
                await sleep(150);
                await page.mouse.move(size.width * (0.25 + 0.5 * Math.random()),
                                      size.height * (0.35 + 0.3 * Math.random()));
                await sleep(150);
            }
        }

        const s = await stats();
        const mem = await evaluate(() => ({
            wasm: window.__wasmMem ? window.__wasmMem.buffer.byteLength : 0,
            jsUsed: (performance.memory || {}).usedJSHeapSize || 0,
            jsTotal: (performance.memory || {}).totalJSHeapSize || 0,
            nodes: document.getElementsByTagName('*').length,
            // Полоса логов страницы: движок печатает в консоль, а страница добавляет туда узел на
            // каждую строку. Если она растёт без конца, кадр дорожает сам по себе.
            logLines: (document.getElementById('log') || {}).childElementCount || 0,
        }));
        if (!s) continue;
        const t = (Date.now() - startedAt) / 60000;
        const row = {
            round,
            min: +t.toFixed(2),
            // `fps` движок кладёт не всегда; `ticks` — то же самое число кадров в секунду.
            fps: +(s.fps || s.ticks || 0).toFixed(1),
            asMs: +(s.asMs || 0).toFixed(2),
            renderMs: +(s.renderMs || 0).toFixed(2),
            drawMs: +(s.drawMs || 0).toFixed(2),
            worstMs: +(s.worstMs || 0).toFixed(1),
            slow: s.slowFrames || 0,
            draws: Math.round(s.draws || 0),
            submits: Math.round(s.submits || 0),
            commands: Math.round(s.commands || 0),
            wasmMb: mem ? +(mem.wasm / 1048576).toFixed(1) : 0,
            jsMb: mem ? +(mem.jsUsed / 1048576).toFixed(1) : 0,
            domNodes: mem ? mem.nodes : 0,
            logLines: mem ? mem.logLines : 0,
            // Строк в консоли за секунду: сами по себе они стоят кадра, когда их сотни.
            consolePerSec: +((lines.length - lastLineCount) / SAMPLE).toFixed(1),
        };
        lastLineCount = lines.length;
        rows.push(row);
        if (METHODS) {
            const hot = await evaluate(() => (window.ruffleStats || {}).hotMethods || []);
            if (hot && hot.length) methodHistory.push({ min: row.min, hot });
        }
        // Режим сверки: что реально сравнили и сколько расхождений. Без этого «ноль mismatch»
        // в логе может означать, что замены ни разу не исполнились.
        const validation = await evaluate(() => ({
            validated: (window.ruffleStats || {}).validated || [],
            mismatches: (window.ruffleStats || {}).nativeMismatches || [],
        }));
        if (validation.validated.length || validation.mismatches.length) {
            lastValidation = validation;
        }
        if (rows.length % Math.max(1, Math.round(30 / SAMPLE)) === 0) {
            console.log('  ' + row.min.toFixed(1).padStart(4) + '  ' +
                String(row.fps).padStart(6) + '  ' + String(row.asMs).padStart(6) + '  ' +
                String(row.renderMs).padStart(7) + '  ' + String(row.drawMs).padStart(7) + '  ' +
                String(row.worstMs).padStart(6) + '  ' + String(row.slow).padStart(8) + '  ' +
                String(row.draws).padStart(7) + '  ' + String(row.wasmMb).padStart(8) + '  ' +
                String(row.jsMb).padStart(10));
        }
    }

    // ── Отчёт ────────────────────────────────────────────────────────────────────────────────
    const csv = ['round,min,fps,asMs,renderMs,drawMs,worstMs,slow,draws,submits,commands,wasmMb,jsMb,domNodes,logLines,consolePerSec']
        .concat(rows.map((r) => [r.round, r.min, r.fps, r.asMs, r.renderMs, r.drawMs, r.worstMs, r.slow,
                                 r.draws, r.submits, r.commands, r.wasmMb, r.jsMb, r.domNodes,
                                 r.logLines, r.consolePerSec].join(',')));
    fs.writeFileSync(path.join(OUT, `soak-${TAG}.csv`), csv.join('\n'), 'utf8');

    if (lastValidation) {
        console.log('validated: ' + (lastValidation.validated.join(', ') || 'ничего'));
        console.log('mismatches: ' + (lastValidation.mismatches.length
            ? lastValidation.mismatches.map(([n, c]) => n + ' x' + c).join('  ')
            : 'нет'));
    }

    const median = (list) => {
        const a = [...list].sort((x, y) => x - y);
        return a.length ? a[Math.floor(a.length / 2)] : 0;
    };
    const pct = (list, p) => {
        const a = [...list].sort((x, y) => x - y);
        return a.length ? a[Math.min(a.length - 1, Math.floor(a.length * p))] : 0;
    };
    const part = (from, to) => rows.slice(Math.floor(rows.length * from), Math.floor(rows.length * to));
    const describe = (label, list) => {
        if (!list.length) return;
        console.log(`--- ${label}: FPS медиана ${median(list.map((r) => r.fps)).toFixed(1)}, ` +
            `p5 ${pct(list.map((r) => r.fps), 0.05).toFixed(1)}; ` +
            `AS ${median(list.map((r) => r.asMs)).toFixed(1)} мс, ` +
            `p95 ${pct(list.map((r) => r.asMs), 0.95).toFixed(1)} мс; ` +
            `рендер ${median(list.map((r) => r.renderMs)).toFixed(1)} мс; ` +
            `вызовов ${Math.round(median(list.map((r) => r.draws)))}; ` +
            `WASM ${median(list.map((r) => r.wasmMb)).toFixed(1)} МБ`);
    };
    console.log('');
    if (ROUNDS > 1) {
        for (let r = 1; r <= ROUNDS; r++) describe('заход ' + r, rows.filter((x) => x.round === r));
        console.log('');
    }
    describe('первая треть', part(0, 1 / 3));
    describe('середина    ', part(1 / 3, 2 / 3));
    describe('последняя треть', part(2 / 3, 1));
    console.log(`--- за весь прогон: FPS медиана ${median(rows.map((r) => r.fps)).toFixed(1)}, ` +
        `p5 ${pct(rows.map((r) => r.fps), 0.05).toFixed(1)}; ` +
        `AS медиана ${median(rows.map((r) => r.asMs)).toFixed(1)} мс, ` +
        `p95 ${pct(rows.map((r) => r.asMs), 0.95).toFixed(1)} мс`);
    if (rows.length) {
        const last = rows[rows.length - 1];
        console.log(`--- WASM: ${rows[0].wasmMb} -> ${last.wasmMb} МБ; ` +
            `куча JS: ${rows[0].jsMb} -> ${last.jsMb} МБ; ` +
            `узлов DOM: ${rows[0].domNodes} -> ${last.domNodes}; ` +
            `строк в полосе логов: ${rows[0].logLines} -> ${last.logLines}; ` +
            `строк консоли в секунду: ${median(rows.map((r) => r.consolePerSec)).toFixed(1)}`);
    }
    console.log(`--- баг-репортов клиента: ${reports}`);

    // Горячие методы: сравниваем ВЫЗОВЫ в секунду в начале и в конце. Рост вызовов = рост коллекции.
    if (methodHistory.length >= 4) {
        const take = (slice) => {
            const acc = new Map();
            for (const sample of slice) {
                for (const [name, ops, calls] of sample.hot) {
                    const cur = acc.get(name) || { ops: 0, calls: 0, n: 0 };
                    cur.ops += ops; cur.calls += calls; cur.n++;
                    acc.set(name, cur);
                }
            }
            const out = new Map();
            for (const [name, v] of acc) out.set(name, { ops: v.ops / v.n, calls: v.calls / v.n });
            return out;
        };
        const head = take(methodHistory.slice(0, Math.max(3, Math.floor(methodHistory.length / 5))));
        const tail = take(methodHistory.slice(-Math.max(3, Math.floor(methodHistory.length / 5))));
        const grown = [];
        for (const [name, later] of tail) {
            const earlier = head.get(name);
            const before = earlier ? earlier.calls : 0;
            grown.push({ name, before, after: later.calls, ops: later.ops,
                         ratio: before > 0 ? later.calls / before : Infinity });
        }
        grown.sort((a, b) => (b.after - b.before) - (a.after - a.before));
        console.log('--- горячие методы: вызовов в секунду, начало -> конец (по приросту)');
        grown.slice(0, 25).forEach((g) => console.log(
            '    ' + (g.ratio === Infinity ? ' новый' : ('x' + g.ratio.toFixed(2)).padStart(6)) + '  ' +
            String(Math.round(g.before)).padStart(9) + ' -> ' + String(Math.round(g.after)).padStart(9) +
            '  ' + g.name));
        fs.writeFileSync(path.join(OUT, `soak-${TAG}-methods.json`),
            JSON.stringify(methodHistory, null, 1), 'utf8');
    }

    fs.writeFileSync(path.join(OUT, `soak-${TAG}.log`), lines.map(clean).join('\n'), 'utf8');
    try { await page.screenshot({ path: path.join(OUT, `soak-${TAG}-end.png`), timeout: 30000 }); } catch {}
    await leaveBattle();
    await context.close();
})().catch(async (e) => {
    console.error(e);
    try { fs.writeFileSync(path.join(OUT, `soak-${TAG}.log`), lines.map(clean).join('\n'), 'utf8'); } catch {}
    process.exit(1);
});
