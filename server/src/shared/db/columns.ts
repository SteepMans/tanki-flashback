import crypto from "crypto";
import { ValueTransformer } from "typeorm";

/**
 * Общие детали хранения для сущностей.
 *
 * База переехала с MongoDB на MySQL, и две вещи пришлось сохранить как есть, чтобы не переписывать
 * пол-игры:
 *
 * 1. **Идентификаторы остались строками из 24 шестнадцатеричных цифр** — теми же, что были у Mongo.
 *    На них ссылаются друзья, кланы, приглашения и сообщения чата, они уезжают в пакеты и в веб-панель.
 *    Автоинкремент потребовал бы переписать все эти ссылки и сломал бы перенос старых данных.
 * 2. **Поля-словари остались `Map`** (`turrets`, `supplies`, `counters` и прочие). Код зовёт у них
 *    `.get()`, `.set()`, `.has()`, `.forEach()` в сотне мест; преобразователь ниже разворачивает Map
 *    в JSON при записи и собирает обратно при чтении, так что вызовы остались нетронутыми.
 */

/** Новый идентификатор в формате ObjectId: 12 случайных байт в hex. */
export function newObjectId(): string {
    return crypto.randomBytes(12).toString("hex");
}

/**
 * ВАЖНО про колонки-словари.
 *
 * Перед записью TypeORM сравнивает новое значение колонки со старым и пишет только изменившиеся.
 * Для JSON-колонок сравнение идёт по собственным перечисляемым свойствам объекта
 * (`OrmUtils.compare2Objects`), а у `Map` их нет вовсе — два любых словаря выглядят для него
 * одинаково пустыми. Поэтому `user.turrets.set(...)` с последующим `save()` НЕ доезжал бы до базы:
 * колонка не попадала в UPDATE. С массивами такого нет, они сравниваются поэлементно.
 *
 * Лечится тем, что сущности со словарями дописывают эти колонки отдельным UPDATE (см. `save()` в
 * `user.model.ts` и `clan.model.ts`) — он пишет ровно то, что ему дали, без сравнения. Список
 * колонок держится рядом с самой сущностью, чтобы не разъехался с её полями.
 */

/** Колонка под идентификатор — свой или чужой (ссылка). */
export const ID_COLUMN = { type: "char", length: 24 } as const;

/** `Map<string, number>` <-> JSON-объект. */
export const mapOfNumbers: ValueTransformer = {
    to: (value?: Map<string, number> | null) => (value ? Object.fromEntries(value) : {}),
    from: (value?: Record<string, number> | null) => new Map(Object.entries(value ?? {})),
};

/** `Map<string, Date>` <-> JSON-объект: даты в JSON становятся строками, поэтому оживляем их обратно. */
export const mapOfDates: ValueTransformer = {
    to: (value?: Map<string, Date> | null) => (value ? Object.fromEntries(value) : {}),
    from: (value?: Record<string, string> | null) =>
        new Map(Object.entries(value ?? {}).map(([key, date]) => [key, new Date(date)])),
};

/** `Map<string, T>` <-> JSON-объект для значений, которые переживают JSON без потерь. */
export function mapOfObjects<T>(): ValueTransformer {
    return {
        to: (value?: Map<string, T> | null) => (value ? Object.fromEntries(value) : {}),
        from: (value?: Record<string, T> | null) => new Map(Object.entries(value ?? {})),
    };
}

/**
 * JSON-колонка со списком: MySQL возвращает уже разобранный массив, но у старых записей на месте
 * значения может оказаться null — тогда отдаём пустой список, как это делала схема Mongo.
 */
export function jsonList<T>(): ValueTransformer {
    return {
        to: (value?: T[] | null) => value ?? [],
        from: (value?: T[] | null) => value ?? [],
    };
}
