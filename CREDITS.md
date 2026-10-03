# Кредиты и лицензии

Проект собран из нескольких чужих работ. Здесь — кто что сделал и под какой лицензией это лежит.
Короткая сводка в `LICENSE`, полная картина здесь.

## Что чьё

| Часть дерева | Автор | Лицензия | Файл лицензии |
|---|---|---|---|
| `server/` — серверная реализация | [magister1o](https://github.com/magister1o) (ProTanki-Server-2.0, Copyright (c) 2026 Bogdan) и [Danilo Palmeira](https://github.com/DaniloPalmeira) ([letanki/server](https://github.com/letanki/server)) | MIT | `server/LICENSE` |
| `server/` — наши доработки: боты, веб-клиент, ресурсный сервер, перенос на MySQL, патчи клиента | Konstantin ([SteepMans](https://github.com/SteepMans)) | PolyForm Noncommercial 1.0.0 | `LICENSE` |
| `ruffle-patches/` — 56 патчей к Ruffle | Konstantin | MIT OR Apache-2.0, как у Ruffle | `ruffle-patches/LICENSE` |
| `client-research/tools/` — парсер SWF/ABC и дизассемблер AVM2 | Konstantin | PolyForm Noncommercial 1.0.0 | `LICENSE` |
| `server/webclient/` — страница-обёртка, e2e и soak-тесты | Konstantin | PolyForm Noncommercial 1.0.0 | `LICENSE` |

## Апстрим серверной части

Серверная часть выросла из [ProTanki-Server-2.0](https://github.com/magister1o) — реализации
серверного протокола на TypeScript под старый клиент. Та, в свою очередь, продолжает
[letanki/server](https://github.com/letanki/server) Данило Палмейры; оттуда же приходит зависимость
[protanki-protocol](https://github.com/DaniloPalmeira/protanki-protocol). Часть комментариев в
`server/src` до сих пор на португальском — это следы апстрима, и мы их не переписываем ради
переписывания.

Апстрим под MIT, его текст лежит нетронутым в `server/LICENSE`. MIT разрешает сублицензирование,
поэтому собранная работа целиком раздаётся по PolyForm Noncommercial. Это не отменяет MIT у
апстрима: оригинал как был, так и остаётся доступен у авторов на условиях MIT, и любой может взять
его оттуда без наших ограничений.

## Ruffle

Браузерный клиент работает на [Ruffle](https://ruffle.rs) — эмуляторе Flash на Rust и WebAssembly,
под MIT OR Apache-2.0. Сам Ruffle в репозиторий не вендорится: в `ruffle-patches/` лежат 56 патчей
поверх закреплённого коммита апстрима, инструкция — в `ruffle-patches/README.md`.

Патчи оставлены под лицензией самого Ruffle (MIT OR Apache-2.0), а не под PolyForm Noncommercial:
патч — производная работа от Ruffle, и под некоммерческой лицензией его нельзя было бы предложить
апстриму. Если это не то, что нужно, достаточно заменить `ruffle-patches/LICENSE`.

## Инструменты, которые нужны для сборки, но в репозиторий не входят

- [RABCDAsm](https://github.com/CyberShadow/RABCDAsm) Владимира Пантелеева (GPL-2.0) — разборка и
  сборка ABC внутри SWF. Нужен для `npm run patch:*`. Скачивается отдельно, см. README.
- [JPEXS Free Flash Decompiler](https://github.com/jindrapetrik/jpexs-decompiler) (GPL-3.0) —
  опционально, переменная `FFDEC`.
- [websockify](https://github.com/novnc/websockify) (LGPL-3.0) — мост WebSocket → TCP для
  браузерного клиента.

## Игра

Tanki Online и ProTanki, их товарные знаки, игровой клиент, игровые ресурсы и художественное
оформление принадлежат правообладателям. Этот проект с ними не связан, ими не одобрен и ничего из
их материалов не распространяет: в репозитории нет ни игровых ресурсов, ни клиента, ни
декомпилированного клиентского кода. Платформа 3D-движка оригинала —
[Alternativa Platform](http://alternativaplatform.com).
