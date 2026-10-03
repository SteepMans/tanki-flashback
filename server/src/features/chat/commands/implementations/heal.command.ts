import { HEAL_MAX_GIVEN } from "@/features/battle/supply.service";
import { CommandContext, ICommand } from "@/features/chat/commands/command.types";
import { ChatModeratorLevel } from "@/shared/models/enums/chat-moderator-level.enum";

/** Starts a free full repair-kit regen on a tank — yours by default, or another player's in the same battle. */
export default class HealCommand implements ICommand {
    name = "heal";
    description = "Восстанавливает броню танка бесплатно (без ника — себе). Использование: /heal [ник].";
    permissionLevel = ChatModeratorLevel.MODERATOR;
    usage = "[ник]";
    example = "/heal Игрок";

    async execute(context: CommandContext, args: string[]): Promise<void> {
        const client = context.executor;
        const { server } = context;
        if (!client.user || !client.currentBattle) {
            context.reply("Нужно быть в битве.");
            return;
        }

        let target = client;
        if (args.length >= 1) {
            const found = server.findClientByUsername(args[0]);
            if (!found?.user || found.currentBattle?.battleId !== client.currentBattle.battleId) {
                context.reply(`Игрока "${args[0]}" нет в этой битве.`);
                return;
            }
            target = found;
        }
        if (target.battleState !== "active") {
            context.reply(`У игрока ${target.user?.username} нет танка на поле.`);
            return;
        }

        server.battleService.supply.startHealing(target, client.currentBattle, HEAL_MAX_GIVEN.INVENTORY);
        context.reply(`Игрок ${target.user?.username} вылечен.`);
    }
}
