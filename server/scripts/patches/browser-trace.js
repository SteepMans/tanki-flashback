'use strict';
/**
 * browser-trace (library.swf): врезает trace() в методы, выбранные по ОРИГИНАЛЬНОМУ имени.
 *
 * ЗАЧЕМ. Гараж в браузерной сборке (Ruffle) не рисуется: сервер отдаёт данные, ресурсы грузятся,
 * ошибок AVM2 нет, экран пуст. На десктопном клиенте с тем же сервером гараж работает полностью,
 * так что дело в исполнении на стороне Ruffle. Нужен факт: докуда доходит цепочка построения.
 * Ruffle печатает trace() в консоль браузера.
 *
 * ПОЧЕМУ ЭТО РАБОТАЕТ. Обфускатор переименовал неймспейсы и мультинеймы, но отладочные имена
 * методов в ABC остались — RABCDAsm показывает их как `name "initDepot"`. По ним и цепляемся.
 *
 * ДВА РЕЖИМА:
 *   TRACE_METHODS=a,b,c   какие методы инструментировать (по умолчанию — цепочка гаража);
 *   TRACE_EXIT=1          дополнительно печатать выход из метода.
 *
 * Трассировка выхода нужна, чтобы поймать исключение, проглоченное чужим try/catch: вход
 * печатается, выхода нет — значит внутри метода что-то бросило, и ошибка не дошла до консоли.
 *
 * ТОЛЬКО для браузерной сборки, в .resource/ не деплоить. Сборка:
 *
 *   TRACE_EXIT=1 TRACE_METHODS=initDepot,initPresents node scripts/patch-client.js \
 *        --only browser-nostorage,browser-trace --base resources/library.swf --out webclient/library.swf
 */

const METHODS = (process.env.TRACE_METHODS ||
  'changeState,showGarage,switchGarage,initDepot,initPresents'
).split(',').map((s) => s.trim()).filter(Boolean);

const TRACE_EXIT = process.env.TRACE_EXIT === '1';

// TRACE_STEPS=имя — пронумеровать вызовы внутри метода и печатать номер перед каждым.
// Так видно, на какой строке метод прерывается: последний напечатанный шаг и есть место броска.
const TRACE_STEPS = (process.env.TRACE_STEPS || '').split(',').map((s) => s.trim()).filter(Boolean);

// TRACE_DEEP=1 — метки не только перед вызовами, но и перед чтением/записью свойств. Нужно, когда
// метод падает ещё на вычислении аргументов (до первого вызова) — обычно это getproperty у null.
const DEEP = process.env.TRACE_DEEP === '1';

// TRACE_CLASS=подстрока — ограничить инструментирование классами, чей refid её содержит.
// Нужно для конструкторов: их отладочное имя всегда "$", и без фильтра пометится весь клиент.
const TRACE_CLASS = process.env.TRACE_CLASS || '';

// Заголовок тела метода вплоть до пролога (getlocal0 / pushscope) — точка врезки на входе.
const METHOD_HEAD =
  /(\n[ \t]*name\s+"([^"]+)"\n[\s\S]{0,600}?\n[ \t]*body\n[ \t]*maxstack\s+)(\d+)([\s\S]{0,200}?\n[ \t]*code\n[ \t]*getlocal0\n[ \t]*pushscope\n)/g;

// Тело метода целиком — нужно, чтобы врезаться перед каждым returnvoid.
const METHOD_BODY =
  /(\n[ \t]*name\s+"([^"]+)"\n[\s\S]{0,600}?\n[ \t]*body\n[ \t]*maxstack\s+)(\d+)([\s\S]{0,200}?\n[ \t]*code\n)([\s\S]*?\n[ \t]*end ; code)/g;

function traceLines(indent, text) {
  return indent + 'findpropstrict      QName(PackageNamespace(""), "trace")\n' +
         indent + 'pushstring          "' + text + '"\n' +
         indent + 'callpropvoid        QName(PackageNamespace(""), "trace"), 1\n';
}

module.exports = {
  id: 'browser-trace',
  swf: 'library',
  description: 'Врезает trace() на вход (и, с TRACE_EXIT=1, на выход) методов из TRACE_METHODS.',

  apply({ classes, log }) {
    const hits = [], exits = [], steps = [];

    for (const c of classes) {
      if (TRACE_CLASS && !c.text.includes(TRACE_CLASS)) continue;
      if (!METHODS.some((m) => c.text.includes('name "' + m + '"'))) continue;

      // Одноимённые методы живут в разных классах (модель / контроллер / вью), поэтому в метку
      // добавляем короткий тег класса — иначе непонятно, чей именно initDepot отработал.
      const refid = (c.text.match(/refid\s+"([^"]+)"/) || [, '?'])[1];
      const tag = refid.split(':').pop().replace(/[^A-Za-z0-9]/g, '').slice(-6) || '?';

      let text = c.text;

      if (TRACE_EXIT) {
        text = text.replace(METHOD_BODY, (full, head, name, maxstack, mid, body) => {
          if (!METHODS.includes(name) || full.includes('[browser-trace]')) return full;
          const patched = body.replace(/^([ \t]*)returnvoid[ \t]*$/gm,
            (_m, ind) => traceLines(ind, '[T] ' + tag + '.' + name + ' EXIT') + ind + 'returnvoid');
          if (patched === body) return full;
          exits.push(name);
          return head + (parseInt(maxstack, 10) + 2) + mid + patched;
        });
      }

      if (TRACE_STEPS.length) {
        text = text.replace(METHOD_BODY, (full, head, name, maxstack, mid, body) => {
          if (!TRACE_STEPS.includes(name)) return full;
          let n = 0;
          const patched = body.replace(DEEP ? /^([ \t]*)(getproperty|getlex|findpropstrict|callpropvoid|callproperty|constructprop|initproperty|setproperty)(?= )/gm : /^([ \t]*)(callpropvoid|callproperty|constructprop)(?= )/gm,
            (m, ind, op) => traceLines(ind, '[S] ' + tag + '.' + name + ' #' + (++n)) + ind + op);
          if (!n) return full;
          steps.push(name + ':' + n);
          return head + (parseInt(maxstack, 10) + 2) + mid + patched;
        });
      }

      text = text.replace(METHOD_HEAD, (full, head, name, maxstack, tail) => {
        if (!METHODS.includes(name) || full.includes('[browser-trace]')) return full;
        hits.push(name);
        // findpropstrict + pushstring занимают два слота сверх текущего максимума.
        return head + (parseInt(maxstack, 10) + 2) + tail +
          '      ; [browser-trace]\n' + traceLines('      ', '[T] ' + tag + '.' + name);
      });

      if (text !== c.text) c.save(text);
    }

    if (hits.length === 0) throw new Error('ни один из методов не найден: ' + METHODS.join(', '));

    log('трассировка врезана: ' + hits.join(', ') +
        (exits.length ? ' | выходы: ' + exits.join(', ') : '') +
        (steps.length ? ' | шаги: ' + steps.join(', ') : ''));
    return { edits: hits.length + exits.length + steps.length };
  },
};
