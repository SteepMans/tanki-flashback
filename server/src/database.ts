import "reflect-metadata";
import Config from "@/core/config/config.model";
import ChatMessage from "@/features/chat/chat.model";
import Clan from "@/features/clan/clan.model";
import Invite from "@/features/invite/invite.model";
import User from "@/shared/models/user.model";
import dotenv from "dotenv";
import { DataSource } from "typeorm";
import logger from "./utils/logger";

dotenv.config();

/**
 * Хранилище: MySQL через TypeORM.
 *
 * Адрес берётся из `MYSQL_URL` целиком либо из отдельных переменных `MYSQL_HOST`, `MYSQL_PORT`,
 * `MYSQL_USER`, `MYSQL_PASSWORD`, `MYSQL_DATABASE` — так одна и та же сборка работает и локально,
 * и в контейнере.
 *
 * `synchronize` приводит таблицы к описанию сущностей при старте — удобно, пока схема меняется
 * вместе с кодом, и избавляет от дисциплины миграций, которой в проекте не было и при Mongo. Но
 * это НЕ безопасная операция: при смене типа колонки TypeORM может пересоздать её и потерять
 * содержимое (поймано на рейтинге клана, когда int стал double). Поэтому по умолчанию она включена
 * только вне прода, а на проде включается явно (`DB_SYNC=1`) и только рядом со свежим дампом.
 */
export const AppDataSource = new DataSource({
    type: "mysql",
    ...(process.env.MYSQL_URL
        ? { url: process.env.MYSQL_URL }
        : {
              host: process.env.MYSQL_HOST ?? "localhost",
              port: Number(process.env.MYSQL_PORT ?? 3306),
              username: process.env.MYSQL_USER ?? "root",
              password: process.env.MYSQL_PASSWORD ?? "",
              database: process.env.MYSQL_DATABASE ?? "letanki",
          }),
    charset: "utf8mb4",
    // Даты хранятся в UTC, как это делала Mongo: иначе при смене часового пояса сервера поехали бы
    // сроки премиума, банов и наград.
    timezone: "Z",
    entities: [User, Clan, ChatMessage, Config, Invite],
    synchronize:
        process.env.DB_SYNC === "1" ||
        (process.env.DB_SYNC !== "0" && process.env.NODE_ENV !== "production"),
    logging: process.env.DB_LOG === "1" ? ["query", "error"] : ["error"],
});

export async function connectToDatabase(): Promise<void> {
    try {
        await AppDataSource.initialize();
        logger.info("Successfully connected to MySQL.");
    } catch (error) {
        logger.error("Error connecting to MySQL", { error });
        throw error;
    }
}

export async function disconnectFromDatabase(): Promise<void> {
    try {
        if (AppDataSource.isInitialized) {
            await AppDataSource.destroy();
        }
        logger.info("Successfully disconnected from MySQL.");
    } catch (error) {
        logger.error("Error disconnecting from MySQL", { error });
        throw error;
    }
}
