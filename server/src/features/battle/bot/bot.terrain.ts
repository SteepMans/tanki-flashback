import { IVector3 } from "@/shared/types/geom/ivector3";

/**
 * Опора под ботом: высота рельефа под корпусом и наклон корпуса по этой опоре.
 *
 * Живой танк на склоне повёрнут вокруг ТРЁХ осей — курс, тангаж (нос вверх/вниз) и крен (завален на
 * борт), — и его клиент шлёт все три в `orientation` пакета движения. Бот слал только курс, поэтому
 * на пандусе и на холме ехал «плашмя»: корпус горизонтален, половина его утоплена в склоне.
 *
 * Наклон снимается так же, как его чувствует подвеска: высота опоры меряется под четырьмя «катками» —
 * впереди/сзади и слева/справа от центра корпуса, — и через них проводится плоскость. Брать нормаль
 * одного треугольника карты нельзя: на стыке пандуса и пола корпус переламывался бы рывком, а под
 * гусеницами вообще может лежать не треугольник, а верх коробки (у неё нормаль всегда вертикальна).
 */

/** Высота опоры в точке карты или null, если под точкой пустота. */
export type GroundProbe = (x: number, y: number) => number | null;

export interface IGroundContact {
    /** Высота опоры, на которой лежит корпус (без клиренса). */
    z: number;
    /** Единичная нормаль опоры, направленная вверх. */
    normal: IVector3;
}

/**
 * Насколько каток может оказаться ВЫШЕ центра, чтобы это ещё считалось склоном. Всё, что круче, —
 * уступ или стена, к которой танк прижался бортом; наклонять по ней корпус нельзя, иначе танк у стены
 * встаёт на дыбы. Эта же величина задаёт потолок луча опоры (см. вызов в BotBrain).
 */
export const CONTACT_RISE = 170;
/** Насколько каток может провалиться НИЖЕ центра: дальше это уже край обрыва, а не спуск. */
export const CONTACT_SAG = 260;

const UP: IVector3 = { x: 0, y: 0, z: 1 };

const cross = (a: IVector3, b: IVector3): IVector3 => ({
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
});

/** Единичный вектор «вверх» из произвольного: нормирует и разворачивает вверх ногами вставшую нормаль. */
export function normalizeUp(n: IVector3): IVector3 {
    const len = Math.hypot(n.x, n.y, n.z);
    if (len < 1e-9) return { ...UP };
    // Треугольники карты намотаны в обе стороны, поэтому векторное произведение может смотреть вниз.
    const s = (n.z < 0 ? -1 : 1) / len;
    return { x: n.x * s, y: n.y * s, z: n.z * s };
}

/** Заваливает нормаль не круче `maxTilt` от вертикали: рисуем танк, а не физику опрокидывания. */
export function clampTilt(n: IVector3, maxTilt: number): IVector3 {
    const flat = Math.hypot(n.x, n.y);
    const limit = Math.tan(maxTilt) * Math.max(n.z, 1e-6);
    if (flat <= limit) return n;
    const s = Math.sin(maxTilt) / flat;
    return { x: n.x * s, y: n.y * s, z: Math.cos(maxTilt) };
}

/**
 * Оси корпуса в мире: X вправо, Y вперёд, Z вверх (правая тройка — X x Y = Z). Курс задаёт след
 * корпуса на плоскости, нормаль — куда «вверх».
 *
 * «Вперёд» получается ПОДЪЁМОМ курса по склону, а не поворотом его вокруг нормали: танк едет по земле,
 * и его след на плоскости обязан идти ровно по курсу, которым бот считает своё перемещение. Поворот
 * вокруг нормали увёл бы след в сторону, и корпус смотрел бы мимо направления движения.
 */
export function hullAxes(heading: number, up: IVector3): { right: IVector3; forward: IVector3 } {
    // Опора встала на ребро — осей по ней не построить, считаем поверхность плоской.
    if (up.z < 1e-6) return hullAxes(heading, UP);

    const fx = Math.cos(heading), fy = Math.sin(heading);
    // Подъём подобран так, чтобы «вперёд» лежало в плоскости опоры (было перпендикулярно нормали).
    const lift = -(fx * up.x + fy * up.y) / up.z;
    const len = Math.hypot(1, lift);
    const forward: IVector3 = { x: fx / len, y: fy / len, z: lift / len };
    return { right: cross(forward, up), forward };
}

/**
 * Углы Эйлера корпуса в том виде, в каком их ждёт клиент: порядок Rz*Ry*Rx (x — тангаж, y — крен,
 * z — курс). Тот же порядок сервер уже разбирает, когда строит ориентированную коробку корпуса под
 * мины (см. MineService.checkTriggers). На плоскости сводится к прежнему `курс - 90°`.
 */
export function orientationFromUp(heading: number, up: IVector3): IVector3 {
    const { right, forward } = hullAxes(heading, up);
    return {
        x: Math.atan2(forward.z, up.z),
        y: Math.atan2(-right.z, Math.hypot(right.x, right.y)),
        z: Math.atan2(right.y, right.x),
    };
}

/**
 * Угол башни ОТНОСИТЕЛЬНО КОРПУСА по её курсу в мире. Клиент держит башню дочерним объектом корпуса,
 * поэтому наклон корпуса в этот угол не входит, — на склоне ствол надо переводить в систему корпуса,
 * а не вычитать курс. На плоскости сводится к прежней разности `курс башни - курс корпуса`.
 */
export function turretAngleInHull(heading: number, up: IVector3, turretHeading: number): number {
    const { right, forward } = hullAxes(heading, up);
    const dx = Math.cos(turretHeading), dy = Math.sin(turretHeading);
    return Math.atan2(-(dx * right.x + dy * right.y), dx * forward.x + dy * forward.y);
}

/**
 * Обратный перевод: курс ствола В МИРЕ по углу башни относительно корпуса. Нужен там, где состоянием
 * служит именно угол в корпусе (башня прикручена к корпусу и едет вместе с ним), а стрелять надо по
 * мировому направлению. На плоскости сводится к сумме `курс корпуса + угол башни`.
 */
export function turretHeadingFromHull(heading: number, up: IVector3, angleInHull: number): number {
    const { right, forward } = hullAxes(heading, up);
    const c = Math.cos(angleInHull), s = Math.sin(angleInHull);
    // Решение системы d·forward = k*cos, d·right = -k*sin относительно горизонтального d.
    const det = forward.x * right.y - forward.y * right.x;
    if (Math.abs(det) < 1e-9) return heading + angleInHull;
    const dx = (right.y * c + forward.y * s) / det;
    const dy = -(right.x * c + forward.x * s) / det;
    return Math.atan2(dy, dx);
}

/**
 * Опора под корпусом: четыре катка вокруг центра дают плоскость, по ней — нормаль и высота посадки.
 * `halfLength`/`halfWidth` — полуразмеры корпуса вдоль и поперёк курса. null — под центром пустота.
 */
export function sampleGroundContact(
    probe: GroundProbe,
    x: number,
    y: number,
    heading: number,
    halfLength: number,
    halfWidth: number,
): IGroundContact | null {
    const centre = probe(x, y);
    if (centre === null) return null;

    const fx = Math.cos(heading), fy = Math.sin(heading);
    const rx = Math.sin(heading), ry = -Math.cos(heading);

    const contact = (ox: number, oy: number): number => {
        const z = probe(x + ox, y + oy);
        if (z === null) return centre;                 // за краем опоры — гусеница висит, корпус это не кренит
        // Проба, ушедшая далеко вверх, стоит НЕ на склоне: это верх уступа или стены, в которую танк
        // упёрся бортом. Проба, провалившаяся далеко вниз, — край обрыва. Такие пробы ОТБРАСЫВАЕМ, а не
        // обрезаем по пределу: обрезанная всё равно задирала корпус на максимум и вместе с ним поднимала
        // всю посадку (высота берётся по самой высокой опоре) — танк у стены вставал на дыбы и всплывал.
        if (z > centre + CONTACT_RISE || z < centre - CONTACT_SAG) return centre;
        return z;
    };

    const front = contact(fx * halfLength, fy * halfLength);
    const back = contact(-fx * halfLength, -fy * halfLength);
    const right = contact(rx * halfWidth, ry * halfWidth);
    const left = contact(-rx * halfWidth, -ry * halfWidth);

    // Две касательные к опоре: вдоль корпуса (нос - корма) и поперёк (борт - борт). Их произведение
    // в порядке «поперёк x вдоль» даёт нормаль вверх — тот же порядок, что и X x Y = Z у осей корпуса.
    const along: IVector3 = { x: fx * 2 * halfLength, y: fy * 2 * halfLength, z: front - back };
    const across: IVector3 = { x: rx * 2 * halfWidth, y: ry * 2 * halfWidth, z: right - left };

    // Лежим на САМОЙ ВЫСОКОЙ опоре: на переломе пандуса середина корпуса ниже краёв, и по средней
    // высоте танк въехал бы носом в землю.
    return {
        z: Math.max(centre, (front + back) / 2, (right + left) / 2),
        normal: normalizeUp(cross(across, along)),
    };
}
