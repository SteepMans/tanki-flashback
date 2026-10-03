'use strict';
/**
 * browser-fps-slider (library.swf): поднимает потолок ползунка «Предельная частота кадров»
 * в браузерной сборке с 60 до 120.
 *
 * ЗАЧЕМ. Потолок хранится в поле класса строки настройки (значение по умолчанию 60) и повышается
 * только для Capabilities.playerType == "Desktop"/"External": там клиент опрашивает частоту
 * монитора через flash.display.Screen. В браузере playerType == "PlugIn", поэтому ползунок
 * упирался в 60 — выше игру было не пустить. Тот же потолок получает встроенный счётчик FPS
 * (правый нижний угол): он обрезает показания по нему, из-за чего показывал 60 даже тогда, когда
 * кадров рисовалось больше.
 *
 * КАК РАБОТАЕТ. Значение ползунка уходит в модель настроек, а оттуда в stage.frameRate. Ruffle
 * setter stage.frameRate уважает, пока частота не задана в конфиге страницы (frameRate: null) —
 * тогда настройка начинает работать по-настоящему, без параметра ?fps= в адресе.
 *
 * Шаг ползунка клиент считает как (max - 30) / 20 + 1, значение округляется при применении.
 * Потолок настраивается переменной окружения FPS_SLIDER_MAX. Сборка браузерного клиента:
 *
 *   node scripts/patch-client.js --only browser-nostorage,browser-fps-slider,browser-render-scale \
 *        --base resources/library.swf --out webclient/library.swf
 */
const MAX = parseInt(process.env.FPS_SLIDER_MAX || '120', 10);

// Класс строки «Предельная частота кадров» (в нём же ползунок).
const FPS_ROW_CLASS = /instance QName\(PackageNamespace\("super super return"\), "5214231921231934123423632234"\)/;
// Поле с потолком: приватный слот типа int со значением по умолчанию 60.
const CAP_FIELD = /("5214237560237573123423632234"\) type QName\(PackageNamespace\("", "#0"\), "int"\) value Integer\()60(\))/;

module.exports = {
  id: 'browser-fps-slider',
  swf: 'library',
  description: 'Поднимает потолок ползунка предельной частоты кадров до ' + MAX + ' (браузерная сборка).',

  apply({ classes, log }) {
    let seen = false, edits = 0, already = 0;

    for (const c of classes) {
      if (!FPS_ROW_CLASS.test(c.text)) continue;
      seen = true;

      if (new RegExp('"5214237560237573123423632234"\\) type QName\\(PackageNamespace\\("", "#0"\\), "int"\\) value Integer\\(' + MAX + '\\)').test(c.text)) {
        already++;
        continue;
      }
      if (!CAP_FIELD.test(c.text)) continue;

      c.save(c.text.replace(CAP_FIELD, '$1' + MAX + '$2'));
      edits++;
    }

    if (!seen) throw new Error('класс строки «предельная частота кадров» не найден — база точно library.swf?');
    if (edits === 0 && already) return { edits: 0, note: 'уже применён' };
    if (edits === 0) throw new Error('поле потолка со значением 60 не найдено (структура класса изменилась?)');

    log('потолок ползунка частоты кадров: 60 -> ' + MAX);
    return { edits };
  },
};
