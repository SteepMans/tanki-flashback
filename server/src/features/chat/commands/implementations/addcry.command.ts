import { CommandContext, ICommand } from "@/features/chat/commands/command.types";
import { UpdateCrystals } from "@/features/profile/profile.packets";
import { ChatModeratorLevel } from "@/shared/models/enums/chat-moderator-level.enum";

/** Максимум за один вызов: команда открыта всем игрокам, поэтому вводим санити-лимит. */
const MAX_PER_CALL = 1_000_000;

export default class AddCrystalsCommand implements ICommand {
    name: string = "addcrystals";
    description: string = "Adds crystals to your account (open to everyone, up to 1000000 per call). Usage: /addcrystals <amount>.";
    permissionLevel: ChatModeratorLevel = ChatModeratorLevel.NONE;
    usage = "<количество>";
    example = "/addcrystals 50000";

    async execute(context: CommandContext, args: string[]): Promise<void> {
        if (args.length < 1) {
            context.reply("Использование: /addcrystals <количество>");
            return;
        }

        const amount = parseInt(args[0], 10);

        if (isNaN(amount)) {
            context.reply("Ошибка: количество должно быть числом.");
            return;
        }

        if (amount <= 0) {
            context.reply("Ошибка: количество должно быть положительным.");
            return;
        }

        if (amount > MAX_PER_CALL) {
            context.reply(`За один раз можно добавить не больше ${MAX_PER_CALL} кристаллов.`);
            return;
        }

        const user = context.executor.user;
        if (!user) {
            context.reply("Ошибка: игрок не найден.");
            return;
        }

        const currentCrystals = user.crystals;
        let newCrystals = currentCrystals + amount;

        const MAX_CRYSTALS = 99_999_999;
        const MIN_CRYSTALS = 0;
        newCrystals = Math.max(MIN_CRYSTALS, Math.min(newCrystals, MAX_CRYSTALS));

        try {
            const updatedUser = await context.server.userService.updateResources(user.id, {
                crystals: newCrystals,
            });

            context.executor.user = updatedUser;

            context.executor.sendPacket(new UpdateCrystals({ crystals: updatedUser.crystals }));
            context.reply(`Кристаллов стало: ${updatedUser.crystals}.`);
        } catch (error: any) {
            context.reply(`Не удалось изменить кристаллы: ${error.message}`);
        }
    }
}