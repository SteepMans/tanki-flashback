import { CommandContext, ICommand } from "@/features/chat/commands/command.types";
import { ChatModeratorLevel, chatModeratorLevelName } from "@/shared/models/enums/chat-moderator-level.enum";
import logger from "@/utils/logger";

/**
 * /set_admin <username> — shorthand for `/role <username> administrator`. Same restriction as /role
 * (Community Manager only), same persistence: writes to the DB so it also works on offline users, and
 * patches the live session when the target is online so permissions and the chat tag apply without a
 * relogin.
 */
export default class SetAdminCommand implements ICommand {
    name = "set_admin";
    description = "Выдаёт игроку роль администратора. Использование: /set_admin <ник>.";
    permissionLevel = ChatModeratorLevel.COMMUNITY_MANAGER;
    usage = "<ник>";
    example = "/set_admin Игрок";

    async execute(context: CommandContext, args: string[]): Promise<void> {
        if (args.length < 1) {
            context.reply("Использование: /set_admin <ник>.");
            return;
        }

        const targetName = args[0];

        try {
            const updated = await context.server.userService.setChatModeratorLevel(
                targetName,
                ChatModeratorLevel.ADMINISTRATOR
            );

            const online = context.server.findClientByUsername(updated.username);
            if (online?.user) {
                online.user.chatModeratorLevel = ChatModeratorLevel.ADMINISTRATOR;
            }

            logger.info("Administrator role granted", {
                target: updated.username,
                by: context.executor.user?.username,
            });

            context.reply(
                `Роль игрока ${updated.username}: ${chatModeratorLevelName(ChatModeratorLevel.ADMINISTRATOR)}.`
            );
        } catch (error: any) {
            context.reply(`Ошибка: ${error.message}`);
        }
    }
}
