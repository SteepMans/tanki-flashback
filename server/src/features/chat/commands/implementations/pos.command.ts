import { CommandContext, ICommand } from "@/features/chat/commands/command.types";
import { ChatModeratorLevel } from "@/shared/models/enums/chat-moderator-level.enum";

/** Shows the caller's current battle coordinates (handy for /tp and /bonus). */
export default class PosCommand implements ICommand {
    name = "pos";
    description = "Показывает ваши координаты в битве. Использование: /pos.";
    permissionLevel = ChatModeratorLevel.MODERATOR;

    async execute(context: CommandContext, _args: string[]): Promise<void> {
        const pos = context.executor.battlePosition;
        if (!context.executor.currentBattle || !pos) {
            context.reply("Нужно быть в битве, на поле.");
            return;
        }
        context.reply(`Координаты: x=${Math.round(pos.x)} y=${Math.round(pos.y)} z=${Math.round(pos.z)}`);
    }
}
