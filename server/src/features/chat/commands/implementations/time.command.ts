import { CommandContext, ICommand } from "@/features/chat/commands/command.types";
import { ChatModeratorLevel } from "@/shared/models/enums/chat-moderator-level.enum";

/** Sets the current round's remaining time (re-syncs everyone's clock + the time-up trigger). */
export default class TimeCommand implements ICommand {
    name = "time";
    description = "Задаёт оставшееся время раунда в секундах. Использование: /time <секунды>.";
    permissionLevel: ChatModeratorLevel = ChatModeratorLevel.ADMINISTRATOR;
    usage = "<секунды>";
    example = "/time 300";

    async execute(context: CommandContext, args: string[]): Promise<void> {
        const battle = context.executor.currentBattle;
        if (!context.executor.user || !battle) {
            context.reply("Нужно быть в битве.");
            return;
        }
        const seconds = parseInt(args[0], 10);
        if (isNaN(seconds) || seconds <= 0) {
            context.reply("Использование: /time <секунды> (положительное число).");
            return;
        }

        context.server.battleService.setRoundTimeLeft(battle, seconds);
        context.reply(`До конца раунда: ${seconds} с.`);
    }
}
