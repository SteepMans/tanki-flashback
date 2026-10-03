import "reflect-metadata";
import { ID_COLUMN, newObjectId } from "@/shared/db/columns";
import User from "@/shared/models/user.model";
import { BaseEntity, BeforeInsert, Column, Entity, Index, JoinColumn, ManyToOne, PrimaryColumn } from "typeorm";

/**
 * Сообщение общего чата. Отправитель и получатель — ссылки на пользователей: колонка с
 * идентификатором плюс связь, через которую история подтягивает имена одним запросом (раньше это
 * делал `populate`). Удалённый пользователь обнуляет ссылку, а сообщение остаётся.
 */
@Entity("chat_messages")
export class ChatMessage extends BaseEntity {
    @PrimaryColumn(ID_COLUMN)
    id!: string;

    get _id(): string {
        return this.id;
    }

    @Index()
    @Column({ ...ID_COLUMN, nullable: true, default: null })
    sourceUserId!: string | null;

    @ManyToOne(() => User, { nullable: true, onDelete: "SET NULL" })
    @JoinColumn({ name: "sourceUserId" })
    sourceUser!: User | null;

    @Column({ ...ID_COLUMN, nullable: true, default: null })
    targetUserId!: string | null;

    @ManyToOne(() => User, { nullable: true, onDelete: "SET NULL" })
    @JoinColumn({ name: "targetUserId" })
    targetUser!: User | null;

    @Column({ type: "text" })
    message!: string;

    @Column({ type: "boolean", default: false })
    isSystemMessage!: boolean;

    @Column({ type: "boolean", default: false })
    isWarning!: boolean;

    /** used by the history-trim sort/skip (keeps only the N most recent) */
    @Index()
    @Column({ type: "datetime", precision: 3, default: () => "CURRENT_TIMESTAMP(3)" })
    timestamp!: Date;

    @BeforeInsert()
    private assignId(): void {
        if (!this.id) this.id = newObjectId();
        if (!this.timestamp) this.timestamp = new Date();
    }
}

export type IChatMessage = ChatMessage;

export default ChatMessage;
