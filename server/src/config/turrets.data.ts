// Unified turret config: ONE source of truth per turret modification — garage/shop catalog +
// display stats (the heterogeneous `properts` rows the client renders, kept verbatim) + movement
// physics (kickback + turret-turn acceleration, from captured TankModelData; optional = formula
// fallback). Resource ids derived as turret/<id>/m<mod>/{preview,model}. NOTE: the WEAPON-simulation
// table (reload/damage/special_entity, plus non-garage weapons like artillery/xt) stays in
// physics.data.ts — it's a separate monolithic blob sent to the client and keyed by weapon id.
import { ResourceManager } from "@/utils/resource.manager";

export interface TurretModConfig {
    rank: number; price: number; nextPrice: number; nextRank: number;
    properts: any[]; // garage display stats (heterogeneous per weapon), verbatim
    kickback?: number; turretTurnAcceleration?: number; // radians
}

export interface TurretConfig {
    id: string; name: string; description: string; category: string; index: number; type: number;
    mods: TurretModConfig[]; // index === modificationID
}

export const turretsData: TurretConfig[] = [
    {
      id: "smoky", name: "Смоки", category: "weapon", index: 100, type: 1,
      description: "Танковое орудие среднего калибра, которое чаще всего ставят на лёгкие и учебные корпуса. Популярность объясняется низкой ценой и простотой обслуживания. Поставьте Смоки на лёгкий корпус и изматывайте тяжёлых неповоротливых противников. Модификации заметно повышают урон. На больших дистанциях эффективность падает.",
        mods: [
            { rank: 1, price: 0, nextPrice: 7100, nextRank: 8, kickback: 1.1, turretTurnAcceleration: 2,
              properts: [{"property":"DAMAGE","value":null,"subproperties":[{"property":"DAMAGE_FROM","value":"16","subproperties":null},{"property":"DAMAGE_TO","value":"20","subproperties":null}]},{"property":"IMPACT_FORCE","value":"150","subproperties":null},{"property":"TURRET_TURN_SPEED","value":"57.3","subproperties":null},{"property":"CRITICAL_HIT_CHANCE","value":"5","subproperties":null},{"property":"CRITICAL_HIT_DAMAGE","value":"36","subproperties":null}] },
            { rank: 8, price: 7100, nextPrice: 61400, nextRank: 15,
              properts: [{"property":"DAMAGE","value":null,"subproperties":[{"property":"DAMAGE_FROM","value":"25","subproperties":null},{"property":"DAMAGE_TO","value":"31","subproperties":null}]},{"property":"IMPACT_FORCE","value":"210","subproperties":null},{"property":"TURRET_TURN_SPEED","value":"77.3","subproperties":null},{"property":"CRITICAL_HIT_CHANCE","value":"10","subproperties":null},{"property":"CRITICAL_HIT_DAMAGE","value":"56","subproperties":null}] },
            { rank: 15, price: 61400, nextPrice: 166900, nextRank: 23, kickback: 1.95, turretTurnAcceleration: 2.9,
              properts: [{"property":"DAMAGE","value":null,"subproperties":[{"property":"DAMAGE_FROM","value":"33","subproperties":null},{"property":"DAMAGE_TO","value":"42","subproperties":null}]},{"property":"IMPACT_FORCE","value":"272","subproperties":null},{"property":"TURRET_TURN_SPEED","value":"96.8","subproperties":null},{"property":"CRITICAL_HIT_CHANCE","value":"14","subproperties":null},{"property":"CRITICAL_HIT_DAMAGE","value":"75","subproperties":null}] },
            { rank: 23, price: 166900, nextPrice: 0, nextRank: 23, kickback: 2.5, turretTurnAcceleration: 3.4800119955514934,
              properts: [{"property":"DAMAGE","value":null,"subproperties":[{"property":"DAMAGE_FROM","value":"44","subproperties":null},{"property":"DAMAGE_TO","value":"56","subproperties":null}]},{"property":"IMPACT_FORCE","value":"330","subproperties":null},{"property":"TURRET_TURN_SPEED","value":"122.6","subproperties":null},{"property":"CRITICAL_HIT_CHANCE","value":"20","subproperties":null},{"property":"CRITICAL_HIT_DAMAGE","value":"100","subproperties":null}] },
        ],
    },
    {
      id: "flamethrower", name: "Огнемёт", category: "weapon", index: 150, type: 1,
      description: "В ближнем бою немногое сравнится с огнемётом. Оружие бьёт по площади и быстро выжигает вражеские машины. Особенно хорош в тесных местах против медленных целей. Перезарядка небыстрая, но стрелять можно и неполным баком.",
        mods: [
            { rank: 1, price: 150, nextPrice: 7100, nextRank: 8, kickback: 0, turretTurnAcceleration: 2.63,
              properts: [{"property":"DAMAGE_PER_SECOND","value":null,"subproperties":[{"property":"DAMAGE_PER_PERIOD","value":"32","subproperties":null}]},{"property":"WEAPON_CHARGE_RATE","value":null,"subproperties":[{"property":"WEAPON_RELOAD_TIME","value":"12.99","subproperties":null}]},{"property":"TURRET_TURN_SPEED","value":"75.6","subproperties":null},{"property":"SHOT_RANGE","value":null,"subproperties":[{"property":"WEAPON_MIN_DAMAGE_RADIUS","value":"17","subproperties":null}]},{"property":"FIRE_DAMAGE","value":null,"subproperties":[{"property":"FLAME_TEMPERATURE_LIMIT","value":"6.2","subproperties":null}]}] },
            { rank: 8, price: 7100, nextPrice: 61400, nextRank: 15, kickback: 0, turretTurnAcceleration: 3.09,
              properts: [{"property":"DAMAGE_PER_SECOND","value":null,"subproperties":[{"property":"DAMAGE_PER_PERIOD","value":"44","subproperties":null}]},{"property":"WEAPON_CHARGE_RATE","value":null,"subproperties":[{"property":"WEAPON_RELOAD_TIME","value":"12.05","subproperties":null}]},{"property":"TURRET_TURN_SPEED","value":"103.1","subproperties":null},{"property":"SHOT_RANGE","value":null,"subproperties":[{"property":"WEAPON_MIN_DAMAGE_RADIUS","value":"19.4","subproperties":null}]},{"property":"FIRE_DAMAGE","value":null,"subproperties":[{"property":"FLAME_TEMPERATURE_LIMIT","value":"13.7","subproperties":null}]}] },
            { rank: 15, price: 61400, nextPrice: 177700, nextRank: 23, kickback: 0, turretTurnAcceleration: 3.55,
              properts: [{"property":"DAMAGE_PER_SECOND","value":null,"subproperties":[{"property":"DAMAGE_PER_PERIOD","value":"56","subproperties":null}]},{"property":"WEAPON_CHARGE_RATE","value":null,"subproperties":[{"property":"WEAPON_RELOAD_TIME","value":"11.11","subproperties":null}]},{"property":"TURRET_TURN_SPEED","value":"130.6","subproperties":null},{"property":"SHOT_RANGE","value":null,"subproperties":[{"property":"WEAPON_MIN_DAMAGE_RADIUS","value":"21.9","subproperties":null}]},{"property":"FIRE_DAMAGE","value":null,"subproperties":[{"property":"FLAME_TEMPERATURE_LIMIT","value":"21.6","subproperties":null}]}] },
            { rank: 23, price: 177700, nextPrice: 0, nextRank: 23, kickback: 0, turretTurnAcceleration: 4.13992098573055,
              properts: [{"property":"DAMAGE_PER_SECOND","value":null,"subproperties":[{"property":"DAMAGE_PER_PERIOD","value":"72","subproperties":null}]},{"property":"WEAPON_CHARGE_RATE","value":null,"subproperties":[{"property":"WEAPON_RELOAD_TIME","value":"10.00","subproperties":null}]},{"property":"TURRET_TURN_SPEED","value":"166.2","subproperties":null},{"property":"SHOT_RANGE","value":null,"subproperties":[{"property":"WEAPON_MIN_DAMAGE_RADIUS","value":"25","subproperties":null}]},{"property":"FIRE_DAMAGE","value":null,"subproperties":[{"property":"FLAME_TEMPERATURE_LIMIT","value":"31.2","subproperties":null}]}] },
        ],
    },
    {
      id: "twins", name: "Твинс", category: "weapon", index: 200, type: 1,
      description: "Скорострельное двуствольное плазменное орудие, способное задавить противника за считаные секунды. Попадания Твинса сбивают прицел врагу, поэтому он хорош в динамичных схватках на средней дистанции.",
        mods: [
            { rank: 2, price: 350, nextPrice: 12350, nextRank: 9, kickback: 0.31, turretTurnAcceleration: 2.56,
              properts: [{"property":"DAMAGE","value":null,"subproperties":[{"property":"DAMAGE_FROM","value":"6.5","subproperties":null},{"property":"DAMAGE_TO","value":"7.6","subproperties":null}]},{"property":"IMPACT_FORCE","value":"83","subproperties":null},{"property":"TURRET_TURN_SPEED","value":"77.3","subproperties":null},{"property":"SHOT_RANGE","value":null,"subproperties":[{"property":"WEAPON_MIN_DAMAGE_RADIUS","value":"60.9","subproperties":null}]},{"property":"WEAPON_MIN_DAMAGE_PERCENT","value":"1.8","subproperties":null}] },
            { rank: 9, price: 12350, nextPrice: 70300, nextRank: 16,
              properts: [{"property":"DAMAGE","value":null,"subproperties":[{"property":"DAMAGE_FROM","value":"9.8","subproperties":null},{"property":"DAMAGE_TO","value":"11.9","subproperties":null}]},{"property":"IMPACT_FORCE","value":"108","subproperties":null},{"property":"TURRET_TURN_SPEED","value":"95.7","subproperties":null},{"property":"SHOT_RANGE","value":null,"subproperties":[{"property":"WEAPON_MIN_DAMAGE_RADIUS","value":"67","subproperties":null}]},{"property":"WEAPON_MIN_DAMAGE_PERCENT","value":"7.6","subproperties":null}] },
            { rank: 16, price: 70300, nextPrice: 188500, nextRank: 24, kickback: 0.43, turretTurnAcceleration: 3.38,
              properts: [{"property":"DAMAGE","value":null,"subproperties":[{"property":"DAMAGE_FROM","value":"13.2","subproperties":null},{"property":"DAMAGE_TO","value":"16.1","subproperties":null}]},{"property":"IMPACT_FORCE","value":"132","subproperties":null},{"property":"TURRET_TURN_SPEED","value":"113.4","subproperties":null},{"property":"SHOT_RANGE","value":null,"subproperties":[{"property":"WEAPON_MIN_DAMAGE_RADIUS","value":"73","subproperties":null}]},{"property":"WEAPON_MIN_DAMAGE_PERCENT","value":"13.4","subproperties":null}] },
            { rank: 24, price: 188500, nextPrice: 0, nextRank: 24, kickback: 0.5, turretTurnAcceleration: 3.8500217969742923,
              properts: [{"property":"DAMAGE","value":null,"subproperties":[{"property":"DAMAGE_FROM","value":"17","subproperties":null},{"property":"DAMAGE_TO","value":"21","subproperties":null}]},{"property":"IMPACT_FORCE","value":"160","subproperties":null},{"property":"TURRET_TURN_SPEED","value":"134.7","subproperties":null},{"property":"SHOT_RANGE","value":null,"subproperties":[{"property":"WEAPON_MIN_DAMAGE_RADIUS","value":"80","subproperties":null}]},{"property":"WEAPON_MIN_DAMAGE_PERCENT","value":"20","subproperties":null}] },
        ],
    },
    {
      id: "railgun", name: "Рельса", category: "weapon", index: 250, type: 1,
      description: "Если среднего калибра мало — вот тяжёлая рельса. Крупный калибр и огромная начальная скорость снаряда. Точный кинетический заряд прошивает машину насквозь и задевает всех, кто стоит на одной линии. Идеальна для позиционного боя и стрельбы издалека. Учтите долгую перезарядку и выбирайте моменты для выстрела.",
        mods: [
            { rank: 3, price: 800, nextPrice: 17600, nextRank: 10, kickback: 1.9, turretTurnAcceleration: 1.11,
              properts: [{"property":"DAMAGE","value":null,"subproperties":[{"property":"DAMAGE_FROM","value":"50","subproperties":null},{"property":"DAMAGE_TO","value":"81","subproperties":null}]},{"property":"IMPACT_FORCE","value":"280","subproperties":null},{"property":"WEAPON_CHARGE_RATE","value":null,"subproperties":[{"property":"WEAPON_RELOAD_TIME","value":"6.23","subproperties":null}]},{"property":"TURRET_TURN_SPEED","value":"45.3","subproperties":null},{"property":"WEAPON_WEAKENING_COEFF","value":"18.00","subproperties":null}] },
            { rank: 10, price: 17600, nextPrice: 79200, nextRank: 17, kickback: 2.27, turretTurnAcceleration: 1.33,
              properts: [{"property":"DAMAGE","value":null,"subproperties":[{"property":"DAMAGE_FROM","value":"78","subproperties":null},{"property":"DAMAGE_TO","value":"120","subproperties":null}]},{"property":"IMPACT_FORCE","value":"419","subproperties":null},{"property":"WEAPON_CHARGE_RATE","value":null,"subproperties":[{"property":"WEAPON_RELOAD_TIME","value":"5.63","subproperties":null}]},{"property":"TURRET_TURN_SPEED","value":"62.5","subproperties":null},{"property":"WEAPON_WEAKENING_COEFF","value":"45.00","subproperties":null}] },
            { rank: 17, price: 79200, nextPrice: 199300, nextRank: 25, kickback: 2.63, turretTurnAcceleration: 1.54,
              properts: [{"property":"DAMAGE","value":null,"subproperties":[{"property":"DAMAGE_FROM","value":"105","subproperties":null},{"property":"DAMAGE_TO","value":"160","subproperties":null}]},{"property":"IMPACT_FORCE","value":"560","subproperties":null},{"property":"WEAPON_CHARGE_RATE","value":null,"subproperties":[{"property":"WEAPON_RELOAD_TIME","value":"5.04","subproperties":null}]},{"property":"TURRET_TURN_SPEED","value":"80.2","subproperties":null},{"property":"WEAPON_WEAKENING_COEFF","value":"73.00","subproperties":null}] },
            { rank: 25, price: 199300, nextPrice: 0, nextRank: 25, kickback: 3, turretTurnAcceleration: 1.7599900177110819,
              properts: [{"property":"DAMAGE","value":null,"subproperties":[{"property":"DAMAGE_FROM","value":"133","subproperties":null},{"property":"DAMAGE_TO","value":"199","subproperties":null}]},{"property":"IMPACT_FORCE","value":"700","subproperties":null},{"property":"WEAPON_CHARGE_RATE","value":null,"subproperties":[{"property":"WEAPON_RELOAD_TIME","value":"4.44","subproperties":null}]},{"property":"TURRET_TURN_SPEED","value":"97.4","subproperties":null},{"property":"WEAPON_WEAKENING_COEFF","value":"100.00","subproperties":null}] },
        ],
    },
    {
      id: "isida", name: "Изида", category: "weapon", index: 300, type: 1,
      description: "Идея этого оружия родилась ещё в холодную войну, а воплотилась благодаря квантовой физике и нанотехнологиям. В основе — генератор нанороботов, которые чинят или разрушают небиологические материалы. Импульсный излучатель переносит наномассу по короткому каналу: Изида наносит урон врагам и лечит союзников, что бесценно в командном бою.",
        mods: [
            { rank: 4, price: 1250, nextPrice: 22850, nextRank: 11, kickback: 0, turretTurnAcceleration: 2.64,
              properts: [{"property":"ISIS_HEALING_PER_SECOND","value":null,"subproperties":[{"property":"ISIS_HEALING_PER_PERIOD","value":"15","subproperties":null}]},{"property":"ISIS_DAMAGE","value":null,"subproperties":[{"property":"DAMAGE_PER_PERIOD","value":"30","subproperties":null}]},{"property":"ISIS_SELF_HEALING_PERCENT","value":"33.00","subproperties":null},{"property":"WEAPON_CHARGE_RATE","value":null,"subproperties":[{"property":"WEAPON_RELOAD_TIME","value":"10.75","subproperties":null}]},{"property":"TURRET_TURN_SPEED","value":"82.5","subproperties":null}] },
            { rank: 11, price: 22850, nextPrice: 88100, nextRank: 18, kickback: 0, turretTurnAcceleration: 3.06,
              properts: [{"property":"ISIS_HEALING_PER_SECOND","value":null,"subproperties":[{"property":"ISIS_HEALING_PER_PERIOD","value":"21","subproperties":null}]},{"property":"ISIS_DAMAGE","value":null,"subproperties":[{"property":"DAMAGE_PER_PERIOD","value":"42","subproperties":null}]},{"property":"ISIS_SELF_HEALING_PERCENT","value":"39.00","subproperties":null},{"property":"WEAPON_CHARGE_RATE","value":null,"subproperties":[{"property":"WEAPON_RELOAD_TIME","value":"10.13","subproperties":null}]},{"property":"TURRET_TURN_SPEED","value":"100.8","subproperties":null}] },
            { rank: 18, price: 88100, nextPrice: 221000, nextRank: 26, kickback: 0, turretTurnAcceleration: 3.45,
              properts: [{"property":"ISIS_HEALING_PER_SECOND","value":null,"subproperties":[{"property":"ISIS_HEALING_PER_PERIOD","value":"27","subproperties":null}]},{"property":"ISIS_DAMAGE","value":null,"subproperties":[{"property":"DAMAGE_PER_PERIOD","value":"55","subproperties":null}]},{"property":"ISIS_SELF_HEALING_PERCENT","value":"45.00","subproperties":null},{"property":"WEAPON_CHARGE_RATE","value":null,"subproperties":[{"property":"WEAPON_RELOAD_TIME","value":"9.52","subproperties":null}]},{"property":"TURRET_TURN_SPEED","value":"119.7","subproperties":null}] },
            { rank: 26, price: 221000, nextPrice: 0, nextRank: 26, kickback: 0, turretTurnAcceleration: 3.8500217969742923,
              properts: [{"property":"ISIS_HEALING_PER_SECOND","value":null,"subproperties":[{"property":"ISIS_HEALING_PER_PERIOD","value":"33","subproperties":null}]},{"property":"ISIS_DAMAGE","value":null,"subproperties":[{"property":"DAMAGE_PER_PERIOD","value":"66","subproperties":null}]},{"property":"ISIS_SELF_HEALING_PERCENT","value":"50.00","subproperties":null},{"property":"WEAPON_CHARGE_RATE","value":null,"subproperties":[{"property":"WEAPON_RELOAD_TIME","value":"9.00","subproperties":null}]},{"property":"TURRET_TURN_SPEED","value":"134.7","subproperties":null}] },
        ],
    },
    {
      id: "thunder", name: "Гром", category: "weapon", index: 350, type: 1,
      description: "Орудие среднего калибра второго поколения — отличный выбор для динамичного боя. Урон по площади (следите за своим положением!) позволяет бить сразу по группе машин. Быстрая перезарядка даёт преимущество против тяжёлых противников. На лёгком корпусе Гром — одно из самых опасных орудий.",
        mods: [
            { rank: 5, price: 1450, nextPrice: 28100, nextRank: 12, kickback: 1.56, turretTurnAcceleration: 1.71,
              properts: [{"property":"DAMAGE","value":null,"subproperties":[{"property":"DAMAGE_FROM","value":"32","subproperties":null},{"property":"DAMAGE_TO","value":"55","subproperties":null}]},{"property":"IMPACT_FORCE","value":"135","subproperties":null},{"property":"WEAPON_CHARGE_RATE","value":null,"subproperties":[{"property":"WEAPON_RELOAD_TIME","value":"3.33","subproperties":null}]},{"property":"TURRET_TURN_SPEED","value":"63","subproperties":null},{"property":"SHOT_RANGE","value":null,"subproperties":[{"property":"WEAPON_MIN_DAMAGE_RADIUS","value":"53.5","subproperties":null}]}] },
            { rank: 12, price: 28100, nextPrice: 97000, nextRank: 19, kickback: 2.02, turretTurnAcceleration: 2.11,
              properts: [{"property":"DAMAGE","value":null,"subproperties":[{"property":"DAMAGE_FROM","value":"49","subproperties":null},{"property":"DAMAGE_TO","value":"75","subproperties":null}]},{"property":"IMPACT_FORCE","value":"196","subproperties":null},{"property":"WEAPON_CHARGE_RATE","value":null,"subproperties":[{"property":"WEAPON_RELOAD_TIME","value":"3.02","subproperties":null}]},{"property":"TURRET_TURN_SPEED","value":"85.9","subproperties":null},{"property":"SHOT_RANGE","value":null,"subproperties":[{"property":"WEAPON_MIN_DAMAGE_RADIUS","value":"59.6","subproperties":null}]}] },
            { rank: 19, price: 97000, nextPrice: 242500, nextRank: 27, kickback: 2.47, turretTurnAcceleration: 2.51,
              properts: [{"property":"DAMAGE","value":null,"subproperties":[{"property":"DAMAGE_FROM","value":"66","subproperties":null},{"property":"DAMAGE_TO","value":"95","subproperties":null}]},{"property":"IMPACT_FORCE","value":"257","subproperties":null},{"property":"WEAPON_CHARGE_RATE","value":null,"subproperties":[{"property":"WEAPON_RELOAD_TIME","value":"2.72","subproperties":null}]},{"property":"TURRET_TURN_SPEED","value":"108.9","subproperties":null},{"property":"SHOT_RANGE","value":null,"subproperties":[{"property":"WEAPON_MIN_DAMAGE_RADIUS","value":"65.7","subproperties":null}]}] },
            { rank: 27, price: 242500, nextPrice: 0, nextRank: 27, kickback: 2.8, turretTurnAcceleration: 2.800031718974503,
              properts: [{"property":"DAMAGE","value":null,"subproperties":[{"property":"DAMAGE_FROM","value":"78","subproperties":null},{"property":"DAMAGE_TO","value":"110","subproperties":null}]},{"property":"IMPACT_FORCE","value":"300","subproperties":null},{"property":"WEAPON_CHARGE_RATE","value":null,"subproperties":[{"property":"WEAPON_RELOAD_TIME","value":"2.50","subproperties":null}]},{"property":"TURRET_TURN_SPEED","value":"124.9","subproperties":null},{"property":"SHOT_RANGE","value":null,"subproperties":[{"property":"WEAPON_MIN_DAMAGE_RADIUS","value":"70","subproperties":null}]}] },
        ],
    },
    {
      id: "shotgun", name: "Молот", category: "weapon", index: 400, type: 1,
      description: "Создатели этой противотанковой пушки подошли к делу нестандартно. Вместо привычных бронебойных снарядов она бьёт картечью с вольфрамовой начинкой, которую подаёт роботизированный барабан. Получилось орудие, которое буквально заколачивает вражеские машины. Из-за такой механики Молот силён на ближней и средней дистанции и теряет мощь с расстоянием.",
        mods: [
            { rank: 3, price: 800, nextPrice: 17600, nextRank: 10, kickback: 1.8, turretTurnAcceleration: 2.1,
              properts: [{"property":"DAMAGE_PER_SECOND","value":null,"subproperties":[{"property":"DAMAGE_PER_PERIOD","value":"44.1","subproperties":null}]},{"property":"IMPACT_FORCE","value":"18","subproperties":null},{"property":"WEAPON_CHARGE_RATE","value":null,"subproperties":[{"property":"WEAPON_RELOAD_TIME","value":"2.26","subproperties":null}]},{"property":"TURRET_TURN_SPEED","value":"75.1","subproperties":null},{"property":"SHOT_RANGE","value":null,"subproperties":[{"property":"WEAPON_MIN_DAMAGE_RADIUS","value":"46.7","subproperties":null}]}] },
            { rank: 10, price: 17600, nextPrice: 79200, nextRank: 17, kickback: 2.17, turretTurnAcceleration: 2.47,
              properts: [{"property":"DAMAGE_PER_SECOND","value":null,"subproperties":[{"property":"DAMAGE_PER_PERIOD","value":"66.6","subproperties":null}]},{"property":"IMPACT_FORCE","value":"26","subproperties":null},{"property":"WEAPON_CHARGE_RATE","value":null,"subproperties":[{"property":"WEAPON_RELOAD_TIME","value":"2.10","subproperties":null}]},{"property":"TURRET_TURN_SPEED","value":"95.7","subproperties":null},{"property":"SHOT_RANGE","value":null,"subproperties":[{"property":"WEAPON_MIN_DAMAGE_RADIUS","value":"52.8","subproperties":null}]}] },
            { rank: 17, price: 79200, nextPrice: 210100, nextRank: 25, kickback: 2.53, turretTurnAcceleration: 2.83,
              properts: [{"property":"DAMAGE_PER_SECOND","value":null,"subproperties":[{"property":"DAMAGE_PER_PERIOD","value":"88.8","subproperties":null}]},{"property":"IMPACT_FORCE","value":"34","subproperties":null},{"property":"WEAPON_CHARGE_RATE","value":null,"subproperties":[{"property":"WEAPON_RELOAD_TIME","value":"1.95","subproperties":null}]},{"property":"TURRET_TURN_SPEED","value":"116.9","subproperties":null},{"property":"SHOT_RANGE","value":null,"subproperties":[{"property":"WEAPON_MIN_DAMAGE_RADIUS","value":"58.9","subproperties":null}]}] },
            { rank: 25, price: 210100, nextPrice: 0, nextRank: 25, kickback: 2.9, turretTurnAcceleration: 3.200061183531603,
              properts: [{"property":"DAMAGE_PER_SECOND","value":null,"subproperties":[{"property":"DAMAGE_PER_PERIOD","value":"111.3","subproperties":null}]},{"property":"IMPACT_FORCE","value":"42","subproperties":null},{"property":"WEAPON_CHARGE_RATE","value":null,"subproperties":[{"property":"WEAPON_RELOAD_TIME","value":"1.80","subproperties":null}]},{"property":"TURRET_TURN_SPEED","value":"137.5","subproperties":null},{"property":"SHOT_RANGE","value":null,"subproperties":[{"property":"WEAPON_MIN_DAMAGE_RADIUS","value":"65","subproperties":null}]}] },
        ],
    },
    {
      id: "freeze", name: "Фриз", category: "weapon", index: 450, type: 1,
      description: "Замысел Фриза начался с работы скромного изобретателя и вырос в грозную морозильную установку. Орудие окатывает противника составом на основе фреона: цель получает урон, замедляется и хуже управляется. Замороженную машину можно оттаять струёй огня.",
        mods: [
            { rank: 5, price: 1450, nextPrice: 28100, nextRank: 12,
              properts: [{"property":"DAMAGE_PER_SECOND","value":null,"subproperties":[{"property":"DAMAGE_PER_PERIOD","value":"39","subproperties":null}]},{"property":"WEAPON_CHARGE_RATE","value":null,"subproperties":[{"property":"WEAPON_RELOAD_TIME","value":"12.50","subproperties":null}]},{"property":"TURRET_TURN_SPEED","value":"108.3","subproperties":null},{"property":"SHOT_RANGE","value":null,"subproperties":[{"property":"WEAPON_MIN_DAMAGE_RADIUS","value":"18.4","subproperties":null}]}] },
            { rank: 12, price: 28100, nextPrice: 97000, nextRank: 19, kickback: 0, turretTurnAcceleration: 3.67,
              properts: [{"property":"DAMAGE_PER_SECOND","value":null,"subproperties":[{"property":"DAMAGE_PER_PERIOD","value":"54","subproperties":null}]},{"property":"WEAPON_CHARGE_RATE","value":null,"subproperties":[{"property":"WEAPON_RELOAD_TIME","value":"11.63","subproperties":null}]},{"property":"TURRET_TURN_SPEED","value":"140.9","subproperties":null},{"property":"SHOT_RANGE","value":null,"subproperties":[{"property":"WEAPON_MIN_DAMAGE_RADIUS","value":"20.8","subproperties":null}]}] },
            { rank: 19, price: 97000, nextPrice: 253300, nextRank: 27,
              properts: [{"property":"DAMAGE_PER_SECOND","value":null,"subproperties":[{"property":"DAMAGE_PER_PERIOD","value":"69","subproperties":null}]},{"property":"WEAPON_CHARGE_RATE","value":null,"subproperties":[{"property":"WEAPON_RELOAD_TIME","value":"10.71","subproperties":null}]},{"property":"TURRET_TURN_SPEED","value":"173","subproperties":null},{"property":"SHOT_RANGE","value":null,"subproperties":[{"property":"WEAPON_MIN_DAMAGE_RADIUS","value":"23.3","subproperties":null}]}] },
            { rank: 27, price: 253300, nextPrice: 0, nextRank: 27, kickback: 0, turretTurnAcceleration: 4.439943084148375,
              properts: [{"property":"DAMAGE_PER_SECOND","value":null,"subproperties":[{"property":"DAMAGE_PER_PERIOD","value":"80","subproperties":null}]},{"property":"WEAPON_CHARGE_RATE","value":null,"subproperties":[{"property":"WEAPON_RELOAD_TIME","value":"10.00","subproperties":null}]},{"property":"TURRET_TURN_SPEED","value":"196","subproperties":null},{"property":"SHOT_RANGE","value":null,"subproperties":[{"property":"WEAPON_MIN_DAMAGE_RADIUS","value":"25","subproperties":null}]}] },
        ],
    },
    {
      id: "ricochet", name: "Рикошет", category: "weapon", index: 500, type: 1,
      description: "Плазменное орудие Рикошет — закрытая научная разработка. Оно выпускает заряды в отрицательном поле: при попадании в машину они взрываются, а от других поверхностей отскакивают. С Рикошетом можно доставать цели, которых не видно напрямую. Только не стойте на пути собственного заряда — заденет.",
        mods: [
            { rank: 6, price: 1700, nextPrice: 33350, nextRank: 13, kickback: 1.45, turretTurnAcceleration: 1.26,
              properts: [{"property":"DAMAGE","value":null,"subproperties":[{"property":"DAMAGE_FROM","value":"16","subproperties":null},{"property":"DAMAGE_TO","value":"19","subproperties":null}]},{"property":"IMPACT_FORCE","value":"146","subproperties":null},{"property":"WEAPON_CHARGE_RATE","value":null,"subproperties":[{"property":"WEAPON_RELOAD_TIME","value":"0.59","subproperties":null}]},{"property":"TURRET_TURN_SPEED","value":"79.6","subproperties":null},{"property":"SHOT_RANGE","value":null,"subproperties":[{"property":"WEAPON_MIN_DAMAGE_RADIUS","value":"64.3","subproperties":null}]}] },
            { rank: 13, price: 33350, nextPrice: 105900, nextRank: 20, kickback: 1.67, turretTurnAcceleration: 1.68,
              properts: [{"property":"DAMAGE","value":null,"subproperties":[{"property":"DAMAGE_FROM","value":"22","subproperties":null},{"property":"DAMAGE_TO","value":"26","subproperties":null}]},{"property":"IMPACT_FORCE","value":"183","subproperties":null},{"property":"WEAPON_CHARGE_RATE","value":null,"subproperties":[{"property":"WEAPON_RELOAD_TIME","value":"0.54","subproperties":null}]},{"property":"TURRET_TURN_SPEED","value":"103.1","subproperties":null},{"property":"SHOT_RANGE","value":null,"subproperties":[{"property":"WEAPON_MIN_DAMAGE_RADIUS","value":"70.4","subproperties":null}]}] },
            { rank: 20, price: 105900, nextPrice: 264200, nextRank: 28, kickback: 1.88, turretTurnAcceleration: 2.12,
              properts: [{"property":"DAMAGE","value":null,"subproperties":[{"property":"DAMAGE_FROM","value":"28","subproperties":null},{"property":"DAMAGE_TO","value":"34","subproperties":null}]},{"property":"IMPACT_FORCE","value":"219","subproperties":null},{"property":"WEAPON_CHARGE_RATE","value":null,"subproperties":[{"property":"WEAPON_RELOAD_TIME","value":"0.50","subproperties":null}]},{"property":"TURRET_TURN_SPEED","value":"126.6","subproperties":null},{"property":"SHOT_RANGE","value":null,"subproperties":[{"property":"WEAPON_MIN_DAMAGE_RADIUS","value":"76.5","subproperties":null}]}] },
            { rank: 28, price: 264200, nextPrice: 0, nextRank: 28, kickback: 2, turretTurnAcceleration: 2.3701571242083004,
              properts: [{"property":"DAMAGE","value":null,"subproperties":[{"property":"DAMAGE_FROM","value":"32","subproperties":null},{"property":"DAMAGE_TO","value":"38","subproperties":null}]},{"property":"IMPACT_FORCE","value":"240","subproperties":null},{"property":"WEAPON_CHARGE_RATE","value":null,"subproperties":[{"property":"WEAPON_RELOAD_TIME","value":"0.47","subproperties":null}]},{"property":"TURRET_TURN_SPEED","value":"139.8","subproperties":null},{"property":"SHOT_RANGE","value":null,"subproperties":[{"property":"WEAPON_MIN_DAMAGE_RADIUS","value":"80","subproperties":null}]}] },
        ],
    },
    {
      id: "machinegun", name: "Вулкан", category: "weapon", index: 550, type: 1,
      description: "Скорострельная пушка для средних и дальних дистанций. Особая система управления не даёт сбить прицел под плотным огнём. Помните: при долгой стрельбе Вулкан перегревается и повреждает собственную машину.",
        mods: [
            { rank: 4, price: 1250, nextPrice: 22850, nextRank: 11,
              properts: [{"property":"DAMAGE_PER_SECOND","value":null,"subproperties":[{"property":"DAMAGE_PER_PERIOD","value":"27","subproperties":null}]},{"property":"IMPACT_FORCE","value":"55","subproperties":null},{"property":"WEAPON_CHARGE_RATE","value":null,"subproperties":[{"property":"WEAPON_RELOAD_TIME","value":"4.39","subproperties":null}]},{"property":"TURRET_TURN_SPEED","value":"76.2","subproperties":null},{"property":"SHOT_RANGE","value":null,"subproperties":[{"property":"WEAPON_MIN_DAMAGE_RADIUS","value":"130.4","subproperties":null}]}] },
            { rank: 11, price: 22850, nextPrice: 88100, nextRank: 18, kickback: 0.6, turretTurnAcceleration: 2.06,
              properts: [{"property":"DAMAGE_PER_SECOND","value":null,"subproperties":[{"property":"DAMAGE_PER_PERIOD","value":"38.5","subproperties":null}]},{"property":"IMPACT_FORCE","value":"85","subproperties":null},{"property":"WEAPON_CHARGE_RATE","value":null,"subproperties":[{"property":"WEAPON_RELOAD_TIME","value":"5.30","subproperties":null}]},{"property":"TURRET_TURN_SPEED","value":"93.4","subproperties":null},{"property":"SHOT_RANGE","value":null,"subproperties":[{"property":"WEAPON_MIN_DAMAGE_RADIUS","value":"154.8","subproperties":null}]}] },
            { rank: 18, price: 88100, nextPrice: 231800, nextRank: 26, kickback: 0.8, turretTurnAcceleration: 2.24,
              properts: [{"property":"DAMAGE_PER_SECOND","value":null,"subproperties":[{"property":"DAMAGE_PER_PERIOD","value":"50.1","subproperties":null}]},{"property":"IMPACT_FORCE","value":"115","subproperties":null},{"property":"WEAPON_CHARGE_RATE","value":null,"subproperties":[{"property":"WEAPON_RELOAD_TIME","value":"6.22","subproperties":null}]},{"property":"TURRET_TURN_SPEED","value":"111.2","subproperties":null},{"property":"SHOT_RANGE","value":null,"subproperties":[{"property":"WEAPON_MIN_DAMAGE_RADIUS","value":"179.1","subproperties":null}]}] },
            { rank: 26, price: 231800, nextPrice: 0, nextRank: 26, kickback: 0.96, turretTurnAcceleration: 2.4000022544174024,
              properts: [{"property":"DAMAGE_PER_SECOND","value":null,"subproperties":[{"property":"DAMAGE_PER_PERIOD","value":"60","subproperties":null}]},{"property":"IMPACT_FORCE","value":"139","subproperties":null},{"property":"WEAPON_CHARGE_RATE","value":null,"subproperties":[{"property":"WEAPON_RELOAD_TIME","value":"7.00","subproperties":null}]},{"property":"TURRET_TURN_SPEED","value":"126","subproperties":null},{"property":"SHOT_RANGE","value":null,"subproperties":[{"property":"WEAPON_MIN_DAMAGE_RADIUS","value":"200","subproperties":null}]}] },
        ],
    },
    {
      id: "shaft", name: "Шафт", category: "weapon", index: 600, type: 1,
      description: "Шафт создан учёными-новаторами и умеет многое. Главная его особенность — снайперский режим, дающий преимущество над противником. Он одинаково хорош и на дальней, и на ближней дистанции: стрелять можно и без снайперского прицела.",
        mods: [
            { rank: 7, price: 1900, nextPrice: 38600, nextRank: 14, kickback: 2.11, turretTurnAcceleration: 1.46,
              properts: [{"property":"AIMING_MODE_DAMAGE","value":null,"subproperties":[{"property":"SHAFT_AIMING_MODE_MAX_DAMAGE","value":"153","subproperties":null}]},{"property":"DAMAGE","value":null,"subproperties":[{"property":"DAMAGE_FROM","value":"44","subproperties":null},{"property":"DAMAGE_TO","value":"54","subproperties":null}]},{"property":"IMPACT_FORCE","value":"167","subproperties":null},{"property":"WEAPON_CHARGE_RATE","value":null,"subproperties":[{"property":"WEAPON_RELOAD_TIME","value":"3.74","subproperties":null}]},{"property":"TURRET_TURN_SPEED","value":"67","subproperties":null}] },
            { rank: 14, price: 38600, nextPrice: 114800, nextRank: 21, kickback: 2.47, turretTurnAcceleration: 1.76,
              properts: [{"property":"AIMING_MODE_DAMAGE","value":null,"subproperties":[{"property":"SHAFT_AIMING_MODE_MAX_DAMAGE","value":"214","subproperties":null}]},{"property":"DAMAGE","value":null,"subproperties":[{"property":"DAMAGE_FROM","value":"63","subproperties":null},{"property":"DAMAGE_TO","value":"76","subproperties":null}]},{"property":"IMPACT_FORCE","value":"233","subproperties":null},{"property":"WEAPON_CHARGE_RATE","value":null,"subproperties":[{"property":"WEAPON_RELOAD_TIME","value":"3.43","subproperties":null}]},{"property":"TURRET_TURN_SPEED","value":"86.5","subproperties":null}] },
            { rank: 21, price: 114800, nextPrice: 275000, nextRank: 29,
              properts: [{"property":"AIMING_MODE_DAMAGE","value":null,"subproperties":[{"property":"SHAFT_AIMING_MODE_MAX_DAMAGE","value":"276","subproperties":null}]},{"property":"DAMAGE","value":null,"subproperties":[{"property":"DAMAGE_FROM","value":"82","subproperties":null},{"property":"DAMAGE_TO","value":"97","subproperties":null}]},{"property":"IMPACT_FORCE","value":"301","subproperties":null},{"property":"WEAPON_CHARGE_RATE","value":null,"subproperties":[{"property":"WEAPON_RELOAD_TIME","value":"3.13","subproperties":null}]},{"property":"TURRET_TURN_SPEED","value":"106.6","subproperties":null}] },
            { rank: 29, price: 275000, nextPrice: 0, nextRank: 29, kickback: 3, turretTurnAcceleration: 2.1600194822681824,
              properts: [{"property":"AIMING_MODE_DAMAGE","value":null,"subproperties":[{"property":"SHAFT_AIMING_MODE_MAX_DAMAGE","value":"302","subproperties":null}]},{"property":"DAMAGE","value":null,"subproperties":[{"property":"DAMAGE_FROM","value":"90","subproperties":null},{"property":"DAMAGE_TO","value":"106","subproperties":null}]},{"property":"IMPACT_FORCE","value":"330","subproperties":null},{"property":"WEAPON_CHARGE_RATE","value":null,"subproperties":[{"property":"WEAPON_RELOAD_TIME","value":"3.00","subproperties":null}]},{"property":"TURRET_TURN_SPEED","value":"114.1","subproperties":null}] },
        ],
    },
];

/**
 * XT variant of a base turret: identical parameters per mod (properts/kickback/turn acceleration —
 * battle captures confirm XT turrets use the base TankModelData; the weapon-sim table in
 * physics.data.ts already carries the <id>_xt_m* entries); only the upgrade prices change — m0
 * costs the same, m1–m3 cost 60% of the base (rule from the captured hornet_xt/viking_xt data).
 */
function xtTurretVariant(baseId: string, name: string, index: number, description: string): TurretConfig {
    const base = turretsData.find((t) => t.id === baseId)!;
    const prices = base.mods.map((m, i) => (i === 0 ? m.price : Math.round(m.price * 0.6)));
    return {
        ...base, id: `${baseId}_xt`, name, index, description,
        mods: base.mods.map((m, i) => ({ ...m, price: prices[i], nextPrice: i + 1 < prices.length ? prices[i + 1] : 0 })),
    };
}

turretsData.push(
  xtTurretVariant("machinegun", "Вулкан XT", 60, "Элитный Вулкан XT. Отделка стволов выдаёт ветерана, а раскручиваются они так же безжалостно, как у обычной модели."),
  xtTurretVariant("flamethrower", "Огнемёт XT", 70, "Эксклюзивный Огнемёт XT. Особое жаростойкое покрытие даёт орудию узнаваемый отблеск в бою."),
  xtTurretVariant("railgun", "Рельса XT", 80, "Элитная Рельса XT с эксклюзивной окраской: её носят стрелки, которых представлять не нужно."),
  xtTurretVariant("thunder", "Гром XT", 90, "Эксклюзивный Гром XT. За парадной окраской — то же орудие, что и у обычной модели; разница лишь в том, какой страх оно внушает."),
  xtTurretVariant("ricochet", "Рикошет XT", 95, "Эксклюзивный Рикошет XT. Под элитной серебряной отделкой — тот же плазменный излучатель: знак тех, кто освоил стрельбу с отскока."),
  xtTurretVariant("isida", "Изида XT", 100, "Эксклюзивная Изида XT. Под элитной отделкой — тот же генератор нанороботов: лечит союзников и разрушает врага со знаком мастера."),
);

const byId = new Map(turretsData.map((t) => [t.id, t]));

/** A turret modification's config (kickback / turret-turn acceleration), keyed like the battle workflow. */
export function getTurretMod(baseId: string, modId: number): TurretModConfig | undefined {
    return byId.get(baseId)?.mods[modId];
}

/**
 * Adapts a TurretConfig to the legacy garage "blueprint" shape (resource accessors + the verbatim
 * `properts` stat rows). Keeps garage.service/item.utils working unchanged off a single source.
 * Resource ids derived: turret/<id>/m<mod>/{preview,model}.
 */
export function toTurretBlueprint(t: TurretConfig) {
    return {
        id: t.id, name: t.name, description: t.description, category: t.category, index: t.index, type: t.type,
        baseItemId: () => ResourceManager.getIdlowById(`turret/${t.id}/m0/preview` as any),
        modifications: t.mods.map((m, modId) => ({
            modificationID: modId,
            next_price: m.nextPrice,
            next_rank: m.nextRank,
            previewResourceId: () => ResourceManager.getIdlowById(`turret/${t.id}/m${modId}/preview` as any),
            rank: m.rank,
            price: m.price,
            object3ds: () => ResourceManager.getIdlowById(`turret/${t.id}/m${modId}/model` as any),
            properts: m.properts,
        })),
    };
}
