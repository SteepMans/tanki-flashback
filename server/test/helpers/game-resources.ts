import test from "node:test";
import { ResourceData } from "@/generated/resourceTypes";

/**
 * Игровых ресурсов (модели, карты, текстуры) в репозитории нет — см. README. Без них
 * `npm run build:gen` генерирует пустой каталог, и тестам, которым нужны настоящие карты и
 * модели, проверять нечего.
 *
 * Такие тесты объявляются через `gameResourceTest` вместо `test`: в дереве с ресурсами они
 * выполняются как обычно, в дереве без ресурсов пропускаются, а не падают.
 */
export const hasGameResources = Object.keys(ResourceData).length > 0;

export const gameResourceTest = hasGameResources ? test : test.skip;
