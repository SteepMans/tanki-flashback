import { MAX_BOTS_PER_BATTLE } from "@/features/battle/bot/bot.service";
import { CommandContext, ICommand } from "@/features/chat/commands/command.types";
import { ChatModeratorLevel } from "@/shared/models/enums/chat-moderator-level.enum";

/**
 * Управление ботами текущей битвы. В окне создания битвы у клиента такого поля нет, поэтому команда
 * меняет ту же настройку боя (`settings.botCount`), что и веб-панель, — состав приводится сразу.
 * Боты живут, только пока в бою есть живой игрок.
 */
export default class BotsCommand implements ICommand {
    name = "bots";
    description = `Добавляет или убирает ботов в текущей битве (0 — убрать всех, максимум ${MAX_BOTS_PER_BATTLE}). Без аргумента показывает, сколько их сейчас. Использование: /bots [количество].`;
    permissionLevel = ChatModeratorLevel.MODERATOR;
    usage = "[количество]";
    example = "/bots 6";

    async execute(context: CommandContext, args: string[]): Promise<void> {
        const client = context.executor;
        const battle = client.currentBattle;
        if (!client.user || !battle) {
            context.reply("Нужно быть в битве.");
            return;
        }

        const bots = context.server.battleService.bots;

        if (args.length === 0) {
            context.reply(`Ботов в битве: ${bots.count(battle)} (заказано: ${battle.settings.botCount ?? 0}, максимум: ${MAX_BOTS_PER_BATTLE}).`);
            return;
        }

        const requested = Number(args[0]);
        if (!Number.isFinite(requested) || requested < 0) {
            context.reply(`Укажите количество от 0 до ${MAX_BOTS_PER_BATTLE}. Пример: ${this.example}.`);
            return;
        }

        const applied = bots.setDesiredCount(battle, requested);
        const actual = bots.count(battle);
        if (actual === 0) {
            context.reply("Все боты убраны из битвы.");
            return;
        }
        // Заказ могли обрезать: свободных мест в бою меньше, чем попросили.
        const note = applied < Math.floor(requested) ? ` (свободных мест хватило только на ${applied})` : "";
        context.reply(`Ботов в битве: ${actual}${note}.`);
    }
}
