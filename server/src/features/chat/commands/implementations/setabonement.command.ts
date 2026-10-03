import { CommandContext, ICommand } from "@/features/chat/commands/command.types";
import { ChatModeratorLevel } from "@/shared/models/enums/chat-moderator-level.enum";
import { isCrystalAbonementActive } from "@/shared/models/passes";

/**
 * Ativa (ou desativa) o abonement de Dobro de Cristais na PRÓPRIA conta — para testar a UI (card no
 * depósito + indicador de dobro no shop). Seta `crystalAbonementExpiresAt`. O efeito aparece ao REABRIR
 * a garagem/loja (não há pacote incremental para isso). Dobra só crystals de DOAÇÃO, não ganhos em jogo.
 */
export default class SetAbonementCommand implements ICommand {
    name = "setabonement";
    description = "Включает удвоение кристаллов на N часов (по умолчанию 24, 0 — отключить). Использование: /setabonement [часы].";
    permissionLevel: ChatModeratorLevel = ChatModeratorLevel.ADMINISTRATOR;
    usage = "[часы]";
    example = "/setabonement 24";

    async execute(context: CommandContext, args: string[]): Promise<void> {
        const user = context.executor.user;
        if (!user) return;

        const hours = args[0] !== undefined ? parseInt(args[0], 10) : 24;
        if (isNaN(hours)) {
            context.reply("Использование: /setabonement [часы] (по умолчанию 24, 0 — отключить).");
            return;
        }

        try {
            if (hours <= 0) {
                user.crystalAbonementExpiresAt = null;
                await user.save();
                context.reply("Удвоение кристаллов выключено. Откройте гараж заново, чтобы обновить.");
                return;
            }
            user.crystalAbonementExpiresAt = new Date(Date.now() + hours * 60 * 60 * 1000);
            await user.save();
            context.reply(`Удвоение кристаллов включено на ${hours} ч (активно: ${isCrystalAbonementActive(user)}). Откройте гараж заново, чтобы обновить.`);
        } catch (error: any) {
            context.reply(`Ошибка: ${error.message}`);
        }
    }
}
