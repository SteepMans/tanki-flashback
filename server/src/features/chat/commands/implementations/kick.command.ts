import { CommandContext, ICommand } from "@/features/chat/commands/command.types";
import { ChatModeratorLevel, chatModeratorPower } from "@/shared/models/enums/chat-moderator-level.enum";

/** Drops a player's connection. Staff can't kick someone of equal/higher cargo. */
export default class KickCommand implements ICommand {
    name = "kick";
    description = "Отключает игрока от сервера. Использование: /kick <ник>.";
    permissionLevel = ChatModeratorLevel.MODERATOR;
    usage = "<ник>";
    example = "/kick Игрок";

    async execute(context: CommandContext, args: string[]): Promise<void> {
        if (args.length < 1) {
            context.reply("Использование: /kick <ник>.");
            return;
        }
        const target = context.server.findClientByUsername(args[0]);
        if (!target?.user) {
            context.reply(`Игрок "${args[0]}" не в сети.`);
            return;
        }
        if (target === context.executor) {
            context.reply("Себя отключить нельзя.");
            return;
        }
        // Hierarchy guard: only someone with strictly MORE power can be kicked.
        if (chatModeratorPower(target.user.chatModeratorLevel) >= chatModeratorPower(context.executor.user!.chatModeratorLevel)) {
            context.reply(`Нельзя отключить ${target.user.username}: у него роль не ниже вашей.`);
            return;
        }
        const name = target.user.username;
        target.closeConnection();
        context.reply(`${name} отключён от сервера.`);
    }
}
