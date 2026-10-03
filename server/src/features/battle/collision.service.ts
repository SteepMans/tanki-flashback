import { getMapCollision, ICollisionTri } from "@/maps/mapCollision";
import { IVector3 } from "@/shared/types/geom/ivector3";

// When checking if collision is BETWEEN two points, trim this much off each end of the line so the
// surface a flag rests on (and the floor under the tank) — touched only at the endpoints — don't
// count; only collision genuinely between the two blocks.
const OCCLUSION_TRIM = 40;

// Grid resolution cap: the map extent is split into at most this many cells per axis. Cell lists
// stay short (a handful of boxes/triangles) while the whole grid is still just a few thousand
// array slots per map.
const GRID_MAX_CELLS_PER_AXIS = 64;
const GRID_MIN_CELL_SIZE = 512;

interface ICollisionBoxLike {
    minX: number;
    minY: number;
    minZ: number;
    maxX: number;
    maxY: number;
    maxZ: number;
}

/**
 * Uniform XY grid over one map's collision geometry. Every box/triangle is registered in each cell
 * its XY bounding box covers; point queries then touch one cell and segment queries walk only the
 * cells along the segment. Built once per map on first use — the geometry is static.
 */
class CollisionGrid<T> {
    private readonly cells: number[][] = [];
    private readonly stamp: Uint32Array;
    private visit = 0;
    private readonly minX: number = Infinity;
    private readonly minY: number = Infinity;
    private readonly cellSize: number = GRID_MIN_CELL_SIZE;
    private readonly cols: number = 0;
    private readonly rows: number = 0;

    constructor(public readonly items: T[], bounds: (item: T) => [number, number, number, number]) {
        let maxX = -Infinity;
        let maxY = -Infinity;
        const itemBounds = items.map(bounds);
        for (const [x0, y0, x1, y1] of itemBounds) {
            if (x0 < this.minX) this.minX = x0;
            if (y0 < this.minY) this.minY = y0;
            if (x1 > maxX) maxX = x1;
            if (y1 > maxY) maxY = y1;
        }
        this.stamp = new Uint32Array(items.length);
        if (!items.length) return;
        this.cellSize = Math.max(
            GRID_MIN_CELL_SIZE,
            Math.ceil(Math.max(maxX - this.minX, maxY - this.minY) / GRID_MAX_CELLS_PER_AXIS)
        );
        this.cols = Math.max(1, Math.ceil((maxX - this.minX) / this.cellSize));
        this.rows = Math.max(1, Math.ceil((maxY - this.minY) / this.cellSize));
        this.cells.length = this.cols * this.rows;
        for (let i = 0; i < items.length; i++) {
            const [x0, y0, x1, y1] = itemBounds[i];
            for (let cy = this._row(y0); cy <= this._row(y1); cy++) {
                for (let cx = this._col(x0); cx <= this._col(x1); cx++) {
                    const idx = cy * this.cols + cx;
                    (this.cells[idx] ??= []).push(i);
                }
            }
        }
    }

    private _col(x: number): number {
        return Math.min(this.cols - 1, Math.max(0, Math.floor((x - this.minX) / this.cellSize)));
    }

    private _row(y: number): number {
        return Math.min(this.rows - 1, Math.max(0, Math.floor((y - this.minY) / this.cellSize)));
    }

    /** Item indices whose cell contains (x, y). One cell — the registration already covers overlap. */
    public at(x: number, y: number): number[] {
        if (!this.items.length) return EMPTY;
        if (x < this.minX - this.cellSize || y < this.minY - this.cellSize) return EMPTY;
        return this.cells[this._row(y) * this.cols + this._col(x)] ?? EMPTY;
    }

    /** Reusable output buffer for collectAlongSegment — avoids per-query closure/array allocations
     *  (the callback variant showed up as ~5% of the server profile through closure churn). */
    public readonly segmentHits: number[] = [];

    /**
     * Collects (into `segmentHits`, returning the count) every item registered in a cell the XY
     * projection of the segment touches, each item once.
     */
    public collectAlongSegment(x0: number, y0: number, x1: number, y1: number): number {
        let count = 0;
        if (!this.items.length) return count;
        this.visit++;
        const c0 = this._col(Math.min(x0, x1));
        const c1 = this._col(Math.max(x0, x1));
        const r0 = this._row(Math.min(y0, y1));
        const r1 = this._row(Math.max(y0, y1));
        // The segment's cell footprint is walked row by row, but rows/columns the segment's XY line
        // doesn't actually cross are skipped by a distance test against the cell's center.
        const dx = x1 - x0;
        const dy = y1 - y0;
        const lenSq = dx * dx + dy * dy;
        // Half cell diagonal + slack: any cell whose center is farther from the segment can't contain it.
        const reach = this.cellSize * 0.7072 + 1;
        for (let cy = r0; cy <= r1; cy++) {
            for (let cx = c0; cx <= c1; cx++) {
                if (lenSq > 1e-6) {
                    const cxm = this.minX + (cx + 0.5) * this.cellSize;
                    const cym = this.minY + (cy + 0.5) * this.cellSize;
                    let t = ((cxm - x0) * dx + (cym - y0) * dy) / lenSq;
                    t = t < 0 ? 0 : t > 1 ? 1 : t;
                    const ex = cxm - (x0 + dx * t);
                    const ey = cym - (y0 + dy * t);
                    if (ex * ex + ey * ey > reach * reach * 2) continue;
                }
                const cell = this.cells[cy * this.cols + cx];
                if (!cell) continue;
                for (const i of cell) {
                    if (this.stamp[i] === this.visit) continue;
                    this.stamp[i] = this.visit;
                    this.segmentHits[count++] = i;
                }
            }
        }
        return count;
    }
}

const EMPTY: number[] = [];

interface IMapGrids {
    /** The exact object getMapCollision returned: if a later call returns a different object (the
     *  map was evicted and reloaded, or a test swapped the data), the grids are rebuilt. */
    source: object;
    boxGrid: CollisionGrid<ICollisionBoxLike>;
    triGrid: CollisionGrid<ICollisionTri>;
    obstacleGrid: CollisionGrid<ICollisionBoxLike>;
}

const boxBounds = (b: ICollisionBoxLike): [number, number, number, number] => [b.minX, b.minY, b.maxX, b.maxY];
const triBounds = (t: ICollisionTri): [number, number, number, number] => [
    Math.min(t.ax, t.bx, t.cx),
    Math.min(t.ay, t.by, t.cy),
    Math.max(t.ax, t.bx, t.cx),
    Math.max(t.ay, t.by, t.cy),
];

/**
 * Pure map-geometry queries (no battle/client/packet state) used for flag drops, pickup occlusion
 * and the anti-clip check. Backed by the generated per-map collision boxes + ramp triangles
 * (`getMapCollision`). Extracted from BattleService as the first step of splitting that god object.
 */
export class CollisionService {
    /** Per-map spatial grids, built lazily on first query — collision geometry is static. */
    private readonly grids = new Map<string, IMapGrids>();

    private _grids(mapResourceId: string): IMapGrids {
        const data = getMapCollision(mapResourceId);
        let grids = this.grids.get(mapResourceId);
        if (!grids || grids.source !== data) {
            grids = {
                source: data,
                boxGrid: new CollisionGrid(data.boxes, boxBounds),
                triGrid: new CollisionGrid(data.triangles, triBounds),
                obstacleGrid: new CollisionGrid(data.obstacles, boxBounds),
            };
            this.grids.set(mapResourceId, grids);
        }
        return grids;
    }

    /** Drops a map's grids together with the underlying collision cache (see evictMapCollision). */
    public evictMap(mapResourceId: string): void {
        this.grids.delete(mapResourceId);
    }

    /** Highest collision surface top at (x,y) at/below `fromZ` (box top or interpolated ramp z), or
     *  null if there's nothing there (the void). Used to drop flags onto the ground below the tank. */
    public raycastGroundZ(mapResourceId: string, x: number, y: number, fromZ: number): number | null {
        const { boxGrid, triGrid } = this._grids(mapResourceId);
        let best: number | null = null;
        const ceiling = fromZ + 1; // tiny slack: the tank rests ~89 above its floor, so the top <= fromZ
        for (const i of boxGrid.at(x, y)) {
            const b = boxGrid.items[i];
            if (x < b.minX || x > b.maxX || y < b.minY || y > b.maxY || b.maxZ > ceiling) continue;
            if (best === null || b.maxZ > best) best = b.maxZ;
        }
        for (const i of triGrid.at(x, y)) {
            const z = this._triZAt(triGrid.items[i], x, y);
            if (z !== null && z <= ceiling && (best === null || z > best)) best = z;
        }
        return best;
    }

    /** Is there ANY construction (not just a floor to stand on) in the column at (x,y) that reaches
     *  the tank's height or below? True if any collision box whose XY contains (x,y) starts at/below
     *  `z`, or a ramp surface sits at/below `z`. False only over the true VOID — an empty column with
     *  no collision at all. Used by parkour so a tank explodes ONLY when it actually falls into nothing,
     *  never while over/beside any structure. */
    public hasSupportBelow(mapResourceId: string, x: number, y: number, z: number): boolean {
        const { boxGrid, triGrid } = this._grids(mapResourceId);
        for (const i of boxGrid.at(x, y)) {
            const b = boxGrid.items[i];
            if (x >= b.minX && x <= b.maxX && y >= b.minY && y <= b.maxY && b.minZ <= z) return true;
        }
        for (const i of triGrid.at(x, y)) {
            const tz = this._triZAt(triGrid.items[i], x, y);
            if (tz !== null && tz <= z + 1) return true;
        }
        return false;
    }

    /** Is there ANY collision (floor, wall, structure, ramp) genuinely BETWEEN the two points? The
     *  straight line is trimmed at both ends (OCCLUSION_TRIM) so the surface a point rests on doesn't
     *  count; only geometry the line passes THROUGH blocks. */
    public isBlockedBetween(mapResourceId: string, from: IVector3, to: IVector3): boolean {
        const { boxGrid, triGrid } = this._grids(mapResourceId);
        if (!boxGrid.items.length && !triGrid.items.length) return false;
        const dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z;
        const len = Math.hypot(dx, dy, dz);
        const e = len > 0 ? Math.min(0.45, OCCLUSION_TRIM / len) : 0; // trim fraction off each end
        const ox = from.x + dx * e, oy = from.y + dy * e, oz = from.z + dz * e;
        const s = 1 - 2 * e;
        const rx = dx * s, ry = dy * s, rz = dz * s;
        const boxCount = boxGrid.collectAlongSegment(ox, oy, ox + rx, oy + ry);
        for (let k = 0; k < boxCount; k++) {
            if (this._segHitsBox(ox, oy, oz, rx, ry, rz, boxGrid.items[boxGrid.segmentHits[k]])) return true;
        }
        const triCount = triGrid.collectAlongSegment(ox, oy, ox + rx, oy + ry);
        for (let k = 0; k < triCount; k++) {
            if (this._segHitsTri(ox, oy, oz, rx, ry, rz, triGrid.items[triGrid.segmentHits[k]])) return true;
        }
        return false;
    }

    /** Segment origin+dir (t in [0,1]) vs an axis-aligned box (slab test), allocation-free. */
    private _segHitsBox(
        ox: number, oy: number, oz: number,
        rx: number, ry: number, rz: number,
        b: ICollisionBoxLike
    ): boolean {
        let tmin = 0, tmax = 1;
        for (let a = 0; a < 3; a++) {
            const o = a === 0 ? ox : a === 1 ? oy : oz;
            const r = a === 0 ? rx : a === 1 ? ry : rz;
            const lo = a === 0 ? b.minX : a === 1 ? b.minY : b.minZ;
            const hi = a === 0 ? b.maxX : a === 1 ? b.maxY : b.maxZ;
            if (Math.abs(r) < 1e-6) {
                if (o < lo || o > hi) return false;
            } else {
                let t1 = (lo - o) / r, t2 = (hi - o) / r;
                if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
                if (t1 > tmin) tmin = t1;
                if (t2 < tmax) tmax = t2;
                if (tmin > tmax) return false;
            }
        }
        return true;
    }

    /** The solid obstacle (wall/structure) the point is inside, or null. For the anti-clip check —
     *  obstacles are shrunk slightly so merely resting against one doesn't count. */
    public obstacleAt(mapResourceId: string, pos: IVector3): string | null {
        const { obstacleGrid } = this._grids(mapResourceId);
        const M = 30; // shrink margin
        for (const i of obstacleGrid.at(pos.x, pos.y)) {
            const b = obstacleGrid.items[i];
            if (pos.x > b.minX + M && pos.x < b.maxX - M && pos.y > b.minY + M && pos.y < b.maxY - M && pos.z > b.minZ + M && pos.z < b.maxZ - M) {
                return `[${b.minX},${b.minY},${b.minZ}]..[${b.maxX},${b.maxY},${b.maxZ}]`;
            }
        }
        return null;
    }

    /** Segment origin+dir (t in [0,1]) vs a 3D triangle. Möller–Trumbore, allocation-free: this and
     *  the box test run hundreds of thousands of times a second across all bot battles. */
    private _segHitsTri(
        ox: number, oy: number, oz: number,
        rx: number, ry: number, rz: number,
        t: ICollisionTri
    ): boolean {
        const e1x = t.bx - t.ax, e1y = t.by - t.ay, e1z = t.bz - t.az;
        const e2x = t.cx - t.ax, e2y = t.cy - t.ay, e2z = t.cz - t.az;
        const px = ry * e2z - rz * e2y;
        const py = rz * e2x - rx * e2z;
        const pz = rx * e2y - ry * e2x;
        const det = e1x * px + e1y * py + e1z * pz;
        if (Math.abs(det) < 1e-9) return false;
        const inv = 1 / det;
        const tvx = ox - t.ax, tvy = oy - t.ay, tvz = oz - t.az;
        const u = (tvx * px + tvy * py + tvz * pz) * inv;
        if (u < 0 || u > 1) return false;
        const qx = tvy * e1z - tvz * e1y;
        const qy = tvz * e1x - tvx * e1z;
        const qz = tvx * e1y - tvy * e1x;
        const v = (rx * qx + ry * qy + rz * qz) * inv;
        if (v < 0 || u + v > 1) return false;
        const tt = (e2x * qx + e2y * qy + e2z * qz) * inv;
        return tt >= 0 && tt <= 1;
    }

    /** z of the tilted triangle surface at (x,y) if (x,y) is within its XY projection, else null. */
    private _triZAt(t: ICollisionTri, x: number, y: number): number | null {
        const d = (t.by - t.cy) * (t.ax - t.cx) + (t.cx - t.bx) * (t.ay - t.cy);
        if (Math.abs(d) < 1e-9) return null;
        const a = ((t.by - t.cy) * (x - t.cx) + (t.cx - t.bx) * (y - t.cy)) / d;
        const b = ((t.cy - t.ay) * (x - t.cx) + (t.ax - t.cx) * (y - t.cy)) / d;
        const c = 1 - a - b;
        const eps = -0.001;
        if (a < eps || b < eps || c < eps) return null;
        return a * t.az + b * t.bz + c * t.cz;
    }
}
