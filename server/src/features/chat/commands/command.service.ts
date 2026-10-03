import { GameClient } from "@/server/game.client";
import { ChatModeratorLevel, chatModeratorPower, hasModeratorPower } from "@/shared/models/enums/chat-moderator-level.enum";
import logger from "@/utils/logger";
import fs from "fs";
import path from "path";
import { CommandContext, ICommand } from "./command.types";

/**
 * Loopback addresses, in the shapes Node reports them on a dual-stack socket:
 * "127.0.0.1", "::1" and the IPv4-mapped "::ffff:127.0.0.1".
 */
function isLoopbackAddress(address: string): boolean {
    const normalized = address.replace(/^::ffff:/i, "");
    return normalized === "127.0.0.1" || normalized === "::1" || normalized.startsWith("127.");
}

/**
 * Effective role of the command executor. A client connected over loopback is playing on the same
 * machine that runs the server — it already has full control of the process and the database — so it
 * is treated as Community Manager. That makes every command usable on a local dev stand without
 * bootstrapping an account first (`npm run set-role`), while remote players keep their real role.
 *
 * Set ALLOW_LOCAL_ADMIN=false to turn this off (e.g. when exposing a dev instance through a tunnel,
 * where the peer address can end up being loopback).
 */
export function effectiveModeratorLevel(executor: GameClient): ChatModeratorLevel {
    const stored = executor.user?.chatModeratorLevel ?? ChatModeratorLevel.NONE;

    if (process.env.ALLOW_LOCAL_ADMIN === "false") return stored;
    if (!isLoopbackAddress(executor.getRemoteAddress())) return stored;

    return chatModeratorPower(stored) >= chatModeratorPower(ChatModeratorLevel.COMMUNITY_MANAGER)
        ? stored
        : ChatModeratorLevel.COMMUNITY_MANAGER;
}

export class CommandService {
    private commands = new Map<string, ICommand>();

    public constructor() {
        this.loadCommands();
    }

    private loadCommands(): void {
        const commandDir = path.join(__dirname, "implementations");
        const files = fs.readdirSync(commandDir).filter((file) => file.endsWith(".ts") || file.endsWith(".js"));

        for (const file of files) {
            try {
                const module = require(path.join(commandDir, file));
                const CommandClass = module.default;

                if (CommandClass && typeof CommandClass === "function") {
                    const commandInstance = new CommandClass();
                    if (commandInstance.name) {
                        this.register(commandInstance);
                    }
                }
            } catch (error: any) {
                logger.error(`Failed to load command from ${file}`, { error: error.message });
            }
        }
    }

    private register(command: ICommand): void {
        this.commands.set(command.name.toLowerCase(), command);
        logger.info(`Command registered: /${command.name}`);
    }

    /** All registered commands (used by /help). */
    public getCommands(): ICommand[] {
        return Array.from(this.commands.values());
    }

    /** A single command by name (case-insensitive), or undefined. */
    public getCommand(name: string): ICommand | undefined {
        return this.commands.get(name.toLowerCase());
    }

    public async process(rawMessage: string, context: CommandContext): Promise<void> {
        if (!rawMessage.startsWith("/")) return;

        const parts = rawMessage.slice(1).split(" ");
        const commandName = parts[0].toLowerCase();
        const args = parts.slice(1);

        const command = this.commands.get(commandName);

        if (!command) {
            context.reply(`Команда "${commandName}" не найдена.`);
            return;
        }

        if (!hasModeratorPower(effectiveModeratorLevel(context.executor), command.permissionLevel)) {
            context.reply("У вас нет прав на эту команду.");
            return;
        }

        try {
            await command.execute(context, args);
        } catch (error: any) {
            logger.error(`Error executing command /${commandName}`, { error: error.message, user: context.executor.user?.username });
            context.reply(`Ошибка при выполнении команды: ${error.message}`);
        }
    }
}