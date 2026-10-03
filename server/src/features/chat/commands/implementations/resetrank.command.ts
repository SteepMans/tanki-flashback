import { CommandContext, ICommand } from "@/features/chat/commands/command.types";
import { GarageWorkflow } from "@/features/garage/garage.workflow";
import { UpdateRankPacket, UpdateScorePacket } from "@/features/profile/profile.packets";
import { ChatModeratorLevel } from "@/shared/models/enums/chat-moderator-level.enum";
import User from "@/shared/models/user.model";

/**
 * Community-manager command: resets the rank/experience of EVERY account back to the first rank.
 * Updates the database in one bulk write, then refreshes any online players live (so they don't need
 * to relog to see score 0). Usage: /resetrank
 */
export default class ResetRankCommand implements ICommand {
    name: string = "resetrank";
    description: string = "Сбрасывает звание и опыт ВСЕМ игрокам до начального уровня. Использование: /resetrank";
    permissionLevel: ChatModeratorLevel = ChatModeratorLevel.COMMUNITY_MANAGER;
    example = "/resetrank";

    async execute(context: CommandContext, args: string[]): Promise<void> {
        const initial = context.server.rankService.getInitialRankData(); // rank 1, score 0, nextRankScore
        const initialRankInfo = context.server.rankService.getRankById(initial.rank);
        const currentRankScore = initialRankInfo?.minScore ?? 0;

        // One bulk write covers every account (online or not).
        const result = await User.createQueryBuilder()
            .update()
            .set({ experience: initial.score, rank: initial.rank, nextRankScore: initial.nextRankScore })
            .execute();

        // Refresh online players in place so the reset shows without a relog.
        for (const client of context.server.getClients()) {
            const user = client.user;
            if (!user) continue;
            const rankChanged = user.rank !== initial.rank;
            user.experience = initial.score;
            user.rank = initial.rank;
            user.nextRankScore = initial.nextRankScore;
            client.sendPacket(new UpdateScorePacket({ score: initial.score }));
            client.sendPacket(new UpdateRankPacket({
                rank: initial.rank,
                score: initial.score,
                currentRankScore,
                nextRankScore: initial.nextRankScore,
                reward: 0,
            }));
            // Rank-dependent garage lists don't rebuild in place — reload for anyone with it open.
            if (rankChanged) GarageWorkflow.reloadGarage(client, context.server);
        }

        context.reply(`Звание сброшено игрокам: ${result.affected ?? 0}. Тем, кто в сети, данные обновлены.`);
    }
}
