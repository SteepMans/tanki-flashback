# ProTanki Server

> [!WARNING]
> ## Внимание
> Поддерживается **только последняя версия клиента ProTanki**.

## Описание

**ProTanki Server** — приватная серверная реализация ProTanki, разработанная на **TypeScript** с использованием современной модульной архитектуры.

Проект находится в стадии **WIP (Work In Progress)**. Некоторые возможности могут отсутствовать или изменяться по мере разработки.

---

# Требования

Перед запуском необходимо установить:

- Node.js
- npm
- MySQL 8

---

# Настройка

Создайте файл `.env` в корне проекта:

```env
PORT=1337
RESOURCE_PORT=9999

MYSQL_HOST=localhost
MYSQL_PORT=3306
MYSQL_USER=root
MYSQL_PASSWORD=
MYSQL_DATABASE=letanki

ENABLE_CONSOLE_LOGGING=true
LOG_LEVEL=info

WEBPANEL_URL=http://localhost:9999/panel
```

## Переменные окружения

| Переменная | Описание |
|------------|----------|
| `PORT` | Порт игрового сервера |
| `RESOURCE_PORT` | Порт сервера ресурсов |
| `MYSQL_HOST`, `MYSQL_PORT`, `MYSQL_USER`, `MYSQL_PASSWORD`, `MYSQL_DATABASE` | Подключение к MySQL (либо одна строка `MYSQL_URL`) |
| `DB_SYNC` | `0` отключает приведение схемы к сущностям при старте |
| `ENABLE_CONSOLE_LOGGING` | Включение логирования в консоль |
| `LOG_LEVEL` | Уровень логирования (`debug`, `info`, `warn`, `error`) |
| `WEBPANEL_URL` | Адрес веб-панели |

---

# Установка

Установить зависимости:

```bash
npm install
```

---

# Запуск

Режим разработки:

```bash
npm run dev
```

Сборка:

```bash
npm run build
```

Запуск после сборки:

```bash
npm start
```

---

# Команды

| Команда | Назначение |
|---------|------------|
| `npm run dev` | Запуск в режиме разработки |
| `npm run build` | Сборка проекта |
| `npm start` | Запуск собранной версии |
| `npm run build:gen` | Генерация игровых ресурсов |
| `npm test` | Выполнение тестов |
| `npm run set-role` | Изменение роли пользователя |
| `npm run parse:logs` | Анализ сетевых логов (`.ndjson`) |
| `npm run stress` | Нагрузочное тестирование |
| `npm run targets` | Запуск тестовых клиентов |
| `npm run patch:client` | Создание клиентского патча |
| `npm run patch:deploy` | Развёртывание патча |
| `npm run patch:list` | Просмотр списка патчей |
| `npm run extract:skyboxes` | Извлечение скайбоксов |
| `npm run tara` | Работа с архивами `.tara` |

---

# Структура проекта

```text
src/
├── server.ts          # Точка входа
├── config/            # Игровая конфигурация
├── core/              # Ядро проекта
├── features/          # Игровые модули
├── generated/         # Автоматически созданные файлы
├── maps/              # Карты и коллизии
├── packets/           # Регистрация игровых пакетов
├── server/            # Сетевой слой
├── shared/            # Общие компоненты
└── utils/             # Вспомогательные утилиты

scripts/               # Скрипты сборки и генерации
resources/             # Игровые ресурсы
tools/                 # Вспомогательные инструменты
```

---

# Статус

> [!NOTE]
> Разработка продолжается. Структура проекта, API и внутренние механизмы могут изменяться без сохранения обратной совместимости.

---

<div align="center">

### Made with ❤️ by **magister1o**

</div>