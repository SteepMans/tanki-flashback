import "reflect-metadata";
import { ID_COLUMN, jsonList, mapOfDates, mapOfNumbers, newObjectId } from "@/shared/db/columns";
import { BaseEntity, BeforeInsert, Column, Entity, Index, PrimaryColumn } from "typeorm";

/** One active clan mission (a daily collective goal). Progress is summed across all members. */
export interface IClanMission {
    id: number; // unique within the current daily set; drives the client row + auto-claim state
    icon: number; // icon resource id (idLow)
    metricKey: string; // kills | battleScore | crystals | goldBox (see clan.missions.data)
    criteria: number; // clan-wide target
    progress: number; // clan-wide progress (may briefly exceed criteria under concurrency; clamped on the wire)
    completed: boolean; // true once progress reached criteria and prizes were auto-granted to all members
}

@Entity("clans")
export class Clan extends BaseEntity {
    @PrimaryColumn(ID_COLUMN)
    id!: string;

    /** Совместимость с кодом, который читает `_id`. */
    get _id(): string {
        return this.id;
    }

    /** display name, unique */
    @Index({ unique: true })
    @Column({ type: "varchar", length: 100 })
    name!: string;

    /** short tag shown next to nicknames, unique */
    @Index({ unique: true })
    @Column({ type: "varchar", length: 32 })
    tag!: string;

    /** rich text (the client allows <font>/<a> HTML) */
    @Column({ type: "text" })
    description: string = "";

    /** founder / owner (a User) */
    @Index()
    @Column(ID_COLUMN)
    leaderId!: string;

    /** member Users (includes the leader) */
    @Column({ type: "json", transformer: jsonList<string>() })
    members: string[] = [];

    /** userId -> ClanPosition (0=Supreme Commander .. 6=Novice). Leader=0; new members default to Novice (absent = Novice). */
    @Column({ type: "json", transformer: mapOfNumbers })
    positions: Map<string, number> = new Map();

    /** userId -> when they joined; drives the "time in clan" display */
    @Column({ type: "json", transformer: mapOfDates })
    memberSince: Map<string, Date> = new Map();

    /** Users who asked to join (pending leader approval) */
    @Column({ type: "json", transformer: jsonList<string>() })
    joinRequests: string[] = [];

    /** Users the clan invited (pending their accept/decline) */
    @Column({ type: "json", transformer: jsonList<string>() })
    invites: string[] = [];

    /** ranking score (clan leaderboard). Дробное: вклад в клановые миссии копится долями очка. */
    @Index()
    @Column({ type: "double", default: 0 })
    rating!: number;

    /** accepts join requests ("open"); false = "closed" */
    @Column({ type: "boolean", default: true })
    recruiting!: boolean;

    /** minimum rank (1-30) required to request to join, or -1 = no minimum */
    @Column({ type: "int", default: -1 })
    minRank!: number;

    /** staff-blocked clan: the foreign-clan window hides the join button and shows blockReason */
    @Column({ type: "boolean", default: false })
    blocked!: boolean;

    /** message shown when blocked=true (staff moderation note) */
    @Column({ type: "text" })
    blockReason: string = "";

    /** CDN-relative resource path to the clan logo image (e.g. /clanlogo/<id>/<v>/BIG); "" = none */
    @Column({ type: "varchar", length: 255 })
    logo: string = "";

    /** the current daily clan-mission set (regenerated when missionResetAt passes) */
    @Column({ type: "json", transformer: jsonList<IClanMission>() })
    missions: IClanMission[] = [];

    /** when the current mission set expires and regenerates */
    @Column({ type: "datetime", precision: 3, nullable: true, default: null })
    missionResetAt!: Date | null;

    /** userId -> lifetime clan-mission contribution points (member panel column) */
    @Column({ type: "json", transformer: mapOfNumbers })
    clanScore: Map<string, number> = new Map();

    /** userId -> this week's contribution points (resets weekly) */
    @Column({ type: "json", transformer: mapOfNumbers })
    weeklyClanScore: Map<string, number> = new Map();

    /** when weeklyClanScore resets */
    @Column({ type: "datetime", precision: 3, nullable: true, default: null })
    weeklyResetAt!: Date | null;

    @Column({ type: "datetime", precision: 3, default: () => "CURRENT_TIMESTAMP(3)" })
    createdAt!: Date;

    @BeforeInsert()
    private assignId(): void {
        if (!this.id) this.id = newObjectId();
        if (!this.createdAt) this.createdAt = new Date();
    }

    /**
     * Колонки-словари дописываются отдельным UPDATE: их правки не видит сравнение перед записью
     * (подробности в `shared/db/columns.ts`). Без этого не сохранялись бы должности в клане, даты
     * вступления и вклад участников в клановые миссии.
     */
    override async save(): Promise<this> {
        const saved = await super.save();
        if (this.id) {
            await Clan.update(this.id, {
                positions: this.positions,
                memberSince: this.memberSince,
                clanScore: this.clanScore,
                weeklyClanScore: this.weeklyClanScore,
            });
        }
        return saved;
    }
}

/** Раньше это был документ mongoose; тип оставлен ради существующих аннотаций. */
export type ClanDocument = Clan;
export type ClanAttributes = Clan;

export default Clan;
