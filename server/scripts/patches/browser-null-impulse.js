'use strict';
/**
 * browser-null-impulse (library.swf): проверка на null перед применением импульса выстрела.
 *
 * ЗАЧЕМ. Клиент моделирует толчок от попадания в `simulateTargetShot` и первой же строкой дёргает
 * метод у своей физической части танка:
 *
 *     this.<движение>.<приложить импульс>(...)
 *
 * Проверки на null там нет, хотя у соседних обработчиков (движение, поворот башни) она есть. Пока
 * модель танка ещё строится — сразу после возрождения или пока догружается модель только что
 * появившегося бота — это поле пустое, и клиент валится с Error #1009. Своё исключение он не
 * печатает в консоль, а шлёт отчётом на сервер, а после тринадцатой ошибки показывает панель
 * «Произошла критическая ошибка» и повторяет её на каждый следующий пакет — отсюда бесконечный флуд.
 *
 * ЧТО ДЕЛАЕТ. Вставляет в начало метода ранний выход, если физической части ещё нет: импульс
 * применять всё равно не к чему, а через кадр-другой танк построится и всё пойдёт как обычно.
 *
 * Патч только для браузерной сборки. Сборка:
 *   node scripts/patch-client.js --only browser-nostorage,browser-fps-slider,browser-render-scale,browser-null-impulse \
 *        --base resources/library.swf --out webclient/library.swf
 */

// Метод сохранил читаемое имя в отладочной информации — по нему и находим.
const METHOD = 'name "simulateTargetShot"';
// Первое обращение в теле: this.<поле физики>.<метод>(...) — из него берём и поле, и namespace.
const FIRST_CALL = /(code\s*\n\s*getlocal0\s*\n\s*pushscope\s*\n\s*\n)(\s*getlocal0\s*\n\s*getproperty\s+(QName\(PrivateNamespace\("\$\d+"\), "[^"]+"\))\s*\n)/;

module.exports = {
  id: 'browser-null-impulse',
  swf: 'library',
  description: 'Не применять импульс выстрела, пока у танка не построена физическая часть (Error #1009).',

  apply({ classes, log }) {
    let seen = false, edits = 0, already = 0;

    for (const c of classes) {
      if (!c.text.includes(METHOD)) continue;
      seen = true;

      if (c.text.includes('LimpulseNoBody')) { already++; break; }

      // Работаем только с телом нужного метода, чтобы не задеть соседние.
      const at = c.text.indexOf(METHOD);
      const head = c.text.slice(0, at);
      const tail = c.text.slice(at);
      const patchedTail = tail.replace(FIRST_CALL, (_m, prologue, firstAccess, field) =>
        prologue +
        '      ; [browser-null-impulse] физической части ещё нет — импульс применять некуда\n' +
        '      getlocal0\n' +
        `      getproperty         ${field}\n` +
        '      pushnull\n' +
        '      ifne                LimpulseNoBody\n' +
        '      returnvoid\n' +
        '     LimpulseNoBody:\n\n' +
        firstAccess);

      if (patchedTail === tail) throw new Error('не найдено первое обращение к физической части');
      c.save(head + patchedTail);
      edits++;
      break;
    }

    if (!seen) throw new Error('метод simulateTargetShot не найден — база точно library.swf?');
    if (edits === 0 && already) return { edits: 0, note: 'уже применён' };
    if (edits !== 1) throw new Error(`ожидалась 1 правка, сделано ${edits}`);

    log('в simulateTargetShot добавлена проверка на null');
    return { edits };
  },
};
