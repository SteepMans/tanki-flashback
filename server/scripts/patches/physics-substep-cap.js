'use strict';
/**
 * physics-substep-cap (library.swf): потолок на догоняющие шаги физики за один кадр.
 *
 * ЗАЧЕМ. Физику клиент считает шагами фиксированной длины и догоняет ими реальное время
 * (класс `import else:final finally finally`, метод `f1e84744`, вызывается из `tick`):
 *
 *     tick(now) { ... this.lastTickTime = now; this.f1e84744(33); scene.render(...); }
 *     f1e84744(step) {
 *         while (physics.getPhysicsTime() < this.lastTickTime) {   // <- потолка нет
 *             ...контроллеры...
 *             physics.update(step);                                // шаг ровно 33 мс
 *             ...пост-контроллеры...
 *         }
 *         this.interpolate(step);
 *     }
 *
 * Потолка у этого цикла нет вообще. Пока кадр укладывается в 33 мс, шаг за кадр один и всё
 * хорошо. Но любая задержка — догрузка модели, сборка мусора, свёрнутая вкладка, просто тяжёлый
 * кадр — оставляет долг, и следующий кадр обязан отработать его ЦЕЛИКОМ: полсекунды простоя это
 * пятнадцать шагов физики подряд в одном кадре. Кадр от этого становится ещё длиннее, долг —
 * ещё больше, и клиент сваливается в яму, из которой сам не выходит: ровно тот симптом, на
 * который жалуются («просадки до 20-30 и дальше только хуже»).
 *
 * ЧТО ДЕЛАЕТ. Считает шаги внутри вызова и выходит из цикла после CAP-го. Долг при этом никуда
 * не девается — он просто гасится за несколько кадров по CAP шагов, а не одним рывком.
 * В нормальном режиме патч не делает НИЧЕГО: CAP шагов это CAP*33 мс времени, то есть кадр
 * длиннее 132 мс (при CAP=4). Такие кадры и есть та самая яма.
 *
 * Настройка: `PHYSICS_SUBSTEP_CAP=<N>` во время сборки, по умолчанию 4.
 * `PHYSICS_SUBSTEP_TRACE=1` — печатать в консоль каждый кадр, где шагов вышло больше одного.
 * Это замер, а не рабочий режим: строки идут потоком и сами по себе стоят кадра.
 *
 * Сборка (браузерная):
 *   node scripts/patch-client.js --only browser-nostorage,browser-fps-slider,browser-render-scale,\
 *        browser-null-impulse,bot-count-stepper,physics-substep-cap \
 *        --base resources/library.swf --out webclient/library.swf
 */

const CAP = (() => {
    const raw = process.env.PHYSICS_SUBSTEP_CAP;
    if (raw === undefined || raw === '') return 4;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1 || n > 64) throw new Error('PHYSICS_SUBSTEP_CAP должен быть целым 1..64');
    return n;
})();

const TRACE = process.env.PHYSICS_SUBSTEP_TRACE === '1';

// Метод сохранил читаемое имя в отладочной информации — по нему и находим.
const METHOD = 'name "f1e84744"';
// Счётчик кладём в свободную локаль: у метода их две (this и параметр).
const COUNTER_LOCAL = 2;

module.exports = {
    id: 'physics-substep-cap',
    swf: 'library',
    description: 'Не больше N догоняющих шагов физики за кадр (PHYSICS_SUBSTEP_CAP, по умолчанию 4).',

    apply({ classes, log }) {
        let seen = 0, edits = 0;

        for (const c of classes) {
            const at = c.text.indexOf(METHOD);
            if (at < 0) continue;
            seen++;
            if (c.text.includes('LphysicsCapDone')) return { edits: 0, note: 'уже применён' };

            // Работаем только с телом нужного метода: имена локалей и меток в соседних совпадают.
            const bodyStart = c.text.lastIndexOf('  trait method', at);
            const bodyEnd = c.text.indexOf('  end ; trait', at);
            if (bodyStart < 0 || bodyEnd < 0) throw new Error('не удалось выделить метод f1e84744');
            const head = c.text.slice(0, bodyStart);
            const tail = c.text.slice(bodyEnd);
            let body = c.text.slice(bodyStart, bodyEnd);

            // 1. Метка условия цикла — цель безусловного перехода сразу после пролога.
            const prologue = /(code\n( *)getlocal0\n *pushscope\n\n *)jump( +)(L\d+)\n/.exec(body);
            if (!prologue) throw new Error('не найден пролог цикла догона');
            const condLabel = prologue[4];
            const pad = prologue[2];

            // 2. Метка тела цикла — цель условного перехода в конце блока условия.
            const cond = new RegExp('\\n' + condLabel + ':\\n([\\s\\S]*?)\\n *iflt( +)(L\\d+)\\n');
            const condMatch = cond.exec(body);
            if (!condMatch) throw new Error('не найдено условие цикла догона (iflt)');
            const bodyLabel = condMatch[3];

            // 3. Обнуляем счётчик в прологе.
            body = body.replace(prologue[0],
                prologue[1] +
                pad + '; [physics-substep-cap] счётчик догоняющих шагов\n' +
                pad + 'pushbyte            0\n' +
                pad + `setlocal            ${COUNTER_LOCAL}\n\n` +
                pad + 'jump' + prologue[3] + condLabel + '\n');

            // 4. Считаем шаг на входе в тело цикла.
            const bodyHead = new RegExp('\\n' + bodyLabel + ':\\n( *)label\\n');
            if (!bodyHead.test(body)) throw new Error('не найдено начало тела цикла догона');
            body = body.replace(bodyHead, (_m, p) =>
                '\n' + bodyLabel + ':\n' + p + 'label\n' + p + `inclocal_i          ${COUNTER_LOCAL}\n`);

            // 5. Условие: сначала потолок, потом сравнение времени.
            body = body.replace(condMatch[0],
                '\n' + condLabel + ':\n' +
                pad + `; [physics-substep-cap] больше ${CAP} шагов за кадр не догоняем\n` +
                pad + `getlocal            ${COUNTER_LOCAL}\n` +
                pad + `pushbyte            ${CAP}\n` +
                pad + 'ifge                LphysicsCapDone\n' +
                condMatch[1] + '\n' +
                pad + 'iflt' + condMatch[2] + bodyLabel + '\n' +
                'LphysicsCapDone:\n' +
                (TRACE
                    ? pad + '; [physics-substep-cap] замер: печатаем кадры, где шагов больше одного\n' +
                      pad + `getlocal            ${COUNTER_LOCAL}\n` +
                      pad + 'pushbyte            2\n' +
                      pad + 'iflt                LphysicsTraceSkip\n' +
                      pad + 'findpropstrict      QName(PackageNamespace(""), "trace")\n' +
                      pad + 'pushstring          "[physics] substeps "\n' +
                      pad + `getlocal            ${COUNTER_LOCAL}\n` +
                      pad + 'add\n' +
                      pad + 'callpropvoid        QName(PackageNamespace(""), "trace"), 1\n' +
                      'LphysicsTraceSkip:\n'
                    : ''));

            // 6. Локаль под счётчик надо объявить.
            const locals = /( *localcount +)(\d+)/.exec(body);
            if (!locals) throw new Error('не найден localcount у f1e84744');
            if (Number(locals[2]) <= COUNTER_LOCAL) {
                body = body.replace(locals[0], locals[1] + (COUNTER_LOCAL + 1));
            }

            c.save(head + body + tail);
            edits++;
            log(`потолок догоняющих шагов физики: ${CAP} за кадр`);
        }

        if (!seen) throw new Error('метод f1e84744 не найден — это точно library.swf?');
        return { edits };
    },
};
