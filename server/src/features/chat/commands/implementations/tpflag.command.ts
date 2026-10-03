import { BattleMode } from "@/features/battle/battle.model";
import { teleportTank } from "@/features/battle/teleport.util";
import { CommandContext, ICommand } from "@/features/chat/commands/command.types";
import { ChatModeratorLevel } from "@/shared/models/enums/chat-moderator-level.enum";

/** Teleports the caller to a CTF flag's current position. Uso: /tpflag <red|blue>. */
export default class TpFlagCommand implements ICommand {
    name = "tpflag";
    description = "Переносит вас к флагу. Использование: /tpflag <red|blue>.";
    permissionLevel = ChatModeratorLevel.MODERATOR;
    usage = "[red/blue]";
    example = "/tpflag red";

    async execute(context: CommandContext, args: string[]): Promise<void> {
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

        const which = (args[0] ?? "").toLowerCase();
        const isRed = which === "red" || which === "r";
        const isBlue = which === "blue" || which === "b";
        if (!isRed && !isBlue) {
            context.reply("Использование: /tpflag <red|blue>.");
            return;
        }

        const flagPosition = isRed ? battle.flagPositionRed : battle.flagPositionBlue;
        const flagName = isRed ? "vermelha" : "azul";
        if (!flagPosition) {
            context.reply(`Флаг ${flagName} сейчас несут.`);
            return;
        }

        teleportTank(client, flagPosition);
        context.reply(`Переносим к флагу ${flagName}…`);
    }
}
