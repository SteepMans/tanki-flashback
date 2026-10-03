import { BattleSystemMessagePacket } from "@/features/battle/battle.packets";
import { ChatHistory } from "@/features/chat/chat.packets";
import { CommandContext, ICommand } from "@/features/chat/commands/command.types";
import { ChatModeratorLevel } from "@/shared/models/enums/chat-moderator-level.enum";

/** Sends a private SYSTEM message to one player (formal staff warning without muting). Delivered on the
 *  chat the target is currently looking at (battle chat when in a battle, lobby chat otherwise). */
export default class MsgCommand implements ICommand {
    name = "msg";
    description = "Отправляет игроку личное системное сообщение. Использование: /msg <ник> <текст>.";
    permissionLevel = ChatModeratorLevel.MODERATOR;
    usage = "<ник> <текст>";
    example = "/msg Игрок Не спамьте в чате";

    async execute(context: CommandContext, args: string[]): Promise<void> {
        const message = args.slice(1).join(" ").trim();
        if (args.length < 2 || !message) {
            context.reply("Использование: /msg <ник> <текст>.");
            return;
        }
        const target = context.server.findClientByUsername(args[0]);
        if (!target?.user) {
            context.reply(`Игрок "${args[0]}" не в сети.`);
            return;
        }

        const tagged = `[STAFF] ${message}`;
        if (target.currentBattle) {
            // Battle chat's system-message channel (606668848, confirmed in-game).
            target.sendPacket(new BattleSystemMessagePacket({ message: tagged }));
        } else {
            target.sendPacket(new ChatHistory({ messages: [{ message: tagged, isSystem: true, isWarning: true, source: null, target: null }] }));
        }
        context.reply(`Сообщение отправлено игроку ${target.user.username}.`);
    }
}
