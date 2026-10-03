/**
 * Проверка экрана настроек: открывает окно настроек, заходит на вкладку графики и снимает кадры.
 *
 *   node webclient/settings.js            обычный прогон
 *   node webclient/settings.js --headed   с видимым окном
 *
 * Нужен, чтобы видеть, что список настроек под Ruffle вообще открывается и что в нём есть
 * ползунок ограничения кадров: именно через него игрок задаёт частоту, а не через адрес страницы.
 */
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright-core');

// Без log=debug: подробный лог сам по себе съедает кадры, а тест меряет частоту.
const URL = process.env.E2E_URL || 'http://localhost:9999/web/?debug=1';
const HEADED = process.argv.includes('--headed');
const PROFILE = path.join(__dirname, '.e2e-profile');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const POINTS = {
    closeModal: { x: 0.617, y: 0.637 },
    settingsButton: { x: 0.912, y: 0.018 },   // шестерёнка в правом верхнем углу
    gameTab: { x: 0.297, y: 0.119 },          // вкладка «Игра» в окне настроек
    graphicsTab: { x: 0.367, y: 0.119 },      // вкладка «Графика» в окне настроек
    renderScaleBox: { x: 0.278, y: 0.248 },   // флажок «Чёткая отрисовка (x2)», левая колонка
};

// Ползунок предельной частоты кадров на вкладке графики: x0 — бегунок в положении 60 при
// потолке 120, x1 — правый край дорожки. Тянуть надо именно за бегунок, по клику мимо него
// ползунок не перескакивает.
const SLIDER = { y: 0.328, x0: 0.50, x1: 0.725 };

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
        await sleep(800);
    };
    const shot = (name) => page.screenshot({ path: path.join(__dirname, 'settings-' + name + '.png') });

    console.log('--- открываем ' + URL);
    await page.goto(URL, { waitUntil: 'domcontentloaded' });
    for (let i = 0; i < 60 && !lines.some((l) => l.includes('Connecting to ws')); i++) await sleep(1000);
    await sleep(16000);
    for (let i = 0; i < 3; i++) await click(POINTS.closeModal);

    await shot('0-lobby');
    console.log('--- открываем настройки');
    await click(POINTS.settingsButton);
    await sleep(1500);
    await shot('1-window');

    // Флажок чёткой отрисовки хранит значение на странице: проверяем, что клик доходит до неё
    // через ExternalInterface и множитель разрешения меняется на лету.
    const scale = () => page.evaluate(() => window.ruffleRenderScale);
    const before = await scale();
    await click(POINTS.renderScaleBox);
    const off = await scale();
    await sleep(1200);
    await shot('4-scale-off');
    await click(POINTS.renderScaleBox);
    const on = await scale();
    await sleep(1200);
    await shot('5-scale-on');
    console.log(`--- множитель разрешения: по умолчанию ${before}, после выключения ${off}, после включения ${on}`);
    const scaleOk = before === 2 && off === 1 && on === 2;

    console.log('--- вкладка графики');
    await click(POINTS.graphicsTab);
    await sleep(1200);
    await shot('2-graphics');

    // Тянем ползунок предельной частоты кадров в правый край: до патча потолок был 60.
    const size = page.viewportSize();
    const drag = async (from, to) => {
        await page.mouse.move(Math.round(size.width * from), Math.round(size.height * SLIDER.y));
        await page.mouse.down();
        await page.mouse.move(Math.round(size.width * to), Math.round(size.height * SLIDER.y), { steps: 20 });
        await page.mouse.up();
        await sleep(1500);
    };
    await drag(SLIDER.x0, SLIDER.x1);
    await shot('3-fps-max');

    // Значение ползунка уходит в stage.frameRate. Проверяем, что движок его слушает: на минимуме
    // (30) частота обязана заметно просесть относительно потолка. В лобби кадр дешёвый, поэтому
    // разница видна даже на программной отрисовке.
    const medianFps = async () => {
        const samples = [];
        for (let i = 0; i < 6; i++) {
            await sleep(1000);
            // Считаем такты игрового цикла: поле fps показывает частоту сцены Stage3D, а в лобби
            // её нет вовсе.
            const s = await page.evaluate(() => window.ruffleStats || null);
            if (s) samples.push(s.ticks || 0);
        }
        samples.sort((a, b) => a - b);
        return samples.length ? samples[Math.floor(samples.length / 2)] : 0;
    };
    // На время замера выключаем чёткую отрисовку: вчетверо больше пикселей программный
    // растеризатор не тянет, и кадр упирается в него, а не в настройку.
    await click(POINTS.gameTab);
    await click(POINTS.renderScaleBox);
    await click(POINTS.graphicsTab);
    const fpsHigh = await medianFps();

    let limitOk = true;
    let fpsLow = 0;
    if (fpsHigh > 35) {
        await drag(SLIDER.x1, SLIDER.x0);
        await shot('6-fps-min');
        fpsLow = await medianFps();
        await drag(SLIDER.x0, SLIDER.x1);
        limitOk = fpsLow < fpsHigh - 8;
        console.log(`--- частота кадров: на потолке ${fpsHigh.toFixed(1)}, на минимуме ${fpsLow.toFixed(1)}`);
    } else {
        console.log(`--- частота кадров ${fpsHigh.toFixed(1)}: среда медленнее минимума ползунка (30), ` +
                    'проверка влияния пропущена');
    }
    await click(POINTS.gameTab);
    await click(POINTS.renderScaleBox);

    fs.writeFileSync(path.join(__dirname, 'settings.log'), lines.join('\n'), 'utf8');
    const crashed = lines.some((l) => /panicked|Что-то пошло не так/.test(l));
    if (crashed) console.log('--- ПРОВАЛ: движок упал, см. webclient/settings.log');
    if (!scaleOk) console.log('--- ПРОВАЛ: флажок чёткой отрисовки не меняет множитель разрешения');
    if (!limitOk) console.log('--- ПРОВАЛ: ползунок частоты кадров не влияет на движок');
    const ok = !crashed && scaleOk && limitOk;
    if (ok) console.log('--- УСПЕХ: снимки settings-1-window, settings-2-graphics, settings-3-fps-max');
    await context.close();
    process.exit(ok ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
