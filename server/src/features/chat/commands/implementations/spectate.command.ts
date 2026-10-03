import { UnloadSpaceBattlePacket } from "@/features/battle/battle-init.packets";
import { BattleWorkflow } from "@/features/battle/battle.workflow";
import { CommandContext, ICommand } from "@/features/chat/commands/command.types";
import { ChatModeratorLevel, hasModeratorPower } from "@/shared/models/enums/chat-moderator-level.enum";

/** Switches the caller from PLAYER to SPECTATOR of the same battle (live moderation): exits like a
 *  voluntary leave, then re-enters through the spectator flow — the same packet sequence as leaving and
 *  clicking "spectate" manually, minus the lobby round-trip. */
export default class SpectateCommand implements ICommand {
    name = "spectate";
    description = "Делает вас наблюдателем текущей битвы. Использование: /spectate.";
    permissionLevel = ChatModeratorLevel.CANDIDATE;

    async execute(context: CommandContext, _args: string[]): Promise<void> {
        const client = context.executor;
        const { server } = context;
        const battle = client.currentBattle;
        if (!client.user || !battle) {
            context.reply("Нужно быть в битве.");
            return;
        }
        if (!hasModeratorPower(client.user.chatModeratorLevel, ChatModeratorLevel.CANDIDATE)) {
            context.reply("Наблюдателем может стать только кандидат в модераторы и выше.");
            return;
        }
        if (client.isSpectator) {
            context.reply("Вы уже наблюдатель.");
            return;
        }

        // Leave as a player (voluntary-exit sequence)...
        server.battleService.announceTankRemoval(client.user, battle, client.battlePosition);
        await server.battleService.finalizeBattleExit(client.user, battle, client.friendsCache, false);
        client.sendPacket(new UnloadSpaceBattlePacket());
        client.currentBattle = null;
        client.battleState = "suicide";
        client.stopTimeChecker();

        // ...and re-enter the same battle as a spectator (the reconnect-style entry skips the lobby
        // teardown packets, which this client never loaded — see reconnect-battle-flow).
        try {
            const rejoined = server.battleService.addSpectatorToBattle(client.user, battle.battleId);
            client.currentBattle = rejoined;
            client.isSpectator = true;
            server.battleService.broadcastSpectatorListUpdate(rejoined, client);
            await BattleWorkflow.enterBattle(client, server, rejoined, true);
            context.reply("Вы стали наблюдателем. Чтобы вернуться, используйте /finish или выйдите из битвы.");
        } catch (error: any) {
            context.reply(`Не удалось стать наблюдателем: ${error.message}`);
        }
    }
}
