import { CommandContext, ICommand } from "@/features/chat/commands/command.types";
import { GarageWorkflow } from "@/features/garage/garage.workflow";
import { ChatModeratorLevel } from "@/shared/models/enums/chat-moderator-level.enum";
import { UserDocument } from "@/shared/models/user.model";

/** Resets a user's garage to the new-account loadout (wasp/smoky/holiday). Rank/crystals untouched. */
export function resetGarageInventory(user: UserDocument): void {
    user.hulls = new Map([["wasp", 0]]);
    user.turrets = new Map([["smoky", 0]]);
    user.paints = ["green", "holiday"];
    user.equippedHull = "wasp";
    user.equippedTurret = "smoky";
    user.equippedPaint = "holiday";
}

export default class ResetGarageCommand implements ICommand {
    name = "resetgarage";
    description = "Сбрасывает гараж игрока к набору нового аккаунта. Использование: /resetgarage <ник>.";
    permissionLevel = ChatModeratorLevel.ADMINISTRATOR;
    usage = "<ник>";
    example = "/resetgarage Игрок";

    async execute(context: CommandContext, args: string[]): Promise<void> {
        if (args.length < 1) {
            context.reply("Использование: /resetgarage <ник>.");
            return;
        }
        const online = context.server.findClientByUsername(args[0]);
        const user = online?.user ?? (await context.server.userService.findUserByUsername(args[0]));
        if (!user) {
            context.reply(`Игрок "${args[0]}" не найден.`);
            return;
        }

        resetGarageInventory(user);
        await user.save();
        if (online) GarageWorkflow.reloadGarage(online, context.server);
        context.reply(`Гараж игрока ${user.username} сброшен к стандартному (wasp, smoky, holiday).`);
    }
}
