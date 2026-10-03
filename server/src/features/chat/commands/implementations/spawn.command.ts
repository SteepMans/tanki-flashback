import { CommandContext, ICommand } from "@/features/chat/commands/command.types";
import { ChatModeratorLevel } from "@/shared/models/enums/chat-moderator-level.enum";

/** Forces the respawn flow for a player stuck dead/waiting (own tank by default). An ACTIVE tank is
 *  refused — use /destroy to blow it up (it respawns on its own). */
export default class SpawnCommand implements ICommand {
    name = "spawn";
    description = "Принудительно возрождает застрявшего игрока (без ника — себя). Использование: /spawn [ник].";
    permissionLevel = ChatModeratorLevel.MODERATOR;
    usage = "[ник]";
    example = "/spawn Игрок";

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
            if (!found?.user || found.currentBattle?.battleId !== client.currentBattle.battleId) {
                context.reply(`Игрока "${args[0]}" нет в этой битве.`);
                return;
            }
            target = found;
        }
        if (target.isSpectator) {
            context.reply(`${target.user?.username} — наблюдатель.`);
            return;
        }
        if (target.battleState === "active") {
            context.reply(`${target.user?.username} уже на поле. Чтобы возродить, используйте /destroy.`);
            return;
        }

        server.battleService.prepareRespawn(target);
        context.reply(`Игрок ${target.user?.username} принудительно возрождён.`);
    }
}
