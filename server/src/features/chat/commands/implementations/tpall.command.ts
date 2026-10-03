import { teleportTank } from "@/features/battle/teleport.util";
import { CommandContext, ICommand } from "@/features/chat/commands/command.types";
import { ChatModeratorLevel } from "@/shared/models/enums/chat-moderator-level.enum";

/** Teleports every active player in the battle to the caller's position. */
export default class TpAllCommand implements ICommand {
    name = "tpall";
    description = "Переносит к вам всех игроков битвы. Использование: /tpall.";
    permissionLevel = ChatModeratorLevel.MODERATOR;

    async execute(context: CommandContext, _args: string[]): Promise<void> {
        const client = context.executor;
        const battle = client.currentBattle;
        const pos = client.battlePosition;
        if (!client.user || !battle || !pos) {
            context.reply("Нужно быть в битве, на поле.");
            return;
        }

        let moved = 0;
        for (const other of battle.clients) {
            if (other === client || !other.user || other.isSpectator || other.battleState !== "active") continue;
            teleportTank(other, pos);
            moved++;
        }
        context.reply(moved > 0 ? `Игроков перенесено к вам: ${moved}.` : "В битве нет других игроков на поле.");
    }
}
