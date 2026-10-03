import { CommandContext, ICommand } from "@/features/chat/commands/command.types";
import { ChatModeratorLevel } from "@/shared/models/enums/chat-moderator-level.enum";

/** Admin command: drops N pumpkin boxes. Works in any map mode, even parkour.
 *  Usage: /pumpkin [count] (1 to 10, default 1). */
export default class PumpkinCommand implements ICommand {
    name = "pumpkin";
    description = "Сбрасывает тыквенные ящики (до 10 за раз). Работает в любом режиме, включая паркур. Использование: /pumpkin [количество].";
    permissionLevel = ChatModeratorLevel.CANDIDATE;
    usage = "[количество]";
    example = "/pumpkin 3";

    async execute(context: CommandContext, args: string[]): Promise<void> {
        const client = context.executor;
        if (!client.user || !client.currentBattle) {
            context.reply("Нужно быть в битве.");
            return;
        }

        let count = 1;
        if (args[0] !== undefined) {
            count = Number(args[0]);
            if (!Number.isInteger(count) || count < 1 || count > 10) {
                context.reply("Неверное количество (от 1 до 10). Использование: /pumpkin [количество].");
                return;
            }
        }

        context.server.battleService.bonus.announceBonusDrops(client.currentBattle, "pumpkin", count);
        context.reply(`Запланировано тыквенных ящиков: ${count}. Упадут через 30–50 секунд.`);
    }
}
