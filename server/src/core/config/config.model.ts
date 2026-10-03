import "reflect-metadata";
import { ID_COLUMN, newObjectId } from "@/shared/db/columns";
import { BaseEntity, BeforeInsert, Column, Entity, Index, PrimaryColumn } from "typeorm";

/** Пара «ключ — значение» для настроек, которые меняются на живом сервере. */
@Entity("configs")
export class Config extends BaseEntity {
    @PrimaryColumn(ID_COLUMN)
    id!: string;

    get _id(): string {
        return this.id;
    }

    @Index({ unique: true })
    @Column({ type: "varchar", length: 191 })
    key!: string;

    @Column({ type: "text" })
    value!: string;

    @BeforeInsert()
    private assignId(): void {
        if (!this.id) this.id = newObjectId();
    }
}

export type IConfig = Config;

export default Config;
