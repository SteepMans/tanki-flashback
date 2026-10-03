import { MAX_COMMAND_SCORE } from "@/config/rank.data";
import { CommandContext, ICommand } from "@/features/chat/commands/command.types";
import { GarageWorkflow } from "@/features/garage/garage.workflow";
import { UpdateRankPacket, UpdateScorePacket } from "@/features/profile/profile.packets";
import { ChatModeratorLevel } from "@/shared/models/enums/chat-moderator-level.enum";
import { broadcastPlayerRankToOthers } from "@/features/profile/rank.notify";

/** Максимум за один вызов: команда открыта всем игрокам, поэтому вводим санити-лимит. */
const MAX_PER_CALL = 1_000_000;

export default class AddScoreCommand implements ICommand {
    name: string = "addscore";
    description: string = "Adds experience to your account (open to everyone, up to 1000000 per call). Usage: /addscore <amount>.";
    permissionLevel: ChatModeratorLevel = ChatModeratorLevel.NONE;
    usage = "<количество>";
    example = "/addscore 100000";

    async execute(context: CommandContext, args: string[]): Promise<void> {
        if (args.length < 1) {
            context.reply("Использование: /addscore <количество>");
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
            context.reply(`За один раз можно добавить не больше ${MAX_PER_CALL} опыта.`);
            return;
        }

        const user = context.executor.user;
        if (!user) {
            context.reply("Ошибка: игрок не найден.");
            return;
        }

        const originalRank = user.rank;
        const currentScore = user.experience;
        let newScore = currentScore + amount;

        const MIN_SCORE = 0;
        newScore = Math.max(MIN_SCORE, Math.min(newScore, MAX_COMMAND_SCORE));

        try {
            const updatedUser = await context.server.userService.updateResources(user.id, {
                experience: newScore,
            });

            context.executor.user = updatedUser;

            context.executor.sendPacket(new UpdateScorePacket({ score: updatedUser.experience }));
            context.reply(`Опыта стало: ${updatedUser.experience}.`);

            if (updatedUser.rank !== originalRank) {
                const newRankInfo = context.server.rankService.getRankById(updatedUser.rank);
                if (newRankInfo) {
                    const rankPacket = new UpdateRankPacket({
                        rank: updatedUser.rank,
                        score: updatedUser.experience,
                        currentRankScore: newRankInfo.minScore,
                        nextRankScore: updatedUser.nextRankScore,
                        reward: 0,
                    });
                    context.executor.sendPacket(rankPacket);
                    context.reply(`Поздравляем! Получено звание: ${newRankInfo.name}.`);
                }
                // The garage item lists are rank-dependent: a rank change (up OR down) with the garage
                // open must fully reload it, or the client renders duplicated items.
                GarageWorkflow.reloadGarage(context.executor, context.server);
                // Atualiza o rank visual desse jogador para todos os demais online.
                broadcastPlayerRankToOthers(context.server, updatedUser);
            }
        } catch (error: any) {
            context.reply(`Не удалось изменить опыт: ${error.message}`);
        }
    }
}