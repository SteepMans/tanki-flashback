/**
 * Посадка бота на рельеф: высота корпуса по опоре и наклон по её нормали.
 *
 * Проверяется ровно то, чего боту не хватало: раньше в пакет движения уходил один курс, и на склоне
 * танк ехал «плашмя». Ключевая проверка — обратная сборка: углы Эйлера, которые уходят клиенту,
 * прогоняются через ту же матрицу Rz*Ry*Rx, которую сервер строит для мин (MineService.checkTriggers),
 * и её ось Z обязана совпасть с нормалью склона.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { gameResourceTest } from "./helpers/game-resources";
import { CollisionService } from "@/features/battle/collision.service";
import {
    clampTilt,
    hullAxes,
    orientationFromUp,
    sampleGroundContact,
    turretAngleInHull,
} from "@/features/battle/bot/bot.terrain";

const mapCollision = require("@/maps/mapCollision") as typeof import("@/maps/mapCollision");

/** Полуразмеры корпуса «хантер» — те же, по которым бот меряет опору. */
const HALF_LENGTH = 262;
const HALF_WIDTH = 165;

const RIDE_HEIGHT = 90;

/** Локальная ось Z корпуса из углов Эйлера — третий столбец матрицы Rz*Ry*Rx (см. MineService). */
function hullUp(o: { x: number; y: number; z: number }): { x: number; y: number; z: number } {
    const sx = Math.sin(o.x), cx = Math.cos(o.x);
    const sy = Math.sin(o.y), cy = Math.cos(o.y);
    const sz = Math.sin(o.z), cz = Math.cos(o.z);
    return { x: cz * sy * cx + sz * sx, y: sz * sy * cx - cz * sx, z: cy * cx };
}

/** Локальная ось Y корпуса («вперёд») — второй столбец той же матрицы. */
function hullForward(o: { x: number; y: number; z: number }): { x: number; y: number; z: number } {
    const sx = Math.sin(o.x), cx = Math.cos(o.x);
    const sy = Math.sin(o.y), cy = Math.cos(o.y);
    const sz = Math.sin(o.z), cz = Math.cos(o.z);
    return { x: cz * sy * sx - sz * cx, y: sz * sy * sx + cz * cx, z: cy * sx };
}

const close = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) <= eps;

/** Наклонная плоскость z = base + slope * x как источник высот (пол без единой коробки). */
const rampProbe = (base: number, slope: number) => (x: number, _y: number): number => base + slope * x;

test("на ровном полу бот наклонён так же, как раньше: только курс", () => {
    const flat = () => 0;
    for (const facing of [0, 0.7, -2.1, Math.PI]) {
        const contact = sampleGroundContact(flat, 100, -50, facing, HALF_LENGTH, HALF_WIDTH);
        assert.ok(contact);
        assert.equal(contact.z, 0);
        // Никакого наклона: нормаль строго вверх.
        assert.ok(close(contact.normal.z, 1));

        const o = orientationFromUp(facing, contact.normal);
        assert.ok(close(o.x, 0), `тангаж на ровном полу: ${o.x}`);
        assert.ok(close(o.y, 0), `крен на ровном полу: ${o.y}`);
        // Прежняя формула курса: корпус смотрит вдоль модельного +Y, отсюда сдвиг на 90 градусов.
        const expected = Math.atan2(Math.sin(facing - Math.PI / 2), Math.cos(facing - Math.PI / 2));
        assert.ok(close(o.z, expected), `курс ${o.z} вместо ${expected}`);

        // И башня считается прежней разностью курсов.
        for (const turret of [0, 1.2, -0.4]) {
            const packet = turretAngleInHull(facing, contact.normal, turret);
            const old = Math.atan2(Math.sin(turret - facing), Math.cos(turret - facing));
            assert.ok(close(packet, old), `башня ${packet} вместо ${old}`);
        }
    }
});

test("на склоне корпус встаёт по нормали: подъём даёт тангаж, траверс — крен", () => {
    const slope = Math.tan(0.35); // ~20 градусов вверх по +X
    const probe = rampProbe(0, slope);
    const normal = { x: -Math.sin(0.35), y: 0, z: Math.cos(0.35) };

    // Едем прямо в гору (курс вдоль +X) — заваливается тангаж, крена нет.
    const up = sampleGroundContact(probe, 0, 0, 0, HALF_LENGTH, HALF_WIDTH);
    assert.ok(up);
    const uphill = orientationFromUp(0, up.normal);
    assert.ok(Math.abs(uphill.x) > 0.3, `тангаж на подъёме слишком мал: ${uphill.x}`);
    assert.ok(close(uphill.y, 0, 1e-9), `крена на подъёме быть не должно: ${uphill.y}`);

    // Едем поперёк склона (курс вдоль +Y) — теперь наоборот.
    const across = sampleGroundContact(probe, 0, 0, Math.PI / 2, HALF_LENGTH, HALF_WIDTH);
    assert.ok(across);
    const traverse = orientationFromUp(Math.PI / 2, across.normal);
    assert.ok(close(traverse.x, 0, 1e-9), `тангажа на траверсе быть не должно: ${traverse.x}`);
    assert.ok(Math.abs(traverse.y) > 0.3, `крен на траверсе слишком мал: ${traverse.y}`);

    // Нормаль плоскости снята верно при любом курсе.
    for (const contact of [up, across]) {
        assert.ok(close(contact.normal.x, normal.x, 1e-6));
        assert.ok(close(contact.normal.y, normal.y, 1e-6));
        assert.ok(close(contact.normal.z, normal.z, 1e-6));
    }
});

test("углы, уходящие клиенту, восстанавливают ту же нормаль и тот же курс", () => {
    const probe = rampProbe(0, Math.tan(0.3));
    for (const facing of [0, 0.9, -1.7, 2.6, Math.PI]) {
        const contact = sampleGroundContact(probe, 500, 500, facing, HALF_LENGTH, HALF_WIDTH);
        assert.ok(contact);
        const o = orientationFromUp(facing, contact.normal);

        // Ось Z корпуса из углов Эйлера = нормаль опоры. Значит клиент нарисует танк ПО ЗЕМЛЕ.
        const z = hullUp(o);
        assert.ok(close(z.x, contact.normal.x, 1e-9), `нормаль x: ${z.x} вместо ${contact.normal.x}`);
        assert.ok(close(z.y, contact.normal.y, 1e-9), `нормаль y: ${z.y} вместо ${contact.normal.y}`);
        assert.ok(close(z.z, contact.normal.z, 1e-9), `нормаль z: ${z.z} вместо ${contact.normal.z}`);

        // Ось Y корпуса — «вперёд»: её след на плоскости идёт ровно по курсу, которым бот считает
        // своё перемещение, иначе корпус смотрел бы мимо направления движения.
        const f = hullForward(o);
        const heading = Math.atan2(f.y, f.x);
        assert.ok(close(Math.atan2(Math.sin(heading - facing), Math.cos(heading - facing)), 0, 1e-9),
            `корпус смотрит на ${heading} вместо ${facing}`);

        // И оси, по которым считается башня, совпадают с осями матрицы.
        const axes = hullAxes(facing, contact.normal);
        assert.ok(close(axes.forward.x, f.x, 1e-9) && close(axes.forward.y, f.y, 1e-9) && close(axes.forward.z, f.z, 1e-9));
    }
});

test("башня на склоне сведена на цель настолько, насколько позволяет наклон корпуса", () => {
    const probe = rampProbe(0, Math.tan(0.4));
    const facing = 1.1;
    const contact = sampleGroundContact(probe, 0, 0, facing, HALF_LENGTH, HALF_WIDTH)!;
    const axes = hullAxes(facing, contact.normal);

    // Башня — дочерний объект корпуса и крутится ВОКРУГ ЕГО оси Z, поэтому на склоне ствол ходит по
    // наклонному конусу и точно в горизонтальный азимут цели не встаёт (у живого игрока — ровно так же).
    // Проверяем, что выбран лучший из возможных углов: любое отклонение уводит ствол ОТ цели.
    for (const turret of [0, 0.8, -2.4, 3.0]) {
        const angle = turretAngleInHull(facing, contact.normal, turret);
        const best = (a: number) => {
            const dir = {
                x: -Math.sin(a) * axes.right.x + Math.cos(a) * axes.forward.x,
                y: -Math.sin(a) * axes.right.y + Math.cos(a) * axes.forward.y,
            };
            return dir.x * Math.cos(turret) + dir.y * Math.sin(turret);
        };
        for (const step of [-0.2, -0.05, 0.05, 0.2]) {
            assert.ok(best(angle) >= best(angle + step) - 1e-12,
                `угол башни ${angle} хуже соседнего ${angle + step}`);
        }
        // И на ровном месте это по-прежнему простая разность курсов.
        const flat = turretAngleInHull(facing, { x: 0, y: 0, z: 1 }, turret);
        assert.ok(close(flat, Math.atan2(Math.sin(turret - facing), Math.cos(turret - facing))));
    }
});

test("упор в стену не кренит корпус и не поднимает его", () => {
    // Стена в 400 единиц высотой перед носом. Каток, попавший ВНУТРЬ неё, находит её верх — и если
    // такую пробу засчитать, танк встаёт на дыбы и всплывает по стене тик за тиком.
    const wall = (x: number, _y: number): number => (x > 100 ? 400 : 0);
    const contact = sampleGroundContact(wall, 0, 0, 0, HALF_LENGTH, HALF_WIDTH);
    assert.ok(contact);
    assert.equal(contact.z, 0, `упор в стену поднял посадку до ${contact.z}`);
    assert.ok(close(contact.normal.z, 1), `упор в стену завалил корпус: ${contact.normal.z}`);

    // А настоящий пологий уступ под гусеницей корпус наклоняет.
    const ledge = (x: number, _y: number): number => (x > 100 ? 120 : 0);
    const onLedge = sampleGroundContact(ledge, 0, 0, 0, HALF_LENGTH, HALF_WIDTH);
    assert.ok(onLedge);
    assert.ok(onLedge.normal.z < 0.99, 'пологий уступ должен наклонять корпус');

    const steep = clampTilt({ x: 0.9, y: 0, z: 0.436 }, 0.6);
    assert.ok(close(steep.z, Math.cos(0.6), 1e-9), `предел наклона не соблюдён: ${steep.z}`);
    assert.ok(close(Math.hypot(steep.x, steep.y), Math.sin(0.6), 1e-9));
    // Пологий склон остаётся как есть.
    const gentle = { x: 0.1, y: 0, z: Math.sqrt(1 - 0.01) };
    assert.deepEqual(clampTilt(gentle, 0.6), gentle);
});

gameResourceTest("на пандусе реальной карты бот и наклоняется, и едет по высоте склона", () => {
    // Пандус Песочницы: полоса x от -2386 до -1614 при y около 500, перепад 300 единиц по высоте.
    const service = new CollisionService();
    const map = "map/sandbox/summer/xml";
    assert.ok(mapCollision.getMapCollision(map).triangles.length > 0, "коллизия карты не собрана");

    const probeAt = (fromZ: number) => (x: number, y: number) => service.raycastGroundZ(map, x, y, fromZ);

    const heights: number[] = [];
    let tilted = 0;
    for (const x of [-2300, -2150, -2000, -1850, -1700]) {
        // Курс вдоль пандуса (в гору по -X): корпус должен задрать нос.
        const contact = sampleGroundContact(probeAt(1200), x, 500, Math.PI, HALF_LENGTH, HALF_WIDTH);
        assert.ok(contact, `под точкой ${x} нет опоры`);
        heights.push(contact.z + RIDE_HEIGHT);

        const o = orientationFromUp(Math.PI, contact.normal);
        assert.ok(Number.isFinite(o.x) && Number.isFinite(o.y) && Number.isFinite(o.z));
        if (Math.abs(o.x) > 0.15) tilted++;
        assert.ok(Math.abs(o.y) < 0.05, `на продольном пандусе крена быть не должно: ${o.y}`);
    }

    assert.ok(tilted >= 3, `корпус должен наклоняться по пандусу (наклонён в ${tilted} точках из 5)`);
    // Высота идёт по склону и нигде не стоит на месте — Z следует за поверхностью, а не держится ровно.
    for (let i = 1; i < heights.length; i++) {
        assert.ok(heights[i] > heights[i - 1], `высота не идёт по склону: ${heights.join(" -> ")}`);
    }
    assert.ok(heights[heights.length - 1] - heights[0] > 150, `перепад по пандусу слишком мал: ${heights.join(" -> ")}`);
});
