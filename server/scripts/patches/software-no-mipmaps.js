'use strict';
/**
 * software-no-mipmaps (software.swf): отключает мип-уровни в программном рендерере.
 *
 * ЗАЧЕМ. В бою земля и другие крупные поверхности рисуются ровным серым, хотя вблизи та же
 * текстура нормальная. Причина — гонка при загрузке: клиент строит пирамиду уменьшенных копий с
 * текстурного атласа 2048x2048 ДО того, как в атлас приедут плитки, и больше её не пересобирает:
 *
 *     cpu-scale: 2048x2048 -> 1024x1024 src_colors=1   уровни считаются с пустого атласа
 *     copy-check: src_colors=320 dst_colors=320        плитки копируются уже после
 *
 * Само копирование исправно, ломается только порядок: в Ruffle события загрузки картинок приходят
 * позже, чем во Flash. На десктопном клиенте гонки нет, поэтому там всё в порядке.
 *
 * ЧТО ДЕЛАЕТ. В конструкторе TextureMaterial поле alternativa3d::_mipMapping (число уровней)
 * принудительно обнуляется, поэтому материал везде берёт полноразмерную текстуру. Внутренний код
 * читает это поле напрямую, минуя геттер, — поэтому патчится именно запись в конструкторе.
 *
 * Цена: дальние поверхности станут чуть более «шумными», зато перестанут быть серыми.
 *
 * ТОЛЬКО для браузерной сборки:
 *
 *   node scripts/patch-client.js --only software-mesh-usedepth,software-no-mipmaps \
 *        --base webclient/sw/software.swf --out webclient/sw/hardware.swf
 */

const MATERIAL = 'instance QName(PackageNamespace("alternativa.engine3d.materials"), "TextureMaterial")';

// getlocal <n> ; setproperty alternativa3d::_mipMapping — запись аргумента конструктора в поле.
const STORE = /([ \t]*)getlocal(0|1|2|3|\s+\d+)(\s*\n[ \t]*setproperty\s+QName\(Namespace\("http:\/\/alternativaplatform\.com\/en\/alternativa3d"\), "_mipMapping"\))/;

module.exports = {
  id: 'software-no-mipmaps',
  swf: 'software',
  description: 'Обнуляет число мип-уровней в TextureMaterial (они строятся до заполнения атласа).',

  apply({ classes, log }) {
    for (const c of classes) {
      if (!c.text.includes(MATERIAL)) continue;
      if (c.text.includes('[software-no-mipmaps]')) return { edits: 0, note: 'уже применён' };
      if (!STORE.test(c.text)) continue;

      c.save(c.text.replace(STORE, (_m, indent, _reg, tail) =>
        indent + 'pushbyte            0 ; [software-no-mipmaps] мип-уровни выключены' + tail));

      log('TextureMaterial: _mipMapping -> 0');
      return { edits: 1 };
    }

    throw new Error('TextureMaterial не найден — база точно software.swf?');
  },
};
