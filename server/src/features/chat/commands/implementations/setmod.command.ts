import { CommandContext, ICommand } from "@/features/chat/commands/command.types";
import { GarageWorkflow } from "@/features/garage/garage.workflow";
import { ChatModeratorLevel } from "@/shared/models/enums/chat-moderator-level.enum";

/** Changes the modification (m0-m3) of an OWNED hull/turret. If it's equipped and the target is in a
 *  battle, the change applies on the next respawn/garage pass. */
export default class SetModCommand implements ICommand {
    name = "setmod";
    description = "Меняет модификацию имеющегося предмета: корпуса или пушки. Использование: /setmod <ник> <id предмета> <модификация>.";
    permissionLevel: ChatModeratorLevel = ChatModeratorLevel.ADMINISTRATOR;
    usage = "<ник> <id предмета> [0/1/2/3]";
    example = "/setmod Игрок railgun 3";

    async execute(context: CommandContext, args: string[]): Promise<void> {
        const mod = parseInt(args[2], 10);
        if (args.length < 3 || isNaN(mod) || mod < 0 || mod > 3) {
            context.reply("Использование: /setmod <ник> <id предмета> <модификация 0-3>.");
            return;
        }
        const online = context.server.findClientByUsername(args[0]);
        const user = online?.user ?? (await context.server.userService.findUserByUsername(args[0]));
        if (!user) {
            context.reply(`Игрок "${args[0]}" не найден.`);
            return;
        }
        const itemId = args[1].toLowerCase();

        if (user.hulls.has(itemId)) user.hulls.set(itemId, mod);
        else if (user.turrets.has(itemId)) user.turrets.set(itemId, mod);
        else {
            context.reply(`У игрока ${user.username} нет "${itemId}" (учитываются только купленные корпуса и пушки).`);
            return;
        }

        await user.save();
        if (online) GarageWorkflow.reloadGarage(online, context.server);
        context.reply(`Предмет "${itemId}" игрока ${user.username} переведён в м${mod}.`);
    }
}
