import { CommandContext, ICommand } from "@/features/chat/commands/command.types";
import { UpdateCrystals } from "@/features/profile/profile.packets";
import { ChatModeratorLevel } from "@/shared/models/enums/chat-moderator-level.enum";

const MAX_CRYSTALS = 99_999_999;

/** Grants crystals to another player (works offline; live update when online). */
export default class GiveCommand implements ICommand {
    name = "give";
    description = "Начисляет кристаллы другому игроку. Использование: /give <ник> <количество>.";
    permissionLevel = ChatModeratorLevel.MODERATOR;
    usage = "<ник> <количество>";
    example = "/give Игрок 50000";

    async execute(context: CommandContext, args: string[]): Promise<void> {
        const amount = parseInt(args[1], 10);
        if (args.length < 2 || isNaN(amount) || amount <= 0) {
            context.reply("Использование: /give <ник> <количество> (положительное число).");
            return;
        }

        const online = context.server.findClientByUsername(args[0]);
        const target = online?.user ?? (await context.server.userService.findUserByUsername(args[0]));
        if (!target) {
            context.reply(`Игрок "${args[0]}" не найден.`);
            return;
        }

        try {
            const crystals = Math.min(target.crystals + amount, MAX_CRYSTALS);
            const updated = await context.server.userService.updateResources(target.id, { crystals });
            if (online) {
                online.user = updated;
                online.sendPacket(new UpdateCrystals({ crystals: updated.crystals }));
            }
            context.reply(`Игроку ${updated.username} начислено ${amount} кристаллов (всего: ${updated.crystals}).`);
        } catch (error: any) {
            context.reply(`Ошибка: ${error.message}`);
        }
    }
}
