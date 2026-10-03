import { IPacket } from "@/packets/packet.interfaces";
import { GameClient } from "@/server/game.client";
import { GameServer } from "@/server/game.server";
import { ChatModeratorLevel } from "@/shared/models/enums/chat-moderator-level.enum";
import User, { UserDocument } from "@/shared/models/user.model";
import { newObjectId } from "@/shared/db/columns";
import * as net from "net";

/**
 * Заглушка сокета. GameClient построен вокруг живого net.Socket (setNoDelay/on/write), и переписывать
 * его ради ботов не хочется: тогда пришлось бы дублировать ветками «а если бот» весь боевой код
 * (рассылки, урон, флаги, точки). Вместо этого боту подсовывается пустышка, а исходящая почта гасится
 * в BotClient — и для всего остального сервера бот остаётся ОБЫЧНЫМ участником битвы.
 */
class BotSocket {
    public destroyed = false;
    public readonly remoteAddress = "bot";
    public setNoDelay(): this { return this; }
    public setKeepAlive(): this { return this; }
    public on(): this { return this; }
    public write(): boolean { return true; }
    public end(): this { return this; }
    public destroy(): this { this.destroyed = true; return this; }
}

/** Снаряжение бота: те же id, что и у настоящих игроков, — иначе клиент не найдёт ресурсы модели. */
export interface IBotLoadout {
    hull: string;
    turret: string;
    /** Модификация (m0..m3) сразу для корпуса и башни, если для них не заданы свои. */
    mod: number;
    /** Модификация корпуса, когда она отличается от общей (звания открытия у предметов разные). */
    hullMod?: number;
    /** Модификация орудия, когда она отличается от общей. */
    turretMod?: number;
    paint: string;
}

/**
 * Игрок без соединения: сервер сам двигает его, крутит башню и стреляет теми же пакетами, какими это
 * делает настоящий клиент. Живёт в `battle.clients` и в реестре сервера, поэтому его находят
 * findClientByUsername, сплэш-урон, домашние точки и всё прочее без единой правки.
 */
export class BotClient extends GameClient {
    private readonly stubSocket: BotSocket;

    private constructor(server: GameServer, socket: BotSocket, user: UserDocument) {
        super({ socket: socket as unknown as net.Socket, server });
        this.stubSocket = socket;
        this.isBot = true;
        this.user = user;
        // Состояние "battle" держит бота вне рассылок лобби (список битв, чат лобби) — туда он не ходит.
        this.setState("battle");
        server.indexAuthenticatedClient(this);
    }

    public static create(server: GameServer, user: UserDocument): BotClient {
        return new BotClient(server, new BotSocket(), user);
    }

    /** Отправлять некуда: у бота нет соединения. */
    public sendPacket(_packet: IPacket, _encrypt: boolean = true): void { /* нет сокета */ }
    public sendRaw(_raw: Buffer, _packetId: number): void { /* нет сокета */ }
    public getRemoteAddress(): string { return "bot"; }

    /**
     * Уход бота — это не обрыв связи: базовый closeConnection запустил бы 60-секундное окно реконнекта и
     * сброс статистики на несуществующий аккаунт. Здесь только снимаем бота с учёта; из ростера битвы его
     * убирает BattleBotService (он же роняет флаг, мины и точки через announceTankRemoval).
     */
    public closeConnection(): void {
        this.stubSocket.destroy();
        this.currentBattle = null;
        this.getServer().removeClient(this);
    }
}

/**
 * Создаёт «аккаунт» бота в памяти. Документ НЕ сохраняется: save() подменён заглушкой, потому что ветки
 * начисления опыта (awardScore, applyRankUp, засчитанный фраг) зовут user.save() безусловно — без
 * подмены mongoose вставил бы фейкового игрока в базу.
 */
export function createBotUser(nickname: string, rank: number, experience: number, loadout: IBotLoadout): UserDocument {
    // Собираем объект напрямую, а не через User.create(): тот идёт в репозиторий, а бот живёт
    // только в памяти — и в тестах, где базы нет вовсе.
    const user = Object.assign(new User(), {
        username: nickname,
        login: nickname.toLowerCase(),
        password: "bot",
        rank,
        experience,
        crystals: 0,
        equippedHull: loadout.hull,
        equippedTurret: loadout.turret,
        equippedPaint: loadout.paint,
        hulls: new Map<string, number>([[loadout.hull, loadout.hullMod ?? loadout.mod]]),
        turrets: new Map<string, number>([[loadout.turret, loadout.turretMod ?? loadout.mod]]),
        paints: [loadout.paint],
        supplies: new Map<string, number>(),
        chatModeratorLevel: ChatModeratorLevel.NONE,
        dailyQuests: [],
    }) as UserDocument;

    // Идентификатор раздаём сами: в базу бот не попадает, а по нему различаются клиенты в бою
    // (рассылка пакетов исключает отправителя именно по id, и без него все боты слились бы в один).
    user.id = newObjectId();
    (user as unknown as { save: () => Promise<UserDocument> }).save = async () => user;
    return user;
}
