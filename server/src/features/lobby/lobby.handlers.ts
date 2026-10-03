import { BattleMode, EquipmentConstraintsMode, IBattleCreationSettings, MapTheme } from "@/features/battle/battle.model";
import { BattleHaltPacket } from "@/features/system/halt.packets";
import { SystemMessage } from "@/features/system/system.packets";
import { GameClient } from "@/server/game.client";
import { GameServer } from "@/server/game.server";
import { IPacketHandler } from "@/shared/interfaces/ipacket-handler";
import { isProBattleActive } from "@/shared/models/passes";
import logger from "@/utils/logger";
import * as LobbyPackets from "./lobby.packets";
import { LobbyWorkflow } from "./lobby.workflow";

/**
 * Пакет окна создания битвы → настройки боя.
 *
 * Поля схемы приходят сырыми number/string, поэтому перечисления приводим руками (по проводу
 * идёт числовое значение), а имя и карту — из nullable-строки.
 *
 * Настройки формата (без ящиков, без мин, зона падения золотого ящика и прочие) клиент шлёт
 * ЭТИМ ЖЕ пакетом, но раньше здесь стояли константы `false`: флажки в окне ничего не меняли, бой
 * всегда создавался с настройками по умолчанию. Окно показывает их только для PRO-битвы, поэтому
 * для обычной глушим их на сервере — изменённый клиент не должен выставлять формат в обход
 * интерфейса.
 */
/** Потолок ботов в одной битве — тот же, что у команды `/bots`. */
const MAX_BOTS_IN_BATTLE = 12;
/**
 * Сколько ботов просили в названии битвы. В пакете создания боя поля под них нет, а окно создания
 * у клиента правится патчем `browser-bot-count`: он дописывает в конец имени метку `#b<число>`.
 * Метка из имени убирается, так что в списке битв её не видно; набранная руками она работает тоже.
 */
function takeBotCount(name: string): { name: string; botCount?: number } {
    const marked = /^(.*?)\s*#b(\d{1,2})$/.exec(name);
    if (!marked) return { name };
    return {
        name: marked[1].trim(),
        botCount: Math.max(0, Math.min(MAX_BOTS_IN_BATTLE, Number(marked[2]))),
    };
}

export function battleSettingsFromRequest(packet: LobbyPackets.CreateBattleRequest): IBattleCreationSettings {
    const pro = packet.proBattle;
    const requested = takeBotCount(packet.name ?? "");
    return {
        name: requested.name,
        botCount: requested.botCount,
        privateBattle: packet.privateBattle,
        proBattle: packet.proBattle,
        battleMode: packet.battleMode as BattleMode,
        mapId: packet.mapId ?? "",
        maxPeopleCount: packet.maxPeopleCount,
        minRank: packet.minRank,
        maxRank: packet.maxRank,
        timeLimitInSec: packet.timeLimitInSec,
        scoreLimit: packet.scoreLimit,
        autoBalance: packet.autoBalance,
        friendlyFire: packet.friendlyFire,
        parkourMode: packet.parkourMode,
        equipmentConstraintsMode: packet.equipmentConstraintsMode as EquipmentConstraintsMode,
        reArmorEnabled: packet.reArmorEnabled,
        mapTheme: packet.mapTheme as MapTheme,
        withoutBonuses: pro && packet.withoutBonuses,
        withoutCrystals: pro && packet.withoutCrystals,
        withoutSupplies: pro && packet.withoutSupplies,
        withoutUpgrades: pro && packet.withoutUpgrades,
        reducedResistances: pro && packet.reducedResistances,
        esportDropTiming: pro && packet.esportDropTiming,
        withoutGoldBoxes: pro && packet.withoutGoldBoxes,
        withoutGoldSiren: pro && packet.withoutGoldSiren,
        withoutGoldZone: pro && packet.withoutGoldZone,
        withoutMedkit: pro && packet.withoutMedkit,
        withoutMines: pro && packet.withoutMines,
        randomGold: pro && packet.randomGold,
        dependentCooldownEnabled: pro && packet.dependentCooldownEnabled,
    };
}

export class CreateBattleHandler implements IPacketHandler<LobbyPackets.CreateBattleRequest> {
    public readonly packetId = LobbyPackets.CreateBattleRequest.getId();

    public async execute(client: GameClient, server: GameServer, packet: LobbyPackets.CreateBattleRequest): Promise<void> {
        if (!client.user) {
            return;
        }

        // Server about to restart: refuse the create. The client ignores the string's value here.
        if (server.isRestartPending()) {
            client.sendPacket(new BattleHaltPacket("restart"));
            return;
        }

        // Gating do Passe de Batalha PRO: criar uma «Batalha PRO» (proBattle=true) exige o passe ativo —
        // sem exceção para staff. Batalhas normais (proBattle=false) qualquer um cria. Checagem
        // autoritativa no servidor (o cliente esconde a opção, mas um cliente modificado poderia enviar).
        if (packet.proBattle && !isProBattleActive(client.user)) {
            client.sendPacket(new SystemMessage({ text: "Для создания PRO-битвы нужен PRO-пропуск.\nКупите его в гараже." }));
            logger.info(`User ${client.user.username} tried to create a PRO battle without the pro_battle pass.`);
            return;
        }

        try {
            const settings = battleSettingsFromRequest(packet);
            const battle = server.lobbyService.createBattle(settings, client.user);

            // Expire the battle if nobody ever joins it (cancelled on the first join).
            server.battleService.scheduleEmptyRemoval(battle);

            client.lastViewedBattleId = battle.battleId;

            const battleModeStr = BattleMode[packet.battleMode];
            const equipmentConstraintsModeStr = EquipmentConstraintsMode[packet.equipmentConstraintsMode];
            const preview = LobbyWorkflow.getMapPreviewResourceId(battle);

            const basePayload = {
                battleId: battle.battleId,
                battleMode: battleModeStr,
                map: battle.settings.mapId,
                maxPeople: battle.settings.maxPeopleCount,
                name: battle.settings.name,
                privateBattle: battle.settings.privateBattle,
                proBattle: battle.settings.proBattle,
                minRank: battle.settings.minRank,
                maxRank: battle.settings.maxRank,
                preview: preview,
                parkourMode: battle.settings.parkourMode,
                equipmentConstraintsMode: equipmentConstraintsModeStr,
                suspicionLevel: "NONE",
            };

            let finalPayload;

            if (battle.isTeamMode()) {
                finalPayload = {
                    ...basePayload,
                    usersBlue: [],
                    usersRed: [],
                };
            } else {
                finalPayload = {
                    ...basePayload,
                    users: [],
                };
            }

            const responsePacket = new LobbyPackets.CreateBattleResponse({ jsonData: JSON.stringify(finalPayload) });
            // Private battles must NOT appear in everyone's list — only recipients who are allowed to
            // see it get the card (creator + staff now); invited players / chat-preview clickers get it
            // granted on demand (see Battle.grantViewer / canBeSeenBy).
            if (battle.settings.privateBattle) {
                server.broadcastToBattleList(responsePacket, (c) => battle.canBeSeenBy(c.user));
            } else {
                server.broadcastToBattleList(responsePacket);
            }

            await LobbyWorkflow.sendBattleDetails(client, server, battle);
        } catch (error: any) {
            logger.error(`Failed to create battle for user ${client.user.username}: ${error.message}`, { client: client.getRemoteAddress() });
        }
    }
}

export class SelectBattleHandler implements IPacketHandler<LobbyPackets.SelectBattlePacket> {
    public readonly packetId = LobbyPackets.SelectBattlePacket.getId();

    public async execute(client: GameClient, server: GameServer, packet: LobbyPackets.SelectBattlePacket): Promise<void> {
        const requestedId = packet.battleId;
        let battle = requestedId ? server.lobbyService.getBattleById(requestedId) : undefined;

        // The client asked for a battle the server no longer has — typically a row that went stale while
        // this client was somewhere the removal broadcast doesn't reach (garage), so it never got the
        // RemoveBattleFromList for an empty battle reaped after EMPTY_BATTLE_REMOVAL_MS. Falling through to
        // "just show the first battle" made the click look dead: the row stays, the panel keeps showing a
        // different battle, and every further click repeats it. Drop the stale row instead so the list
        // matches the server and the player can see what actually happened.
        if (!battle && requestedId) {
            logger.info(`Client ${client.user?.username} selected battle ${requestedId}, which no longer exists; dropping the stale row.`);
            client.sendPacket(new LobbyPackets.RemoveBattleFromListPacket({ battleId: requestedId }));
            client.sendPacket(new LobbyPackets.HideBattleInfoPacket({ battleId: requestedId }));
            if (client.lastViewedBattleId === requestedId) {
                client.lastViewedBattleId = null;
            }
            return;
        }

        if (!battle) {
            const allBattles = server.lobbyService.getBattles();
            if (allBattles.length === 0) {
                logger.error("No battles available to display details.");
                return;
            }
            battle = allBattles[0];
        }

        client.lastViewedBattleId = battle.battleId;
        await LobbyWorkflow.sendBattleDetails(client, server, battle);
    }
}

export class RequestBattleByLinkHandler implements IPacketHandler<LobbyPackets.RequestBattleByLinkPacket> {
    public readonly packetId = LobbyPackets.RequestBattleByLinkPacket.getId();

    public async execute(client: GameClient, server: GameServer, packet: LobbyPackets.RequestBattleByLinkPacket): Promise<void> {
        if (!packet.battleId) {
            return;
        }

        const battle = server.lobbyService.getBattleById(packet.battleId);

        if (!battle) {
            logger.warn(`Client ${client.user?.username} requested details for non-existent battle ${packet.battleId}`);
            return;
        }

        client.lastViewedBattleId = battle.battleId;

        // Opening a private battle's preview from a chat link grants list visibility (and pushes the
        // card so it shows up in this player's battle list).
        if (battle.settings.privateBattle && battle.grantViewer(client.user)) {
            client.sendPacket(new LobbyPackets.CreateBattleResponse({ jsonData: JSON.stringify(LobbyWorkflow.buildBattleListEntry(battle)) }));
        }

        if (client.getState() === "chat_garage") {
            await LobbyWorkflow.returnToLobby(client, server, true);
        } else {
            await LobbyWorkflow.sendBattleDetails(client, server, battle);
        }
    }
}

export class ValidateBattleNameHandler implements IPacketHandler<LobbyPackets.ValidateBattleNameRequest> {
    public readonly packetId = LobbyPackets.ValidateBattleNameRequest.getId();

    public async execute(client: GameClient, server: GameServer, packet: LobbyPackets.ValidateBattleNameRequest): Promise<void> {
        if (!packet.name) {
            return;
        }

        const sanitizedName = server.lobbyService.validateName(packet.name);
        client.sendPacket(new LobbyPackets.ValidateBattleNameResponse({ name: sanitizedName }));
    }
}

export class RequestLobbyHandler implements IPacketHandler<LobbyPackets.RequestLobbyPacket> {
    public readonly packetId = LobbyPackets.RequestLobbyPacket.getId();

    public async execute(client: GameClient, server: GameServer, packet: LobbyPackets.RequestLobbyPacket): Promise<void> {
        const state = client.getState();

        if (client.currentBattle) {
            if (state === "battle") {
                LobbyWorkflow.enterBattleLobbyView(client, server);
            } else if (state === "battle_lobby") {
                LobbyWorkflow.returnToBattleView(client, server);
            } else if (state === "battle_garage") {
                LobbyWorkflow.transitionFromGarageToLobby(client, server);
            }
        } else {
            if (state === "chat_garage") {
                await LobbyWorkflow.returnToLobby(client, server, true);
            }
        }
    }
}