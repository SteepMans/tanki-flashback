import User, { UserDocument } from "@/shared/models/user.model";
import { UserService } from "@/shared/services/user.service";
import logger from "@/utils/logger";
import { In } from "typeorm";
import { IFriendsListProps } from "./friends.types";

/**
 * Списки друзей и заявок — это списки идентификаторов внутри записи пользователя (JSON-колонки).
 * Раньше там лежали ObjectId, поэтому сравнения шли через `.equals()`; теперь это обычные строки,
 * и сравнение обычное.
 */
export class FriendsService {
    private userService: UserService;

    constructor(userService: UserService) {
        this.userService = userService;
    }

    public async sendFriendRequest(senderUser: UserDocument, targetNickname: string): Promise<UserDocument> {
        const targetUser = await this.userService.findUserByUsername(targetNickname);

        if (!targetUser) {
            throw new Error(`User "${targetNickname}" not found.`);
        }

        const senderId = senderUser.id;
        const targetId = targetUser.id;

        if (senderId === targetId) {
            throw new Error("Себя в друзья добавить нельзя.");
        }

        if (senderUser.friends.includes(targetId)) {
            throw new Error("ALREADY_FRIENDS");
        }

        if (senderUser.friendRequestsSent.includes(targetId)) {
            throw new Error("REQUEST_ALREADY_SENT");
        }

        if (senderUser.friendRequestsReceived.includes(targetId)) {
            throw new Error("INCOMING_REQUEST_EXISTS");
        }

        senderUser.friendRequestsSent.push(targetId);
        targetUser.friendRequestsReceived.push(senderId);
        targetUser.newFriendRequests.push(senderId);

        await senderUser.save();
        await targetUser.save();

        logger.info(`Friend request sent from ${senderUser.username} to ${targetUser.username}`);
        return targetUser;
    }

    public async cancelFriendRequest(senderUser: UserDocument, targetNickname: string): Promise<UserDocument> {
        const targetUser = await this.userService.findUserByUsername(targetNickname);
        if (!targetUser) {
            throw new Error(`User "${targetNickname}" not found.`);
        }

        const senderId = senderUser.id;
        const targetId = targetUser.id;

        if (!senderUser.friendRequestsSent.includes(targetId)) {
            throw new Error(`You have not sent a friend request to "${targetNickname}".`);
        }

        senderUser.friendRequestsSent = senderUser.friendRequestsSent.filter((id) => id !== targetId);
        targetUser.friendRequestsReceived = targetUser.friendRequestsReceived.filter((id) => id !== senderId);
        targetUser.newFriendRequests = targetUser.newFriendRequests.filter((id) => id !== senderId);

        await senderUser.save();
        await targetUser.save();

        logger.info(`User ${senderUser.username} canceled friend request to ${targetUser.username}.`);
        return targetUser;
    }

    public async declineAllFriendRequests(user: UserDocument): Promise<UserDocument[]> {
        const senderIds = user.friendRequestsReceived;
        if (senderIds.length === 0) {
            return [];
        }

        const receivedRequests = await User.findBy({ id: In(senderIds) });

        user.friendRequestsReceived = [];
        user.newFriendRequests = [];
        await user.save();

        // Убираем себя из исходящих заявок у каждого отправителя — раньше это делал один $pull.
        for (const sender of receivedRequests) {
            sender.friendRequestsSent = sender.friendRequestsSent.filter((id) => id !== user.id);
            await sender.save();
        }

        logger.info(`User ${user.username} declined all ${receivedRequests.length} friend requests.`);

        return receivedRequests;
    }

    public async declineFriendRequest(user: UserDocument, senderNickname: string): Promise<UserDocument> {
        const senderUser = await this.userService.findUserByUsername(senderNickname);

        if (!senderUser) {
            throw new Error(`User "${senderNickname}" not found.`);
        }

        const userId = user.id;
        const senderId = senderUser.id;

        if (!user.friendRequestsReceived.includes(senderId)) {
            throw new Error(`Nenhum pedido de amizade de "${senderNickname}" para ser recusado.`);
        }

        user.friendRequestsReceived = user.friendRequestsReceived.filter((id) => id !== senderId);
        user.newFriendRequests = user.newFriendRequests.filter((id) => id !== senderId);
        senderUser.friendRequestsSent = senderUser.friendRequestsSent.filter((id) => id !== userId);

        await user.save();
        await senderUser.save();

        logger.info(`User ${user.username} declined friend request from ${senderUser.username}.`);
        return senderUser;
    }

    public async acceptFriendRequest(user: UserDocument, senderNickname: string): Promise<UserDocument> {
        const senderUser = await this.userService.findUserByUsername(senderNickname);

        if (!senderUser) {
            throw new Error(`User "${senderNickname}" not found.`);
        }

        const userId = user.id;
        const senderId = senderUser.id;

        if (!user.friendRequestsReceived.includes(senderId)) {
            throw new Error(`Nenhum pedido de amizade de "${senderNickname}" para aceitar.`);
        }

        user.friendRequestsReceived = user.friendRequestsReceived.filter((id) => id !== senderId);
        user.newFriendRequests = user.newFriendRequests.filter((id) => id !== senderId);
        senderUser.friendRequestsSent = senderUser.friendRequestsSent.filter((id) => id !== userId);

        user.friends.push(senderId);
        senderUser.friends.push(userId);

        user.newFriends.push(senderId);
        senderUser.newFriends.push(userId);

        await user.save();
        await senderUser.save();

        logger.info(`User ${user.username} accepted friend request from ${senderUser.username}. They are now friends.`);

        return senderUser;
    }

    public async removeFriend(user: UserDocument, friendNickname: string): Promise<UserDocument> {
        const friend = await this.userService.findUserByUsername(friendNickname);
        if (!friend) {
            throw new Error(`Amigo "${friendNickname}" not found.`);
        }

        const userId = user.id;
        const friendId = friend.id;

        if (!user.friends.includes(friendId)) {
            throw new Error(`"${friend.username}" is not in your friends list.`);
        }

        user.friends = user.friends.filter((id) => id !== friendId);
        user.newFriends = user.newFriends.filter((id) => id !== friendId);

        friend.friends = friend.friends.filter((id) => id !== userId);
        friend.newFriends = friend.newFriends.filter((id) => id !== userId);

        await user.save();
        await friend.save();

        logger.info(`User ${user.username} removed ${friend.username} from friends.`);
        return friend;
    }

    public async acknowledgeNewFriend(user: UserDocument, friendNickname: string): Promise<UserDocument> {
        const friend = await this.userService.findUserByUsername(friendNickname);
        if (!friend) {
            throw new Error(`Amigo "${friendNickname}" not found.`);
        }

        const friendId = friend.id;

        if (!user.newFriends.includes(friendId)) {
            logger.warn(`User ${user.username} tried to acknowledge a non-new friend ${friend.username}.`);
            return friend;
        }

        user.newFriends = user.newFriends.filter((id) => id !== friendId);
        await user.save();
        logger.info(`User ${user.username} acknowledged new friend ${friend.username}.`);
        return friend;
    }

    public async acknowledgeNewFriendRequest(user: UserDocument, senderNickname: string): Promise<UserDocument> {
        const sender = await this.userService.findUserByUsername(senderNickname);
        if (!sender) {
            throw new Error(`User "${senderNickname}" not found.`);
        }

        const senderId = sender.id;

        if (!user.newFriendRequests.includes(senderId)) {
            logger.warn(`User ${user.username} tried to acknowledge a non-new friend request from ${sender.username}.`);
            return sender;
        }

        user.newFriendRequests = user.newFriendRequests.filter((id) => id !== senderId);
        await user.save();
        logger.info(`User ${user.username} acknowledged new friend request from ${sender.username}.`);
        return sender;
    }

    public async getFriendsData(userId: string): Promise<IFriendsListProps> {
        const user = await User.findOneBy({ id: userId });

        if (!user) {
            throw new Error("Игрок не найден при загрузке списка друзей.");
        }

        // Все пять списков — это идентификаторы; имена берём одним запросом на всех сразу, а не
        // пятью populate, как было раньше.
        const referenced = Array.from(
            new Set([
                ...user.friends,
                ...user.newFriends,
                ...user.friendRequestsReceived,
                ...user.newFriendRequests,
                ...user.friendRequestsSent,
            ])
        );
        const known = referenced.length ? await User.findBy({ id: In(referenced) }) : [];
        const usernameById = new Map(known.map((friend) => [friend.id, friend.username]));
        const names = (ids: string[]): string[] =>
            ids.map((id) => usernameById.get(id)).filter((name): name is string => !!name);

        return {
            acceptedFriends: names(user.friends),
            newAcceptedFriends: names(user.newFriends),
            incomingRequests: names(user.friendRequestsReceived),
            newIncomingRequests: names(user.newFriendRequests),
            outgoingRequests: names(user.friendRequestsSent),
        };
    }
}
