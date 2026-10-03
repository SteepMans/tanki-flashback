/**
 * Сверка переезда Mongo -> MySQL: поле в поле по всем записям, плюс прогон тех запросов, которые
 * были переписаны на TypeORM и не покрыты ни тестами, ни входом в бой.
 *
 *   npx ts-node -r tsconfig-paths/register scripts/verify-migration.ts
 */
import "reflect-metadata";
import "dotenv/config";
import { AppDataSource, connectToDatabase, disconnectFromDatabase } from "@/database";
import Config from "@/core/config/config.model";
import ChatMessage from "@/features/chat/chat.model";
import Clan from "@/features/clan/clan.model";
import Invite from "@/features/invite/invite.model";
import User from "@/shared/models/user.model";
import mongoose from "mongoose";

let problems = 0;
/**
 * Поля, которые сервер законно переписывает уже после переноса: если в базу успели зайти, они
 * обязаны отличаться от снимка Mongo. Считать их расхождением — значит утопить настоящие в шуме.
 */
const LIVE_FIELDS = ["loginToken", "lastLogin", "lastMessageTimestamp"];
const live: string[] = [];

function fail(what: string, mongo: unknown, mysql: unknown): void {
    if (LIVE_FIELDS.some((field) => what.endsWith(`.${field}`))) {
        live.push(what);
        return;
    }
    problems++;
    console.log(`РАСХОЖДЕНИЕ ${what}\n   mongo: ${JSON.stringify(mongo)}\n   mysql: ${JSON.stringify(mysql)}`);
}

/** Приводит значение к виду, в котором его можно сравнивать между двумя базами. */
function normal(value: unknown): unknown {
    if (value === undefined || value === null) return null;
    if (value instanceof Date) return value.getTime();
    if (value instanceof Map) return normal(Object.fromEntries(value));
    if (Array.isArray(value)) return value.map(normal);
    if (typeof value === "object") {
        const raw = value as Record<string, unknown>;
        // ObjectId печатается как строка из 24 hex-цифр.
        if (raw._bsontype === "ObjectID" || raw._bsontype === "ObjectId") return String(value);
        const out: Record<string, unknown> = {};
        for (const key of Object.keys(raw).sort()) {
            if (key === "_id" || key === "__v") continue;
            out[key] = normal(raw[key]);
        }
        return out;
    }
    return value;
}

function same(what: string, mongo: unknown, mysql: unknown): void {
    const a = JSON.stringify(normal(mongo));
    const b = JSON.stringify(normal(mysql));
    if (a !== b) fail(what, normal(mongo), normal(mysql));
}

async function main(): Promise<void> {
    await mongoose.connect(process.env.MONGODB_URI!);
    await connectToDatabase();
    const mongo = mongoose.connection.db!;

    // ---------- пользователи ----------
    const userDocs = await mongo.collection("users").find({}).toArray();
    for (const doc of userDocs) {
        const id = String(doc._id);
        const user = await User.findOneBy({ id });
        if (!user) {
            fail(`пользователь ${id} не найден в MySQL`, doc.username, null);
            continue;
        }
        const scalars = [
            "username", "login", "password", "email", "emailConfirmed", "pendingEmail",
            "emailConfirmationToken", "passwordResetToken", "crystals", "experience",
            "isActive", "isPunished", "punishmentReason", "mutedReason", "hasDoubleCrystal",
            "newbieBonusShown", "rank", "nextRankScore", "referralHash", "registeredIp",
            "chatModeratorLevel", "notificationsEnabled", "questLevel", "questStreak",
            "questCompletionUnviewed", "loginToken", "equippedTurret", "equippedHull", "equippedPaint",
        ];
        for (const field of scalars) {
            same(`users.${doc.username}.${field}`, doc[field] ?? null, (user as never)[field] ?? null);
        }
        const dates = [
            "emailConfirmationTokenExpiresAt", "passwordResetTokenExpiresAt", "clanCooldownUntil",
            "punishmentExpiresAt", "mutedUntil", "premiumExpiresAt", "newbieExpiresAt",
            "upScoreExpiresAt", "proBattleExpiresAt", "crystalAbonementExpiresAt",
            "lastMessageTimestamp", "lastQuestCompletedDate", "lastQuestGeneratedDate",
            "freeQuestSkipUsedDate", "createdAt", "lastLogin",
        ];
        for (const field of dates) {
            same(`users.${doc.username}.${field}`, doc[field] ?? null, (user as never)[field] ?? null);
        }
        same(`users.${doc.username}.clanId`, doc.clanId ?? null, user.clanId);
        same(`users.${doc.username}.referredBy`, doc.referredBy ?? null, user.referredBy);
        for (const field of ["friends", "friendRequestsSent", "friendRequestsReceived", "newFriends", "newFriendRequests", "seenNewsIds", "usedPromoCodes", "unlockedAchievements", "paints", "dailyQuests"]) {
            same(`users.${doc.username}.${field}`, doc[field] ?? [], (user as never)[field] ?? []);
        }
        for (const field of ["hulls", "turrets", "supplies", "rankedModes"]) {
            same(`users.${doc.username}.${field}`, doc[field] ?? {}, (user as never)[field]);
        }
        same(`users.${doc.username}.stats.counters`, doc.stats?.counters ?? {}, user.stats.counters);
        for (const field of ["maxKillsInBattle", "maxDeathsInBattle", "maxCrystalsInBattle", "maxXpInBattle", "maxDamageInBattle", "currentWinStreak", "maxWinStreak", "currentLossStreak", "maxLossStreak"]) {
            same(`users.${doc.username}.stats.${field}`, doc.stats?.[field] ?? 0, (user.stats as never)[field] ?? 0);
        }
    }
    console.log(`пользователи сверены: ${userDocs.length}`);

    // ---------- кланы ----------
    const clanDocs = await mongo.collection("clans").find({}).toArray();
    for (const doc of clanDocs) {
        const clan = await Clan.findOneBy({ id: String(doc._id) });
        if (!clan) {
            fail(`клан ${doc.tag} не найден в MySQL`, doc.name, null);
            continue;
        }
        for (const field of ["name", "tag", "description", "rating", "recruiting", "minRank", "blocked", "blockReason", "logo"]) {
            same(`clans.${doc.tag}.${field}`, doc[field] ?? null, (clan as never)[field] ?? null);
        }
        same(`clans.${doc.tag}.leaderId`, doc.leaderId, clan.leaderId);
        for (const field of ["members", "joinRequests", "invites", "missions"]) {
            same(`clans.${doc.tag}.${field}`, doc[field] ?? [], (clan as never)[field] ?? []);
        }
        for (const field of ["positions", "memberSince", "clanScore", "weeklyClanScore"]) {
            same(`clans.${doc.tag}.${field}`, doc[field] ?? {}, (clan as never)[field]);
        }
        for (const field of ["missionResetAt", "weeklyResetAt", "createdAt"]) {
            same(`clans.${doc.tag}.${field}`, doc[field] ?? null, (clan as never)[field] ?? null);
        }
    }
    console.log(`кланы сверены: ${clanDocs.length}`);

    // ---------- чат, настройки, приглашения ----------
    const messageDocs = await mongo.collection("chatmessages").find({}).toArray();
    for (const doc of messageDocs) {
        const message = await ChatMessage.findOne({ where: { id: String(doc._id) }, relations: { sourceUser: true } });
        if (!message) {
            fail(`сообщение ${String(doc._id)} не найдено в MySQL`, doc.message, null);
            continue;
        }
        same(`chat.${String(doc._id)}.message`, doc.message, message.message);
        same(`chat.${String(doc._id)}.timestamp`, doc.timestamp, message.timestamp);
        same(`chat.${String(doc._id)}.sourceUser`, doc.sourceUser ?? null, message.sourceUserId);
        same(`chat.${String(doc._id)}.targetUser`, doc.targetUser ?? null, message.targetUserId);
        // Связь должна разворачиваться в того же пользователя, на которого указывает колонка.
        if (message.sourceUserId && message.sourceUser?.id !== message.sourceUserId) {
            fail(`chat.${String(doc._id)}.sourceUser связь`, message.sourceUserId, message.sourceUser?.id ?? null);
        }
    }
    console.log(`сообщения чата сверены: ${messageDocs.length}`);

    const configDocs = await mongo.collection("configs").find({}).toArray();
    for (const doc of configDocs) {
        const config = await Config.findOneBy({ key: doc.key });
        same(`configs.${doc.key}`, doc.value, config?.value ?? null);
    }
    console.log(`настройки сверены: ${configDocs.length}`);

    const inviteDocs = await mongo.collection("invites").find({}).toArray();
    for (const doc of inviteDocs) {
        const invite = await Invite.findOneBy({ code: doc.code });
        same(`invites.${doc.code}.player`, doc.player ?? null, invite?.player ?? null);
        same(`invites.${doc.code}.userId`, doc.userId ?? null, invite?.userId ?? null);
    }
    console.log(`приглашения сверены: ${inviteDocs.length}`);

    // ---------- переписанные запросы: просто должны отработать и вернуть ожидаемое ----------
    console.log("\nпрогон переписанных запросов:");
    const someUser = await User.findOne({ where: {}, order: { createdAt: "ASC" } });
    if (!someUser) throw new Error("в базе нет ни одного пользователя");

    const byPrefix = await User.createQueryBuilder("u")
        .where("u.login LIKE :q", { q: `${someUser.login.slice(0, 3)}%` })
        .orderBy("u.login", "ASC")
        .take(10)
        .getMany();
    console.log(`  поиск в админке по началу логина: ${byPrefix.length} записей, есть искомая — ${byPrefix.some((u: User) => u.id === someUser.id)}`);

    const clan = await Clan.findOne({ where: {} });
    if (clan) {
        const leaderId = clan.leaderId;
        // Тот же запрос, что getPendingRequests / getInvitingClanTags: поиск идентификатора в JSON-массиве.
        const asMember = await Clan.createQueryBuilder("c")
            .where("JSON_CONTAINS(c.members, :id)", { id: JSON.stringify(leaderId) })
            .getMany();
        console.log(`  JSON_CONTAINS по составу клана: нашёл ${asMember.length} (ожидался 1: [${clan.tag}])`);
        if (asMember.length !== 1 || asMember[0].id !== clan.id) fail("JSON_CONTAINS по составу клана", 1, asMember.length);

        const nothing = await Clan.createQueryBuilder("c")
            .where("JSON_CONTAINS(c.joinRequests, :id)", { id: JSON.stringify("нет такого") })
            .getMany();
        console.log(`  JSON_CONTAINS по несуществующей заявке: ${nothing.length} (ожидался 0)`);
        if (nothing.length !== 0) fail("JSON_CONTAINS по несуществующей заявке", 0, nothing.length);

        console.log(`  клан по тегу: ${(await Clan.findOneBy({ tag: clan.tag }))?.name}`);
        console.log(`  клан по имени в другом регистре: ${(await Clan.findOneBy({ name: clan.name.toUpperCase() }))?.tag ?? "НЕ НАЙДЕН"}`);
        console.log(`  таблица кланов по рейтингу: ${(await Clan.find({ order: { rating: "DESC" }, take: 5 })).length}`);
    } else {
        console.log("  кланов в базе нет — часть запросов не проверить");
    }

    // Таблица лидеров и топ минёров: отбор и сортировка по пути внутри JSON-колонки. Пробу пишем в
    // отдельную временную запись, чтобы не портить настоящие данные.
    const probe = Object.assign(new User(), {
        username: "verifyprobe",
        login: "verifyprobe",
        password: "verify",
        referralHash: `verify-${Date.now()}`,
    });
    probe.rankedModes.set("1v1", { mmr: 1234, wins: 3, losses: 1, abandons: 0, games: 4, currentStreak: 2 });
    probe.stats.counters.set("mines_used", 7);
    await probe.save();
    const path = '$."1v1".mmr';
    const board = await User.createQueryBuilder("u")
        .where("JSON_EXTRACT(u.rankedModes, :path) IS NOT NULL", { path })
        .orderBy("CAST(JSON_EXTRACT(u.rankedModes, :path) AS SIGNED)", "DESC")
        .limit(20)
        .getMany();
    console.log(`  таблица лидеров: ${board.length} записей, у первой mmr=${board[0]?.rankedModes.get("1v1")?.mmr}`);
    if (board.length !== 1 || board[0].rankedModes.get("1v1")?.mmr !== 1234) fail("таблица лидеров", 1234, board[0]?.rankedModes.get("1v1")?.mmr ?? null);

    const higher = await User.createQueryBuilder("u")
        .where("CAST(JSON_EXTRACT(u.rankedModes, :path) AS SIGNED) > :mmr", { path, mmr: 1000 })
        .getCount();
    console.log(`  место в рейтинге (сколько выше 1000): ${higher} (ожидался 1)`);
    if (higher !== 1) fail("сравнение mmr через JSON_EXTRACT", 1, higher);

    const minesPath = '$."counters"."mines_used"';
    const miners = await User.createQueryBuilder("u")
        .where("CAST(JSON_EXTRACT(u.stats, :path) AS SIGNED) > 0", { path: minesPath })
        .orderBy("CAST(JSON_EXTRACT(u.stats, :path) AS SIGNED)", "DESC")
        .limit(20)
        .getMany();
    const mineCounts = miners.map((u: User) => u.stats.counters.get("mines_used") ?? 0);
    console.log(`  топ минёров: ${miners.length}, значения по убыванию: ${mineCounts.join(", ")}`);
    // Проба должна попасть в выборку, а порядок — быть строго по убыванию.
    if (!miners.some((u: User) => u.id === probe.id)) fail("топ минёров не видит пробу", probe.id, null);
    for (let i = 1; i < mineCounts.length; i++) {
        if (mineCounts[i] > mineCounts[i - 1]) fail("топ минёров отсортирован не по убыванию", mineCounts[i - 1], mineCounts[i]);
    }

    // История чата со связями и обрезка по времени.
    const history = await ChatMessage.find({ order: { timestamp: "DESC" }, take: 5, relations: { sourceUser: true, targetUser: true } });
    console.log(`  история чата: ${history.length} сообщений, авторы подтянулись у ${history.filter((m: ChatMessage) => m.sourceUser).length}`);

    // Уникальность: два пользователя без почты должны уживаться (в Mongo это был частичный индекс).
    const nullEmails = await User.countBy({ email: null as never });
    console.log(`  записей с пустой почтой: ${nullEmails} (уникальный индекс их не режет)`);

    // Правки внутри словарей должны доезжать до базы (см. save() в сущностях).
    probe.turrets.set("verify", 3);
    await probe.save();
    const reprobe = await User.findOneBy({ id: probe.id });
    console.log(`  правка внутри словаря: ${reprobe?.turrets.get("verify") === 3 ? "записалась" : "ПОТЕРЯНА"}`);
    if (reprobe?.turrets.get("verify") !== 3) fail("правка словаря не сохраняется", 3, reprobe?.turrets.get("verify") ?? null);

    // Округление: рейтинг клана копится дробными долями за клановые миссии.
    const probeClan = Object.assign(new Clan(), {
        name: `verify-${Date.now()}`,
        tag: `v${Date.now() % 10000}`,
        leaderId: probe.id,
        members: [probe.id],
        rating: 10.5,
    });
    await probeClan.save();
    const rereadClan = await Clan.findOneBy({ id: probeClan.id });
    console.log(`  дробный рейтинг клана: записали 10.5, прочитали ${rereadClan?.rating}`);
    if (rereadClan?.rating !== 10.5) fail("дробный рейтинг клана теряется", 10.5, rereadClan?.rating);

    probeClan.positions.set(probe.id, 3);
    await probeClan.save();
    const rereadPositions = await Clan.findOneBy({ id: probeClan.id });
    console.log(`  правка словаря должностей: ${rereadPositions?.positions.get(probe.id) === 3 ? "записалась" : "ПОТЕРЯНА"}`);
    if (rereadPositions?.positions.get(probe.id) !== 3) fail("должности в клане не сохраняются", 3, rereadPositions?.positions.get(probe.id) ?? null);

    await Clan.delete({ id: probeClan.id });
    await User.delete({ id: probe.id });

    if (live.length) {
        console.log(`\nизменено сервером уже после переноса (это нормально): ${live.join(", ")}`);
    }
    console.log(problems === 0 ? "\nВСЁ СОШЛОСЬ" : `\nРАСХОЖДЕНИЙ: ${problems}`);
    await mongoose.disconnect();
    await disconnectFromDatabase();
    if (problems) process.exit(1);
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
