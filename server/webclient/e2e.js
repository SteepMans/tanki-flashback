/**
 * Автотест браузерного клиента: поднимает Chrome, логинится, открывает гараж и выводит
 * трассировку из консоли. Нужен, чтобы проверять патчи library.swf без ручных прогонов.
 *
 *   node webclient/e2e.js              вход + гараж, печать строк [T] и ошибок
 *   node webclient/e2e.js --headed     то же, но с видимым окном (отладка координат)
 *   node webclient/e2e.js --shot       дополнительно сохранить скриншот в webclient/e2e.png
 *
 * Профиль браузера сохраняется в webclient/.e2e-profile, поэтому SharedObject с аккаунтом
 * переживает перезапуски: со второго раза клиент логинится сам и шаг ввода пропускается.
 *
 * Требуется установленный Chrome и запущенные игровой сервер + websockify (см. README.md).
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
const SHOT = process.argv.includes('--shot');
const PROFILE = path.join(__dirname, '.e2e-profile');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Ruffle рисует игру в canvas, DOM-селекторов внутри нет — жать приходится по координатам.
// Значения в долях от размера окна, чтобы не зависеть от разрешения.
const POINTS = {
    loginTab: { x: 0.506, y: 0.21 },   // ссылка "Авторизуйтесь!" на экране регистрации
    loginField: { x: 0.525, y: 0.377 }, // поле "Имя или email" формы входа
    passField: { x: 0.525, y: 0.418 },
    remember: { x: 0.459, y: 0.473 },   // галочка "Запомнить" (чтобы следующий прогон вошёл сам)
    submit: { x: 0.570, y: 0.473 },     // кнопка "Играть"
    closeModal: { x: 0.617, y: 0.637 },  // "Закрыть" во всплывающем окне приглашений после входа
    battlesButton: { x: 0.798, y: 0.018 }, // кнопка "Битвы" в верхней панели
    battleRow: { x: 0.50, y: 0.10 },      // первая строка списка битв
    battlePlay: { x: 0.71, y: 0.78 },     // кнопка "Играть" в панели информации о битве
    garageButton: { x: 0.854, y: 0.018 }, // кнопка "Гараж" в верхней панели
};

let step = 0;
let shotSeq = 0;
async function click(page, point, label) {
    const size = page.viewportSize();
    await page.mouse.click(Math.round(size.width * point.x), Math.round(size.height * point.y));
    await sleep(600);
    if (SHOT && label) {
        await page.screenshot({ path: path.join(__dirname, `e2e-${++step}-${label}.png`) });
    }
}

(async () => {
    const lines = [];
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
    page.on('console', (msg) => {
        const text = msg.text();
        // Шум MP3-декодера в диагностике не нужен и раздувает лог в разы.
        if (/symphonia|main_data_begin|estimating duration from bitrate/.test(text)) return;
        lines.push(text);
        if (/\[T\]|ERROR|panicked|Error #/.test(text)) {
            console.log(text.replace(/%c/g, '').replace(/ color:[^;]*;?/g, '').trim());
        }
    });
    page.on('pageerror', (err) => console.log('PAGEERROR ' + err.message));

    // Заливки текстур логируем с самого начала: их немного, а гонка загрузки картинок случается
    // как раз на старте.
    await page.addInitScript(() => { window.ruffleTraceUploads = true; });

    console.log('--- открываем ' + URL);
    await page.goto(URL, { waitUntil: 'domcontentloaded' });

    // Ждём, пока игра догрузится: признак — клиент открыл сокет (в логе Ruffle есть "Connecting to ws").
    for (let i = 0; i < 60 && !lines.some((l) => l.includes('Connecting to ws')); i++) await sleep(1000);
    console.log('--- сокет открыт, ждём экран входа');
    await sleep(14000);

    // Если аккаунт уже сохранён в профиле, клиент входит сам и форма не появляется.
    const alreadyIn = lines.some((l) => l.includes('[T]'));
    if (!alreadyIn) {
        console.log('--- вводим ' + LOGIN);
        // Первый клик по странице уходит на фокус canvas и игрой не виден — жмём по пустому месту.
        await click(page, { x: 0.08, y: 0.5 });
        await click(page, POINTS.loginTab, 'login-tab');
        await click(page, POINTS.loginField, 'login-field');
        await page.keyboard.type(LOGIN, { delay: 60 });
        await click(page, POINTS.passField, 'pass-field');
        await page.keyboard.type(PASSWORD, { delay: 60 });
        await click(page, POINTS.remember, 'remember');
        await click(page, POINTS.submit, 'submit');
        await sleep(15000);
    }

    // Игра показывает после входа то окно приглашений, то баннер миссий — они перекрывают панель.
    // Escape закрывает любое, клик по "Закрыть" оставлен как запасной вариант.
    for (let i = 0; i < 3; i++) {
        await page.keyboard.press('Escape');
        await sleep(400);
    }
    await click(page, POINTS.closeModal, 'close-modal');
    await sleep(800);

    console.log('--- жмём Гараж');
    const before = lines.length;
    // Признак открытого гаража — появление превью танка: движок начинает рисовать сцену Stage3D
    // и счётчик вызовов отрисовки становится ненулевым.
    // Модель танка едет с ресурсного сервера и появляется не сразу, поэтому кнопку жмём редко:
    // каждый клик по «Гаражу» перезапускает загрузку превью, и частые повторы не давали ей
    // дойти до конца — тест «не открывал» уже открытый гараж.
    let opened = false;
    for (let attempt = 1; attempt <= 12 && !opened; attempt++) {
        // Escape здесь не жмём: в игре он открывает диалог выхода и ломает сценарий.
        if (attempt === 1 || attempt === 7) await click(page, POINTS.garageButton, attempt === 1 ? 'garage' : null);
        await sleep(4000);
        const stats = await page.evaluate(() => window.ruffleStats || null);
        opened = !!stats && (stats.draws || 0) > 0;
        if (!opened) console.log('--- попытка ' + attempt + ': гараж ещё не открылся');
    }
    console.log(opened ? '--- гараж открыт' : '--- гараж открыть не удалось');

    for (const t of [3000, 2000, 2000, 2000, 2000, 4000]) {
        await sleep(t);
        if (SHOT) await page.screenshot({ path: path.join(__dirname, `e2e-t${++shotSeq}.png`) });
    }

    const traced = lines.slice(before)
        .filter((l) => /\[T\]/.test(l))
        .map((l) => (l.match(/\[T\][^\s]*\s*([A-Za-z]+(?: EXIT)?)/) || [, l])[1]);

    console.log('--- трассировка после клика (' + traced.length + ' строк):');
    const counts = {};
    for (const t of traced) counts[t] = (counts[t] || 0) + 1;
    for (const [k, v] of Object.entries(counts)) console.log('   ' + k + ' × ' + v);

    // Второй сценарий: заходим в бой — там тот же 3D-движок, что и в превью гаража.
    if (process.argv.includes('--battle')) {
        console.log('--- идём в бой');
        // Окно приглашений может всплыть повторно и перехватить клики по панели.
        for (let i = 0; i < 2; i++) {
            await click(page, POINTS.closeModal);
            await sleep(500);
        }
        await click(page, POINTS.battlesButton, 'battles');
        await sleep(2500);
        await click(page, POINTS.battleRow, 'battle-row');
        await sleep(2000);
        await click(page, POINTS.battlePlay, 'battle-play');
        for (const t of [5000, 5000, 5000, 5000, 5000]) {
            await sleep(t);
            if (SHOT) await page.screenshot({ path: path.join(__dirname, `e2e-b${++shotSeq}.png`) });
        }

        // Припасы: сбрасываем ящики рядом с танком и смотрим, как они нарисованы (пользователь
        // видел их чёрными). Команда доступна с локального адреса без прав модератора.
        if (process.argv.includes('--bonus')) {
            // Разбор вызовов отрисовки: интересует, с какими текстурами рисуется ящик припасов.
            await page.evaluate(() => { window.ruffleTraceDraws = true; });
            if (process.argv.includes('--nocache')) {
                await page.evaluate(() => { window.ruffleNoCache = true; });
                console.log('--- кеши пайплайнов выключены');
            }
            // Сбрасываем много ящиков по всей карте (они лежат до подбора) и катаемся,
            // снимая кадры: так хотя бы часть попадёт в поле зрения камеры.
            for (const type of ['armor', 'damage', 'nitro', 'health']) {
                await page.keyboard.press('Enter');
                await sleep(400);
                await page.keyboard.type('/bonus ' + type + ' 12', { delay: 20 });
                await page.keyboard.press('Enter');
                await sleep(700);
            }
            await sleep(4000);

            let shot = 0;
            const drive = async (keys, ms) => {
                for (const k of keys) await page.keyboard.down(k);
                await sleep(ms);
                for (const k of keys) await page.keyboard.up(k);
            };

            for (const [keys, ms] of [[['KeyW'], 2500], [['KeyW', 'KeyA'], 2500],
                                      [['KeyW'], 2500], [['KeyW', 'KeyD'], 2500],
                                      [['KeyW'], 2500], [['KeyA'], 1500],
                                      [['KeyW'], 2500], [['KeyD'], 1500]]) {
                await drive(keys, ms);
                if (SHOT) await page.screenshot({ path: path.join(__dirname, `e2e-drive-${++shot}.png`) });
                await sleep(300);
                if (SHOT) await page.screenshot({ path: path.join(__dirname, `e2e-drive-${++shot}.png`) });
            }

            console.log('--- припасы сброшены');
        }

        // Русская раскладка: браузер шлёт те же физические клавиши, но символы кириллицы.
        // Flash в этом случае отдаёт игре код клавиши (87 для W), поэтому управление работает
        // на любой раскладке — проверяем, что и здесь так.
        console.log('--- проверяем русскую раскладку');
        const beforeCyrillic = lines.length;
        const cdp = await page.context().newCDPSession(page);
        const RU = [
            { code: 'KeyW', key: 'ц', vk: 87 },
            { code: 'KeyA', key: 'ф', vk: 65 },
            { code: 'KeyS', key: 'ы', vk: 83 },
            { code: 'KeyD', key: 'в', vk: 68 },
            { code: 'KeyR', key: 'к', vk: 82 },
        ];
        for (const k of RU) {
            for (const type of ['keyDown', 'keyUp']) {
                await cdp.send('Input.dispatchKeyEvent', {
                    type,
                    code: k.code,
                    key: k.key,
                    text: type === 'keyDown' ? k.key : undefined,
                    windowsVirtualKeyCode: k.vk,
                    nativeVirtualKeyCode: k.vk,
                });
                await sleep(150);
            }
            await sleep(200);
        }
        await sleep(1500);
        const cyrillicErrors = lines.slice(beforeCyrillic).filter((l) => /Error #|ERROR/.test(l));
        console.log('--- ошибок на русской раскладке: ' + cyrillicErrors.length);
        cyrillicErrors.slice(0, 2).forEach((l) => console.log('    ' +
            l.replace(/%c/g, '').replace(/ color:[^;]*;?/g, '').trim().slice(0, 200)));

        // Управление: клиент должен принимать клавиши движения и стрельбы без ошибок.
        console.log('--- проверяем управление');
        const before = lines.length;
        for (const key of ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space', 'ShiftLeft', 'ShiftRight',
                           'ControlLeft', 'ControlRight', 'AltLeft', 'Numpad1', 'Numpad2',
                           'ArrowUp', 'ArrowDown', 'Digit1', 'Digit2', 'Tab', 'KeyR', 'KeyF']) {
            await page.keyboard.down(key);
            await sleep(250);
            await page.keyboard.up(key);
            await sleep(200);
        }

        // Мышь: у клиента свои коды для её кнопок, они как раз выходят за обычный диапазон.
        const size = page.viewportSize();
        await page.mouse.move(size.width / 2, size.height / 2);
        for (const button of ['left', 'right', 'middle']) {
            await page.mouse.down({ button });
            await sleep(400);
            await page.mouse.up({ button });
            await sleep(200);
        }
        await page.mouse.wheel(0, 200);
        await sleep(600);
        await sleep(1500);
        const keyErrors = lines.slice(before).filter((l) => /Error #|ERROR/.test(l));
        console.log('--- ошибок при нажатиях: ' + keyErrors.length);
        keyErrors.slice(0, 3).forEach((l) => console.log('    ' +
            l.replace(/%c/g, '').replace(/ color:[^;]*;?/g, '').trim().slice(0, 220)));
        if (SHOT) await page.screenshot({ path: path.join(__dirname, 'e2e-keys.png') });

        // Выход из битвы: Escape открывает диалог, «Выйти» возвращает в лобби.
        console.log('--- выходим из битвы');
        const beforeExit = lines.length;
        await page.keyboard.press('Escape');
        await sleep(1500);
        if (SHOT) await page.screenshot({ path: path.join(__dirname, 'e2e-exit-dialog.png') });
        await click(page, { x: 0.4625, y: 0.4222 });  // кнопка «Да» в диалоге выхода
        await sleep(4000);
        if (SHOT) await page.screenshot({ path: path.join(__dirname, 'e2e-after-exit.png') });
        // После выхода обработчики битвы должны сняться: нажатия в лобби не должны падать.
        const afterExit = lines.length;
        for (const key of ['KeyW', 'KeyD', 'Space', 'ShiftLeft']) {
            await page.keyboard.down(key);
            await sleep(200);
            await page.keyboard.up(key);
        }
        await sleep(1200);
        const lobbyErrors = lines.slice(afterExit).filter((l) => /Error #|ERROR/.test(l));
        console.log('--- ошибок при нажатиях в лобби: ' + lobbyErrors.length);
        lobbyErrors.slice(0, 3).forEach((l) => console.log('    ' +
            l.replace(/%c/g, '').replace(/ color:[^;]*;?/g, '').trim().slice(0, 220)));

        // Возвращаемся в бой ещё раз: повторный вход — типичный сценарий, где всплывает мусор
        // от прошлой битвы.
        console.log('--- заходим в бой второй раз');
        await click(page, POINTS.battleRow);
        await sleep(1500);
        await click(page, POINTS.battlePlay);
        await sleep(12000);
        const second = lines.length;
        for (const key of ['KeyW', 'KeyA', 'Space']) {
            await page.keyboard.down(key);
            await sleep(250);
            await page.keyboard.up(key);
        }
        await sleep(1500);
        if (SHOT) await page.screenshot({ path: path.join(__dirname, 'e2e-second-battle.png') });
        const secondErrors = lines.slice(second).filter((l) => /Error #|ERROR/.test(l));
        console.log('--- ошибок во второй битве: ' + secondErrors.length);
        secondErrors.slice(0, 3).forEach((l) => console.log('    ' +
            l.replace(/%c/g, '').replace(/ color:[^;]*;?/g, '').trim().slice(0, 220)));

        const exitErrors = lines.slice(beforeExit).filter((l) => /Error #|ERROR/.test(l));
        console.log('--- ошибок при выходе: ' + exitErrors.length);
        exitErrors.slice(0, 3).forEach((l) => console.log('    ' +
            l.replace(/%c/g, '').replace(/ color:[^;]*;?/g, '').trim().slice(0, 220)));

        // Профилирование: собираем сэмплы процессора и печатаем самые дорогие функции.
        // Нужно, чтобы понимать, на что уходит кадр, а не гадать по общему времени.
        if (process.argv.includes('--profile')) {
            const cdp = await page.context().newCDPSession(page);
            await cdp.send('Profiler.enable');
            await cdp.send('Profiler.setSamplingInterval', { interval: 200 });
            await cdp.send('Profiler.start');
            await sleep(8000);
            const { profile } = await cdp.send('Profiler.stop');

            const self = new Map();
            const byId = new Map(profile.nodes.map((n) => [n.id, n]));
            const total = profile.samples.length;
            for (const id of profile.samples) {
                const node = byId.get(id);
                if (!node) continue;
                const f = node.callFrame;
                const name = (f.functionName || '(аноним)') + '  ' +
                    (f.url || '').replace(/^.*\//, '') + (f.lineNumber >= 0 ? ':' + f.lineNumber : '');
                self.set(name, (self.get(name) || 0) + 1);
            }
            console.log('--- профиль: ' + total + ' сэмплов');
            [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25)
                .forEach(([name, n]) => console.log('   ' + (100 * n / total).toFixed(1).padStart(5) + '%  ' + name));
        }

        // Замер частоты кадров: считаем перерисовки страницы за 6 секунд. Игра ограничена 60,
        // так что интересна именно фактическая величина.
        const fps = await page.evaluate(() => new Promise((resolve) => {
            let frames = 0;
            const started = performance.now();
            const tick = () => {
                frames++;
                if (performance.now() - started < 6000) requestAnimationFrame(tick);
                else resolve(+(frames / ((performance.now() - started) / 1000)).toFixed(1));
            };
            requestAnimationFrame(tick);
        }));
        console.log('--- FPS в бою: ' + fps);
    }

    if (SHOT) {
        const file = path.join(__dirname, 'e2e.png');
        await page.screenshot({ path: file });
        console.log('--- скриншот: ' + file);
    }

    fs.writeFileSync(path.join(__dirname, 'e2e.log'), lines.join('\n'), 'utf8');
    console.log('--- полный лог: webclient/e2e.log');

    await context.close();
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
