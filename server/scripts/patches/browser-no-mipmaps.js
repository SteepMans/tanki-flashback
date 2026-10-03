'use strict';
/**
 * browser-no-mipmaps (library.swf): выключает мипмаппинг для браузерной сборки.
 *
 * ЗАЧЕМ. В бою часть поверхностей (земля, дальние стены) рисуется ровным серым, тогда как вблизи
 * та же текстура нормальная. Разбор в Ruffle показал гонку: клиент строит пирамиду уменьшенных
 * копий (мип-уровни) с атласа 2048x2048 ДО того, как атлас наполнится плитками, и больше её не
 * пересобирает. Диагностика:
 *
 *     cpu-scale: 2048x2048 -> 1024x1024 src_colors=1     мипы строятся с пустого атласа
 *     copy-check: src_colors=320 dst_colors=320          плитки приезжают уже после
 *
 * Само копирование исправно (src и dst совпадают по числу цветов), ломается только порядок:
 * в Ruffle события загрузки картинок приходят на кадр позже, чем в Flash, и клиент успевает
 * построить мипы раньше. Поэтому вдали видны пустые уровни, а вблизи — правильный нулевой.
 *
 * ЧТО ДЕЛАЕТ. Геттер `isMipMappingEnabled` всегда возвращает false, и рендерер везде берёт
 * полноразмерную текстуру. Дальние поверхности становятся чуть более «шумными», зато перестают
 * быть серыми.
 *
 * ТОЛЬКО для браузерной сборки, в .resource/ не деплоить: на десктопе гонки нет и мипы полезны.
 *
 *   node scripts/patch-client.js --only browser-nostorage,browser-no-mipmaps \
 *        --base resources/library.swf --out webclient/library.swf
 */

const GETTER = /(\n[ \t]*name\s+"isMipMappingEnabled"\n[\s\S]{0,400}?\n[ \t]*code\n[ \t]*getlocal0\n[ \t]*pushscope\n)([\s\S]{0,300}?)(\n[ \t]*returnvalue)/;

module.exports = {
  id: 'browser-no-mipmaps',
  swf: 'library',
  description: 'Заставляет isMipMappingEnabled возвращать false (мип-уровни строятся до заполнения атласа).',

  apply({ classes, log }) {
    for (const c of classes) {
      if (!c.text.includes('name "isMipMappingEnabled"')) continue;
      if (c.text.includes('[browser-no-mipmaps]')) return { edits: 0, note: 'уже применён' };
      if (!GETTER.test(c.text)) continue;

      c.save(c.text.replace(GETTER, (_m, head, _body, tail) =>
        head + '      ; [browser-no-mipmaps] мипы отключены\n      pushfalse' + tail));

      log('isMipMappingEnabled -> false');
      return { edits: 1 };
    }

    throw new Error('геттер isMipMappingEnabled не найден — база точно library.swf?');
  },
};
