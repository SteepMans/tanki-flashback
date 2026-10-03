import "reflect-metadata";
import { INVITE_CODE_LENGTH } from "@/config/constants";
import { ID_COLUMN, newObjectId } from "@/shared/db/columns";
import { BaseEntity, BeforeInsert, Column, Entity, Index, PrimaryColumn } from "typeorm";

/** Код приглашения: пока `userId` пуст, кодом ещё никто не воспользовался. */
@Entity("invites")
export class Invite extends BaseEntity {
    @PrimaryColumn(ID_COLUMN)
    id!: string;

    get _id(): string {
        return this.id;
    }

    @Index({ unique: true })
    @Column({ type: "varchar", length: INVITE_CODE_LENGTH })
    code!: string;

    @Column({ type: "varchar", length: 191, nullable: true, default: null })
    player!: string | null;

    @Column({ ...ID_COLUMN, nullable: true, default: null })
    userId!: string | null;

    @BeforeInsert()
    private assignId(): void {
        if (!this.id) this.id = newObjectId();
    }
}

export type IInvite = Invite;

export default Invite;
