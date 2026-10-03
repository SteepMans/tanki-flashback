import { RANKS_TOTAL } from "@/config/constants";
import { hullsData } from "@/config/hulls.data";
import { turretsData } from "@/config/turrets.data";
import { itemBlueprints, PREMIUM_PAINT_IDS } from "@/features/garage/garage.data";
import { LoadDependencies } from "@/features/loader/loader.packets";
import * as LobbyPackets from "@/features/lobby/lobby.packets";
import { ResourceId } from "@/generated/resourceTypes";
import { IPacket } from "@/packets/packet.interfaces";
import { GameClient } from "@/server/game.client";
import { GameServer } from "@/server/game.server";
import { UserDocument } from "@/shared/models/user.model";
import { IVector3 } from "@/shared/types/geom/ivector3";
import logger from "@/utils/logger";
import { ResourceManager } from "@/utils/resource.manager";
import { Battle, BattleMode } from "../battle.model";
import { TankModelDataPacket, UserConnectDMPacket, UserConnectTeamPacket } from "../battle.packets";
import { BattleWorkflow } from "../battle.workflow";
import { BonusService } from "../bonus.service";
import { CollisionService } from "../collision.service";
import { SpawnService } from "../spawn.service";
import { BotBrain, IBotTeamPlan, IBotTickContext } from "./bot.ai";
import { BotClient, createBotUser, IBotLoadout } from "./bot.client";

/** Общий такт ИИ всей битвы: один таймер на бой, а не по таймеру на бота. */
const BOT_TICK_MS = 100;
/**
 * Такт боя, в котором нет ни одного живого игрока. Такие бои — весь стартовый список: их никто не
 * видит, кроме превью в лобби, и считать их физику десять раз в секунду незачем. Как только в бой
 * заходит игрок, такт возвращается к BOT_TICK_MS (см. _tickInterval), и разницы он не замечает.
 * Именно это и позволяет держать сотню засеянных боёв вместо трёх десятков.
 */
const BOT_TICK_IDLE_MS = 300;
const BOT_TICK_TIMER = "botTick";
/** Потолок ботов в одном бою. Клиент хранит танки в Vector(60), поэтому оставляем запас живым игрокам. */
/** На сколько званий бот может отличаться от живого игрока. Разброс в обе стороны. */
const BOT_RANK_SPREAD = 3;

export const MAX_BOTS_PER_BATTLE = 30;
/** Сколько ждём подтверждения загрузки ресурсов бота живыми клиентами, прежде чем показать танк. */
const JOIN_ACK_TIMEOUT_MS = 6000;
/**
 * Пауза в вещании ботов после того, как живой игрок ДОСТРОИЛ бой у себя.
 *
 * Момент входа — самый тяжёлый для клиента: он разбирает карту и снимок танков и на секунду-другую
 * перестаёт успевать за сетью. Если в этот миг на него льётся поток движения и поворотов башен от
 * шести ботов, он валится с #1009 на танках, которых у него ещё нет, и вешает окно «Произошла
 * критическая ошибка» (после 13-й ошибки — и дальше на каждой). Живые игроки такой волны не создают:
 * их пакеты идут вразнобой и реже. Поэтому боты на это время замолкают — они продолжают жить на
 * сервере, просто не шлют обновления.
 */
const BOT_STREAM_SETTLE_MS = 1500;
/** Дальше этого расстояния бот врага не замечает — тот же порог, что в BotBrain (для общего плана). */
const TEAM_VIEW_RANGE = 10000;

/**
 * Из чего собираются ники ботов. Бот НЕ помечается ботом: в списке игроков он должен читаться как
 * обычный позывной, иначе бой сразу перестаёт выглядеть живым. Ники только из букв и цифр — как у
 * настоящих аккаунтов; занятый прямо сейчас ник отбраковывается (см. _pickNickname), а пул из пары
 * тысяч сочетаний делает совпадение с чьим-то реальным аккаунтом маловероятным.
 */
const NAME_HEADS = [
    "Shadow", "Iron", "Night", "Storm", "Steel", "Frost", "Blaze", "Silent", "Rapid", "Dark",
    "Wild", "Rusty", "Turbo", "Grim", "Solar", "Viper", "Crimson", "Arctic", "Neon", "Savage",
];
const NAME_TAILS = [
    "Wolf", "Hawk", "Fang", "Rider", "Strike", "Blade", "Fox", "Bear", "Thunder", "Hunter",
    "Ghost", "Raven", "Lynx", "Tiger", "Knight", "Sniper", "Ranger", "Falcon", "Cobra", "Panther",
];

/**
 * Орудия, за которые бот умеет стрелять: у каждого своя механика выстрела в BotBrain (смоки —
 * одиночный, твинс — плазма из двух стволов, рельса — заряд и луч, огнемёт — струя в упор). Всё
 * остальное бот палил бы пакетами смоки из чужого ствола, и на экране это выглядит поломанным.
 */
const BOT_TURRETS = ["smoky", "twins", "railgun", "flamethrower"];
/** Корпуса под них: от лёгких (успеть дойти на дистанцию струи) до тяжёлых под рельсу. */
const BOT_HULLS = ["hunter", "wasp", "hornet", "titan", "dictator", "mammoth", "viking"];
/**
 * Краски, которые боту не положены, хотя по званию и открыты: «Премиум» даётся подпиской, «Помощник» —
 * только модераторам (и даёт 30% сопротивления любому оружию, см. GarageService._canAccessHelperPaint).
 */
const BOT_PAINTS_DENIED = new Set([...PREMIUM_PAINT_IDS, "helper"]);

const STATE_RED = 0;
const STATE_BLUE = 1;

const dist2 = (a: IVector3, b: IVector3): number => Math.hypot(a.x - b.x, a.y - b.y);

const turretMods = (id: string) => turretsData.find((t) => t.id === id)?.mods;
const hullMods = (id: string) => hullsData.find((h) => h.id === id)?.mods;

/** Старшая модификация предмета, открытая на этом звании; -1 — предмет на нём ещё не доступен. */
function highestModAtRank(mods: { rank: number }[] | undefined, rank: number): number {
    if (!mods) return -1;
    let best = -1;
    for (let i = 0; i < mods.length; i++) if (mods[i].rank <= rank) best = i;
    return best;
}

/**
 * Боты как полноценные участники боя: подсадка/снятие, общий такт ИИ и командный план (кого валим
 * всей толпой, кто идёт в защиту, кто на какую точку). Боты живут только пока в битве есть живой
 * игрок — иначе пустой бой никогда бы не «опустел» и не удалился.
 */
export class BattleBotService {
    /** Мозги ботов по battleId — источник правды о том, кто в бою бот. */
    private readonly squads = new Map<string, BotBrain[]>();
    private counter = 0;
    /** Ники живых игроков, которые на прошлом такте ещё грузили бой (battleId -> ники). */
    private readonly joiningLastTick = new Map<string, Set<string>>();
    /** До какого момента боты боя молчат после входа игрока (battleId -> timestamp). */
    private readonly streamHoldUntil = new Map<string, number>();
    /** Когда по этому бою в последний раз крутился такт: по нему считается его фактическая длина. */
    private readonly lastTickAt = new Map<string, number>();

    constructor(
        private readonly server: GameServer,
        private readonly spawn: SpawnService,
        private readonly collision: CollisionService,
        private readonly bonus: BonusService,
    ) { }

    /** Сколько ботов сейчас в бою. */
    public count(battle: Battle): number {
        return this.squads.get(battle.battleId)?.length ?? 0;
    }

    /** Заказанное настройками количество, обрезанное по вместимости боя. */
    public desiredCount(battle: Battle): number {
        return Math.max(0, Math.min(this._capacity(battle), battle.settings.botCount ?? 0));
    }

    /** Меняет настройку боя и сразу приводит состав в соответствие. Возвращает фактический заказ. */
    public setDesiredCount(battle: Battle, count: number): number {
        battle.settings.botCount = Math.max(0, Math.min(MAX_BOTS_PER_BATTLE, Math.floor(count)));
        this.onRosterChanged(battle);
        return this.desiredCount(battle);
    }

    /**
     * Приводит число ботов к заказанному. Боты НЕ уходят следом за игроком: бой с ботами продолжает
     * идти и без людей, чтобы к нему можно было подключиться в любой момент (и чтобы вход-выход игрока
     * не перетряхивал состав — постоянные пере-создания танков с теми же никами копят мусор у клиентов).
     */
    public onRosterChanged(battle: Battle): void {
        const target = this.desiredCount(battle);
        const squad = this.squads.get(battle.battleId) ?? [];

        while (squad.length > target) this._removeBot(battle, squad[squad.length - 1]);
        while (this.count(battle) < target) {
            if (!this._addBot(battle)) break;
        }
        if (this.count(battle) > 0) this._ensureTick(battle);
    }

    /** Снимает всех ботов боя (например, при эвакуации перед рестартом сервера). */
    public removeAll(battle: Battle): void {
        const squad = this.squads.get(battle.battleId);
        if (!squad) return;
        for (const brain of [...squad]) this._removeBot(battle, brain);
        battle.timers.clear(BOT_TICK_TIMER);
        this.squads.delete(battle.battleId);
        this.joiningLastTick.delete(battle.battleId);
        this.streamHoldUntil.delete(battle.battleId);
        this.lastTickAt.delete(battle.battleId);
    }

    // ---------------------------------------------------------------- состав

    /**
     * Сколько ботов ещё влезет. В командных режимах maxPeopleCount задаётся НА КОМАНДУ (CTF 1 = 1x1),
     * поэтому общий потолок вдвое больше; половинка от 60 — жёсткий лимит танков клиента.
     */
    private _capacity(battle: Battle): number {
        const totalCap = battle.isTeamMode() ? Math.min(battle.settings.maxPeopleCount, 30) * 2 : battle.settings.maxPeopleCount;
        return Math.max(0, Math.min(MAX_BOTS_PER_BATTLE, totalCap - this._humanCount(battle)));
    }

    private _botUserIds(battle: Battle): Set<string> {
        return new Set((this.squads.get(battle.battleId) ?? []).map((b) => b.user.id));
    }

    /** Живые игроки боя — все участники, кроме собственных ботов. */
    private _humans(battle: Battle): UserDocument[] {
        const bots = this._botUserIds(battle);
        return [...battle.users, ...battle.usersRed, ...battle.usersBlue].filter((u) => !bots.has(u.id));
    }

    private _humanCount(battle: Battle): number {
        return this._humans(battle).length;
    }

    private _addBot(battle: Battle): boolean {
        const squad = this.squads.get(battle.battleId) ?? [];
        const team = this._pickTeam(battle);
        const nickname = this._pickNickname();
        // Звание — ВНУТРИ окна боя, а не подпёрто к его краю: бой с ограничением по званию иначе
        // набивался бы одинаковыми новобранцами (а то и оставался бы пустым по смыслу).
        const rank = this._pickRank(battle, squad.length);
        const loadout = this._pickLoadout(rank, squad.length);
        const experience = this.server.rankService.getRankById(rank)?.minScore ?? 0;

        const user = createBotUser(nickname, rank, experience, loadout);
        let client: BotClient;
        try {
            client = BotClient.create(this.server, user);
        } catch (error: any) {
            logger.error(`Failed to create bot ${nickname}`, { error: error.message });
            return false;
        }

        if (battle.isTeamMode()) {
            (team === STATE_RED ? battle.usersRed : battle.usersBlue).push(user);
        } else {
            battle.users.push(user);
        }
        client.currentBattle = battle; // регистрирует бота в battle.clients (рассылки, сплэш, точки)

        // Индекс в отряде задаёт и снаряжение, и «класс» меткости — от откровенно кривого новобранца
        // до опасного стрелка, чтобы бой не превращался в тир в одну сторону.
        const accuracy = 0.75 + (squad.length % 4) * 0.25;
        const brain = new BotBrain(client, squad.length, accuracy);
        squad.push(brain);
        this.squads.set(battle.battleId, squad);

        // Подсадка бота идёт ВНУТРИ входа живого игрока в битву (addUserToBattle). Любая осечка здесь —
        // например, недостающий ресурс снаряжения — не имеет права сорвать игроку вход: откатываем бота
        // и живём дальше без него.
        try {
            this._announceSlot(battle, user, team);
            this._announceTank(battle, brain, team);
        } catch (error: any) {
            logger.error(`Failed to announce bot ${nickname}; rolling it back`, { error: error.message });
            this._removeBot(battle, brain);
            return false;
        }

        logger.info(`Bot ${nickname} joined battle ${battle.battleId} (team ${team}).`);
        return true;
    }

    private _removeBot(battle: Battle, brain: BotBrain): void {
        const squad = this.squads.get(battle.battleId);
        if (squad) {
            const i = squad.indexOf(brain);
            if (i !== -1) squad.splice(i, 1);
            if (squad.length === 0) this.squads.delete(battle.battleId);
        }

        const client = brain.client;
        const user = brain.user;

        // Тот же путь, что и у вышедшего игрока: уронить флаг, снять мины и точки, убрать танк у всех.
        this.server.battleService.announceTankRemoval(user, battle, client.battlePosition);

        battle.users = battle.users.filter((u) => u.id !== user.id);
        battle.usersRed = battle.usersRed.filter((u) => u.id !== user.id);
        battle.usersBlue = battle.usersBlue.filter((u) => u.id !== user.id);
        battle.timers.clear(`botJoin:${user.id}`);
        battle.timers.clear(`spawn:${user.id}`);

        if (battle.settings.battleMode === BattleMode.DM) {
            this.server.broadcastToBattleList(new LobbyPackets.ReleasePlayerSlotDmPacket({ battleId: battle.battleId, nickname: user.username }));
        } else {
            this.server.broadcastToBattleList(new LobbyPackets.OnReleaseSlotTeamPacket({ battleId: battle.battleId, nickname: user.username }));
        }

        client.closeConnection();
        logger.info(`Bot ${user.username} left battle ${battle.battleId}.`);
    }

    /** Команда с меньшим числом игроков — чтобы боты выравнивали составы, а не перекашивали их. */
    private _pickTeam(battle: Battle): number {
        if (!battle.isTeamMode()) return 2;
        return battle.usersRed.length <= battle.usersBlue.length ? STATE_RED : STATE_BLUE;
    }

    private _pickNickname(): string {
        for (let attempt = 0; attempt < 40; attempt++) {
            const head = NAME_HEADS[Math.floor(Math.random() * NAME_HEADS.length)];
            const tail = NAME_TAILS[Math.floor(Math.random() * NAME_TAILS.length)];
            // Число в хвосте — обычное дело для игроцких ников, и оно же разводит одинаковые пары.
            const nickname = `${head}${tail}${10 + Math.floor(Math.random() * 90)}`;
            if (!this.server.findClientByUsername(nickname)) return nickname;
        }
        return `Rookie${++this.counter}${Date.now().toString(36).slice(-3)}`;
    }

    /**
     * Звание бота.
     *
     * Если в бою есть живые игроки — звание случайное, но РЯДОМ с их средним: большинство ботов
     * попадает в звание-другое от игрока, изредка встречаются на пару выше или ниже. Это же звание
     * определяет снаряжение (см. `_pickLoadout`), поэтому противник получается сопоставимым, а не
     * новобранцем на стоке против генералиссимуса или наоборот.
     *
     * Если живых нет — это засеянный бой из стартового списка, и отряд раскладывается по всему окну
     * боя, как раньше: иначе весь список битв оказался бы одного звания.
     *
     * Уже подсаженные боты звание не меняют: перетряхивать состав из-за прихода игрока другого
     * звания дороже, чем оставить как есть (см. `onRosterChanged`).
     */
    private _pickRank(battle: Battle, index: number): number {
        const low = Math.max(1, Math.min(battle.settings.minRank, battle.settings.maxRank));
        const high = Math.max(low, Math.min(RANKS_TOTAL, battle.settings.maxRank));

        const humans = this._humans(battle);
        if (!humans.length) return low + (index % (high - low + 1));

        const average = humans.reduce((sum, user) => sum + user.rank, 0) / humans.length;
        // Сумма двух равномерных чисел даёт треугольное распределение: горб в середине, края редкие.
        // Ровно то, что нужно, — обычно вплотную к игроку, иногда заметно выше или ниже.
        const offset = (Math.random() + Math.random() - 1) * BOT_RANK_SPREAD;
        return Math.max(low, Math.min(high, Math.round(average + offset)));
    }

    /**
     * Снаряжение по званию: бот везёт то, что на его звании реально открыто, — на низких это m0 из
     * стартового набора, на высоких верхние модификации. Иначе новобранец разъезжал бы с прокачанной
     * рельсой, а генералиссимус — со стоковым смоки, и подбор по званию терял бы смысл.
     */
    private _pickLoadout(rank: number, index: number): IBotLoadout {
        const pick = (ids: string[], mods: (id: string) => { rank: number }[] | undefined, fallback: string) => {
            const open = ids.filter((id) => highestModAtRank(mods(id), rank) >= 0);
            const id = open.length > 0 ? open[index % open.length] : fallback;
            return { id, mod: Math.max(0, highestModAtRank(mods(id), rank)) };
        };
        const turret = pick(BOT_TURRETS, turretMods, "smoky");
        const hull = pick(BOT_HULLS, hullMods, "hunter");
        return {
            turret: turret.id,
            hull: hull.id,
            mod: 0,
            turretMod: turret.mod,
            hullMod: hull.mod,
            paint: this._pickPaint(rank),
        };
    }

    /**
     * Краска — по тому же правилу, что орудие и корпус: из того, что на звании бота открыто. Раньше она
     * бралась из списка на две позиции, и генералиссимус разъезжал зелёным новобранцем — а краска в этой
     * игре видна первой и сразу выдаёт, что перед тобой не игрок.
     *
     * Берём из ВЕРХНЕЙ ТРЕТИ открытого списка (он отсортирован по званию): игрок ездит на том, что купил
     * последним, а не на стартовой зелёной. Краски не по званию — см. BOT_PAINTS_DENIED.
     */
    private _pickPaint(rank: number): string {
        const open = itemBlueprints.paints
            .filter((p) => !BOT_PAINTS_DENIED.has(p.id) && p.rank <= rank)
            .sort((a, b) => a.rank - b.rank);
        if (open.length === 0) return "green";
        const from = Math.floor((open.length * 2) / 3);
        return open[from + Math.floor(Math.random() * (open.length - from))].id;
    }

    /** Место в списке битв и в панели «кто в бою» — бот должен быть виден так же, как игрок. */
    private _announceSlot(battle: Battle, user: UserDocument, team: number): void {
        // Звание бота НЕ рассылаем всем подряд (раньше здесь был broadcastPlayerRankToOthers): SetPlayerRank
        // по незнакомому нику валит клиент с #1009 — а ботов на сервере заводятся десятки, и каждый такой
        // пакет прилетал даже тем, кто сидит в другом бою. Звание бот отдаёт теми же путями, что и игрок:
        // в бою — полем rank в UserConnect, в списке битв — ответом на запрос профиля (ProfileService).
        const watchers = this.server.getClients().filter((c) => (c.getState() === "chat_lobby" || c.getState() === "battle_lobby") && c.lastViewedBattleId === battle.battleId);
        if (battle.settings.battleMode === BattleMode.DM) {
            this.server.broadcastToBattleList(new LobbyPackets.ReservePlayerSlotDmPacket({ battleId: battle.battleId, nickname: user.username }));
            const add = new LobbyPackets.AddUserToBattleDmPacket({ battleId: battle.battleId, nickname: user.username, kills: 0, score: 0, suspicious: false });
            for (const w of watchers) w.sendPacket(add);
        } else {
            this.server.broadcastToBattleList(new LobbyPackets.OnReserveSlotTeamPacket({ battleId: battle.battleId, nickname: user.username, team }));
            const add = new LobbyPackets.AddUserTeamPacket({ battleId: battle.battleId, nickname: user.username, kills: 0, score: 0, suspicious: false, team });
            for (const w of watchers) w.sendPacket(add);
        }
    }

    /**
     * Показывает танк бота живым клиентам. Порядок как при входе игрока: сперва строка в таблице
     * (UserConnect — иначе InitTank не найдёт ник и клиент упадёт на null), потом загрузка ресурсов
     * снаряжения, и только после подтверждения — сама модель танка.
     */
    private _announceTank(battle: Battle, brain: BotBrain, team: number): void {
        const user = brain.user;
        const humans = [...battle.clients].filter((c) => !c.isBot && !c.isDestroyed && c.user);
        const established = humans.filter((c) => !c.isJoiningBattle);

        let done = false;
        const reveal = () => {
            if (done) return;
            done = true;
            battle.timers.clear(`botJoin:${user.id}`);
            try {
                battle.broadcast(new TankModelDataPacket({ jsonData: BattleWorkflow.getTankModelDataJson(brain.client, battle) }));
            } catch (error: any) {
                // Без модели танк у клиентов не создан. Пустить бота в бой всё равно — значит слать
                // движение и выстрелы на несуществующий объект: клиент будет падать на каждом пакете.
                logger.error(`Failed to broadcast bot tank model for ${user.username}; removing the bot`, { error: error.message });
                this._removeBot(battle, brain);
                return;
            }
            brain.spawnAllowed = true;
        };

        if (established.length === 0) {
            // Некому показывать (в бою только загружающиеся клиенты — они возьмут бота из своего снимка).
            reveal();
            return;
        }

        for (const client of established) client.sendPacket(this._userConnectPacket(battle, user, team));

        const mod = user.turrets.get(user.equippedTurret) ?? 0;
        const hullMod = user.hulls.get(user.equippedHull) ?? 0;
        const resources: ResourceId[] = [
            `turret/${user.equippedTurret}/m${mod}/model` as ResourceId,
            `hull/${user.equippedHull}/m${hullMod}/model` as ResourceId,
            `paint/${user.equippedPaint}/texture` as ResourceId,
        ];

        const pending = new Set(established.map((c) => c.user!.username));
        const callbackId = this.server.registerDynamicCallback((acking: GameClient) => {
            pending.delete(acking.user?.username ?? "");
            if (pending.size > 0) return;
            this.server.removeDynamicCallback(callbackId);
            reveal();
        });

        const deps = new LoadDependencies({ resources: ResourceManager.getBulkResources(resources) }, callbackId);
        // Ресурсы шлём и тем, кто ещё грузится: их снимок входа уже включает бота, а догрузка лишней
        // не будет. В «ожидание» (pending) они не входят — подтверждения от них можно и не дождаться.
        for (const client of humans) client.sendPacket(deps);

        battle.timers.set(`botJoin:${user.id}`, JOIN_ACK_TIMEOUT_MS, () => {
            this.server.removeDynamicCallback(callbackId);
            reveal();
        });
    }

    private _userConnectPacket(battle: Battle, user: UserDocument, team: number): IPacket {
        const known = (p: UserDocument) => {
            const c = this.server.findClientByUsername(p.username);
            return c != null && (!c.isJoiningBattle || p.id === user.id);
        };
        const toInfo = (p: UserDocument) => ({ ChatModeratorLevel: p.chatModeratorLevel, deaths: 0, kills: 0, rank: p.rank, score: 0, nickname: p.username });

        if (battle.isTeamMode()) {
            // Клиент ПЕРЕСТРАИВАЕТ колонку команды по этому пакету — шлём всю команду бота целиком.
            const members = (team === STATE_BLUE ? battle.usersBlue : battle.usersRed).filter(known);
            return new UserConnectTeamPacket({ nickname: user.username, usersInfo: members.map(toInfo), team });
        }
        const all = [...battle.users, ...battle.usersBlue, ...battle.usersRed].filter(known);
        return new UserConnectDMPacket({ nickname: user.username, usersInfo: all.map(toInfo) });
    }

    // ---------------------------------------------------------------- такт ИИ

    private _ensureTick(battle: Battle): void {
        if (battle.timers.has(BOT_TICK_TIMER)) return;
        battle.timers.set(BOT_TICK_TIMER, this._tickInterval(battle), () => this._tick(battle));
    }

    /** Частота такта: полная, пока в бою есть живой игрок, и втрое реже в пустом бою. */
    private _tickInterval(battle: Battle): number {
        return this._liveAudience(battle) ? BOT_TICK_MS : BOT_TICK_IDLE_MS;
    }

    /** Есть ли в бою хоть один живой клиент — то есть кто-то, кто это всё видит. */
    private _liveAudience(battle: Battle): boolean {
        for (const client of battle.clients) if (!client.isBot && !client.isDestroyed) return true;
        return false;
    }

    private _tick(battle: Battle): void {
        this.advance(battle);
        // Пере-взводим, только пока боты в бою: снятый отряд гасит такт сам собой. Интервал считаем
        // заново каждый раз — игрок мог войти в бой или выйти из него.
        if (this.squads.get(battle.battleId)?.length) {
            battle.timers.set(BOT_TICK_TIMER, this._tickInterval(battle), () => this._tick(battle));
        }
    }

    /**
     * Один такт ИИ всех ботов боя. `now` можно задать снаружи: тесты так прогоняют целый матч на
     * синтетических часах, не дожидаясь реальных таймеров.
     */
    public advance(battle: Battle, now: number = Date.now()): void {
        let squad = this.squads.get(battle.battleId);
        if (!squad || squad.length === 0) return;

        // Длину такта берём ФАКТИЧЕСКУЮ, а не паспортную: она разная у пустого и у играемого боя
        // (см. BOT_TICK_IDLE_MS), а в тестах часы вообще синтетические.
        const previous = this.lastTickAt.get(battle.battleId);
        const dt = Math.min(1, Math.max(0.01, (now - (previous ?? now - BOT_TICK_MS)) / 1000));
        this.lastTickAt.set(battle.battleId, now);

        // Боевой код мог «выкинуть» бота (например, зона kick закрывает соединение). Такой клиент уже
        // мёртв, а в ростере битвы висел бы призраком — вычищаем его штатным путём.
        for (const brain of [...squad]) if (brain.client.isDestroyed) this._removeBot(battle, brain);
        squad = this.squads.get(battle.battleId);
        if (!squad || squad.length === 0) return;

        const ctx: IBotTickContext = {
            battle,
            server: this.server,
            collision: this.collision,
            bonus: this.bonus,
            prepareRespawn: (client) => this.spawn.prepareRespawn(client),
            now,
            dt,
            plans: this.buildPlans(battle),
            squad,
            mute: this._settling(battle, now),
            // Пустой бой в эфир не вещает: собирать пакеты движения, которые примут одни боты (а у них
            // отправка — заглушка), значит жечь процессор на сотне засеянных боёв впустую.
            silent: !this._liveAudience(battle),
        };

        for (const brain of [...squad]) {
            try {
                brain.update(ctx);
            } catch (error: any) {
                logger.error(`Bot ${brain.user.username} AI tick failed`, { error: error.message });
            }
        }
    }

    /**
     * Идёт ли сейчас «обживание» боя живым игроком. Момент перехода `isJoiningBattle` из true в false —
     * это ровно тот такт, когда клиент получил снимок боя и начал его строить; ещё несколько секунд он
     * не успевает за сетью, и вещать в него нельзя (см. BOT_STREAM_SETTLE_MS).
     */
    private _settling(battle: Battle, now: number): boolean {
        const before = this.joiningLastTick.get(battle.battleId) ?? new Set<string>();
        const nowJoining = new Set<string>();
        for (const client of battle.clients) {
            const name = client.user?.username;
            if (!name || client.isBot || client.isDestroyed) continue;
            // Пока клиент не подтвердил, что разобрал снимок боя, танков ботов у него ещё нет —
            // это и есть «обживание» (см. BattleWorkflow._awaitSnapshotAck).
            const busy = client.isJoiningBattle || client.battleSnapshotPending;
            if (busy) nowJoining.add(name);
            // Подтверждение получено — даём ещё немного форы: клиент разгребает накопившийся хвост.
            else if (before.has(name)) this.streamHoldUntil.set(battle.battleId, now + BOT_STREAM_SETTLE_MS);
        }
        this.joiningLastTick.set(battle.battleId, nowJoining);
        return nowJoining.size > 0 || (this.streamHoldUntil.get(battle.battleId) ?? 0) > now;
    }

    /**
     * Командный план на такт: боты одной стороны выбирают ОБЩУЮ цель (сосредоточенный огонь), общую
     * точку сбора (туда стягиваются свободные) и делят роли — часть уходит в защиту базы/точек, чтобы
     * атака не оставляла тыл голым.
     */
    public buildPlans(battle: Battle): Map<number, IBotTeamPlan> {
        const squad = this.squads.get(battle.battleId) ?? [];
        const plans = new Map<number, IBotTeamPlan>();
        const teams = new Set(squad.map((b) => battle.teamOf(b.user)));

        for (const team of teams) {
            const mates = squad.filter((b) => battle.teamOf(b.user) === team);
            const enemies = [...battle.clients].filter((c) => {
                if (c.isDestroyed || c.battleState !== "active" || !c.user || !c.battlePosition) return false;
                return !battle.isTeamMode() ? !mates.some((m) => m.client === c) : battle.teamOf(c.user) !== team;
            });

            const plan: IBotTeamPlan = { focus: null, rally: null, defenders: new Set(), pointAssign: new Map() };
            plan.focus = this._pickFocus(battle, team, mates, enemies);
            plan.rally = plan.focus?.battlePosition ? { ...plan.focus.battlePosition } : this._objectivePosition(battle, team);
            this._assignRoles(battle, team, mates, plan);
            plans.set(team, plan);
        }
        return plans;
    }

    /** Кого валим всей командой: носителя нашего флага, иначе — самого «дохлого» из тех, кого видим. */
    private _pickFocus(battle: Battle, team: number, mates: BotBrain[], enemies: GameClient[]): GameClient | null {
        if (battle.settings.battleMode === BattleMode.CTF) {
            const ownFlagCarrier = team === STATE_RED ? battle.flagCarrierRed : battle.flagCarrierBlue;
            if (ownFlagCarrier) {
                const carrier = enemies.find((c) => c.user?.id === ownFlagCarrier.id);
                if (carrier) return carrier;
            }
        }

        let best: GameClient | null = null;
        let bestHealth = Infinity;
        for (const enemy of enemies) {
            const seen = mates.some((m) => m.client.battlePosition && dist2(m.client.battlePosition, enemy.battlePosition!) <= TEAM_VIEW_RANGE);
            if (!seen) continue;
            if (enemy.currentHealth < bestHealth) { bestHealth = enemy.currentHealth; best = enemy; }
        }
        return best;
    }

    /** Куда стягиваться, когда врагов не видно: к текущему объективу режима. */
    private _objectivePosition(battle: Battle, team: number): IVector3 | null {
        if (battle.settings.battleMode === BattleMode.CTF) {
            const enemyFlag = team === STATE_RED ? battle.flagPositionBlue : battle.flagPositionRed;
            if (enemyFlag) return { ...enemyFlag };
        }
        if (battle.settings.battleMode === BattleMode.CP) {
            const contested = battle.domPoints.find((p) => p.state !== team);
            if (contested) return { ...contested.position };
        }
        return null;
    }

    /** Роли: примерно треть отряда остаётся в защите; в CP отряд равномерно раскидывается по точкам. */
    private _assignRoles(battle: Battle, team: number, mates: BotBrain[], plan: IBotTeamPlan): void {
        if (battle.settings.battleMode === BattleMode.CTF && mates.length >= 3) {
            const defenders = Math.max(1, Math.floor(mates.length / 3));
            for (const brain of mates.slice(-defenders)) plan.defenders.add(brain.user.username);
        }

        if (battle.settings.battleMode === BattleMode.CP && battle.domPoints.length > 0) {
            // Сначала незахваченные точки: команда сперва разбирает то, что реально даёт очки.
            const priority = [...battle.domPoints].sort((a, b) => Number(a.state === team) - Number(b.state === team));
            mates.forEach((brain, i) => plan.pointAssign.set(brain.user.username, priority[i % priority.length].id));
        }
    }
}
