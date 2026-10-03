'use strict';
/**
 * browser-render-scale (library.swf): добавляет в настройки («Игра», левая колонка) флажок
 * «Чёткая отрисовка (x2)» — множитель разрешения кадра для браузерной сборки.
 *
 * ЗАЧЕМ. В клиенте нет вшитых шрифтов: подписи набраны системными, которых у Ruffle нет, и он
 * рисует их своим запасным шрифтом без хинтинга — мелкий текст выглядит мылом. Если рисовать кадр
 * вдвое подробнее экрана и дать браузеру сжать его обратно, буквы перестают ломаться. Раньше это
 * включалось только параметром адреса ?render=2, то есть игроку было недоступно.
 *
 * КАК УСТРОЕНО. Значение хранит страница (webclient/index.html, localStorage), а не клиент: сам
 * множитель применяет движок через window.ruffleRenderScale, и настройка должна пережить
 * перезапуск игры независимо от её SharedObject. Поэтому флажок:
 *   - при создании спрашивает текущее значение: ExternalInterface.call("ruffleRenderScale2x");
 *   - по клику сообщает новое:                  ExternalInterface.call("ruffleRenderScale2x", вкл).
 * Обе стороны переживают отсутствие ExternalInterface (десктопный клиент): тогда флажок просто
 * показывает «включено» и ничего не делает.
 *
 * Флажок делается тем же приватным методом класса, что и «Показывать уведомления» — он создаёт
 * checkbox без привязки к модели настроек, ровно то, что нужно: значение живёт на странице.
 *
 * ВАЖНО: патч только для браузерной сборки, в .resource/ его деплоить не нужно. Сборка:
 *
 *   node scripts/patch-client.js --only browser-nostorage,browser-fps-slider,browser-render-scale \
 *        --base resources/library.swf --out webclient/library.swf
 */

// Подпись флажка. В .asasm строки пишем escape-последовательностями, чтобы не зависеть от
// кодировки файла при сборке.
const LABEL = 'Чёткая отрисовка (x2)';
const JS_HOOK = 'ruffleRenderScale2x';

// Вкладка «Игра» окна настроек.
const GAME_TAB = /instance QName\(PackageNamespace\("521423117312311744123423632234"\), "static package implements"\)/;
// Приватное пространство имён класса вытаскиваем из вызова его же метода-фабрики флажков.
const MAKE_CHECKBOX = /QName\(PrivateNamespace\("(\$\d+)"\), "521423127992312812123423632234"\)/;
// Якорь: строка «альтернативное поведение камеры» — второй флажок левой колонки.
const ANCHOR = /(pushstring\s+"SETTINGS_ALTERNATE_CAMERA_LABEL_TEXT"[\s\S]*?callpropvoid\s+QName\(PackageNamespace\("", "#0"\), "dynamic false"\), 1\n)/;

const EI = 'QName(PackageNamespace("flash.external"), "ExternalInterface")';
const PUB = (n) => `QName(PackageNamespace("", "#0"), "${n}")`;
const SELECTED = PUB('5214234103234116123423632234');   // checkbox.selected
const VBOX_ADD = PUB('dynamic false');                  // колонка.добавить(элемент)
const TOGGLE = 'renderScaleToggle';

function escapeString(text) {
  return Array.from(Buffer.from(text, 'utf8'))
    .map((b) => (b >= 0x20 && b < 0x7F && b !== 0x22 && b !== 0x5C
      ? String.fromCharCode(b)
      : '\\x' + b.toString(16).padStart(2, '0')))
    .join('');
}

// Создание флажка и подписка на клик. local3 — левая колонка, local5 свободен до конца конструктора.
const INSERT = (ns) => `
     ; [browser-render-scale] чёткая отрисовка: значение хранит страница, кадр рисуется крупнее
     getlocal0
     pushstring          "${escapeString(LABEL)}"
     getlex              ${EI}
     getproperty         ${PUB('available')}
     iffalse             LrenderScaleDefault
     getlex              ${EI}
     pushstring          "${JS_HOOK}"
     callproperty        ${PUB('call')}, 1
     convert_b
     jump                LrenderScaleMake
LrenderScaleDefault:
     pushtrue
LrenderScaleMake:
     callproperty        QName(PrivateNamespace("${ns}"), "521423127992312812123423632234"), 2
     setlocal            5

     getlocal            5
     pushstring          "click"
     getlocal0
     getproperty         QName(PrivateNamespace("${ns}"), "${TOGGLE}")
     callpropvoid        ${PUB('addEventListener')}, 2

     getlocal3
     getlocal            5
     callpropvoid        ${VBOX_ADD}, 1
`;

// Обработчик клика: сообщает странице новое значение.
const TRAIT = (ns) => `  trait method QName(PrivateNamespace("${ns}"), "${TOGGLE}")
   method
    name "${TOGGLE}"
    refid "521423117312311744123423632234:static package implements/instance/${TOGGLE}"
    param QName(PackageNamespace("flash.events"), "MouseEvent")
    returns ${PUB('void')}
    body
     maxstack 4
     localcount 2
     initscopedepth 0
     maxscopedepth 1
     code
      getlocal0
      pushscope
      getlex              ${EI}
      getproperty         ${PUB('available')}
      iffalse             LrenderScaleSkip
      getlex              ${EI}
      pushstring          "${JS_HOOK}"
      getlocal1
      getproperty         ${PUB('currentTarget')}
      getproperty         ${SELECTED}
      callpropvoid        ${PUB('call')}, 2
     LrenderScaleSkip:
      returnvoid
     end ; code
    end ; body
   end ; method
  end ; trait
`;

module.exports = {
  id: 'browser-render-scale',
  swf: 'library',
  description: 'Флажок «' + LABEL + '» в настройках: множитель разрешения кадра (браузерная сборка).',

  apply({ classes, log }) {
    let seen = false, edits = 0, already = 0;

    for (const c of classes) {
      if (!GAME_TAB.test(c.text)) continue;
      seen = true;

      if (c.text.includes('"' + TOGGLE + '"')) { already++; break; }

      const ns = (c.text.match(MAKE_CHECKBOX) || [])[1];
      if (!ns) throw new Error('не найден метод-фабрика флажков (структура вкладки изменилась?)');
      if (!ANCHOR.test(c.text)) throw new Error('не найдена строка «альтернативное поведение камеры»');

      const slotAnchor = `  trait slot QName(PrivateNamespace("${ns}"), "static static")`;
      if (!c.text.includes(slotAnchor)) throw new Error('не найдено место для нового метода');

      let text = c.text.replace(ANCHOR, '$1' + INSERT(ns));
      text = text.replace(slotAnchor, TRAIT(ns) + slotAnchor);
      c.save(text);
      edits++;
      break;
    }

    if (!seen) throw new Error('вкладка «Игра» окна настроек не найдена — база точно library.swf?');
    if (edits === 0 && already) return { edits: 0, note: 'уже применён' };
    if (edits !== 1) throw new Error(`ожидалась 1 правка, сделано ${edits}`);

    log('во вкладку «Игра» добавлен флажок «' + LABEL + '» (хук ' + JS_HOOK + ')');
    return { edits };
  },
};
