/**
 * Выгрузка и замена картинок, ЗАШИТЫХ В САМ SWF клиента.
 *
 * Часть графики игрок видит не из ресурсов (`.tara`, ими занимается `art.ts`), а из библиотеки
 * клиента: заставка на загрузке, промо-полоски в магазине и прочее лежат прямо в `library.swf`
 * отдельными символами-битмапами. Переиздание ресурсов их не трогает, отсюда и «эту картинку не
 * заменили».
 *
 *   npx ts-node scripts/swf-art.ts list                    что зашито в библиотеке (крупные картинки)
 *   npx ts-node scripts/swf-art.ts export [папка]          выгрузить известные (по умолчанию art-export/)
 *   npx ts-node scripts/swf-art.ts import [папка]          вернуть заменённые обратно в SWF
 *
 * `import` правит ИСХОДНЫЙ `resources/library.swf` — тот, из которого собираются и обычный клиент,
 * и браузерный. После него нужно пересобрать раздачу:
 *
 *   npm run patch:webclient && npm run patch:deploy
 *
 * Размер новой картинки должен совпадать с исходной: в SWF у символа нет полей ширины и высоты,
 * их берут из самого JPEG, а координаты и масштаб на сцене посчитаны под исходный размер. И JPEG
 * должен быть обычный (baseline), не прогрессивный: прогрессивный Flash не покажет.
 */
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

const ROOT = path.join(__dirname, "..");
const RABCDASM = path.join(ROOT, "tools", "rabcdasm");

/** Что умеем менять. `id` — номер символа в SWF, его печатает команда `list`. */
const TARGETS: { swf: string; id: number; file: string; note: string }[] = [
    { swf: "library", id: 97, file: "loading/library_splash.jpg", note: "заставка с логотипом на загрузке клиента" },
];

/** Теги SWF с картинками. Нас интересует только JPEG без альфы — в нём лежит готовый файл. */
const TAG_DEFINE_BITS_JPEG2 = 21;
const TAG_DEFINE_BITS_JPEG3 = 35;
const TAG_DEFINE_BITS_JPEG4 = 90;
const TAG_END = 0;

interface SwfTag {
    code: number;
    /** Смещение начала тега (с заголовком) в распакованном файле. */
    start: number;
    /** Тело тега без заголовка. */
    body: Buffer;
}

/** Распаковывает SWF во временный файл и отдаёт его содержимое. Сжатие бывает ZWS (LZMA) и CWS (zlib). */
function readDecompressed(file: string): { data: Buffer; wasCompressed: boolean } {
    const raw = fs.readFileSync(file);
    const signature = raw.subarray(0, 3).toString("latin1");
    if (signature === "FWS") return { data: raw, wasCompressed: false };

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "swfart-"));
    const copy = path.join(tmp, "work.swf");
    fs.copyFileSync(file, copy);
    execFileSync(path.join(RABCDASM, "swfdecompress.exe"), [copy], { stdio: ["ignore", "pipe", "pipe"] });
    const data = fs.readFileSync(copy);
    fs.rmSync(tmp, { recursive: true, force: true });
    return { data, wasCompressed: true };
}

/** Пишет SWF обратно, при необходимости сжимая тем же LZMA, которым он был сжат. */
function writeMaybeCompressed(file: string, data: Buffer, compress: boolean): void {
    if (!compress) {
        fs.writeFileSync(file, data);
        return;
    }
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "swfart-"));
    const copy = path.join(tmp, "work.swf");
    fs.writeFileSync(copy, data);
    execFileSync(path.join(RABCDASM, "swflzmacompress.exe"), [copy], { stdio: ["ignore", "pipe", "pipe"] });
    fs.copyFileSync(copy, file);
    fs.rmSync(tmp, { recursive: true, force: true });
}

/** Начало списка тегов: заголовок + прямоугольник сцены + частота кадров + число кадров. */
function tagsOffset(data: Buffer): number {
    let pos = 8;
    const nbits = data[pos] >> 3;
    pos += Math.ceil((5 + nbits * 4) / 8);
    return pos + 4;
}

function readTags(data: Buffer): SwfTag[] {
    const tags: SwfTag[] = [];
    let pos = tagsOffset(data);
    while (pos + 2 <= data.length) {
        const start = pos;
        const codeAndLength = data.readUInt16LE(pos);
        pos += 2;
        const code = codeAndLength >> 6;
        let length = codeAndLength & 0x3f;
        if (length === 0x3f) {
            length = data.readUInt32LE(pos);
            pos += 4;
        }
        tags.push({ code, start, body: data.subarray(pos, pos + length) });
        pos += length;
        if (code === TAG_END) break;
    }
    return tags;
}

/** JPEG из тега. У JPEG2 это всё тело после номера символа, у JPEG3/4 — кусок до альфа-канала. */
function jpegOf(tag: SwfTag): Buffer | null {
    if (tag.code === TAG_DEFINE_BITS_JPEG2) return stripSwfPrefix(tag.body.subarray(2));
    if (tag.code === TAG_DEFINE_BITS_JPEG3 || tag.code === TAG_DEFINE_BITS_JPEG4) {
        const alphaOffset = tag.body.readUInt32LE(2);
        const dataStart = tag.code === TAG_DEFINE_BITS_JPEG3 ? 6 : 8;
        return stripSwfPrefix(tag.body.subarray(dataStart, dataStart + alphaOffset));
    }
    return null;
}

/**
 * Старые SWF кладут перед картинкой заглушку из пустой JPEG-таблицы (FF D9 FF D8) — её нужно снять,
 * иначе получится файл, который не откроет ни один просмотрщик.
 */
function stripSwfPrefix(jpeg: Buffer): Buffer {
    return jpeg.subarray(0, 4).equals(Buffer.from([0xff, 0xd9, 0xff, 0xd8])) ? jpeg.subarray(4) : jpeg;
}

/** Размер картинки из заголовка JPEG (SOF0..SOF3): нужен, чтобы не подсунуть замену другого размера. */
function jpegSize(jpeg: Buffer): { width: number; height: number } | null {
    let pos = 2;
    while (pos + 9 < jpeg.length) {
        if (jpeg[pos] !== 0xff) {
            pos++;
            continue;
        }
        const marker = jpeg[pos + 1];
        // Маркеры без поля длины: заполнитель, начало/конец картинки и метки перезапуска.
        if (marker === 0xff || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
            pos += 2;
            continue;
        }
        // SOF0..SOF3 и SOF5..SOF7 — обычные кадры, размер лежит в них. SOF4 (0xc4) это таблица Хаффмана.
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
            return { height: jpeg.readUInt16BE(pos + 5), width: jpeg.readUInt16BE(pos + 7) };
        }
        pos += 2 + jpeg.readUInt16BE(pos + 2);
    }
    return null;
}

function isProgressive(jpeg: Buffer): boolean {
    for (let pos = 2; pos + 3 < jpeg.length; ) {
        if (jpeg[pos] !== 0xff) {
            pos++;
            continue;
        }
        const marker = jpeg[pos + 1];
        if (marker === 0xc2) return true;
        if (marker >= 0xc0 && marker <= 0xc3) return false;
        pos += 2 + jpeg.readUInt16BE(pos + 2);
    }
    return false;
}

function swfPath(name: string): string {
    return path.join(ROOT, "resources", `${name}.swf`);
}

function list(): void {
    for (const name of new Set(TARGETS.map((t) => t.swf))) {
        const { data } = readDecompressed(swfPath(name));
        const rows = readTags(data)
            .map((tag) => ({ tag, jpeg: jpegOf(tag) }))
            .filter((row): row is { tag: SwfTag; jpeg: Buffer } => !!row.jpeg && row.jpeg.length > 8000)
            .map(({ tag, jpeg }) => ({ id: tag.body.readUInt16LE(0), size: jpegSize(jpeg), bytes: jpeg.length }))
            .sort((a, b) => b.bytes - a.bytes);
        console.log(`${name}.swf: крупных картинок ${rows.length}`);
        for (const row of rows) {
            const known = TARGETS.find((t) => t.swf === name && t.id === row.id);
            const size = row.size ? `${row.size.width}x${row.size.height}` : "размер не разобран";
            console.log(`   id=${String(row.id).padStart(4)}  ${size.padEnd(12)} ${(row.bytes / 1024).toFixed(0).padStart(4)} КБ${known ? "  <- " + known.note : ""}`);
        }
    }
}

function exportAll(dir: string): void {
    for (const target of TARGETS) {
        const { data } = readDecompressed(swfPath(target.swf));
        const tag = readTags(data).find((t) => jpegOf(t) && t.body.readUInt16LE(0) === target.id);
        if (!tag) throw new Error(`в ${target.swf}.swf нет картинки с номером ${target.id}`);
        const jpeg = jpegOf(tag)!;
        const out = path.join(dir, target.file);
        fs.mkdirSync(path.dirname(out), { recursive: true });
        fs.writeFileSync(out, jpeg);
        const size = jpegSize(jpeg);
        console.log(`выгружено ${target.file} (${size ? `${size.width}x${size.height}` : "?"}, ${(jpeg.length / 1024).toFixed(0)} КБ) — ${target.note}`);
    }
    console.log("\nЗамену клади под тем же именем и того же размера, JPEG обычный (не прогрессивный).");
}

function importAll(dir: string): void {
    let changed = 0;
    for (const swfName of new Set(TARGETS.map((t) => t.swf))) {
        const file = swfPath(swfName);
        const { data, wasCompressed } = readDecompressed(file);
        let out = data;

        for (const target of TARGETS.filter((t) => t.swf === swfName)) {
            const replacement = path.join(dir, target.file);
            if (!fs.existsSync(replacement)) {
                console.log(`пропуск ${target.file}: файла нет`);
                continue;
            }
            const tag = readTags(out).find((t) => jpegOf(t) && t.body.readUInt16LE(0) === target.id);
            if (!tag) throw new Error(`в ${swfName}.swf нет картинки с номером ${target.id}`);
            if (tag.code !== TAG_DEFINE_BITS_JPEG2) {
                throw new Error(`картинка ${target.id} лежит в теге ${tag.code}, замена написана только для JPEG без альфы`);
            }

            const current = jpegOf(tag)!;
            const next = fs.readFileSync(replacement);
            if (next.subarray(0, 2).toString("hex") !== "ffd8") throw new Error(`${target.file}: это не JPEG`);
            if (isProgressive(next)) throw new Error(`${target.file}: прогрессивный JPEG, Flash его не покажет — пересохрани обычным`);

            const was = jpegSize(current);
            const now = jpegSize(next);
            if (was && now && (was.width !== now.width || was.height !== now.height)) {
                throw new Error(`${target.file}: размер ${now.width}x${now.height}, а нужен ${was.width}x${was.height} — иначе картинка поедет по сцене`);
            }
            if (current.equals(next)) {
                console.log(`пропуск ${target.file}: не менялась`);
                continue;
            }

            out = replaceTag(out, tag, Buffer.concat([tag.body.subarray(0, 2), next]));
            changed++;
            console.log(`заменено ${target.file}: ${(current.length / 1024).toFixed(0)} КБ -> ${(next.length / 1024).toFixed(0)} КБ`);
        }

        if (changed) writeMaybeCompressed(file, out, wasCompressed);
    }

    if (!changed) {
        console.log("менять нечего");
        return;
    }
    console.log("\nГотово. Теперь пересобери раздачу: npm run patch:webclient && npm run patch:deploy");
}

/** Перекладывает файл, подменив тело одного тега; заголовок тега и длину файла пересчитывает. */
function replaceTag(data: Buffer, tag: SwfTag, body: Buffer): Buffer {
    const before = data.subarray(0, tag.start);
    const after = data.subarray(tag.body.byteOffset + tag.body.length);

    // Длинная форма заголовка (0x3F в младших битах + отдельное поле длины) годится для любой длины.
    const header = Buffer.alloc(6);
    header.writeUInt16LE((tag.code << 6) | 0x3f, 0);
    header.writeUInt32LE(body.length, 2);

    const out = Buffer.concat([before, header, body, after]);
    out.writeUInt32LE(out.length, 4); // FileLength в заголовке SWF считает распакованный размер
    return out;
}

const [command, dirArg] = process.argv.slice(2);
const dir = path.join(ROOT, dirArg || "art-export");
try {
    if (command === "list") list();
    else if (command === "export") exportAll(dir);
    else if (command === "import") importAll(dir);
    else console.log("команды: list | export [папка] | import [папка]");
} catch (error: any) {
    console.error("ОШИБКА:", error.message);
    process.exit(1);
}
