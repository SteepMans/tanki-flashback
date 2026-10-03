'use strict';
/**
 * browser-nostorage (library.swf): выключает локальный кэш ресурсов клиента.
 *
 * ЗАЧЕМ. Под Ruffle (браузерный стенд, webclient/) `SharedObject.flush()` на хранилище ресурсов
 * бросает Error #2130. Исключение вылетает из dispatchEvent и обрывает цепочку готовности ресурсов:
 *
 *     BatchTextureConstructor/onTextureReady() -> complete() -> dispatchEvent()
 *       -> SharedObject/flush()  ->  Error #2130: Unable to flush SharedObject
 *
 * Простые SharedObject (`accounts`, `name` — без localPath) при этом работают, логин сохраняется.
 * Падают ровно те, что создаются как `SharedObject.getLocal(<имя>, "/")` — подсистема локального
 * кэша ресурсов, та самая, что в десктопной версии накапливает сотни мегабайт в Local Store\cache.
 *
 * ЧТО ДЕЛАЕТ. У класса хранилища есть штатный флаг `enabled` — им пользуются консольные команды
 * EnableStorageCommand / DisableStorageCommand (`storage.enabled = false`). Патч заставляет геттер
 * `enabled` всегда возвращать false, то есть переводит клиент в режим «кэш выключен»: ресурсы
 * всегда берутся по HTTP и ничего не пишется в SharedObject. Браузеру дисковый кэш не нужен —
 * у него есть обычный HTTP-кэш, а версия ресурса и так зашита в URL.
 *
 * ПОЧЕМУ НЕ ГЛУШИТЬ flush(). Первая версия патча убирала сами вызовы flush. 2130 уходила, лобби и
 * бой работали, но гараж оставался пустым: за всю браузерную сессию клиент не запросил НИ ОДНОГО
 * library.tara (десктоп за то же время — 198). Хранилище продолжало считаться включённым, отвечало
 * на запросы ресурсов из своей памяти и до HTTP дело не доходило. Выключение флага бьёт в корень.
 *
 * ВАЖНО: патч предназначен ТОЛЬКО для браузерной сборки. Деплоить в .resource/ его не нужно —
 * десктопный клиент потеряет дисковый кэш ресурсов и станет качать их заново каждый запуск. Сборка:
 *
 *   node scripts/patch-client.js --only browser-nostorage \
 *        --base resources/library.swf --out webclient/library.swf
 */

// Признак классов подсистемы хранения: SharedObject.getLocal(..., "/").
const STORAGE_CLASS = /pushstring\s+"\/"\s*\n\s*callproperty\s+QName\(PackageNamespace\("", "#0"\), "getLocal"\), 2/;

// Геттер `enabled`: возвращает приватный слот. Подменяем тело на `return false`.
const ENABLED_GETTER = /(trait getter QName\(PackageNamespace\("", "#0"\), "enabled"\)[\s\S]{0,400}?code\s*\n)([ \t]*getlocal0\s*\n[ \t]*pushscope\s*\n\s*\n[ \t]*getlocal0\s*\n[ \t]*getproperty\s+QName\(PrivateNamespace\("[^"]+"\), "[^"]+"\)\s*\n[ \t]*returnvalue\s*\n)/;

module.exports = {
  id: 'browser-nostorage',
  swf: 'library',
  description: 'Выключает локальный кэш ресурсов (storage.enabled = false) для браузерной сборки на Ruffle.',

  apply({ classes, log }) {
    let seen = 0, edits = 0, already = 0;

    for (const c of classes) {
      if (!STORAGE_CLASS.test(c.text)) continue;
      seen++;

      if (/; \[browser-nostorage\]/.test(c.text)) { already++; continue; }
      if (!ENABLED_GETTER.test(c.text)) continue;

      c.save(c.text.replace(ENABLED_GETTER,
        (_m, head) => head +
          '      ; [browser-nostorage] кэш ресурсов выключен: всегда качаем по HTTP\n' +
          '      pushfalse\n' +
          '      returnvalue\n'));
      edits++;
    }

    if (seen === 0) throw new Error('классы хранилища (getLocal с путём "/") не найдены — база точно library.swf?');
    if (edits === 0 && already) return { edits: 0, note: 'уже применён' };
    if (edits === 0) throw new Error('геттер enabled не найден (структура класса изменилась?)');

    log(`кэш ресурсов выключен: правок — ${edits}, классов хранилища — ${seen}`);
    return { edits };
  },
};
