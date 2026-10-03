/**
 * Выгрузка и обратная сборка картинок, которые видит игрок: плакаты (рекламные щиты на картах) и
 * баннеры загрузки.
 *
 * Плакаты лежат внутри `.tara` вместе с моделью щита, поэтому руками их не подменить: скрипт
 * достаёт из архива нужный блоб, а на обратном ходу кладёт его на место, сохраняя порядок записей
 * (остальное содержимое архива не трогается).
 *
 *   npx ts-node scripts/art.ts export [папка]     выгрузить (по умолчанию art-export/)
 *   npx ts-node scripts/art.ts import [папка]     вернуть заменённые картинки в игру
 *   npx ts-node scripts/art.ts import [папка] --bump   то же, но новой версией ресурса
 *   npx ts-node scripts/art.ts import [папка] --bump --only=flags,tips   только эти ресурсы
 *
 * `import` пишет и в `resources/` (исходники), и в `.resource/` (то, что реально раздаётся), так
 * что перезапуск сервера не нужен.
 *
 * Но перезагрузка клиента НЕ помогает: ресурсы отдаются с `Cache-Control: immutable` на год (см.
 * resource.server.ts), а адрес ресурса в него не меняется, пока не меняется версия. Браузер, который
 * хоть раз видел старую картинку, будет показывать её и дальше — даже по Ctrl+F5, потому что игру
 * рисует Ruffle и картинки тянет из скрипта, а жёсткая перезагрузка на такие запросы не действует.
 *
 * Поэтому картинку, которую игроки уже видели, надо выкладывать новой версией: `--bump` кладёт её в
 * v+1, у ресурса меняется адрес, и старый кэш оказывается ни при чём. С `--bump` берутся ВСЕ картинки
 * из манифеста, а не только изменившиеся: переиздать нужно и то, что уже импортировано, иначе
 * повторить выкладку нечем. `--only` ограничивает список ресурсов по началу их id.
 *
 * После `--bump` нужно пересобрать раздачу:
 *
 *   npm run build:resources && npm run patch:deploy && npm run patch:webclient
 */
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { parseTara, buildTara } from "./tara";
import { ResourceData } from "../src/generated/resourceTypes";

const ROOT = path.join(__dirname, "..");
const RESOURCES = path.join(ROOT, "resources");
const BUILD = path.join(ROOT, ".resource");

/** Что выгружаем. Ключ — id ресурса (как в resourceTypes), группа — папка в выгрузке. */
const TARGETS: { id: string; group: string; note: string }[] = [
    { id: "library/promotion", group: "posters", note: "рекламный щит на летних картах" },
    { id: "library/promotion_winter", group: "posters", note: "он же на зимних картах" },
    { id: "library/ny", group: "posters", note: "новогодние баннеры и ёлка" },
    { id: "flags/red_flag_sprite", group: "flags", note: "полотнище красного флага (image + alpha-маска)" },
    { id: "flags/blue_flag_sprite", group: "flags", note: "полотнище синего флага (image + alpha-маска)" },
    { id: "flags/red_pedestal", group: "flags", note: "подставка красного флага" },
    { id: "flags/blue_pedestal", group: "flags", note: "подставка синего флага" },
    { id: "tips/tip_1", group: "loading", note: "баннер-подсказка на загрузке боя" },
    { id: "tips/tip_2", group: "loading", note: "баннер-подсказка на загрузке боя" },
    { id: "tips/tip_3", group: "loading", note: "баннер-подсказка на загрузке боя" },
    { id: "ui/login_background", group: "loading", note: "фон экрана входа" },
];

interface Item {
    /** Путь картинки внутри папки выгрузки. */
    file: string;
    resource: string;
    /** Папка версии в resources/ (например v55). */
    version: string;
    /** Имя записи внутри library.tara — либо null, если это отдельный файл. */
    entry: string | null;
    /** Имя файла в папке версии (для не-tara ресурсов). */
    name: string;
    size: string;
    sha1: string;
    note: string;
}

const sha1 = (data: Buffer) => crypto.createHash("sha1").update(data).digest("hex");
const isImage = (data: Buffer) =>
    (data.length > 3 && data[0] === 0xff && data[1] === 0xd8) ||
    (data.length > 8 && data[0] === 0x89 && data[1] === 0x50);

/** Размер картинки из заголовка — чтобы в выгрузке было видно, во что укладываться. */
function imageSize(data: Buffer): string {
    if (data[0] === 0x89 && data[1] === 0x50) {
        return `${data.readUInt32BE(16)}x${data.readUInt32BE(20)}`;
    }
    let off = 2;
    while (off + 9 < data.length) {
        if (data[off] !== 0xff) { off++; continue; }
        const marker = data[off + 1];
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
            return `${data.readUInt16BE(off + 7)}x${data.readUInt16BE(off + 5)}`;
        }
        off += 2 + data.readUInt16BE(off + 2);
    }
    return "?";
}

function latestVersionDir(id: string): string {
    const dir = path.join(RESOURCES, id);
    const versions = fs.readdirSync(dir)
        .filter((v) => /^v\d+$/.test(v))
        .sort((a, b) => Number(b.slice(1)) - Number(a.slice(1)));
    if (!versions.length) throw new Error(`у ресурса ${id} нет папок версий`);
    return versions[0];
}

function exportArt(outDir: string): void {
    const items: Item[] = [];
    fs.rmSync(outDir, { recursive: true, force: true });

    for (const target of TARGETS) {
        const version = latestVersionDir(target.id);
        const versionDir = path.join(RESOURCES, target.id, version);
        const taraPath = path.join(versionDir, "library.tara");
        const groupDir = path.join(outDir, target.group);
        fs.mkdirSync(groupDir, { recursive: true });
        const stem = target.id.split("/").pop()!;

        if (fs.existsSync(taraPath)) {
            for (const entry of parseTara(fs.readFileSync(taraPath))) {
                if (!isImage(entry.data)) continue;
                const file = path.join(target.group, `${stem}__${entry.tag}`);
                fs.writeFileSync(path.join(outDir, file), entry.data);
                items.push({ file: file.replace(/\\/g, "/"), resource: target.id, version, entry: entry.tag,
                             name: "library.tara", size: imageSize(entry.data), sha1: sha1(entry.data), note: target.note });
            }
            continue;
        }

        for (const name of fs.readdirSync(versionDir)) {
            const data = fs.readFileSync(path.join(versionDir, name));
            if (!isImage(data)) continue;
            const file = path.join(target.group, `${stem}__${name}`);
            fs.writeFileSync(path.join(outDir, file), data);
            items.push({ file: file.replace(/\\/g, "/"), resource: target.id, version, entry: null,
                         name, size: imageSize(data), sha1: sha1(data), note: target.note });
        }
    }

    fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify({ items }, null, 2));
    fs.writeFileSync(path.join(outDir, "README.txt"), readme(items));
    console.log(`Выгружено картинок: ${items.length} -> ${outDir}`);
    for (const item of items) console.log(`  ${item.file}  ${item.size}  (${item.resource}, ${item.note})`);
}

function readme(items: Item[]): string {
    const lines = [
        "Картинки игры для замены.",
        "",
        "Правила:",
        "  - имя файла и формат менять нельзя (jpg остаётся jpg, png — png);",
        "  - размер лучше сохранить: он указан ниже, движок ждёт ту же сетку координат;",
        "  - плакаты и баннеры внутри library.tara — это АТЛАСЫ: на одной картинке и рама щита,",
        "    и подложка, и ножки. Перерисовывать нужно поверх существующей раскладки, иначе",
        "    текстура ляжет на модель мимо.",
        "",
        "Как вернуть в игру: положить изменённые файлы на те же места и сказать",
        "  npx ts-node scripts/art.ts import <эта папка>",
        "",
        "Список:",
    ];
    for (const item of items) lines.push(`  ${item.file}  ${item.size}  — ${item.note}`);
    return lines.join("\n") + "\n";
}

/** Кладёт готовый файл в раздачу (.resource/<путь ресурса>/<имя>). */
function deploy(resource: string, name: string, data: Buffer): string | null {
    const meta = (ResourceData as Record<string, { path: string }>)[resource];
    if (!meta) return null;
    const dir = path.join(BUILD, meta.path.replace(/^\/+/, "").replace(/\//g, path.sep));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, name), data);
    return path.join(dir, name);
}

function importArt(dir: string, bump: boolean, only: string[]): void {
    const manifest: { items: Item[] } = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));

    // Сначала группируем по ресурсу: в одном .tara может смениться несколько картинок сразу.
    const byResource = new Map<string, Item[]>();
    for (const item of manifest.items) {
        if (only.length && !only.some((prefix) => item.resource.startsWith(prefix))) continue;
        const data = fs.readFileSync(path.join(dir, item.file));
        // Без --bump перезаписывать одинаковые байты незачем. С --bump — наоборот: смысл новой версии
        // в новом адресе, по которому клиент сходит заново, а байты при этом могут не меняться вовсе.
        if (!bump && sha1(data) === item.sha1) continue;
        const list = byResource.get(item.resource) ?? [];
        list.push(item);
        byResource.set(item.resource, list);
    }

    if (!byResource.size) {
        console.log("Изменённых картинок нет — интегрировать нечего.");
        return;
    }

    for (const [resource, changed] of byResource) {
        const version = changed[0].version;
        const sourceDir = path.join(RESOURCES, resource, version);
        const targetVersion = bump ? `v${Number(version.slice(1)) + 1}` : version;
        const targetDir = path.join(RESOURCES, resource, targetVersion);
        if (bump) {
            fs.mkdirSync(targetDir, { recursive: true });
            for (const name of fs.readdirSync(sourceDir)) {
                fs.copyFileSync(path.join(sourceDir, name), path.join(targetDir, name));
            }
        }

        const taraItems = changed.filter((i) => i.entry !== null);
        if (taraItems.length) {
            const taraPath = path.join(targetDir, "library.tara");
            const entries = parseTara(fs.readFileSync(taraPath));
            for (const item of taraItems) {
                const entry = entries.find((e) => e.tag === item.entry);
                if (!entry) throw new Error(`в ${taraPath} нет записи ${item.entry}`);
                entry.data = fs.readFileSync(path.join(dir, item.file));
                console.log(`  ${resource} ${targetVersion}: ${item.entry} <- ${item.file}`);
            }
            const packed = buildTara(entries);
            fs.writeFileSync(taraPath, packed);
            if (!bump) deploy(resource, "library.tara", packed);
        }

        for (const item of changed.filter((i) => i.entry === null)) {
            const data = fs.readFileSync(path.join(dir, item.file));
            fs.writeFileSync(path.join(targetDir, item.name), data);
            console.log(`  ${resource} ${targetVersion}: ${item.name} <- ${item.file}`);
            if (!bump) deploy(resource, item.name, data);
        }
    }

    // Манифест переписываем: теперь эталон — то, что лежит в игре. Версию поднимаем только у тех
    // ресурсов, которые действительно переехали: с --only остальные остались на прежней.
    for (const item of manifest.items) {
        item.sha1 = sha1(fs.readFileSync(path.join(dir, item.file)));
        if (bump && byResource.has(item.resource)) item.version = `v${Number(item.version.slice(1)) + 1}`;
    }
    fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));

    console.log(bump
        ? "Готово. Новая версия ресурсов создана — пересоберите раздачу: npm run build:resources && npm run patch:deploy && npm run patch:webclient"
        : "Готово. В браузере нужен Ctrl+F5: ресурсы отдаются с вечным кэшем.");
}

function main(): void {
    const [cmd, ...rest] = process.argv.slice(2);
    const dir = path.resolve(rest.find((a) => !a.startsWith("--")) ?? path.join(ROOT, "art-export"));
    const only = (rest.find((a) => a.startsWith("--only=")) ?? "").slice("--only=".length)
        .split(",").map((s) => s.trim()).filter(Boolean);
    if (cmd === "export") exportArt(dir);
    else if (cmd === "import") importArt(dir, rest.includes("--bump"), only);
    else {
        console.log("Usage:\n  npx ts-node scripts/art.ts export [папка]\n  npx ts-node scripts/art.ts import [папка] [--bump] [--only=<id>,<id>]");
        process.exit(1);
    }
}

main();
