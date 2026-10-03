export const INVITE_CODE_LENGTH = 5;
export const INVITE_CODE_CHARACTERS = "0123456789abcdef";

export const DEFAULT_PORT = 1337;
export const DEFAULT_MAX_CLIENTS = 10;

/**
 * In-game web panel (HTMLLoader) defaults. The server tells the client which URL/size/position
 * to open via the OpenWebPanel packet, so the host lives here (not hardcoded in the SWF patch).
 * x/y = -1 → the client centers the panel on the stage. Override URL with the WEBPANEL_URL env.
 */
export const WEBPANEL = {
  URL: process.env.WEBPANEL_URL || "http://127.0.0.1:9999/panel",
  WIDTH: 380,
  HEIGHT: 320,
  X: -1,
  Y: -1,
};

/**
 * Публичные адреса стенда, которые сервер сообщает клиенту (ссылка на профиль в лобби, хост в
 * реферальной ссылке). Своего домена в коде нет: по умолчанию всё указывает на localhost,
 * боевые значения задаются в `.env`.
 *
 *   SERVER_HOST=example.com            хост, который увидит игрок
 *   PROFILE_PORT=4607                  порт публичных профилей (ProfileWebServer)
 *   PROFILE_URL_BASE=http://.../user/  перебивает ссылку на профиль целиком
 */
const PUBLIC_HOST = process.env.SERVER_HOST || process.env.HOST || "localhost";
const PROFILE_PORT = process.env.PROFILE_PORT || "4607";

export const PUBLIC = {
  HOST: PUBLIC_HOST,
  PROFILE_URL_BASE: process.env.PROFILE_URL_BASE || `http://${PUBLIC_HOST}:${PROFILE_PORT}/user/`,
};

export const CALLBACK = {
  LOGIN_FORM: 3,
  GARAGE_DATA: 4,
  LOBBY_DATA: 5,
  BATTLE_MAP_LIBS_LOADED: 6,
  BATTLE_SKYBOX_LOADED: 7,
  BATTLE_MAP_GEOMETRY_LOADED: 8,
  BATTLE_GENERAL_RESOURCES_LOADED: 9,
  BATTLE_PLAYER_EQUIPMENT_LOADED: 10,
  TIPS_LOADED: 11,
};

/**
 * Диапазон званий при создании битвы.
 *
 * Клиент строит ползунок званий по данным из battle.data.ts: `maxRangeLength` ограничивает ширину
 * диапазона, а у каждой карты свои `minRank`/`maxRank`. В оригинале это резало выбор — например,
 * «Зону» нельзя было открыть новобранцам, а разница между границами не превышала 10 званий.
 *
 * Здесь задаётся политика поверх данных карт: по умолчанию доступны все звания, от новобранца до
 * генералиссимуса, любой ширины. Настраивается в `.env`:
 *
 *   BATTLE_MIN_RANK=1        нижняя граница ползунка
 *   BATTLE_MAX_RANK=30       верхняя граница
 *   BATTLE_MAX_RANK_SPAN=30  максимальная ширина диапазона
 *   BATTLE_RANK_LIMITS=map   вернуть исходные ограничения карт
 */
export const RANKS_TOTAL = 30;

const rankFromEnv = (name: string, fallback: number): number => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.min(Math.round(value), RANKS_TOTAL) : fallback;
};

export const BATTLE_RANK_RANGE = {
  /** false — оставить ограничения из данных карт. */
  UNLOCKED: process.env.BATTLE_RANK_LIMITS !== "map",
  MIN: rankFromEnv("BATTLE_MIN_RANK", 1),
  MAX: rankFromEnv("BATTLE_MAX_RANK", 30),
  MAX_SPAN: rankFromEnv("BATTLE_MAX_RANK_SPAN", 30),
};
