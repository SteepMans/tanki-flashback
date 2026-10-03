import { CommandContext, ICommand } from "@/features/chat/commands/command.types";
import { ChatModeratorLevel, chatModeratorPower } from "@/shared/models/enums/chat-moderator-level.enum";

/** Punishes a user for N hours (blocks login via the existing punishment flow) and drops them if online. */
export default class BanCommand implements ICommand {
    name = "ban";
    description = "Банит игрока на N часов (причина не обязательна). Использование: /ban <ник> <часы> [причина].";
    permissionLevel: ChatModeratorLevel = ChatModeratorLevel.ADMINISTRATOR;
    usage = "<ник> <часы> [причина]";
    example = "/ban Игрок 24 использование макросов";

    async execute(context: CommandContext, args: string[]): Promise<void> {
        const hours = parseFloat(args[1]);
        if (args.length < 2 || isNaN(hours) || hours <= 0) {
            context.reply("Использование: /ban <ник> <часы> [причина].");
            return;
        }
        const reason = args.slice(2).join(" ").trim() || null;

        const online = context.server.findClientByUsername(args[0]);
        const target = online?.user ?? (await context.server.userService.findUserByUsername(args[0]));
        if (!target) {
            context.reply(`Игрок "${args[0]}" не найден.`);
            return;
        }
        if (target.id === context.executor.user!.id) {
            context.reply("Себя забанить нельзя.");
            return;
        }
        // Hierarchy guard: only someone with strictly LESS power can be banned.
        if (chatModeratorPower(target.chatModeratorLevel) >= chatModeratorPower(context.executor.user!.chatModeratorLevel)) {
            context.reply(`Нельзя забанить ${target.username}: у него роль не ниже вашей.`);
            return;
        }

        try {
            const punished = await context.server.userService.punishUser(target.username, hours * 60 * 60 * 1000, reason);
            online?.closeConnection();
            context.reply(`${punished.username} забанен на ${hours} ч${reason ? ` — причина: ${reason}` : ""}.`);
        } catch (error: any) {
            context.reply(`Ошибка: ${error.message}`);
        }
    }
}
