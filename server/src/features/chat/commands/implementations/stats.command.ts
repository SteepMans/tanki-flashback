import { CommandContext, ICommand } from "@/features/chat/commands/command.types";
import { ChatModeratorLevel } from "@/shared/models/enums/chat-moderator-level.enum";

const MODES = ["dm", "tdm", "ctf", "cp", "as"] as const;
const TYPES = ["normal", "xpbp", "parkour"] as const;

/** Debug: dumps a user's persisted long-term stats (see StatsService). `/stats` for self, `/stats <username>`
 *  for someone else. Read-only; shows the last flushed values (NOT the current in-progress round). */
export default class StatsCommand implements ICommand {
    name: string = "stats";
        description: string = "Shows long-term statistics. Usage: /stats [username] (empty = you).";
    permissionLevel: ChatModeratorLevel = ChatModeratorLevel.NONE;
    usage = "[ник]";
    example = "/stats Игрок";

    async execute(context: CommandContext, args: string[]): Promise<void> {
        const target = args.length >= 1
            ? await context.server.userService.findUserByUsername(args[0])
            : context.executor.user;
        if (!target) {
            context.reply(`Игрок "${args[0]}" не найден.`);
            return;
        }

        const st: any = target.stats;
        const counters: Map<string, number> = st?.counters ?? new Map();
        const c = (key: string): number => counters.get(key) ?? 0;
        const s = (field: string): number => st?.[field] ?? 0;
        const ratio = (a: number, b: number): string => (b > 0 ? (a / b).toFixed(2) : a.toFixed(2));

        const kills = c("kills");
        const deaths = c("deaths");
        const wins = c("wins");
        const losses = c("losses");

        context.reply(`=== Статистика ${target.username} (без текущего раунда) ===`);
        context.reply(
            `Битв: ${c("battles_played")} | Побед: ${wins} | Поражений: ${losses} | П/П: ${ratio(wins, losses)}`
        );
        context.reply(
            `Убийств: ${kills} | Смертей: ${deaths} | У/С: ${ratio(kills, deaths)} | Самоуничтожений: ${c("suicides")}`
        );
        context.reply(
            `Опыт: ${c("xp_earned")} | Кристаллы: ${c("crystals_earned")} | Урон нанесён/получен: ${c("damage_dealt")}/${c("damage_taken")}`
        );
        context.reply(
            `Припасов использовано: ${c("supplies_used")} (мин: ${c("mines_used")}) | Подобрано: ${c("supplies_picked")}`
        );
        context.reply(
            `Рекорды за битву — убийств: ${s("maxKillsInBattle")}, смертей: ${s("maxDeathsInBattle")}, кристаллов: ${s("maxCrystalsInBattle")}, опыта: ${s("maxXpInBattle")}, урона: ${s("maxDamageInBattle")}`
        );
        context.reply(
            `Серии — побед: ${s("currentWinStreak")} (рекорд ${s("maxWinStreak")}) | поражений: ${s("currentLossStreak")} (рекорд ${s("maxLossStreak")})`
        );

        // Per-mode breakdown (only modes actually played), each split by type when present.
        const perMode: string[] = [];
        for (const m of MODES) {
            const played = c(`battles_played:${m}`);
            if (played <= 0) continue;
            const typeParts = TYPES.map((t) => {
                const n = c(`battles_played:${m}:${t}`);
                return n > 0 ? `${t} ${n}` : null;
            }).filter(Boolean);
            perMode.push(
                `  ${m.toUpperCase()}: ${played}p V${c(`wins:${m}`)}/D${c(`losses:${m}`)} K${c(`kills:${m}`)}/D${c(`deaths:${m}`)}` +
                    (typeParts.length ? ` [${typeParts.join(", ")}]` : "")
            );
        }
        if (perMode.length) {
            context.reply("По режимам (битв, П/П, У/С):");
            for (const line of perMode) context.reply(line);
        }
    }
}
