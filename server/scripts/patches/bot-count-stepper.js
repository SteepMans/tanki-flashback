'use strict';
/**
 * bot-count-stepper (library.swf): счётчик ботов в окне создания битвы.
 *
 * ЗАЧЕМ. Ботов сервер умеет подсаживать в бой, но сказать ему об этом при создании было нечем:
 * в пакете создания битвы поля под них нет, а добавить его нельзя — протокол разбирает и клиент.
 * Поэтому число едет меткой в конце названия боя (`#b6`), сервер её читает и убирает
 * (см. takeBotCount в lobby.handlers.ts), а здесь появляется обычный степпер, как «Мах игроков»:
 * набирать метку руками не нужно, и в списке битв её не видно.
 *
 * ЧТО МЕНЯЕТСЯ.
 *   1. Окно создания (класс вида `break switch var:5214232441232454123423632234`): новое поле под
 *      степпер, его создание в init, положение в конце resize и публичный метод getBotCount.
 *   2. Контроллер окна (`try function finally:5214237118237131123423632234`, onCreateBattle):
 *      дописывает метку к названию, но только если ботов заказали больше нуля.
 *
 * ГДЕ СТОИТ. Четвёртым в том же ряду, что «Мах игроков / Время / Уничтожений». Исходная формула
 * раскладки считает зазор на три поля и ветвится по режимам, поэтому в неё не влезаем: в конце
 * `resize` ряд раскладывается заново на четыре степпера, а ширина ряда берётся из того, что
 * оригинал только что посчитал (см. комментарий у RESIZE_CODE). Отдельной строкой степпер стоять
 * не может: при включённой PRO-битве прямо под рядом разворачивается список флажков формата и
 * налезает на него.
 */

// Класс окна создания битвы (вид) и класс-контроллер этого окна.
const VIEW_CLASS = /instance QName\(PackageNamespace\("break switch var"\), "5214232441232454123423632234"\)/;
const CONTROLLER_CLASS = /instance QName\(PackageNamespace\("try function finally"\), "5214237118237131123423632234"\)/;

// Приватное пространство имён вида и его поля со степперами ряда.
const NS = 'QName(PrivateNamespace("$58"), ';
const STEPPER_TYPE = 'QName(PackageNamespace("native switch finally"), "5214237359237372123423632234")';
const PLAYERS = NS + '"static catch case")';        // «Мах игроков» — первый в ряду
const TIME = NS + '"var const with")';              // «Время» — второй
const KILLS = NS + '"implements while if")';        // «Уничтожений» / «Флаги» — третий
const BOTS = NS + '"bot count stepper")';           // наше поле
const PUB = 'QName(PackageNamespace("", "#0"), ';
// Сеттеры компонента-степпера: минимум, максимум, значение. Имена обфусцированы, взяты из
// setSettingsPlayersLimit того же окна.
const MIN = PUB + '"throw true")';
const MAX = PUB + '"package super set")';
const VALUE = PUB + '"value")';
// «Боты» в байтах UTF-8: так строка не зависит от того, в какой кодировке инструмент прочитает файл.
const LABEL = '"\\xd0\\x91\\xd0\\xbe\\xd1\\x82\\xd1\\x8b"';
/** Потолок степпера. Тот же, что у сервера (MAX_BOTS_IN_BATTLE). */
const MAX_BOTS = 12;

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const ind = (line) => (line.endsWith(':') || line === '' ? line : '      ' + line);
const asm = (lines) => lines.map(ind).join('\n');
/** Инструкции подряд -> регулярка, терпимая к пустым строкам и переводам строки. */
const seq = (lines) => new RegExp(lines.map(esc).join('\\s*'), 'g');

/** Ровно одна замена: якорь, найденный дважды, означает, что мы метим не туда. */
function replaceOnce(text, pattern, make, what) {
    const found = text.match(pattern);
    if (!found) throw new Error(what + ': место не найдено');
    if (found.length > 1) throw new Error(what + ': найдено ' + found.length + ' мест, ожидалось одно');
    return text.replace(pattern, make);
}

// --- вид: поле под степпер ------------------------------------------------
const VIEW_SLOT_ANCHOR = seq(['  trait slot ' + PLAYERS + ' type ' + STEPPER_TYPE + ' end']);
const VIEW_SLOT = '\n  trait slot ' + BOTS + ' type ' + STEPPER_TYPE + ' end';

// --- вид: создание степпера в init ---------------------------------------
// Якорь — последняя строка настройки степпера «Мах игроков» (значок игрока, номер 6).
const INIT_ANCHOR = seq([
    'getlocal0',
    'getproperty         ' + PLAYERS,
    'pushbyte            6',
    'setproperty         ' + PUB + '"icon")',
]);

const INIT_CODE = '\n\n' + asm([
    'getlocal0',
    'findpropstrict      ' + STEPPER_TYPE,
    'constructprop       ' + STEPPER_TYPE + ', 0',
    'setproperty         ' + BOTS,
    '',
    'getlocal0',
    'getproperty         ' + BOTS,
    'pushstring          ' + LABEL,
    'setproperty         ' + PUB + '"label")',
    '',
    'getlocal0',
    'getproperty         ' + BOTS,
    'pushbyte            6',
    'setproperty         ' + PUB + '"icon")',
    '',
    'getlocal0',
    'getproperty         ' + BOTS,
    'pushbyte            0',
    'setproperty         ' + MIN,
    '',
    'getlocal0',
    'getproperty         ' + BOTS,
    'pushbyte            ' + MAX_BOTS,
    'setproperty         ' + MAX,
    '',
    'getlocal0',
    'getproperty         ' + BOTS,
    'pushbyte            0',
    'setproperty         ' + VALUE,
    '',
    'findpropstrict      ' + PUB + '"addChild")',
    'getlocal0',
    'getproperty         ' + BOTS,
    'callpropvoid        ' + PUB + '"addChild"), 1',
]);

// --- вид: раскладка ряда степперов в конце resize -------------------------
/**
 * Ряд «Мах игроков / Время / Уничтожений» раскладывается выше по методу: зазор считается как
 * (ширина ряда - сумма ширин) / 4, а сами координаты — с ветвлениями на режимы. Влезать в ту
 * формулу, чтобы добавить четвёртое поле, значит переписывать её целиком; вместо этого в конце
 * метода ряд раскладывается заново — уже на четыре степпера.
 *
 * Ширину ряда берём из того, что оригинал только что посчитал: правый край третьего степпера плюс
 * тот же отступ, что достался первому слева. Так раскладка остаётся правильной при любой ширине
 * окна и не зависит от внутренностей исходной формулы.
 *
 * Локали 13..18 — временные (в заголовке метода их количество поднимается ниже).
 */
const ROW_LOCALS = { w1: 13, w2: 14, w3: 15, w4: 16, row: 17, gap: 18 };
const LOCAL_COUNT = 19;

const RESIZE_TAIL = seq([
    'getlocal0',
    'getproperty         ' + NS + '"5214233112233125123423632234")',
    'callpropvoid        ' + PUB + '"native native"), 0',
    'returnvoid',
]);

/** Ширина степпера в локаль. */
const widthTo = (field, local) => [
    'getlocal0',
    'getproperty         ' + field,
    'getproperty         ' + PUB + '"width")',
    'setlocal            ' + local,
];

/** `stepper.x = смещение`, где смещение уже лежит на стеке после вызова. */
const xFrom = (field, offset) => ['getlocal0', 'getproperty         ' + field, ...offset, 'setproperty         ' + PUB + '"x")'];

const RESIZE_CODE = asm([
    'getlocal0',
    'getproperty         ' + NS + '"5214233112233125123423632234")',
    'callpropvoid        ' + PUB + '"native native"), 0',
    '',
    ...widthTo(PLAYERS, ROW_LOCALS.w1),
    ...widthTo(TIME, ROW_LOCALS.w2),
    ...widthTo(KILLS, ROW_LOCALS.w3),
    ...widthTo(BOTS, ROW_LOCALS.w4),
    '',
    // ширина ряда = правый край третьего степпера + отступ слева у первого
    'getlocal0',
    'getproperty         ' + KILLS,
    'getproperty         ' + PUB + '"x")',
    'getlocal            ' + ROW_LOCALS.w3,
    'add',
    'getlocal0',
    'getproperty         ' + PLAYERS,
    'getproperty         ' + PUB + '"x")',
    'add',
    'setlocal            ' + ROW_LOCALS.row,
    '',
    // зазор = (ширина ряда - сумма четырёх ширин) / 5
    'getlocal            ' + ROW_LOCALS.row,
    'getlocal            ' + ROW_LOCALS.w1,
    'subtract',
    'getlocal            ' + ROW_LOCALS.w2,
    'subtract',
    'getlocal            ' + ROW_LOCALS.w3,
    'subtract',
    'getlocal            ' + ROW_LOCALS.w4,
    'subtract',
    'pushbyte            5',
    'divide',
    'convert_i',
    'setlocal            ' + ROW_LOCALS.gap,
    '',
    ...xFrom(PLAYERS, ['getlocal            ' + ROW_LOCALS.gap]),
    ...xFrom(TIME, [
        'getlocal            ' + ROW_LOCALS.w1,
        'getlocal            ' + ROW_LOCALS.gap,
        'pushbyte            2',
        'multiply',
        'add',
    ]),
    ...xFrom(KILLS, [
        'getlocal            ' + ROW_LOCALS.w1,
        'getlocal            ' + ROW_LOCALS.w2,
        'add',
        'getlocal            ' + ROW_LOCALS.gap,
        'pushbyte            3',
        'multiply',
        'add',
    ]),
    ...xFrom(BOTS, [
        'getlocal            ' + ROW_LOCALS.w1,
        'getlocal            ' + ROW_LOCALS.w2,
        'add',
        'getlocal            ' + ROW_LOCALS.w3,
        'add',
        'getlocal            ' + ROW_LOCALS.gap,
        'pushbyte            4',
        'multiply',
        'add',
    ]),
    '',
    // по вертикали — вровень с рядом
    'getlocal0',
    'getproperty         ' + BOTS,
    'getlocal0',
    'getproperty         ' + PLAYERS,
    'getproperty         ' + PUB + '"y")',
    'setproperty         ' + PUB + '"y")',
    '',
    'returnvoid',
]);

/** Заголовок resize: под временные локали нужно поднять их количество. */
const RESIZE_LOCALS = /(name "resize"[\s\S]{0,400}?maxstack \d+\s*\n\s*localcount )13/;

// --- вид: публичный getBotCount ------------------------------------------
const VIEW_METHOD = [
    '  trait method ' + PUB + '"getBotCount")',
    '   method',
    '    name "getBotCount"',
    '    refid "break switch var:5214232441232454123423632234/instance/getBotCount"',
    '    returns ' + PUB + '"int")',
    '    body',
    '     maxstack 2',
    '     localcount 1',
    '     initscopedepth 0',
    '     maxscopedepth 1',
    '     code',
    '      getlocal0',
    '      pushscope',
    '',
    '      getlocal0',
    '      getproperty         ' + BOTS,
    '      pushnull',
    '      ifeq                LbotStepperMissing',
    '',
    '      getlocal0',
    '      getproperty         ' + BOTS,
    '      getproperty         ' + VALUE,
    '      returnvalue',
    '',
    'LbotStepperMissing:',
    '      pushbyte            0',
    '      returnvalue',
    '     end ; code',
    '    end ; body',
    '   end ; method',
    '  end ; trait',
    '',
].join('\n');

// --- контроллер: метка в названии боя ------------------------------------
const VIEW_FIELD = 'QName(PrivateNamespace("$92"), "dynamic function throw")';
const NAME_ANCHOR = seq([
    'getlocal1',
    'getlocal0',
    'getproperty         ' + VIEW_FIELD,
    'callproperty        ' + PUB + '"521423108532310866123423632234"), 0',
    'setproperty         ' + PUB + '"name")',
]);

const NAME_CODE = asm([
    'getlocal1',
    'getlocal0',
    'getproperty         ' + VIEW_FIELD,
    'callproperty        ' + PUB + '"521423108532310866123423632234"), 0',
    'setproperty         ' + PUB + '"name")',
    '',
    'getlocal0',
    'getproperty         ' + VIEW_FIELD,
    'callproperty        ' + PUB + '"getBotCount"), 0',
    'pushbyte            0',
    'ifngt               LbotCountNotRequested',
    '',
    'getlocal1',
    'getlocal1',
    'getproperty         ' + PUB + '"name")',
    'pushstring          " #b"',
    'add',
    'getlocal0',
    'getproperty         ' + VIEW_FIELD,
    'callproperty        ' + PUB + '"getBotCount"), 0',
    'add',
    'setproperty         ' + PUB + '"name")',
    '',
    'LbotCountNotRequested:',
]);

module.exports = {
    id: 'bot-count-stepper',
    swf: 'library',
    description: 'Добавляет счётчик ботов в окно создания битвы (метка #bN в названии).',

    apply({ classes, log }) {
        let view = 0, controller = 0, already = 0;

        for (const c of classes) {
            if (VIEW_CLASS.test(c.text)) {
                if (c.text.includes('"bot count stepper"')) { already++; continue; }
                if (!/^ end ; instance$/m.test(c.text)) throw new Error('конец описания экземпляра не найден');

                if (!RESIZE_LOCALS.test(c.text)) throw new Error('заголовок resize не найден (localcount уже другой?)');
                let text = c.text.replace(RESIZE_LOCALS, `$1${LOCAL_COUNT}`);
                text = replaceOnce(text, VIEW_SLOT_ANCHOR, (m) => m + VIEW_SLOT, 'поле степпера');
                text = replaceOnce(text, INIT_ANCHOR, (m) => m + INIT_CODE, 'создание степпера в init');
                text = replaceOnce(text, RESIZE_TAIL, () => RESIZE_CODE, 'хвост resize');
                text = text.replace(/^ end ; instance$/m, () => VIEW_METHOD + ' end ; instance');
                c.save(text);
                view++;
                continue;
            }

            if (CONTROLLER_CLASS.test(c.text)) {
                if (c.text.includes('"getBotCount"')) { already++; continue; }
                c.save(replaceOnce(c.text, NAME_ANCHOR, () => NAME_CODE, 'запись названия боя в onCreateBattle'));
                controller++;
            }
        }

        if (!view && !controller && already) return { edits: 0, note: 'уже применён' };
        if (!view) throw new Error('класс окна создания битвы не найден — база точно library.swf?');
        if (!controller) throw new Error('класс-контроллер окна создания битвы не найден');

        log('счётчик ботов в окне создания битвы: потолок ' + MAX_BOTS);
        return { edits: view + controller };
    },
};
