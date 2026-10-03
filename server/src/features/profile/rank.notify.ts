import { GameServer } from "@/server/game.server";
import { UserDocument } from "@/shared/models/user.model";
import { SetPlayerRankPacket } from "@/features/battle/battle.packets";
import { UpdateRankPacket } from "@/features/profile/profile.packets";

/**
 * Envia `SetPlayerRank(nick, rank)` para todos os OUTROS clientes online — atualiza VISUALMENTE o rank
 * desse usuário no cache de quem já o carregou (chat, placar, etc.). Quem não tem o usuário em cache
 * ignora; quem relogar já carrega o rank atualizado, então não precisa receber nada.
 */
export function broadcastPlayerRankToOthers(server: GameServer, user: UserDocument): void {
    const packet = new SetPlayerRankPacket({ nickname: user.username, rank: user.rank });
    const owner = server.findClientByUsername(user.username);
    // Бота знают только те, кто сейчас с ним в бою (ник приходит им в UserConnect). Всем остальным
    // SetPlayerRank по незнакомому нику — это #1009 на ровном месте: клиент лезет в свой кэш игроков,
    // не находит запись и падает прямо в обработчике пакета. Ботов на сервере десятки, и повышение
    // звания у них случается постоянно, поэтому рассылку сужаем до их собственного боя.
    const battleId = owner?.isBot ? owner.currentBattle?.battleId : null;
    for (const c of server.getClients()) {
        if (!c.user || c.user.username === user.username) continue;
        if (battleId && c.currentBattle?.battleId !== battleId) continue;
        c.sendPacket(packet);
    }
}

/**
 * Recalcula o rank do usuário; se MUDOU: persiste, notifica o próprio (UpdateRank) e atualiza o rank
 * visual para todos os demais online (SetPlayerRank). Retorna true se o rank mudou. Usado no caminho de
 * XP (batalha/garagem) para que um rank-up reflita ao vivo para todo mundo.
 */
export async function applyRankUp(server: GameServer, user: UserDocument): Promise<boolean> {
    if (!server.rankService.updateRank(user)) return false;
    await user.save();

    const ownClient = server.findClientByUsername(user.username);
    if (ownClient) {
        const rankInfo = server.rankService.getRankById(user.rank);
        ownClient.sendPacket(new UpdateRankPacket({
            rank: user.rank,
            score: user.experience,
            currentRankScore: rankInfo?.minScore ?? 0,
            nextRankScore: user.nextRankScore,
            reward: 0,
        }));
    }
    broadcastPlayerRankToOthers(server, user);
    return true;
}
