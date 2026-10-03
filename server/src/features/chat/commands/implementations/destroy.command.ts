import { CommandContext, ICommand } from "@/features/chat/commands/command.types";
import { ChatModeratorLevel } from "@/shared/models/enums/chat-moderator-level.enum";

/** Destroys a tank in the current battle — your own by default, or another player's when a nick is given. */
export default class DestroyTankCommand implements ICommand {
    name = "destroy";
    description = "Уничтожает танк игрока (без аргумента — ваш). Использование: /destroy [ник].";
    permissionLevel = ChatModeratorLevel.MODERATOR;
    usage = "[ник]";
    example = "/destroy Игрок";

    async execute(context: CommandContext, args: string[]): Promise<void> {
        const client = context.executor;
        const { server } = context;
        if (!client.user || !client.currentBattle) {
            context.reply("Нужно быть в битве.");
            return;
        }

        let target = client;
        if (args.length >= 1) {
            const found = server.findClientByUsername(args[0]);
            if (!found || found.currentBattle?.battleId !== client.currentBattle.battleId) {
                context.reply(`Игрока "${args[0]}" нет в этой битве.`);
                return;
            }
            target = found;
        }

        const destroyed = server.battleService.forceDestroyTank(target);
        context.reply(
            destroyed
                ? `${target.user?.username}'s tank was destroyed.`
                : `Не удалось уничтожить: у игрока ${target.user?.username} нет танка на поле.`
        );
    }
}
