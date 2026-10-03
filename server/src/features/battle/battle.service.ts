import { BATTLE_RANK_RANGE, RANKS_TOTAL } from "@/config/constants";
import * as LobbyPackets from "@/features/lobby/lobby.packets";
import { LobbyService } from "@/features/lobby/lobby.service";
import { IPacket } from "@/packets/packet.interfaces";
import { GameClient } from "@/server/game.client";
import { GameServer } from "@/server/game.server";
import User, { UserDocument } from "@/shared/models/user.model";
import { In } from "typeorm";
import { IVector3 } from "@/shared/types/geom/ivector3";
import { CollisionService } from "./collision.service";
import { SpawnService } from "./spawn.service";
import { BattleEvents } from "./battle-events";
import { CombatService } from "./combat.service";
import { CtfService } from "./ctf.service";
import { RoundService } from "./round.service";
import { BonusService } from "./bonus.service";
import { SupplyService } from "./supply.service";
import { MineService } from "./mine.service";
import { DominationService } from "./domination.service";
import { BattleBotService } from "./bot/bot.service";
import { evictMapData, getMapGeometries } from "@/maps/mapData";
import { evictMapCollision } from "@/maps/mapCollision";
import logger from "@/utils/logger";
import { StatsService } from "@/features/stats/stats.service";
import { Battle, BattleMode, BattleRoundState, EquipmentConstraintsMode, IBattleCreationSettings, MapTheme } from "./battle.model";
import { battleDataObject } from "@/config/battle.data";
import { DestroyTankPacket, RemoveTankPacket, UpdateSpectatorListPacket, UserDisconnectedDmPacket, UserDisconnectTeamPacket } from "./battle.packets";
import { UnloadSpaceBattlePacket } from "./battle-init.packets";
import { LobbyWorkflow } from "@/features/lobby/lobby.workflow";

/** Шаг по каталогу карт при засеве стартовых боёв: подряд в нём идут темы одной карты (см. seedBotBattles). */
const MAP_STRIDE = 41;
const EMPTY_BATTLE_REMOVAL_MS = 60000; // a player-created battle left empty this long is removed

/** A join rejected because the player's gear doesn't satisfy the battle's XP/BP equipment constraint. */
export class EquipmentConstraintError extends Error {}

interface IDisconnectedPlayerInfo {
    battleId: string;
    timeoutId: NodeJS.Timeout;
}

/**
 * Режимы, которые в стартовый список не берём. «Контроль точек» роняет клиент при входе (#1009):
 * пакеты состояния точек прилетают раньше, чем клиент успевает построить модель режима. Пока это не
 * починено, бой такого режима в списке — это гарантированный вылет у того, кто в него зайдёт.
 */
const SEED_SKIP_MODES = new Set(["CP"]);

/**
 * Предел счёта в засеянных боях, по режимам. Числа подобраны так, чтобы раунд обычно доигрывался до
 * конца времени, а не обрывался на середине: в двадцать минут боя с ботами столько не набирают. Но и
 * не «до 999» — счёт в карточке боя должен читаться как настоящий.
 */
const SEED_LIMITS: Record<string, { scoreLimit: number }> = {
    DM: { scoreLimit: 100 },   // личные уничтожения
    TDM: { scoreLimit: 300 },  // уничтожения команды
    CTF: { scoreLimit: 10 },   // доставленные флаги
    CP: { scoreLimit: 100 },   // очки за удержание точек
    AS: { scoreLimit: 100 },
};

export class BattleService {
    /**
     * Hard ceiling on active tanks per battle. The client's BattlefieldModel stores tanks in a
     * fixed-length Vector(60); the 61st tank overflows it (RangeError #1125), corrupting the battle
     * for everyone. We cap below any battle's configured maxPeopleCount so no config can exceed it.
     */
    public static readonly MAX_TANKS_PER_BATTLE = 60;

    /** XP/BP modes require the railgun at "at least m2" (turret modification index >= 2). */
    private static readonly RAILGUN_MIN_MOD = 2;

    /**
     * Enforces an equipment-constraint mode's required hull + turret on join: XP = hornet+railgun,
     * BP = wasp+railgun, XP/BP = either hull, all with the railgun at >= m2. NONE allows anything.
     * XT variants are pure skins of the base items (same stats/physics), so they qualify too.
     * Throws a join-rejection error (shown to the player) when the equipped gear doesn't comply.
     */
    /** Returns a PT-BR error string if `user`'s equipment violates the constraint `mode`, else null.
     *  Public so matchmaking (Partida Competitiva XP/BP) can pre-validate at enqueue time. */
    public static getEquipmentConstraintError(mode: EquipmentConstraintsMode, user: UserDocument): string | null {
        if (mode === EquipmentConstraintsMode.NONE) return null;

        const baseHulls =
            mode === EquipmentConstraintsMode.HORNET_RAILGUN ? ["hornet"] :
            mode === EquipmentConstraintsMode.WASP_RAILGUN ? ["wasp"] :
            ["hornet", "wasp"]; // HORNET_WASP_RAILGUN
        const allowedHulls = baseHulls.flatMap((h) => [h, `${h}_xt`]);

        const turretId = user.equippedTurret;
        const railgunMod = turretId === "railgun" || turretId === "railgun_xt" ? (user.turrets.get(turretId) ?? 0) : -1;
        if (!allowedHulls.includes(user.equippedHull) || railgunMod < BattleService.RAILGUN_MIN_MOD) {
            const hullLabel = baseHulls.map((h) => (h === "hornet" ? "Hornet" : "Wasp")).join(" or ");
            return `This battle requires ${hullLabel} + Railgun (at least M2).`;
        }
        return null;
    }

    private static _enforceEquipmentConstraint(mode: EquipmentConstraintsMode, user: UserDocument): void {
        const error = BattleService.getEquipmentConstraintError(mode, user);
        if (error) throw new EquipmentConstraintError(error);
    }

    private disconnectedPlayers = new Map<string, IDisconnectedPlayerInfo>();
    private readonly collision = new CollisionService();
    private readonly events = new BattleEvents();
    private readonly combat = new CombatService(this.events, this.collision);
    private readonly ctf = new CtfService(this.events, this.collision);
    private readonly spawn: SpawnService;
    private readonly round: RoundService;
    public readonly supply = new SupplyService();
    public readonly bonus: BonusService;
    public readonly mine: MineService;
    public readonly domination: DominationService;
    /** Боты этой битвы: подсадка/снятие и общий такт ИИ (см. BattleBotService). */
    public readonly bots: BattleBotService;
    private server: GameServer;
    private lobbyService: LobbyService;

    constructor(server: GameServer, lobbyService: LobbyService) {
        this.server = server;
        this.spawn = new SpawnService(server);
        this.mine = new MineService(server, this.combat, this.collision, this.events);
        this.bonus = new BonusService(server, this.supply);
        this.round = new RoundService(server, this.events, this.ctf, this.spawn, this.bonus);
        this.domination = new DominationService(server, this.round, this.events);
        this.bots = new BattleBotService(server, this.spawn, this.collision, this.bonus);
        this.lobbyService = lobbyService;
    }

    private broadcastToBattle(battle: Battle, packet: IPacket): void {
        // Serialize once and skip clients still loading (they'd deref null on a packet that
        // references a player/tank they haven't registered yet — #1009).
        battle.broadcast(packet);
    }

    /**
     * Applies `realDamage` (garage HP units) from a weapon hit to a target. Health is tracked on
     * the client's normalized 0-10000 scale, so we convert by RULE OF 3 against the target's hull
     * HP: normalizedDamage = realDamage * 10000 / hullHP. Broadcasts SetHealth + the damage number,
     * and runs the kill flow when health drops to 0. Shared by all weapons (railgun, thunder, ...).
     */
    public applyDamage(battle: Battle, shooterClient: GameClient, targetClient: GameClient, realDamage: number, damageType: number = 0): Promise<void> {
        return this.combat.applyDamage(battle, shooterClient, targetClient, realDamage, damageType);
    }

    /**
     * Area (splash) damage from an explosion at `center` (world position). Every active tank —
     * INCLUDING the shooter (you can blow yourself up) — within `minRadius` takes damage: full up
     * to `maxRadius`, then linearly down to `minPercent`% at `minRadius`, nothing beyond. World
     * distance is scaled by SPLASH_WORLD_SCALE so a direct hit (~150u from center) stays inside
     * maxRadius and the splash reaches ~nearby tanks — calibrate this if the radius feels off.
     */
    public applySplashDamage(battle: Battle, shooterClient: GameClient, center: IVector3, baseDamage: number, maxRadius: number, minRadius: number, minPercent: number, losOrigin?: IVector3): Promise<void> {
        return this.combat.applySplashDamage(battle, shooterClient, center, baseDamage, maxRadius, minRadius, minPercent, losOrigin);
    }

    /** A death with no killer (self-destruct, void). Delegates to CombatService. */
    public registerSuicideDeath(battle: Battle, client: GameClient): void {
        this.combat.registerSuicideDeath(battle, client);
    }

    /** Force-ends the current round (results screen), like the natural round end. Returns false if the
     *  round is already finishing. Used by the /finish staff command. */
    public finishBattle(battle: Battle): boolean {
        if (battle.roundState === BattleRoundState.FINISHED) return false;
        this.round.finishRound(battle);
        return true;
    }

    /** Restarts the round immediately (skip the results pause): resets scores/flags/fund, swaps sides in
     *  team modes and respawns everyone — same flow as the natural post-results restart. Used by /restart. */
    public restartBattle(battle: Battle): void {
        this.round.restartRound(battle);
    }

    /** Sets the round's remaining time (staff /time). */
    public setRoundTimeLeft(battle: Battle, seconds: number): void {
        this.round.setTimeLeft(battle, seconds);
    }

    /** Force-destroys a player's active tank (mirrors the void-death path): returns any carried flag to
     *  base, marks the death, and broadcasts the explosion + respawn to the battle. Returns false if the
     *  target isn't an active tank in a battle. Used by the /destroy staff command. */
    public forceDestroyTank(client: GameClient): boolean {
        const user = client.user;
        const battle = client.currentBattle;
        if (!user || !battle || client.battleState !== "active") return false;

        if (battle.flagCarrierRed?.id === user.id) this.ctf.returnFlagToBase(battle, "RED");
        if (battle.flagCarrierBlue?.id === user.id) this.ctf.returnFlagToBase(battle, "BLUE");

        client.battleState = "suicide";
        client.battleIncarnation++;
        this.registerSuicideDeath(battle, client);

        const destroyPacket = new DestroyTankPacket({ nickname: user.username, readyToSpawnInMs: 3000 });
        for (const p of battle.getAllParticipants()) {
            const pc = this.server.findClientByUsername(p.username);
            if (pc && pc.currentBattle?.battleId === battle.battleId) pc.sendPacket(destroyPacket);
        }
        return true;
    }

    /** Drops any flag currently being carried in the battle, at the carrier's position. Returns how many
     *  were dropped. Used by the /dropflag staff command. */
    public dropCarriedFlags(battle: Battle): number {
        let dropped = 0;
        for (const carrier of [battle.flagCarrierRed, battle.flagCarrierBlue]) {
            if (!carrier) continue;
            const carrierClient = this.server.findClientByUsername(carrier.username);
            this.ctf.dropFlag(carrier, battle, carrierClient?.battlePosition ?? null);
            dropped++;
        }
        return dropped;
    }

    public async checkPlayerPosition(client: GameClient): Promise<void> {
        const { user, currentBattle, battlePosition } = client;
        if (!user || !currentBattle || !battlePosition) return;

        // Anti-clip: a tank inside a solid wall/structure shouldn't happen — log on enter/leave (debug
        // + a hook for wall-hack / building-clip detection). Logged on state change to avoid spam.
        const obstacle = this.collision.obstacleAt(currentBattle.mapResourceId, battlePosition);
        if (obstacle !== client.insideObstacle) {
            if (obstacle) logger.warn(`[collision] ${user.username} is INSIDE collision ${obstacle} at (${battlePosition.x | 0},${battlePosition.y | 0},${battlePosition.z | 0})`);
            else logger.info(`[collision] ${user.username} left collision at (${battlePosition.x | 0},${battlePosition.y | 0},${battlePosition.z | 0})`);
            client.insideObstacle = obstacle;
        }

        // During the round-finish freeze nobody may pick up the flag or trigger kill/void zones — the
        // carrier's flag just fell right under them and would otherwise be re-grabbed instantly.
        if (currentBattle.roundState === BattleRoundState.FINISHED) return;
        // Staff /pause: same interaction freeze (flags/mines/domination/zones) while movement still relays.
        if (currentBattle.paused) return;

        this.ctf.checkFlagInteractions(client);
        this.mine.checkTriggers(client);
        this.domination.checkPointOccupancy(client);

        // Staff toggle (/bounds off): boundary kill/kick zones disabled for this battle — tanks may
        // roam outside the playable shell. Flag/mine/domination checks above still run.
        if (currentBattle.boundsDisabled) return;

        const geometries = getMapGeometries(currentBattle.mapResourceId);
        if (geometries.length === 0) return;

        for (const box of geometries) {
            const isInside =
                battlePosition.x >= box.minX &&
                battlePosition.x <= box.maxX &&
                battlePosition.y >= box.minY &&
                battlePosition.y <= box.maxY &&
                battlePosition.z >= box.minZ &&
                battlePosition.z <= box.maxZ;

            if (!isInside) continue;

            // Parkour: subir e ir pros lados é o jogo — só se MORRE caindo no VOID (coluna sem NENHUMA
            // construção abaixo). Qualquer zona de kill/kick com qualquer estrutura embaixo (chão, rampa,
            // parede ou prédio — inclusive áreas "inacessíveis" muradas) é ignorada; só a queda no vazio mata.
            if (currentBattle.settings.parkourMode) {
                const supported = this.collision.hasSupportBelow(
                    currentBattle.mapResourceId, battlePosition.x, battlePosition.y, battlePosition.z,
                );
                if (supported) continue; // há construção embaixo → não é queda no void → ignora
            }

            await this.handleSpecialGeometryAction(client, box.action);
            break;
        }
    }

    private async handleSpecialGeometryAction(client: GameClient, action: "kill" | "kick"): Promise<void> {
        const { user, currentBattle } = client;
        if (!user || !currentBattle) return;

        logger.info(`User ${user.username} entered a special geometry zone with action: ${action}`);

        if (action === "kill") {
            if (currentBattle.flagCarrierRed?.id === user.id) {
                this.ctf.returnFlagToBase(currentBattle, "RED");
            }
            if (currentBattle.flagCarrierBlue?.id === user.id) {
                this.ctf.returnFlagToBase(currentBattle, "BLUE");
            }
            if (client.battleState === "suicide") return;

            client.battleState = "suicide";
            client.battleIncarnation++;

            // Falling into the void destroys the tank — counts as a death on the scoreboard.
            this.registerSuicideDeath(currentBattle, client);

            const destroyPacket = new DestroyTankPacket({ nickname: user.username, readyToSpawnInMs: 3000 });

            const allParticipants = currentBattle.getAllParticipants();
            allParticipants.forEach((p: UserDocument) => {
                const pClient = this.server.findClientByUsername(p.username);
                if (pClient && pClient.currentBattle?.battleId === currentBattle.battleId) {
                    pClient.sendPacket(destroyPacket);
                }
            });
        } else if (action === "kick") {
            logger.warn(`User ${user.username} was kicked for entering a forbidden area.`);
            setTimeout(() => client.closeConnection(), 100);
        }
    }

    public broadcastSpectatorListUpdate(battle: Battle, excludeClient?: GameClient): void {
        const spectatorNames = battle.spectators.map((s) => s.username);
        const spectatorListString = spectatorNames.join("\n");
        const packet = new UpdateSpectatorListPacket({ spectatorList: spectatorListString });

        for (const spectator of battle.spectators) {
            if (excludeClient && spectator.id === excludeClient.user?.id) {
                continue;
            }
            const spectatorClient = this.server.findClientByUsername(spectator.username);
            if (spectatorClient && spectatorClient.isSpectator) {
                spectatorClient.sendPacket(packet);
            }
        }
        logger.info(`Broadcasted spectator list update for battle ${battle.battleId}`);
    }

    public announceTankRemoval(user: UserDocument, battle: Battle, lastPosition: IVector3 | null): void {
        this.dropFlag(user, battle, lastPosition);
        this.mine.removeMinesOf(battle, user.username);
        this.domination.removeTankFromPoints(battle, user.username);

        // Notify remaining players that this user left the battle (shown in the stats list),
        // then remove their tank object. Team modes (TDM/CTF/CP) use a different "left"
        // packet id than DM. The official server sends the "left" notice before the removal.
        const disconnectPacket: IPacket = battle.isTeamMode()
            ? new UserDisconnectTeamPacket({ nickname: user.username })
            : new UserDisconnectedDmPacket({ nickname: user.username });
        const removeTankPacket = new RemoveTankPacket({ nickname: user.username });

        // Established clients only: a still-loading client never received this tank, and its
        // entry snapshot already excludes the departed player.
        battle.broadcast(disconnectPacket, user.id);
        battle.broadcast(removeTankPacket, user.id);
    }

    public async finalizeBattleExit(user: UserDocument, battle: Battle, friendsToNotify?: string[], isSpectator: boolean = false): Promise<void> {
        if (!isSpectator) {
            const battleDetailWatchers = this.server.getClients().filter((c) => (c.getState() === "chat_lobby" || c.getState() === "battle_lobby") && c.lastViewedBattleId === battle.battleId);
            if (battleDetailWatchers.length > 0) {
                const removeUserPacket = new LobbyPackets.RemoveUserFromBattleLobbyPacket({ battleId: battle.battleId, nickname: user.username });
                for (const watcher of battleDetailWatchers) {
                    watcher.sendPacket(removeUserPacket);
                }
            }

            if (battle.settings.battleMode === BattleMode.DM) {
                this.server.broadcastToBattleList(new LobbyPackets.ReleasePlayerSlotDmPacket({ battleId: battle.battleId, nickname: user.username }));
            } else {
                this.server.broadcastToBattleList(new LobbyPackets.OnReleaseSlotTeamPacket({ battleId: battle.battleId, nickname: user.username }));
            }
        }

        let friends: string[] = friendsToNotify || [];
        if (!friendsToNotify) {
            const friendUsers = user.friends.length ? await User.findBy({ id: In(user.friends) }) : [];
            friends = friendUsers.map((friend) => friend.username);
        }

        if (friends.length > 0) {
            const userNotInBattlePacket = new LobbyPackets.UserNotInBattlePacket({ nickname: user.username });
            for (const friendUsername of friends) {
                const friendClient = this.server.findClientByUsername(friendUsername);
                if (friendClient) {
                    friendClient.sendPacket(userNotInBattlePacket);
                }
            }
        }

        this.removeUserFromBattle(user, battle);
    }

    public handlePlayerDisconnection(client: GameClient): void {
        const { user, currentBattle, isSpectator, battlePosition } = client;
        if (!user || !currentBattle) return;

        if (isSpectator) {
            logger.info(`Spectator ${user.username} disconnected from battle ${currentBattle.battleId}. Finalizing immediately.`);
            this.finalizeDisconnection(user, currentBattle, isSpectator);
        } else {
            logger.info(`Player ${user.username} disconnected from battle ${currentBattle.battleId}. Starting 1-minute reconnect timer.`);
            this.announceTankRemoval(user, currentBattle, battlePosition);

            const timeoutId = setTimeout(() => {
                logger.info(`Reconnect timer for ${user.username} expired. Finalizing disconnection.`);
                this.disconnectedPlayers.delete(user.id);
                this.finalizeDisconnection(user, currentBattle, isSpectator);
            }, 60000);

            this.disconnectedPlayers.set(user.id, { battleId: currentBattle.battleId, timeoutId });
        }
    }

    public handlePlayerReconnection(user: UserDocument): { battleId: string } | null {
        const disconnectedInfo = this.disconnectedPlayers.get(user.id);
        if (disconnectedInfo) {
            logger.info(`Player ${user.username} reconnected in time.`);
            clearTimeout(disconnectedInfo.timeoutId);
            this.disconnectedPlayers.delete(user.id);

            // The roster still holds the UserDocument from the player's ORIGINAL join; relogin loaded a
            // fresh document (client.user) from the DB. They diverge after a mid-battle equipment change
            // (equipItem mutates the live client.user, not the stale roster doc). loadPlayerEquipment
            // reads equipment off the roster while getTankModelDataJson builds the InitTank off
            // client.user — a divergence means the client loads the OLD hull/turret/paint resources but
            // receives an InitTank referencing the NEW ones → null resource → TypeError #1009. Swap the
            // stale roster reference for the live one so both read the same (current) equipment.
            const battle = this.lobbyService.getBattleById(disconnectedInfo.battleId);
            if (battle) this._refreshRosterUser(battle, user);

            return { battleId: disconnectedInfo.battleId };
        }
        return null;
    }

    /** Replaces the stale UserDocument reference (matched by id) in every roster array with the live
     *  one. Called on reconnect so the roster stays in sync with the reconnecting client's client.user. */
    private _refreshRosterUser(battle: Battle, user: UserDocument): void {
        const swap = (arr: UserDocument[]) => {
            const i = arr.findIndex((u) => u.id === user.id);
            if (i !== -1) arr[i] = user;
        };
        swap(battle.users);
        swap(battle.usersBlue);
        swap(battle.usersRed);
        swap(battle.spectators);
    }

    private async finalizeDisconnection(user: UserDocument, battle: Battle, isSpectator: boolean): Promise<void> {
        await this.finalizeBattleExit(user, battle, undefined, isSpectator);
    }

    /** Force-removes an OFFLINE user still held in a battle roster (closed the game / dropped and is
     *  sitting in the 60s reconnect grace): cancels the grace timer and finalizes the exit immediately.
     *  Returns the battleId they were removed from, or null if no roster holds them. Used by /kickbattle
     *  for targets that aren't connected. */
    public async kickOfflineFromBattle(username: string): Promise<string | null> {
        const lower = username.toLowerCase();
        for (const battle of this.lobbyService.getBattles()) {
            const rosters: [UserDocument[], boolean][] = [
                [battle.users, false], [battle.usersBlue, false], [battle.usersRed, false], [battle.spectators, true],
            ];
            for (const [roster, isSpectator] of rosters) {
                const user = roster.find((u) => u.username.toLowerCase() === lower);
                if (!user) continue;
                const grace = this.disconnectedPlayers.get(user.id);
                if (grace) {
                    clearTimeout(grace.timeoutId);
                    this.disconnectedPlayers.delete(user.id);
                }
                logger.info(`Force-removing offline user ${user.username} from battle ${battle.battleId} (staff kickbattle).`);
                await this.finalizeDisconnection(user, battle, isSpectator);
                return battle.battleId;
            }
        }
        return null;
    }

    /** Start the empty-battle removal countdown (a player-created battle nobody is in is removed after
     *  EMPTY_BATTLE_REMOVAL_MS). Called at creation (so a never-joined battle expires) and whenever a
     *  battle becomes empty. System battles ("Batalha para Novatos") are kept. Cancelled on join. */
    public scheduleEmptyRemoval(battle: Battle): void {
        if (battle.isSystem || battle.timers.has("emptyRemoval")) return;
        battle.timers.set("emptyRemoval", EMPTY_BATTLE_REMOVAL_MS, () => this._removeEmptyBattle(battle));
    }

    /** Empty player-created battle that stayed empty for the timeout: remove it from the list + state. */
    private _removeEmptyBattle(battle: Battle): void {
        if (battle.isSystem) return;
        if ([...battle.users, ...battle.usersBlue, ...battle.usersRed].length > 0) return; // someone rejoined
        logger.info(`Removing empty battle ${battle.battleId} after ${EMPTY_BATTLE_REMOVAL_MS / 1000}s idle.`);
        this.bots.removeAll(battle); // подстраховка: битвы не станет, а отряд ботов остался бы в реестре
        battle.timers.clearAll(); // no dangling timers once the battle is gone
        // Remove it from everyone's battle list, and close the detail panel for anyone previewing it
        // (else they'd try to join a battle that no longer exists).
        this.server.broadcastToBattleList(new LobbyPackets.RemoveBattleFromListPacket({ battleId: battle.battleId }));
        const hidePacket = new LobbyPackets.HideBattleInfoPacket({ battleId: battle.battleId });
        for (const c of this.server.getClients()) {
            if ((c.getState() === "chat_lobby" || c.getState() === "battle_lobby") && c.lastViewedBattleId === battle.battleId) {
                c.sendPacket(hidePacket);
                c.lastViewedBattleId = null;
            }
        }
        this.lobbyService.removeBattle(battle.battleId);
        this._evictMapCachesIfUnused(battle.mapResourceId);
    }

    /** Frees a map's cached data (battle data + collision) once no active battle uses it anymore. */
    private _evictMapCachesIfUnused(mapResourceId: string): void {
        if (this.server.lobbyService.getBattles().some((b) => b.mapResourceId === mapResourceId)) return;
        evictMapData(mapResourceId);
        evictMapCollision(mapResourceId);
        this.collision.evictMap(mapResourceId);
    }

    public addUserToBattle(user: UserDocument, battleId: string, teamIndex: number): Battle {
        const battle = this.lobbyService.getBattleById(battleId);
        if (!battle) throw new Error("Выбранной битвы больше нет.");

        // Someone joined — cancel any pending empty-battle removal.
        battle.timers.clear("emptyRemoval");

        const settings = battle.settings;
        if (user.rank < settings.minRank || user.rank > settings.maxRank) {
            throw new Error("Ваше звание не подходит для этой битвы.");
        }

        // XP/BP modes only admit a specific hull + railgun (>= m2).
        BattleService._enforceEquipmentConstraint(settings.equipmentConstraintsMode, user);

        const allParticipants = battle.getAllParticipants();
        const isAlreadyInBattle = allParticipants.some((p) => p.id === user.id);

        if (isAlreadyInBattle) {
            throw new Error("Вы уже в этой битве.");
        }

        // Capacity: in TEAM modes the client's maxPeopleCount is PER TEAM (CTF=1 => 1v1, CP=3 => 3v3),
        // so cap each team independently (prevents 3x1 / 4x0); in DM it's the total player count.
        if (battle.isTeamMode()) {
            if (teamIndex !== 0 && teamIndex !== 1) throw new Error("Выбрана неверная команда.");
            const perTeamCap = Math.min(settings.maxPeopleCount, BattleService.MAX_TANKS_PER_BATTLE / 2);
            const team = teamIndex === 0 ? battle.usersRed : battle.usersBlue;
            if (team.length >= perTeamCap) {
                throw new Error("Битва заполнена.");
            }
            team.push(user);
        } else {
            const capacity = Math.min(settings.maxPeopleCount, BattleService.MAX_TANKS_PER_BATTLE);
            if (battle.users.length >= capacity) {
                throw new Error("Битва заполнена.");
            }
            battle.users.push(user);
        }

        this.startRoundIfIdle(battle);

        // Боты подсаживаются ДО входного рукопожатия клиента — так их снаряжение попадает в его
        // загрузку ресурсов и танки уже есть в снимке битвы.
        this.bots.onRosterChanged(battle);

        logger.info(`User ${user.username} added to battle ${battle.battleId}`);
        return battle;
    }

    /** Запускает раунд, если он ещё не шёл: часы, авто-дроп бонусов и цикл точек контроля. Общий для
     *  входа первого игрока и для битв, которые сразу наполняются ботами. */
    public startRoundIfIdle(battle: Battle): void {
        if (battle.roundStarted) return;
        if ([...battle.users, ...battle.usersBlue, ...battle.usersRed].length === 0) return;
        battle.roundStartTime = Date.now();
        this.round.startRoundTimer(battle); // -> RUNNING
        this.bonus.startAutoSpawn(battle);
        this.bonus.startGoldBoxDrops(battle);
        this.domination.startLoop(battle);
        logger.info(`Round started for battle ${battle.battleId}.`);
    }

    /**
     * Наполняет битву ботами и сразу запускает раунд — бой идёт сам по себе, к нему можно подключиться
     * в любой момент. Используется для стартовых битв сервера (см. seedBotBattles).
     */
    public fillWithBots(battle: Battle, count: number): number {
        this.bots.setDesiredCount(battle, count);
        this.startRoundIfIdle(battle);
        return this.bots.count(battle);
    }

    /**
     * Окна званий для стартовых боёв: список должен показывать весь пул — от новобранца до
     * генералиссимуса, — а не один диапазон «1-30», в котором новичку не видно ни одного боя по себе.
     * Окна перекрываются, чтобы игрок на стыке званий видел бои с обеих сторон, и упираются в границы
     * BATTLE_RANK_RANGE (сервер сам их не расширяет — иначе бой не пройдёт проверку лобби).
     */
    private _seedRankWindows(): { min: number; max: number }[] {
        const low = Math.max(1, BATTLE_RANK_RANGE.MIN);
        const high = Math.min(RANKS_TOTAL, BATTLE_RANK_RANGE.MAX);
        const span = Math.max(1, high - low);
        const at = (fraction: number) => Math.round(low + span * fraction);
        const windows = [
            { min: low, max: at(0.2) },          // новобранцы
            { min: at(0.13), max: at(0.4) },     // младшие звания
            { min: at(0.33), max: at(0.6) },     // середина
            { min: at(0.53), max: at(0.8) },     // старшие
            { min: at(0.73), max: high },        // верхушка
            { min: low, max: high },             // и пара боёв на весь диапазон
        ];
        // Окно шире разрешённого лобби не пропустит, поэтому подрезаем сверху.
        return windows.map((w) => ({
            min: Math.max(low, Math.min(w.min, high)),
            max: Math.min(high, Math.max(w.min, Math.min(w.max, w.min + BATTLE_RANK_RANGE.MAX_SPAN - 1))),
        }));
    }

    /**
     * Сколько ботов посадить в стартовый бой этой карты. Не фиксированная шестёрка: на тесной карте
     * толпа не помещается, на просторной шестеро теряются. Считаем от ВМЕСТИМОСТИ боя и занимаем
     * примерно половину — свободные места должны остаться игроку, иначе он видит полный бой и не может
     * в него войти. Итог зажат в 2..10: меньше двух — не бой, больше десяти клиент рисует с трудом.
     */
    private _seedBotCount(capacity: number): number {
        return Math.max(2, Math.min(10, Math.floor(capacity / 2)));
    }

    /**
     * Форматы стартовых боёв. Список битв должен читаться как живой: обычные бои вперемешку с PRO
     * (без ящиков, без припасов, без мин, с точным таймером дропа, с зоной золотого ящика) и парой
     * парковых. Один формат на бой — они и раздают бою характер, а не только карта с режимом.
     *
     * Обычных боёв в списке заметно больше — так же, как и в живом списке битв.
     */
    /**
     * Сколько идёт раунд в засеянном бою. Раньше сеятель брал `battleLimits` из `battle.data.ts`, но
     * это ПОТОЛКИ ползунков в окне создания битвы (999 уничтожений, 59940 секунд — почти 17 часов), а
     * не настройки боя: список получался из одинаковых вечных боёв «до 999».
     */
    private static readonly SEED_ROUND_SECONDS = 20 * 60;

    private _seedFormats(): Partial<IBattleCreationSettings>[] {
        return [
            {}, {}, {}, {},
            // Формат без припасов и без ящиков задаёт бою характер и БЕЗ пометки PRO: сами по себе
            // эти флажки бесплатны, платный только вход в PRO-битву, поэтому её тут нет вовсе —
            // иначе четверть стартового списка стоила бы игроку кристаллов за вход.
            { withoutSupplies: true },
            {}, {}, {},
            { withoutBonuses: true },
            {}, {},
            { withoutMines: true, withoutSupplies: true },
            {}, {},
            {}, {},
            {}, {},
            { withoutCrystals: true, withoutGoldBoxes: true },
            { friendlyFire: true },
            {},
            // Парковый бой: по нему ездят, а не стреляют, — в списке он тоже должен быть.
            { parkourMode: true, withoutBonuses: true },
        ];
    }

    /**
     * Создаёт `count` системных битв, уже наполненных ботами: сервер стартует не с пустым списком, а с
     * идущими боями, к любому из которых игрок может подключиться. Разнообразие — по всем осям сразу:
     * карта с темой из каталога (`battleDataObject.maps`), режим, окно званий, вместимость и формат
     * (см. _seedFormats). Системные битвы не удаляются по таймеру пустоты, поэтому бои живут всё время
     * работы сервера.
     *
     * Карта подбирается ПОД окно званий: у каждой карты каталога своё окно (map_zone — от 11-го звания),
     * и бой новобранцев на такой карте игрок в жизни не увидит.
     */
    public seedBotBattles(count: number, botsPerBattle: number = 6): Battle[] {
        const modeByName: Record<string, BattleMode> = { DM: BattleMode.DM, TDM: BattleMode.TDM, CTF: BattleMode.CTF, CP: BattleMode.CP };
        const maps = battleDataObject.maps.filter((m) => m.enabled && m.supportedModes.some((mode) => mode in modeByName));
        const created: Battle[] = [];
        if (maps.length === 0) {
            logger.warn("No maps available to seed bot battles.");
            return created;
        }
        const windows = this._seedRankWindows();
        const formats = this._seedFormats();
        // Своя очередь карт на каждое окно званий: иначе окна, деля один общий счётчик, разбирали бы
        // подряд идущие темы одной и той же карты.
        const cursor = new Map<number, number>();

        for (let i = 0; i < count; i++) {
            // Окно званий и формат крутим отдельными циклами разной длины: так их сочетания не
            // повторяются каждые несколько боёв.
            const windowIndex = i % windows.length;
            const window = windows[windowIndex];
            const format = formats[i % formats.length];

            // Карта должна закрывать окно ЦЕЛИКОМ: у каждой карты каталога своё ограничение по званию
            // (map_zone — от 11-го), и на такой карте бой новобранцев в жизни не встретишь. Если карт под
            // окно нет вовсе, берём хотя бы те, что с ним заметно пересекаются, и подрезаем окно по карте.
            const covering = maps.filter((m) => m.minRank <= window.min && m.maxRank >= window.max);
            const overlapping = maps.filter((m) => Math.min(window.max, m.maxRank) - Math.max(window.min, m.minRank) >= 2);
            const pool = covering.length > 0 ? covering : (overlapping.length > 0 ? overlapping : maps);
            const at = cursor.get(windowIndex) ?? 0;
            cursor.set(windowIndex, at + 1);
            // Шаг по каталогу — простое число, а не единица: подряд в нём идут ТЕМЫ одной и той же карты
            // (лето, зима, космос), и сплошным перебором список получался бы из десятка карт в разных
            // расцветках вместо сотни разных боёв.
            const map = pool[(at * MAP_STRIDE + windowIndex) % pool.length];

            const modes = map.supportedModes.filter((mode) => mode in modeByName && !SEED_SKIP_MODES.has(mode));
            // Режим гоняем по КОЛИЧЕСТВУ созданных боёв, а не по индексу карты: иначе карта, которая
            // поддерживает только DM/TDM, никогда не давала бы захват флага, и список выглядел бы
            // как один сплошной дезматч.
            const modeName = modes[i % modes.length];
            const limits = SEED_LIMITS[modeName] ?? SEED_LIMITS.DM;
            // Вместимость тоже разная: каталожный максимум карты, его половина и три четверти. Бой на
            // 4 человека и бой на 20 — это разные бои даже на одной карте.
            const seats = [1, 0.5, 0.75][i % 3];
            const maxPeopleCount = Math.max(2, Math.round(map.maxPeople * seats));
            const minRank = Math.max(window.min, map.minRank);
            const maxRank = Math.max(minRank, Math.min(window.max, map.maxRank));
            try {
                const battle = this.lobbyService.createBattle({
                    name: map.mapName,
                    privateBattle: false,
                    proBattle: false,
                    battleMode: modeByName[modeName],
                    mapId: map.mapId,
                    maxPeopleCount,
                    minRank,
                    maxRank,
                    timeLimitInSec: BattleService.SEED_ROUND_SECONDS,
                    scoreLimit: limits.scoreLimit,
                    autoBalance: true,
                    friendlyFire: false,
                    parkourMode: false,
                    equipmentConstraintsMode: EquipmentConstraintsMode.NONE,
                    reArmorEnabled: true,
                    mapTheme: MapTheme[map.theme as keyof typeof MapTheme] ?? MapTheme.SUMMER,
                    withoutBonuses: false,
                    withoutCrystals: false,
                    withoutSupplies: false,
                    withoutUpgrades: false,
                    reducedResistances: false,
                    esportDropTiming: false,
                    withoutGoldBoxes: false,
                    withoutGoldSiren: false,
                    withoutGoldZone: false,
                    withoutMedkit: false,
                    withoutMines: false,
                    randomGold: false,
                    dependentCooldownEnabled: false,
                    botCount: botsPerBattle,
                    ...format,
                });
                // Число ботов — по вместимости КОНКРЕТНОГО боя (в командных режимах она вдвое больше:
                // maxPeopleCount задаётся на команду). `botsPerBattle` остаётся потолком, чтобы вызов
                // с явным числом (тесты, админка) по-прежнему решал.
                const capacity = battle.isTeamMode() ? maxPeopleCount * 2 : maxPeopleCount;
                this.fillWithBots(battle, Math.min(botsPerBattle, this._seedBotCount(capacity)));
                created.push(battle);
            } catch (error: any) {
                logger.warn(`Failed to seed a bot battle on ${map.mapId}`, { error: error.message });
            }
        }
        // Разбивку по режимам печатаем сразу: список битв должен быть разным, и проверять это
        // глазами по сотне карточек — то ещё занятие.
        const byMode = created.reduce<Record<string, number>>((acc, battle) => {
            const name = BattleMode[battle.settings.battleMode];
            acc[name] = (acc[name] ?? 0) + 1;
            return acc;
        }, {});
        const modes = Object.entries(byMode).map(([name, count]) => `${name} ${count}`).join(", ");
        logger.info(`Seeded ${created.length} bot battles: ${modes}; раунд ${BattleService.SEED_ROUND_SECONDS / 60} мин.`);
        return created;
    }

    public addSpectatorToBattle(user: UserDocument, battleId: string): Battle {
        const battle = this.lobbyService.getBattleById(battleId);
        if (!battle) throw new Error("Выбранной битвы больше нет.");

        const allParticipants = battle.getAllParticipants();
        const isAlreadyInBattle = allParticipants.some((p) => p.id === user.id);

        if (isAlreadyInBattle) {
            throw new Error("Вы уже в этой битве.");
        }

        battle.spectators.push(user);
        logger.info(`User ${user.username} added to battle ${battle.battleId} as a spectator`);

        return battle;
    }

    public removeUserFromBattle(user: UserDocument, battle: Battle): void {
        const userId = user.id;

        // Being REMOVED from the match (explicit leave OR kick after the reconnect grace expires) resets
        // the equip-change cooldowns. A reconnect keeps the user in the roster and never calls this, so a
        // "close & reopen → sent back to the match" reconnect keeps the cooldowns; a kick + fresh re-join
        // resets them.
        this.server.garageService.clearEquipCooldowns(userId);

        const wasSpectator = battle.spectators.some((s) => s.id === userId);

        // Leaving a LIVE match counts as a loss and flushes the round's accumulated stats. Only real
        // players during active play — spectators, the results-pause and reconnect flows don't penalise.
        const wasPlayer = [...battle.users, ...battle.usersBlue, ...battle.usersRed].some((u) => u.id === userId);
        if (wasPlayer && battle.roundState === BattleRoundState.RUNNING) {
            const client = this.server.findClientByUsername(user.username);
            if (client && !client.isSpectator && !client.statsFlushedForRound) {
                // Flush the final counter + clan-mission delta and settle the per-round outcome (maxes,
                // streaks, win/loss — leaving mid-round = a loss). flushDelta already ran on each death, so
                // this only writes what happened since the last one plus the round aggregates.
                StatsService.flushRound(client, battle, StatsService.countsWinLoss(battle) ? "loss" : "none", this.server);
                client.statsFlushedForRound = true;
            }
            // Partida Competitiva: sair de um round em ANDAMENTO = abandono → W.O. para o adversário.
            this.server.rankedService?.onPlayerLeft(battle, userId);
        }

        battle.users = battle.users.filter((u) => u.id !== userId);
        battle.usersBlue = battle.usersBlue.filter((u) => u.id !== userId);
        battle.usersRed = battle.usersRed.filter((u) => u.id !== userId);
        battle.spectators = battle.spectators.filter((u) => u.id !== userId);

        if (wasSpectator) {
            this.broadcastSpectatorListUpdate(battle);
        }

        // Ушёл последний живой игрок — снимаем ботов ДО проверки «бой опустел» ниже: иначе они остались
        // бы в ростере, битва никогда не считалась бы пустой и воевала сама с собой вечно.
        this.bots.onRosterChanged(battle);

        if ([...battle.users, ...battle.usersBlue, ...battle.usersRed].length === 0) {
            this._resetEmptiedBattle(battle);
            this.scheduleEmptyRemoval(battle);
        }

        logger.info(`User ${user.username} removed from battle ${battle.battleId}`);
    }

    /** The battle just lost its last participant. A disconnected player stays in the roster until
     *  their reconnect grace expires, so this only runs when there's truly NObody left (not even a
     *  reconnecting one). Wipe ALL match state so whoever joins next starts a clean match: round +
     *  timers, team scores, the crystal fund, dropped/carried flags (back to base), domination points
     *  (back to neutral) and any leftover drops & mines. */
    private _resetEmptiedBattle(battle: Battle): void {
        battle.roundState = BattleRoundState.WAITING;
        battle.roundStartTime = null;
        battle.timers.clear("round");
        battle.timers.clear("finish");

        // Stop the live loops and remove transient field objects.
        this.bonus.stopAutoSpawn(battle); // clears the spawn timer + any leftover drops
        this.domination.stopLoop(battle);
        this.ctf.clearReturnTimers(battle);
        this.mine.clearAll(battle);

        // Zero the persistent match stats so the next joiner starts fresh.
        battle.scoreRed = 0;
        battle.scoreBlue = 0;
        battle.fund = 0;
        if (battle.settings.battleMode === BattleMode.CTF) {
            this.ctf.returnFlagToBase(battle, "RED");
            this.ctf.returnFlagToBase(battle, "BLUE");
        }
        this.domination.resetRound(battle); // points back to neutral + team scores 0 (CP only)

        logger.info(`Battle ${battle.battleId} is now empty. Match state fully reset.`);
    }

    /** Delegates to SpawnService — kept on BattleService so existing callers (the spawn handler and
     *  restartRound) keep working through the facade. */
    public prepareRespawn(client: GameClient): void {
        this.spawn.prepareRespawn(client);
    }

    /** Drops the flag the user is carrying onto the ground beneath them (CtfService). Kept on the
     *  facade because the disconnect/exit handlers and the garage workflow call it. */
    public dropFlag(user: UserDocument, battle: Battle, dropPosition: IVector3 | null): void {
        this.ctf.dropFlag(user, battle, dropPosition);
    }

    /** Ends every running round ahead of a server restart (shows the results screen). The
     *  restart-pending guard in RoundService.restartRound then evacuates the players instead of
     *  recommencing the round. */
    public endAllBattlesForRestart(): void {
        for (const battle of this.server.lobbyService.getBattles()) {
            if (battle.roundState === BattleRoundState.RUNNING) {
                this.round.finishRound(battle); // results screen, then guard evacuates after the 10s pause
            } else if (battle.roundState !== BattleRoundState.FINISHED) {
                // WAITING (no round in progress): no finish→restart cycle, so evacuate right away.
                void this.evacuateForRestart(battle);
            }
            // FINISHED battles already have a pending finish timer -> restartRound -> guard -> evacuate.
        }
        logger.info("All battles ended for server restart.");
    }

    /** Removes every player/spectator from `battle` and sends them back to the battle list. Called
     *  when a finished round would restart but the server is shutting down. */
    public async evacuateForRestart(battle: Battle): Promise<void> {
        // Ботов вывозить некуда — просто снимаем их, пока не начали разбирать живых.
        this.bots.removeAll(battle);
        for (const client of [...battle.clients]) {
            const user = client.user;
            if (!user) continue;
            const isSpectator = client.isSpectator;

            if (!isSpectator) this.announceTankRemoval(user, battle, client.battlePosition);
            await this.finalizeBattleExit(user, battle, client.friendsCache, isSpectator);

            client.sendPacket(new UnloadSpaceBattlePacket());
            client.currentBattle = null;
            client.isSpectator = false;
            client.battleState = "suicide";
            client.stopTimeChecker();

            if (client.getState() === "battle_lobby") client.sendPacket(new LobbyPackets.UnloadBattleListPacket());
            await LobbyWorkflow.returnToLobby(client, this.server, false);
        }
        logger.info(`Battle ${battle.battleId} evacuated for server restart.`);
    }
}