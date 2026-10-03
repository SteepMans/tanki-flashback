import { teleportTank } from "@/features/battle/teleport.util";
import { CommandContext, ICommand } from "@/features/chat/commands/command.types";
import { ChatModeratorLevel } from "@/shared/models/enums/chat-moderator-level.enum";

/** Teleports another player to the caller's position. Uso: /tphere <username> (case-insensitive). */
export default class TpHereCommand implements ICommand {
    name = "tphere";
    description = "Переносит другого игрока к вам. Использование: /tphere <ник>.";
    permissionLevel = ChatModeratorLevel.MODERATOR;
    usage = "<ник>";
    example = "/tphere Игрок";

    async execute(context: CommandContext, args: string[]): Promise<void> {
        const client = context.executor;
        const { server } = context;
        if (!client.user || !client.currentBattle) {
            context.reply("Нужно быть в битве.");
            return;
        }

        if (args.length < 1) {
            context.reply("Использование: /tphere <ник>.");
            return;
        }

        if (!client.battlePosition) {
            context.reply("Вы не на поле.");
            return;
        }

        const target = server.findClientByUsername(args[0]);
        if (!target || target.currentBattle?.battleId !== client.currentBattle.battleId) {
            context.reply(`Игрока "${args[0]}" нет в этой битве.`);
            return;
        }

        teleportTank(target, client.battlePosition);
        context.reply(`Переносим ${target.user?.username} к вам…`);
    }
}
