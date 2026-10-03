import { CommandContext, ICommand } from "@/features/chat/commands/command.types";
import { ChatModeratorLevel } from "@/shared/models/enums/chat-moderator-level.enum";

/** /ranking — mostra a classificação da ranqueada (XP/BP): sua posição + o top 10. */
export default class RankingCommand implements ICommand {
    name = "ranking";
    description = "Показывает рейтинг соревновательных боёв: ваше место и первую десятку.";
    permissionLevel: ChatModeratorLevel = ChatModeratorLevel.MODERATOR;

    async execute(context: CommandContext, args: string[]): Promise<void> {
        const svc = context.server.rankedService;
        if (!svc) {
            context.reply("Рейтинговые бои недоступны.");
            return;
        }
        // /ranking [1v1|2v2] — padrão 1v1.
        const mode = args[0] === "2v2" ? "2v2" : "1v1";
        const userId = context.executor.user?.id;
        const [top, you] = await Promise.all([
            svc.getLeaderboard(mode, 10),
            userId ? svc.getPlayerPosition(userId, mode) : Promise.resolve(null),
        ]);

        context.reply(`=== Рейтинг · опыт/боевые очки ${mode} ===`);
        if (you) context.reply(`Вы: #${you.rank} из ${you.total} · MMR ${you.mmr}`);
        else context.reply("Вы ещё не в рейтинге: сыграйте рейтинговый бой.");

        if (top.length === 0) {
            context.reply("В рейтинге пока никого нет.");
            return;
        }
        top.forEach((p, i) => {
            context.reply(`#${i + 1} ${p.username} — ${p.mmr} MMR (побед: ${p.wins}, поражений: ${p.losses})`);
        });
    }
}
