import { GameServer } from "@/server/game.server";
import { UserDocument } from "@/shared/models/user.model";
import { ItemUtils } from "@/utils/item.utils";
import logger from "@/utils/logger";

export interface FullUserInfo {
    user: UserDocument;
    isOnline: boolean;
    isInBattle: boolean;
}

export class ProfileService {
    public async getFullUserInfo(server: GameServer, username: string): Promise<FullUserInfo | null> {
        const targetClient = server.findClientByUsername(username);

        // Бот живёт ТОЛЬКО в памяти сервера: в базе его нет, и раньше запрос его профиля оставался без
        // ответа. Для клиента это фатально: не получив звание бота, он не достраивает его танк, а потом
        // валится с #1009 на каждом пакете этого танка (движение, поворот башни) — отсюда и экран
        // «Произошла критическая ошибка», и просадка FPS (исключение в кадре стоит дорого). Отвечаем
        // тем же документом, который бот носит в памяти.
        const botUser = targetClient?.isBot ? targetClient.user : null;
        const targetUser = botUser ?? (await server.userService.findUserByUsername(username));
        if (!targetUser) {
            logger.warn(`User info requested for non-existent user: ${username}`);
            return null;
        }

        // Ponto central de "solicitar a info do usuário" (inclui premium): reconcilia LAZY o estado
        // derivado do premium (pintura premium equipada → green quando expira) e persiste se mudou, para
        // que qualquer leitor — inclusive o perfil de OUTRO jogador — veja o banco já corrigido.
        // У бота нет ни премиума, ни базы — сверять нечего.
        if (!botUser) await ItemUtils.reconcilePremiumEquipment(targetUser);

        const isOnline = !!targetClient;
        const isInBattle = isOnline ? server.lobbyService.isUserInBattle(username) : false;

        return {
            user: targetUser,
            isOnline,
            isInBattle,
        };
    }
}