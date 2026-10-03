/**
 * Прогон боя с ботами в живом клиенте: заходит в бой, где играют боты, катается и стреляет пару
 * минут, снимает серию кадров и проверяет консоль движка на ошибки.
 *
 *   node webclient/bots.js                обычный прогон (90 секунд в бою)
 *   node webclient/bots.js --headed       с видимым окном
 *   node webclient/bots.js --seconds 150  другая длительность
 *
 * Тест падает с ненулевым кодом, если:
 *   - в бой войти не удалось (иначе проверять нечего и прогон «проходит» вхолостую);
 *   - в бою нет ботов (то же самое: проверяли бы пустой бой);
 *   - в логе движка есть паника Ruffle, ошибка AVM2 (Error #, #1009) или неизвестный пакет.
 *
 * Кадры складываются в webclient/bots-*.png, полный лог — в webclient/bots.log.
 * Требуются запущенные игровой сервер, websockify и раздача стенда (см. README.md).
 */
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright-core');

// Тесты открывают стенд в режиме отладки: снизу полоса логов, поверх боя счётчик кадров.
// Заодно это фиксирует раскладку окна, по которой выверены координаты кликов.
const URL = process.env.E2E_URL || 'http://localhost:9999/web/?debug=1&log=debug';
// Аккаунт СВОЙ, а не общий `e2e`: сервер держит один сеанс на логин, и когда рядом идёт другой
// сценарий (e2e.js, crate.js), он выбивает нас из боя — на экране «Connection closed by server», а
// прогон честно доигрывает пустоту. Заводится один раз через форму регистрации клиента.
const LOGIN = process.env.E2E_LOGIN || 'botsqa';
const PASSWORD = process.env.E2E_PASSWORD || 'bots12345';
const HEADED = process.argv.includes('--headed');
// Профиль СВОЙ, а не общий .e2e-profile: остальные сценарии (e2e.js, crate.js) запускаются
// параллельно, а Chrome не пускает два браузера в один каталог и просто не стартует.
const PROFILE = path.join(__dirname, '.bots-profile');
const SERVER_LOGS = path.join(__dirname, '..', 'logs');

const arg = (name, fallback) => {
    const i = process.argv.indexOf(name);
    return i !== -1 ? Number(process.argv[i + 1]) : fallback;
};
const PLAY_SECONDS = arg('--seconds', Number(process.env.BOTS_SECONDS || 90));
/**
 * --bots N: сменить число ботов в бою сразу после входа. Можно указать два числа через запятую
 * (`--bots 0,6`): первое применяется сразу, второе — в середине прогона. Так отделяются беды ВХОДА
 * (боты уже были в бою) от бед ПОДСАДКИ (бот приходит в уже построенный бой).
 */
const SET_BOTS = (() => {
    const i = process.argv.indexOf('--bots');
    return i !== -1 ? String(process.argv[i + 1]).split(',').map(Number) : null;
})();
/** --idle: не ездить и не стрелять, только смотреть. Так видно, что копится само по себе. */
const IDLE = process.argv.includes('--idle');
/**
 * --follow: не кататься самому, а прыгать к ботам по очереди (`/tpto`) и снимать их вблизи, крутя
 * башню. Так видно, КАК бот стоит и едет: на своей позиции его загораживает половина карты, а если
 * просто ездить, танк рано или поздно упирается в угол и все кадры выходят в стену.
 */
const FOLLOW = process.argv.includes('--follow');
/**
 * --row N: с какой строки списка битв начинать перебор. Стартовые бои сервер заводит по каталогу карт
 * по порядку (см. seedBotBattles), поэтому номер строки — это и есть выбор карты: нужен рельеф, а на
 * первой попавшейся карте склонов может не быть вовсе.
 */
const FIRST_ROW = arg('--row', 0);
/** --tag имя: приставка к именам кадров и лога, чтобы прогоны не затирали друг друга. */
const TAG = (() => {
    const i = process.argv.indexOf('--tag');
    return i !== -1 ? process.argv[i + 1] : 'bots';
})();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Строки консоли движка. Живут снаружи сценария: лог нужен и когда прогон свалился на полпути. */
const lines = [];

/**
 * Отчёты об ошибках самого клиента. Игра ловит исключения своих обработчиков пакетов в try/catch, поэтому
 * в консоли Ruffle их не видно — вместо этого она шлёт текст со стеком POST-запросом на свой адрес
 * баг-репортов (класс _SafeStr_86 в library.swf) и после 14-й такой ошибки вешает на экран панель
 * «Произошла критическая ошибка» (ключ ERROR_FATAL). Перехватываем эти запросы: их тело — единственный
 * способ прочитать настоящую ошибку клиента.
 */
// Стенд перенаправляет адрес баг-репортов на /web/noop (см. urlRewriteRules в index.html), поэтому
// ловить надо ИМЕННО его: до сети исходный адрес не доходит.
const REPORT_URL = /755779336|aborigine|\/web\/noop/;
const reports = [];

// Ruffle рисует игру в canvas, DOM-селекторов внутри нет — жать приходится по координатам.
// Значения в долях от размера окна, чтобы не зависеть от разрешения.
const POINTS = {
    loginTab: { x: 0.506, y: 0.21 },
    loginField: { x: 0.525, y: 0.377 },
    passField: { x: 0.525, y: 0.418 },
    remember: { x: 0.459, y: 0.473 },
    submit: { x: 0.570, y: 0.473 },
    closeModal: { x: 0.617, y: 0.637 },     // «Закрыть» в окне приглашений
    closeNews: { x: 0.500, y: 0.494 },      // «Закрыть» в окне новостей (вылезает на новом аккаунте)
    exitYes: { x: 0.4625, y: 0.4222 },   // «Да» в диалоге выхода из битвы (Escape в бою)
    battlesButton: { x: 0.798, y: 0.018 },
    battleRow: { x: 0.50, y: 0.10 },
    battlePlay: { x: 0.71, y: 0.78 },
    confirmJoin: { x: 0.491, y: 0.432 },
};

/**
 * Что считаем поломкой клиента. `#1009` (обращение к null) и «No packet class found for ID» — ровно
 * те симптомы, на которые жаловался пользователь, поэтому они вынесены отдельными правилами: так в
 * отчёте видно, какая именно беда сработала, а не просто «была ошибка».
 */
const FATAL = [
    { name: 'паника Ruffle', re: /panicked|Panic|Что-то пошло не так/ },
    { name: 'обращение к null (#1009)', re: /#1009/ },
    { name: 'неизвестный пакет', re: /No packet class found for ID/ },
    { name: 'ошибка AVM2', re: /Error #\d+/ },
    { name: 'необработанное исключение', re: /Unhandled (?:AVM2 )?exception|Uncaught \(in promise\)/ },
];

/** Шум движка и стенда, который к игре отношения не имеет. */
const NOISE = /symphonia|main_data_begin|estimating duration|Ignoring unsupported|WebGL|Compiled shader|Using ANGLE|GPU stall/;

/** Обрезает раскраску консоли Ruffle, иначе строки нечитаемы. */
const clean = (line) => line.replace(/%c/g, '').replace(/ ?color:[^;]*;?/g, '').trim();

function saveLog() {
    const file = path.join(__dirname, `${TAG}.log`);
    fs.writeFileSync(file, lines.map(clean).join('\n'), 'utf8');
    return file;
}

/** Хвост сегодняшнего журнала сервера. За сутки он весит десятки мегабайт — читаем только конец. */
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

/** Время последнего события журнала, подходящего под шаблон, или 0. */
function lastEventAt(pattern) {
    const hits = [...serverLogTail().matchAll(new RegExp(`(\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2}).*${pattern}`, 'g'))];
    return hits.length === 0 ? 0 : new Date(hits[hits.length - 1][1].replace(' ', 'T')).getTime();
}

/** Последняя битва, в которую вошёл наш логин, и число ботов в ней — по журналу сервера. */
function readBattleFromServerLog(login) {
    const text = serverLogTail();
    if (!text) return null;

    // Время входа берём из самой строки журнала: без него сценарий засчитывал СТАРУЮ запись и «входил»
    // в бой, которого в этом прогоне не было (например, застряв в лобби под всплывшим окном).
    const joins = [...text.matchAll(new RegExp(`(\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2}).*User ${login} added to battle ([0-9a-f]+)`, 'g'))];
    if (joins.length === 0) return null;
    const last = joins[joins.length - 1];
    const battleId = last[2];
    const at = new Date(last[1].replace(' ', 'T')).getTime();
    const bots = new Set([...text.matchAll(new RegExp(`Bot ([\\w-]+) joined battle ${battleId}`, 'g'))].map((m) => m[1]));
    const left = new Set([...text.matchAll(new RegExp(`Bot ([\\w-]+) left battle ${battleId}`, 'g'))].map((m) => m[1]));
    for (const name of left) bots.delete(name);
    return { battleId, at, bots: [...bots] };
}

/**
 * Открывает браузер. Профиль общий с остальными сценариями, и если предыдущий прогон закрылся только
 * что, Chrome ещё держит его каталог и падает при старте — поэтому пробуем несколько раз.
 */
async function launch() {
    const options = {
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
    };
    for (let attempt = 1; ; attempt++) {
        try {
            return await chromium.launchPersistentContext(PROFILE, options);
        } catch (e) {
            if (attempt >= 5) throw e;
            console.log(`--- Chrome не стартовал (попытка ${attempt}), профиль ещё занят — ждём`);
            await sleep(5000);
        }
    }
}

(async () => {
    const context = await launch();

    const page = context.pages()[0] || (await context.newPage());
    page.on('console', (m) => {
        const text = m.text();
        if (NOISE.test(text)) return;
        lines.push(text);
    });
    page.on('pageerror', (e) => lines.push('PAGEERROR ' + e.message));

    // Баг-репорты клиента: адрес заведомо недоступен, поэтому просто снимаем тело и обрываем запрос.
    await page.route((url) => REPORT_URL.test(url.href), async (route) => {
        const body = route.request().postData();
        // Время нужно, чтобы сопоставить отчёт с журналом сервера: там видно, что в этот миг
        // происходило с танком (появление, активация, смерть).
        const stamp = new Date().toTimeString().slice(0, 8);
        reports.push(stamp + ' ' + (body ? decodeURIComponent(body.replace(/\+/g, ' ')) : '(пустой отчёт) ' + route.request().url()));
        // Пропускаем дальше: стенд уводит эти запросы на /web/noop нашего же ресурсного сервера, а тот
        // печатает отчёт в лог сервера. Оборвать запрос — значит лишить лог сервера тех же данных.
        await route.continue();
    });
    // Если песочница Flash не пустит POST наружу, останется хотя бы факт попытки.
    page.on('requestfailed', (r) => { if (REPORT_URL.test(r.url())) lines.push('REPORT-FAILED ' + r.url()); });

    /**
     * Замеры движка. Когда клиент захлёбывается, его поток скриптов занят целыми секундами, и обычный
     * page.evaluate висит вместе с ним — прогон встаёт намертво. Поэтому ждём ответ ограниченное время
     * и, не дождавшись, считаем, что замера нет.
     */
    const stats = async (timeout = 15000) => {
        try {
            return await Promise.race([
                page.evaluate(() => window.ruffleStats || null),
                new Promise((resolve) => setTimeout(() => resolve(null), timeout)),
            ]);
        } catch {
            return null;
        }
    };

    let shot = 0;
    const snap = async (label) => {
        const file = path.join(__dirname, `${TAG}-${String(++shot).padStart(2, '0')}-${label}.png`);
        // Когда клиент захлёбывается, кадр отдаётся дольше таймаута playwright. Это само по себе
        // диагноз («игра не отвечает»), но ронять на этом прогон нельзя — лог важнее кадра.
        try {
            await page.screenshot({ path: file, timeout: 60000 });
        } catch (e) {
            console.log(`--- кадр ${label} снять не удалось (клиент не отвечает): ${e.message.split('\n')[0]}`);
            return null;
        }
        return file;
    };
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
    const failures = (from = 0) => {
        const found = [];
        for (const line of lines.slice(from)) {
            for (const rule of FATAL) {
                if (rule.re.test(line)) { found.push({ rule: rule.name, line: clean(line) }); break; }
            }
        }
        return found;
    };
    /** Печатает пойманные баг-репорты клиента, сгруппированные по первой строке стека. */
    const printReports = () => {
        if (reports.length === 0) return;
        const groups = new Map();
        for (const text of reports) {
            const key = (text.match(/at [\w:.$\\\/]+/) || text.match(/\[\w+\]/) || [text.slice(0, 60)])[0];
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(text);
        }
        console.log(`--- баг-репортов клиента: ${reports.length} (панель «критическая ошибка» вылезает после 13)`);
        for (const [key, items] of groups) {
            console.log(`    ${key} x${items.length}`);
            console.log('      ' + items[0].replace(/\s+/g, ' ').slice(0, 600));
        }
    };
    const die = async (message) => {
        console.log('--- ПРОВАЛ: ' + message);
        printReports();
        console.log('--- лог: ' + saveLog());
        await snap('fail');
        try { await leaveBattle(); } catch { /* уже не в бою */ }
        await context.close();
        process.exit(1);
    };

    console.log('--- открываем ' + URL);
    await page.goto(URL, { waitUntil: 'domcontentloaded' });
    for (let i = 0; i < 60 && !lines.some((l) => l.includes('Connecting to ws')); i++) await sleep(1000);
    await sleep(16000);

    /*
     * Вошли ли мы. Признак берём из журнала СЕРВЕРА: на экране входа Ruffle тоже отдаёт замеры, так что
     * по ним «вход» засчитывался всегда и форма никогда не заполнялась. Когда профиль браузера пустой
     * (первый запуск или сменился аккаунт), клиент показывает форму — проходим её и ставим «Запомнить»,
     * чтобы следующие прогоны входили сами.
     */
    const loggedIn = () => Date.now() - lastEventAt(`login .* for user ${LOGIN}\\b`) < 90000;
    if (!loggedIn()) {
        console.log('--- входим как ' + LOGIN);
        await click({ x: 0.08, y: 0.5 });  // первый клик уходит на фокус холста
        await click(POINTS.loginTab);
        await click(POINTS.loginField);
        await page.keyboard.type(LOGIN, { delay: 60 });
        await click(POINTS.passField);
        await page.keyboard.type(PASSWORD, { delay: 60 });
        await click(POINTS.remember);
        await click(POINTS.submit);
        await sleep(15000);
        if (!loggedIn()) {
            await die('войти под ' + LOGIN + ' не удалось — проверьте, что аккаунт существует');
        }
    }
    for (let i = 0; i < 3; i++) { await page.keyboard.press('Escape'); await sleep(400); }
    // Поверх лобби всплывают разные окна (приглашения, новости) — у каждого своя кнопка «Закрыть».
    for (let i = 0; i < 2; i++) { await click(POINTS.closeNews); await click(POINTS.closeModal); }
    await snap('lobby');

    /**
     * Мы в бою? Главный признак — свежая запись о входе в ЖУРНАЛЕ СЕРВЕРА: замеры Ruffle обманывают,
     * потому что в лобби тоже есть сцена Stage3D (превью карты, окно приглашений с танками), и по ним
     * сценарий уже «входил в бой», стоя в лобби. Замеры оставлены как второе условие: они подтверждают,
     * что клиент действительно рисует бой, а не висит на загрузке.
     */
    const joinedBattle = () => {
        const joined = readBattleFromServerLog(LOGIN);
        return joined && Date.now() - joined.at < 60000 ? joined : null;
    };
    const inBattle = async () => {
        if (!joinedBattle()) return false;
        const s = await stats();
        return !!s && (s.draws || 0) > 0;
    };

    /**
     * Выход из битвы в лобби. Нужен и в конце прогона: иначе сервер держит игрока в бою ещё минуту
     * (окно переподключения), следующий запуск попадает туда же по реконнекту, и сценарий не понимает,
     * где он находится, — прогон валится «в бой войти не удалось» на ровном месте.
     */
    const leaveBattle = async () => {
        if (!(await inBattle())) return;
        await page.keyboard.press('Escape');
        await sleep(1500);
        await click(POINTS.exitYes);
        await sleep(5000);
    };
    await leaveBattle();

    console.log('--- заходим в бой');
    await click(POINTS.battlesButton);
    await sleep(2000);
    await snap('battle-list');

    // Первой в списке может стоять битва, куда наш танк не пускают, поэтому перебираем строки.
    for (let row = FIRST_ROW; row < FIRST_ROW + 5 && !(await inBattle()); row++) {
        // Окна приглашений и подсказок всплывают сами и перекрывают список — закрываем перед каждой
        // попыткой, иначе клики уходят в них. Кнопку «Битвы» повторно НЕ жмём: если бой уже грузится,
        // это возврат в лобби и загрузка отменяется.
        await click(POINTS.closeNews);
        await click(POINTS.closeModal);
        await click({ x: POINTS.battleRow.x, y: POINTS.battleRow.y + row * 0.027 });
        await click(POINTS.battlePlay);
        // Загрузка боя в браузере занимает секунд пятнадцать: ждём терпеливо, иначе следующий клик
        // отменит её и сценарий решит, что войти не удалось.
        for (let wait = 0; wait < 8 && !(await inBattle()); wait++) await sleep(3000);
        // Для битв с нестандартными настройками клиент спрашивает подтверждение — жмём «Войти».
        if (!(await inBattle())) { await click(POINTS.confirmJoin); await sleep(6000); }
        if (!(await inBattle())) { await click(POINTS.confirmJoin); await sleep(3000); }
    }
    await sleep(6000);

    if (!(await inBattle())) {
        await die('в бой войти не удалось: ' + JSON.stringify(await stats()));
    }

    // В бою должны быть боты — иначе проверять нечего. Достоверный источник — журнал сервера:
    // с холста ники не считать, а вход в «пустую» битву тест бы молча зачёл.
    const joined = joinedBattle();
    if (!joined) await die('в журнале сервера нет свежей записи о нашем входе в бой');
    if (joined.bots.length === 0) await die(`бой ${joined.battleId} без ботов, проверять нечего`);
    console.log(`--- бой ${joined.battleId}, ботов в нём: ${joined.bots.length} (${joined.bots.join(', ')})`);
    const battleLogFrom = lines.length;

    // Команды доступны с локального адреса без прав модератора (см. command.service.ts).
    const chat = async (text, settle = 3000) => {
        await page.keyboard.press('Enter');
        await sleep(400);
        await page.keyboard.type(text, { delay: 20 });
        await page.keyboard.press('Enter');
        await sleep(settle);
    };
    const setBots = async (count) => {
        await chat('/bots ' + count);
        console.log('--- запросили ботов в бою: ' + count + ' (' + new Date().toTimeString().slice(0, 8) + ')');
    };
    if (SET_BOTS !== null) await setBots(SET_BOTS[0]);

    const startShot = await snap('spawn');
    console.log('--- появились в бою: ' + (startShot ? path.basename(startShot) : 'кадр не снят'));

    let crash = failures();
    if (crash.length > 0) {
        console.log('--- ошибки уже на входе:');
        crash.slice(0, 5).forEach((f) => console.log('    [' + f.rule + '] ' + f.line.slice(0, 220)));
        await die(`${crash.length} ошибок клиента на входе в бой`);
    }

    // Катаемся и стреляем: план повторяется, пока не истечёт отведённое время. Между манёврами
    // снимаем кадры — по ним потом видно, как боты едут, целятся и стреляют.
    console.log(`--- играем ${PLAY_SECONDS} с`);
    const size = page.viewportSize();
    await page.mouse.move(size.width / 2, size.height / 2);

    const plan = [
        { keys: ['KeyW'], ms: 2500, label: 'fwd' },
        { keys: ['KeyW', 'KeyA'], ms: 2000, label: 'fwd-left' },
        { keys: ['KeyW'], ms: 2500, label: 'fwd2' },
        { keys: ['KeyW', 'KeyD'], ms: 2000, label: 'fwd-right' },
        { keys: ['KeyS'], ms: 1500, label: 'back' },
        { keys: ['KeyA'], ms: 1500, label: 'left' },
        { keys: ['KeyD'], ms: 1500, label: 'right' },
    ];

    const startedAt = Date.now();
    const fpsSamples = [];
    const sampleFps = async () => {
        const s = await stats();
        if (s) fpsSamples.push({ t: Math.round((Date.now() - startedAt) / 1000), fps: +(s.fps || 0).toFixed(1), draws: Math.round(s.draws || 0) });
    };

    /**
     * Ruffle показывает своё окно «Connection closed by server», когда игровой сокет оборвался, — это
     * бывает при перезапуске сервера (ts-node-dev поднимается на каждое сохранение исходников). Игра
     * при этом замирает, замеры остаются прежними, и прогон честно «доигрывает» пустоту. Ловим отдельно.
     */
    const disconnected = async () => {
        try {
            // Окно рисует сам Ruffle внутри своего shadow-root, до обычного document.body его текст
            // не доходит — заглядываем именно туда.
            return await page.evaluate(() => {
                const host = document.querySelector('#player > *');
                const text = (host && host.shadowRoot && host.shadowRoot.textContent) || '';
                return /Connection closed|соединение/i.test(text);
            });
        } catch {
            return false;
        }
    };

    let step = 0;
    let secondBotsDone = SET_BOTS === null || SET_BOTS.length < 2;
    while (Date.now() - startedAt < PLAY_SECONDS * 1000) {
        if (!secondBotsDone && Date.now() - startedAt > (PLAY_SECONDS * 1000) / 3) {
            secondBotsDone = true;
            await setBots(SET_BOTS[1]);
        }
        if (await disconnected()) await die('сервер разорвал соединение — игра замерла, проверять нечего');
        const move = plan[step % plan.length];
        if (FOLLOW) {
            const target = joined.bots[step % joined.bots.length];
            await chat('/tpto ' + target, 1500);
            // Башня (а с ней и камера) крутится клавишами Z/X — иначе бот остаётся за спиной.
            await drive(['KeyZ'], 700);
            await snap('at-' + target);
            await drive(['KeyX'], 1200);
            await snap('at-' + target + '-b');
            await sampleFps();
            step++;
            continue;
        }
        if (IDLE) { await sleep(move.ms); await snap('idle'); await sampleFps(); step++; continue; }
        await drive(move.keys, move.ms);
        // Стреляем в ту сторону, куда смотрит башня: клавиша выстрела — пробел.
        await page.keyboard.press('Space');
        await sleep(400);
        // Крутим башню мышью, чтобы кадры были с разных ракурсов и попадали боты.
        await page.mouse.move(size.width * (0.25 + 0.5 * Math.random()), size.height * (0.35 + 0.3 * Math.random()));
        await sleep(600);
        await snap(move.label);
        await sampleFps();
        step++;
    }

    // Последний кадр — с открытой таблицей результатов: по ней видно счёт и что боты в нём растут.
    await page.keyboard.down('Tab');
    await sleep(1500);
    const tabShot = await snap('scoreboard');
    await page.keyboard.up('Tab');
    console.log('--- таблица результатов: ' + (tabShot ? path.basename(tabShot) : 'кадр не снят'));

    const logFile = saveLog();
    console.log('--- полный лог: ' + logFile);
    console.log('--- FPS по ходу боя: ' + fpsSamples.map((s) => `${s.t}с:${s.fps}`).join('  '));
    if (fpsSamples.length >= 4) {
        const half = Math.floor(fpsSamples.length / 2);
        const avg = (arr) => arr.reduce((s, x) => s + x.fps, 0) / arr.length;
        console.log(`--- FPS: первая половина ${avg(fpsSamples.slice(0, half)).toFixed(1)}, вторая ${avg(fpsSamples.slice(half)).toFixed(1)}`);
        const drawsFirst = fpsSamples[0].draws;
        const drawsLast = fpsSamples[fpsSamples.length - 1].draws;
        console.log(`--- вызовов отрисовки: в начале ${drawsFirst}, в конце ${drawsLast}`);
    }

    // Время фазы enterFrame — прямой признак того, что в клиенте копятся живые объекты: рисовать
    // может быть уже нечего, а скрипты кадра всё равно занимают сотни миллисекунд. Считаем только
    // с момента появления в бою: в лобби кадр почти пустой и сравнивать не с чем.
    const phases = lines.slice(battleLogFrom)
        .map((l) => clean(l).match(/enterFrame ([0-9.]+) ms, construct ([0-9.]+) ms/))
        .filter(Boolean)
        .map((m) => ({ enter: +m[1], construct: +m[2] }));
    if (phases.length >= 4) {
        const tail = phases.slice(-5);
        const head = phases.slice(0, 5);
        const avg = (arr, key) => (arr.reduce((s, x) => s + x[key], 0) / arr.length).toFixed(1);
        console.log(`--- enterFrame: в начале ${avg(head, 'enter')} мс, в конце ${avg(tail, 'enter')} мс; ` +
                    `construct ${avg(head, 'construct')} -> ${avg(tail, 'construct')} мс`);
    }

    printReports();

    crash = failures();
    if (crash.length > 0) {
        const byRule = {};
        for (const f of crash) (byRule[f.rule] = byRule[f.rule] || []).push(f.line);
        console.log('--- ошибки клиента:');
        for (const [rule, items] of Object.entries(byRule)) {
            console.log(`    ${rule} x${items.length}`);
            items.slice(0, 3).forEach((l) => console.log('      ' + l.slice(0, 260)));
        }
        await die(`${crash.length} ошибок клиента за прогон`);
    }
    if (reports.length > 0) {
        fs.writeFileSync(path.join(__dirname, `${TAG}-reports.txt`), reports.join('\n\n----\n\n'), 'utf8');
        await die(`клиент отправил ${reports.length} баг-репортов, подробности в ${TAG}-reports.txt`);
    }

    // Уходим в лобби: иначе сервер держит нас в бою минуту, и следующий прогон попадёт по реконнекту
    // обратно в ту же битву вместо чистого входа.
    await leaveBattle();

    console.log('--- УСПЕХ: бой с ботами отыгран без ошибок клиента, кадров снято: ' + shot);
    await context.close();
})().catch((e) => {
    console.error(e);
    // Лог движка нужен ровно тогда, когда прогон сорвался, — сохраняем его в любом случае.
    console.log('--- лог: ' + saveLog());
    process.exit(1);
});
