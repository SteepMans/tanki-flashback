import { ChangeFundPacket } from "@/features/battle/battle.packets";
import { CommandContext, ICommand } from "@/features/chat/commands/command.types";
import { ChatModeratorLevel } from "@/shared/models/enums/chat-moderator-level.enum";

/** Sets the current battle's crystal fund (the pool shown in the stats panel). */
export default class FundCommand implements ICommand {
    name = "fund";
    description = "Задаёт кристальный фонд текущей битвы. Использование: /fund <значение>.";
    permissionLevel = ChatModeratorLevel.ADMINISTRATOR;
    usage = "<значение>";
    example = "/fund 10000";

    async execute(context: CommandContext, args: string[]): Promise<void> {
        const battle = context.executor.currentBattle;
        if (!context.executor.user || !battle) {
            context.reply("Нужно быть в битве.");
            return;
        }
        const value = parseInt(args[0], 10);
        if (isNaN(value) || value < 0) {
            context.reply("Использование: /fund <значение> (число не меньше 0).");
            return;
        }

        battle.fund = value;
        battle.broadcast(new ChangeFundPacket(value));
        context.reply(`Фонд битвы изменён: ${value}.`);
    }
}
