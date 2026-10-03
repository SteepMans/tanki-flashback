import { BattleMode } from "@/features/battle/battle.model";
import { CommandContext, ICommand } from "@/features/chat/commands/command.types";
import { ChatModeratorLevel } from "@/shared/models/enums/chat-moderator-level.enum";

/** Drops any flag currently being carried in the caller's battle (CTF). */
export default class DropFlagCommand implements ICommand {
    name = "dropflag";
    description = "Бросает флаг, который вы несёте (режим захвата флага). Использование: /dropflag.";
    permissionLevel = ChatModeratorLevel.MODERATOR;
    example = "/dropflag";

    async execute(context: CommandContext, _args: string[]): Promise<void> {
        const client = context.executor;
        const battle = client.currentBattle;
        if (!client.user || !battle) {
            context.reply("Нужно быть в битве.");
            return;
        }
        if (battle.settings.battleMode !== BattleMode.CTF) {
            context.reply("Это битва не в режиме захвата флага.");
            return;
        }

        const dropped = context.server.battleService.dropCarriedFlags(battle);
        context.reply(dropped > 0 ? `${dropped} flag(s) dropped.` : "Вы не несёте флаг.");
    }
}
