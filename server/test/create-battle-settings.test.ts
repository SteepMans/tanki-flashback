import assert from "node:assert/strict";
import test from "node:test";
import { battleSettingsFromRequest } from "../src/features/lobby/lobby.handlers";
import { BattleMode, EquipmentConstraintsMode, MapTheme } from "../src/features/battle/battle.model";

// Флажки формата, которые окно создания битвы шлёт вместе с остальными полями. Их сервер раньше
// выбрасывал: в бою всегда были и золотые ящики, и зона их падения, и мины, что бы игрок ни выбрал.
const FORMAT_FLAGS = [
    "withoutBonuses",
    "withoutCrystals",
    "withoutSupplies",
    "withoutUpgrades",
    "reducedResistances",
    "esportDropTiming",
    "withoutGoldBoxes",
    "withoutGoldSiren",
    "withoutGoldZone",
    "withoutMedkit",
    "withoutMines",
    "randomGold",
    "dependentCooldownEnabled",
] as const;

function request(overrides: Record<string, unknown> = {}): any {
    const packet: Record<string, unknown> = {
        name: "test",
        privateBattle: false,
        proBattle: true,
        battleMode: BattleMode.DM,
        mapId: "map_silence_moon",
        maxPeopleCount: 10,
        minRank: 1,
        maxRank: 30,
        timeLimitInSec: 600,
        scoreLimit: 0,
        autoBalance: false,
        friendlyFire: false,
        parkourMode: false,
        equipmentConstraintsMode: EquipmentConstraintsMode.NONE,
        reArmorEnabled: false,
        mapTheme: MapTheme.SUMMER,
    };
    for (const flag of FORMAT_FLAGS) packet[flag] = false;
    return { ...packet, ...overrides };
}

test("PRO battle keeps every format flag sent by the create window", () => {
    const overrides: Record<string, unknown> = {};
    for (const flag of FORMAT_FLAGS) overrides[flag] = true;

    const settings = battleSettingsFromRequest(request(overrides)) as unknown as Record<string, unknown>;
    for (const flag of FORMAT_FLAGS) {
        assert.equal(settings[flag], true, `флаг ${flag} потерялся`);
    }
});

test("regular battle gets no format flags even if the client sends them", () => {
    const overrides: Record<string, unknown> = { proBattle: false };
    for (const flag of FORMAT_FLAGS) overrides[flag] = true;

    const settings = battleSettingsFromRequest(request(overrides)) as unknown as Record<string, unknown>;
    for (const flag of FORMAT_FLAGS) {
        assert.equal(settings[flag], false, `флаг ${flag} применился к обычной битве`);
    }
});

test("gold box drop zone follows its own checkbox", () => {
    const shown = battleSettingsFromRequest(request({ withoutGoldZone: false }));
    const hidden = battleSettingsFromRequest(request({ withoutGoldZone: true }));

    assert.equal(shown.withoutGoldZone, false);
    assert.equal(hidden.withoutGoldZone, true);
});

test("bot count is taken from the name marker and the marker is stripped", () => {
    const withBots = battleSettingsFromRequest(request({ name: "Колхоз рубилово #b6" }));
    assert.equal(withBots.name, "Колхоз рубилово");
    assert.equal(withBots.botCount, 6);

    const clamped = battleSettingsFromRequest(request({ name: "Битва #b99" }));
    assert.equal(clamped.botCount, 12);

    const plain = battleSettingsFromRequest(request({ name: "Обычная битва" }));
    assert.equal(plain.name, "Обычная битва");
    assert.equal(plain.botCount, undefined);
});
