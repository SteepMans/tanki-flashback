import { LobbyService } from "@/features/lobby/lobby.service";
import { UserDocument } from "@/shared/models/user.model";
import { UserService } from "@/shared/services/user.service";
import logger from "@/utils/logger";
import { IsNull, LessThan, Not } from "typeorm";
import ChatMessage from "./chat.model";

export interface PopulatedChatMessage {
    sourceUser: UserDocument | null;
    targetUser: UserDocument | null;
    message: string;
    isSystemMessage: boolean;
    isWarning: boolean;
}

export interface ClearAllMessagesResult {
    deletedCount: number;
    /** Distinct senders whose messages were removed — the client can only clear one sender's messages
     *  at a time (see RemoveUserChatMessagesPacket), so the caller broadcasts one packet per username. */
    usernames: string[];
}

// Maximum number of messages kept in the persisted history (matches the config's `chatHistoryLimit`,
// which limits the LOAD). Once past that, the oldest overflow is deleted on every new message.
const CHAT_HISTORY_LIMIT = 70;

export class ChatService {
    private userService: UserService;

    constructor(userService: UserService) {
        this.userService = userService;
    }

    public async getChatHistory(limit: number): Promise<PopulatedChatMessage[]> {
        try {
            // Отправитель и получатель подтягиваются связью — тем же одним запросом, что раньше
            // делал populate.
            const messages = await ChatMessage.find({
                order: { timestamp: "DESC" },
                take: limit,
                relations: { sourceUser: true, targetUser: true },
            });

            return messages.reverse() as unknown as PopulatedChatMessage[];
        } catch (error) {
            logger.error("Failed to get chat history", { error });
            return [];
        }
    }

    private async _parseBattleLinks(message: string, lobbyService: LobbyService): Promise<string> {
        const regex = /#\/battle\/([a-f0-9]+)/gi;
        const matches = Array.from(message.matchAll(regex));
        let processedMessage = message;

        for (const match of matches) {
            const fullPattern = match[0];
            const battleId = match[1];

            const battle = lobbyService.getBattleById(battleId);

            if (battle) {
                const battleName = battle.settings.name;
                const replacement = `#battle|${battleName}|${battleId}`;
                processedMessage = processedMessage.replace(fullPattern, replacement);
            }
        }

        return processedMessage;
    }

    public async postMessage(sourceUser: UserDocument, targetNickname: string | null, message: string, lobbyService: LobbyService): Promise<PopulatedChatMessage> {
        let targetUser: UserDocument | null = null;
        if (targetNickname) {
            targetUser = await this.userService.findUserByUsername(targetNickname);
        }

        const processedMessage = await this._parseBattleLinks(message, lobbyService);

        const chatMessage = ChatMessage.create({
            sourceUserId: sourceUser.id,
            targetUserId: targetUser ? targetUser.id : null,
            message: processedMessage,
        });

        await chatMessage.save();
        await this._trimHistory();

        sourceUser.lastMessageTimestamp = new Date();
        await sourceUser.save();

        return {
            sourceUser,
            targetUser,
            message: processedMessage,
            isSystemMessage: false,
            isWarning: false,
        };
    }

    /** Keeps only the `CHAT_HISTORY_LIMIT` most recent messages; deletes the oldest overflow. */
    private async _trimHistory(): Promise<void> {
        try {
            const overflow = await ChatMessage.find({
                order: { timestamp: "DESC" },
                skip: CHAT_HISTORY_LIMIT,
                take: 1,
                select: { timestamp: true },
            });
            if (overflow.length > 0) {
                await ChatMessage.delete({ timestamp: LessThan(overflow[0].timestamp) });
            }
        } catch (error) {
            logger.error("Failed to trim chat history", { error });
        }
    }

    /** Removes ALL messages sent by a user from history. Returns how many were deleted. */
    public async removeUserMessages(user: UserDocument): Promise<number> {
        try {
            const res = await ChatMessage.delete({ sourceUserId: user.id });
            return res.affected ?? 0;
        } catch (error) {
            logger.error(`Failed to remove chat messages of ${user.username}`, { error });
            return 0;
        }
    }

    /**
     * Wipes the ENTIRE chat history (every message from every user). Also resolves the distinct list of
     * senders that were removed, since the client-side clear packet only knows how to clear one sender's
     * messages at a time — the caller (e.g. /clearmsgs) broadcasts a RemoveUserChatMessagesPacket per
     * username returned here to actually blank every client's chat window.
     */
    public async removeAllMessages(): Promise<ClearAllMessagesResult> {
        try {
            const messages = await ChatMessage.find({
                where: { sourceUserId: Not(IsNull()) },
                relations: { sourceUser: true },
            });

            const usernames = Array.from(
                new Set(messages.map((m) => m.sourceUser?.username).filter((u): u is string => !!u))
            );

            // Пустого условия удаления TypeORM не принимает, поэтому чистим построителем запроса.
            const res = await ChatMessage.createQueryBuilder().delete().execute();
            return { deletedCount: res.affected ?? 0, usernames };
        } catch (error) {
            logger.error("Failed to clear the entire chat history", { error });
            return { deletedCount: 0, usernames: [] };
        }
    }
}
