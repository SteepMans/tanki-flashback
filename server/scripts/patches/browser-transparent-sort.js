/**
 * НЕ ВКЛЮЧЁН В СБОРКУ. Замер на машине владельца показал, что патч не убирает работу, а переносит
 * её из интерпретатора в отрисовку примерно один к одному: `drawOOBBGeometry` (28-42% кадра) и
 * `e48c6fdc` исчезают, число выполненных инструкций падает вдвое, но время отрисовки Ruffle растёт
 * с 0.6-1.4 мс до 3-19 мс, и суммарно кадр не выигрывает. Файл оставлен как разобранный путь и
 * заготовка: если найдётся, какая из двух его половин (перевод 14 мешей на сортировку по средней
 * глубине или снятие ступени OOBB у контейнера) даёт цену в отрисовке, вторую можно будет включить.
 * Правильное решение для этих методов — нативный перенос в Ruffle, а не патч байткода.
 */
'use strict';
/**
 * browser-transparent-sort (library.swf): порядок прозрачной геометрии определяется сортировкой
 * по средней Z, а не разбиением полигонов и поиском разделяющих плоскостей.
 *
 * ЗАЧЕМ. В тяжёлых кадрах боя до половины всего времени ActionScript уходит в два метода
 * движка — `ConflictContainer/drawOOBBGeometry` и `ConflictContainer/e48c6fdc`:
 *
 *     hitch 42.2 ms: ActionScript 41.2 ms, render 1.0 ms, 4771 тыс. инструкций;
 *         ConflictContainer/drawOOBBGeometry 25%; ConflictContainer/e48c6fdc 17%; ...
 *
 * Вопреки названию, `drawOOBBGeometry` ничего отладочного не рисует. `KDContainer` наследует
 * `ConflictContainer`, и его `draw` разрешает порядок рисования прозрачных объектов лесенкой
 * из трёх всё более дорогих шагов (alternativa/engine3d/containers/ConflictContainer):
 *
 *     drawAABBGeometry     — делит список по осям X/Y/Z параллелепипедами; дёшево;
 *     drawOOBBGeometry     — ищет разделяющую плоскость среди граней ориентированных коробок;
 *     drawConflictGeometry — последний шаг: режет геометрию по полигонам (BSP) методом e48c6fdc
 *                            `(splitter:Face, list:Face, camera:Camera3D, threshold:Number, ...)`.
 *
 * Каждый шаг вызывается, только если предыдущий не смог развести объекты, и в конце любой ветки
 * стоит настоящее рисование `vg.draw(camera, threshold, this)`. То есть выключить их нельзя:
 * без них прозрачная геометрия просто перестанет рисоваться. И отладочного флага здесь нет —
 * единственная отладочная отрисовка в этих классах, `Debug.drawBounds`, закрыта проверкой битов
 * `camera.debug` и в игре не включена. Снять один штатный флаг тоже не выход: без
 * `resolveByOOBB` конфликтующий список уходит сразу в BSP, то есть становится хуже.
 *
 * Зато у самой лесенки есть выход подешевле — он выбирается по `VG.sorting`:
 *   - `drawConflictGeometry` при `Sorting.DYNAMIC_BSP` (2) режет по полигонам, а при
 *     `Sorting.NONE` (0) и `Sorting.AVERAGE_Z` (1) просто зовёт `camera.sortByAverageZ(faces)`;
 *   - `VG.draw` независимо от конфликтов делает `lookupswitch` по тому же полю и при DYNAMIC_BSP
 *     каждый кадр гоняет `camera.sortByDynamicBSP` по граням объекта, даже одиноко стоящего.
 *
 * У `Mesh` по умолчанию как раз AVERAGE_Z; DYNAMIC_BSP игра ставит руками — следы выстрелов
 * (Trail1/Trail2), лучи (Laser), конусы огнемёта и заморозки, взрывные квадраты, меши танка.
 * Почти всё это рисуется аддитивно (`blendMode = "add"`), а для сложения цветов порядок вообще
 * не важен.
 *
 * ЧТО ДЕЛАЕТ.
 *   1. Все 14 мест, где игра ставит `sorting = Sorting.DYNAMIC_BSP`, переводит на
 *      `Sorting.AVERAGE_Z`, вместе с тремя проверками «этот меш уже подготовлен» рядом с ними.
 *      После этого ни `e48c6fdc`, ни `sortByDynamicBSP` не вызываются вовсе.
 *   2. Контейнеру карты и контейнеру статических групп ставит `resolveByOOBB = false`. Теперь,
 *      когда параллелепипеды не развели объекты, вместо перебора граней ориентированных коробок
 *      сразу берётся дешёвая сортировка по средней Z — это возможно только вместе с пунктом 1,
 *      иначе тот же список ушёл бы в BSP.
 *
 * ЧТО МЕНЯЕТСЯ ВИЗУАЛЬНО. Пересекающиеся прозрачные поверхности больше не разрезаются по линии
 * пересечения: если дым проходит сквозь стену или два следа выстрела пересекаются, порядок
 * выбирается целиком для грани, а не для её половинок. На аддитивных эффектах это не видно
 * (сложение коммутативно), на остальном возможен резкий перескок порядка при движении камеры —
 * ровно то же поведение, которое движок и так даёт всем обычным мешам по умолчанию.
 *
 * Патч только для браузерной сборки. Сборка:
 *   node scripts/patch-client.js --only browser-nostorage,browser-fps-slider,browser-render-scale,\
 *        browser-null-impulse,bot-count-stepper,browser-transparent-sort \
 *        --base resources/library.swf --out webclient/library.swf
 */

const PUBLIC_NS = 'QName(PackageNamespace("", "#0")';
// Публичное свойство `sorting` у Mesh. Две формы записи присваивания в дизассемблировке:
// через findproperty/swap и напрямую после getlocal.
const SORTING_VIA_SWAP = new RegExp(
  '(pushbyte\\s+)2(\\s*\\n\\s*findproperty\\s+' + esc(PUBLIC_NS) + ', "sorting"\\)' +
  '\\s*\\n\\s*swap\\s*\\n\\s*setproperty\\s+' + esc(PUBLIC_NS) + ', "sorting"\\))', 'g');
const SORTING_DIRECT = new RegExp(
  '(pushbyte\\s+)2(\\s*\\n\\s*setproperty\\s+' + esc(PUBLIC_NS) + ', "sorting"\\))', 'g');
// Сколько мест ставят DYNAMIC_BSP в нетронутом library.swf. Если база другая — патч должен
// упасть, а не молча промахнуться.
const SORTING_SITES = 14;
// Рядом с присваиванием стоит защита от повторной подготовки меша:
//     if (mesh.sorting != DYNAMIC_BSP) { mesh.sorting = DYNAMIC_BSP; ... optimizeForDynamicBSP(); }
// Её тоже надо перевести на новое значение, иначе условие перестанет срабатывать и дорогая
// подготовка будет выполняться при каждом вызове.
const SORTING_GUARD = new RegExp(
  '(getproperty\\s+' + esc(PUBLIC_NS) + ', "sorting"\\)\\s*\\n\\s*pushbyte\\s+)2(\\s*\\n\\s*ifeq\\s)', 'g');
const GUARD_SITES = 3;

// Контейнер карты: строится в билдере карты и сразу получает threshold/ignoreChildrenInCollider.
const MAP_CONTAINER = new RegExp(
  '(getlocal0\\s*\\n\\s*findpropstrict\\s+QName\\(PackageNamespace\\("alternativa\\.engine3d\\.containers"\\), "KDContainer"\\)' +
  '\\s*\\n\\s*constructprop\\s+QName\\(PackageNamespace\\("alternativa\\.engine3d\\.containers"\\), "KDContainer"\\), 0' +
  '\\s*\\n\\s*setproperty\\s+(QName\\(PrivateNamespace\\("\\$\\d+"\\), "\\d+"\\))\\s*\\n)', 'g');
// Контейнер статических групп: единственный наследник KDContainer в игре, узнаётся по
// единственному во всей библиотеке обращению к needCollectReceivers.
const GROUP_CONTAINER = new RegExp(
  '(\\s*getlocal0\\s*\\n\\s*pushfalse\\s*\\n\\s*setproperty\\s+' +
  'QName\\(ProtectedNamespace\\("alternativa\\.engine3d\\.containers:KDContainer"\\), ' +
  '"needCollectReceivers"\\)\\s*\\n)', 'g');

function esc(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

module.exports = {
  id: 'browser-transparent-sort',
  swf: 'library',
  description: 'Прозрачную геометрию упорядочивать сортировкой по средней Z, без BSP и OOBB.',

  apply({ classes, log }) {
    let sorting = 0, guards = 0, map = 0, group = 0, already = 0;

    for (const c of classes) {
      if (c.text.includes('[browser-transparent-sort]')) { already++; continue; }
      let text = c.text;

      // Защиту правим ДО присваивания: иначе первое же присваивание превратится в pushbyte 1
      // и станет неотличимо от чтения.
      text = text.replace(SORTING_GUARD, (_m, head, tail) => { guards++; return head + '1' + tail; });
      text = text.replace(SORTING_VIA_SWAP, (_m, head, tail) => { sorting++; return head + '1' + tail; });
      text = text.replace(SORTING_DIRECT, (_m, head, tail) => { sorting++; return head + '1' + tail; });

      text = text.replace(MAP_CONTAINER, (_m, block, field) => {
        map++;
        return block +
          '      ; [browser-transparent-sort] конфликты прозрачной геометрии разводить сортировкой,\n' +
          '      ; а не поиском разделяющих плоскостей ориентированных коробок\n' +
          '      getlocal0\n' +
          `      getproperty         ${field}\n` +
          '      pushfalse\n' +
          `      setproperty         ${PUBLIC_NS}, "resolveByOOBB")\n`;
      });

      text = text.replace(GROUP_CONTAINER, (_m, block) => {
        group++;
        return block +
          '\n      ; [browser-transparent-sort] то же самое для контейнера статических групп\n' +
          '      getlocal0\n' +
          '      pushfalse\n' +
          `      setproperty         ${PUBLIC_NS}, "resolveByOOBB")\n`;
      });

      if (text !== c.text) c.save(text);
    }

    if (already && !sorting && !guards && !map && !group) return { edits: 0, note: 'уже применён' };
    if (sorting !== SORTING_SITES) {
      throw new Error(`sorting = Sorting.DYNAMIC_BSP: ожидалось ${SORTING_SITES} мест, найдено ${sorting}`);
    }
    if (guards !== GUARD_SITES) {
      throw new Error(`защита «уже подготовлен»: ожидалось ${GUARD_SITES} мест, найдено ${guards}`);
    }
    if (map !== 1) throw new Error(`контейнер карты: ожидалось 1 место, найдено ${map}`);
    if (group !== 1) throw new Error(`контейнер статических групп: ожидалось 1 место, найдено ${group}`);

    log(`эффекты переведены с DYNAMIC_BSP на AVERAGE_Z (${sorting} мест + ${guards} проверки), ` +
        `resolveByOOBB выключен у ${map + group} контейнеров`);
    return { edits: sorting + guards + map + group };
  },
};
