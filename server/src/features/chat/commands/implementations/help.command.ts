import { effectiveModeratorLevel } from "@/features/chat/commands/command.service";
import { CommandContext, ICommand } from "@/features/chat/commands/command.types";
import {
    ChatModeratorLevel,
    chatModeratorLevelName,
    hasModeratorPower,
} from "@/shared/models/enums/chat-moderator-level.enum";

/** Cargo groups shown by /help, from highest to lowest. */
const GROUP_ORDER: ChatModeratorLevel[] = [
    ChatModeratorLevel.COMMUNITY_MANAGER,
    ChatModeratorLevel.ADMINISTRATOR,
    ChatModeratorLevel.MODERATOR,
    ChatModeratorLevel.CANDIDATE,
    ChatModeratorLevel.NONE,
];

const GROUP_LABEL: Record<ChatModeratorLevel, string> = {
    [ChatModeratorLevel.COMMUNITY_MANAGER]: "Комьюнити-менеджер",
    [ChatModeratorLevel.ADMINISTRATOR]: "Администратор",
    [ChatModeratorLevel.MODERATOR]: "Модератор",
    [ChatModeratorLevel.CANDIDATE]: "Кандидат",
    [ChatModeratorLevel.HELPERR]: "Кандидат",
    [ChatModeratorLevel.NONE]: "Для всех",
};

/** Запись команды лежит в `usage`, поэтому хвост «Использование: …» из описания убираем, чтобы не дублировать. */
function whatItDoes(description: string): string {
    return description.replace(/\s*(Использование|Usage):.*$/i, "").trim();
}

/** Строка полного списка, например «/role <ник> [none/candidate/...] — Назначает игроку роль». */
function listLine(cmd: ICommand): string {
    const params = cmd.usage ? " " + cmd.usage : "";
    return `/${cmd.name}${params} — ${whatItDoes(cmd.description)}`;
}

/**
 * /help — COMPACT list: one line per role group with just the command names the caller can use.
 * /help * — the FULL wall: every accessible command grouped by role with parameters + description.
 * /help <command> — the detail (parameters with hardcoded options as [a/b/c], description, example, role).
 */
export default class HelpCommand implements ICommand {
    name = "help";
    description = "Показывает доступные команды (* — полный список с описаниями). Использование: /help [команда/*].";
    permissionLevel: ChatModeratorLevel = ChatModeratorLevel.NONE;
    usage = "[команда/*]";
    example = "/help role";

    async execute(context: CommandContext, args: string[]): Promise<void> {
        const level = effectiveModeratorLevel(context.executor);
        const service = context.server.commandService;

        // /help * — the "wall": full list grouped by role with parameters + description.
        if (args[0] === "*") {
            const accessible = service.getCommands().filter((c) => hasModeratorPower(level, c.permissionLevel));
            context.reply("Доступные команды. Подробности: /help <команда>");
            for (const group of GROUP_ORDER) {
                const inGroup = accessible
                    .filter((c) => c.permissionLevel === group)
                    .sort((a, b) => a.name.localeCompare(b.name));
                if (inGroup.length === 0) continue;
                context.reply(`${GROUP_LABEL[group]}:`);
                for (const cmd of inGroup) context.reply(listLine(cmd));
            }
            return;
        }

        // /help <command> — detail of a specific command.
        if (args.length >= 1) {
            const name = args[0].replace(/^\//, "").toLowerCase();
            const cmd = service.getCommand(name);
            if (!cmd) {
                context.reply(`Команда "/${name}" не найдена. Список — /help.`);
                return;
            }
            if (!hasModeratorPower(level, cmd.permissionLevel)) {
                context.reply(`У вас нет прав на /${cmd.name}.`);
                return;
            }
            context.reply(`/${cmd.name}${cmd.usage ? " " + cmd.usage : ""}`);
            context.reply(whatItDoes(cmd.description));
            if (cmd.example) {
                context.reply(`Пример: ${cmd.example}`);
            }
            context.reply(
                cmd.permissionLevel === ChatModeratorLevel.NONE
                    ? "Access: all players."
                    : `Минимальная роль: ${chatModeratorLevelName(cmd.permissionLevel)}.`
            );
            return;
        }

        // /help — COMPACT list: one line per role, just the names (detail lives in /help <command>).
        const accessible = service.getCommands().filter((c) => hasModeratorPower(level, c.permissionLevel));

        context.reply("Команды. Подробности и пример: /help <команда>");
        for (const group of GROUP_ORDER) {
            const names = accessible
                .filter((c) => c.permissionLevel === group)
                .map((c) => c.name)
                .sort()
                .join(", ");
            if (!names) continue;
            context.reply(`${GROUP_LABEL[group]}: ${names}`);
        }
    }
}
