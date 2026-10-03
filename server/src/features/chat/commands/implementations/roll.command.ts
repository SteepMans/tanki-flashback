import { CommandContext, ICommand } from "@/features/chat/commands/command.types";
import { ChatModeratorLevel } from "@/shared/models/enums/chat-moderator-level.enum";

/** Fun: rolls a random number 1..max (default 100). */
export default class RollCommand implements ICommand {
    name = "roll";
    description = "Бросает число от 1 до максимума (по умолчанию 100). Использование: /roll [максимум].";
    permissionLevel: ChatModeratorLevel = ChatModeratorLevel.MODERATOR;
    usage = "[максимум]";
    example = "/roll 6";

    async execute(context: CommandContext, args: string[]): Promise<void> {
        const max = Math.max(2, Math.floor(Number(args[0]) || 100));
        const value = 1 + Math.floor(Math.random() * max);
        context.reply(`${context.executor.user?.username} выбросил ${value} (из 1–${max}).`);
    }
}
