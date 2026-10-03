import { CommandContext, ICommand } from "@/features/chat/commands/command.types";
import { ChatModeratorLevel } from "@/shared/models/enums/chat-moderator-level.enum";

/** Lifts a user's punishment so they can log in again. */
export default class UnbanCommand implements ICommand {
    name = "unban";
    description = "Снимает бан с игрока. Использование: /unban <ник>.";
    permissionLevel: ChatModeratorLevel = ChatModeratorLevel.ADMINISTRATOR;
    usage = "<ник>";
    example = "/unban Игрок";

    async execute(context: CommandContext, args: string[]): Promise<void> {
        if (args.length < 1) {
            context.reply("Использование: /unban <ник>.");
            return;
        }
        const user = await context.server.userService.findUserByUsername(args[0]);
        if (!user) {
            context.reply(`Игрок "${args[0]}" не найден.`);
            return;
        }
        if (!user.isPunished) {
            context.reply(`${user.username} не забанен.`);
            return;
        }
        user.isPunished = false;
        user.punishmentExpiresAt = null;
        user.punishmentReason = null;
        await user.save();
        context.reply(`Бан снят с игрока ${user.username}.`);
    }
}
