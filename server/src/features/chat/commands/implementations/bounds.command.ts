import { CommandContext, ICommand } from "@/features/chat/commands/command.types";
import { ChatModeratorLevel } from "@/shared/models/enums/chat-moderator-level.enum";

/** Toggles the current battle's map boundary (kill/kick) zones. `off` lets tanks roam outside the
 *  playable shell (parkour exploration/tests); `on` restores the normal limits. No argument = show state. */
export default class BoundsCommand implements ICommand {
    name = "bounds";
    description = "Включает и выключает границы карты (зоны смерти) в текущей битве. Использование: /bounds [on/off].";
    permissionLevel: ChatModeratorLevel = ChatModeratorLevel.ADMINISTRATOR;
    usage = "[on/off]";
    example = "/bounds off";

    async execute(context: CommandContext, args: string[]): Promise<void> {
        const battle = context.executor.currentBattle;
        if (!context.executor.user || !battle) {
            context.reply("Нужно быть в битве.");
            return;
        }

        const arg = (args[0] ?? "").toLowerCase();
        if (arg !== "on" && arg !== "off") {
            context.reply(`Границы карты: ${battle.boundsDisabled ? "ВЫКЛЮЧЕНЫ" : "включены"}. Использование: /bounds [on/off].`);
            return;
        }

        battle.boundsDisabled = arg === "off";
        context.reply(
            battle.boundsDisabled
                ? "Границы карты ВЫКЛЮЧЕНЫ — танки могут выезжать за игровую зону."
                : "Limites do mapa reativados."
        );
    }
}
