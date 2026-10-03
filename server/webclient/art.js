/**
 * Проверка игровой графики в браузере: экран входа, баннер загрузки и флаги CTF вблизи.
 *
 *   node webclient/art.js                  прогон на своём профиле webclient/.art-profile
 *   node webclient/art.js --fresh          снести профиль перед стартом (пустой кэш, форма входа)
 *   node webclient/art.js --profile .e2e-profile   взять чужой профиль (со СТАРЫМ кэшем ресурсов)
 *   node webclient/art.js --tag before     приставка к именам кадров (webclient/art-before-*.png)
 *   node webclient/art.js --row 5          с какой строки списка битв начинать перебор
 *   node webclient/art.js --slow           придержать сеть, чтобы снять экран загрузки
 *   node webclient/art.js --headed         с видимым окном
 *
 * Глазами по кадру видно только «похоже на новое». Поэтому сценарий заодно считает sha1 КАЖДОГО
 * ответа с картинкой ресурса и сверяет с манифестом выгрузки (art-export/manifest.json): так
 * отличается «клиент скачал новый файл» от «клиент достал старый из кэша». Ресурсы отдаются с
 * `Cache-Control: immutable` на год, поэтому второе — обычное дело, и без сверки прогон врёт.
 */
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { chromium } = require('playwright-core');

// Имя PAGE_URL, а не URL: глобальный конструктор URL нужен ниже для разбора адресов ответов.
const PAGE_URL = process.env.E2E_URL || 'http://localhost:9999/web/?debug=1';
const LOGIN = process.env.E2E_LOGIN || 'e2e';
const PASSWORD = process.env.E2E_PASSWORD || 'e2e12345';
const HEADED = process.argv.includes('--headed');
const FRESH = process.argv.includes('--fresh');
/**
 * --slow: придержать сеть на время входа в бой. На localhost бой грузится за три секунды, а
 * баннер-подсказку сервер присылает по запросу клиента раз в полминуты (RequestNextTip), поэтому в
 * обычном прогоне экран загрузки успевает показать только заводскую заставку из library.swf, и снять
 * новый баннер нечем.
 */
const SLOW = process.argv.includes('--slow');
const SERVER_LOGS = path.join(__dirname, '..', 'logs');

const arg = (name, fallback) => {
    const i = process.argv.indexOf(name);
    return i !== -1 ? process.argv[i + 1] : fallback;
};
const TAG = arg('--tag', 'art');
/** С какой строки списка битв начинать перебор в поисках боя с флагами. */
const ROW = Number(arg('--row', 0));
const PROFILE = path.resolve(__dirname, arg('--profile', '.art-profile'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Ruffle рисует игру в canvas, DOM-селекторов внутри нет — жать приходится по координатам.
// Значения в долях от размера окна, чтобы не зависеть от разрешения.
const POINTS = {
    loginTab: { x: 0.506, y: 0.21 },
    loginField: { x: 0.525, y: 0.377 },
    passField: { x: 0.525, y: 0.418 },
    submit: { x: 0.570, y: 0.473 },
    okDialog: { x: 0.4975, y: 0.4289 },  // «ОК» в окошке с ошибкой входа
    closeModal: { x: 0.617, y: 0.637 },
    closeNews: { x: 0.500, y: 0.494 },
    battlesButton: { x: 0.798, y: 0.018 },
    battleRow: { x: 0.50, y: 0.10 },
    // В командном бою кнопок «Играть» две — по одной на команду; в дезматче есть только правая.
    playRed: { x: 0.713, y: 0.783 },
    playBlue: { x: 0.952, y: 0.783 },
    confirmJoin: { x: 0.491, y: 0.432 },
    exitYes: { x: 0.4625, y: 0.4222 },
};

// Список битв: первая строка по центру на 84-й точке окна высотой 900, шаг строки — 20 точек.
const ROW_TOP = 84 / 900;
const ROW_STEP = 20 / 900;

/**
 * Чего ждём от раздачи. Адрес ресурса берём из сгенерированного resourceTypes.ts (он и есть источник
 * правды для клиента), эталонный sha1 — из манифеста выгрузки. Читаем оба файла текстом: тянуть сюда
 * ts-node ради двух регулярок ни к чему.
 */
function expectedFiles() {
    const types = fs.readFileSync(path.join(__dirname, '..', 'src', 'generated', 'resourceTypes.ts'), 'utf8');
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'art-export', 'manifest.json'), 'utf8'));
    const byResource = new Map();
    for (const m of types.matchAll(/"([^"]+)": \{ idLow: \d+, path: "([^"]+)", versionLow: \d+ \}/g)) {
        byResource.set(m[1], m[2]);
    }
    const expected = new Map();
    for (const item of manifest.items) {
        // Плакаты лежат внутри library.tara — по одному ответу их не проверить, пропускаем.
        if (item.entry !== null) continue;
        const base = byResource.get(item.resource);
        if (!base) continue;
        expected.set(base + item.name, { sha1: item.sha1, file: item.file, resource: item.resource });
    }
    return expected;
}

/** Хвост сегодняшнего журнала сервера: за сутки он весит десятки мегабайт. */
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

(async () => {
    const startedAt = Date.now();
    const expected = expectedFiles();
    if (FRESH) fs.rmSync(PROFILE, { recursive: true, force: true });

    const context = await chromium.launchPersistentContext(PROFILE, {
        channel: 'chrome',
        headless: !HEADED,
        viewport: { width: 1600, height: 900 },
        args: [
            // Ruffle рендерит через wgpu-webgl; в headless нужен софтверный GL.
            '--use-gl=angle',
            '--use-angle=swiftshader',
            '--enable-unsafe-swiftshader',
            '--autoplay-policy=no-user-gesture-required',
        ],
    });

    const page = context.pages()[0] || (await context.newPage());
    const lines = [];
    page.on('console', (m) => lines.push(m.text()));

    /** Что клиент реально получил по каждому наблюдаемому адресу: адрес -> sha1 тела. */
    const got = new Map();
    /** Адреса ресурсов, запрошенные с последнего сброса: по ним видно, что грузит текущий бой. */
    let recent = new Set();
    page.on('response', async (response) => {
        const url = new URL(response.url());
        if (!/^\/0(\/\d+){4}\//.test(url.pathname)) return;
        recent.add(url.pathname);
        try {
            const body = await response.body();
            got.set(url.pathname, crypto.createHash('sha1').update(body).digest('hex'));
        } catch {
            /* тело уже недоступно — не беда, ниже будет видно как «не запрашивался» */
        }
    });

    let shot = 0;
    const snap = async (label) => {
        const file = path.join(__dirname, `${TAG}-${String(++shot).padStart(2, '0')}-${label}.png`);
        try {
            await page.screenshot({ path: file, timeout: 60000 });
            return file;
        } catch (e) {
            console.log(`--- кадр ${label} снять не удалось: ${e.message.split('\n')[0]}`);
            return null;
        }
    };
    const click = async (p, settle = 700) => {
        const size = page.viewportSize();
        await page.mouse.click(Math.round(size.width * p.x), Math.round(size.height * p.y));
        await sleep(settle);
    };
    const chat = async (text, settle = 2500) => {
        await page.keyboard.press('Enter');
        await sleep(400);
        await page.keyboard.type(text, { delay: 20 });
        await page.keyboard.press('Enter');
        await sleep(settle);
    };
    const drive = async (keys, ms) => {
        for (const k of keys) await page.keyboard.down(k);
        await sleep(ms);
        for (const k of keys) await page.keyboard.up(k);
    };

    console.log('--- профиль: ' + PROFILE + (FRESH ? ' (снесён перед стартом)' : ''));
    console.log('--- открываем ' + PAGE_URL);
    await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded' });
    for (let i = 0; i < 60 && !lines.some((l) => l.includes('Connecting to ws')); i++) await sleep(1000);

    // Загрузчик показывает баннер-подсказку (tips/*), потом появляется форма входа с фоном
    // (ui/login_background). Обе стадии проскакивают за несколько секунд, поэтому снимаем часто.
    for (let i = 0; i < 16; i++) {
        await snap('boot');
        await sleep(1300);
    }

    // Событие входа засчитываем только СВЕЖЕЕ: в журнале лежат входы прошлых прогонов, и по ним
    // сценарий уже «входил», стоя на форме, а потом восемь минут тыкал в пустоту.
    // Пробела после `.*` быть не должно: по паролю сервер пишет «Successful login for user», а по
    // токену — «Successful login via token for user». С пробелом первый случай мимо, и прогон падал
    // на входе, хотя вход прошёл.
    const loggedIn = () => lastEventAt(`Successful login .*for user ${LOGIN}\\b`) > startedAt;
    if (!loggedIn()) {
        // Сохранённый аккаунт клиент подставляет в форму сам, но сам её не отправляет — сначала просто
        // жмём «Играть», и только если не вышло, заполняем поля руками.
        console.log('--- входим как ' + LOGIN);
        await click({ x: 0.08, y: 0.5 });  // первый клик уходит на фокус холста
        await click(POINTS.submit);
        await sleep(12000);
    }
    if (!loggedIn()) {
        await click(POINTS.okDialog);      // «Пароль неверный», если поля были заполнены не нами
        await click(POINTS.loginTab);      // ссылка «Авторизуйтесь!» на экране регистрации
        await click(POINTS.loginField);
        // Поле может быть уже заполнено: без очистки логин склеится сам с собой.
        await page.keyboard.press('End');
        for (let i = 0; i < 40; i++) await page.keyboard.press('Backspace');
        await page.keyboard.type(LOGIN, { delay: 60 });
        await click(POINTS.passField);
        await page.keyboard.press('End');
        for (let i = 0; i < 40; i++) await page.keyboard.press('Backspace');
        await page.keyboard.type(PASSWORD, { delay: 60 });
        await click(POINTS.submit);
        await sleep(15000);
    }
    if (!loggedIn()) {
        console.log('--- ПРОВАЛ: войти под ' + LOGIN + ' не удалось');
        await snap('login-failed');
        await context.close();
        process.exit(1);
    }

    for (let i = 0; i < 2; i++) { await click(POINTS.closeNews); await click(POINTS.closeModal); }
    // Сервер минуту держит место в прошлом бою и возвращает туда при переподключении, поэтому после
    // входа мы можем оказаться не в лобби. Выходим: иначе список битв не открыть.
    await page.keyboard.press('Escape');
    await sleep(1500);
    await click(POINTS.exitYes, 6000);
    await snap('lobby');

    await click(POINTS.battlesButton, 2500);
    await snap('battle-list');

    const cdp = SLOW ? await context.newCDPSession(page) : null;
    const throttle = async (on) => {
        if (!cdp) return;
        await cdp.send('Network.enable');
        await cdp.send('Network.emulateNetworkConditions', {
            offline: false, latency: on ? 80 : 0,
            downloadThroughput: on ? 150 * 1024 : -1, uploadThroughput: on ? 150 * 1024 : -1,
        });
    };
    await throttle(true);

    /**
     * Ищем бой с флагами перебором строк: режим по списку не виден (у всех командных боёв одинаковая
     * пара счётчиков), а картинки флагов клиент качает в ЛЮБОМ бою — они лежат в общем списке
     * зависимостей (battle.workflow.ts), так что по загрузке режим не определить.
     *
     * Зато его видно в журнале сервера: в бою с флагами боты их постоянно берут и возвращают, и каждое
     * такое событие подписано номером боя. Собираем номера таких боёв и сверяем с тем, куда нас пустили.
     */
    const ctfBattles = () => new Set([...serverLogTail()
        .matchAll(/flag[^\n]*? in battle ([0-9a-f]+)/gi)].map((m) => m[1]));
    /**
     * Номер боя, в который нас пустили ПОСЛЕ момента `after`, или null. Отсечка по времени
     * обязательна: запись о входе остаётся в журнале и после выхода из боя, и без неё каждая
     * следующая попытка «попадала» в тот же самый бой.
     */
    const currentBattle = (after) => {
        const hits = [...serverLogTail().matchAll(
            new RegExp(`(\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2}).*User ${LOGIN} added to battle ([0-9a-f]+)`, 'g'))];
        if (hits.length === 0) return null;
        const last = hits[hits.length - 1];
        return new Date(last[1].replace(' ', 'T')).getTime() >= after ? last[2] : null;
    };

    let joined = false;
    let idle = 0;
    for (let row = ROW; row < ROW + 24 && !joined; row++) {
        recent = new Set();
        // Журнал сервера пишет время с точностью до секунды, поэтому отсечку сдвигаем на секунду назад.
        const since = Date.now() - 1000;
        await click(POINTS.closeNews, 300);
        await click(POINTS.closeModal, 300);
        await click({ x: POINTS.battleRow.x, y: ROW_TOP + row * ROW_STEP });
        // У командного боя две кнопки «Играть» (по кнопке на команду), у дезматча — только правая.
        await click(POINTS.playRed, 300);
        await click(POINTS.playBlue, 300);
        for (let i = 0; i < 10 && !currentBattle(since); i++) {
            await sleep(1500);
            if (i === 2) await click(POINTS.confirmJoin, 300);
        }
        const battle = currentBattle(since);
        if (!battle || !ctfBattles().has(battle)) {
            console.log(`--- строка ${row}: не тот режим (бой ${battle ?? 'не открылся'})`);
            // Ни одного ресурса подряд — значит мы не в лобби и клики уходят в никуда. Перебирать
            // строки дальше бессмысленно, это восемь минут вхолостую.
            idle = recent.size === 0 ? idle + 1 : 0;
            if (idle >= 3) break;
            if (battle) {
                await page.keyboard.press('Escape');
                await sleep(1500);
                await click(POINTS.exitYes, 6000);
            }
            await click(POINTS.battlesButton, 1500);
            continue;
        }
        joined = true;
        console.log(`--- строка ${row}: бой с флагами ${battle}, ждём загрузку`);
    }
    if (!joined) {
        console.log('--- ПРОВАЛ: бой в режиме захвата флага найти не удалось');
        await snap('no-ctf');
        await context.close();
        process.exit(1);
    }
    // Сервер записывает вход в бой раньше, чем клиент дорисовывает карту, поэтому экран загрузки с
    // баннером-подсказкой ловится ЗДЕСЬ, а не на самих кликах: там он ещё не успевает появиться.
    for (let i = 0; i < (SLOW ? 25 : 9); i++) { await snap('loading'); await sleep(1500); }
    await throttle(false);
    await click(POINTS.confirmJoin, 4000);
    await sleep(6000);
    await snap('battle');

    // Флаги. `/tpflag` доступен со стенда без прав модератора (см. command.service.ts). После
    // переноса отъезжаем назад: на самой точке флаг оказывается внутри камеры и в кадр не влезает.
    for (const colour of ['red', 'blue']) {
        await chat('/tpflag ' + colour);
        await snap('tp-' + colour);
        await drive(['KeyS'], 1200);
        await sleep(1200);
        await snap('flag-' + colour);
        await drive(['KeyS'], 1200);
        await sleep(1200);
        await snap('flag-' + colour + '-far');
    }

    // Выходим, иначе сервер держит игрока в бою ещё минуту и следующий прогон попадёт туда же.
    await page.keyboard.press('Escape');
    await sleep(1500);
    await click(POINTS.exitYes, 5000);

    console.log('\n--- что клиент скачал (эталон — art-export/manifest.json):');
    let stale = 0;
    for (const [urlPath, want] of expected) {
        const have = got.get(urlPath);
        const state = have === undefined ? 'НЕ ЗАПРАШИВАЛСЯ' : have === want.sha1 ? 'новый' : 'СТАРЫЙ (из кэша)';
        if (have !== undefined && have !== want.sha1) stale++;
        console.log(`    ${state.padEnd(16)} ${urlPath}  ${want.file}`);
    }
    console.log(stale === 0 ? '--- старых картинок не осталось' : `--- СТАРЫХ КАРТИНОК: ${stale}`);

    fs.writeFileSync(path.join(__dirname, `${TAG}.log`), lines.join('\n'), 'utf8');
    console.log('--- лог: webclient/' + TAG + '.log');
    await context.close();
    process.exit(stale === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
