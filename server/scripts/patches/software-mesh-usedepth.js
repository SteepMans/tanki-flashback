'use strict';
/**
 * software-mesh-usedepth (software.swf): добавляет классу Mesh свойство alternativa3d::useDepth.
 *
 * ЗАЧЕМ. Браузерная сборка использует программный рендерер вместо аппаратного: на Stage3D Ruffle
 * падает при трансляции AGAL-шейдера. Но библиотека игры написана под аппаратный рендерер и при
 * построении сцены гаража делает:
 *
 *     mesh.alternativa3d::useDepth = false;
 *
 * В hardware.swf это свойство есть, в software.swf — нет (там нет ни depth-прохода, ни теней).
 * Класс запечатан (SEALED), поэтому присваивание несуществующего свойства бросает ReferenceError.
 * Исключение ловится игрой выше по стеку и глушится, из-за чего окно гаража молча не строится:
 *
 *     model.initDepot -> controller.objectLoaded -> new TankPanel(...)
 *       -> setup3DScene: mesh.useDepth = false   ← ReferenceError
 *
 * Найдено пошаговой трассировкой (scripts/patches/browser-trace.js): конструктор доходил до
 * шага 48 из 83 и обрывался ровно на этом setproperty.
 *
 * ЧТО ДЕЛАЕТ. Добавляет в Mesh слот useDepth в неймспейсе alternativa3d. Программный рендерер его
 * не использует — значение просто хранится, — но присваивание перестаёт быть ошибкой, и построение
 * гаража продолжается.
 *
 * Сборка (software.swf лежит в webclient/sw под обоими именами — см. index.html):
 *
 *   node scripts/patch-client.js --only software-mesh-usedepth \
 *        --base webclient/sw/software.swf --out webclient/sw/hardware.swf
 */

// Свойство ставится не только на Mesh: игра проходит по всей сцене и трогает разные 3D-объекты.
// Поэтому добавляем его в корень иерархии Object3D — наследники получат его автоматически.
const TARGETS = [
  'instance QName(PackageNamespace("alternativa.engine3d.core"), "Object3D")',
  'instance QName(PackageNamespace("alternativa.engine3d.objects"), "Mesh")',
];
const ALTERNATIVA3D = 'Namespace("http://alternativaplatform.com/en/alternativa3d")';
const TRAIT = '  trait slot QName(' + ALTERNATIVA3D + ', "useDepth") ' +
              'type QName(PackageNamespace(""), "Boolean") end ; [software-mesh-usedepth]\n';

module.exports = {
  id: 'software-mesh-usedepth',
  swf: 'software',
  description: 'Добавляет Mesh.alternativa3d::useDepth в программный рендерер (нужно для гаража).',

  apply({ classes, log }) {
    let edits = 0;

    for (const c of classes) {
      const target = TARGETS.find((t) => c.text.includes(t));
      if (!target) continue;
      if (c.text.includes('[software-mesh-usedepth]')) continue;
      if (c.text.includes('"useDepth"')) continue; // в этом классе свойство уже есть

      // Вставляем трейт последним в списке трейтов экземпляра, перед закрывающим "end ; instance".
      const marker = '\n end ; instance';
      const at = c.text.indexOf(marker);
      if (at === -1) continue;

      c.save(c.text.slice(0, at) + '\n' + TRAIT + c.text.slice(at));
      log(target.slice(target.lastIndexOf('"', target.length - 3)).replace(/[")]/g, '') +
          ': добавлен alternativa3d::useDepth');
      edits++;
    }

    if (edits === 0) throw new Error('классы Object3D/Mesh не найдены — база точно software.swf?');
    return { edits };
  },
};
