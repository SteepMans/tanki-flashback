import { CommandContext, ICommand } from "@/features/chat/commands/command.types";
import { ChatModeratorLevel } from "@/shared/models/enums/chat-moderator-level.enum";

/** Tells which battle a player is in and their current coordinates. */
export default class FindCommand implements ICommand {
    name = "find";
    description = "Показывает, в какой битве игрок и где он находится. Использование: /find <ник>.";
    permissionLevel = ChatModeratorLevel.MODERATOR;
    usage = "<ник>";
    example = "/find Игрок";

    async execute(context: CommandContext, args: string[]): Promise<void> {
        if (args.length < 1) {
            context.reply("Использование: /find <ник>.");
            return;
        }
        const target = context.server.findClientByUsername(args[0]);
        if (!target?.user) {
            context.reply(`Игрок "${args[0]}" не в сети.`);
            return;
        }
        if (!target.currentBattle) {
            context.reply(`${target.user.username} в сети, но не в битве.`);
            return;
        }
        const pos = target.battlePosition;
        const where = pos ? ` em x=${Math.round(pos.x)} y=${Math.round(pos.y)} z=${Math.round(pos.z)}` : " (fora de campo)";
        context.reply(`${target.user.username} в битве ${target.currentBattle.battleId}${target.isSpectator ? " как наблюдатель" : ""}${where}.`);
    }
}
