# Client research

Записи разбора официального клиента: формат кадра, схема сериализации, цепочка загрузки и
обфускация тела пакета. Это то, из чего выросла серверная реализация в `../server` — без этих
заметок непонятно, почему сервер отвечает именно так.

## Структура

```
tools/               парсер SWF/ABC и дизассемблер AVM2 (Python 3, без зависимостей)
```

Сами SWF клиента и дампы их декомпиляции в репозиторий не входят: это чужой код. Инструменты
работают с любым SWF — приложите свой файл и получите те же данные.

## Инструменты

```bash
python tools/swfabc.py  <file.swf>            # распаковка + константный пул строк
python tools/abcdump.py <file.swf> [filter]   # классы, интерфейсы, трейты
python tools/dis.py     <file.swf> <needle>   # дизассемблировать методы, чей байткод
                                              # содержит подстроку (имя, литерал, опкод)
```

`swfabc.py` умеет FWS/CWS/ZWS (в ZWS-заголовке размер несовместим с lzma-alone,
поэтому подставляется маркер неизвестного размера).

Пример — найти цикл разбора сетевого кадра:

```bash
python tools/dis.py library.swf "packetLength"
```

## Цепочка загрузки

```
ProTanki.exe (AIR captive runtime)
  └─ StandaloneLoader.swf          единственный код в установщике
       ├─ версия из application.xml, сверка с актуальной → Alert через StageWebView
       ├─ перебор зашитых зеркал (в патченом клиенте — localhost:9999)
       └─ GET /Prelauncher.swf?rand=<random>  → Loader.loadBytes(allowCodeImport = true)
            └─ Loader.swf (GameLoader, alternativa.ILauncherListener)
                 ├─ GET /config.xml?rand=  → address, port, status
                 │    status: available | overloaded | unavailable | notavailable | detect
                 ├─ GPUCapabilities: проба Stage3D (requestContext3D, baselineConstrained,
                 │    driverInfo содержит "software") → hardware.swf либо software.swf
                 ├─ GET /library.swf
                 └─ getDefinition('Game')
```

Ошибки грузят `/TanksErrorScreen.swf`; локали `RU, EN, DE, CN, PT_BR`.

## config.xml

```xml
<cfg xmlns="http://alternativaplatform.com/core/config.xsd">
<server address="127.0.0.1"><port>1337</port></server>
<status>available</status>
</cfg>
```

Ресурсный HTTP-хост и игровой TCP-хост — разные. Сервер из `../server` отдаёт
свой config.xml на `RESOURCE_PORT` и слушает игру на `PORT`.

## Транспорт

Сырой TCP через `flash.net.Socket`, без TLS.
Слушатели: `socketData`, `connect`, `close`, `ioError`, `securityError`.

Тело пакета скрембится самомодифицирующимся XOR-потоком (не шифрование, а обфускация:
ключ уходит клиенту открытым текстом). Реализация со стороны сервера —
`../server/src/core/security/security.service.ts`:

- 8 байт состояния, позиция в ключе гуляет: `pos ^= byte & 7`
- ключ мутирует на каждом байте, поэтому поток нельзя расшифровать с середины
- `decrypt_key[i] = encrypt_key[i] ^ 87`
- 4 стартовых байта (каждый в диапазоне -1..-120) сервер шлёт первым пакетом

Первый кадр от сервера, снятый с живого соединения:

```
00000010 7750 12c4 00000004 e4c7bbb1
 length=16  packetId=2001736388  vector<int8>: length=4, [-28,-57,-69,-79]
```

Заголовок и длина вектора — открытым текстом, что подтверждает и формат кадра,
и схему кодирования векторов, описанные ниже.

## Формат кадра

Из `library.swf`, обработчик `socketData`:

| поле     | размер      | смысл |
|----------|-------------|-------|
| header   | 4 байта BE  | биты 0..23 — полная длина кадра (8 + тело); бит `0x40` старшего байта — тело сжато zlib |
| packetId | 4 байта BE  | идентификатор пакета |
| body     | length - 8  | поля, сериализованные кодеками |

```
header = readInt()
compressed = (header >>> 24 & 0x40) != 0
length     = header & 0xFFFFFF
packetId   = readInt()
payloadLen = length - 8
if (socket.bytesAvailable < payloadLen) -> ждать следующего socketData
readBytes(buffer, 0, payloadLen)
if (compressed) buffer.inflate()
getPacket(packetId).decode(buffer) -> слушатели
```

Отправка симметрична и без сжатия: тело собирается кодеками в общий ByteArray,
затем `writeInt(8 + body.length)`, `writeInt(packetId)`, `writeBytes(body)`, `flush()`.
Сжимает только сервер.

Приём устойчив к фрагментации TCP: состояние кадра хранится в полях объекта,
недочитанный кадр переносится на следующее событие.

## Сериализация

Рефлективная, кодек выбирается по имени типа поля:

```
scpacker.networking.protocol.codec.custom.CodecBattleTeam
                                          CodecBattleMode
                                          CodecBonusType
                                          CodecControlPointState
                                          CodecIsisState
                                          CodecChatModeratorLevel
                                          CodecClanAction / CodecClanPermission
                                          CodecItemCategoryEnum / CodecItemViewCategoryEnum
                                          CodecDamageIndicatorType
                                          CodecBattleSuspicionLevel
                                          CodecEquipmentConstraintsMode
                                          CodecLayoutState / CodecMapTheme
                                          CodecAchievement / CodecValidationStatus
                                          CaptchaLocationCodec
```

Векторы: если кодек по имени типа не найден и имя содержит `.Vector`, ищется кодек
элемента, значение пишется как `writeInt(length)` + элементы. Nullable-поля требуют
аннотации `@ProtocolOptional` (иначе рантайм-ошибка `Object is null...`).
Отсутствие кодека — `Error('Codec not found' + type)`.

API уровня протокола: `registerPacket`, `getPacket`, `getPacketId`, `addCodec`, `getCodec`,
`addPacketListener`, `removePacketListener`, `onPacketLoadingStart`, `onPacketLoadingStop`.

При сбое декодирования клиент логирует `error packet %1 packetLength %2 packetId %3`
вместе со стектрейсом, ником, рангом и временем сессии.

## Ресурсы

Отдельный HTTP-слой. URL: `http://<mirror>/<a>/<b>/<c>/<d>/<version>/<file>`,
где version — восьмеричный таймстамп. Клиент кэширует в
`%APPDATA%\StandaloneLoader\Local Store\cache\`, имя файла — base64 полного URL,
поэтому новая версия ресурса = новый URL = промах кэша; инвалидации нет.

Типы: `image.jpg`, `alpha.jpg` (альфа отдельным JPEG), `images.xml`, `object.3ds`,
`lightmap.jpg`, `details.jpg`, `sound.swf`, `map.xml`, `proplibs.xml`,
`image.tara`, `library.tara`.

`.tara` — контейнер: счётчик записей, таблица (offset, length), затем склеенные файлы.

## Настройки клиента

`%APPDATA%\StandaloneLoader\Local Store\#SharedObjects\StandaloneLoader.swf\`:

- `accounts.sol` — логин и пароль в обратимом кодировании (не хэш)
- `name.sol` — `userHash`, `userName`, биндинги, графические флаги, `blocklist`
- `performance.sol` — бенчмарк-скор и профиль качества
- `launcherStorage.sol` — `LAST_LOCALE`

## Не восстановлено

Боевая синхронизация. Классы в `library.swf` обфусцированы (имена вида
`$591:521423188552318868123423632234`), читаемых сигнатур нет. В пуле строк видны
следы клиентского предсказания и интерполяции:

```
addPhysicsController, addPhysicsInterpolator, addPostPhysicsController,
interpolatePhysicsState, getInterpolatedDirection,
fullMoveCommand, copyMoveCommand, isMoveCommandsAlmostEquals,
ServerFightCommandAlreadySentFlag
```

`isMoveCommandsAlmostEquals` + `fullMoveCommand` указывают на дельта-отправку команд
движения, `addPhysicsInterpolator` — на интерполяцию чужих танков. Частота отправки,
схема коррекции позиции и серверная валидация по байткоду не восстановлены.
Следующий шаг, если понадобится: раскрутить граф вызовов от `addPacketListener`
до моделей боя.
