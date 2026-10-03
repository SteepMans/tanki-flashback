import { weaponPhysicsData } from "@/config/physics.data";
import { getHullMod } from "@/config/hulls.data";
import { getTurretMod } from "@/config/turrets.data";
import { hullCollision } from "@/generated/hullCollision";
import { getMapBonusRegions, getMapGeometries, getMapSpawns } from "@/maps/mapData";
import { GameClient } from "@/server/game.client";
import { GameServer } from "@/server/game.server";
import { IVector3 } from "@/shared/types/geom/ivector3";
import { ItemUtils } from "@/utils/item.utils";
import logger from "@/utils/logger";
import { SmokyStaticShotPacket, SmokyTargetShotPacket } from "@/features/weapons/smoky/smoky.packets";
import { TwinsShotPacket } from "@/features/weapons/twins/twins.packets";
import { RailgunShotPacket, StartChargingPacket } from "@/features/weapons/railgun/railgun.packets";
import { StartShootingFlamethrowerPacket, StopShootingFlamethrowerPacket } from "@/features/weapons/flamethrower/flamethrower.packets";
import { Battle, BattleMode, BattleRoundState, IDomPointState } from "../battle.model";
import { ActivateTankPacket, FullMovePacket, TankTemperaturePacket, TurretRotationPacket } from "../battle.packets";
import { BonusService } from "../bonus.service";
import { CollisionService } from "../collision.service";
import { BattleWorkflow } from "../battle.workflow";
import { BotClient } from "./bot.client";
import { clampTilt, CONTACT_RISE, orientationFromUp, sampleGroundContact, turretAngleInHull, turretHeadingFromHull } from "./bot.terrain";

/**
 * Корпус смотрит вдоль модельной оси +Y, а не +X: это видно по CtfService._nearFlag, где длина корпуса
 * лежит по локальному Y, то есть в мире направление «вперёд» = (-sin yaw, cos yaw). Поэтому курс
 * движения переводится в orientation.z вычитанием 90° — без этого танк едет боком.
 */
const YAW_FROM_HEADING = -Math.PI / 2;

/** Танк стоит примерно на столько выше пола (значение из CollisionService: «tank rests ~89 above its floor»). */
const RIDE_HEIGHT = 90;
/**
 * Круче этого корпус не заваливаем (радианы, ~34°). Опора под гусеницей может оказаться ступенькой
 * или бортиком, и по её нормали танк вставал бы на дыбы; живой танк на такой склон просто не заедет.
 */
const MAX_TILT = 0.6;
/** С какой скоростью корпус доворачивается к новой нормали опоры (доля расхождения в секунду). */
const TILT_RATE = 6;
/** Габариты корпуса для неизвестной модели: по ним меряется опора под гусеницами. */
const HULL_FALLBACK = { halfX: 165, halfY: 262 };
/** Абсолютный потолок подъёма за шаг: выше — это стена, а не пандус. */
const STEP_UP = 160;
/**
 * Крутизна, которую танк ещё берёт ходом (tan ~35°). Подъём разрешается ПРОПОРЦИОНАЛЬНО пройденному
 * пути, а не одним порогом STEP_UP на любую длину пробы: за такт бот проезжает всего десятки единиц, и
 * общий порог позволял ему запрыгивать на 160 единиц вверх — то есть на любой ящик или уступ стены.
 * Упёршись в стену из составленных коробок, бот брал по уступу за такт и «всплывал» по ней вверх.
 */
const MAX_CLIMB = 0.7;
/** Столько тактов подряд шаг не проходит — значит упёрлись; ждать STUCK_MS незачем, отворачиваем сразу. */
const BLOCKED_TICKS = 3;
/** Больше этого перепада вниз — обрыв; туда бот не поедет, чтобы не улететь в пропасть. */
const MAX_DROP = 400;
/** Высота «глаз» над точкой танка для лучей видимости и проверок препятствий. */
const EYE = 90;
/** Дальность проверки препятствий по курсу: короче корпуса — луч бы обрезался (см. OCCLUSION_TRIM). */
const PROBE_DISTANCE = 320;
/** Курсы, которые перебирает бот при обходе препятствия (радианы, от желаемого). */
const HEADING_PROBES = [0, 0.35, -0.35, 0.8, -0.8, 1.3, -1.3, 2.0, -2.0, Math.PI];
/** Найденный обход держим столько, чтобы бот не перещёлкивался между «влево» и «вправо» каждый такт. */
const AVOID_HOLD_MS = 700;
/** Промах по курсу меньше этого корпус не отрабатывает: иначе он мелко трясётся на месте. */
const HEADING_DEADBAND = 0.05;
/** Промах по курсу, при котором бот ещё жмёт газ: дальше он сперва доворачивается, как и живой игрок. */
const DRIVE_ARC = 1.1;
/**
 * Биты состояния КОРПУСА в поле `control` — те же клавиши, что жмёт живой игрок.
 *
 * Принимающий клиент разбирает их так же, как биты башни: `_SafeStr_1833` в library.swf берёт
 * (бит0 - бит1) как тягу и (бит2 - бит3) как руль и отдаёт их прямо в физику танка
 * (`_SafeStr_7306` -> `_SafeStr_3091`), а позицию и скорости из пакета применяет лишь как поправку,
 * причём наполовину. Имена констант битов у корпуса и у башни в клиенте ОДНИ И ТЕ ЖЕ (бит2 корпуса и
 * бит5 башни — одна строка в пуле), поэтому «влево» здесь означает то же, что у башни: курс растёт.
 */
const HULL_CONTROL_FORWARD = 1 << 0;
const HULL_CONTROL_BACKWARD = 1 << 1;
const HULL_CONTROL_LEFT = 1 << 2;
const HULL_CONTROL_RIGHT = 1 << 3;

const VIEW_RANGE = 10000;      // дальше бот врага «не видит»
const FIRE_RANGE = 6500;       // дальше не стреляет (смоки за этой чертой почти не наносит урона)
const KEEP_MIN = 1400;         // ближе — отходит
const KEEP_MAX = 4200;         // дальше — сближается
const AIM_TOLERANCE = 0.05;    // выстрел только когда башня реально смотрит на цель (~3 градуса)
/** Вылет ствола от центра танка: линию огня проверяем от дула, а не из середины корпуса. */
const MUZZLE_OFFSET = 260;
/** Полуширина корпуса: по ней решается, прошёл снаряд по цели или мимо. */
const HULL_HALF_WIDTH = 300;
/** Шаг урона огнемёта: струя капает уроном с этим периодом. */
const FLAME_TICK_MS = 500;
/** Нагрев цели за один тик струи (тот же шаг, что и в FirebirdHitCommandHandler). */
const FLAME_HEAT_STEP = 0.1;
const LOW_ARMOR = 0.3;         // ниже этой доли брони бот отступает
const SAFE_ARMOR = 0.65;       // выше — возвращается в бой
const GOAL_REACHED = 600;      // радиус «дошёл» для вольных целей (патруль, сбор, отход)
/** Радиус «дошёл» для объективов: флаг берётся только КАСАНИЕМ корпуса, так что останавливаться
 *  за полтанка от него нельзя — иначе бот вечно стоит рядом с флагом и не берёт его. */
const OBJECTIVE_REACHED = 100;
const STUCK_MS = 1500;         // столько без продвижения — считаем, что застряли
const STUCK_DISTANCE = 60;     // продвижение меньше этого за STUCK_MS = застряли
const UNSTICK_MS = 1400;       // столько едем выбранным курсом, чтобы выбраться из тупика
/** Сколько сдаём назад, прежде чем выбирать новый курс: из угла разворот на месте ничего не даёт. */
const REVERSE_MS = 700;
/**
 * «Полка» ускорения принимающего клиента (ед. мира/с²) — константа 400 из его физики хода
 * (декомпилят: resources/AS3 Scripts (library.swf)/521423188462318859123423632234/_SafeStr_3091.as).
 * Выше половины паспортной скорости клиент заменяет ослабевшую тягу ровно этим значением — только
 * благодаря полке танк у него вообще доезжает до предела скорости (см. _driveSpeed).
 */
const CLIENT_ACCEL_FLOOR = 400;
/** Кадровая сетка физики клиента (Гц): его закон хода интегрируется шагами этой длины. */
const CLIENT_PHYSICS_HZ = 60;
// --- интерес получателей ---------------------------------------------------------------------------
/**
 * Дальше этого (по XY до танка получателя) точная позиция бота получателю не важна: чужой танк его
 * клиент ведёт САМ по битам control, и на таком удалении дрейф этой симуляции на глаз не виден.
 * Позиционные пакеты такому получателю уходят редким кипэлайвом (BOT_FAR_RESEND_MS); смена клавиш
 * корпуса — всегда и немедленно, иначе его симуляция уедет далеко (башня дальнему и так приходит
 * дискретным TurretRotation на каждой смене состояния — он вещается всем). Смысл фильтра — поток на
 * клиент: каждое сообщение у браузерного клиента — отдельная задача main thread, и тридцать ботов
 * полным каденсом заваливают его сотнями задач в секунду, хотя вблизи получателя из них единицы.
 */
const BOT_NEAR_RANGE = 4000;
/** Выход из радиуса — с гистерезисом: на самой границе получатель не должен мигать ближний/дальний. */
const BOT_NEAR_EXIT = 4600;
/** Каденс позиционных пакетов дальнему получателю. */
const BOT_FAR_RESEND_MS = 1000;
/**
 * Просвет, который бот требует под САМ ШАГ (десятки единиц за такт), в отличие от просвета под выбор
 * курса. Требовать под шаг всю PROBE_DISTANCE значило тормозить в пол за три корпуса до любой стены и
 * стоять там колом, пока проба не найдёт другой курс: со стороны это и есть «едет резко». Выбор курса
 * по-прежнему смотрит на PROBE_DISTANCE вперёд, поэтому в стену бот не целится.
 */
const STEP_CLEARANCE = 220;
/** Просвет, которым бот довольствуется, выбираясь из тупика: в закуток уже PROBE_DISTANCE он въезжает
 *  (шагом в десятки единиц за такт), а выехать по обычным меркам не может — и стоит там до конца боя. */
const ESCAPE_CLEARANCE = 160;
/** Курсы, которые бот перебирает, выбираясь из тупика (радианы, от собственного курса корпуса). */
const ESCAPE_PROBES = [Math.PI, 2.4, -2.4, 1.8, -1.8, 1.2, -1.2, 0.6, -0.6];
/** Столько помним курс, в который уткнулись: без памяти бот откатывается и тут же едет обратно в угол. */
const DEAD_END_MEMORY_MS = 6000;
/** Сектор вокруг запомненного курса, который считается тем же тупиком. */
const DEAD_END_ARC = 0.7;
/** Сколько тупиков держим в памяти: больше — и бот перестаёт видеть выход вообще. */
const DEAD_END_LIMIT = 4;
/**
 * Безнадёжный случай: столько времени бот не сдвинулся с места, перепробовав все манёвры. Бывает,
 * когда его столкнули в яму или зажали в закутке, из которого выезда нет вовсе. Живой игрок в такой
 * ситуации жмёт самоуничтожение — бот делает то же самое, иначе он выбывает из боя до конца раунда.
 */
const HOPELESS_MS = 12000;
/** На столько бот должен отъехать, чтобы это считалось продвижением (а не вознёй на месте). */
const HOPELESS_DISTANCE = 400;
/** И столько раз он должен был честно попробовать выбраться: без этого под самоуничтожение попал бы
 *  боец, спокойно сидящий в укрытии. */
const HOPELESS_ATTEMPTS = 4;
const IDLE_RESEND_MS = 500;    // как часто повторять позицию, когда бот стоит
/**
 * Как часто подтверждать позицию боту, едущему ПО ПРЯМОЙ без событий (руль отпущен, клавиши не
 * менялись, расталкивания не было). Принимающий клиент ведёт чужой танк ТОЙ ЖЕ физикой по тем же
 * клавишам и прямолинейный ход воспроизводит сам; поправка каждые 100 мс тут не помогала, а мешала —
 * позицию из пакета он применяет полупоправкой, и любое расхождение (например, его физика развела
 * столкнувшиеся корпуса, которые сервер вёл внахлёст) стягивалось обратно десять раз в секунду. Это и
 * видно как «дёргаются». События же — поворот, смена клавиш, снос башни, расталкивание — уходят немедленно.
 */
const CRUISE_RESEND_MS = 300;
// --- расталкивание корпусов ----------------------------------------------------------------------
/** Ближе этого (по XY, между центрами) двум ботам не стоять: примерно два «радиуса» корпуса. */
const TANK_SEPARATION = 400;
/** Потолок сдвига расталкивания за такт: наложение разводится за несколько тактов, а не телепортом. */
const SEPARATION_STEP = 60;
/** Разница высот, до которой боты считаются на одном ярусе: мост и проезд под ним не расталкиваются. */
const SEPARATION_LAYER = 300;
/**
 * Как часто стоящий бот подтверждает угол башни, пока она крутится. Сам поворот принимающий клиент
 * ведёт САМ по состоянию вращения (см. TURRET_CONTROL_*), поэтому поток углов нужен только как
 * поправка на расхождение двух интеграторов — их шаг по времени разный (у нас такт, у клиента кадр).
 */
const TURRET_SYNC_MS = 250;
/** Насколько башне разрешено уехать «молча», пока состояние вращения снято (см. _publishMovement). */
const TURRET_DRIFT = 0.04;
/**
 * Биты состояния поворота башни в поле `control` пакетов движения и TurretRotation.
 *
 * Клиент-ПОЛУЧАТЕЛЬ крутит чужую башню сам: по этим битам он берёт направление (бит5 - бит6), гонит
 * башню с паспортным ускорением до паспортной скорости и каждый кадр наращивает угол; пришедший в
 * пакете угол он ПОДСТАВЛЯЕТ как есть (см. `_SafeStr_3016` в library.swf: биты 5/6/7 и `_SafeStr_5674`).
 * Бот раньше слал control=0 и один угол за такт — то есть клиент не крутил ничего сам, а десять раз в
 * секунду переставлял башню на новый угол. Это и был тот рывок, которого у живых игроков нет: их клиент
 * шлёт ровно эти же биты на нажатие и отпускание.
 */
const TURRET_CONTROL_LEFT = 1 << 5;   // угол башни растёт
const TURRET_CONTROL_RIGHT = 1 << 6;  // угол башни убывает
/** Промах по углу меньше этого башня не отрабатывает вовсе (тот же порог, что у клиента). */
const TURRET_EPSILON = 1e-6;
const RESPAWN_DELAY_MS = 3200; // пауза от смерти до заявки на возрождение (как у игрока: 3с + запас)
const PLACE_DELAY_MS = 1200;   // «материализация» танка после выбора точки спавна
/**
 * Пауза между Spawn и ActivateTank. У живого игрока между ними целый оборот по сети: сервер шлёт Spawn,
 * КЛИЕНТ создаёт танк и только потом отвечает ReadyToActivate. Если активировать бота в том же пакетном
 * всплеске, клиент получает Activate на ещё не построенный танк и валится с критической ошибкой.
 */
const ACTIVATE_DELAY_MS = 900;
const BONUS_INTEREST = 4500;   // за припасом бот сворачивает только если тот рядом
const BONUS_PICKUP = 260;      // на таком расстоянии засчитываем подбор
/**
 * Что бот подбирает — то же, что и живой игрок: припасы, кристальные ящики и дорогие коробки. Начисление
 * кристаллов боту не идёт (см. BonusService), но подбор всё равно нужен: несобранные ящики копятся на
 * поле десятками, клиент захлёбывается их отрисовкой, а бот, объезжающий золото, выглядит поломанным.
 */
const BOT_BONUS_TYPES = new Set(["health", "nitro", "damage", "armor", "crystall", "gold", "special", "moon", "pumpkin"]);
/** Дорогие коробки: за ними бот идёт, бросив текущие дела, — как за ними ныряет вся битва. */
const BOT_TREASURE_TYPES = new Set(["gold", "special", "moon", "pumpkin"]);
/** В этом радиусе золотой ящик важнее любой другой цели. */
const TREASURE_INTEREST = 12000;
/** За кристальным ящиком бот сворачивает «по пути» — дальше этого не бежит. */
const CRYSTAL_INTEREST = 3000;

// --- укрытия -------------------------------------------------------------------------------------
/** Пока перезаряжается, бот прячется: доля отката, которую он проводит за укрытием. */
const COVER_RELOAD_FRACTION = 0.55;
/** Радиусы, на которых ищется укрытие вокруг бота. */
const COVER_RADII = [500, 900, 1400];
/** Сколько направлений перебирается на каждом радиусе. */
const COVER_DIRECTIONS = 8;
/** Найденное укрытие держим хотя бы столько, чтобы бот не дёргался между двумя точками. */
const COVER_HOLD_MS = 1200;

const STATE_RED = 0;
const STATE_BLUE = 1;

export type BotState = "patrol" | "chase" | "attack" | "retreat" | "cover";

/** Орудия, для которых у бота есть своя механика выстрела. Остальные считаются смоки. */
export type BotWeapon = "smoky" | "twins" | "railgun" | "flamethrower";

/** Цель движения и радиус, с которого она считается достигнутой (у флага он куда меньше, чем у патруля). */
interface IBotGoal {
    pos: IVector3;
    arrive: number;
}

/** Общий план команды на тик: боты действуют сообща, а не каждый сам по себе. */
export interface IBotTeamPlan {
    /** Приоритетная цель команды — по ней ведут сосредоточенный огонь. */
    focus: GameClient | null;
    /** Точка сбора: там сейчас идёт бой или лежит объектив; свободные боты подтягиваются туда. */
    rally: IVector3 | null;
    /** Ники ботов, назначенных в оборону (остальные атакуют). */
    defenders: Set<string>;
    /** Распределение ботов по точкам контроля: ник -> id точки. */
    pointAssign: Map<string, number>;
}

export interface IBotTickContext {
    battle: Battle;
    server: GameServer;
    collision: CollisionService;
    bonus: BonusService;
    prepareRespawn: (client: GameClient) => void;
    now: number;
    /** Длина тика в секундах. */
    dt: number;
    /** План по индексу команды (0 красные, 1 синие, 2 — DM). */
    plans: Map<number, IBotTeamPlan>;
    /** Весь отряд ботов боя — для взаимного расталкивания корпусов (см. _separateFromSquad). */
    squad: BotBrain[];
    /**
     * Молчать в эфир: бой сейчас достраивает у себя только что вошедший игрок. Боты продолжают думать
     * и ездить на сервере, но не шлют движение/поворот башни — иначе клиент захлёбывается и валится на
     * танках, которых он ещё не построил (см. BOT_STREAM_SETTLE_MS).
     */
    mute: boolean;
    /**
     * В бою нет ни одного живого клиента — вещать некому. Боты продолжают жить и драться на сервере
     * (счёт боя, флаги, точки — всё считается), но пакеты движения и выстрелов не собираются вовсе:
     * принять их могли бы только другие боты, у которых отправка и так заглушка. На сотне засеянных
     * боёв это заметная доля процессора.
     */
    silent: boolean;
}

const dist2 = (a: IVector3, b: IVector3): number => Math.hypot(a.x - b.x, a.y - b.y);

/** Нормализация угла в (-PI, PI]. */
function wrapAngle(a: number): number {
    while (a > Math.PI) a -= Math.PI * 2;
    while (a <= -Math.PI) a += Math.PI * 2;
    return a;
}

/** Приближение нормального распределения (сумма равномерных) — для разброса выстрела. */
function gauss(): number {
    return (Math.random() + Math.random() + Math.random() - 1.5) / 0.5;
}

/**
 * «Мозг» одного бота: конечный автомат (патруль → преследование → атака → укрытие → отступление) плюс
 * объектив режима (флаг в CTF, точки в CP).
 *
 * Едет НЕ по прямой к цели, а как танк: разгон, торможение, ограниченная скорость поворота корпуса —
 * значения берутся из того же паспорта корпуса, который получает клиент, поэтому чужая симуляция
 * движения совпадает с серверной. Наружу всё уходит теми же пакетами, что и у живого игрока.
 */
export class BotBrain {
    public state: BotState = "patrol";
    /** Танк можно спавнить: живые клиенты уже получили его модель. */
    public spawnAllowed = false;

    private readonly pos: IVector3 = { x: 0, y: 0, z: 0 };
    /** Куда СМОТРИТ корпус по плоскости (курс в мире). В пакет уходит внутри `orientation` (см. _settle). */
    private facing = 0;
    /** Нормаль опоры под гусеницами: по ней корпус наклоняется на склоне. Сглажена, чтобы не щёлкать. */
    private up: IVector3 = { x: 0, y: 0, z: 1 };
    /** Готовые углы Эйлера корпуса (курс + тангаж + крен) — ровно то, что уходит в пакет. */
    private orientation: IVector3 = { x: 0, y: 0, z: 0 };
    /** Текущая продольная скорость (единицы мира/с; отрицательная — задний ход). */
    private speed = 0;
    /** Текущая угловая скорость корпуса (рад/с). */
    private angular = 0;
    private turret = 0;          // курс башни в мире — производная от угла в корпусе (см. _aim)
    /**
     * Угол башни ОТНОСИТЕЛЬНО КОРПУСА — основное состояние башни и ровно то, что уходит в пакет.
     * Держать состоянием мировой курс нельзя: башня прикручена к корпусу и на его довороте едет вместе
     * с ним, а клиент именно так её и рисует. Мировой курс как состояние означал бы, что каждый доворот
     * корпуса приходит клиенту подстановкой угла — то есть рывком башни на экране.
     */
    private turretLocal = 0;
    private turretGoal = 0;
    /** Текущее состояние вращения башни (TURRET_CONTROL_*; 0 — стоит). Уезжает в каждом пакете движения. */
    private turretControl = 0;
    /** Текущие «нажатые клавиши» корпуса (HULL_CONTROL_*). Уезжают тем же полем `control`. */
    private hullControl = 0;
    /** Что из этого уже знает клиент: на смене клавиш пакет уходит немедленно, не дожидаясь такта тишины. */
    private lastSentHullControl = 0;
    /** Состояние вращения из последнего дискретного TurretRotation — по нему видно, что уже знает клиент. */
    private lastSentControl = 0;
    /** Направление вращения прошлого такта: на смене знака скорость сбрасывается — как у клиента. */
    private turretDirection = 0;
    /** Текущая угловая скорость башни (рад/с): она разгоняется, а не щёлкает на угол цели. */
    private turretAngular = 0;
    /** Тактов подряд, когда шаг вперёд не прошёл: так ловится упор в стену. */
    private blockedTicks = 0;
    /** Расталкивание сдвинуло корпус на этом такте: клавишами клиент такой сдвиг не воспроизведёт,
     *  поэтому поправка позиции обязана уйти немедленно (см. CRUISE_RESEND_MS). */
    private separated = false;
    /** Интерес получателей: ник -> ближний/дальний, когда и с какими битами корпуса мы ему слали. */
    private readonly interest = new Map<string, { near: boolean; lastAt: number; lastHull: number }>();
    /** Высота на начало такта: от неё считается, насколько танк вообще имел право подняться. */
    private tickStartZ = 0;

    private goal: IVector3 | null = null;
    private goalUntil = 0;
    private lastMoveSentAt = 0;

    private respawnAt: number | null = null;
    private placeAt: number | null = null;
    private activateAt: number | null = null;

    private lastShotAt = 0;
    /** Ствол твинса, из которого пойдёт следующая плазма (0/1 — как у живого игрока). */
    private twinsBarrel = 0;
    /** Когда рельса начала накапливать заряд; null — не заряжается. */
    private chargeStartedAt: number | null = null;
    /** Идёт ли сейчас струя огнемёта (чтобы не слать «начали» дважды и не забыть «закончили»). */
    private flaming = false;
    private strafeSign = Math.random() < 0.5 ? 1 : -1;
    private strafeUntil = 0;

    private coverPos: IVector3 | null = null;
    private coverUntil = 0;

    /** Выбранный обход препятствия и до какого момента его держим (иначе корпус дёргается). */
    private avoidOffset = 0;
    private avoidUntil = 0;

    /** Что и когда ушло в последнем пакете движения — по этой дельте считаются рассылаемые скорости. */
    private lastSentPos: IVector3 | null = null;
    private lastSentOrientation: IVector3 = { x: 0, y: 0, z: 0 };
    /** Угол башни из последнего пакета: по нему видно, сколько башня уехала «молча». */
    private lastSentAngle = 0;

    private stuckSince = 0;
    private stuckAnchor: IVector3 = { x: 0, y: 0, z: 0 };
    private unstickUntil = 0;
    private unstickHeading = 0;
    /** До какого момента идёт откат назад; 0 — откат не идёт и новый курс уже выбран. */
    private reverseUntil = 0;
    /** Откуда и с какого момента бот не может уехать, и сколько раз он уже пробовал выбраться. */
    private progressAnchor: IVector3 = { x: 0, y: 0, z: 0 };
    private progressSince = 0;
    private escapeAttempts = 0;
    /** Курсы, в которые бот уже ткнулся, и до какого момента про них помнить. */
    private readonly deadEnds: { heading: number; until: number }[] = [];

    /** Последние замеченные позиции врагов — по ним считается упреждение при стрельбе. */
    private readonly tracks = new Map<string, { pos: IVector3; at: number; vx: number; vy: number }>();

    constructor(public readonly client: BotClient, public readonly index: number, private readonly accuracy: number) { }

    public get user() { return this.client.user!; }

    // ---------------------------------------------------------------- жизненный цикл

    public update(ctx: IBotTickContext): void {
        const client = this.client;
        if (client.isDestroyed) return;

        // Танк уже отдан клиентам, ждём паузу перед активацией (см. ACTIVATE_DELAY_MS).
        if (this.activateAt !== null) {
            if (ctx.now >= this.activateAt) this._activate(ctx);
            return;
        }

        // Точка спавна выбрана (нами или перезапуском раунда) — доводим появление до конца.
        if (client.pendingSpawnPoint) {
            if (this.placeAt === null) this.placeAt = ctx.now + PLACE_DELAY_MS;
            if (ctx.now >= this.placeAt) this._place(ctx);
            return;
        }
        this.placeAt = null;

        if (client.battleState !== "active") {
            if (!this.spawnAllowed) return;
            if (this.respawnAt === null) this.respawnAt = ctx.now + RESPAWN_DELAY_MS;
            if (ctx.now >= this.respawnAt) {
                this.respawnAt = null;
                // Во время паузы результатов prepareRespawn ничего не делает — просто попробуем позже.
                ctx.prepareRespawn(client);
            }
            return;
        }

        this.respawnAt = null;
        this._think(ctx);
    }

    /** Ставит танк на точку спавна и рассылает Spawn. Активация — отдельным шагом, с паузой. */
    private _place(ctx: IBotTickContext): void {
        const client = this.client;
        const spawn = client.pendingSpawnPoint;
        if (!spawn) return;

        // Точка спавна приходит уже в «пакетной» системе (orientation.z), поэтому курс получаем обратным
        // переводом — иначе бот стартовал бы повёрнутым на 90°.
        this.facing = wrapAngle(spawn.rotation.z - YAW_FROM_HEADING);
        this.pos.x = spawn.position.x;
        this.pos.y = spawn.position.y;
        this.pos.z = spawn.position.z;

        // Сажаем точку спавна на землю И на её наклон ДО рассылки: иначе клиент получил бы танк на
        // «сырой» высоте точки плашмя, а следующим тиком мы бы дёрнули его на пол и завалили по склону —
        // видимый рывок при появлении. На спавне нормаль берём сразу, без сглаживания.
        this.up = { x: 0, y: 0, z: 1 };
        this._settle(ctx, spawn.position.z + STEP_UP, 1, true);
        spawn.position.z = this.pos.z;
        // Rotation точки спавна — ОБЩИЙ объект из данных карты (см. SpawnService.getSpawnPoint): править
        // его на месте нельзя, поэтому подкладываем свой. Spawn у клиентов уйдёт уже с наклоном.
        spawn.rotation = { ...this.orientation };

        this.speed = 0;
        this.angular = 0;
        this.turret = this.facing;
        this.turretLocal = 0;
        this.turretGoal = this.facing;
        this.turretAngular = 0;
        this.turretControl = 0;
        this.lastSentControl = 0;
        this.turretDirection = 0;
        this.hullControl = 0;
        this.lastSentHullControl = 0;
        this.blockedTicks = 0;
        this.goal = null;
        this.coverPos = null;
        this.state = "patrol";
        // Появление — это телепорт: считать по нему скорость нельзя, иначе первый же пакет унесёт танк.
        this.lastSentPos = null;
        // Спавн разослан всем — интерес получателей классифицируем заново от новой точки.
        this.interest.clear();
        this.avoidUntil = 0;
        this.unstickUntil = 0;
        this.reverseUntil = 0;
        this.deadEnds.length = 0;
        this.stuckAnchor = { ...this.pos };
        this.stuckSince = ctx.now;
        this.progressAnchor = { ...this.pos };
        this.progressSince = ctx.now;
        this.escapeAttempts = 0;

        BattleWorkflow.placeTank(client);
        this.placeAt = null;

        client.battlePosition = { ...this.pos };
        client.battlePositionPrevious = { ...this.pos };
        client.battleOrientation = { ...this.orientation };
        client.turretAngle = this.turretLocal;
        client.turretControl = 0;
        this.lastSentOrientation = { ...this.orientation };
        this.lastSentAngle = client.turretAngle;

        this.activateAt = ctx.now + ACTIVATE_DELAY_MS;
    }

    /** ReadyToActivate от клиента не придёт — активируем сами, иначе танк останется «newcome». */
    private _activate(ctx: IBotTickContext): void {
        const client = this.client;
        this.activateAt = null;
        if (client.currentBattle !== ctx.battle) return;
        client.battleState = "active";
        client.damageFromAttackers.clear();
        client.supplyReadyAt.clear();
        ctx.battle.broadcast(new ActivateTankPacket({ nickname: this.user.username }));
    }

    /**
     * Сажает корпус на рельеф: высота — по опоре под гусеницами, наклон — по её нормали, и оба
     * пересчитываются в углы Эйлера, которые ждёт клиент.
     *
     * Вызывается КАЖДЫЙ такт, а не только при перемещении. Высоту раньше давал только `_stepTo`
     * (и только когда бот реально ехал), а тангаж и крен не считались вовсе: в пакет уходил один курс,
     * и на пандусе бот ехал горизонтально, наполовину утопленный в склоне.
     *
     * `blend` — доля, на которую нормаль подтягивается к новой (1 — мгновенно, для спавна). На ходу
     * доворот ограничен TILT_RATE, иначе корпус щёлкал бы на каждом стыке коробок карты. `snap` сажает
     * танк на землю одним движением — только при появлении, когда высота ещё «сырая».
     */
    private _settle(ctx: IBotTickContext, ceiling: number, blend: number, snap = false): void {
        // Стоящий на месте танк опору не меняет: пересчитывать пять лучей на такт незачем — при
        // двух сотнях ботов на сервере это заметная доля процессора. Курс всё равно раскладываем.
        if (!snap && this.speed === 0 && this.angular === 0) {
            this.orientation = orientationFromUp(this.facing, this.up);
            return;
        }

        const mapId = ctx.battle.mapResourceId;
        const hull = hullCollision[this.user.equippedHull] ?? HULL_FALLBACK;
        const contact = sampleGroundContact(
            (x, y) => ctx.collision.raycastGroundZ(mapId, x, y, ceiling),
            this.pos.x, this.pos.y, this.facing, hull.halfY, hull.halfX,
        );

        // Под центром пустота (паркур, полёт с трамплина) — высоту и наклон держим прежние, но курс
        // всё равно надо разложить заново: корпус за такт довернулся.
        if (contact) {
            // Вверх посадка поднимает не выше, чем танк успел бы ВЪЕХАТЬ за этот такт, и считается это
            // от высоты на НАЧАЛО такта: шаг вперёд уже израсходовал часть того же запаса, и без общего
            // потолка танк набирал бы вдвое. Иначе, упершись бортом в стену, он всплывал бы по ней тик за
            // тиком (каток внутри стены находит её верх). Вниз — без ограничений: с уступа танк падает сразу.
            const rest = contact.z + RIDE_HEIGHT;
            const climb = Math.max(1, Math.abs(this.speed) * ctx.dt * MAX_CLIMB);
            this.pos.z = snap ? rest : Math.min(rest, this.tickStartZ + climb);
            const target = clampTilt(contact.normal, MAX_TILT);
            this.up = {
                x: this.up.x + (target.x - this.up.x) * blend,
                y: this.up.y + (target.y - this.up.y) * blend,
                z: this.up.z + (target.z - this.up.z) * blend,
            };
        }
        this.orientation = orientationFromUp(this.facing, this.up);
    }

    // ---------------------------------------------------------------- принятие решений

    private _think(ctx: IBotTickContext): void {
        const { battle } = ctx;
        // Раунд закончился — идёт табло результатов и пауза перед рестартом. Живого игрока в этот момент
        // обездвиживает его собственный клиент: ни газа, ни руля, ни выстрела. Бот обязан замереть так
        // же (см. _freeze), иначе по замершей карте катаются одни боты. Штабная /pause — не то же самое:
        // там «бой заморожен, ездить можно», и ездить продолжают все.
        if (battle.roundState === BattleRoundState.FINISHED) { this._freeze(ctx); return; }

        this.tickStartZ = this.pos.z;
        const enemy = this._selectTarget(ctx);
        this._updateState(ctx, enemy);

        const goal = this._resolveGoal(ctx, enemy);
        this._navigate(ctx, goal);
        // Выбираясь из безнадёжного тупика, бот мог сам себя уничтожить (см. _checkHopeless). Танка
        // больше нет, и досылать на него движение или выстрел нельзя: клиент дерефит уничтоженный объект.
        if (this.client.battleState !== "active") { this._stopFlame(ctx); return; }

        // Корпуса расталкиваем ПОСЛЕ шага навигации и ДО посадки на рельеф: сдвиг должен уйти клиенту
        // тем же пакетом, что и сам шаг, — уже с высотой и наклоном по новой точке.
        this._separateFromSquad(ctx);

        // Посадку на рельеф считаем ПОСЛЕ движения и ДО прицеливания: наклон корпуса разворачивает
        // башню, а высота корпуса задаёт, откуда идёт луч выстрела.
        this._settle(ctx, this.pos.z + CONTACT_RISE, Math.min(1, ctx.dt * TILT_RATE));

        // Прицеливание считаем ДО рассылки: угол башни уезжает тем же пакетом, что и позиция.
        this._aim(ctx, enemy);
        this._publishMovement(ctx);
        if (!battle.paused && enemy) this._tryShoot(ctx, enemy);
        this._tryTakeBonus(ctx);
    }

    /**
     * Замирание на конец раунда: бот стоит ровно так же, как обездвиженный клиентом живой игрок.
     *
     * Одного «не думать» мало. Принимающий клиент ведёт чужой танк СВОЕЙ физикой по последним
     * присланным клавишам (см. HULL_CONTROL_* и _publishMovement), поэтому бот, замолчавший на полном
     * газу, продолжит у него ехать. Значит на паузу надо уйти пакетом с отпущенными клавишами.
     *
     * Таймеры застревания здесь тоже переводятся: бот стоит по приказу, а не потому что уткнулся в
     * стену. Иначе _checkStuck поднял бы его откатом посреди табло результатов, а _checkHopeless
     * (HOPELESS_MS короче паузы) довёл бы до самоуничтожения.
     */
    private _freeze(ctx: IBotTickContext): void {
        this._stopFlame(ctx);
        // Недокачанный заряд рельсы паузу не переживает: иначе бот открывает новый раунд выстрелом,
        // который начал заряжать ещё в прошлом.
        this.chargeStartedAt = null;

        this.stuckSince = ctx.now;
        this.stuckAnchor = { ...this.pos };
        this.progressSince = ctx.now;
        this.progressAnchor = { ...this.pos };
        this.escapeAttempts = 0;
        this.blockedTicks = 0;
        this.avoidUntil = 0;
        this.unstickUntil = 0;
        this.reverseUntil = 0;
        // Цель и укрытие выбирались под ещё идущий бой — после рестарта они выберутся заново.
        this.goalUntil = 0;
        this.coverUntil = 0;

        const settled = this.speed === 0 && this.angular === 0
            && this.hullControl === 0 && this.turretControl === 0
            && this.lastSentHullControl === 0 && this.lastSentControl === 0;
        this.speed = 0;
        this.angular = 0;
        this.turretAngular = 0;
        this.turretDirection = 0;
        this.hullControl = 0;
        this.turretControl = 0;
        this.client.turretControl = 0;
        if (settled) return; // клиенты уже знают, что этот танк стоит с отпущенными клавишами

        this._publishStop(ctx);
    }

    /**
     * Тот самый стоп-пакет: обычный FullMove, но с control=0 и нулевыми скоростями. Получатель глушит
     * мотор и останавливает башню, вместо того чтобы доезжать начатое своей физикой и экстраполировать
     * последнюю известную скорость.
     */
    private _publishStop(ctx: IBotTickContext): void {
        const client = this.client;
        client.battlePositionPrevious = client.battlePosition;
        client.battlePosition = { ...this.pos };
        client.battleOrientation = { ...this.orientation };
        this.lastMoveSentAt = ctx.now;
        // Возвращение в бой после рестарта — телепорт на точку спавна: считать по нему скорость нельзя.
        this.lastSentPos = null;
        // В эфир не вещаем (входящий игрок строит бой / пустой бой) — но состояние всё равно сброшено,
        // а отметки о разосланном НЕ трогаем: стоп уедет тем же путём, как только вещание вернётся.
        if (ctx.mute || ctx.silent) return;

        this.lastSentOrientation = { ...this.orientation };
        this.lastSentAngle = client.turretAngle;
        this.lastSentHullControl = 0;
        this.lastSentControl = 0;

        const zero = { x: 0, y: 0, z: 0 };
        const packet = new FullMovePacket({
            nickname: this.user.username,
            angularVelocity: zero,
            control: 0,
            linearVelocity: zero,
            orientation: { ...this.orientation },
            position: { ...this.pos },
            direction: client.turretAngle,
        });
        ctx.battle.broadcastRaw(packet.write(), packet.getId(), this.user.id);
    }

    /** Оружие готово к выстрелу (откат прошёл). */
    private _weaponReady(now: number): boolean {
        return now - this.lastShotAt >= this._reloadMs();
    }

    /** Переключение состояния автомата: броня, наличие цели, дистанция и готовность оружия. */
    private _updateState(ctx: IBotTickContext, enemy: GameClient | null): void {
        const armor = this.client.currentHealth / 10000;
        if (this.state === "retreat") {
            if (armor >= SAFE_ARMOR) this.state = enemy ? "attack" : "patrol";
            return;
        }
        if (armor < LOW_ARMOR && enemy) {
            this.state = "retreat";
            return;
        }
        if (!enemy) {
            this.state = "patrol";
            return;
        }
        const d = dist2(this.pos, enemy.battlePosition!);
        const engaged = d <= this._fireRange() && this._hasLineOfSight(ctx, enemy.battlePosition!);
        if (!engaged) {
            this.state = "chase";
            return;
        }
        // Перезаряжается — уходит за укрытие, чтобы не стоять под огнём впустую; как только откат
        // прошёл, снова выкатывается и стреляет.
        const reloadLeft = this._reloadMs() - (ctx.now - this.lastShotAt);
        this.state = reloadLeft > this._reloadMs() * (1 - COVER_RELOAD_FRACTION) ? "cover" : "attack";
    }

    /** Ближайший видимый враг; при равных условиях — общая цель команды (сосредоточенный огонь). */
    private _selectTarget(ctx: IBotTickContext): GameClient | null {
        const { battle } = ctx;
        const myTeam = battle.teamOf(this.user);
        const plan = ctx.plans.get(myTeam);

        let best: GameClient | null = null;
        let bestScore = Infinity;
        for (const other of battle.clients) {
            if (other === this.client || other.isDestroyed || other.battleState !== "active") continue;
            const otherUser = other.user;
            const otherPos = other.battlePosition;
            if (!otherUser || !otherPos) continue;
            if (battle.isTeamMode() && battle.teamOf(otherUser) === myTeam) continue;

            const d = dist2(this.pos, otherPos);
            if (d > VIEW_RANGE) continue;
            this._track(ctx, other);
            if (!this._hasLineOfSight(ctx, otherPos)) continue;

            // Цель, назначенная командой, «весит» на треть ближе — так боты валят одного, а не
            // размазывают урон по всем сразу.
            const score = other === plan?.focus ? d * 0.66 : d;
            if (score < bestScore) { bestScore = score; best = other; }
        }
        return best;
    }

    /** Куда ехать: золото, укрытие, припас под ногами, объектив режима, помощь команде или патруль. */
    private _resolveGoal(ctx: IBotTickContext, enemy: GameClient | null): IBotGoal {
        const { battle } = ctx;

        // Золотой ящик бросает всё: за ним ныряет вся битва, и бот, объезжающий золото, сразу выдаёт
        // себя. Радиус большой, но не бесконечный — с другого конца карты бежать бессмысленно.
        const treasure = this._nearestBonus(ctx, BOT_TREASURE_TYPES, TREASURE_INTEREST);
        if (treasure) return { pos: treasure.position, arrive: OBJECTIVE_REACHED };

        if (this.state === "retreat" && enemy) {
            // Отступая, тоже предпочитаем спрятаться за стену, а не бежать по открытому полю.
            const shelter = this._coverGoal(ctx, enemy);
            return shelter ?? { pos: this._awayFrom(enemy.battlePosition!), arrive: GOAL_REACHED };
        }
        if (this.state === "cover" && enemy) {
            const shelter = this._coverGoal(ctx, enemy);
            if (shelter) return shelter;
        }

        // За припасом сворачиваем даже в командных режимах — но не в разгар перестрелки и не с флагом
        // в руках (тогда важнее донести его до базы).
        const supply = this._bonusGoal(ctx);
        if (supply) return supply;

        const objective = battle.settings.battleMode === BattleMode.CTF
            ? this._ctfGoal(ctx)
            : battle.settings.battleMode === BattleMode.CP
                ? this._cpGoal(ctx)
                : null;
        if (objective) return objective;

        if (enemy && (this.state === "attack" || this.state === "cover")) return { pos: this._combatGoal(ctx, enemy), arrive: 200 };
        if (this.state === "chase" && enemy) return { pos: enemy.battlePosition!, arrive: Math.min(KEEP_MIN, this._fireRange() * 0.5) };

        // Свободен: идём туда, где команда уже дерётся (совместный наскок), иначе патрулируем.
        const plan = ctx.plans.get(battle.teamOf(this.user));
        if (plan?.rally && dist2(this.pos, plan.rally) > GOAL_REACHED * 2) return { pos: plan.rally, arrive: GOAL_REACHED };
        return { pos: this._patrolGoal(ctx), arrive: GOAL_REACHED };
    }

    /**
     * Ближайшая точка рядом, из которой врага НЕ видно: бот прячется за угол/стену, пока перезаряжается
     * или зализывает раны. Перебираем несколько колец вокруг себя и берём первую проходимую точку, где
     * луч до врага перекрыт геометрией карты. Найденное держим COVER_HOLD_MS, чтобы не дёргаться.
     */
    private _coverGoal(ctx: IBotTickContext, enemy: GameClient): IBotGoal | null {
        const target = enemy.battlePosition!;
        if (this.coverPos && ctx.now < this.coverUntil) return { pos: this.coverPos, arrive: OBJECTIVE_REACHED * 2 };

        // Уже стоим в укрытии — никуда не едем.
        if (!this._hasLineOfSight(ctx, target)) {
            this.coverPos = { ...this.pos };
            this.coverUntil = ctx.now + COVER_HOLD_MS;
            return { pos: this.coverPos, arrive: OBJECTIVE_REACHED * 2 };
        }

        // Прячемся ОТ врага: сперва пробуем стороны, отвёрнутые от него.
        const away = Math.atan2(this.pos.y - target.y, this.pos.x - target.x);
        for (const radius of COVER_RADII) {
            for (let i = 0; i < COVER_DIRECTIONS; i++) {
                // Чередуем влево/вправо от направления «от врага», чтобы найти ближайший угол.
                const offset = (Math.ceil(i / 2) * (Math.PI * 2 / COVER_DIRECTIONS)) * (i % 2 === 0 ? 1 : -1);
                const heading = wrapAngle(away + offset);
                const spot = this._stepTo(ctx, heading, radius);
                if (!spot) continue;
                const eyeFrom = { x: spot.x, y: spot.y, z: spot.z + EYE };
                const eyeTo = { x: target.x, y: target.y, z: target.z + EYE };
                if (!ctx.collision.isBlockedBetween(ctx.battle.mapResourceId, eyeFrom, eyeTo)) continue;
                this.coverPos = spot;
                this.coverUntil = ctx.now + COVER_HOLD_MS;
                return { pos: spot, arrive: OBJECTIVE_REACHED * 2 };
            }
        }
        this.coverPos = null;
        return null;
    }

    /** В бою бот держит дистанцию и обходит цель по кругу, а не стоит столбом. */
    private _combatGoal(ctx: IBotTickContext, enemy: GameClient): IVector3 {
        const target = enemy.battlePosition!;
        const d = dist2(this.pos, target);
        const angle = Math.atan2(target.y - this.pos.y, target.x - this.pos.x);
        // Дистанция боя от орудия: огнемёту надо в упор, рельсе — наоборот, подальше.
        const keepMin = Math.min(KEEP_MIN, this._fireRange() * 0.5);
        const keepMax = Math.min(KEEP_MAX, this._fireRange() * 0.85);
        if (d < keepMin) {
            return { x: this.pos.x - Math.cos(angle) * 1200, y: this.pos.y - Math.sin(angle) * 1200, z: this.pos.z };
        }
        if (d > keepMax) return target;
        if (ctx.now >= this.strafeUntil) {
            this.strafeSign = -this.strafeSign;
            this.strafeUntil = ctx.now + 1500 + Math.random() * 2000;
        }
        const side = angle + (Math.PI / 2) * this.strafeSign;
        return { x: this.pos.x + Math.cos(side) * 900, y: this.pos.y + Math.sin(side) * 900, z: this.pos.z };
    }

    /** CTF: несу флаг — на свою базу; свой флаг уронили — возвращаю; союзник несёт — прикрываю его. */
    private _ctfGoal(ctx: IBotTickContext): IBotGoal | null {
        const { battle } = ctx;
        const team = battle.teamOf(this.user);
        if (team !== STATE_RED && team !== STATE_BLUE) return null;

        const iAmRed = team === STATE_RED;
        const ownBase = iAmRed ? battle.flagBasePositionRed : battle.flagBasePositionBlue;
        const ownFlagPos = iAmRed ? battle.flagPositionRed : battle.flagPositionBlue;
        const enemyFlagPos = iAmRed ? battle.flagPositionBlue : battle.flagPositionRed;
        const enemyFlagCarrier = iAmRed ? battle.flagCarrierBlue : battle.flagCarrierRed;
        const ownFlagCarrier = iAmRed ? battle.flagCarrierRed : battle.flagCarrierBlue;

        if (enemyFlagCarrier?.id === this.user.id && ownBase) return { pos: ownBase, arrive: OBJECTIVE_REACHED };

        // Свой флаг лежит не на базе — вернуть его важнее всего остального.
        if (ownFlagPos && ownBase && (ownFlagPos.x !== ownBase.x || ownFlagPos.y !== ownBase.y)) {
            return { pos: ownFlagPos, arrive: OBJECTIVE_REACHED };
        }
        // Свой флаг тащит враг — вся команда идёт за ним (его же выбирает и общий фокус огня).
        if (ownFlagCarrier) {
            const thief = ctx.server.findClientByUsername(ownFlagCarrier.username);
            if (thief?.battlePosition) return { pos: thief.battlePosition, arrive: KEEP_MIN };
        }

        const plan = ctx.plans.get(team);
        if (plan?.defenders.has(this.user.username) && ownBase) return { pos: ownBase, arrive: GOAL_REACHED };

        if (enemyFlagPos) return { pos: enemyFlagPos, arrive: OBJECTIVE_REACHED };
        // Флаг несёт союзник — сопровождаем его до базы, а не разбредаемся.
        if (enemyFlagCarrier) {
            const ally = ctx.server.findClientByUsername(enemyFlagCarrier.username);
            if (ally?.battlePosition) return { pos: ally.battlePosition, arrive: GOAL_REACHED };
        }
        return ownBase ? { pos: ownBase, arrive: GOAL_REACHED } : null;
    }

    /** CP: держим назначенную командой точку, по умолчанию — ближайшую незахваченную. */
    private _cpGoal(ctx: IBotTickContext): IBotGoal | null {
        const { battle } = ctx;
        if (battle.domPoints.length === 0) return null;
        const team = battle.teamOf(this.user);
        const plan = ctx.plans.get(team);

        const assigned = plan?.pointAssign.get(this.user.username);
        const point = (assigned !== undefined ? battle.domPoints.find((p) => p.id === assigned) : undefined)
            ?? this._nearestPoint(battle.domPoints.filter((p) => p.state !== team))
            ?? this._nearestPoint(battle.domPoints);
        if (!point) return null;

        // Стоять ровно в центре не нужно — достаточно уверенно войти в радиус захвата.
        return { pos: point.position, arrive: Math.max(OBJECTIVE_REACHED, point.radius * 0.5) };
    }

    private _nearestPoint(points: IDomPointState[]): IDomPointState | null {
        let best: IDomPointState | null = null;
        let bestD = Infinity;
        for (const p of points) {
            const d = dist2(this.pos, p.position);
            if (d < bestD) { bestD = d; best = p; }
        }
        return best;
    }

    /** Ближайший интересный припас, если ради него стоит свернуть. */
    private _bonusGoal(ctx: IBotTickContext): IBotGoal | null {
        if (this.state === "attack") return null;
        const battle = ctx.battle;
        // С флагом в руках за коробками не бегают.
        if (battle.flagCarrierRed?.id === this.user.id || battle.flagCarrierBlue?.id === this.user.id) return null;

        const bonus = this._nearestBonus(ctx);
        if (!bonus) return null;
        return { pos: bonus.position, arrive: OBJECTIVE_REACHED };
    }

    /** Патруль: случайная точка из «заведомо хороших» мест карты (спавны и зоны бонусов). */
    private _patrolGoal(ctx: IBotTickContext): IVector3 {
        if (this.goal && ctx.now < this.goalUntil && dist2(this.pos, this.goal) > GOAL_REACHED) return this.goal;

        const mapId = ctx.battle.mapResourceId;
        const spawns = getMapSpawns(mapId);
        const regions = getMapBonusRegions(mapId);
        const candidates: IVector3[] = [
            ...spawns.map((s) => s.position),
            ...regions.map((r) => ({ x: (r.min.x + r.max.x) / 2, y: (r.min.y + r.max.y) / 2, z: (r.min.z + r.max.z) / 2 })),
        ];
        this.goal = candidates.length > 0
            ? candidates[Math.floor(Math.random() * candidates.length)]
            : { x: this.pos.x + (Math.random() - 0.5) * 4000, y: this.pos.y + (Math.random() - 0.5) * 4000, z: this.pos.z };
        this.goalUntil = ctx.now + 15000;
        return this.goal;
    }

    private _awayFrom(threat: IVector3): IVector3 {
        const angle = Math.atan2(this.pos.y - threat.y, this.pos.x - threat.x);
        return { x: this.pos.x + Math.cos(angle) * 3000, y: this.pos.y + Math.sin(angle) * 3000, z: this.pos.z };
    }

    // ---------------------------------------------------------------- движение

    /**
     * Танковое движение: корпус доворачивается с ограниченной угловой скоростью и разгоном, а едет бот
     * ВДОЛЬ СВОЕГО КОРПУСА — не «скользит» боком к цели. Пока цель сильно сбоку, он разворачивается почти
     * на месте; если она позади и близко, сдаёт назад. Скорости берутся из паспорта корпуса, поэтому
     * симуляция на чужих клиентах совпадает с серверной.
     */
    private _navigate(ctx: IBotTickContext, goal: IBotGoal): void {
        // Выход из тупика идёт двумя шагами (см. _breakOff): сперва ОТКАТ назад, и только потом новый
        // курс. Разворот на месте из угла не помогает — упершийся нос никуда не денется, пока танк не
        // отъедет, и бот продолжает возить бортом по той же стене.
        if (ctx.now < this.reverseUntil) { this._backOut(ctx); return; }
        if (this.reverseUntil !== 0) this._pickEscape(ctx);

        const arrived = dist2(this.pos, goal.pos) <= goal.arrive;
        let desired = Math.atan2(goal.pos.y - this.pos.y, goal.pos.x - this.pos.x);
        if (ctx.now < this.unstickUntil) desired = this.unstickHeading;

        // Курс, по которому реально можно ехать (обход препятствия). Выбранный обход ДЕРЖИМ: без этого
        // проба перещёлкивалась между «влево» и «вправо» на каждом такте, корпус дёргался туда-сюда по
        // десять раз в секунду, и со стороны это выглядело как тряска танка на месте.
        let chosen: number | null = null;
        if (ctx.now < this.avoidUntil && this._stepTo(ctx, wrapAngle(desired + this.avoidOffset), PROBE_DISTANCE)) {
            chosen = wrapAngle(desired + this.avoidOffset);
        } else {
            // Первым проходом обходим стороной курсы, в которые бот уже ткнулся: без этой памяти он
            // выбирался из угла и тут же ехал обратно в него, потому что цель по-прежнему за стеной.
            for (const avoidDeadEnds of [true, false]) {
                for (const offset of HEADING_PROBES) {
                    const candidate = wrapAngle(desired + offset);
                    if (avoidDeadEnds && this._isDeadEnd(ctx, candidate)) continue;
                    if (!this._stepTo(ctx, candidate, PROBE_DISTANCE)) continue;
                    chosen = candidate;
                    this.avoidOffset = offset;
                    // Прямой курс держать незачем — держим только сам обход.
                    this.avoidUntil = offset === 0 ? 0 : ctx.now + AVOID_HOLD_MS;
                    break;
                }
                if (chosen !== null) break;
            }
        }

        const accel = this._acceleration();
        const turnAccel = this._turnAcceleration();

        /*
         * Управление корпусом — это НАЖАТЫЕ КЛАВИШИ, а не желаемая скорость.
         *
         * Принимающий клиент ведёт чужой танк своей физикой по битам 0..4 поля `control` (см.
         * HULL_CONTROL_*): бит газа — тяга на гусеницы, бит руля — доворот, а позицию и скорости из
         * пакета он применяет лишь как поправку, и то наполовину (`_SafeStr_13402` смешивает своё
         * состояние с пришедшим в отношении 1:1). Пока бот слал в этих битах нули, чужой танк у него
         * стоял с заглушенным мотором и раз в такт прыгал к присланной точке — отсюда и «резко и
         * неестественно», сколько ни сглаживай траекторию на сервере.
         *
         * Поэтому решение принимается в тех же терминах: газ нажат или отпущен, руль нажат или
         * отпущен. Плавность даёт не дробная тяга, а разгон и торможение — они одинаковые и у нас, и
         * у клиента, потому что берутся из одного паспорта корпуса.
         */
        let forward = 0;
        let steer = 0;

        if (!arrived && chosen !== null) {
            const err = wrapAngle(chosen - this.facing);
            // Задний ход, когда цель почти за спиной и близко — разворачиваться дольше, чем откатиться.
            const reverse = Math.abs(err) > 2.4 && dist2(this.pos, goal.pos) < 1500;

            // Руль отпускается ЗАРАНЕЕ — на той скорости, с которой корпус ещё успевает встать ровно
            // на нужный курс (v = sqrt(2*a*s)). Держать до упора значило бы проскочить курс и качаться
            // вокруг него: пропорциональный доворот именно так и вёл себя — бот стоял с нулевым газом
            // и качался, то есть «застревал» на ровном месте.
            const brakingTurn = Math.sqrt(2 * turnAccel * Math.abs(err));
            if (Math.abs(err) >= HEADING_DEADBAND && Math.abs(this.angular) < brakingTurn) {
                steer = err > 0 ? 1 : -1;
            }

            // Газ жмём, только когда корпус смотрит примерно туда, куда едем: сперва довернуться,
            // потом ехать — так же водит и живой игрок. И отпускаем на подходе, чтобы встать у цели,
            // а не проскочить её (тормозной путь v^2 / 2a).
            const stopping = (this.speed * this.speed) / (2 * accel);
            const remaining = dist2(this.pos, goal.pos) - goal.arrive;
            if (reverse) forward = -1;
            else if (Math.abs(err) < DRIVE_ARC && remaining > stopping) forward = 1;
        }

        // Разгон/торможение и доворот — ЗАКОНОМ ПРИНИМАЮЩЕГО КЛИЕНТА (см. _driveSpeed/_driveTurn):
        // он ведёт чужой танк своей физикой, и любое отличие серверной модели от неё приезжает
        // игроку ритмичным рывком-полупоправкой с каждым пакетом движения.
        const drive = this._driveSpeed(this.speed, forward, ctx.dt);
        this.speed = drive.speed;
        this.angular = this._driveTurn(this.angular, steer, ctx.dt);
        if (Math.abs(this.speed) < 1) this.speed = 0;
        if (Math.abs(this.angular) < 0.01) this.angular = 0;

        this.facing = wrapAngle(this.facing + this.angular * ctx.dt);

        const travel = drive.travel;
        const clearance = ctx.now < this.unstickUntil ? ESCAPE_CLEARANCE : STEP_CLEARANCE;
        if (Math.abs(travel) > 0.5) {
            const next = this._stepTo(ctx, travel > 0 ? this.facing : wrapAngle(this.facing + Math.PI), Math.abs(travel), clearance);
            if (next) {
                this.pos.x = next.x; this.pos.y = next.y; this.pos.z = next.z;
                this.blockedTicks = 0;
            } else {
                // Упор: газ есть, а шаг не проходит. Гасим ход и ОТПУСКАЕМ газ — иначе клиент продолжит
                // толкать танк в стену своей физикой, а мы будем каждый пакет оттаскивать его назад.
                this.speed = 0;
                forward = 0;
                if (++this.blockedTicks >= BLOCKED_TICKS) this._breakOff(ctx);
            }
        } else if (chosen === null && !arrived) {
            // Проходимого курса нет вовсе — бот стоит и НЕ упирается, поэтому счётчик упора сам собой не
            // растёт. Считаем это тем же тупиком: иначе бот молча ждал бы полторы секунды до _checkStuck.
            if (++this.blockedTicks >= BLOCKED_TICKS) this._breakOff(ctx);
        } else if (this.speed === 0) {
            this.blockedTicks = 0;
        }

        this._setHullControl(forward, steer);
        this._checkStuck(ctx, arrived);
        this._checkHopeless(ctx);
    }

    /**
     * Взаимное расталкивание ботов: окружность-окружность по XY между ботами одной битвы.
     *
     * Навигация ботов друг друга НЕ видит: несколько ботов, идущих к одной цели (точка сбора, золотой
     * ящик, общий фокус огня), на сервере честно въезжали друг в друга и стояли стопкой. Клиент же
     * танк-танк коллизии считает у себя и корпуса разводил — а очередная поправка позиции стягивала их
     * обратно в нахлёст. Эта борьба и выглядела как «дёргаются и въезжают друг в друга»: сгладить её
     * рассылкой нельзя, пока серверные позиции сами пересекаются.
     *
     * Поэтому разводим на сервере: центры ближе TANK_SEPARATION — каждый бот на своём такте отходит
     * вдоль нормали на половину наложения (не больше SEPARATION_STEP за такт, чтобы не телепортировать).
     * Навигацию сдвиг не ломает: курс и цель не трогаем, следующий шаг бот считает уже от новой точки.
     * Живых игроков не расталкиваем — их позиция клиент-авторитарна, двигать её с сервера нельзя.
     */
    private _separateFromSquad(ctx: IBotTickContext): void {
        this.separated = false;
        for (const other of ctx.squad) {
            if (other === this || other.client.isDestroyed || other.client.battleState !== "active") continue;
            if (Math.abs(other.pos.z - this.pos.z) > SEPARATION_LAYER) continue;
            const d = dist2(this.pos, other.pos);
            if (d >= TANK_SEPARATION) continue;

            // Стоим ровно друг в друге (спавн в одну точку) — нормали нет, расходимся каждый в свою
            // сторону по индексу в отряде.
            const away = d > 1
                ? Math.atan2(this.pos.y - other.pos.y, this.pos.x - other.pos.x)
                : wrapAngle((this.index * Math.PI) / 2);
            const push = Math.min((TANK_SEPARATION - d) / 2, SEPARATION_STEP);
            // Сквозь стену не расталкиваемся: сперва обычная проверка проезда, потом «щель» — как при
            // выходе из тупика. Некуда — значит на этом такте отходит только сосед.
            const spot = this._stepTo(ctx, away, push, ESCAPE_CLEARANCE) ?? this._stepTo(ctx, away, push, push);
            if (!spot) continue;
            this.pos.x = spot.x;
            this.pos.y = spot.y;
            this.pos.z = spot.z;
            this.separated = true;
        }
    }

    /**
     * Скорость корпуса за такт — ЗАКОНОМ ПРИНИМАЮЩЕГО КЛИЕНТА, а не идеальной рампой.
     *
     * Клиент ведёт чужой танк собственной физикой по битам control, и закон разгона у неё другой
     * (восстановлен из декомпилята _SafeStr_3091._SafeStr_12167, см. CLIENT_ACCEL_FLOOR):
     *   1) прибавка за кадр = газ * ускорение * кадр; ход ПРОТИВ нажатой клавиши гасится
     *      reverse-ускорением корпуса, отпущенный газ — обычным ускорением до нуля;
     *   2) сумма режется паспортным пределом скорости (задний ход — тем же пределом, что и передний);
     *   3) прибавка ПО ХОДУ движения умножается на (1 - |v|/vmax): тяга тает с ростом скорости;
     *   4) ускорение, упавшее ниже CLIENT_ACCEL_FLOOR на скорости выше половины паспортной, клиент
     *      заменяет ровно полкой CLIENT_ACCEL_FLOOR — ею и добирается до предела.
     *
     * Прежняя серверная рампа (v += a*dt до vmax) разгоняла Диктатор m0 до 700 ед/с за 0.64 с, а
     * клиент по своему закону — только к 1.35 с: скорости расходились до 226 ед/с, позиции — на
     * 21 ед уже за первые 300 мс и на 166 ед суммарно за разгон. Каждый пакет движения стягивал
     * клиенту танк вперёд полупоправкой — тот самый ритмичный рывок на каждом разгоне (после
     * каждого доворота, остановки, спавна), особенно заметный на медленных тяжёлых корпусах.
     *
     * Интегрируем субшагами клиентской кадровой сетки: Эйлер сразу с шагом 100 мс уезжает от
     * клиентского профиля на ~18 ед/с, субшаги 60 Гц совпадают с ним в ноль. Путь тоже копится по
     * субшагам (см. travel): скорость конца такта на весь такт завышала бы путь на разгоне.
     */
    private _driveSpeed(v: number, throttle: number, dt: number): { speed: number; travel: number } {
        const vmax = this._maxSpeed();
        const accel = this._acceleration();
        const reverseAccel = this._reverseAcceleration();
                const steps = Math.max(1, Math.round(dt * CLIENT_PHYSICS_HZ));
        const h = dt / steps;
        let travel = 0;
        for (let i = 0; i < steps; i++) {
            let dv: number;
            if (throttle === 0) {
                dv = Math.abs(v) <= accel * h ? -v : -Math.sign(v) * accel * h;
            } else if (v !== 0 && Math.sign(v) !== throttle) {
                dv = throttle * reverseAccel * h;
            } else {
                dv = throttle * accel * h;
            }
            const clamped = Math.max(-vmax, Math.min(vmax, v + dv));
            dv = clamped - v;
            if (throttle !== 0 && v !== 0 && Math.sign(v) === throttle) {
                dv *= Math.max(0, 1 - Math.abs(v) / vmax);
            }
            const surge = dv / h;
            if (Math.abs(surge) < CLIENT_ACCEL_FLOOR && Math.abs(clamped) > vmax / 2) {
                // Мёртвая зона 0.1 — как у клиента: стоящую на пределе скорость полка не дёргает.
                dv = (Math.abs(surge) <= 0.1 ? 0 : Math.sign(surge)) * CLIENT_ACCEL_FLOOR * h;
            }
            v = Math.max(-vmax, Math.min(vmax, v + dv));
            travel += v * h;
        }
        return { speed: v, travel };
    }

    /**
     * Угловая скорость корпуса — тем же законом клиента: рампа без сужения, НО руль ПРОТИВ текущего
     * доворота отрабатывается reverse-ускорением поворота (у корпусов оно почти вдвое выше обычного:
     * у Диктатора m0 — 3.41 против 1.81 рад/с²). Сервер раньше и тормозил, и разгонял доворот одним
     * ускорением — на каждой смене руля клиент гасил вращение вдвое быстрее серверной модели, и курс
     * приходилось дотаскивать поправками.
     */
    private _driveTurn(w: number, steer: number, dt: number): number {
        const wmax = this._maxTurnSpeed();
        const turnAccel = this._turnAcceleration();
        if (steer === 0) {
            const dw = turnAccel * dt;
            return Math.abs(w) <= dw ? 0 : w - Math.sign(w) * dw;
        }
        const rate = w !== 0 && Math.sign(w) !== steer ? this._reverseTurnAcceleration() : turnAccel;
        return Math.max(-wmax, Math.min(wmax, w + steer * rate * dt));
    }

    /** Складывает «нажатые клавиши» корпуса в биты, которые уедут клиенту полем `control`. */
    private _setHullControl(forward: number, steer: number): void {
        let control = 0;
        if (forward > 0) control |= HULL_CONTROL_FORWARD;
        else if (forward < 0) control |= HULL_CONTROL_BACKWARD;
        if (steer > 0) control |= HULL_CONTROL_LEFT;
        else if (steer < 0) control |= HULL_CONTROL_RIGHT;
        this.hullControl = control;
    }

    /**
     * Тупик: запоминаем курс, в который ткнулись, и уходим в откат. Новый курс выбирается не сейчас, а
     * ПОСЛЕ отката (см. _pickEscape) — от точки, куда бот отъедет, проходимо совсем не то же, что от
     * стены, в которую он уткнулся носом.
     */
    private _breakOff(ctx: IBotTickContext): void {
        this.blockedTicks = 0;
        this.escapeAttempts++;
        this._rememberDeadEnd(ctx, this.facing);
        // Ход и доворот НЕ обнуляем: откат сам оттормозит их паспортным ускорением (см. _backOut).
        // Мгновенная остановка — это рывок, который клиент отработать не может: он ведёт танк своей
        // физикой и просто проедет дальше, а следующий пакет оттащит его назад.
        this._setHullControl(0, 0);
        this.reverseUntil = ctx.now + REVERSE_MS;
        this.unstickUntil = 0;
        this.avoidUntil = 0;
        this.stuckSince = ctx.now;
        this.stuckAnchor = { ...this.pos };
        // Цель могла оказаться недостижимой — на следующем такте выберем новую.
        this.goalUntil = 0;
        this.coverUntil = 0;
    }

    /** Откат из тупика: задний ход по своему же курсу, без руля. Сзади стена — откат прекращаем. */
    private _backOut(ctx: IBotTickContext): void {
        // Руль отпущен: доворот гасится ускорением, а не щелчком в ноль.
        this.angular = this._driveTurn(this.angular, 0, ctx.dt);
        this.facing = wrapAngle(this.facing + this.angular * ctx.dt);
        // Клиент видит зажатый задний ход и интегрирует его к ПОЛНОМУ пределу скорости корпуса —
        // половинная цель на сервере значила бы каждый пакет отдёргивать танк, который у клиента
        // уже уехал дальше.
        const drive = this._driveSpeed(this.speed, -1, ctx.dt);
        this.speed = drive.speed;

        // Клиенту откат виден как зажатая клавиша заднего хода — иначе он весь откат простоит на месте
        // и потом дёрнется к присланной точке.
        this._setHullControl(-1, 0);

        const travel = Math.abs(drive.travel);
        if (travel <= 0.5) return;
        const next = this._stepTo(ctx, wrapAngle(this.facing + Math.PI), travel, ESCAPE_CLEARANCE);
        if (next) {
            this.pos.x = next.x; this.pos.y = next.y; this.pos.z = next.z;
            return;
        }
        // Зажали с обеих сторон: откатываться некуда, сразу переходим к выбору курса.
        this.speed = 0;
        this._setHullControl(0, 0);
        this._rememberDeadEnd(ctx, wrapAngle(this.facing + Math.PI));
        this.reverseUntil = ctx.now;
    }

    /** После отката: новый курс — проходимый и не в уже известный тупик. */
    private _pickEscape(ctx: IBotTickContext): void {
        this.reverseUntil = 0;
        this.unstickUntil = ctx.now + UNSTICK_MS;
        this.unstickHeading = this._escapeHeading(ctx);
        this.stuckSince = ctx.now;
        this.stuckAnchor = { ...this.pos };
    }

    private _escapeHeading(ctx: IBotTickContext): number {
        let passable: number | null = null;
        // Сперва ищем полноценный проезд, потом — щель: бот, зажатый в закутке, должен выбираться,
        // а не стоять там до конца боя.
        for (const clearance of [PROBE_DISTANCE, ESCAPE_CLEARANCE]) {
            for (const offset of ESCAPE_PROBES) {
                const heading = wrapAngle(this.facing + offset);
                if (!this._stepTo(ctx, heading, clearance, clearance)) continue;
                if (passable === null) passable = heading;
                if (this._isDeadEnd(ctx, heading)) continue;
                return heading;
            }
        }
        // Всё вокруг уже отмечено тупиком (или непроходимо) — едем хоть куда, лишь бы не стоять.
        return passable ?? wrapAngle(this.facing + Math.PI);
    }

    /** Курс, в который бот ткнулся: помним его, чтобы не выбрать тот же тупик следующим же тактом. */
    private _rememberDeadEnd(ctx: IBotTickContext, heading: number): void {
        for (let i = this.deadEnds.length - 1; i >= 0; i--) {
            if (this.deadEnds[i].until <= ctx.now) this.deadEnds.splice(i, 1);
        }
        this.deadEnds.push({ heading, until: ctx.now + DEAD_END_MEMORY_MS });
        if (this.deadEnds.length > DEAD_END_LIMIT) this.deadEnds.shift();
    }

    private _isDeadEnd(ctx: IBotTickContext, heading: number): boolean {
        for (const entry of this.deadEnds) {
            if (entry.until > ctx.now && Math.abs(wrapAngle(heading - entry.heading)) < DEAD_END_ARC) return true;
        }
        return false;
    }

    /** Самоуничтожение как последний манёвр — см. HOPELESS_MS. */
    private _checkHopeless(ctx: IBotTickContext): void {
        if (dist2(this.pos, this.progressAnchor) > HOPELESS_DISTANCE) {
            this.progressAnchor = { ...this.pos };
            this.progressSince = ctx.now;
            this.escapeAttempts = 0;
            return;
        }
        if (this.escapeAttempts < HOPELESS_ATTEMPTS || ctx.now - this.progressSince < HOPELESS_MS) return;
        this.progressAnchor = { ...this.pos };
        this.progressSince = ctx.now;
        this.escapeAttempts = 0;
        ctx.server.battleService.forceDestroyTank(this.client);
    }

    private _checkStuck(ctx: IBotTickContext, arrived: boolean): void {
        if (arrived || ctx.now < this.unstickUntil || ctx.now < this.reverseUntil) { this.stuckSince = ctx.now; this.stuckAnchor = { ...this.pos }; return; }
        if (dist2(this.pos, this.stuckAnchor) > STUCK_DISTANCE) { this.stuckSince = ctx.now; this.stuckAnchor = { ...this.pos }; return; }
        if (ctx.now - this.stuckSince < STUCK_MS) return;
        this._breakOff(ctx);
    }

    /**
     * Пробует сместиться на `distance` по курсу `heading`: сажает точку на землю и проверяет подъём,
     * обрыв, стену между текущей и новой позицией и зоны kill/kick. null — туда нельзя.
     */
    private _stepTo(ctx: IBotTickContext, heading: number, distance: number, clearance: number = PROBE_DISTANCE): IVector3 | null {
        const mapId = ctx.battle.mapResourceId;
        const nx = this.pos.x + Math.cos(heading) * distance;
        const ny = this.pos.y + Math.sin(heading) * distance;

        const ground = ctx.collision.raycastGroundZ(mapId, nx, ny, this.pos.z + STEP_UP);
        if (ground === null) return null; // пустота — там дыра в карте
        const nz = ground + RIDE_HEIGHT;
        // Подъём разрешаем ПО ДЛИНЕ шага: настоящий склон поднимает пропорционально пройденному пути.
        // Один порог STEP_UP на любую длину давал боту запрыгивать на 160 единиц за такт (шаг ~80) — то
        // есть на любой ящик или уступ; на стене из составленных коробок он так и «всплывал» вверх.
        if (nz - this.pos.z > Math.min(STEP_UP, distance * MAX_CLIMB)) return null; // стена или уступ
        if (this.pos.z - nz > MAX_DROP) return null; // обрыв

        const from = { x: this.pos.x, y: this.pos.y, z: this.pos.z + EYE };
        // Луч всегда тянем минимум на `clearance`: на короткой дистанции isBlockedBetween обрезает
        // концы и почти ничего не проверяет. Требуемый просвет — параметр: в обычной езде он большой
        // (бот заранее видит стену), а выбираясь из тупика бот соглашается протиснуться в щель, иначе
        // из закутка уже меньше PROBE_DISTANCE в поперечнике он не выедет НИКОГДА.
        const reach = Math.max(distance, clearance);
        const to = { x: this.pos.x + Math.cos(heading) * reach, y: this.pos.y + Math.sin(heading) * reach, z: nz + EYE };
        if (ctx.collision.isBlockedBetween(mapId, from, to)) return null;
        if (this._inHazard(ctx, nx, ny, nz)) return null;

        return { x: nx, y: ny, z: nz };
    }

    /** Зоны kill/kick карты: игрока туда заносит по неосторожности, бота туда пускать незачем. */
    private _inHazard(ctx: IBotTickContext, x: number, y: number, z: number): boolean {
        if (ctx.battle.boundsDisabled) return false;
        for (const box of getMapGeometries(ctx.battle.mapResourceId)) {
            if (x >= box.minX && x <= box.maxX && y >= box.minY && y <= box.maxY && z >= box.minZ && z <= box.maxZ) return true;
        }
        return false;
    }

    /** Классифицирует получателя для рассылки движения; null — этому клиенту не шлём вовсе. */
    private _interestOf(recipient: GameClient): { near: boolean; lastAt: number; lastHull: number } | null {
        if (recipient.isBot || recipient.isDestroyed || recipient.isJoiningBattle || !recipient.user) return null;
        let st = this.interest.get(recipient.user.username);
        if (!st) {
            // Первое знакомство считаем ближним: снимок входа уже отдал этому клиенту точное состояние.
            st = { near: true, lastAt: 0, lastHull: this.hullControl };
            this.interest.set(recipient.user.username, st);
        }
        return st;
    }

    /**
     * Пересчёт ближних/дальних получателей. Вход в радиус обслуживается НЕМЕДЛЕННО полным пакетом
     * (позиция, наклон, угол башни, клавиши; скорости нулевые — их принесёт первый регулярный пакет):
     * дальнему позиция досылалась раз в секунду, и первый обычный близкий пакет дёрнул бы танк
     * телепортом. Вызывается и на тихих тактах — получатель может въехать в радиус, пока бот стоит.
     */
    private _interestSweep(ctx: IBotTickContext): void {
        for (const recipient of ctx.battle.clients) {
            const st = this._interestOf(recipient);
            if (!st) continue;
            // Без позиции (зритель, только что вошедший) фильтровать нечем — такой всегда ближний.
            const pos = recipient.battlePosition;
            const d = pos ? dist2(this.pos, pos) : 0;
            if (st.near) {
                if (d > BOT_NEAR_EXIT) st.near = false;
                continue;
            }
            if (d > BOT_NEAR_RANGE) continue;
            st.near = true;
            const zero = { x: 0, y: 0, z: 0 };
            const entry = new FullMovePacket({
                nickname: this.user.username,
                angularVelocity: zero,
                control: this.hullControl | this.turretControl,
                linearVelocity: zero,
                orientation: { ...this.orientation },
                position: { ...this.pos },
                direction: this.client.turretAngle,
            });
            recipient.sendRaw(entry.write(), entry.getId());
            st.lastAt = ctx.now;
            st.lastHull = this.hullControl;
        }
    }

    /**
     * Рассылает движение и угол башни ОДНИМ пакетом FullMove и прогоняет серверные проверки.
     *
     * Почему именно FullMove, а не Move + TurretDirection. В клиенте обработчики движения (Move,
     * FullMove, RotateTurret) ищут танк по нику С ПРОВЕРКОЙ на null и просто пропускают пакет, если
     * танка ещё нет. А обработчик TurretDirection такой проверки НЕ делает и валится с #1009 — клиент
     * шлёт баг-репорт и после 13-й ошибки вешает окно «Произошла критическая ошибка», дальше на каждом
     * пакете. Танка «ещё нет» бывает всегда: между рассылкой модели бота и тем моментом, когда клиент её
     * построил, проходят секунды (в браузере — единицы секунд). FullMove несёт направление башни в поле
     * `direction`, поэтому отдельный пакет не нужен: башня видна, а падать нечему. Заодно вдвое меньше
     * пакетов на бота — клиенту легче.
     */
    private _publishMovement(ctx: IBotTickContext): void {
        const client = this.client;
        // Пока бот едет, пакет уходит каждый такт — им же едет и угол башни, лишнего это не стоит.
        // Пока бот СТОИТ и только крутит башню, частить незачем: клиент ведёт поворот сам по состоянию
        // вращения (см. `control` ниже), и от нас нужна лишь редкая поправка на расхождение.
        const driving = this.speed !== 0 || this.angular !== 0;
        // Со снятым состоянием вращения клиент башню не двигает вовсе, поэтому мелкий доворот «в упор»
        // (бот держит уже сведённый ствол на шевелящейся цели) обязан уехать сразу — иначе он копится
        // и приходит одним куском.
        const drifted = this.turretControl === 0 && Math.abs(wrapAngle(client.turretAngle - this.lastSentAngle)) >= TURRET_DRIFT;
        // Смена «нажатых клавиш» корпуса уходит НЕМЕДЛЕННО, даже если бот в этот момент встал: клиент
        // ведёт танк своей физикой и, не узнав об отпущенном газе, проедет ещё полсекунды сам.
        const rekeyed = this.hullControl !== this.lastSentHullControl;
        // Прямолинейный ход без событий клиент воспроизводит сам — частая поправка тут только дёргает
        // танк (см. CRUISE_RESEND_MS). Всё, что клиент сам не угадает, — поворот (angular != 0), смена
        // клавиш, снос башни, сдвиг расталкиванием — по-прежнему уходит немедленно.
        const cruising = driving && this.angular === 0 && !drifted && !rekeyed && !this.separated;
        const quiet = cruising
            ? (this.turretControl !== 0 ? TURRET_SYNC_MS : CRUISE_RESEND_MS)
            : driving || drifted || rekeyed ? 0 : (this.turretControl !== 0 ? TURRET_SYNC_MS : IDLE_RESEND_MS);
        if (ctx.now - this.lastMoveSentAt < quiet) {
            // Публикации не будет, но вход получателя в радиус интереса пропускать нельзя: ему нужен
            // немедленный полный пакет (см. _interestSweep), иначе первый близкий пакет — телепорт.
            if (!ctx.mute && !ctx.silent) this._interestSweep(ctx);
            return;
        }
        const elapsed = Math.max(0.001, (ctx.now - this.lastMoveSentAt) / 1000);
        this.lastMoveSentAt = ctx.now;

        const orientation = { ...this.orientation };
        client.battlePositionPrevious = client.battlePosition;
        client.battlePosition = { ...this.pos };
        client.battleOrientation = { ...orientation };

        // Кто-то только что вошёл в бой и ещё строит его у себя — в эфир не лезем, но серверную
        // позицию обновили выше, так что после паузы бот окажется там, где и должен. Пустой бой не
        // вещает по той же схеме, только навсегда (см. silent).
        if (ctx.mute || ctx.silent) {
            this.lastSentPos = null;
            void ctx.server.battleService.checkPlayerPosition(client).catch((e) => logger.error(`Bot position check failed: ${e}`));
            return;
        }

        /*
         * Скорости считаем по ФАКТИЧЕСКОЙ дельте с прошлого пакета, а не по внутренним speed/angular.
         * Клиент экстраполирует чужой танк ровно как `позиция + скорость * время`, поэтому расхождение
         * между заявленной скоростью и реальным перемещением он каждые 100 мс исправляет рывком назад —
         * это и есть тряска. Причины расхождения неустранимы по-другому: бот едет по дуге (курс меняется
         * внутри такта), упирается в стену и остаётся на месте, доворачивается почти на месте. Дельта же
         * сходится с позицией следующего пакета по построению.
         */
        const previous = this.lastSentPos;
        const linearVelocity = previous
            ? { x: (this.pos.x - previous.x) / elapsed, y: (this.pos.y - previous.y) / elapsed, z: (this.pos.z - previous.z) / elapsed }
            : { x: 0, y: 0, z: 0 };
        // Угловую скорость считаем по ВСЕМ трём углам, а не по одному курсу: на склоне корпус
        // доворачивается ещё и по тангажу с креном, и без этих составляющих клиент дотягивал бы танк
        // до нового наклона рывком в момент прихода пакета.
        const spun = this.lastSentOrientation;
        const angularVelocity = previous
            ? {
                x: wrapAngle(orientation.x - spun.x) / elapsed,
                y: wrapAngle(orientation.y - spun.y) / elapsed,
                z: wrapAngle(orientation.z - spun.z) / elapsed,
            }
            : { x: 0, y: 0, z: 0 };
        this.lastSentPos = { ...this.pos };
        this.lastSentOrientation = { ...orientation };
        this.lastSentAngle = client.turretAngle;
        this.lastSentHullControl = this.hullControl;

        const packet = new FullMovePacket({
            nickname: this.user.username,
            angularVelocity,
            // `control` этого пакета клиент разбирает и на корпус (биты 0..4 — нажатые клавиши), и на
            // башню (биты 5..7), и по обоим наборам ведёт танк САМ. Поэтому здесь едут оба состояния:
            // без битов корпуса чужой танк стоит с заглушенным мотором между пакетами, без битов башни
            // так же стоит башня.
            control: this.hullControl | this.turretControl,
            linearVelocity,
            orientation,
            position: { ...this.pos },
            direction: client.turretAngle,
        });
        // Свежие входы в радиус получают полный пакет прямо сейчас (lastAt этого такта) — регулярная
        // рассылка ниже их пропустит и не пришлёт дубль.
        this._interestSweep(ctx);
        const raw = packet.write();
        const id = packet.getId();
        for (const recipient of ctx.battle.clients) {
            const st = this._interestOf(recipient);
            if (!st || st.lastAt === ctx.now) continue;
            if (!st.near) {
                // Дальнему — только смена клавиш корпуса (немедленно) и редкий позиционный кипэлайв.
                // Башню ему держит в курсе дискретный TurretRotation: он вещается всем на каждой смене.
                const rekeyedFor = this.hullControl !== st.lastHull;
                if (!rekeyedFor && ctx.now - st.lastAt < BOT_FAR_RESEND_MS) continue;
            }
            recipient.sendRaw(raw, id);
            st.lastAt = ctx.now;
            st.lastHull = this.hullControl;
        }

        // Тот же серверный аудит, что и для игрока: флаги, мины, точки контроля, зоны смерти.
        void ctx.server.battleService.checkPlayerPosition(client).catch((e) => logger.error(`Bot position check failed: ${e}`));
    }

    // ---------------------------------------------------------------- стрельба

    /**
     * Доворачивает башню к цели ТЕМ ЖЕ СПОСОБОМ, каким это делает живой клиент.
     *
     * Живой игрок не шлёт «новый угол» каждый кадр: его клиент решает, в какую сторону крутить, и
     * держит СОСТОЯНИЕ вращения (биты 5/6 в `control`), а получатели крутят башню сами — с паспортным
     * ускорением до паспортной скорости. Угол в пакете для них лишь поправка. Бот же слал control=0 и
     * дискретный угол десять раз в секунду: получатель ничего не крутил, а переставлял башню рывком на
     * каждый пакет — то самое дёрганье, которого у живых нет.
     *
     * Поэтому здесь воспроизведён алгоритм клиента (`_SafeStr_17908`/`_SafeStr_3016` в library.swf):
     * пока до цели дальше одного такта хода — выставляем бит вращения и разгоняем башню тем же
     * интегратором, что и получатель; на подходе — гасим скорость и добираем остаток углом (сперва
     * половинками, потом точно в цель), а бит снимаем.
     *
     * Порядок внутри такта важен: СПЕРВА отрабатывается состояние, которое клиент уже применяет, и
     * только ПОТОМ выбирается новое. Наоборот было бы хуже, чем вообще без состояния: сервер разворачивал
     * бы башню в новую сторону тем же тактом, а клиент — только со следующего пакета, и на каждой смене
     * направления они расходились бы на два такта хода (около двадцати градусов).
     *
     * Считается всё в системе КОРПУСА — в ней живёт башня у клиента. Это принципиально: когда бот
     * доворачивает корпус, удерживая ствол на цели, угол башни относительно корпуса едет со скоростью
     * поворота корпуса, и без бита вращения клиент отрабатывал бы этот доворот рывками.
     */
    private _aim(ctx: IBotTickContext, enemy: GameClient | null): void {
        if (enemy) {
            const lead = this._leadPoint(ctx, enemy);
            this.turretGoal = Math.atan2(lead.y - this.pos.y, lead.x - this.pos.x);
        } else {
            this.turretGoal = this.facing;
        }

        const maxSpeed = this._turretSpeed();
        const accel = this._turretAcceleration();

        // Шаг 1: доигрываем такт с тем состоянием вращения, которое у клиента уже есть.
        if (this.turretDirection === 0) {
            this.turretAngular = 0;
        } else {
            this.turretAngular = Math.max(-maxSpeed, Math.min(maxSpeed, this.turretAngular + this.turretDirection * accel * ctx.dt));
            this.turretLocal = wrapAngle(this.turretLocal + this.turretAngular * ctx.dt);
        }

        // Шаг 2: где башня оказалась и куда ей теперь. Корпус за этот такт уже довернулся, а башня
        // вместе с ним — значит доля доворота корпуса сама собой входит в промах по цели.
        const goal = wrapAngle(turretAngleInHull(this.facing, this.up, this.turretGoal));
        const err = wrapAngle(goal - this.turretLocal);

        /*
         * Крутить вращением или добрать углом. Порог — сколько башня РЕАЛЬНО пройдёт за такт: клиент
         * разгоняет её от ТЕКУЩЕЙ скорости, а не сразу до паспортной. Мерить по паспортной (как клиент
         * меряет у себя) здесь нельзя: у него кадр 16 мс, и под доводку углом попадает доворот в
         * градус-полтора, а у бота такт 100 мс — туда попал бы доворот на десяток градусов, и клиент
         * получал бы его одной подстановкой, то есть рывком.
         *
         * Отсюда же и «тормоз»: разогнанная башня, которой до цели осталось меньше такта хода, вращение
         * СНИМАЕТ и ничего не подставляет. Клиент от снятого состояния тормозит мгновенно, скорость
         * обнуляется — и остаток добирается со следующего такта мелкими шагами «с места». Подставлять
         * весь остаток углом было бы тем же рывком, только на подлёте.
         */
        const wanted = err > 0 ? 1 : -1;
        const held = this.turretDirection === wanted ? Math.min(maxSpeed, Math.abs(this.turretAngular) + accel * ctx.dt) : accel * ctx.dt;
        const fromRest = accel * ctx.dt * ctx.dt;

        let control = 0;
        if (Math.abs(err) >= held * ctx.dt) {
            control = err > 0 ? TURRET_CONTROL_LEFT : TURRET_CONTROL_RIGHT;
        } else if (Math.abs(err) < fromRest && Math.abs(err) >= TURRET_EPSILON) {
            // Меньше самого мелкого шага «с места» — ставим башню точно в цель: клиент подставит тот же
            // угол, и это единственная подстановка, которая до него доходит.
            this.turretLocal = wrapAngle(this.turretLocal + err);
        }

        const direction = control === TURRET_CONTROL_LEFT ? 1 : control === TURRET_CONTROL_RIGHT ? -1 : 0;
        // Смена направления обнуляет скорость — так же, как у получателя, и в тот же момент: он
        // получит новое состояние этим же пакетом.
        if (direction !== this.turretDirection) this.turretAngular = 0;
        this.turretDirection = direction;

        // Курс ствола в мире — производная величина: по нему считаются линия огня и сведение на цель.
        this.turret = wrapAngle(turretHeadingFromHull(this.facing, this.up, this.turretLocal));
        const angle = this.turretLocal;
        this.turretControl = control;
        this.client.turretAngle = angle;
        /*
         * Бит вращения в client.turretControl НЕ зеркалим — он остаётся нулевым. Единственный читатель
         * этого поля — снимок боя для входящего игрока (getTankModelDataJson), а входящему боты как раз
         * молчат всё время его загрузки плюс BOT_STREAM_SETTLE_MS (см. mute). Клиент же по битам 5/6
         * из InitTank крутит башню САМ и без поправок: мгновенный срез «крутится», пойманный снимком,
         * вертел у новичка башни ботов секундами, пока не кончалась пауза вещания. У живых игроков
         * этого нет — их поток движения при чужом входе не глушится, поправки идут сразу.
         *
         * Поэтому в снимке башня бота стоит в текущем угле (client.turretAngle обновляется выше каждый
         * такт), а действительное состояние вращения новичок получает первым же FullMove после паузы:
         * его control собирается из this.turretControl (см. _publishMovement), и после конца паузы все
         * таймеры тишины давно истекли — поправка уходит в первые же такты, смены состояния не ждёт.
         */

        // Пока вошедший игрок строит бой, в эфир не шлём (см. mute в контексте такта). Отметку о
        // разосланном состоянии при этом НЕ трогаем: иначе смена, пришедшаяся на паузу, потерялась бы
        // вместе с пакетом, и клиент остался бы с башней, крутящейся не туда.
        if (ctx.mute || ctx.silent) return;
        if (control === this.lastSentControl) return;
        this.lastSentControl = control;

        // Дискретный RotateTurret шлём только на СМЕНЕ состояния вращения — ровно как клиент, который
        // шлёт его на нажатие и отпускание. Промежуточные углы уезжают полем `direction` в FullMove
        // (см. _publishMovement): отдельный TurretDirection слать НЕЛЬЗЯ, его обработчик в клиенте
        // падает на танке, который ещё не построен.
        const rotation = new TurretRotationPacket({ nickname: this.user.username, angle, control });
        ctx.battle.broadcastRaw(rotation.write(), rotation.getId(), this.user.id);
    }

    /** Куда цель приедет за время полёта снаряда — по замерам её скорости за последние тики. */
    private _leadPoint(ctx: IBotTickContext, enemy: GameClient): IVector3 {
        const target = enemy.battlePosition!;
        const track = this.tracks.get(enemy.user!.username);
        const flight = 0.18 + dist2(this.pos, target) / 45000;
        if (!track) return target;
        return { x: target.x + track.vx * flight, y: target.y + track.vy * flight, z: target.z };
    }

    private _track(ctx: IBotTickContext, enemy: GameClient): void {
        const pos = enemy.battlePosition!;
        const key = enemy.user!.username;
        const prev = this.tracks.get(key);
        if (prev) {
            const dt = Math.max(0.05, (ctx.now - prev.at) / 1000);
            // Сглаживаем: одиночный рывок (телепорт на респавне) не должен ломать упреждение.
            const vx = 0.5 * prev.vx + 0.5 * ((pos.x - prev.pos.x) / dt);
            const vy = 0.5 * prev.vy + 0.5 * ((pos.y - prev.pos.y) / dt);
            this.tracks.set(key, { pos: { ...pos }, at: ctx.now, vx, vy });
        } else {
            this.tracks.set(key, { pos: { ...pos }, at: ctx.now, vx: 0, vy: 0 });
        }
    }

    private _hasLineOfSight(ctx: IBotTickContext, target: IVector3): boolean {
        return !ctx.collision.isBlockedBetween(
            ctx.battle.mapResourceId,
            { x: this.pos.x, y: this.pos.y, z: this.pos.z + EYE },
            { x: target.x, y: target.y, z: target.z + EYE },
        );
    }

    /**
     * Точка выхода снаряда: центр танка плюс вылет ствола по направлению башни. Стрелять надо проверять
     * именно отсюда — луч из центра корпуса проходит сквозь стену, к которой танк прижался вплотную
     * (isBlockedBetween подрезает концы отрезка, чтобы опора под гусеницами не считалась преградой).
     */
    private _muzzle(): IVector3 {
        return {
            x: this.pos.x + Math.cos(this.turret) * MUZZLE_OFFSET,
            y: this.pos.y + Math.sin(this.turret) * MUZZLE_OFFSET,
            z: this.pos.z + EYE,
        };
    }

    /** Свободна ли линия огня от дула до цели (не от центра корпуса — см. _muzzle). */
    private _canShootAt(ctx: IBotTickContext, target: IVector3): boolean {
        return !ctx.collision.isBlockedBetween(
            ctx.battle.mapResourceId,
            this._muzzle(),
            { x: target.x, y: target.y, z: target.z + EYE },
        );
    }

    /**
     * Выстрел. Общая часть у всех орудий одна: дистанция, откат, СВЕДЁННАЯ башня и прямая видимость от
     * дула; дальше каждое орудие стреляет по-своему — теми же пакетами, что и живой игрок.
     */
    private _tryShoot(ctx: IBotTickContext, enemy: GameClient): void {
        if (this.state === "chase" || this.state === "patrol") { this._stopFlame(ctx); return; }
        if (this.client.battleState !== "active") return;
        // Пока вошедший игрок строит бой, не стреляем: пакеты выстрела адресованы танку, которого у
        // него ещё нет (см. mute в контексте такта).
        if (ctx.mute) { this._stopFlame(ctx); return; }

        const target = enemy.battlePosition!;
        const distance = dist2(this.pos, target);
        // Стреляем только когда РАССЫЛАЕМАЯ башня смотрит на цель. Сверять внутреннюю цель прицела
        // (turretGoal) с внутренним углом было нельзя: они сходятся мгновенно, а видимая игроку башня
        // в этот момент могла быть развёрнута ещё куда угодно — со стороны бот стрелял «спиной».
        const toTarget = Math.atan2(target.y - this.pos.y, target.x - this.pos.x);
        const aimed = Math.abs(wrapAngle(this.turret - toTarget)) <= AIM_TOLERANCE;
        // И только по прямой видимости ОТ ДУЛА: иначе бот палит в стену, за которой прячется цель.
        const clear = distance <= this._fireRange() && aimed && this._canShootAt(ctx, target);

        const weapon = this._weapon();
        if (weapon === "flamethrower") { this._fireFlame(ctx, enemy, clear, distance); return; }
        if (weapon === "railgun") { this._fireRailgun(ctx, enemy, clear, distance); return; }
        if (!clear || !this._weaponReady(ctx.now)) return;

        this.lastShotAt = ctx.now;
        // Выстрелил — можно снова прятаться, укрытие подберётся заново от текущей позиции.
        this.coverUntil = 0;
        if (weapon === "twins") this._fireTwins(ctx, enemy, distance);
        else this._fireSmoky(ctx, enemy, distance);
    }

    /** Угол выстрела с разбросом и признак «снаряд прошёл по корпусу цели, а не мимо». */
    private _shotSpread(ctx: IBotTickContext, enemy: GameClient, distance: number): { aim: number; hit: boolean } {
        const track = this.tracks.get(enemy.user!.username);
        const targetSpeed = track ? Math.hypot(track.vx, track.vy) : 0;
        // Чем дальше и чем быстрее цель — тем шире разброс; `accuracy` задаёт «класс» конкретного бота.
        const spread = (0.018 + 0.03 * (distance / this._fireRange()) + (targetSpeed > 250 ? 0.022 : 0)) / this.accuracy;
        const error = gauss() * spread;
        // Промах по фронту цели: боковое смещение луча на дистанции цели против полуширины корпуса.
        return { aim: wrapAngle(this.turret + error), hit: Math.abs(Math.tan(error) * distance) <= HULL_HALF_WIDTH };
    }

    /**
     * Смоки: одиночный выстрел. Промах виден клиенту отдельным пакетом (взрыв в точке промаха), а не
     * «невидимым» несостоявшимся уроном.
     */
    private _fireSmoky(ctx: IBotTickContext, enemy: GameClient, distance: number): void {
        const { aim, hit } = this._shotSpread(ctx, enemy, distance);
        if (!hit) {
            const impact = { x: this.pos.x + Math.cos(aim) * distance, y: this.pos.y + Math.sin(aim) * distance, z: enemy.battlePosition!.z + 40 };
            ctx.battle.broadcast(new SmokyStaticShotPacket({ nickname: this.user.username, hitPosition: impact }), this.user.id);
            return;
        }
        this._dealSmokyDamage(ctx, enemy, distance);
    }

    /**
     * Твинс: две плазмы поочерёдно из левого и правого ствола. Клиенту уходит тот же TwinsShot, что
     * ретранслируется живому игроку, — сгусток и всплеск он рисует сам. Урон без крита и с другим шагом
     * затухания: в твинсе дистанция делится на 200 (см. TwinsTargetShotCommandHandler).
     */
    private _fireTwins(ctx: IBotTickContext, enemy: GameClient, distance: number): void {
        const { aim, hit } = this._shotSpread(ctx, enemy, distance);
        this.twinsBarrel = this.twinsBarrel === 0 ? 1 : 0;
        ctx.battle.broadcast(new TwinsShotPacket({
            nickname: this.user.username,
            barrel: this.twinsBarrel,
            direction: { x: Math.cos(aim), y: Math.sin(aim), z: 0 },
        }), this.user.id);
        if (!hit) return;

        const physics = this._physics();
        const factor = this._falloff(distance / 200, physics?.max_damage_radius ?? 15, physics?.min_damage_radius ?? 61, (physics?.min_damage_percent ?? 2) / 100);
        void ctx.server.battleService.applyDamage(ctx.battle, this.client, enemy, this._rollDamage() * factor, 0)
            .catch((e) => logger.error(`Bot twins shot failed: ${e}`));
    }

    /**
     * Рельса: сперва зарядка (клиент рисует накопление), через фиксированное для модификации время —
     * луч. Урон одним равномерным броском и НЕ зависит от дистанции — как в RailgunShotCommandHandler.
     */
    private _fireRailgun(ctx: IBotTickContext, enemy: GameClient, clear: boolean, distance: number): void {
        if (this.chargeStartedAt === null) {
            if (!clear || !this._weaponReady(ctx.now)) return;
            this.chargeStartedAt = ctx.now;
            ctx.battle.broadcast(new StartChargingPacket({ nickname: this.user.username }), this.user.id);
            return;
        }
        if (ctx.now - this.chargeStartedAt < this._railgunChargeMs()) return;
        this.chargeStartedAt = null;
        this.lastShotAt = ctx.now;
        this.coverUntil = 0;

        const { aim, hit } = this._shotSpread(ctx, enemy, distance);
        const beamEnd = { x: this.pos.x + Math.cos(aim) * distance, y: this.pos.y + Math.sin(aim) * distance, z: enemy.battlePosition!.z + 40 };
        ctx.battle.broadcast(new RailgunShotPacket({
            shooterNickname: this.user.username,
            staticHitPoint: beamEnd,
            targets: hit ? [{ nickname: enemy.user!.username, localHitPoint: { x: 0, y: 0, z: 60 } }] : [],
        }), this.user.id);
        if (!hit) return;

        void ctx.server.battleService.applyDamage(ctx.battle, this.client, enemy, this._rollDamage(), 0)
            .catch((e) => logger.error(`Bot railgun shot failed: ${e}`));
    }

    /**
     * Огнемёт: непрерывная струя. Клиенту шлём начало и конец струи (те же пакеты, что и у игрока), а
     * урон капаем тиками, попутно нагревая цель — по нагреву клиент красит танк, и на нём же держится
     * остаточное горение (см. FirebirdHitCommandHandler).
     */
    private _fireFlame(ctx: IBotTickContext, enemy: GameClient, clear: boolean, distance: number): void {
        if (!clear) { this._stopFlame(ctx); return; }
        if (!this.flaming) {
            this.flaming = true;
            ctx.battle.broadcast(new StartShootingFlamethrowerPacket({ nickname: this.user.username }), this.user.id);
        }
        if (ctx.now - this.lastShotAt < FLAME_TICK_MS) return;
        this.lastShotAt = ctx.now;

        const turretMod = ItemUtils.getItemModification(this.user, "turret");
        const perPeriod = ItemUtils.getPropertyValue(turretMod, "DAMAGE_PER_SECOND", "DAMAGE_PER_PERIOD") ?? 0;
        const physics = this._physics();
        const factor = this._falloff(distance / 100, physics?.max_damage_radius ?? 5, physics?.min_damage_radius ?? 17, (physics?.min_damage_percent ?? 50) / 100);
        void ctx.server.battleService.applyDamage(ctx.battle, this.client, enemy, (perPeriod / 2) * factor, 0)
            .catch((e) => logger.error(`Bot flame tick failed: ${e}`));

        const heat = Math.min(1, enemy.visualTemperature + FLAME_HEAT_STEP);
        enemy.visualTemperature = heat;
        enemy.flameSource = this.user.username;
        ctx.battle.broadcast(new TankTemperaturePacket(enemy.user!.username, heat));
    }

    /** Гасит струю огнемёта, если она горела: и когда цель пропала, и на паузе вещания. */
    private _stopFlame(ctx: IBotTickContext): void {
        if (!this.flaming) return;
        this.flaming = false;
        ctx.battle.broadcast(new StopShootingFlamethrowerPacket({ nickname: this.user.username }), this.user.id);
    }

    /** Бросок урона орудия в его паспортных пределах. */
    private _rollDamage(): number {
        const turretMod = ItemUtils.getItemModification(this.user, "turret");
        const from = ItemUtils.getPropertyValue(turretMod, "DAMAGE", "DAMAGE_FROM") ?? 0;
        const to = ItemUtils.getPropertyValue(turretMod, "DAMAGE", "DAMAGE_TO") ?? from;
        return from + Math.random() * (to - from);
    }

    /** Затухание урона с дистанцией: полный до maxR, дальше линейно до minPct на minR. */
    private _falloff(distance: number, maxR: number, minR: number, minPct: number): number {
        if (distance <= maxR) return 1;
        if (distance >= minR) return minPct;
        return 1 - (1 - minPct) * ((distance - maxR) / (minR - maxR));
    }

    /** Урон и визуал попадания смоки — по той же формуле, что в SmokyTargetShotCommandHandler. */
    private _dealSmokyDamage(ctx: IBotTickContext, enemy: GameClient, distanceUnits: number): void {
        const turretMod = ItemUtils.getItemModification(this.user, "turret");
        const critChance = ItemUtils.getPropertyValue(turretMod, "CRITICAL_HIT_CHANCE") ?? 0;
        const critical = Math.random() * 100 < critChance;

        const physics = this._physics();
        const metres = distanceUnits / 100;
        const factor = this._falloff(metres, physics?.max_damage_radius ?? 40, physics?.min_damage_radius ?? 120, (physics?.min_damage_percent ?? 10) / 100);

        const dmgFrom = ItemUtils.getPropertyValue(turretMod, "DAMAGE", "DAMAGE_FROM") ?? 0;
        const dmgTo = ItemUtils.getPropertyValue(turretMod, "DAMAGE", "DAMAGE_TO") ?? dmgFrom;
        const critDamage = ItemUtils.getPropertyValue(turretMod, "CRITICAL_HIT_DAMAGE") ?? dmgFrom + dmgTo;
        const damage = critical ? critDamage : (dmgFrom + Math.random() * (dmgTo - dmgFrom)) * factor;

        ctx.battle.broadcast(new SmokyTargetShotPacket({
            nickname: this.user.username,
            targetNickname: enemy.user!.username,
            hitPosition: { x: 0, y: 0, z: 60 },
            impactForce: Math.max(0.01, 1.45 - 0.0075 * metres),
            critical,
        }), this.user.id);

        void ctx.server.battleService
            .applyDamage(ctx.battle, this.client, enemy, damage, critical ? 1 : 0)
            .catch((e) => logger.error(`Bot shot failed: ${e}`));
    }

    // ---------------------------------------------------------------- припасы

    /** Ближайший припас, который боту сейчас нужен (кристаллы/золото не трогаем — см. BOT_BONUS_TYPES). */
    private _nearestBonus(
        ctx: IBotTickContext,
        types: Set<string> = BOT_BONUS_TYPES,
        reach: number = BONUS_INTEREST,
    ): { id: string; position: IVector3; d: number } | null {
        let nearest: { id: string; position: IVector3; d: number } | null = null;
        for (const bonus of ctx.battle.activeBonuses.values()) {
            if (!types.has(bonus.type)) continue;
            // Аптечка нужна только раненому, остальное — всегда.
            if (bonus.type === "health" && this.client.currentHealth > 8500) continue;
            const d = dist2(this.pos, bonus.position);
            // Кристаллы бот собирает ПО ПУТИ: они не дают ему ничего (начисления боту нет), но брошенные
            // ящики копятся на поле десятками и топят клиент отрисовкой. Ради них крюк должен быть коротким.
            if (d > (bonus.type === "crystall" ? CRYSTAL_INTEREST : reach)) continue;
            if (!nearest || d < nearest.d) nearest = { id: bonus.id, position: bonus.position, d };
        }
        return nearest;
    }

    /**
     * Подбирает всё, что лежит под гусеницами, — тем же путём, каким это делает клиент (TakeBonusCommand).
     * Радиусы интереса здесь ни при чём: коробку, на которую бот наехал по дороге, он берёт всегда,
     * даже если ехал совсем за другим.
     */
    private _tryTakeBonus(ctx: IBotTickContext): void {
        for (const bonus of ctx.battle.activeBonuses.values()) {
            if (!BOT_BONUS_TYPES.has(bonus.type)) continue;
            if (dist2(this.pos, bonus.position) > BONUS_PICKUP) continue;
            ctx.bonus.takeBonus(this.client, ctx.battle, bonus.id);
        }
    }

    // ---------------------------------------------------------------- паспорт танка

    private _physics(): { reload?: number; max_damage_radius?: number; min_damage_radius?: number; min_damage_percent?: number; special_entity?: { chargingTimeMsec?: number } } | undefined {
        const id = `${this.user.equippedTurret}_m${this.user.turrets.get(this.user.equippedTurret) ?? 0}`;
        return weaponPhysicsData.weapons.find((w) => w.id === id) as { reload?: number } | undefined;
    }

    /** Тип орудия бота. Всё, что не из списка, стреляет по смоки-механике — она самая простая. */
    private _weapon(): BotWeapon {
        const id = this.user.equippedTurret;
        return id === "twins" || id === "railgun" || id === "flamethrower" ? id : "smoky";
    }

    /**
     * Дальность огня орудия. Смоки достаёт далеко, рельса ещё дальше, а огнемёт бьёт на длину струи
     * (`range` в паспорте — в «метрах» игры, мир считается сотыми), и подходить к цели надо вплотную.
     */
    private _fireRange(): number {
        switch (this._weapon()) {
            case "railgun": return 9000;
            case "twins": return 5000;
            case "flamethrower": return 1500;
            default: return FIRE_RANGE;
        }
    }

    private _reloadMs(): number {
        // Огнемёт не перезаряжается: он льёт струю, темп урона задаёт FLAME_TICK_MS.
        if (this._weapon() === "flamethrower") return FLAME_TICK_MS;
        return this._physics()?.reload ?? 2000;
    }

    /** Время накопления заряда рельсы — фиксировано для модификации (то же значение проверяет сервер). */
    private _railgunChargeMs(): number {
        return this._physics()?.special_entity?.chargingTimeMsec ?? 1100;
    }

    /** Паспорт корпуса — те же значения, что уходят клиенту в TankModelData. */
    private _hullPhysics() {
        return getHullMod(this.user.equippedHull, this.user.hulls.get(this.user.equippedHull) ?? 0);
    }

    /** Максимальная скорость в единицах мира: HULL_SPEED — «метры» игры, а мир считается сотыми. */
    private _maxSpeed(): number {
        return (ItemUtils.getTankSpecifications(this.user).speed || 8) * 100;
    }

    /** Продольное ускорение (единицы мира/с²) — из HULL_POWER, в той же шкале, что и скорость. */
    private _acceleration(): number {
        const hullMod = ItemUtils.getItemModification(this.user, "hull");
        return (ItemUtils.getPropertyValue(hullMod, "HULL_POWER", "HULL_ACCELERATION") ?? 10) * 100;
    }

    /** Reverse-ускорение корпуса (ед. мира/с²): им клиент гасит ход против нажатой клавиши.
     *  Фолбэк — тот же, что уходит клиенту в TankModelData (см. battle.workflow). */
    private _reverseAcceleration(): number {
        return (this._hullPhysics()?.reverseAcceleration ?? 18) * 100;
    }

    /** Reverse-ускорение поворота (рад/с²): руль против текущего доворота. Фолбэк — как в TankModelData. */
    private _reverseTurnAcceleration(): number {
        return this._hullPhysics()?.reverseTurnAcceleration ?? this._maxTurnSpeed() * 2.0;
    }

    private _maxTurnSpeed(): number {
        return ItemUtils.getTankSpecifications(this.user).maxTurnSpeed || 1.2;
    }

    private _turnAcceleration(): number {
        return this._hullPhysics()?.turnAcceleration ?? this._maxTurnSpeed() * 1.15;
    }

    /** Паспортная скорость поворота башни (рад/с) — TURRET_TURN_SPEED конкретного орудия. */
    private _turretSpeed(): number {
        return ItemUtils.getTankSpecifications(this.user).turretTurnSpeed || 1.5;
    }

    /** Паспортное угловое ускорение башни (рад/с²) — то же, что уходит клиенту в TankModelData. */
    private _turretAcceleration(): number {
        const mod = getTurretMod(this.user.equippedTurret, this.user.turrets.get(this.user.equippedTurret) ?? 0);
        return mod?.turretTurnAcceleration ?? this._turretSpeed() * 1.6;
    }
}
