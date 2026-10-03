import { CommandContext, ICommand } from "@/features/chat/commands/command.types";
import { ChatModeratorLevel } from "@/shared/models/enums/chat-moderator-level.enum";

/** Wipes a user's long-term stats (kills/deaths/streaks/records). Rank/crystals/garage untouched. */
export default class ResetStatsCommand implements ICommand {
    name = "resetstats";
    description = "Стирает накопленную статистику игрока. Использование: /resetstats <ник>.";
    permissionLevel = ChatModeratorLevel.ADMINISTRATOR;
    usage = "<ник>";
    example = "/resetstats Игрок";

    async execute(context: CommandContext, args: string[]): Promise<void> {
        if (args.length < 1) {
            context.reply("Использование: /resetstats <ник>.");
            return;
        }
        const online = context.server.findClientByUsername(args[0]);
        const user = online?.user ?? (await context.server.userService.findUserByUsername(args[0]));
        if (!user) {
            context.reply(`Игрок "${args[0]}" не найден.`);
            return;
        }

        user.stats.counters.clear();
        user.stats.maxKillsInBattle = 0;
        user.stats.maxDeathsInBattle = 0;
        user.stats.maxCrystalsInBattle = 0;
        user.stats.maxXpInBattle = 0;
        user.stats.maxDamageInBattle = 0;
        user.stats.currentWinStreak = 0;
        user.stats.maxWinStreak = 0;
        user.stats.currentLossStreak = 0;
        user.stats.maxLossStreak = 0;
        await user.save();
        context.reply(`Статистика игрока ${user.username} сброшена.`);
    }
}
