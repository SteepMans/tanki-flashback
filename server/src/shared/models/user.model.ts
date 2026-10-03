import "reflect-metadata";
import { MAX_EXPERIENCE } from "@/config/rank.data";
import { QuestDifficulty, QuestType } from "@/features/quests/quests.data";
import { ID_COLUMN, jsonList, mapOfNumbers, mapOfObjects, newObjectId } from "@/shared/db/columns";
import bcrypt from "bcrypt";
import {
    AfterLoad,
    BaseEntity,
    BeforeInsert,
    BeforeUpdate,
    Column,
    Entity,
    Index,
    PrimaryColumn,
} from "typeorm";
import { ChatModeratorLevel } from "./enums/chat-moderator-level.enum";

export interface IUserQuest {
    questId: number;
    questType: QuestType;
    difficulty: QuestDifficulty;
    progress: number;
    finishCriteria: number;
    prizes: { itemName: string; itemCount: number }[];
    isCompleted: boolean;
    canSkipForFree: boolean;
}

/**
 * Long-term competitive metrics per user, accumulated once per round at battle end / on leave (see
 * StatsService). `counters` is a flexible bag keyed by `<metric>` / `<metric>:<mode>` /
 * `<metric>:<mode>:<type>` (mode = dm/tdm/ctf/cp/as, type = normal/xpbp/parkour), so new metrics need no
 * schema change. The scalar fields hold values that need special update logic (per-match records via max,
 * and win/loss streaks). Most of this isn't surfaced yet — we keep the data for future leaderboards.
 */
export interface IUserStats {
    counters: Map<string, number>;
    maxKillsInBattle: number;
    maxDeathsInBattle: number;
    maxCrystalsInBattle: number;
    maxXpInBattle: number;
    maxDamageInBattle: number;
    currentWinStreak: number;
    maxWinStreak: number;
    currentLossStreak: number;
    maxLossStreak: number;
}

export interface RankedModeStats {
    mmr: number;
    wins: number;
    losses: number;
    abandons: number;
    games: number;
    currentStreak: number;
}

/** Пустая длинная статистика — та же форма, что раньше задавала схема Mongo. */
export function emptyUserStats(): IUserStats {
    return {
        counters: new Map<string, number>(),
        maxKillsInBattle: 0,
        maxDeathsInBattle: 0,
        maxCrystalsInBattle: 0,
        maxXpInBattle: 0,
        maxDamageInBattle: 0,
        currentWinStreak: 0,
        maxWinStreak: 0,
        currentLossStreak: 0,
        maxLossStreak: 0,
    };
}

/** Начальные соревновательные показатели: рейтинг стартует с 1000 по Эло. */
export function emptyRankedStats(): RankedModeStats {
    return { mmr: 1000, wins: 0, losses: 0, abandons: 0, games: 0, currentStreak: 0 };
}

/**
 * `stats.counters` внутри JSON-колонки — тоже Map, поэтому колонке нужен свой преобразователь:
 * общий `mapOfNumbers` разворачивает Map верхнего уровня, а здесь Map лежит на уровень глубже.
 */
const statsTransformer = {
    to: (value?: IUserStats | null) => {
        const stats = value ?? emptyUserStats();
        return { ...stats, counters: Object.fromEntries(stats.counters ?? new Map()) };
    },
    from: (value?: (Omit<IUserStats, "counters"> & { counters?: Record<string, number> }) | null) => {
        if (!value) return emptyUserStats();
        return { ...emptyUserStats(), ...value, counters: new Map(Object.entries(value.counters ?? {})) };
    },
};

@Entity("users")
export class User extends BaseEntity {
    /** Идентификатор в формате ObjectId — тот же, что был в Mongo (см. shared/db/columns). */
    @PrimaryColumn(ID_COLUMN)
    id!: string;

    /** Совместимость с кодом, который читает `_id`: в Mongo это был тот же идентификатор. */
    get _id(): string {
        return this.id;
    }

    /** display name (original casing) */
    @Column({ type: "varchar", length: 50 })
    username!: string;

    /** lowercase of username — the unique, indexed key used for authentication */
    @Index({ unique: true })
    @Column({ type: "varchar", length: 50 })
    login!: string;

    @Column({ type: "varchar", length: 191 })
    password!: string;

    @Index({ unique: true })
    @Column({ type: "varchar", length: 191, nullable: true, default: null })
    email!: string | null;

    @Column({ type: "boolean", default: false })
    emailConfirmed!: boolean;

    @Column({ type: "varchar", length: 191, nullable: true, default: null })
    pendingEmail!: string | null;

    @Index()
    @Column({ type: "varchar", length: 191, nullable: true, default: null })
    emailConfirmationToken!: string | null;

    @Column({ type: "datetime", precision: 3, nullable: true, default: null })
    emailConfirmationTokenExpiresAt!: Date | null;

    @Index()
    @Column({ type: "varchar", length: 191, nullable: true, default: null })
    passwordResetToken!: string | null;

    @Column({ type: "datetime", precision: 3, nullable: true, default: null })
    passwordResetTokenExpiresAt!: Date | null;

    @Column({ type: "int", default: 500 })
    crystals!: number;

    @Column({ type: "int", default: 0 })
    experience!: number;

    /** the clan this user belongs to (null = no clan) */
    @Index()
    @Column({ ...ID_COLUMN, nullable: true, default: null })
    clanId!: string | null;

    /** after leaving a clan, can't JOIN another until this time (creating is allowed) */
    @Column({ type: "datetime", precision: 3, nullable: true, default: null })
    clanCooldownUntil!: Date | null;

    @Column({ type: "boolean", default: true })
    isActive!: boolean;

    @Column({ type: "boolean", default: false })
    isPunished!: boolean;

    @Column({ type: "datetime", precision: 3, nullable: true, default: null })
    punishmentExpiresAt!: Date | null;

    @Column({ type: "varchar", length: 500, nullable: true, default: null })
    punishmentReason!: string | null;

    /** Chat mute (staff /mute): while in the future, chat messages are rejected (commands still work). */
    @Column({ type: "datetime", precision: 3, nullable: true, default: null })
    mutedUntil!: Date | null;

    /** Optional reason for current chat mute (displayed to the user) */
    @Column({ type: "varchar", length: 500, nullable: true, default: null })
    mutedReason!: string | null;

    @Column({ type: "boolean", default: false })
    hasDoubleCrystal!: boolean;

    @Column({ type: "datetime", precision: 3, nullable: true, default: null })
    premiumExpiresAt!: Date | null;

    /** Passe Iniciante (newbie): +50% XP + 100% de crystals/batalha por ~21 dias. Concedido ao criar conta. */
    @Column({ type: "datetime", precision: 3, nullable: true, default: null })
    newbieExpiresAt!: Date | null;

    /** Janela de boas-vindas do Passe Iniciante já foi exibida (mostra só 1x, no 1º login após ganhar). */
    @Column({ type: "boolean", default: false })
    newbieBonusShown!: boolean;

    /** Ids das notícias (news.data) que este usuário já viu — cada notícia aparece só 1x por pessoa. */
    @Column({ type: "json", transformer: jsonList<string>() })
    seenNewsIds: string[] = [];

    /** Códigos promocionais já resgatados (cada código só pode ser usado 1x por conta). */
    @Column({ type: "json", transformer: jsonList<string>() })
    usedPromoCodes: string[] = [];

    /** Passe Multiplicador de Pontos (up_score): +30% XP. Comprável na garagem, dura 30 dias. */
    @Column({ type: "datetime", precision: 3, nullable: true, default: null })
    upScoreExpiresAt!: Date | null;

    /** Passe de Batalha PRO (pro_battle): criar batalhas próprias + Batalhas PRO. Comprável, dura 30 dias. */
    @Column({ type: "datetime", precision: 3, nullable: true, default: null })
    proBattleExpiresAt!: Date | null;

    @Column({ type: "int", default: 1 })
    rank!: number;

    @Column({ type: "int", default: 100 })
    nextRankScore!: number;

    /** Competitive matchmaking — LEGACY single-mode stats (kept only to seed rankedModes once). */
    @Column({ type: "json" })
    ranked: RankedModeStats = emptyRankedStats();

    /** Competitive stats PER MODE (key = mode id, e.g. "xpbp"). mmr starts at 1000 (Elo). */
    @Column({ type: "json", transformer: mapOfObjects<RankedModeStats>() })
    rankedModes: Map<string, RankedModeStats> = new Map();

    @Column({ type: "datetime", precision: 3, nullable: true, default: null })
    crystalAbonementExpiresAt!: Date | null;

    @Column({ type: "json", transformer: jsonList<string>() })
    friends: string[] = [];

    @Column({ type: "json", transformer: jsonList<string>() })
    friendRequestsSent: string[] = [];

    @Column({ type: "json", transformer: jsonList<string>() })
    friendRequestsReceived: string[] = [];

    @Column({ type: "json", transformer: jsonList<string>() })
    newFriends: string[] = [];

    @Column({ type: "json", transformer: jsonList<string>() })
    newFriendRequests: string[] = [];

    @Column({ type: "json", transformer: jsonList<number>() })
    unlockedAchievements: number[] = [];

    @Index({ unique: true })
    @Column({ type: "varchar", length: 64 })
    referralHash!: string;

    @Column({ ...ID_COLUMN, nullable: true, default: null })
    referredBy!: string | null;

    /** IP address used when the account was created (if available) */
    @Column({ type: "varchar", length: 64, nullable: true, default: null })
    registeredIp!: string | null;

    @Column({ type: "int", default: ChatModeratorLevel.NONE })
    chatModeratorLevel!: ChatModeratorLevel;

    @Column({ type: "datetime", precision: 3, nullable: true, default: null })
    lastMessageTimestamp!: Date | null;

    @Column({ type: "boolean", default: true })
    notificationsEnabled!: boolean;

    @Column({ type: "json", transformer: jsonList<IUserQuest>() })
    dailyQuests: IUserQuest[] = [];

    @Column({ type: "int", default: 1 })
    questLevel!: number;

    @Column({ type: "int", default: 0 })
    questStreak!: number;

    @Column({ type: "datetime", precision: 3, nullable: true, default: null })
    lastQuestCompletedDate!: Date | null;

    @Column({ type: "datetime", precision: 3, nullable: true, default: null })
    lastQuestGeneratedDate!: Date | null;

    /** when the day's ONE free mission change was used (null = still available today) */
    @Column({ type: "datetime", precision: 3, nullable: true, default: null })
    freeQuestSkipUsedDate!: Date | null;

    /** a mission reached its target and the player hasn't opened the window since (auto-opens it on login) */
    @Column({ type: "boolean", default: false })
    questCompletionUnviewed!: boolean;

    @Index({ unique: true })
    @Column({ type: "varchar", length: 191, nullable: true, default: null })
    loginToken!: string | null;

    @Column({ type: "json", transformer: mapOfNumbers })
    hulls: Map<string, number> = new Map([["hunter", 0]]);

    @Column({ type: "json", transformer: mapOfNumbers })
    turrets: Map<string, number> = new Map([["smoky", 0]]);

    @Column({ type: "json", transformer: jsonList<string>() })
    paints: string[] = ["green", "holiday"];

    @Column({ type: "json", transformer: mapOfNumbers })
    supplies: Map<string, number> = new Map([
        ["health", 0],
        ["armor", 0],
        ["double_damage", 0],
        ["n2o", 0],
        ["mine", 0],
    ]);

    /**
     * Купленные наборы. В схеме Mongo этого поля не было вовсе, поэтому покупка набора никогда не
     * сохранялась: гараж писал `user.kits`, а mongoose молча выбрасывал незнакомое поле при записи
     * (отсюда и проверки `Array.isArray` в garage.service). Теперь это обычная колонка и набор
     * остаётся у игрока после перезахода.
     */
    @Column({ type: "json", transformer: jsonList<string>() })
    kits: string[] = [];

    @Column({ type: "varchar", length: 64, default: "smoky" })
    equippedTurret!: string;

    @Column({ type: "varchar", length: 64, default: "hunter" })
    equippedHull!: string;

    @Column({ type: "varchar", length: 64, default: "green" })
    equippedPaint!: string;

    /** long-term competitive metrics (see IUserStats) */
    @Column({ type: "json", transformer: statsTransformer })
    stats: IUserStats = emptyUserStats();

    @Column({ type: "datetime", precision: 3, default: () => "CURRENT_TIMESTAMP(3)" })
    createdAt!: Date;

    @Column({ type: "datetime", precision: 3, nullable: true, default: null })
    lastLogin!: Date | null;

    /**
     * Хэш, с которым запись пришла из базы. Нужен, чтобы отличить «пароль поменяли» от «запись
     * просто перезаписали»: в Mongo это делал `isModified("password")`, у TypeORM такого нет.
     */
    private loadedPassword?: string;

    @AfterLoad()
    private rememberPassword(): void {
        this.loadedPassword = this.password;
    }

    @BeforeInsert()
    private assignId(): void {
        if (!this.id) this.id = newObjectId();
        if (!this.createdAt) this.createdAt = new Date();
    }

    /**
     * Держит `login` (уникальный ключ входа) в согласии с `username` и не даёт опыту перевалить за
     * потолок последнего звания — иначе на прокачанном аккаунте очко опыта переполнило бы поле счёта
     * у клиента. Раньше это делал хук `pre("validate")` в схеме Mongo.
     */
    @BeforeInsert()
    @BeforeUpdate()
    private normalize(): void {
        if (this.username) this.login = this.username.toLowerCase();
        if (this.experience > MAX_EXPERIENCE) this.experience = MAX_EXPERIENCE;
        if (this.experience < 0) this.experience = 0;
        if (this.crystals < 0) this.crystals = 0;
    }

    /** Пароль хэшируется только когда его действительно меняли, иначе перехэшировался бы хэш. */
    @BeforeInsert()
    @BeforeUpdate()
    private async hashPasswordIfChanged(): Promise<void> {
        if (!this.password || this.password === this.loadedPassword) return;
        this.password = await bcrypt.hash(this.password, 10);
        this.loadedPassword = this.password;
    }

    /**
     * Дописывает колонки-словари: их правки TypeORM не замечает при сравнении (подробности в
     * `shared/db/columns.ts`), поэтому после обычной записи они уходят отдельным UPDATE, который
     * пишет ровно то, что ему дали. Без этого не сохранялись бы покупки в гараже, расход припасов,
     * длинная статистика и соревновательный рейтинг.
     */
    override async save(): Promise<this> {
        const saved = await super.save();
        if (this.id) {
            await User.update(this.id, {
                hulls: this.hulls,
                turrets: this.turrets,
                supplies: this.supplies,
                rankedModes: this.rankedModes,
                stats: this.stats,
            });
        }
        return saved;
    }

    public verifyPassword(password: string, callback: (error: Error | undefined, isMatch?: boolean) => void): void {
        bcrypt.compare(password, this.password, (error: Error | undefined, isMatch: boolean) => {
            if (error) return callback(error);
            callback(undefined, isMatch);
        });
    }
}

/** Раньше это был документ mongoose; теперь — сущность, тип оставлен ради существующих аннотаций. */
export type UserDocument = User;

export type UserDocumentWithFriends = Omit<UserDocument, "friends"> & {
    friends: UserDocument[];
};

export default User;
