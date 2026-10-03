import { CommandContext, ICommand } from "@/features/chat/commands/command.types";
import { ChatModeratorLevel } from "@/shared/models/enums/chat-moderator-level.enum";

/**
 * Force-ends a battle (results screen). No argument = the battle the caller is currently in or spectating;
 * `/finish <id>` ends a specific battle by its id (works from anywhere, e.g. the battle list).
 */
export default class FinishBattleCommand implements ICommand {
    name = "finish";
    description = "Завершает битву (текущую, наблюдаемую или указанную по номеру). Использование: /finish [id].";
    permissionLevel = ChatModeratorLevel.ADMINISTRATOR;
    usage = "[id]";
    example = "/finish";

    async execute(context: CommandContext, args: string[]): Promise<void> {
        const { server } = context;

        let battle = context.executor.currentBattle ?? null;
        if (args.length >= 1) {
            battle = server.lobbyService.getBattleById(args[0]) ?? null;
            if (!battle) {
                context.reply(`Битва "${args[0]}" не найдена.`);
                return;
            }
        }
        if (!battle) {
            context.reply("Нужно быть в битве или указать её номер. Использование: /finish [id].");
            return;
        }

        const ended = server.battleService.finishBattle(battle);
        context.reply(
            ended ? `Битва ${battle.battleId} завершена.` : `Битва ${battle.battleId} уже завершается.`
        );
    }
}
