import { BattleSystemMessagePacket } from "@/features/battle/battle.packets";
import { ChatHistory } from "@/features/chat/chat.packets";
import { CommandContext, ICommand } from "@/features/chat/commands/command.types";
import { ChatModeratorLevel } from "@/shared/models/enums/chat-moderator-level.enum";

/** Sends a system message to EVERYONE — lobby/garage chat listeners get the system chat entry, players
 *  currently in a battle get it on the battle chat (nickname-less general message). */
export default class BroadcastCommand implements ICommand {
    name = "broadcast";
    description = "Отправляет системное сообщение всем игрокам. Использование: /broadcast <сообщение>.";
    permissionLevel: ChatModeratorLevel = ChatModeratorLevel.ADMINISTRATOR;
    usage = "<сообщение>";
    example = "/broadcast Технические работы через 10 минут";

    async execute(context: CommandContext, args: string[]): Promise<void> {
        const message = args.join(" ").trim();
        if (!message) {
            context.reply("Использование: /broadcast <сообщение>.");
            return;
        }

        context.server.broadcastToLobbyChat(
            new ChatHistory({ messages: [{ message, isSystem: true, isWarning: true, source: null, target: null }] })
        );
        for (const client of context.server.getClients()) {
            if (client.user && client.currentBattle) {
                client.sendPacket(new BattleSystemMessagePacket({ message: message }));
            }
        }
        context.reply("Сообщение отправлено всем игрокам.");
    }
}
