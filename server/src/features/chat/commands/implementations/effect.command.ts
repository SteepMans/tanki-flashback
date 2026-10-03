import { CommandContext, ICommand } from "@/features/chat/commands/command.types";
import { ChatModeratorLevel } from "@/shared/models/enums/chat-moderator-level.enum";

const EFFECT_TYPES = ["n2o", "double_damage", "armor"] as const;

/** Applies a supply buff for free (no inventory cost) — to yourself or another player in the battle. */
export default class EffectCommand implements ICommand {
    name = "effect";
    description = "Бесплатно применяет припас (без ника — на себя). Использование: /effect <тип> [ник].";
    permissionLevel = ChatModeratorLevel.MODERATOR;
    usage = "<n2o/double_damage/armor> [ник]";
    example = "/effect n2o Игрок";

    async execute(context: CommandContext, args: string[]): Promise<void> {
        const client = context.executor;
        const { server } = context;
        if (!client.user || !client.currentBattle) {
            context.reply("Нужно быть в битве.");
            return;
        }

        const type = (args[0] ?? "").toLowerCase();
        if (!(EFFECT_TYPES as readonly string[]).includes(type)) {
            context.reply(`Неизвестный тип. Доступные: ${EFFECT_TYPES.join(", ")}.`);
            return;
        }

        let target = client;
        if (args.length >= 2) {
            const found = server.findClientByUsername(args[1]);
            if (!found?.user || found.currentBattle?.battleId !== client.currentBattle.battleId) {
                context.reply(`Игрока "${args[1]}" нет в этой битве.`);
                return;
            }
            target = found;
        }
        if (target.battleState !== "active") {
            context.reply(`У игрока ${target.user?.username} нет танка на поле.`);
            return;
        }

        server.battleService.supply.applyEffect(target, client.currentBattle, type);
        context.reply(`Игроку ${target.user?.username} выдан припас ${type}.`);
    }
}
