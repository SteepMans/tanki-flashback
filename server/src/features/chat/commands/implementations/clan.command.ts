import { ClanNotifierData } from "@/features/profile/profile.packets";
import { CommandContext, ICommand } from "@/features/chat/commands/command.types";
import { ChatModeratorLevel } from "@/shared/models/enums/chat-moderator-level.enum";

/** Staff clan moderation: inspect a clan, force-remove a member, or disband an abusive clan. */
export default class ClanCommand implements ICommand {
    name = "clan";
    description = "Управление кланами: info <тег>, kick <ник>, disband <тег>, block <тег> [причина], unblock <тег>. Использование: /clan [info/kick/disband/block/unblock] <цель>.";
    permissionLevel: ChatModeratorLevel = ChatModeratorLevel.ADMINISTRATOR;
    usage = "[info/kick/disband/block/unblock] <цель> [причина]";
    example = "/clan block LGC Клан наказан за читы";

    async execute(context: CommandContext, args: string[]): Promise<void> {
        const { server } = context;
        const action = (args[0] ?? "").toLowerCase();
        const target = args[1];
        if (!target || !["info", "kick", "disband", "block", "unblock"].includes(action)) {
            context.reply("Использование: /clan [info/kick/disband/block/unblock] <цель> (для kick — ник, для остальных — тег клана).");
            return;
        }

        if (action === "block" || action === "unblock") {
            const reason = args.slice(2).join(" ");
            const clan = await server.clanService.staffSetClanBlocked(target, action === "block", reason);
            if (!clan) {
                context.reply(`Клан "${target}" не найден.`);
                return;
            }
            context.reply(action === "block"
                ? `Clan [${clan.tag}] blocked${reason ? ` (reason: ${reason})` : ""}.`
                : `Clan [${clan.tag}] unblocked.`);
            return;
        }

        if (action === "info") {
            const clan = await server.clanService.getClanByTag(target);
            if (!clan) {
                context.reply(`Клан "${target}" не найден.`);
                return;
            }
            const leader = await server.clanService.getLeaderUsername(clan);
            const members = await server.clanService.getMembers(clan);
            context.reply(`=== [${clan.tag}] ${clan.name} ===`);
            context.reply(`Лидер: ${leader ?? "?"} | Участников: ${members.length} | Рейтинг: ${clan.rating ?? 0} | Набор: ${clan.recruiting ? "открыт" : "закрыт"}`);
            context.reply(`Участники: ${members.map((m) => m.username).join(", ")}`);
            return;
        }

        if (action === "kick") {
            const result = await server.clanService.staffRemoveMember(target);
            if (result === "leader") {
                context.reply(`${target} — лидер клана. Используйте /clan disband <тег> или передайте лидерство.`);
                return;
            }
            if (!result) {
                context.reply(`Игрок "${target}" не состоит в клане.`);
                return;
            }
            const online = server.findClientByUsername(result.target.username);
            if (online?.user) {
                online.user.clanId = null;
                online.sendPacket(new ClanNotifierData(online.user.username, null));
            }
            context.reply(`${result.target.username} исключён из клана [${result.clan.tag}].`);
            return;
        }

        // disband
        const result = await server.clanService.staffDisbandClan(target);
        if (!result) {
            context.reply(`Клан "${target}" не найден.`);
            return;
        }
        for (const member of result.members) {
            const online = server.findClientByUsername(member.username);
            if (online?.user) {
                online.user.clanId = null;
                online.sendPacket(new ClanNotifierData(online.user.username, null));
            }
        }
        context.reply(`Клан [${result.tag}] распущен, освобождено участников: ${result.members.length}.`);
    }
}
