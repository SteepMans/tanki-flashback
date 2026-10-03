import { CommandContext, ICommand } from "@/features/chat/commands/command.types";
import { GarageWorkflow } from "@/features/garage/garage.workflow";
import { ChatModeratorLevel } from "@/shared/models/enums/chat-moderator-level.enum";

/** Removes a specific item (hull/turret/paint/supply) from a user. If it was equipped, falls back to
 *  another owned item (re-adding the account default if nothing else is left). */
export default class RemoveItemCommand implements ICommand {
    name = "removeitem";
    description = "Убирает у игрока предмет: корпус, пушку, краску или припас. Использование: /removeitem <ник> <id предмета>.";
    permissionLevel: ChatModeratorLevel = ChatModeratorLevel.ADMINISTRATOR;
    usage = "<ник> <id предмета>";
    example = "/removeitem Игрок railgun";

    async execute(context: CommandContext, args: string[]): Promise<void> {
        if (args.length < 2) {
            context.reply("Использование: /removeitem <ник> <id предмета>.");
            return;
        }
        const online = context.server.findClientByUsername(args[0]);
        const user = online?.user ?? (await context.server.userService.findUserByUsername(args[0]));
        if (!user) {
            context.reply(`Игрок "${args[0]}" не найден.`);
            return;
        }
        const itemId = args[1].toLowerCase();

        let removed: string | null = null;
        if (user.hulls.has(itemId)) {
            user.hulls.delete(itemId);
            if (user.equippedHull === itemId) {
                const fallback = [...user.hulls.keys()][0];
                if (!fallback) user.hulls.set("wasp", 0);
                user.equippedHull = fallback ?? "wasp";
            }
            removed = "hull";
        } else if (user.turrets.has(itemId)) {
            user.turrets.delete(itemId);
            if (user.equippedTurret === itemId) {
                const fallback = [...user.turrets.keys()][0];
                if (!fallback) user.turrets.set("smoky", 0);
                user.equippedTurret = fallback ?? "smoky";
            }
            removed = "turret";
        } else if (user.paints.includes(itemId)) {
            user.paints = user.paints.filter((p) => p !== itemId);
            if (user.equippedPaint === itemId) {
                const fallback = user.paints[0];
                if (!fallback) user.paints.push("holiday");
                user.equippedPaint = fallback ?? "holiday";
            }
            removed = "pintura";
        } else if ((user.supplies.get(itemId) ?? 0) > 0) {
            user.supplies.set(itemId, 0);
            removed = "suprimento (zerado)";
        }

        if (!removed) {
            context.reply(`У игрока ${user.username} нет предмета "${itemId}".`);
            return;
        }
        await user.save();
        if (online) GarageWorkflow.reloadGarage(online, context.server);
        context.reply(`Предмет "${itemId}" (${removed}) убран у игрока ${user.username}.`);
    }
}
