import { CommandContext, ICommand } from "@/features/chat/commands/command.types";
import { ChatModeratorLevel } from "@/shared/models/enums/chat-moderator-level.enum";

// Bonus types defined in getBonusData() — the spawn id prefix must match one of these.
const BONUS_TYPES = ["crystal", "gold", "health", "nitro", "damage", "armor", "special", "moon", "pumpkin"];

/** Test command: drops bonuses of <type> — N at random map areas, or one at your position/coords.
 *  Usage: /bonus <type> [amount] (random around the map areas) or /bonus <type> pos [x y z] (at your position/coordinates). */
export default class BonusCommand implements ICommand {
    name = "bonus";
    description = `Сбрасывает припасы. Использование: /bonus <${BONUS_TYPES.join("|")}> [количество] (по случайным точкам карты) или /bonus <тип> pos [x y z] (в вашей позиции или по координатам).`;
    permissionLevel = ChatModeratorLevel.MODERATOR;
    usage = `[${BONUS_TYPES.join("/")}] [количество | pos [x y z]]`;
    example = "/bonus gold 5";

    async execute(context: CommandContext, args: string[]): Promise<void> {
        const client = context.executor;
        if (!client.user || !client.currentBattle) {
            context.reply("Нужно быть в битве.");
            return;
        }

        const type = (args[0] ?? "").toLowerCase();
        if (!BONUS_TYPES.includes(type)) {
            context.reply(`Неизвестный тип. Доступные: ${BONUS_TYPES.join(", ")}.`);
            return;
        }

        // "/bonus <type> pos [x y z]" — one drop at your position or explicit coords (old behavior).
        if ((args[1] ?? "").toLowerCase() === "pos") {
            let position = client.battlePosition;
            if (args.length >= 5) {
                const x = Number(args[2]); const y = Number(args[3]); const z = Number(args[4]);
                if ([x, y, z].some((n) => Number.isNaN(n))) {
                    context.reply("Неверные координаты. Использование: /bonus <тип> pos [x y z].");
                    return;
                }
                position = { x, y, z };
            }
            if (!position) {
                context.reply("Вы не на поле: позиция неизвестна.");
                return;
            }
            const id = context.server.battleService.bonus.spawnBonus(client.currentBattle, type, position);
            context.reply(`Сброшен припас "${id}".`);
            return;
        }

        // "/bonus <type> [amount]" — N drops at random points inside the map's bonus areas.
        const count = args[1] !== undefined ? Number(args[1]) : 1;
        if (!Number.isInteger(count) || count < 1 || count > 100) {
            context.reply("Неверное количество (от 1 до 100). Использование: /bonus <тип> [количество].");
            return;
        }
        const dropped = context.server.battleService.bonus.spawnRandom(client.currentBattle, type, count);
        if (dropped === 0) {
            context.reply("На этой карте нет точек сброса для текущего режима.");
            return;
        }
        context.reply(`Сброшено припасов "${type}": ${dropped}, по случайным точкам карты.`);
    }
}
