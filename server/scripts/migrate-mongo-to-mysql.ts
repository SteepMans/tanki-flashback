/**
 * Разовый перенос базы из MongoDB в MySQL.
 *
 *   npx ts-node -r tsconfig-paths/register scripts/migrate-mongo-to-mysql.ts            перенести
 *   npx ts-node -r tsconfig-paths/register scripts/migrate-mongo-to-mysql.ts --replace  очистить и перенести
 *
 * Источник — `MONGODB_URI`, приёмник — те же переменные `MYSQL_*`, с которыми работает сервер.
 * Идентификаторы сохраняются как есть (hex ObjectId), поэтому все ссылки между записями —
 * друзья, кланы, приглашения, авторы сообщений — переезжают без переписывания.
 *
 * Скрипт ничего не удаляет в Mongo: старую базу можно держать сколько угодно как запасную.
 */
import "reflect-metadata";
import "dotenv/config";
import { AppDataSource, connectToDatabase, disconnectFromDatabase } from "@/database";
import Config from "@/core/config/config.model";
import ChatMessage from "@/features/chat/chat.model";
import Clan from "@/features/clan/clan.model";
import Invite from "@/features/invite/invite.model";
import User, { emptyRankedStats, emptyUserStats } from "@/shared/models/user.model";
import mongoose from "mongoose";

const REPLACE = process.argv.includes("--replace");
const BATCH = 200;

/** ObjectId, строка или null -> строка из 24 hex-цифр (или null). */
function id(value: unknown): string | null {
    if (!value) return null;
    const text = String(value);
    return /^[0-9a-f]{24}$/i.test(text) ? text.toLowerCase() : text;
}

function ids(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return value.map((item) => id(item)).filter((item): item is string => !!item);
}

function date(value: unknown): Date | null {
    if (!value) return null;
    const parsed = value instanceof Date ? value : new Date(String(value));
    return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function numberMap(value: unknown): Map<string, number> {
    if (!value || typeof value !== "object") return new Map();
    return new Map(Object.entries(value as Record<string, unknown>).map(([key, n]) => [key, Number(n) || 0]));
}

function dateMap(value: unknown): Map<string, Date> {
    if (!value || typeof value !== "object") return new Map();
    const entries: [string, Date][] = [];
    for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
        const parsed = date(raw);
        if (parsed) entries.push([key, parsed]);
    }
    return new Map(entries);
}

/**
 * Пароли в Mongo уже захэшированы. У сущности стоит хук, который хэширует пароль, если он
 * отличается от прочитанного из базы, — подсовываем ему то же значение, иначе при переносе
 * каждый хэш захэшировался бы второй раз и никто не смог бы войти.
 */
function keepHashedPassword(user: User): void {
    (user as unknown as { loadedPassword?: string }).loadedPassword = user.password;
}

async function migrate(): Promise<void> {
    const uri = process.env.MONGODB_URI;
    if (!uri) throw new Error("MONGODB_URI не задан — неоткуда читать старую базу.");

    await mongoose.connect(uri);
    await connectToDatabase();
    const mongo = mongoose.connection.db;
    if (!mongo) throw new Error("Mongo не отдала базу данных.");

    const tables = [User, Clan, ChatMessage, Config, Invite];
    if (REPLACE) {
        // Порядок важен: у сообщений чата есть ссылки на пользователей.
        for (const table of [ChatMessage, Invite, Config, Clan, User]) {
            await AppDataSource.getRepository(table as never).createQueryBuilder().delete().execute();
        }
        console.log("целевые таблицы очищены");
    } else {
        for (const table of tables) {
            const count = await AppDataSource.getRepository(table as never).count();
            if (count > 0) {
                throw new Error(
                    `таблица ${AppDataSource.getRepository(table as never).metadata.tableName} не пуста (${count}). ` +
                        "Запусти с --replace, если её содержимое можно затереть."
                );
            }
        }
    }

    // --- пользователи ---------------------------------------------------------
    const userDocs = await mongo.collection("users").find({}).toArray();
    let batch: User[] = [];
    let usersDone = 0;
    for (const doc of userDocs) {
        const user = User.create({
            id: id(doc._id)!,
            username: doc.username,
            login: (doc.login ?? doc.username ?? "").toLowerCase(),
            password: doc.password,
            email: doc.email ?? null,
            emailConfirmed: !!doc.emailConfirmed,
            pendingEmail: doc.pendingEmail ?? null,
            emailConfirmationToken: doc.emailConfirmationToken ?? null,
            emailConfirmationTokenExpiresAt: date(doc.emailConfirmationTokenExpiresAt),
            passwordResetToken: doc.passwordResetToken ?? null,
            passwordResetTokenExpiresAt: date(doc.passwordResetTokenExpiresAt),
            crystals: Number(doc.crystals) || 0,
            experience: Number(doc.experience) || 0,
            clanId: id(doc.clanId),
            clanCooldownUntil: date(doc.clanCooldownUntil),
            isActive: doc.isActive !== false,
            isPunished: !!doc.isPunished,
            punishmentExpiresAt: date(doc.punishmentExpiresAt),
            punishmentReason: doc.punishmentReason ?? null,
            mutedUntil: date(doc.mutedUntil),
            mutedReason: doc.mutedReason ?? null,
            hasDoubleCrystal: !!doc.hasDoubleCrystal,
            premiumExpiresAt: date(doc.premiumExpiresAt),
            newbieExpiresAt: date(doc.newbieExpiresAt),
            newbieBonusShown: !!doc.newbieBonusShown,
            seenNewsIds: Array.isArray(doc.seenNewsIds) ? doc.seenNewsIds : [],
            usedPromoCodes: Array.isArray(doc.usedPromoCodes) ? doc.usedPromoCodes : [],
            upScoreExpiresAt: date(doc.upScoreExpiresAt),
            proBattleExpiresAt: date(doc.proBattleExpiresAt),
            rank: Number(doc.rank) || 1,
            nextRankScore: Number(doc.nextRankScore) || 100,
            ranked: { ...emptyRankedStats(), ...(doc.ranked ?? {}) },
            rankedModes: new Map(
                Object.entries((doc.rankedModes ?? {}) as Record<string, object>).map(([key, stats]) => [
                    key,
                    { ...emptyRankedStats(), ...stats },
                ])
            ),
            crystalAbonementExpiresAt: date(doc.crystalAbonementExpiresAt),
            friends: ids(doc.friends),
            friendRequestsSent: ids(doc.friendRequestsSent),
            friendRequestsReceived: ids(doc.friendRequestsReceived),
            newFriends: ids(doc.newFriends),
            newFriendRequests: ids(doc.newFriendRequests),
            unlockedAchievements: Array.isArray(doc.unlockedAchievements) ? doc.unlockedAchievements : [],
            referralHash: doc.referralHash,
            referredBy: id(doc.referredBy),
            registeredIp: doc.registeredIp ?? null,
            chatModeratorLevel: Number(doc.chatModeratorLevel) || 0,
            lastMessageTimestamp: date(doc.lastMessageTimestamp),
            notificationsEnabled: doc.notificationsEnabled !== false,
            dailyQuests: Array.isArray(doc.dailyQuests) ? doc.dailyQuests : [],
            questLevel: Number(doc.questLevel) || 1,
            questStreak: Number(doc.questStreak) || 0,
            lastQuestCompletedDate: date(doc.lastQuestCompletedDate),
            lastQuestGeneratedDate: date(doc.lastQuestGeneratedDate),
            freeQuestSkipUsedDate: date(doc.freeQuestSkipUsedDate),
            questCompletionUnviewed: !!doc.questCompletionUnviewed,
            loginToken: doc.loginToken ?? null,
            hulls: numberMap(doc.hulls),
            turrets: numberMap(doc.turrets),
            paints: Array.isArray(doc.paints) ? doc.paints : [],
            supplies: numberMap(doc.supplies),
            kits: Array.isArray(doc.kits) ? doc.kits : [],
            equippedTurret: doc.equippedTurret ?? "smoky",
            equippedHull: doc.equippedHull ?? "hunter",
            equippedPaint: doc.equippedPaint ?? "green",
            stats: {
                ...emptyUserStats(),
                ...(doc.stats ?? {}),
                counters: numberMap(doc.stats?.counters),
            },
            createdAt: date(doc.createdAt) ?? new Date(),
            lastLogin: date(doc.lastLogin),
        });
        keepHashedPassword(user);
        batch.push(user);
        if (batch.length >= BATCH) {
            await User.save(batch);
            usersDone += batch.length;
            batch = [];
        }
    }
    if (batch.length) {
        await User.save(batch);
        usersDone += batch.length;
    }
    console.log(`пользователи: ${usersDone} из ${userDocs.length}`);

    // --- кланы ----------------------------------------------------------------
    const clanDocs = await mongo.collection("clans").find({}).toArray();
    for (const doc of clanDocs) {
        await Clan.create({
            id: id(doc._id)!,
            name: doc.name,
            tag: doc.tag,
            description: doc.description ?? "",
            leaderId: id(doc.leaderId)!,
            members: ids(doc.members),
            positions: numberMap(doc.positions),
            memberSince: dateMap(doc.memberSince),
            joinRequests: ids(doc.joinRequests),
            invites: ids(doc.invites),
            rating: Number(doc.rating) || 0,
            recruiting: doc.recruiting !== false,
            minRank: Number(doc.minRank ?? -1),
            blocked: !!doc.blocked,
            blockReason: doc.blockReason ?? "",
            logo: doc.logo ?? "",
            missions: Array.isArray(doc.missions) ? doc.missions : [],
            missionResetAt: date(doc.missionResetAt),
            clanScore: numberMap(doc.clanScore),
            weeklyClanScore: numberMap(doc.weeklyClanScore),
            weeklyResetAt: date(doc.weeklyResetAt),
            createdAt: date(doc.createdAt) ?? new Date(),
        }).save();
    }
    console.log(`кланы: ${clanDocs.length}`);

    // --- сообщения чата -------------------------------------------------------
    const knownUserIds = new Set((await User.find({ select: { id: true } })).map((u) => u.id));
    const messageDocs = await mongo.collection("chatmessages").find({}).toArray();
    let messages: ChatMessage[] = [];
    let messagesDone = 0;
    for (const doc of messageDocs) {
        const source = id(doc.sourceUser);
        const target = id(doc.targetUser);
        messages.push(
            ChatMessage.create({
                id: id(doc._id)!,
                // Ссылка на удалённого пользователя обнуляется: внешний ключ такой строки не пропустит.
                sourceUserId: source && knownUserIds.has(source) ? source : null,
                targetUserId: target && knownUserIds.has(target) ? target : null,
                message: doc.message ?? "",
                isSystemMessage: !!doc.isSystemMessage,
                isWarning: !!doc.isWarning,
                timestamp: date(doc.timestamp) ?? new Date(),
            })
        );
        if (messages.length >= BATCH) {
            await ChatMessage.save(messages);
            messagesDone += messages.length;
            messages = [];
        }
    }
    if (messages.length) {
        await ChatMessage.save(messages);
        messagesDone += messages.length;
    }
    console.log(`сообщения чата: ${messagesDone} из ${messageDocs.length}`);

    // --- настройки и приглашения ---------------------------------------------
    const configDocs = await mongo.collection("configs").find({}).toArray();
    for (const doc of configDocs) {
        await Config.create({ id: id(doc._id)!, key: doc.key, value: String(doc.value ?? "") }).save();
    }
    console.log(`настройки: ${configDocs.length}`);

    const inviteDocs = await mongo.collection("invites").find({}).toArray();
    for (const doc of inviteDocs) {
        await Invite.create({
            id: id(doc._id)!,
            code: doc.code,
            player: doc.player ?? null,
            userId: id(doc.userId),
        }).save();
    }
    console.log(`приглашения: ${inviteDocs.length}`);

    // --- сверка ---------------------------------------------------------------
    const counts = {
        users: await User.count(),
        clans: await Clan.count(),
        chat: await ChatMessage.count(),
        configs: await Config.count(),
        invites: await Invite.count(),
    };
    console.log("в MySQL сейчас:", counts);
    if (counts.users !== userDocs.length) {
        throw new Error(`перенеслось пользователей ${counts.users}, а в Mongo их ${userDocs.length}`);
    }

    await mongoose.disconnect();
    await disconnectFromDatabase();
}

migrate()
    .then(() => console.log("перенос завершён"))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });
