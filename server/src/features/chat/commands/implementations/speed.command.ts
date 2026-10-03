import { broadcastMovementSpec } from "@/features/weapons/freeze/freeze.handlers";
import { CommandContext, ICommand } from "@/features/chat/commands/command.types";
import { ChatModeratorLevel } from "@/shared/models/enums/chat-moderator-level.enum";

const SPEED_MIN = 0.1, SPEED_MAX = 10;

/** Sets the caller's tank speed multiplier (physics test). Composes with nitro/freeze; 1 = normal.
 *  Resets on leaving the battle. NOTE: a respawn re-sends the base spec — re-run /speed after dying. */
export default class SpeedCommand implements ICommand {
    name = "speed";
    description = "Умножает скорость вашего танка (1 — обычная, сбрасывается при выходе). Использование: /speed <множитель>.";
    permissionLevel: ChatModeratorLevel = ChatModeratorLevel.ADMINISTRATOR;
    usage = "<множитель>";
    example = "/speed 2";

    async execute(context: CommandContext, args: string[]): Promise<void> {
        const client = context.executor;
        const battle = client.currentBattle;
        if (!client.user || !battle) {
            context.reply("Нужно быть в битве.");
            return;
        }
        const mult = parseFloat(args[0]);
        if (isNaN(mult) || mult < SPEED_MIN || mult > SPEED_MAX) {
            context.reply(`Использование: /speed <множитель> (от ${SPEED_MIN} до ${SPEED_MAX}).`);
            return;
        }

        client.speedMultiplier = mult;
        broadcastMovementSpec(battle, client);
        context.reply(`Скорость x${mult}${mult === 1 ? " (обычная)" : ""}.`);
    }
}
