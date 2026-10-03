import { CommandContext, ICommand } from "@/features/chat/commands/command.types";
import { ChatModeratorLevel } from "@/shared/models/enums/chat-moderator-level.enum";

/** Lifts a user's chat mute. */
export default class UnmuteCommand implements ICommand {
    name = "unmute";
    description = "Разблокирует чат игрока. Использование: /unmute <ник>.";
    permissionLevel = ChatModeratorLevel.MODERATOR;
    usage = "<ник>";
    example = "/unmute Игрок";

    async execute(context: CommandContext, args: string[]): Promise<void> {
        if (args.length < 1) {
            context.reply("Использование: /unmute <ник>.");
            return;
        }
        const online = context.server.findClientByUsername(args[0]);
        const user = online?.user ?? (await context.server.userService.findUserByUsername(args[0]));
        if (!user) {
            context.reply(`Игрок "${args[0]}" не найден.`);
            return;
        }
        if (!user.mutedUntil || user.mutedUntil <= new Date()) {
            context.reply(`У игрока ${user.username} чат не заблокирован.`);
            return;
        }
        user.mutedUntil = null;
        await user.save();
        if (online?.user && online.user !== user) online.user.mutedUntil = null;
        context.reply(`Чат игрока ${user.username} разблокирован.`);
    }
}
