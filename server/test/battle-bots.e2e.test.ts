/**
 * e2e ботов: полноценный матч без единого сокета. Поднимаем НАСТОЯЩИЕ BattleService/LobbyService на
 * заглушке сервера, сажаем ботов в бой и прокручиваем общий такт ИИ на синтетических часах —
 * то есть проверяем ровно то, что происходит в бою: спавн, движение по карте с коллизиями, стрельба,
 * фраги, смерть и возрождение, флаг в CTF, точки в CP и совместные действия команды.
 */
import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import { gameResourceTest } from './helpers/game-resources';
import { BattleMode, BattleRoundState, EquipmentConstraintsMode, IBattleCreationSettings, MapTheme } from '../src/features/battle/battle.model';
import { BattleService } from '../src/features/battle/battle.service';
import { BattleWorkflow } from '../src/features/battle/battle.workflow';
import { createBotUser } from '../src/features/battle/bot/bot.client';
import { LobbyService } from '../src/features/lobby/lobby.service';
import { RankService } from '../src/shared/services/rank.service';
import { UserDocument } from '../src/shared/models/user.model';
import { ResourceManager } from '../src/utils/resource.manager';
import { ActivateTankPacket, DestroyTankPacket, FullMovePacket, KillPacket, MovePacket, SpawnPacket, TankModelDataPacket, TurretRotationPacket, UserConnectTeamPacket } from '../src/features/battle/battle.packets';
import { LoadDependencies } from '../src/features/loader/loader.packets';
import { getMapSpawns } from '../src/maps/mapData';
import { getTurretMod } from '../src/config/turrets.data';
import { getHullMod } from '../src/config/hulls.data';
import { ItemUtils } from '../src/utils/item.utils';
import { itemBlueprints } from '../src/features/garage/garage.data';
import { FinishBattlePacket } from '../src/features/battle/battle.packets';
import { decodeBody, defs } from 'protanki-protocol';
import { battleDataObject } from '../src/config/battle.data';

const TICK_MS = 100;

function makeSettings(over: Partial<IBattleCreationSettings>): IBattleCreationSettings {
    return {
        name: 'bots', privateBattle: false, proBattle: false, battleMode: BattleMode.TDM,
        mapId: 'map_sandbox', maxPeopleCount: 10, minRank: 1, maxRank: 30, timeLimitInSec: 600,
        scoreLimit: 5, autoBalance: false, friendlyFire: false, parkourMode: false,
        equipmentConstraintsMode: EquipmentConstraintsMode.NONE, reArmorEnabled: true, mapTheme: MapTheme.SUMMER,
        withoutBonuses: false, withoutCrystals: false, withoutSupplies: false, withoutUpgrades: false,
        reducedResistances: false, esportDropTiming: false, withoutGoldBoxes: false, withoutGoldSiren: false,
        withoutGoldZone: false, withoutMedkit: false, withoutMines: false, randomGold: false,
        dependentCooldownEnabled: false, ...over,
    };
}

/** Заглушка сервера: только то, что реально дёргает боевой код (реестр клиентов + мелкие сервисы). */
function makeStand() {
    const clients: any[] = [];
    const byName = new Map<string, any>();
    const callbacks = new Map<number, any>();
    let nextCallbackId = 1;

    const server: any = {
        // Колбэки загрузки ресурсов держим наружу: тест играет за клиент, который их подтверждает.
        _callbacks: callbacks,
        rankService: new RankService(),
        rankedService: undefined,
        garageService: { clearEquipCooldowns: () => { } },
        userService: { updateResources: async (_id: string, payload: any) => ({ ...payload }) },
        questService: { applyQuestEvent: async () => false },
        clanService: { applyRoundContribution: async () => { } },
        isRestartPending: () => false,
        addClient: (c: any) => clients.push(c),
        removeClient: (c: any) => {
            const i = clients.indexOf(c);
            if (i >= 0) clients.splice(i, 1);
            const name = c.user?.username.toLowerCase();
            if (name && byName.get(name) === c) byName.delete(name);
        },
        indexAuthenticatedClient: (c: any) => { if (c.user) byName.set(c.user.username.toLowerCase(), c); },
        findClientByUsername: (name: string) => byName.get(name.toLowerCase()),
        getClients: () => clients,
        broadcastToBattleList: () => { },
        registerDynamicCallback: (cb: any) => { const id = nextCallbackId++; callbacks.set(id, cb); return id; },
        removeDynamicCallback: (id: number) => { callbacks.delete(id); },
    };

    const lobbyService = new LobbyService();
    const battleService = new BattleService(server, lobbyService);
    server.battleService = battleService;
    server.lobbyService = lobbyService;
    return { server, lobbyService, battleService };
}

/** «Живой» игрок в ростере: без него боты в бою не появляются (и правильно — пустой бой должен умирать). */
function addHuman(battle: any, username = 'Tester', rank = 5): UserDocument {
    const human = createBotUser(username, rank, 0, { hull: 'hunter', turret: 'smoky', mod: 0, paint: 'green' });
    if (battle.isTeamMode()) battle.usersRed.push(human);
    else battle.users.push(human);
    return human;
}

/**
 * Бои, заведённые тестом. Отряд ботов взводит РЕАЛЬНЫЙ таймер боя, и если тест упадёт на assert, до
 * своей уборки он не дойдёт — такт продолжит крутиться в реальном времени до конца прогона: процесс не
 * завершится, а лог зальёт спавнами. Поэтому уборка висит на afterEach и срабатывает при любом исходе.
 */
const liveBattles: { stand: ReturnType<typeof makeStand>; battle: any }[] = [];

afterEach(() => {
    for (const { stand, battle } of liveBattles.splice(0)) {
        try {
            battle.timers.clearAll();
            stand.battleService.bots.removeAll(battle);
        } catch { /* бой мог быть убран самим тестом */ }
    }
});

function trackBattle(stand: ReturnType<typeof makeStand>, battle: any): any {
    liveBattles.push({ stand, battle });
    return battle;
}

function startedBattle(stand: ReturnType<typeof makeStand>, over: Partial<IBattleCreationSettings>) {
    const battle = stand.lobbyService.createBattle(makeSettings(over), undefined);
    // Игрок попадает только в бой по своему званию, поэтому в тестовом бою он ровно посередине окна:
    // от его звания теперь зависит и звание подсаженных ботов.
    addHuman(battle, 'Tester', Math.round((battle.settings.minRank + battle.settings.maxRank) / 2));
    battle.roundState = BattleRoundState.RUNNING;
    battle.roundStartTime = Date.now();
    stand.battleService.bots.onRosterChanged(battle);
    // Такт ИИ прогоняем вручную — реальный таймер боя тут только мешал бы.
    battle.timers.clearAll();
    return trackBattle(stand, battle);
}

const botsOf = (battle: any) => [...battle.clients].filter((c: any) => c.isBot);

/**
 * Синтетические часы такта. Общие на весь прогон и только вперёд: внутри ИИ время живёт абсолютными
 * отметками («до этого момента едем таким курсом», «столько молчим»), и если следующий вызов начнёт
 * отсчёт заново от Date.now(), для бота эти отметки окажутся в будущем — он замрёт и перестанет
 * вещать. Тесту из нескольких фаз это ломало бы ровно то, что он проверяет во второй фазе.
 */
let clock = Date.now();

/** Крутит общий такт ИИ, пока не сработает `until` или не кончится бюджет тиков. */
async function runMatch(stand: ReturnType<typeof makeStand>, battle: any, ticks: number, until?: () => boolean): Promise<number> {
    for (let i = 0; i < ticks; i++) {
        clock += TICK_MS;
        stand.battleService.bots.advance(battle, clock);
        // Урон и фраги долетают через промисы — даём им сойтись.
        if (i % 25 === 0) await new Promise((r) => setTimeout(r, 0));
        if (until && until()) return i;
    }
    await new Promise((r) => setTimeout(r, 0));
    return ticks;
}

gameResourceTest('боты отыгрывают матч TDM: спавнятся, ездят, стреляют, умирают и добивают раунд до лимита', async () => {
    const stand = makeStand();
    const battle: any = startedBattle(stand, { battleMode: BattleMode.TDM, botCount: 6, scoreLimit: 5 });

    assert.equal(stand.battleService.bots.count(battle), 6);
    // Боты распределены по командам, а не свалены в одну.
    assert.ok(battle.usersRed.length >= 3 && battle.usersBlue.length >= 3, 'боты должны выровнять составы');

    const bots = botsOf(battle);
    assert.equal(bots.length, 6);

    // Ждём, пока все окажутся на поле, и запоминаем стартовые позиции.
    await runMatch(stand, battle, 200, () => botsOf(battle).every((b: any) => b.battlePosition !== null));
    const spawnPositions = new Map<string, any>(bots.map((b: any) => [b.user.username, { ...b.battlePosition }]));
    assert.equal(spawnPositions.size, 6);
    for (const b of bots) assert.ok(b.battlePosition, `${b.user.username} должен появиться на карте`);

    await runMatch(stand, battle, 6000, () => battle.roundState === BattleRoundState.FINISHED);

    const moved = bots.filter((b: any) => {
        const from = spawnPositions.get(b.user.username)!;
        return Math.hypot(b.battlePosition.x - from.x, b.battlePosition.y - from.y) > 500;
    });
    assert.ok(moved.length >= 4, `боты должны ездить по карте (сдвинулись: ${moved.length}/6)`);

    const kills = bots.reduce((s: number, b: any) => s + b.kills, 0);
    const deaths = bots.reduce((s: number, b: any) => s + b.deaths, 0);
    assert.ok(kills > 0, 'боты должны наносить смертельный урон друг другу');
    assert.ok(deaths > 0, 'боты должны умирать');
    // Возрождение: после стольких смертей кто-то обязан снова стоять на поле живым.
    assert.ok(bots.some((b: any) => b.battleState === 'active'), 'боты должны возрождаться после смерти');
    assert.ok(bots.some((b: any) => b.battleScore > 0), 'фраги должны идти в счёт боя');
    assert.ok(battle.fund > 0, 'фонд битвы должен расти от фрагов ботов');
    assert.equal(battle.roundState, BattleRoundState.FINISHED, 'раунд должен закончиться по лимиту фрагов');

    battle.timers.clearAll();
    stand.battleService.bots.removeAll(battle);
});

gameResourceTest('боты едут по рельефу: корпус наклоняется по склону, а не идёт плашмя', async () => {
    const stand = makeStand();
    const battle: any = startedBattle(stand, { battleMode: BattleMode.TDM, botCount: 6, scoreLimit: 99999 });

    // Наклон корпуса и высота уходят клиенту одним объектом с battleOrientation (см. _publishMovement),
    // поэтому смотреть за ним — то же, что читать пакет движения.
    const bots = botsOf(battle);
    let tilted = 0;
    const heights = new Map<string, number[]>();

    await runMatch(stand, battle, 3000, () => {
        for (const bot of bots) {
            const o = bot.battleOrientation;
            if (!o || bot.battleState !== 'active') continue;
            assert.ok(Number.isFinite(o.x) && Number.isFinite(o.y) && Number.isFinite(o.z),
                `битые углы корпуса у ${bot.user.username}: ${JSON.stringify(o)}`);
            // Клиент рисует танк, а не физику опрокидывания: круче предела корпус не заваливается.
            assert.ok(Math.abs(o.x) <= 0.61 && Math.abs(o.y) <= 0.61,
                `${bot.user.username} завалился на бок: ${JSON.stringify(o)}`);
            if (Math.abs(o.x) > 0.05 || Math.abs(o.y) > 0.05) tilted++;
            const track = heights.get(bot.user.username) ?? [];
            track.push(bot.battlePosition.z);
            heights.set(bot.user.username, track);
        }
        return false;
    });

    assert.ok(tilted > 0, 'на карте со склонами корпус обязан наклоняться хоть иногда');
    // И высота идёт по рельефу, а не держится на одном уровне весь бой.
    const climbed = [...heights.values()].filter((track) => Math.max(...track) - Math.min(...track) > 100);
    assert.ok(climbed.length > 0, 'боты должны подниматься и спускаться по рельефу');

    battle.timers.clearAll();
    stand.battleService.bots.removeAll(battle);
});

test('бот не всплывает по стене: за такт он поднимается не выше, чем мог бы въехать', async () => {
    const stand = makeStand();
    const battle: any = startedBattle(stand, { battleMode: BattleMode.TDM, botCount: 8, scoreLimit: 99999 });
    const bots = botsOf(battle);

    // Быстрее самого быстрого корпуса за такт не проехать, а въехать выше, чем tan(35°) от пройденного,
    // танк не может: всё, что выше, — запрыгивание на уступ (так бот и «всплывал» по стене из коробок).
    const MAX_RISE = 1200 * TICK_MS / 1000 * 0.7 + 2;
    const last = new Map<string, number>();
    let worst = 0;
    let worstBot = '';

    await runMatch(stand, battle, 3000, () => {
        for (const bot of bots) {
            if (bot.battleState !== 'active' || !bot.battlePosition) { last.delete(bot.user.username); continue; }
            const before = last.get(bot.user.username);
            const now = bot.battlePosition.z;
            // Появление — телепорт, по нему подъём не считаем.
            if (before !== undefined && now - before > worst) { worst = now - before; worstBot = bot.user.username; }
            last.set(bot.user.username, now);
        }
        return false;
    });

    assert.ok(worst <= MAX_RISE, `${worstBot} поднялся на ${worst.toFixed(0)} за такт (предел ${MAX_RISE.toFixed(0)})`);

    battle.timers.clearAll();
    stand.battleService.bots.removeAll(battle);
});

gameResourceTest('корпус едет у клиента сам: бот шлёт нажатые клавиши, а позицию — поправкой', async () => {
    const stand = makeStand();
    const battle: any = startedBattle(stand, { battleMode: BattleMode.TDM, botCount: 8, scoreLimit: 99999 });
    const bots = botsOf(battle);

    /*
     * Играем за принимающий клиент. Он ведёт чужой танк СВОЕЙ физикой по битам 0..4 поля `control`
     * (`_SafeStr_1833` в library.swf: бит0-бит1 — тяга, бит2-бит3 — руль, дальше прямо в физику танка),
     * а позицию из пакета применяет лишь как поправку, да и ту наполовину. Значит и проверять надо это:
     * держим объявленные клавиши, разгоняемся паспортными числами танка и смотрим, насколько нас потом
     * поправляют.
     */
    const FWD = 1 << 0, BACK = 1 << 1, LEFT = 1 << 2, RIGHT = 1 << 3;
    const FRAME = 1 / 60;
    const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

    const specs = new Map<string, { maxSpeed: number; accel: number; reverseAccel: number; maxTurn: number; turnAccel: number; reverseTurnAccel: number }>();
    for (const bot of bots) {
        const u = bot.user;
        const hullMod = ItemUtils.getItemModification(u, 'hull');
        const spec = ItemUtils.getTankSpecifications(u);
        const phys = getHullMod(u.equippedHull, u.hulls.get(u.equippedHull) ?? 0);
        const maxTurn = spec.maxTurnSpeed || 1.2;
        specs.set(u.username, {
            maxSpeed: (spec.speed || 8) * 100,
            accel: (ItemUtils.getPropertyValue(hullMod, 'HULL_POWER', 'HULL_ACCELERATION') ?? 10) * 100,
            reverseAccel: (phys?.reverseAcceleration ?? 18) * 100,
            maxTurn,
            turnAccel: phys?.turnAcceleration ?? maxTurn * 1.15,
            reverseTurnAccel: phys?.reverseTurnAcceleration ?? maxTurn * 2.0,
        });
    }

    /**
     * Один кадр физики клиента (закон из декомпилята _SafeStr_3091._SafeStr_12167 в library.swf):
     * тяга по ходу тает как (1 - |v|/vmax), выше половины паспорта работает «полка» 400 ед/с²,
     * ход против клавиши гасится reverse-ускорением, руль против доворота — reverse-ускорением поворота.
     */
    const clientDrive = (sim: { speed: number; yawRate: number }, control: number, step: number,
        spec: { maxSpeed: number; accel: number; reverseAccel: number; maxTurn: number; turnAccel: number; reverseTurnAccel: number }) => {
        const throttle = (control & (1 << 0)) ? 1 : (control & (1 << 1)) ? -1 : 0;
        let dv: number;
        if (throttle === 0) dv = Math.abs(sim.speed) <= spec.accel * step ? -sim.speed : -Math.sign(sim.speed) * spec.accel * step;
        else if (sim.speed !== 0 && Math.sign(sim.speed) !== throttle) dv = throttle * spec.reverseAccel * step;
        else dv = throttle * spec.accel * step;
        const clamped = Math.max(-spec.maxSpeed, Math.min(spec.maxSpeed, sim.speed + dv));
        dv = clamped - sim.speed;
        if (throttle !== 0 && sim.speed !== 0 && Math.sign(sim.speed) === throttle) dv *= Math.max(0, 1 - Math.abs(sim.speed) / spec.maxSpeed);
        const surge = dv / step;
        if (Math.abs(surge) < 400 && Math.abs(clamped) > spec.maxSpeed / 2) dv = (Math.abs(surge) <= 0.1 ? 0 : Math.sign(surge)) * 400 * step;
        sim.speed = Math.max(-spec.maxSpeed, Math.min(spec.maxSpeed, sim.speed + dv));

        const steer = (control & (1 << 2)) ? 1 : (control & (1 << 3)) ? -1 : 0;
        if (steer === 0) {
            const dw = spec.turnAccel * step;
            sim.yawRate = Math.abs(sim.yawRate) <= dw ? 0 : sim.yawRate - Math.sign(sim.yawRate) * dw;
        } else {
            const rate = sim.yawRate !== 0 && Math.sign(sim.yawRate) !== steer ? spec.reverseTurnAccel : spec.turnAccel;
            sim.yawRate = Math.max(-spec.maxTurn, Math.min(spec.maxTurn, sim.yawRate + steer * rate * step));
        }
    };

    type Sim = { x: number; y: number; yaw: number; speed: number; yawRate: number; tick: number; control: number };
    const sims = new Map<string, Sim>();
    const last = new Map<string, { x: number; y: number; speed: number; tick: number }>();
    let tick = 0;
    let movingPackets = 0;
    let movingNoKeys = 0;
    let overAccel = 0;
    let speedSamples = 0;
    const corrections: number[] = [];

    const observer: any = {
        user: createBotUser('Watcher', 5, 0, { hull: 'hunter', turret: 'smoky', mod: 0, paint: 'green' }),
        isBot: false, isSpectator: true, isDestroyed: false, isJoiningBattle: false,
        battleState: 'suicide', currentHealth: 0, battlePosition: null, activeEffects: [],
        kills: 0, deaths: 0, battleScore: 0, getState: () => 'battle', sendPacket: () => { },
        sendRaw: (b: Buffer, id: number) => {
            if (id !== FullMovePacket.getId()) return;
            const packet: any = new (FullMovePacket as any)({});
            packet.read(b);
            const nick = packet.nickname;
            const spec = nick ? specs.get(nick) : undefined;
            if (!nick || !spec) return;
            const yaw = packet.orientation.z;

            // Скорость, которую клиент видит по самим пакетам, и её изменение от пакета к пакету.
            const before = last.get(nick);
            const gapTicks = before ? tick - before.tick : 0;
            if (before && gapTicks >= 1 && gapTicks <= 3) {
                const dt = gapTicks * TICK_MS / 1000;
                const speed = Math.hypot(packet.position.x - before.x, packet.position.y - before.y) / dt;
                speedSamples++;
                // Двигатель не может изменить скорость быстрее паспортного ускорения. Всё, что резче, —
                // рывок: либо телепорт, либо удар в стену.
                // Торможение хода против клавиши идёт reverse-ускорением — оно у корпусов выше обычного.
                if (Math.abs(speed - before.speed) > Math.max(spec.accel, spec.reverseAccel) * dt * 1.05) overAccel++;
                if (speed > 50) {
                    movingPackets++;
                    if ((packet.control & (FWD | BACK)) === 0) movingNoKeys++;
                }
                last.set(nick, { x: packet.position.x, y: packet.position.y, speed, tick });
            } else {
                last.set(nick, { x: packet.position.x, y: packet.position.y, speed: 0, tick });
            }

            const sim = sims.get(nick);
            if (!sim) {
                sims.set(nick, { x: packet.position.x, y: packet.position.y, yaw, speed: 0, yawRate: 0, tick, control: packet.control });
                return;
            }
            const gap = (tick - sim.tick) * TICK_MS / 1000;
            if (gap > 0 && gap <= 0.5) {
                for (let t = 0; t < gap - 1e-9;) {
                    const step = Math.min(FRAME, gap - t);
                    clientDrive(sim, sim.control, step, spec);
                    sim.yaw = wrap(sim.yaw + sim.yawRate * step);
                    // Корпус смотрит вдоль модельной оси +Y, поэтому курс движения — orientation.z плюс 90.
                    const heading = sim.yaw + Math.PI / 2;
                    sim.x += Math.cos(heading) * sim.speed * step;
                    sim.y += Math.sin(heading) * sim.speed * step;
                    t += step;
                }
                corrections.push(Math.hypot(packet.position.x - sim.x, packet.position.y - sim.y));
            }
            sim.x = packet.position.x; sim.y = packet.position.y; sim.yaw = yaw;
            sim.control = packet.control; sim.tick = tick;
        },
    };
    observer.currentBattle = battle;
    battle.clients.add(observer);
    stand.server.indexAuthenticatedClient(observer);

    const TICKS = 1500;
    await runMatch(stand, battle, TICKS, () => {
        tick++;
        // Смерть — это телепорт: сравнивать позиции до и после возрождения нельзя.
        for (const bot of bots) if (bot.battleState !== 'active') { sims.delete(bot.user.username); last.delete(bot.user.username); }
        return false;
    });

    assert.ok(movingPackets > 500, `для проверки нужен поток движения, а пришло ${movingPackets} пакетов`);
    // Главное: едущий бот обязан говорить, что жмёт газ. Иначе чужой танк стоит с заглушенным мотором
    // и раз в такт прыгает к присланной точке — это и есть «резко и неестественно».
    const silentShare = movingNoKeys / movingPackets;
    assert.ok(silentShare < 0.35, `${(silentShare * 100).toFixed(0)}% пакетов едущего бота идут без нажатого газа`);
    // Скорость меняется не быстрее, чем позволяет двигатель: разгон и торможение, а не мгновенные скачки.
    const jerkShare = overAccel / Math.max(1, speedSamples);
    assert.ok(jerkShare < 0.05, `${(jerkShare * 100).toFixed(1)}% пакетов меняют скорость резче паспортного разгона`);

    // И поправка, которую клиенту приходится вносить, остаётся мелкой по меркам танка (~500 единиц).
    corrections.sort((a, b) => a - b);
    const median = corrections[Math.floor(corrections.length / 2)] ?? 0;
    const p95 = corrections[Math.floor(corrections.length * 0.95)] ?? 0;
    assert.ok(median < 20, `клиент промахивается мимо бота на ${median.toFixed(0)} единиц в половине пакетов`);
    assert.ok(p95 < 120, `в 5% пакетов клиента оттаскивает на ${p95.toFixed(0)} единиц`);

    battle.timers.clearAll();
    stand.battleService.bots.removeAll(battle);
});

test('разгон бота идёт по закону клиента: тяга тает с ростом скорости, а не рампой до предела', async () => {
    const stand = makeStand();
    const battle: any = startedBattle(stand, { battleMode: BattleMode.TDM, botCount: 2, scoreLimit: 99999 });
    const brain: any = (stand.battleService.bots as any).squads.get(battle.battleId)[0];
    const u = brain.user;

    const spec = ItemUtils.getTankSpecifications(u);
    const vmax = (spec.speed || 8) * 100;
    const accel = (ItemUtils.getPropertyValue(ItemUtils.getItemModification(u, 'hull'), 'HULL_POWER', 'HULL_ACCELERATION') ?? 10) * 100;

    /*
     * Эталон — закон разгона принимающего клиента на его кадровой сетке 60 Гц (декомпилят
     * _SafeStr_3091._SafeStr_12167 в library.swf): тяга по ходу тает как (1 - v/vmax), а выше
     * половины паспорта клиент толкает танк «полкой» ровно 400 ед/с² до самого предела. Прежняя
     * серверная рампа набирала предел за vmax/accel секунд — у клиента в этот момент скорость едва
     * за 60% паспорта, и каждый пакет стягивал его танк вперёд рывком.
     */
    const FRAME = 1 / 60;
    const ref = { v: 0 };
    const refFrame = () => {
        let dv = accel * FRAME;
        const clamped = Math.min(vmax, ref.v + dv);
        dv = clamped - ref.v;
        if (ref.v > 0) dv *= Math.max(0, 1 - ref.v / vmax);
        const surge = dv / FRAME;
        if (Math.abs(surge) < 400 && clamped > vmax / 2) dv = (surge > 0.1 ? 1 : 0) * 400 * FRAME;
        ref.v = Math.min(vmax, ref.v + dv);
    };

    // Сервер интегрирует тактами по 100 мс — профиль обязан лечь на клиентский поточечно.
    const rampEnd = vmax / accel; // момент, когда СТАРАЯ рампа уже упиралась в предел
    let v = 0;
    let atRampEnd = vmax;
    for (let t = 0; t < 2.5; t += 0.1) {
        v = brain._driveSpeed(v, 1, 0.1).speed;
        for (let i = 0; i < 6; i++) refFrame();
        assert.ok(Math.abs(v - ref.v) <= vmax * 0.02,
            `на ${(t + 0.1).toFixed(1)} с сервер разогнался до ${v.toFixed(0)}, клиент — до ${ref.v.toFixed(0)}`);
        if (t + 0.1 >= rampEnd && atRampEnd === vmax) atRampEnd = v;
    }
    // Контрольная точка против старой модели: когда рампа уже вышла бы на предел, клиентский закон
    // набирает лишь около двух третей — сервер обязан ехать так же, иначе клиента дёргает вперёд.
    assert.ok(atRampEnd < vmax * 0.8, `к концу старой рампы сервер уже разогнан до ${atRampEnd.toFixed(0)} из ${vmax}`);
    // Но до предела скорость всё же доходит — бот не остаётся вечно недоразогнанным.
    assert.ok(v >= vmax * 0.99, `за 2.5 с бот разогнался лишь до ${v.toFixed(0)} из ${vmax}`);

    battle.timers.clearAll();
    stand.battleService.bots.removeAll(battle);
});

test('башня едет у клиента сама: бот шлёт состояние вращения, а угол — редкой поправкой', async () => {
    const stand = makeStand();
    const battle: any = startedBattle(stand, { battleMode: BattleMode.TDM, botCount: 6, scoreLimit: 99999 });
    const bots = botsOf(battle);

    /*
     * Играем за принимающий клиент — и не «смотрим на угол», а КРУТИМ БАШНЮ ТАК ЖЕ, как это делает он
     * (см. _SafeStr_3016 в library.swf): по битам 5/6 поля `control` берётся направление, скорость
     * разгоняется паспортным ускорением до паспортной, угол наращивается каждый кадр, а пришедший в
     * пакете угол ПОДСТАВЛЯЕТСЯ как есть.
     *
     * Мера дёрганья — величина этой подстановки: у живого игрока клиент почти доводит башню сам, и
     * поправка микроскопическая; бот, шедший с control=0, переставлял башню на весь такт хода.
     */
    const TURRET_LEFT = 1 << 5;
    const TURRET_RIGHT = 1 << 6;
    const FRAME = 1 / 60;

    const specs = new Map<string, { maxSpeed: number; accel: number }>();
    for (const bot of bots) {
        const turret = bot.user.equippedTurret;
        const mod = getTurretMod(turret, bot.user.turrets.get(turret) ?? 0);
        const maxSpeed = ItemUtils.getTankSpecifications(bot.user).turretTurnSpeed || 1.5;
        specs.set(bot.user.username, { maxSpeed, accel: mod?.turretTurnAcceleration ?? maxSpeed * 1.6 });
    }

    type Sim = { angle: number; speed: number; dir: number; tick: number };
    const sims = new Map<string, Sim>();
    let tick = 0;
    let worstCorrection = 0;
    let worstBot = '';
    let corrections = 0;
    let sentPackets = 0;
    let sawRotation = false;

    const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

    /** Крутит башню столько секунд, сколько прошло, — кадрами, как клиент. */
    const spin = (sim: Sim, seconds: number, spec: { maxSpeed: number; accel: number }) => {
        for (let t = 0; t < seconds - 1e-9;) {
            const step = Math.min(FRAME, seconds - t);
            if (sim.dir === 0) sim.speed = 0;
            else {
                sim.speed = Math.max(-spec.maxSpeed, Math.min(spec.maxSpeed, sim.speed + sim.dir * spec.accel * step));
                sim.angle = wrap(sim.angle + sim.speed * step);
            }
            t += step;
        }
    };

    const apply = (nick: string, angle: number, control: number) => {
        const spec = specs.get(nick);
        if (!spec) return;
        sentPackets++;
        const sim = sims.get(nick);
        const dir = (control & TURRET_LEFT) ? 1 : (control & TURRET_RIGHT) ? -1 : 0;
        if (!sim) {
            sims.set(nick, { angle, speed: 0, dir, tick });
            return;
        }
        const gap = (tick - sim.tick) * TICK_MS / 1000;
        spin(sim, gap, spec);
        const correction = Math.abs(wrap(angle - sim.angle));
        // Разрыв больше полусекунды — это пауза вещания на входящего игрока, а не рывок башни.
        if (gap <= 0.5) {
            corrections++;
            if (correction > worstCorrection) { worstCorrection = correction; worstBot = nick; }
        }
        sim.angle = angle;
        if (dir !== sim.dir) sim.speed = 0;
        sim.dir = dir;
        sim.tick = tick;
    };

    const observer: any = {
        user: createBotUser('Watcher', 5, 0, { hull: 'hunter', turret: 'smoky', mod: 0, paint: 'green' }),
        isBot: false, isSpectator: true, isDestroyed: false, isJoiningBattle: false,
        battleState: 'suicide', currentHealth: 0, battlePosition: null, activeEffects: [],
        kills: 0, deaths: 0, battleScore: 0, getState: () => 'battle', sendPacket: () => { },
        sendRaw: (b: Buffer, id: number) => {
            if (id === TurretRotationPacket.getId()) {
                const packet: any = new (TurretRotationPacket as any)({});
                packet.read(b);
                if (!packet.nickname) return;
                sawRotation = true;
                apply(packet.nickname, packet.angle, packet.control);
                return;
            }
            if (id !== FullMovePacket.getId()) return;
            const packet: any = new (FullMovePacket as any)({});
            packet.read(b);
            if (!packet.nickname) return;
            apply(packet.nickname, packet.direction, packet.control);
        },
    };
    observer.currentBattle = battle;
    battle.clients.add(observer);
    stand.server.indexAuthenticatedClient(observer);

    const TICKS = 2000;
    await runMatch(stand, battle, TICKS, () => {
        tick++;
        // Смерть — это телепорт башни: сравнивать угол до и после возрождения нельзя.
        for (const bot of bots) if (bot.battleState !== 'active') sims.delete(bot.user.username);
        return false;
    });

    assert.ok(sawRotation, 'бот обязан слать дискретный RotateTurret на смене состояния вращения');
    assert.ok(corrections > 500, `для проверки нужен поток пакетов, а пришло ${corrections}`);
    // Клиент, который НЕ крутит башню сам, доворачивал бы её на весь такт хода — это до 13 градусов
    // на пакет, десять раз в секунду. Здесь он ведёт башню сам, и поправка остаётся в единицы градусов.
    assert.ok(worstCorrection < 0.1,
        `клиенту пришлось доворачивать башню ${worstBot} на ${(worstCorrection * 180 / Math.PI).toFixed(1)} градусов`);

    // Поток на клиент: плавная башня НЕ должна стоить лишних пакетов. Потолок прежний — такт на бота
    // плюс редкий дискретный RotateTurret на смену состояния башни.
    const budget = bots.length * TICKS * 1.1;
    assert.ok(sentPackets <= budget,
        `от ${bots.length} ботов за ${TICKS} тактов ушло ${sentPackets} пакетов движения (потолок ${budget | 0})`);

    battle.timers.clearAll();
    stand.battleService.bots.removeAll(battle);
});

test('снимок входа не крутит башни ботов: turretControl нулевой, а после паузы вещания поправка идёт сразу', async () => {
    const stand = makeStand();
    const battle: any = startedBattle(stand, { battleMode: BattleMode.TDM, botCount: 6, scoreLimit: 99999 });
    const bots = botsOf(battle);

    /*
     * Играем за принимающий клиент. Вошедшему игроку снимок боя отдаёт танки ботов через InitTank, и
     * бит вращения башни (5/6) оттуда клиент отрабатывает САМ — а боты ему на всё время входа молчат
     * (см. mute/BOT_STREAM_SETTLE_MS). Мгновенный срез «крутится», пойманный снимком, вертел башни
     * ботов секундами без единой поправки. Значит проверяем две вещи: в снимке башня бота ВСЕГДА стоит
     * (даже когда бот реально доворачивает прямо сейчас), а после конца паузы вещания состояние башни
     * доезжает первым же FullMove, не дожидаясь смены направления.
     */
    const TURRET_BITS = (1 << 5) | (1 << 6);
    let spinningNick: string | null = null;
    const received: string[] = [];
    const observer: any = {
        user: createBotUser('Watcher', 15, 0, { hull: 'hunter', turret: 'smoky', mod: 0, paint: 'green' }),
        isBot: false, isSpectator: true, isDestroyed: false, isJoiningBattle: false,
        battleState: 'suicide', currentHealth: 0, battlePosition: null, activeEffects: [],
        kills: 0, deaths: 0, battleScore: 0, getState: () => 'battle', sendPacket: () => { },
        sendRaw: (b: Buffer, id: number) => {
            if (id !== FullMovePacket.getId()) return;
            const packet: any = new (FullMovePacket as any)({});
            packet.read(b);
            if (!packet.nickname) return;
            received.push(packet.nickname);
            if ((packet.control & TURRET_BITS) !== 0) spinningNick = packet.nickname;
        },
    };
    observer.currentBattle = battle;
    battle.clients.add(observer);
    stand.server.indexAuthenticatedClient(observer);

    // Ловим такт, на котором какой-то бот РЕАЛЬНО крутит башню: биты 5/6 в его же пакете движения
    // сняты с текущего состояния — ровно в этот момент и заглядываем в снимок входа.
    await runMatch(stand, battle, 2000, () => spinningNick !== null);
    assert.ok(spinningNick, 'за бой ни один бот не покрутил башню — проверять нечего');

    const realIdlow = ResourceManager.getIdlowById;
    ResourceManager.getIdlowById = (() => 1) as any;
    try {
        for (const bot of bots.filter((b: any) => b.battleState === 'active')) {
            const snapshot = JSON.parse(BattleWorkflow.getTankModelDataJson(bot, battle));
            assert.equal(snapshot.turretControl, 0,
                `снимок входа крутит башню ${bot.user.username} (control=${snapshot.turretControl})`);
            assert.equal(snapshot.turretAngle, bot.turretAngle,
                `в снимке не текущий угол башни ${bot.user.username}`);
        }
    } finally {
        ResourceManager.getIdlowById = realIdlow;
    }

    // Вход игрока: боты молчат, пока он строит бой, и ещё BOT_STREAM_SETTLE_MS после подтверждения.
    const joiner: any = {
        user: createBotUser('Newbie', 15, 0, { hull: 'hunter', turret: 'smoky', mod: 0, paint: 'green' }),
        isBot: false, isSpectator: false, isDestroyed: false, isJoiningBattle: true, battleSnapshotPending: false,
        battleState: 'suicide', currentHealth: 0, battlePosition: null, activeEffects: [],
        kills: 0, deaths: 0, battleScore: 0, getState: () => 'battle', sendPacket: () => { }, sendRaw: () => { },
    };
    joiner.currentBattle = battle;
    battle.clients.add(joiner);
    received.length = 0;
    await runMatch(stand, battle, 10);
    assert.equal(received.length, 0, `во время входа игрока боты обязаны молчать, а ушло ${received.length} пакетов`);

    // Снимок разобран — идёт пауза дожития (1500 мс), вещания всё ещё нет.
    joiner.isJoiningBattle = false;
    await runMatch(stand, battle, 15);
    assert.equal(received.length, 0, 'пауза дожития после входа тоже должна быть тихой');

    // Пауза кончилась: каждый живой бот шлёт поправку в первые же такты — новичок сразу узнаёт и
    // фактический угол башни, и её действительное состояние вращения.
    const active = bots.filter((b: any) => b.battleState === 'active');
    assert.ok(active.length >= 3, `к концу паузы на поле осталось ${active.length} ботов — мало для проверки`);
    received.length = 0;
    await runMatch(stand, battle, 5);
    for (const bot of active.filter((b: any) => b.battleState === 'active')) {
        assert.ok(received.includes(bot.user.username),
            `${bot.user.username} не прислал поправку после конца паузы вещания`);
    }

    battle.timers.clearAll();
    stand.battleService.bots.removeAll(battle);
});

gameResourceTest('интерес по дистанции: дальнему движение ботов идёт редким кипэлайвом, вход в радиус — немедленный пакет', async () => {
    const stand = makeStand();
    const battle: any = startedBattle(stand, { battleMode: BattleMode.TDM, maxPeopleCount: 20, botCount: 16, scoreLimit: 99999 });
    const bots = botsOf(battle);
    assert.equal(bots.length, 16);

    /*
     * Играем за двух принимающих клиентов. Позиционные пакеты ботов — главный поток на клиент
     * (у браузерного каждое сообщение — отдельная задача main thread), а точная позиция нужна только
     * тем, кто рядом: чужой танк клиент ведёт сам по битам control. Дальнему уходит редкий кипэлайв
     * и немедленная смена клавиш; вход в радиус — сразу полный пакет, иначе телепорт.
     */
    let tick = 0;
    const makeObserver = (name: string, pos: { x: number; y: number; z: number } | null) => {
        const counts = new Map<string, number>();
        const keepalives = new Map<string, number>();
        const lastHull = new Map<string, number>();
        const firstAt = new Map<string, number>();
        const o: any = {
            user: createBotUser(name, 15, 0, { hull: 'hunter', turret: 'smoky', mod: 0, paint: 'green' }),
            isBot: false, isSpectator: false, isDestroyed: false, isJoiningBattle: false,
            battleState: 'active', currentHealth: 10000, battlePosition: pos, activeEffects: [],
            kills: 0, deaths: 0, battleScore: 0, getState: () => 'battle', sendPacket: () => { },
            counts, keepalives, firstAt,
            sendRaw: (b: Buffer, id: number) => {
                if (id !== FullMovePacket.getId()) return;
                const packet: any = new (FullMovePacket as any)({});
                packet.read(b);
                if (!packet.nickname) return;
                counts.set(packet.nickname, (counts.get(packet.nickname) ?? 0) + 1);
                if (!firstAt.has(packet.nickname)) firstAt.set(packet.nickname, tick);
                // Кипэлайв — позиционный пакет без смены клавиш корпуса (биты 0..4).
                const hull = packet.control & 0x1f;
                if (lastHull.get(packet.nickname) === hull) keepalives.set(packet.nickname, (keepalives.get(packet.nickname) ?? 0) + 1);
                lastHull.set(packet.nickname, hull);
            },
        };
        o.currentBattle = battle;
        battle.clients.add(o);
        stand.server.indexAuthenticatedClient(o);
        return o;
    };

    // Дальний стоит за пределами любой карты; ближний едет бок о бок с одним конкретным ботом.
    const far = makeObserver('FarWatcher', { x: 200000, y: 200000, z: 0 });
    const near = makeObserver('NearWatcher', { x: 0, y: 0, z: 0 });

    await runMatch(stand, battle, 200, () => bots.some((b: any) => b.battleState === 'active' && b.battlePosition));
    const target = bots.find((b: any) => b.battleState === 'active' && b.battlePosition)!;

    const SECONDS = 40;
    far.counts.clear(); far.keepalives.clear();
    near.counts.clear(); near.keepalives.clear();
    await runMatch(stand, battle, SECONDS * 10, () => {
        tick++;
        // Ближний наблюдатель держится вплотную к целевому боту — всегда внутри радиуса интереса.
        if (target.battlePosition) near.battlePosition = { x: target.battlePosition.x + 500, y: target.battlePosition.y, z: target.battlePosition.z };
        return false;
    });

    // Дальний: позиционные кипэлайвы — не чаще 1.2/с на бота.
    for (const bot of bots) {
        const ka = far.keepalives.get(bot.user.username) ?? 0;
        assert.ok(ka <= SECONDS * 1.2, `${bot.user.username} прислал дальнему ${ka} кипэлайвов за ${SECONDS} с`);
    }
    // Ближний — полный каденс: даже стоящий бот подтверждает позицию дважды в секунду.
    const nearFromTarget = near.counts.get(target.user.username) ?? 0;
    assert.ok(nearFromTarget >= SECONDS * 1.8, `ближний получил от своего бота всего ${nearFromTarget} пакетов за ${SECONDS} с`);
    // И дальнему тот же бот шлёт в разы меньше, чем ближнему.
    const farFromTarget = far.counts.get(target.user.username) ?? 0;
    assert.ok(farFromTarget < nearFromTarget * 0.5, `дальний получил ${farFromTarget} пакетов против ${nearFromTarget} у ближнего`);

    // Вход в радиус: дальний оказывается в гуще боя — каждый живой бот рядом обязан прислать полный
    // пакет в первые же такты, даже тихий (иначе первый близкий пакет дёргает танк телепортом).
    const hub = { ...target.battlePosition };
    const nearby = bots.filter((b: any) => b.battleState === 'active' && b.battlePosition
        && Math.hypot(b.battlePosition.x - hub.x, b.battlePosition.y - hub.y) < 3500);
    assert.ok(nearby.length >= 1, 'для проверки входа в радиус нужен хоть один бот в гуще боя');
    far.battlePosition = { ...hub };
    far.firstAt.clear();
    const entryTick = tick;
    await runMatch(stand, battle, 5, () => { tick++; return false; });
    for (const bot of nearby) {
        if (bot.battleState !== 'active') continue; // успел умереть — пакета и не будет
        const at = far.firstAt.get(bot.user.username);
        assert.ok(at !== undefined && at - entryTick <= 3,
            `${bot.user.username} не прислал немедленный пакет вошедшему в радиус (первый на такте ${at}, вход на ${entryTick})`);
    }

    battle.timers.clearAll();
    stand.battleService.bots.removeAll(battle);
});

gameResourceTest('бот не остаётся стоять в тупике: откатывается, разворачивается и уезжает', async () => {
    const stand = makeStand();
    // Карта с узкими проездами и ямами: именно на такой бот и утыкался носом в стену до конца боя.
    const battle: any = startedBattle(stand, { battleMode: BattleMode.TDM, mapId: 'map_solikamsk', maxPeopleCount: 12, botCount: 8, scoreLimit: 99999 });
    const bots = botsOf(battle);

    // «Стоит колом» — подряд идущие такты, за которые бот сдвинулся меньше чем на 5 единиц. Разворот
    // на месте и разгон сюда не попадают: там танк уже едет.
    const frozen = new Map<string, { x: number; y: number; ticks: number }>();
    let worst = 0;
    let worstBot = '';
    let frozenTicks = 0;
    const TICKS = 1200;

    await runMatch(stand, battle, TICKS, () => {
        for (const bot of bots) {
            const name = bot.user.username;
            if (bot.battleState !== 'active' || !bot.battlePosition) { frozen.delete(name); continue; }
            const before = frozen.get(name);
            if (!before || Math.hypot(bot.battlePosition.x - before.x, bot.battlePosition.y - before.y) > 5) {
                frozen.set(name, { x: bot.battlePosition.x, y: bot.battlePosition.y, ticks: 0 });
                continue;
            }
            before.ticks++;
            frozenTicks++;
            if (before.ticks > worst) { worst = before.ticks; worstBot = name; }
        }
        return false;
    });

    // До выхода из тупика бот застревал у стены на сотни тактов, а то и до конца раунда. Потолок —
    // безнадёжный случай (яма, из которой выезда нет): там бот ждёт HOPELESS_MS и самоуничтожается.
    assert.ok(worst <= 150, `${worstBot} простоял на месте ${worst} тактов подряд`);
    assert.ok(frozenTicks < TICKS * bots.length * 0.5,
        `отряд простоял ${frozenTicks} тактов из ${TICKS * bots.length} — это уже не бой`);

    battle.timers.clearAll();
    stand.battleService.bots.removeAll(battle);
});

gameResourceTest('после конца раунда боты замирают вместе с игроками: control=0 и ни шагу до рестарта', async () => {
    const stand = makeStand();
    const battle: any = startedBattle(stand, { battleMode: BattleMode.TDM, botCount: 6, scoreLimit: 99999 });
    const bots = botsOf(battle);

    /*
     * Играем за принимающий клиент. Живого игрока на табло результатов обездвиживает его собственный
     * клиент, а бот управляется с сервера — и продолжал ездить всю паузу перед рестартом. Проверять
     * надо именно то, что доехало до клиента: он ведёт чужой танк своей физикой по битам `control`,
     * поэтому бот, просто замолчавший на полном газу, у него всё равно поедет дальше.
     */
    const lastControl = new Map<string, number>();
    let finished = false;
    let packetsAfterFinish = 0;
    let keysAfterFinish = 0;

    const observer: any = {
        user: createBotUser('Watcher', 15, 0, { hull: 'hunter', turret: 'smoky', mod: 0, paint: 'green' }),
        isBot: false, isSpectator: true, isDestroyed: false, isJoiningBattle: false,
        battleState: 'suicide', currentHealth: 0, battlePosition: null, activeEffects: [],
        kills: 0, deaths: 0, battleScore: 0, getState: () => 'battle', sendPacket: () => { },
        sendRaw: (b: Buffer, id: number) => {
            if (id !== FullMovePacket.getId()) return;
            const packet: any = new (FullMovePacket as any)({});
            packet.read(b);
            if (!packet.nickname) return;
            lastControl.set(packet.nickname, packet.control);
            if (!finished) return;
            packetsAfterFinish++;
            if (packet.control !== 0) keysAfterFinish++;
        },
    };
    observer.currentBattle = battle;
    battle.clients.add(observer);
    stand.server.indexAuthenticatedClient(observer);

    await runMatch(stand, battle, 600);
    assert.ok([...lastControl.values()].some((c) => c !== 0), 'пока раунд идёт, боты должны жать клавиши');

    // Конец раунда — тем же путём, каким его заканчивает лимит очков или таймер.
    stand.battleService.finishBattle(battle);
    battle.timers.clearAll(); // пауза результатов взводит НАСТОЯЩИЙ таймер рестарта
    finished = true;
    assert.equal(battle.roundState, BattleRoundState.FINISHED);

    // Один такт паузы: он разносит стоп-пакеты и синхронизирует battlePosition с внутренней позицией
    // бота — на прямой публикация идёт раз в CRUISE_RESEND_MS, и к финишу она могла отставать на такт-
    // другой хода. Мерить замирание надо ОТ этой точки: скачок синхронизации клиент не видит (его
    // симуляция и так вела танк вперёд по нажатым клавишам).
    await runMatch(stand, battle, 1);
    const alive = bots.filter((b: any) => b.battleState === 'active' && b.battlePosition);
    assert.ok(alive.length >= 3, `на поле к концу раунда осталось ${alive.length} ботов — мало для проверки`);
    const frozenAt = new Map<string, any>(alive.map((b: any) => [b.user.username, { ...b.battlePosition }]));

    // Крутим паузу заведомо дольше, чем ждёт логика застревания (HOPELESS_MS = 12 c): бот стоит по
    // приказу, и она не имеет права ни разбудить его откатом, ни отправить на самоуничтожение.
    await runMatch(stand, battle, 200);

    assert.equal(keysAfterFinish, 0, `после конца раунда пришло ${keysAfterFinish} пакетов с нажатыми клавишами`);
    assert.ok(packetsAfterFinish > 0, 'клиенту должен уйти стоп-пакет, иначе он доедет начатое своей физикой');
    assert.ok(packetsAfterFinish <= bots.length,
        `за паузу ушло ${packetsAfterFinish} пакетов движения — это поток, а не остановка`);
    for (const bot of alive) {
        const from = frozenAt.get(bot.user.username)!;
        const drift = Math.hypot(bot.battlePosition.x - from.x, bot.battlePosition.y - from.y);
        assert.equal(drift, 0, `${bot.user.username} проехал ${drift.toFixed(0)} единиц после конца раунда`);
        assert.equal(bot.battleState, 'active', `${bot.user.username} не пережил паузу результатов`);
        assert.equal(lastControl.get(bot.user.username), 0, `клиент так и не узнал, что ${bot.user.username} встал`);
    }

    // И это не «застыли навсегда»: рестарт возвращает отряд в бой.
    stand.battleService.restartBattle(battle);
    battle.timers.clearAll();
    await runMatch(stand, battle, 400, () => botsOf(battle).every((b: any) => b.battleState === 'active'));
    const back = botsOf(battle).filter((b: any) => b.battleState === 'active' && b.battlePosition);
    assert.ok(back.length >= 3, `после рестарта на поле всего ${back.length} ботов`);
    const respawnedAt = new Map<string, any>(back.map((b: any) => [b.user.username, { ...b.battlePosition }]));

    await runMatch(stand, battle, 600);
    const moved = back.filter((b: any) => {
        const from = respawnedAt.get(b.user.username)!;
        return Math.hypot(b.battlePosition.x - from.x, b.battlePosition.y - from.y) > 500;
    });
    assert.ok(moved.length >= Math.ceil(back.length / 2), `после рестарта поехали ${moved.length} из ${back.length}`);

    battle.timers.clearAll();
    stand.battleService.bots.removeAll(battle);
});

test('в итоговой таблице у ботов ненулевые кристаллы — и у проигравшей стороны тоже', async () => {
    /** Разбирает FinishBattle так же, как его разберёт клиент: ник -> начисленные кристаллы. */
    const finishRewards = (raw: Buffer): Map<string, number> => {
        const decoded: any = decodeBody(defs.battle.FinishBattle, raw);
        return new Map<string, number>(decoded.fields.rewards.map((r: any) => [r.nickname, r.reward]));
    };

    /**
     * Играет бой заданное время и заканчивает раунд тем же путём, каким его заканчивает лимит или
     * таймер. Заканчиваем принудительно, а не по лимиту: сколько именно займёт доставка флага или пятый
     * фраг, зависит от того, как сложится бой, — а проверяем мы дележ фонда, а не скорость боя.
     */
    const playOut = async (over: Partial<IBattleCreationSettings>, ticks: number, arrange?: (battle: any) => void) => {
        const stand = makeStand();
        const battle: any = startedBattle(stand, over);
        let finish: Buffer | null = null;
        const observer: any = {
            user: createBotUser('Watcher', 15, 0, { hull: 'hunter', turret: 'smoky', mod: 0, paint: 'green' }),
            isBot: false, isSpectator: true, isDestroyed: false, isJoiningBattle: false,
            battleState: 'suicide', currentHealth: 0, battlePosition: null, activeEffects: [],
            kills: 0, deaths: 0, battleScore: 0, getState: () => 'battle', sendPacket: () => { },
            sendRaw: (b: Buffer, id: number) => { if (id === FinishBattlePacket.getId()) finish = b; },
        };
        observer.currentBattle = battle;
        battle.clients.add(observer);
        stand.server.indexAuthenticatedClient(observer);

        await runMatch(stand, battle, ticks, () => battle.roundState === BattleRoundState.FINISHED);
        arrange?.(battle);
        stand.battleService.finishBattle(battle);
        await new Promise((r) => setTimeout(r, 0));
        // Уборку делаем сразу: пауза результатов взводит настоящий таймер перезапуска раунда.
        battle.timers.clearAll();
        // Снимок делаем ДО уборки: снятие бота обнуляет его счёт вместе со снятием танка.
        const bots = botsOf(battle).map((b: any) => ({ nickname: b.user.username, score: b.battleScore, team: battle.teamOf(b.user) }));
        const fund = battle.fund;
        const winner = battle.scoreRed > battle.scoreBlue ? 0 : 1;
        stand.battleService.bots.removeAll(battle);
        assert.ok(finish, 'раунд должен закончиться и прислать итоговую таблицу');
        return { fund, winner, bots, rewards: finishRewards(finish!) };
    };

    // TDM: фонд делится по личным очкам, и бот, набравший очки, обязан получить свою долю.
    const dm = await playOut({ battleMode: BattleMode.TDM, botCount: 6, scoreLimit: 99999 }, 3000);
    assert.ok(dm.fund > 0, 'фрагами ботов фонд боя должен набраться');
    const scoring = dm.bots.filter((b) => b.score > 0);
    assert.ok(scoring.length >= 2, `набравших очки ботов всего ${scoring.length}`);
    for (const bot of scoring) {
        assert.ok((dm.rewards.get(bot.nickname) ?? 0) > 0,
            `${bot.nickname} со счётом ${bot.score} получил ${dm.rewards.get(bot.nickname)} кристаллов`);
    }

    // CTF: команда, проигравшая всухую, тоже играла — её боты не должны уйти с нулём.
    // Счёт по флагам ставим руками: 1:0 — самый обычный исход захвата, и именно на нём вся проигравшая
    // половина таблицы уходила с нулём. Ждать такого счёта от самого боя значило бы гадать на удачу.
    const ctf = await playOut({ battleMode: BattleMode.CTF, botCount: 6, scoreLimit: 99999 }, 4000, (battle: any) => {
        battle.scoreRed = 1;
        battle.scoreBlue = 0;
    });
    const losers = ctf.bots.filter((b) => b.team !== ctf.winner && b.score > 0);
    assert.ok(losers.length >= 1, 'у проигравшей стороны должен быть хоть кто-то со счётом');
    for (const bot of losers) {
        assert.ok((ctf.rewards.get(bot.nickname) ?? 0) > 0,
            `${bot.nickname} из проигравшей команды со счётом ${bot.score} получил ${ctf.rewards.get(bot.nickname)}`);
    }
});

gameResourceTest('боты не въезжают друг в друга: у общей цели корпуса держат дистанцию, а не стоят стопкой', async () => {
    const stand = makeStand();
    const battle: any = startedBattle(stand, { battleMode: BattleMode.TDM, botCount: 2, scoreLimit: 99999 });
    const bots = botsOf(battle);
    assert.equal(bots.length, 2);

    // Обоих — в одну команду: перестрелка разводила бы их сама (боевая дистанция), а проверяем мы
    // именно мирную стопку у общей цели.
    const botIds = new Set(bots.map((b: any) => b.user.id));
    battle.usersRed = [...battle.usersRed, ...battle.usersBlue.filter((u: any) => botIds.has(u.id))];
    battle.usersBlue = battle.usersBlue.filter((u: any) => !botIds.has(u.id));

    await runMatch(stand, battle, 300, () => bots.every((b: any) => b.battleState === 'active' && b.battlePosition));

    /*
     * Общая цель, которую нельзя израсходовать: золотой ящик, «прибитый» к месту заглушкой подбора.
     * За золотом бот бросает всё (см. BOT_TREASURE_TYPES) и целит в точку ящика с радиусом прибытия
     * в полкорпуса — то есть без расталкивания оба честно съезжаются В ОДНУ точку и стоят друг в
     * друге, пока цель не пропадёт. Ровно так отряд и складывался стопкой на золоте, точке сбора и
     * общем фокусе.
     */
    const spawns = getMapSpawns(battle.mapResourceId);
    assert.ok(spawns.length > 0, 'для общей цели нужна точка спавна карты');
    const magnet = { ...spawns[0].position };
    const realTake = stand.battleService.bonus.takeBonus;
    (stand.battleService.bonus as any).takeBonus = () => { };
    let worst = 0;
    let streak = 0;
    try {
        let goldId = stand.battleService.bonus.spawnBonus(battle, 'gold', magnet);
        const respawn = () => {
            if (!battle.activeBonuses.has(goldId)) goldId = stand.battleService.bonus.spawnBonus(battle, 'gold', magnet) || goldId;
        };
        const near = () => bots.every((b: any) => b.battlePosition
            && Math.hypot(b.battlePosition.x - magnet.x, b.battlePosition.y - magnet.y) < 800);
        await runMatch(stand, battle, 3000, () => { respawn(); return near(); });
        assert.ok(near(), 'оба бота должны собраться у общей цели');

        // Оба у цели. «Слиплись» — центры на одном ярусе ближе полукорпуса; меряем ПОДРЯД идущие
        // такты в этом состоянии: мгновенное сближение бывает честным (пролёт мимо на скорости),
        // а вот стоять внахлёст корпуса не должны.
        await runMatch(stand, battle, 400, () => {
            respawn();
            const [a, b] = bots.map((x: any) => x.battlePosition);
            const stacked = a && b && Math.abs(a.z - b.z) < 300 && Math.hypot(a.x - b.x, a.y - b.y) < 250;
            streak = stacked ? streak + 1 : 0;
            if (streak > worst) worst = streak;
            return false;
        });
    } finally {
        (stand.battleService.bonus as any).takeBonus = realTake;
    }

    assert.ok(worst <= 20, `боты простояли друг в друге ${worst} тактов подряд у общей цели`);
    // Расталкивание не отменяет саму цель: оба остаются при ящике, просто не внахлёст.
    for (const b of bots) {
        const d = Math.hypot(b.battlePosition.x - magnet.x, b.battlePosition.y - magnet.y);
        assert.ok(d < 1500, `${b.user.username} отъехал от общей цели на ${d.toFixed(0)}`);
    }

    battle.timers.clearAll();
    stand.battleService.bots.removeAll(battle);
});

gameResourceTest('боты собирают кристаллы и золото, а не объезжают их', async () => {
    const stand = makeStand();
    const battle: any = startedBattle(stand, { battleMode: BattleMode.TDM, botCount: 8, scoreLimit: 99999 });
    const bots = botsOf(battle);

    // Ждём, пока отряд окажется на поле, и раскладываем ящики прямо там, где боты ездят.
    await runMatch(stand, battle, 300, () => botsOf(battle).every((b: any) => b.battlePosition !== null));
    const alive = bots.filter((b: any) => b.battlePosition);
    assert.ok(alive.length >= 4, 'для проверки нужен отряд на поле');

    // Кристаллы кладём под ноги отряду — их бот берёт по пути. Золото раскладываем по ТОЧКАМ СПАВНА
    // карты: туда заведомо есть дорога, а координата «на столько-то в сторону от бота» легко попадает
    // внутрь стены, и тогда тест проверял бы проходимость карты, а не то, идёт ли бот за золотом.
    const spawns = getMapSpawns(battle.mapResourceId);
    assert.ok(spawns.length >= 4, 'для раскладки золота нужны точки спавна карты');
    const crystals = alive.slice(0, 4).map((bot: any) => stand.battleService.bonus.spawnBonus(
        battle, 'crystall', { x: bot.battlePosition.x + 700, y: bot.battlePosition.y, z: bot.battlePosition.z },
    ));
    const golds = spawns.slice(0, 4).map((sp) => stand.battleService.bonus.spawnBonus(battle, 'gold', { ...sp.position }));
    const dropped = [...crystals, ...golds];
    assert.equal(battle.activeBonuses.size >= dropped.length, true, 'ящики должны лечь на поле');

    const left = (ids: string[]) => ids.filter((id) => battle.activeBonuses.has(id)).length;
    await runMatch(stand, battle, 4000, () => left(dropped) === 0);

    // Золото бот бросает всё и едет за ним через полкарты, поэтому спрос с него полный.
    assert.equal(left(golds), 0, `на поле осталось ${left(golds)} из ${golds.length} золотых ящиков`);
    // Кристаллы бот собирает ПО ПУТИ и далеко за ними не ходит: тот, кого убили и подняли на другом
    // конце карты, за своим ящиком уже не вернётся — поэтому спрашиваем большинство, а не всё до одного.
    assert.ok(left(crystals) <= crystals.length / 2,
        `на поле осталось ${left(crystals)} из ${crystals.length} кристальных ящиков — боты их не собирают`);

    battle.timers.clearAll();
    stand.battleService.bots.removeAll(battle);
});

gameResourceTest('CTF: боты берут вражеский флаг и доносят его до базы', async () => {
    const stand = makeStand();
    // Один на один: доставку флага проверяем без толпы защитников, иначе результат целиком зависит от
    // того, как сложится перестрелка. Командную игру в CTF проверяет отдельный тест ниже.
    const battle: any = startedBattle(stand, { battleMode: BattleMode.CTF, botCount: 2, scoreLimit: 1 });

    let sawCarrier = false;
    // Бюджет с запасом: сколько займёт доставка, зависит от того, как сложится бой. После перехода
    // на клиентский закон разгона (тяга тает с ростом скорости) боты набирают ход заметно дольше —
    // на прежнем бюджете тест изредка не успевал в полном прогоне сьюта.
    const ticks = await runMatch(stand, battle, 32000, () => {
        if (battle.flagCarrierRed || battle.flagCarrierBlue) sawCarrier = true;
        return battle.scoreRed + battle.scoreBlue >= 1;
    });

    assert.ok(sawCarrier, 'кто-то из ботов должен взять флаг');
    assert.ok(battle.scoreRed + battle.scoreBlue >= 1, `флаг должен быть доставлен (тиков прошло: ${ticks})`);

    battle.timers.clearAll();
    stand.battleService.bots.removeAll(battle);
});

gameResourceTest('CP: боты доезжают до точки контроля и сервер засчитывает их на ней', async () => {
    const stand = makeStand();
    const battle: any = startedBattle(stand, { battleMode: BattleMode.CP, botCount: 6, scoreLimit: 30 });
    assert.ok(battle.domPoints.length > 0, 'на карте должна быть хотя бы одна точка контроля');

    const occupied = () => battle.domPoints.some((p: any) => p.tanksOnPoint.length > 0);
    await runMatch(stand, battle, 3000, occupied);

    assert.ok(occupied(), 'боты должны занять точку контроля');
    const point = battle.domPoints.find((p: any) => p.tanksOnPoint.length > 0)!;
    const botNames = new Set(botsOf(battle).map((b: any) => b.user.username));
    assert.ok(point.tanksOnPoint.some((u: any) => botNames.has(u.username)), 'на точке должны стоять именно боты');
    // Занятость считается по реальной позиции — значит бот действительно въехал в радиус захвата.
    for (const u of point.tanksOnPoint) {
        const c = stand.server.findClientByUsername(u.username);
        assert.ok(Math.hypot(c.battlePosition.x - point.position.x, c.battlePosition.y - point.position.y) <= point.radius);
    }

    battle.timers.clearAll();
    stand.battleService.bots.removeAll(battle);
});

gameResourceTest('боты действуют сообща: общая цель, точка сбора и роли в команде', async () => {
    const stand = makeStand();
    const battle: any = startedBattle(stand, { battleMode: BattleMode.CTF, botCount: 6, scoreLimit: 99 });
    await runMatch(stand, battle, 600);

    const plans = stand.battleService.bots.buildPlans(battle);
    assert.ok(plans.size >= 2, 'план строится для каждой команды, где есть боты');
    for (const [, plan] of plans) {
        // По трое в команде — значит один уходит в оборону базы, остальные атакуют.
        assert.ok(plan.defenders.size >= 1, 'часть отряда должна оставаться в обороне');
    }
    // Хотя бы одна команда видит противника и назначила общую цель для сосредоточенного огня.
    assert.ok([...plans.values()].some((p) => p.focus !== null), 'команда должна выбирать общую цель');

    battle.timers.clearAll();
    stand.battleService.bots.removeAll(battle);

    // CP: отряд раскидывается по точкам, а не толпится на одной.
    const cp: any = startedBattle(stand, { battleMode: BattleMode.CP, botCount: 4, scoreLimit: 99 });
    await runMatch(stand, cp, 200);
    const cpPlans = stand.battleService.bots.buildPlans(cp);
    const assigned = [...cpPlans.values()].reduce((s, p) => s + p.pointAssign.size, 0);
    assert.equal(assigned, stand.battleService.bots.count(cp), 'каждому боту назначена точка');

    cp.timers.clearAll();
    stand.battleService.bots.removeAll(cp);
});

test('бот, подсаженный к уже играющему клиенту, сперва грузит ресурсы и только потом появляется', async () => {
    const stand = makeStand();
    const battle: any = trackBattle(stand, stand.lobbyService.createBattle(makeSettings({ battleMode: BattleMode.TDM, botCount: 0 }), undefined));

    // Клиент, который УЖЕ в бою: он должен получить загрузку ресурсов бота и строку в таблице
    // раньше, чем модель танка, — иначе клиент ищет ник в пустой таблице и падает (#1009).
    const sent: number[] = [];
    const raw: number[] = [];
    const human: any = {
        user: addHuman(battle, 'Veteran'), isBot: false, isSpectator: false, isDestroyed: false,
        isJoiningBattle: false, battleState: 'active', currentHealth: 10000, battlePosition: { x: 0, y: 0, z: 90 },
        activeEffects: [], kills: 0, deaths: 0, battleScore: 0,
        getState: () => 'battle', sendPacket: (p: any) => sent.push(p.getId()), sendRaw: (_b: Buffer, id: number) => raw.push(id),
    };
    human.currentBattle = battle;
    battle.clients.add(human);
    stand.server.indexAuthenticatedClient(human);
    battle.roundState = BattleRoundState.RUNNING;

    // В тестовом окружении карта ресурсов не собрана — подменяем ровно те два вызова, которыми
    // сервер переводит id предметов в ресурсы клиента.
    const realBulk = ResourceManager.getBulkResources;
    const realIdlow = ResourceManager.getIdlowById;
    ResourceManager.getBulkResources = (() => []) as any;
    ResourceManager.getIdlowById = (() => 1) as any;
    try {
        stand.battleService.bots.setDesiredCount(battle, 1);
    } finally {
        ResourceManager.getBulkResources = realBulk;
        ResourceManager.getIdlowById = realIdlow;
    }
    battle.timers.clearAll();

    assert.ok(sent.includes(UserConnectTeamPacket.getId()), 'клиент должен получить строку бота в таблице');
    assert.ok(sent.includes(LoadDependencies.getId()), 'клиент должен получить ресурсы снаряжения бота');
    assert.ok(!raw.includes(TankModelDataPacket.getId()), 'модель танка не должна уходить до подтверждения загрузки');

    // Играем за клиент: подтверждаем загрузку ресурсов.
    ResourceManager.getIdlowById = (() => 1) as any;
    try {
        for (const cb of stand.server._callbacks.values()) cb(human);
    } finally {
        ResourceManager.getIdlowById = realIdlow;
    }
    assert.ok(raw.includes(TankModelDataPacket.getId()), 'после подтверждения клиент получает модель танка бота');

    // И только теперь бот выезжает на поле.
    const bot: any = botsOf(battle)[0];
    await runMatch(stand, battle, 300, () => bot.battleState === 'active');
    assert.equal(bot.battleState, 'active', 'бот должен появиться на поле после загрузки ресурсов');
    assert.ok(bot.battlePosition, 'у бота должна быть позиция на карте');

    battle.timers.clearAll();
    stand.battleService.bots.removeAll(battle);
});

test('долгий бой с толпой ботов не копит дропы и не шлёт клиенту битых пакетов', async () => {
    const stand = makeStand();
    const battle: any = trackBattle(stand, stand.lobbyService.createBattle(makeSettings({ battleMode: BattleMode.TDM, botCount: 16, scoreLimit: 99999 }), undefined));

    // Ник в этих пакетах идёт первым полем — этого хватает, чтобы отследить жизнь чужого танка так же,
    // как это делает клиент.
    const readNick = (b: Buffer): string | null => {
        if (b.length < 5 || b.readUInt8(0) === 1) return null;
        const len = b.readInt32BE(1);
        return len >= 0 && 5 + len <= b.length ? b.toString('utf8', 5, 5 + len) : null;
    };
    const alive = new Map<string, boolean>();
    const initTank = new Map<string, number>();
    let moveWhileDead = 0, doubleSpawn = 0, activateWithoutSpawn = 0;

    const observer: any = {
        user: createBotUser('Watcher', 5, 0, { hull: 'hunter', turret: 'smoky', mod: 0, paint: 'green' }),
        isBot: false, isSpectator: true, isDestroyed: false, isJoiningBattle: false,
        battleState: 'suicide', currentHealth: 0, battlePosition: null, activeEffects: [],
        kills: 0, deaths: 0, battleScore: 0, getState: () => 'battle',
        sendPacket: (p: any) => {
            // Самоуничтожение приходит наблюдателю адресно (см. BattleService.forceDestroyTank), а не
            // общей рассылкой, — иначе его смерть выглядела бы как «Spawn живого танка».
            if (p.getId() === DestroyTankPacket.getId()) { alive.set((p as any).nickname, false); return; }
            if (p.getId() !== TankModelDataPacket.getId()) return;
            try { const nick = JSON.parse(p.jsonData).nickname; initTank.set(nick, (initTank.get(nick) ?? 0) + 1); } catch { /* не наш пакет */ }
        },
        sendRaw: (b: Buffer, id: number) => {
            const nick = readNick(b);
            if (!nick) return;
            if (id === SpawnPacket.getId()) { if (alive.get(nick)) doubleSpawn++; alive.set(nick, true); }
            else if (id === KillPacket.getId() || id === DestroyTankPacket.getId()) alive.set(nick, false);
            else if (id === ActivateTankPacket.getId()) { if (!alive.get(nick)) activateWithoutSpawn++; }
            else if (id === FullMovePacket.getId() || id === MovePacket.getId()) { if (alive.has(nick) && !alive.get(nick)) moveWhileDead++; }
        },
    };
    observer.currentBattle = battle;
    battle.clients.add(observer);
    // Наблюдатель — полноценный участник боя: адресные рассылки идут по ростеру, а не по battle.clients.
    battle.spectators.push(observer.user);
    stand.server.indexAuthenticatedClient(observer);

    const realBulk = ResourceManager.getBulkResources;
    const realIdlow = ResourceManager.getIdlowById;
    ResourceManager.getBulkResources = (() => []) as any;
    ResourceManager.getIdlowById = (() => 1) as any;
    try {
        battle.roundState = BattleRoundState.RUNNING;
        battle.roundStartTime = Date.now();
        stand.battleService.bots.onRosterChanged(battle);
        for (const cb of [...stand.server._callbacks.values()]) cb(observer); // играем за клиент: ресурсы загружены
        battle.timers.clearAll();
        await runMatch(stand, battle, 2500);
    } finally {
        ResourceManager.getBulkResources = realBulk;
        ResourceManager.getIdlowById = realIdlow;
    }

    assert.equal(moveWhileDead, 0, 'движение мёртвого танка — клиент дерефит уничтоженный объект');
    assert.equal(doubleSpawn, 0, 'повторный Spawn живого танка ломает модель боя у клиента');
    assert.equal(activateWithoutSpawn, 0, 'ActivateTank без Spawn приходит на ещё не созданный танк');
    for (const [nick, n] of initTank) assert.equal(n, 1, `танк ${nick} создан у клиента ${n} раз(а) вместо одного`);

    // Дропы не должны копиться: боты убирают рядовые кристальные ящики, иначе поле забивается ими
    // и клиент захлёбывается их отрисовкой.
    assert.ok(battle.activeBonuses.size < 40, `на поле застряло ${battle.activeBonuses.size} дропов`);
    const deaths = botsOf(battle).reduce((s: number, b: any) => s + b.deaths, 0);
    assert.ok(deaths > 20, 'бой должен продолжаться, а не замирать');

    battle.timers.clearAll();
    stand.battleService.bots.removeAll(battle);
});

test('стартовые бои: сотня разных форматов, карт и званий, и боты в них — по званию боя', () => {
    const stand = makeStand();
    const realBulk = ResourceManager.getBulkResources;
    const realIdlow = ResourceManager.getIdlowById;
    ResourceManager.getBulkResources = (() => []) as any;
    ResourceManager.getIdlowById = (() => 1) as any;
    let battles: any[] = [];
    try {
        battles = stand.battleService.seedBotBattles(100, 10);
        for (const seeded of battles) trackBattle(stand, seeded);
    } finally {
        ResourceManager.getBulkResources = realBulk;
        ResourceManager.getIdlowById = realIdlow;
    }

    assert.ok(battles.length >= 100, `засеяно всего ${battles.length} боёв`);

    // Ботов в бою — от двух до десяти по вместимости карты, и место игроку всегда остаётся.
    const counts = new Set<number>();
    for (const battle of battles) {
        const bots = stand.battleService.bots.count(battle);
        const capacity = battle.isTeamMode() ? battle.settings.maxPeopleCount * 2 : battle.settings.maxPeopleCount;
        counts.add(bots);
        assert.ok(bots >= 2 && bots <= 10, `в бою ${battle.settings.name} ботов ${bots}`);
        assert.ok(capacity - bots >= 1, `бой ${battle.settings.name} забит ботами под завязку`);
    }
    assert.ok(counts.size >= 2, `во всех боях одинаковое число ботов: ${[...counts].join(',')}`);

    // Список должен закрывать весь путь от новобранца до генералиссимуса, а не один общий диапазон.
    for (const rank of [1, 8, 15, 22, 30]) {
        const forRank = battles.filter((b) => b.settings.minRank <= rank && b.settings.maxRank >= rank);
        assert.ok(forRank.length >= 10, `игроку ${rank} звания видно всего ${forRank.length} боёв`);
    }
    // И это не один и тот же диапазон у всех: окна реально разные.
    const windows = new Set(battles.map((b) => `${b.settings.minRank}-${b.settings.maxRank}`));
    assert.ok(windows.size >= 4, `окон званий всего ${windows.size}: ${[...windows].join(', ')}`);
    // Окно боя не шире того, что разрешает сама карта: бой новобранцев на карте «от 11 звания» игрок
    // в жизни не увидит.
    for (const battle of battles) {
        const map = battleDataObject.maps.find((m) => m.mapId === battle.settings.mapId)!;
        assert.ok(battle.settings.minRank >= map.minRank && battle.settings.maxRank <= map.maxRank,
            `бой ${battle.settings.minRank}-${battle.settings.maxRank} на карте ${map.mapId} (${map.minRank}-${map.maxRank})`);
    }

    // Режимы: не одна сплошная свалка. Контроль точек в стартовый список не берут намеренно —
    // клиент валится на входе в такой бой (см. SEED_SKIP_MODES в BattleService).
    const modes = new Set(battles.map((b) => b.settings.battleMode));
    for (const mode of [BattleMode.DM, BattleMode.TDM, BattleMode.CTF]) {
        assert.ok(modes.has(mode), `в списке нет режима ${mode}`);
    }
    assert.ok(!modes.has(BattleMode.CP), 'контроль точек в стартовом списке не место, пока он роняет клиент');

    // Карты: список из сотни боёв на десятке карт выглядит заготовкой, а не живым сервером.
    const maps = new Set(battles.map((b) => b.settings.mapId));
    assert.ok(maps.size >= 25, `карт в списке всего ${maps.size}`);
    // Разное число мест: бой на четверых и бой на два десятка — это разные бои даже на одной карте.
    assert.ok(new Set(battles.map((b) => b.settings.maxPeopleCount)).size >= 5, 'вместимость боёв одинаковая');

    // Форматы: настройки, задающие бою характер, и пара парковых. Пометки PRO среди них нет намеренно —
    // за вход в PRO-битву игрок платит кристаллами, а стартовый список должен быть бесплатным.
    assert.ok(battles.some((b) => b.settings.withoutSupplies), 'нет боя без припасов');
    assert.ok(battles.some((b) => b.settings.withoutBonuses), 'нет боя без ящиков');
    assert.ok(battles.some((b) => b.settings.withoutMines), 'нет боя без мин');
    assert.ok(battles.some((b) => b.settings.withoutCrystals), 'нет боя без кристаллов');
    assert.ok(battles.some((b) => b.settings.friendlyFire), 'нет боя с огнём по своим');
    assert.ok(!battles.some((b) => b.settings.proBattle), 'стартовый бой не должен брать плату за вход');
    const parkour = battles.filter((b) => b.settings.parkourMode);
    assert.ok(parkour.length >= 2 && parkour.length <= 10, `парковых боёв ${parkour.length}`);

    // Бой с ограничением по званию не должен получаться пустым: боты подобраны ПОД его окно.
    for (const battle of battles) {
        const bots = botsOf(battle);
        assert.ok(bots.length > 0, `бой ${battle.settings.name} ${battle.settings.minRank}-${battle.settings.maxRank} остался без ботов`);
        for (const bot of bots) {
            assert.ok(bot.user.rank >= battle.settings.minRank && bot.user.rank <= battle.settings.maxRank,
                `${bot.user.username} звания ${bot.user.rank} в бою ${battle.settings.minRank}-${battle.settings.maxRank}`);
            // Снаряжение — то, что на этом звании открыто: модификация не выше доступной.
            const turretMod = bot.user.turrets.get(bot.user.equippedTurret) ?? 0;
            assert.ok(turretMod >= 0 && turretMod <= 3, `модификация орудия ${turretMod}`);
        }
        // Ник читается как игроцкий: только буквы и цифры и без служебной пометки в начале (искать
        // «bot» где угодно внутри нельзя — это слово попадается в середине обычных пар вроде
        // TurboThunder, и такой ник игрока ничем не выдаёт).
        for (const bot of bots) {
            assert.match(bot.user.username, /^[A-Za-z][A-Za-z0-9]*$/, `ник ${bot.user.username} не похож на игроцкий`);
            assert.doesNotMatch(bot.user.username, /^bot/i, `ник ${bot.user.username} выдаёт бота`);
        }
    }

    for (const battle of battles) {
        battle.timers.clearAll();
        stand.battleService.bots.removeAll(battle);
    }
});

test('снаряжение бота растёт со званием: новобранец на стоке, генералиссимус на верхних модификациях', () => {
    const stand = makeStand();
    const low: any = startedBattle(stand, { battleMode: BattleMode.DM, botCount: 4, minRank: 1, maxRank: 3 });
    const high: any = startedBattle(stand, { battleMode: BattleMode.DM, botCount: 4, minRank: 26, maxRank: 30 });

    const mods = (battle: any) => botsOf(battle).map((b: any) => (b.user.turrets.get(b.user.equippedTurret) ?? 0) + (b.user.hulls.get(b.user.equippedHull) ?? 0));
    const lowMods = mods(low);
    const highMods = mods(high);

    assert.ok(lowMods.every((m: number) => m === 0), `новобранцы едут на прокачке ${lowMods.join(',')}`);
    assert.ok(highMods.every((m: number) => m >= 4), `верхние звания едут на прокачке ${highMods.join(',')}`);

    for (const battle of [low, high]) {
        battle.timers.clearAll();
        stand.battleService.bots.removeAll(battle);
    }
});

test('краска бота — по его званию: генералиссимус не ездит зелёным новобранцем', () => {
    const stand = makeStand();
    const low: any = startedBattle(stand, { battleMode: BattleMode.DM, botCount: 8, maxPeopleCount: 20, minRank: 1, maxRank: 2 });
    const high: any = startedBattle(stand, { battleMode: BattleMode.DM, botCount: 8, maxPeopleCount: 20, minRank: 29, maxRank: 30 });

    const paintRank = (id: string) => itemBlueprints.paints.find((p: any) => p.id === id)?.rank ?? -1;

    for (const bot of botsOf(low)) {
        const rank = paintRank(bot.user.equippedPaint);
        assert.ok(rank > 0 && rank <= bot.user.rank, `${bot.user.username} звания ${bot.user.rank} в краске ${bot.user.equippedPaint} (звание краски ${rank})`);
    }

    // На верхних званиях бот обязан быть в краске старших званий, а не в стартовом наборе.
    const highPaints = botsOf(high).map((b: any) => b.user.equippedPaint);
    for (const paint of highPaints) {
        assert.ok(paintRank(paint) >= 15, `верхнее звание в краске ${paint} (звание краски ${paintRank(paint)})`);
    }
    // Отряд не одноцветный.
    assert.ok(new Set(highPaints).size >= 3, `у всего отряда краска ${[...new Set(highPaints)].join(',')}`);
    // Краски не по званию (премиум, помощник) боту не положены.
    for (const bot of [...botsOf(low), ...botsOf(high)]) {
        assert.ok(!['premium', 'helper'].includes(bot.user.equippedPaint), `${bot.user.username} в краске ${bot.user.equippedPaint}`);
    }

    for (const b of [low, high]) {
        b.timers.clearAll();
        stand.battleService.bots.removeAll(b);
    }
});

test('звание бота пляшет вокруг звания живого игрока, а не по всему окну боя', () => {
    const stand = makeStand();
    // Окно боя широкое — если бы звание бралось по нему, боты разъехались бы от новобранца до
    // генералиссимуса. Игрок ровно посередине, отряд большой: так видно и разброс, и его границы.
    const battle: any = startedBattle(stand, { battleMode: BattleMode.DM, botCount: 12, maxPeopleCount: 20, minRank: 1, maxRank: 30 });
    const player = battle.users.find((u: any) => u.username === 'Tester')!;
    const ranks = botsOf(battle).map((b: any) => b.user.rank);
    assert.equal(ranks.length, 12);

    for (const rank of ranks) {
        assert.ok(Math.abs(rank - player.rank) <= 3, `бот звания ${rank} против игрока ${player.rank}`);
    }
    // И это именно разброс, а не одно и то же звание на весь отряд.
    assert.ok(new Set(ranks).size >= 3, `у всего отряда звания ${[...new Set(ranks)].join(',')}`);

    // Окно боя всё равно главнее: подсадить генералиссимуса в бой новобранцев нельзя.
    const narrow: any = startedBattle(stand, { battleMode: BattleMode.DM, botCount: 6, minRank: 1, maxRank: 3 });
    for (const bot of botsOf(narrow)) {
        assert.ok(bot.user.rank >= 1 && bot.user.rank <= 3, `${bot.user.username} звания ${bot.user.rank} в бою 1-3`);
    }

    for (const b of [battle, narrow]) {
        b.timers.clearAll();
        stand.battleService.bots.removeAll(b);
    }
});

test('бой с ботами живёт сам по себе: игрок приходит и уходит, боты остаются', async () => {
    const stand = makeStand();
    const battle: any = trackBattle(stand, stand.lobbyService.createBattle(makeSettings({ battleMode: BattleMode.TDM, botCount: 4 }), undefined));

    // Бой наполняется ботами и без людей — к нему можно подключиться в любой момент.
    stand.battleService.fillWithBots(battle, 4);
    assert.equal(stand.battleService.bots.count(battle), 4);
    assert.equal(battle.roundState, BattleRoundState.RUNNING, 'раунд должен идти и без живых игроков');

    const human = createBotUser('Player1', 5, 0, { hull: 'hunter', turret: 'smoky', mod: 0, paint: 'green' });
    stand.battleService.addUserToBattle(human, battle.battleId, 0);
    assert.equal(stand.battleService.bots.count(battle), 4, 'приход игрока не перетряхивает состав');
    assert.equal(battle.usersRed.length + battle.usersBlue.length, 5, 'боты видны в списке игроков битвы');

    stand.battleService.removeUserFromBattle(human, battle);
    assert.equal(stand.battleService.bots.count(battle), 4, 'боты не уходят следом за игроком');

    // Настройку можно менять на лету — этим же путём работает чат-команда /bots.
    stand.battleService.bots.setDesiredCount(battle, 0);
    assert.equal(stand.battleService.bots.count(battle), 0);
    assert.equal(battle.users.length + battle.usersRed.length + battle.usersBlue.length, 0, 'ростер должен опустеть');

    battle.timers.clearAll();
});
