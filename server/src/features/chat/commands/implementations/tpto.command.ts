import { teleportTank } from "@/features/battle/teleport.util";
import { CommandContext, ICommand } from "@/features/chat/commands/command.types";
import { ChatModeratorLevel } from "@/shared/models/enums/chat-moderator-level.enum";

/** Teleports the caller to another player's position. Uso: /tpto <username> (case-insensitive). */
export default class TpToCommand implements ICommand {
    name = "tpto";
    description = "Переносит вас к другому игроку. Использование: /tpto <ник>.";
    permissionLevel = ChatModeratorLevel.MODERATOR;
    usage = "<ник>";
    example = "/tpto Игрок";

    async execute(context: CommandContext, args: string[]): Promise<void> {
        const client = context.executor;
        const { server } = context;
        if (!client.user || !client.currentBattle) {
            context.reply("Нужно быть в битве.");
            return;
        }

        if (args.length < 1) {
            context.reply("Использование: /tpto <ник>.");
            return;
        }

        const target = server.findClientByUsername(args[0]);
        if (!target || target.currentBattle?.battleId !== client.currentBattle.battleId) {
            context.reply(`Игрока "${args[0]}" нет в этой битве.`);
            return;
        }
        if (!target.battlePosition) {
            context.reply(`Игрок "${target.user?.username}" не на поле.`);
            return;
        }

        teleportTank(client, target.battlePosition);
        context.reply(`Переносим вас к ${target.user?.username}…`);
    }
}
