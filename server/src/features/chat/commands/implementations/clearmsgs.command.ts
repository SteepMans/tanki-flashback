import { CommandContext, ICommand } from "@/features/chat/commands/command.types";
import { ChatModeratorLevel, chatModeratorPower } from "@/shared/models/enums/chat-moderator-level.enum";
import { RemoveUserChatMessagesPacket } from "@/features/chat/chat.packets";

/**
 * Remove TODAS as mensagens de chat de um usuário — do histórico (DB) e das telas de todos os clientes —
 * SEM silenciá-lo (ele continua podendo falar). Para spam/limpeza pontual. Guard de hierarquia como o /mute.
 */
export default class ClearMessagesCommand implements ICommand {
    name = "clearmsgs";
    description = "Удаляет все сообщения игрока из чата (без блокировки чата). Использование: /clearmsgs <ник>.";
    permissionLevel = ChatModeratorLevel.MODERATOR;
    usage = "<ник>";
    example = "/clearmsgs Игрок";

    async execute(context: CommandContext, args: string[]): Promise<void> {
        if (args.length < 1) {
            context.reply("Использование: /clearmsgs <ник>.");
            return;
        }

        const online = context.server.findClientByUsername(args[0]);
        const user = online?.user ?? (await context.server.userService.findUserByUsername(args[0]));
        if (!user) {
            context.reply(`Игрок "${args[0]}" не найден.`);
            return;
        }
        if (chatModeratorPower(user.chatModeratorLevel) >= chatModeratorPower(context.executor.user!.chatModeratorLevel)) {
            context.reply(`Нельзя чистить сообщения ${user.username}: у него роль не ниже вашей.`);
            return;
        }

        const removed = await context.server.chatService.removeUserMessages(user);
        const removePacket = new RemoveUserChatMessagesPacket({ nickname: user.username });
        for (const c of context.server.getClients()) c.sendPacket(removePacket);

        context.reply(`Сообщения игрока ${user.username} удалены (из истории — ${removed}).`);
    }
}
