import assert from "node:assert/strict";
import test from "node:test";
import { CommandService } from "@/features/chat/commands/command.service";
import { CommandContext } from "@/features/chat/commands/command.types";
import { ChatModeratorLevel, hasModeratorPower } from "@/shared/models/enums/chat-moderator-level.enum";

/** Контекст обычного игрока (роль NONE, адрес не loopback — локальный админ-байпас не срабатывает). */
function makeContext() {
    const replies: string[] = [];
    const updates: Record<string, number>[] = [];
    const user = {
        id: 1,
        username: "player",
        chatModeratorLevel: ChatModeratorLevel.NONE,
        crystals: 0,
        experience: 0,
        rank: 1,
        nextRankScore: 1000,
    };
    const executor = {
        user,
        getRemoteAddress: () => "203.0.113.10",
        sendPacket: () => undefined,
    };
    const server = {
        userService: {
            updateResources: async (_id: number, resources: Record<string, number>) => {
                updates.push(resources);
                return { ...user, ...resources };
            },
        },
    };
    const context = {
        executor,
        server,
        reply: (message: string) => void replies.push(message),
    } as unknown as CommandContext;
    return { context, replies, updates };
}

test("addscore, addcrystals and gold are open to regular players", () => {
    const service = new CommandService();
    for (const name of ["addscore", "addcrystals", "gold"]) {
        const command = service.getCommand(name);
        assert.ok(command, `command /${name} must be registered`);
        assert.equal(command.permissionLevel, ChatModeratorLevel.NONE, `/${name} must require no role`);
        assert.ok(hasModeratorPower(ChatModeratorLevel.NONE, command.permissionLevel));
    }
});

test("staff commands stay closed to regular players", async () => {
    const service = new CommandService();
    for (const name of ["ban", "kick", "setcrystals", "setscore", "restart", "broadcast"]) {
        const command = service.getCommand(name);
        assert.ok(command, `command /${name} must be registered`);
        assert.equal(
            hasModeratorPower(ChatModeratorLevel.NONE, command.permissionLevel),
            false,
            `/${name} must not be open to everyone`
        );
    }

    const { context, replies, updates } = makeContext();
    await service.process("/ban someone", context);
    assert.deepEqual(replies, ["У вас нет прав на эту команду."]);
    assert.equal(updates.length, 0);
});

test("a regular player can add crystals within the per-call limit", async () => {
    const service = new CommandService();
    const { context, replies, updates } = makeContext();
    await service.process("/addcrystals 1000", context);
    assert.deepEqual(updates, [{ crystals: 1000 }]);
    assert.deepEqual(replies, ["Кристаллов стало: 1000."]);
});

test("a regular player can add experience within the per-call limit", async () => {
    const service = new CommandService();
    const { context, replies, updates } = makeContext();
    await service.process("/addscore 500", context);
    assert.deepEqual(updates, [{ experience: 500 }]);
    assert.deepEqual(replies, ["Опыта стало: 500."]);
});

test("non-positive and oversized amounts are rejected without touching the balance", async () => {
    const service = new CommandService();
    const cases: Array<[string, string]> = [
        ["/addcrystals -5", "Ошибка: количество должно быть положительным."],
        ["/addscore 0", "Ошибка: количество должно быть положительным."],
        ["/addcrystals 1000001", "За один раз можно добавить не больше 1000000 кристаллов."],
        ["/addscore 99999999", "За один раз можно добавить не больше 1000000 опыта."],
    ];
    for (const [commandLine, expectedReply] of cases) {
        const { context, replies, updates } = makeContext();
        await service.process(commandLine, context);
        assert.equal(updates.length, 0, `${commandLine} must not touch the balance`);
        assert.deepEqual(replies, [expectedReply]);
    }
});
