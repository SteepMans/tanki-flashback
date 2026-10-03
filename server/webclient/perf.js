/**
 * Замер производительности в бою: на что уходит кадр и растёт ли расход со временем.
 *
 *   node webclient/perf.js                 обычная камера
 *   node webclient/perf.js --zoom          отвести камеру вверх (колесо от себя)
 *   node webclient/perf.js --profile       снять профиль процессора и напечатать топ функций
 *   node webclient/perf.js --seconds 90    длительность замера
 *
 * Печатает таблицу по секундам: такты, ActionScript, отрисовка, вызовы Stage3D и счётчики кешей.
 * Сравнивать надо ActionScript: именно он упирается в потолок, отрисовка на порядок дешевле.
 */
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright-core');

const URL = process.env.E2E_URL || 'http://localhost:9999/web/?debug=1';
// Пропускную способность печатает движок раз в секунду при включённом счётчике методов.
const HEADED = process.argv.includes('--headed');
const ZOOM = process.argv.includes('--zoom');
const PROFILE_CPU = process.argv.includes('--profile');
const SECONDS = Number((process.argv.find((a) => a.startsWith('--seconds=')) || '').split('=')[1]) || 60;
const PROFILE = path.join(__dirname, '.e2e-profile');

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
    const stats = () => page.evaluate(() => window.ruffleStats || null);
    const inBattleNow = async () => {
        const s = await stats();
        return !!s && (s.draws || 0) > 0 && (s.sceneWidth || 0) > 900;
    };

    console.log('--- открываем ' + URL);
    await page.goto(URL, { waitUntil: 'domcontentloaded' });
    for (let i = 0; i < 60 && !lines.some((l) => l.includes('Connecting to ws')); i++) await sleep(1000);
    await sleep(16000);
    for (let i = 0; i < 3; i++) await click(POINTS.closeModal);

    // --solo: свой пустой бой вместо боя с ботами. Нужен, чтобы отделить цену чужих танков:
    // клиент считает физику каждого тела в бою, а не только своего.
    if (process.argv.includes('--solo')) {
        console.log('--- создаём пустой бой');
        for (let i = 0; i < 2; i++) await click(POINTS.closeModal);
        await click(POINTS.battlesButton);
        await sleep(1500);
        await click({ x: 0.629, y: 0.792 });   // «Создать»
        await sleep(2500);
        await click({ x: 0.962, y: 0.792 });   // «Запустить»
        await sleep(4000);
        await click({ x: 0.952, y: 0.782 });   // «Играть» в панели своего боя
        await sleep(9000);
        if (!(await inBattleNow())) {
            console.log('--- ПРОВАЛ: свой бой создать/войти не удалось');
            await page.screenshot({ path: path.join(__dirname, 'perf-nosolo.png') });
            await context.close();
            process.exit(1);
        }
    }

    // --lobby: мерить прямо в лобби. Сцена там одна и та же от запуска к запуску, поэтому шум
    // на порядок меньше, чем в бою, где всё зависит от точки возрождения.
    const lobbyOnly = process.argv.includes('--lobby');
    if (!lobbyOnly) console.log('--- заходим в бой');
    if (!lobbyOnly) for (let i = 0; i < 2; i++) await click(POINTS.closeModal);
    if (!lobbyOnly && !(await inBattleNow())) await click(POINTS.battlesButton);
    for (let row = 0; !lobbyOnly && row < 4 && !(await inBattleNow()); row++) {
        await click({ x: POINTS.battleRow.x, y: POINTS.battleRow.y + row * 0.027 });
        await click(POINTS.battlePlay);
        await sleep(5000);
        if (!(await inBattleNow())) { await click(POINTS.confirmJoin); await sleep(4000); }
        if (!(await inBattleNow())) { await click(POINTS.confirmJoin); await sleep(1500); }
    }
    if (!lobbyOnly) await sleep(6000);
    if (!lobbyOnly && !(await inBattleNow())) {
        console.log('--- ПРОВАЛ: в бой войти не удалось: ' + JSON.stringify(await stats()));
        await page.screenshot({ path: path.join(__dirname, 'perf-nobattle.png') });
        fs.writeFileSync(path.join(__dirname, 'perf.log'), lines.join('\n'), 'utf8');
        await context.close();
        process.exit(1);
    }

    // Раскрываем ручные настройки качества: с включённым «авто» они спрятаны.
    if (process.argv.includes('--lowq')) {
        console.log('--- открываем настройки графики');
        await click({ x: 0.912, y: 0.018 });   // шестерёнка
        await sleep(1500);
        await click({ x: 0.367, y: 0.119 });   // вкладка «Графика»
        await sleep(1200);
        await click({ x: 0.278, y: 0.287 });   // «Автоматическая настройка качества графики»
        await sleep(1500);
        await page.screenshot({ path: path.join(__dirname, 'perf-graphics.png') });
        for (const point of (process.env.LOWQ_CLICKS || '').split(';').filter(Boolean)) {
            const [x, y] = point.split(',').map(Number);
            await click({ x, y });
        }
        await sleep(800);
        await page.screenshot({ path: path.join(__dirname, 'perf-graphics-off.png') });
        await click({ x: 0.705, y: 0.674 });   // «Закрыть»
        await sleep(1500);
    }

    if (ZOOM) {
        console.log('--- отводим камеру вверх');
        const size = page.viewportSize();
        await page.mouse.move(size.width / 2, size.height / 2);
        for (let i = 0; i < 12; i++) { await page.mouse.wheel(0, 240); await sleep(200); }
        await sleep(1500);
    }

    // Счётчик инструкций по методам игры: движок печатает верхушку раз в секунду.
    if (process.argv.includes('--methods')) {
        await page.keyboard.press('F9');
        await page.evaluate(() => { window.ruffleTraceMethods = true; });
        console.log('--- включён счётчик горячих методов');
    }
    // Гистограмма по видам инструкций: сама по себе замедляет игру, поэтому отдельным флагом.
    if (process.argv.includes('--ops')) {
        await page.evaluate(() => { window.ruffleTraceMethods = true; window.ruffleTraceOps = true; });
        console.log('--- включена гистограмма инструкций');
    }

    // Сравнение «с ботами / без ботов»: клиент считает физику и интерполяцию каждого танка,
    // поэтому их число напрямую бьёт по кадру.
    if (process.argv.includes('--nobots')) {
        console.log('--- убираем ботов из боя');
        await page.keyboard.press('Enter');
        await sleep(400);
        await page.keyboard.type('/bots 0', { delay: 20 });
        await page.keyboard.press('Enter');
        await sleep(6000);
    }

    console.log('--- замер ' + SECONDS + ' с (танк едет, чтобы сцена менялась)');
    console.log('  сек   такты  ActionScript  отрисовка   худший кадр  просадок>33мс  вызовов  пайплайнов');
    const rows = [];
    for (let sec = 1; sec <= SECONDS; sec++) {
        // Немного ездим: неподвижная сцена не показывает реальную нагрузку.
        if (sec % 4 === 0 && !process.argv.includes('--still')) {
            await page.keyboard.down('KeyW');
            await sleep(600);
            await page.keyboard.up('KeyW');
            await sleep(400);
        } else {
            await sleep(1000);
        }
        const s = await stats();
        if (!s) continue;
        rows.push(s);
        if (sec % 5 === 0 || sec === 1) {
            console.log('  ' + String(sec).padStart(3) + '   ' +
                (s.ticks || 0).toFixed(1).padStart(5) + '   ' +
                (s.asMs || 0).toFixed(1).padStart(9) + ' мс' + '   ' +
                (s.renderMs || 0).toFixed(1).padStart(6) + ' мс' + '   ' +
                (s.worstMs || 0).toFixed(1).padStart(8) + ' мс' + '   ' +
                String(s.slowFrames || 0).padStart(10) + '  ' +
                String(Math.round(s.draws || 0)).padStart(7) + '  ' +
                String(s.pipelines || 0).padStart(9));
        }
    }

    // Вторая половина замера — уже без ботов: сравнение внутри одного прогона надёжнее двух
    // отдельных, потому что карта, место и время суток остаются теми же.
    if (process.argv.includes('--botsab')) {
        const command = process.argv.includes('--addbots') ? '/bots 6' : '/bots 0';
        console.log('--- ' + command + ' и меряем ещё раз');
        await page.keyboard.press('Enter');
        await sleep(400);
        await page.keyboard.type(command, { delay: 20 });
        await page.keyboard.press('Enter');
        await sleep(8000);

        const after = [];
        for (let sec = 1; sec <= SECONDS; sec++) {
            if (sec % 4 === 0 && !process.argv.includes('--still')) {
                await page.keyboard.down('KeyW');
                await sleep(600);
                await page.keyboard.up('KeyW');
                await sleep(400);
            } else {
                await sleep(1000);
            }
            const s = await stats();
            if (s) after.push(s);
        }
        const mean = (list, key) => list.reduce((a, r) => a + (r[key] || 0), 0) / (list.length || 1);
        console.log('--- до команды:  ActionScript ' + mean(rows, 'asMs').toFixed(1) + ' мс, такты ' +
                    mean(rows, 'ticks').toFixed(1) + ', вызовов отрисовки ' + mean(rows, 'draws').toFixed(0));
        console.log('--- после:       ActionScript ' + mean(after, 'asMs').toFixed(1) + ' мс, такты ' +
                    mean(after, 'ticks').toFixed(1) + ', вызовов отрисовки ' + mean(after, 'draws').toFixed(0));
    }

    const avg = (key, from, to) => {
        const part = rows.slice(from, to).map((r) => r[key] || 0);
        return part.reduce((a, b) => a + b, 0) / (part.length || 1);
    };
    // Стабильность важнее среднего: считаем, сколько секунд содержали кадр дольше 33 мс
    // (это провал ниже 30 FPS) и каким был худший кадр за прогон.
    const worst = Math.max(...rows.map((r) => r.worstMs || 0));
    const slow = rows.reduce((sum, r) => sum + (r.slowFrames || 0), 0);
    const frames = rows.reduce((sum, r) => sum + (r.ticks || 0), 0);
    console.log('--- стабильность: худший кадр ' + worst.toFixed(1) + ' мс, кадров дольше 33 мс — ' +
                slow + ' из ' + Math.round(frames) + ' (' + (100 * slow / (frames || 1)).toFixed(1) + '%)');

    const half = Math.floor(rows.length / 2);
    console.log('--- первая половина замера: ActionScript ' + avg('asMs', 0, half).toFixed(1) +
                ' мс, такты ' + avg('ticks', 0, half).toFixed(1));
    console.log('--- вторая половина замера: ActionScript ' + avg('asMs', half).toFixed(1) +
                ' мс, такты ' + avg('ticks', half).toFixed(1));

    if (PROFILE_CPU) {
        console.log('--- профиль процессора, 10 с');
        const cdp = await page.context().newCDPSession(page);
        await cdp.send('Profiler.enable');
        await cdp.send('Profiler.setSamplingInterval', { interval: 200 });
        await cdp.send('Profiler.start');
        await sleep(10000);
        const { profile } = await cdp.send('Profiler.stop');
        const self = new Map();
        const byId = new Map(profile.nodes.map((n) => [n.id, n]));
        for (const id of profile.samples) {
            const node = byId.get(id);
            if (!node) continue;
            const f = node.callFrame;
            const name = (f.functionName || '(аноним)') + '  ' + (f.url || '').replace(/^.*\//, '');
            self.set(name, (self.get(name) || 0) + 1);
        }
        const total = profile.samples.length;
        [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25)
            .forEach(([name, n]) => console.log('   ' + (100 * n / total).toFixed(1).padStart(5) + '%  ' + name));
    }

    const throughput = lines.filter((l) => /AVM2 throughput/.test(l));
    if (throughput.length) {
        const nums = throughput.map((l) => Number((l.match(/([\d.]+) ops per ms/) || [])[1]) || 0)
            .filter((n) => n > 0).sort((a, b) => a - b);
        if (nums.length) {
            console.log('--- пропускная способность интерпретатора: медиана ' +
                Math.round(nums[Math.floor(nums.length / 2)]) + ' инструкций на мс скриптового времени' +
                ' (замеров ' + nums.length + ')');
        }
    }
    if (process.argv.includes('--methods') || process.argv.includes('--ops')) {
        // Список горячих методов движок кладёт прямо на страницу — читаем оттуда, а не из лога.
        const hot = await page.evaluate(() => (window.ruffleStats || {}).hotMethods || []);
        const ops = await page.evaluate(() => (window.ruffleStats || {}).opsPerSecond || 0);
        if (hot.length) {
            console.log('--- горячие методы игры (' + Math.round(ops / 1000) + ' тыс. инструкций/с):');
            hot.forEach(([name, methodOps, calls]) => console.log(
                '   ' + (100 * methodOps / (ops || 1)).toFixed(1).padStart(5) + '%  ' +
                String(Math.round(calls)).padStart(7) + ' вызовов/с  ' + name));
        } else {
            console.log('--- список горячих методов пуст (профилировщик не развёрнут?)');
        }
    }

    // Снимок с профилировщиком: по нему видно и панель, и что она показывает.
    await page.screenshot({ path: path.join(__dirname, 'perf-overlay.png') });
    fs.writeFileSync(path.join(__dirname, 'perf.log'), lines.join('\n'), 'utf8');
    await context.close();
})().catch((e) => { console.error(e); process.exit(1); });
