import { CommandContext, ICommand } from "@/features/chat/commands/command.types";
import { itemBlueprints } from "@/features/garage/garage.data";
import { GarageWorkflow } from "@/features/garage/garage.workflow";
import { ChatModeratorLevel } from "@/shared/models/enums/chat-moderator-level.enum";

/** Grants a specific garage item to a user — hulls/turrets always at their FIRST modification (m0);
 *  use /setmod afterwards to change it. */
export default class GiveItemCommand implements ICommand {
    name = "giveitem";
    description = "Выдаёт игроку предмет (корпус или пушку в м0 — модификация через /setmod — либо краску). Использование: /giveitem <ник> <id предмета>.";
    permissionLevel = ChatModeratorLevel.ADMINISTRATOR;
    usage = "<ник> <id предмета>";
    example = "/giveitem Игрок railgun";

    async execute(context: CommandContext, args: string[]): Promise<void> {
        if (args.length < 2) {
            context.reply("Использование: /giveitem <ник> <id предмета>.");
            return;
        }
        const online = context.server.findClientByUsername(args[0]);
        const user = online?.user ?? (await context.server.userService.findUserByUsername(args[0]));
        if (!user) {
            context.reply(`Игрок "${args[0]}" не найден.`);
            return;
        }
        const itemId = args[1].toLowerCase();

        const hull = itemBlueprints.hulls.find((h) => h.id === itemId);
        const turret = itemBlueprints.turrets.find((t) => t.id === itemId);
        const paint = itemBlueprints.paints.find((p) => p.id === itemId);

        if (hull) {
            user.hulls.set(itemId, 0);
            await user.save();
            context.reply(`Игрок ${user.username} получил корпус "${itemId}" м0 (модификация меняется через /setmod).`);
        } else if (turret) {
            user.turrets.set(itemId, 0);
            await user.save();
            context.reply(`Игрок ${user.username} получил пушку "${itemId}" м0 (модификация меняется через /setmod).`);
        } else if (paint) {
            if (!user.paints.includes(itemId)) user.paints.push(itemId);
            await user.save();
            context.reply(`Игрок ${user.username} получил краску "${itemId}".`);
        } else {
            context.reply(`Предмета "${itemId}" не существует (корпуса, пушки и краски из гаража).`);
            return;
        }

        if (online) GarageWorkflow.reloadGarage(online, context.server);
    }
}
