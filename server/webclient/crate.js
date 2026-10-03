/**
 * Проверка ящиков припасов: сбрасывает их в бою и ищет на кадре чёрные пятна.
 *
 *   node webclient/crate.js            обычный прогон
 *   node webclient/crate.js --headed   с видимым окном
 *
 * Ящик — коробка с текстурой; если текстура не доехала, он рисуется сплошной чёрной фигурой.
 * Тест ищет на снимках связные почти чёрные области размером с ящик и падает, если находит.
 * Небо ночных карт тоже тёмное, поэтому верхняя часть кадра и панели интерфейса исключены.
 */
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright-core');

// Тесты открывают стенд в режиме отладки: снизу полоса логов, поверх боя счётчик кадров.
// Заодно это фиксирует раскладку окна, по которой выверены координаты кликов.
const URL = process.env.E2E_URL || 'http://localhost:9999/web/?debug=1&log=debug';
const HEADED = process.argv.includes('--headed');
const PROFILE = path.join(__dirname, '.e2e-profile');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const POINTS = {
    closeModal: { x: 0.617, y: 0.637 },
    battlesButton: { x: 0.798, y: 0.018 },
    battleRow: { x: 0.50, y: 0.10 },
    battlePlay: { x: 0.71, y: 0.78 },
    confirmJoin: { x: 0.491, y: 0.432 },   // «Войти» в предупреждении о нестандартных правилах
};

// Область поиска: без неба сверху и без интерфейса снизу.
const AREA = { x0: 0.06, x1: 0.95, y0: 0.25, y1: 0.68 };
// Панель подсказок по клавишам внизу по центру — тёмная, её надо пропускать.
const HINTS = { x0: 0.36, x1: 0.66, y0: 0.64, y1: 0.82 };
const DARK = 26;        // сумма каналов, ниже которой пиксель считается чёрным
const MIN_BLOB = 700;   // ящик в кадре занимает тысячи пикселей; меньше — тень, окно, щель
const MAX_SIDE = 300;   // ящик компактный; крупнее — это ночное небо или тень от стены
const MIN_FILL = 0.4;   // и достаточно плотный: доля чёрного в его габаритном прямоугольнике

/**
 * Ищет самое большое чёрное пятно, похожее на ящик припасов.
 *
 * Ночное небо тоже почти чёрное, поэтому пятна, упирающиеся в верх области поиска, а также
 * слишком большие и рыхлые, отбрасываются.
 */
function findBlackCrate(png) {
    const { width, height, data } = png;
    const x0 = Math.round(width * AREA.x0), x1 = Math.round(width * AREA.x1);
    const y0 = Math.round(height * AREA.y0), y1 = Math.round(height * AREA.y1);

    const hx0 = Math.round(width * HINTS.x0), hx1 = Math.round(width * HINTS.x1);
    const hy0 = Math.round(height * HINTS.y0), hy1 = Math.round(height * HINTS.y1);

    const dark = (x, y) => {
        if (x >= hx0 && x < hx1 && y >= hy0 && y < hy1) return false;
        const i = (y * width + x) * 4;
        return data[i] + data[i + 1] + data[i + 2] < DARK;
    };

    const seen = new Uint8Array(width * height);
    let best = { size: 0, x: 0, y: 0 };

    for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
            if (seen[y * width + x] || !dark(x, y)) continue;

            const queue = [[x, y]];
            seen[y * width + x] = 1;
            let size = 0;
            let minX = x, maxX = x, minY = y, maxY = y;
            while (queue.length) {
                const [cx, cy] = queue.pop();
                size++;
                if (cx < minX) minX = cx;
                if (cx > maxX) maxX = cx;
                if (cy < minY) minY = cy;
                if (cy > maxY) maxY = cy;
                for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
                    const nx = cx + dx, ny = cy + dy;
                    if (nx < x0 || nx >= x1 || ny < y0 || ny >= y1) continue;
                    if (seen[ny * width + nx] || !dark(nx, ny)) continue;
                    seen[ny * width + nx] = 1;
                    queue.push([nx, ny]);
                }
            }

            const boxWidth = maxX - minX + 1;
            const boxHeight = maxY - minY + 1;
            const touchesSky = minY <= y0;
            const fill = size / (boxWidth * boxHeight);

            if (touchesSky || boxWidth > MAX_SIDE || boxHeight > MAX_SIDE || fill < MIN_FILL) {
                continue;
            }

            if (size > best.size) {
                best = { size, x: Math.round((minX + maxX) / 2), y: Math.round((minY + maxY) / 2) };
            }
        }
    }
    return best;
}

(async () => {
    const { PNG } = require('pngjs');
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
    const drive = async (keys, ms) => {
        for (const k of keys) await page.keyboard.down(k);
        await sleep(ms);
        for (const k of keys) await page.keyboard.up(k);
    };
    const chat = async (text) => {
        await page.keyboard.press('Enter');
        await sleep(400);
        await page.keyboard.type(text, { delay: 20 });
        await page.keyboard.press('Enter');
        await sleep(700);
    };

    console.log('--- открываем ' + URL);
    await page.goto(URL, { waitUntil: 'domcontentloaded' });
    for (let i = 0; i < 60 && !lines.some((l) => l.includes('Connecting to ws')); i++) await sleep(1000);
    await sleep(16000);
    for (let i = 0; i < 3; i++) await click(POINTS.closeModal);

    const inBattleNow = async () => {
        const s = await page.evaluate(() => window.ruffleStats || null);
        return !!s && (s.draws || 0) > 0 && (s.sceneWidth || 0) > 900;
    };
    // Падение движка тест обязан замечать: на экране ошибки чёрных пятен нет, и проверка
    // «проходила» бы вхолостую. Лог пишем при любом исходе, иначе разбирать нечего.
    const saveLog = () => fs.writeFileSync(path.join(__dirname, 'crate.log'), lines.join('\n'), 'utf8');
    const crashed = () => lines.some((l) => /panicked|Что-то пошло не так/.test(l));

    console.log('--- заходим в бой');
    // Окно приглашений всплывает и после входа, перехватывая клики по верхней панели.
    for (let i = 0; i < 2; i++) await click(POINTS.closeModal);
    await click(POINTS.battlesButton);

    // Первой в списке может стоять битва, куда наш танк не пускают (рейтинговый формат с
    // ограничением снаряжения), поэтому перебираем несколько строк списка.
    for (let row = 0; row < 4 && !(await inBattleNow()); row++) {
        await click({ x: POINTS.battleRow.x, y: POINTS.battleRow.y + row * 0.027 });
        await click(POINTS.battlePlay);
        await sleep(5000);

        // Для битв с нестандартными настройками клиент спрашивает подтверждение — жмём «Войти».
        if (!(await inBattleNow())) {
            await click(POINTS.confirmJoin);
            await sleep(4000);
        }
        // Окно «сюда нельзя» закрываем и пробуем следующую строку.
        if (!(await inBattleNow())) {
            await click(POINTS.confirmJoin);
            await sleep(1500);
        }
    }
    await sleep(6000);

    // Без боя проверять нечего: считаем это провалом, иначе тест «проходит» вхолостую.
    if (!(await inBattleNow())) {
        const stats = await page.evaluate(() => window.ruffleStats || null);
        console.log('--- ПРОВАЛ: в бой войти не удалось, проверять нечего: ' + JSON.stringify(stats));
        saveLog();
        await page.screenshot({ path: path.join(__dirname, 'crate-no-battle.png') });
        await context.close();
        process.exit(1);
    }

    if (crashed()) {
        console.log('--- ПРОВАЛ: движок упал, см. webclient/crate.log');
        saveLog();
        await page.screenshot({ path: path.join(__dirname, 'crate-crash.png') });
        await context.close();
        process.exit(1);
    }

    // Ящики раскладываются по всей карте и лежат, пока их не подберут, — катаемся и снимаем.
    for (const type of ['armor', 'damage', 'nitro', 'health']) {
        await chat('/bonus ' + type + ' 12');
    }
    await sleep(5000);

    let worst = { size: 0 };
    let shot = 0;
    for (const [keys, ms] of [[['KeyW'], 2500], [['KeyW', 'KeyA'], 2500], [['KeyW'], 2500],
                              [['KeyW', 'KeyD'], 2500], [['KeyW'], 2500], [['KeyA'], 1500],
                              [['KeyW'], 2500], [['KeyD'], 1500]]) {
        await drive(keys, ms);
        await sleep(400);

        const file = path.join(__dirname, `crate-${++shot}.png`);
        await page.screenshot({ path: file });
        const blob = findBlackCrate(PNG.sync.read(fs.readFileSync(file)));
        if (blob.size > worst.size) worst = { ...blob, file };
        console.log(`    кадр ${shot}: чёрных ящиков: ${blob.size ? 'да, ' + blob.size + ' пикс.' : 'нет'}`);
    }

    fs.writeFileSync(path.join(__dirname, 'crate.log'), lines.join('\n'), 'utf8');

    if (crashed()) {
        console.log('--- ПРОВАЛ: движок упал во время прогона, см. webclient/crate.log');
        saveLog();
        await context.close();
        process.exit(1);
    }

    if (worst.size >= MIN_BLOB) {
        console.log(`--- ПРОВАЛ: чёрное пятно ${worst.size} пикс. в точке (${worst.x}, ${worst.y}), ` +
                    `см. ${path.basename(worst.file)}`);
        await context.close();
        process.exit(1);
    }

    console.log(`--- УСПЕХ: чёрных пятен нет (максимум ${worst.size} пикс. при пороге ${MIN_BLOB})`);
    await context.close();
})().catch((e) => { console.error(e); process.exit(1); });
