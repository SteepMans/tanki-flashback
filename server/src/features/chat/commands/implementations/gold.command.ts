import { CommandContext, ICommand } from "@/features/chat/commands/command.types";
import { ChatModeratorLevel } from "@/shared/models/enums/chat-moderator-level.enum";

/** Player command (open to everyone): drops N gold boxes with siren announcement. Works in any map mode, even parkour.
 *  Usage: /gold [count] (1 to 10, default 1). */
export default class GoldCommand implements ICommand {
    name = "gold";
    description = "Сбрасывает золотые ящики с сиреной (до 10 за раз). Работает в любом режиме, включая паркур. Использование: /gold [количество].";
    permissionLevel = ChatModeratorLevel.NONE;
    usage = "[количество]";
    example = "/gold 5";

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
                context.reply("Неверное количество (от 1 до 10). Использование: /gold [количество].");
                return;
            }
        }

        context.server.battleService.bonus.announceGoldBoxDrops(client.currentBattle, count);
        context.reply(`Объявлено золотых ящиков: ${count}. Упадут через 30–50 секунд.`);
    }
}
