import { CommandContext, ICommand } from "@/features/chat/commands/command.types";
import { ChatModeratorLevel } from "@/shared/models/enums/chat-moderator-level.enum";

/** Lists everyone connected, with the battle each one is in (if any). */
export default class OnlineCommand implements ICommand {
    name = "online";
    description = "Показывает, кто сейчас в сети и в каких битвах. Использование: /online.";
    permissionLevel = ChatModeratorLevel.MODERATOR;

    async execute(context: CommandContext, _args: string[]): Promise<void> {
        const authenticated = context.server.getClients().filter((c) => c.user);
        context.reply(`=== В сети: ${authenticated.length} ===`);
        for (const c of authenticated) {
            const battle = c.currentBattle ? ` — битва ${c.currentBattle.battleId}${c.isSpectator ? " (наблюдатель)" : ""}` : "";
            context.reply(`${c.user!.username}${battle}`);
        }
    }
}
