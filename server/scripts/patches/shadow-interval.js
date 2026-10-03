'use strict';
/**
 * shadow-interval (hardware.swf): карта теней обновляется не каждый кадр.
 *
 * ЗАЧЕМ. Тени рисуются отдельным проходом: `Camera3D.render` зовёт `ShadowMap.calculateBounds`, а
 * следом `ShadowMap.render(camera, casterObjects, casterCount)`, и тот прогоняет каждый
 * отбрасывающий тень объект в отдельный вызов отрисовки в атлас теней. В большом бою это десятки
 * вызовов Stage3D на кадр плюс своя доля скриптового времени, и всё это ради картинки, которая от
 * кадра к кадру почти не меняется.
 *
 * ЧТО ДЕЛАЕТ. В начало `ShadowMap/alternativa3d::render` вставлен счётчик: проход выполняется раз
 * в N кадров, остальные кадры выходят сразу. Тогда и содержимое атласа, и матрица `transform` с
 * параметрами `params`, по которым приёмники его читают, остаются от предыдущего прохода — то есть
 * согласованными между собой. Тень отстаёт от сцены на N-1 кадр; границы карты теней движок и так
 * привязывает к сетке (`Math.floor(boundMin / шаг) * шаг`), поэтому при обычном движении камеры
 * область покрытия чаще всего та же самая и перескока не видно.
 *
 * ПО УМОЛЧАНИЮ ПАТЧ НИЧЕГО НЕ ДЕЛАЕТ. На стенде (headless, программный GL, бой на десяток танков)
 * разница между «тени как есть» и «теней нет вообще» уложилась в разброс между прогонами: у
 * одинаковых сборок медиана кадров гуляет на 15-20%, а весь теневой проход дал меньше. В профиле
 * на машине владельца `ShadowMap/render` виден, поэтому мерить надо там — патч оставлен готовым
 * рычагом, а не включён вслепую.
 *
 * НАСТРОЙКА. `SHADOW_EVERY=<N>` во время сборки:
 *   N = 1  — по умолчанию: как в оригинале, патч не применяется;
 *   N = 2  — половина проходов;
 *   N = 0  — тени не рисуются вовсе. Это НЕ рабочий режим, а замер: показывает, сколько стоит
 *            весь теневой проход целиком.
 *
 * Как мерить (артефакт кладётся туда же, откуда его берёт браузерная страница — `resources` в
 * index.html указывает на корень ресурсного сервера, а тот раздаёт `.resource/hardware.swf`):
 *
 *   node webclient/soak.js --minutes 6 --tag shadow-before          # база
 *   SHADOW_EVERY=0 node scripts/patch-client.js --only shadow-interval --deploy
 *   node webclient/soak.js --minutes 6 --tag shadow-off             # весь проход целиком
 *   SHADOW_EVERY=2 node scripts/patch-client.js --only shadow-interval --deploy
 *   node webclient/soak.js --minutes 6 --tag shadow-half            # половина проходов
 *
 * Откат: `cp resources/hardware.swf .resource/hardware.swf`.
 */

const EVERY = (() => {
    const raw = process.env.SHADOW_EVERY;
    if (raw === undefined || raw === '') return 1;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0 || n > 16) throw new Error('SHADOW_EVERY должен быть целым 0..16');
    return n;
})();

// Счётчик кадров живёт слотом самого ShadowMap: их в игре по одному на камеру, общего состояния
// между ними не нужно.
const COUNTER = 'QName(PackageNamespace(""), "shadowIntervalTick")';
const SLOT = `  trait slot ${COUNTER} type QName(PackageNamespace(""), "int") value Integer(0) end`;
// Якорь для слота — первое поле класса; вставляем свой перед ним.
const FIRST_SLOT = '  trait slot QName(PrivateNamespace("alternativa.engine3d.core:ShadowMap"), "a5ae1740")';
// Пролог метода render: сразу после него и врезаемся.
const RENDER_HEAD = /(trait method QName\(Namespace\("http:\/\/alternativaplatform\.com\/en\/alternativa3d"\), "render"\)[\s\S]{0,900}?\n( *)code\n( *)getlocal0\n *pushscope\n)/;

const ind = (line) => (line.endsWith(':') ? '     ' + line : '      ' + line);

/** Тени выключены целиком: выходим из render сразу. */
const skipAll = [
    '; [shadow-interval] SHADOW_EVERY=0 — теневой проход выключен (режим замера)',
    'returnvoid',
];

/** Проход раз в N кадров. */
const everyN = (n) => [
    `; [shadow-interval] теневой проход раз в ${n} кадра, остальные кадры берут прошлый атлас`,
    'getlocal0',
    'getlocal0',
    `getproperty         ${COUNTER}`,
    'increment_i',
    `pushbyte            ${n}`,
    'modulo',
    'convert_i',
    `setproperty         ${COUNTER}`,
    'getlocal0',
    `getproperty         ${COUNTER}`,
    'pushbyte            0',
    'ifeq                LshadowIntervalRender',
    'returnvoid',
    'LshadowIntervalRender:',
];

module.exports = {
    id: 'shadow-interval',
    swf: 'hardware',
    description: 'Карта теней обновляется раз в N кадров (SHADOW_EVERY; по умолчанию 1 — выключен, 0 — совсем без теней).',

    apply({ classes, log }) {
        if (EVERY === 1) return { edits: 0, note: 'SHADOW_EVERY=1 — оригинальное поведение, ничего не меняем' };

        let edits = 0;
        for (const c of classes) {
            if (!c.text.includes('instance QName(PackageNamespace("alternativa.engine3d.core"), "ShadowMap")')) continue;
            // Метки и комментарии RABCDAsm при пересборке теряет, поэтому по ним патч не узнать —
            // ищем имя слота-счётчика, оно переживает круг «собрать — разобрать».
            if (c.text.includes('shadowIntervalTick')) return { edits: 0, note: 'уже применён' };

            let text = c.text;
            if (EVERY !== 0) {
                if (!text.includes(FIRST_SLOT)) throw new Error('не найдено место под слот-счётчик в ShadowMap');
                text = text.replace(FIRST_SLOT, SLOT + '\n' + FIRST_SLOT);
            }
            if (!RENDER_HEAD.test(text)) throw new Error('не найден пролог ShadowMap/render');
            const body = (EVERY === 0 ? skipAll : everyN(EVERY)).map(ind).join('\n');
            text = text.replace(RENDER_HEAD, (_m, head) => head + '\n' + body + '\n');

            c.save(text);
            edits++;
            log(EVERY === 0 ? 'теневой проход выключен целиком' : `теневой проход раз в ${EVERY} кадра`);
        }
        if (!edits) throw new Error('класс ShadowMap не найден — это точно hardware.swf?');
        return { edits };
    },
};
