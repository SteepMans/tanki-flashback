import { CommandContext, ICommand } from "@/features/chat/commands/command.types";
import { ChatModeratorLevel } from "@/shared/models/enums/chat-moderator-level.enum";

/** Resumes a battle frozen by /pause. */
export default class ResumeCommand implements ICommand {
    name = "resume";
    description = "Снимает паузу, поставленную командой /pause. Использование: /resume.";
    permissionLevel: ChatModeratorLevel = ChatModeratorLevel.ADMINISTRATOR;
    example = "/resume";

    async execute(context: CommandContext, _args: string[]): Promise<void> {
        const battle = context.executor.currentBattle;
        if (!context.executor.user || !battle) {
            context.reply("Нужно быть в битве.");
            return;
        }
        if (!battle.paused) {
            context.reply("Битва не на паузе.");
            return;
        }
        battle.paused = false;
        context.reply(`Битва ${battle.battleId} продолжена.`);
    }
}
