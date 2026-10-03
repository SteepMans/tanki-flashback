import { CommandContext, ICommand } from "@/features/chat/commands/command.types";
import { ChatModeratorLevel, chatModeratorLevelName } from "@/shared/models/enums/chat-moderator-level.enum";

/** Staff info card about a user: rank, role, clan, crystals, punishment, connection/battle. */
export default class WhoisCommand implements ICommand {
    name = "whois";
    description = "Показывает данные игрока: звание, роль, клан, подключение и битву. Использование: /whois <ник>.";
    permissionLevel = ChatModeratorLevel.MODERATOR;
    usage = "<ник>";
    example = "/whois Игрок";

    async execute(context: CommandContext, args: string[]): Promise<void> {
        if (args.length < 1) {
            context.reply("Использование: /whois <ник>.");
            return;
        }
        const online = context.server.findClientByUsername(args[0]);
        const user = online?.user ?? (await context.server.userService.findUserByUsername(args[0]));
        if (!user) {
            context.reply(`Игрок "${args[0]}" не найден.`);
            return;
        }

        const clanTag = await context.server.clanService.getTagForUser(user);
        context.reply(`=== ${user.username} ===`);
        context.reply(`Звание: ${user.rank} | Опыт: ${user.experience} | Кристаллы: ${user.crystals}`);
        context.reply(`Роль: ${chatModeratorLevelName(user.chatModeratorLevel)} | Клан: ${clanTag ?? "нет"}`);
        if (user.isPunished && user.punishmentExpiresAt && user.punishmentExpiresAt > new Date()) {
            context.reply(`ЗАБАНЕН до ${user.punishmentExpiresAt.toISOString()} — причина: ${user.punishmentReason ?? "не указана"}`);
        }
        if (online) {
            const battle = online.currentBattle ? `битва ${online.currentBattle.battleId}${online.isSpectator ? " (наблюдатель)" : ""}` : "не в битве";
            context.reply(`В сети — IP ${online.getRemoteAddress()} — ${battle}.`);
        } else {
            context.reply(`Не в сети — последний вход: ${user.lastLogin ? user.lastLogin.toISOString() : "никогда"}.`);
        }
    }
}
