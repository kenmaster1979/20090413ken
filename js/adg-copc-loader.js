/**
 * Viewer COPC LoD：Range + copc.js + laz-perf + ADGC 节点缓存。
 * 从 ADG-2.0/probe-copc.html 抽出，挂到现网 isCloudRoot Group。
 */
import { Copc } from 'copc';

function isAppleMobile() {
    const ua = String(navigator.userAgent || '');
    if (/iPhone|iPad|iPod/i.test(ua)) return true;
    return /Macintosh/i.test(ua) && (navigator.maxTouchPoints || 0) > 1;
}

const IS_IOS = isAppleMobile();
const LOAD_CONCURRENCY = IS_IOS ? 1 : 4;
const NODE_LOAD_TIMEOUT_MS = 15000;
const LOD_MAX_POINTS = IS_IOS ? 400000 : 1500000;
const LOD_MAX_NODES = IS_IOS ? 48 : 120;
const LOD_BASE_MAX_DEPTH = 1;
const LOD_SSE_REFINE = 80;
const LOD_SSE_COLLAPSE = 40;
const LOD_RANGE_SCALE_DEFAULT = 8;
const LOD_NEAR_FORCE_M = 8;
const LOD_THROTTLE_MS = 120;
const LOD_CAM_MOVE_M = 0.28;
const LOD_CAM_ROT_DOT = 0.9994;
const LOD_UNLOAD_MS = 700;
const LOD_CACHE_EXTRA = 48;
const ADGC_MAGIC = 'ADGC';
const ADGC_VERSION = 1;
const ADGC_HEADER_SIZE = 64;
const ADGC_NODE_RECORD_SIZE = 24;
const FLATNESS_RADIUS = 0.10;
const FLATNESS_MIN_NEIGHBORS = 6;

function nodeDepth(key) {
    const n = Number(String(key).split('-')[0]);
    return Number.isFinite(n) ? n : 99;
}

function detectLasRgbDivisor(gr, gg, gb, count) {
    let max = 0;
    const n = Math.min(count, 128);
    for (let i = 0; i < n; i++) {
        const r = gr(i);
        const g = gg(i);
        const b = gb(i);
        if (r > max) max = r;
        if (g > max) max = g;
        if (b > max) max = b;
    }
    if (max <= 1.0001) return 1;
    if (max <= 255) return 255;
    return 65535;
}

function withTimeout(promise, ms, label) {
    return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`timeout ${label || ''}`)), ms);
        promise.then((v) => { clearTimeout(t); resolve(v); }, (err) => { clearTimeout(t); reject(err); });
    });
}

async function mapPool(items, limit, fn) {
    let i = 0;
    const n = Math.min(limit, items.length);
    await Promise.all(Array.from({ length: n }, (_, workerId) => (async () => {
        while (true) {
            const cur = i;
            i += 1;
            if (cur >= items.length) return;
            await fn(items[cur], cur, workerId);
        }
    })()));
}

function createRangeGetter(url) {
    const abs = new URL(url, window.location.href).href;
    return async (begin, end) => {
        const res = await fetch(abs, {
            headers: { Range: `bytes=${begin}-${end - 1}` }
        });
        if (res.status !== 206 && res.status !== 200) {
            throw new Error(`Range HTTP ${res.status} (${begin}-${end})`);
        }
        return new Uint8Array(await res.arrayBuffer());
    };
}

async function loadAllHierarchy(getter, rootPage) {
    const all = {};
    async function walk(page) {
        const result = await Copc.loadHierarchyPage(getter, page);
        const nodes = result.nodes || {};
        const pages = result.pages || {};
        Object.assign(all, nodes);
        const subPages = Object.values(pages);
        for (let i = 0; i < subPages.length; i++) {
            const sub = subPages[i];
            if (sub && sub.pageOffset != null && sub.pageLength) await walk(sub);
        }
    }
    await walk(rootPage);
    return all;
}

async function inflateGzipArrayBuffer(buffer) {
    const u8 = new Uint8Array(buffer);
    if (u8.length >= 2 && u8[0] === 0x1f && u8[1] === 0x8b) {
        const stream = new Blob([buffer]).stream().pipeThrough(new DecompressionStream('gzip'));
        return await new Response(stream).arrayBuffer();
    }
    return buffer;
}

export function parseAdgcCache(arrayBuffer, expectedPointCount) {
    if (!arrayBuffer || arrayBuffer.byteLength < ADGC_HEADER_SIZE) return null;
    const view = new DataView(arrayBuffer);
    for (let i = 0; i < ADGC_MAGIC.length; i++) {
        if (view.getUint8(i) !== ADGC_MAGIC.charCodeAt(i)) return null;
    }
    const version = view.getUint8(4);
    if (version < 1 || version > ADGC_VERSION) return null;
    const headerSize = view.getUint16(6, true) || ADGC_HEADER_SIZE;
    const radius = view.getFloat32(8, true);
    const minNeighbors = view.getUint32(12, true);
    const totalPoints = view.getUint32(16, true);
    const nodeCount = view.getUint32(20, true);
    const globalMin = view.getFloat32(24, true);
    const globalMax = view.getFloat32(28, true);
    const sourcePointCount = Number(view.getBigUint64(32, true));
    if (Math.abs(radius - FLATNESS_RADIUS) > 1e-6) return null;
    if (minNeighbors !== FLATNESS_MIN_NEIGHBORS) return null;
    if (expectedPointCount && sourcePointCount && sourcePointCount !== expectedPointCount) return null;
    const recordSize = view.getUint32(60, true) || ADGC_NODE_RECORD_SIZE;
    const tableStart = headerSize;
    const tableBytes = nodeCount * recordSize;
    const roughStart = tableStart + tableBytes;
    if (roughStart + totalPoints * 4 > arrayBuffer.byteLength) return null;
    const nodes = new Map();
    for (let i = 0; i < nodeCount; i++) {
        const o = tableStart + i * recordSize;
        const d = view.getInt32(o, true);
        const x = view.getInt32(o + 4, true);
        const y = view.getInt32(o + 8, true);
        const z = view.getInt32(o + 12, true);
        const count = view.getUint32(o + 16, true);
        const roughIndex = view.getUint32(o + 20, true);
        if (roughIndex + count > totalPoints) return null;
        const key = `${d}-${x}-${y}-${z}`;
        nodes.set(key, {
            count,
            roughness: new Float32Array(arrayBuffer, roughStart + roughIndex * 4, count)
        });
    }
    return {
        radius,
        minNeighbors,
        totalPoints,
        nodeCount,
        min: globalMin,
        max: globalMax,
        sourcePointCount,
        nodes
    };
}

async function loadAdgcFromUrl(cacheUrl, expectedPointCount) {
    if (!cacheUrl) return null;
    const res = await fetch(cacheUrl);
    if (!res.ok) throw new Error(`ADGC HTTP ${res.status}`);
    const inflated = await inflateGzipArrayBuffer(await res.arrayBuffer());
    return parseAdgcCache(inflated, expectedPointCount);
}

async function fetchLazPerfWasm(wasmUrl) {
    const candidates = [
        wasmUrl,
        'https://cdn.jsdelivr.net/npm/laz-perf@0.0.7/lib/laz-perf.wasm'
    ].filter(Boolean);
    let lastErr = null;
    for (let i = 0; i < candidates.length; i++) {
        try {
            const res = await fetch(candidates[i]);
            if (!res.ok) throw new Error(`laz-perf wasm HTTP ${res.status}`);
            return new Uint8Array(await res.arrayBuffer());
        } catch (err) {
            lastErr = err;
        }
    }
    throw lastErr || new Error('laz-perf wasm 不可用');
}

async function createLazPerfPool(count, wasmUrl) {
    if (typeof window.createLazPerf !== 'function') {
        throw new Error('laz-perf 未加载');
    }
    const wasmBinary = await fetchLazPerfWasm(wasmUrl);
    const lazPerfs = [];
    for (let w = 0; w < count; w++) {
        lazPerfs.push(await window.createLazPerf({ wasmBinary }));
    }
    return { wasmBinary, lazPerfs };
}

function parseCopcKey(key) {
    const p = String(key).split('-');
    return {
        d: Number(p[0]) || 0,
        x: Number(p[1]) || 0,
        y: Number(p[2]) || 0,
        z: Number(p[3]) || 0
    };
}

function childCopcKeys(key) {
    const { d, x, y, z } = parseCopcKey(key);
    const out = [];
    for (let dx = 0; dx <= 1; dx++) {
        for (let dy = 0; dy <= 1; dy++) {
            for (let dz = 0; dz <= 1; dz++) {
                out.push(`${d + 1}-${x * 2 + dx}-${y * 2 + dy}-${z * 2 + dz}`);
            }
        }
    }
    return out;
}

function parentCopcKey(key) {
    const { d, x, y, z } = parseCopcKey(key);
    if (d <= 0) return '';
    return `${d - 1}-${x >> 1}-${y >> 1}-${z >> 1}`;
}

function resolveCopcCube(info, header) {
    if (info && Array.isArray(info.cube) && info.cube.length >= 6) {
        return info.cube.map(Number);
    }
    const cx = Number(info?.center_x);
    const cy = Number(info?.center_y);
    const cz = Number(info?.center_z);
    const half = Number(info?.halfsize);
    if (Number.isFinite(cx) && Number.isFinite(cy) && Number.isFinite(cz) && Number.isFinite(half) && half > 0) {
        return [cx - half, cy - half, cz - half, cx + half, cy + half, cz + half];
    }
    const min = header?.min || [0, 0, 0];
    const max = header?.max || [1, 1, 1];
    const midX = (min[0] + max[0]) * 0.5;
    const midY = (min[1] + max[1]) * 0.5;
    const midZ = (min[2] + max[2]) * 0.5;
    const span = Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2], 1);
    const h = span * 0.5;
    return [midX - h, midY - h, midZ - h, midX + h, midY + h, midZ + h];
}

function findRootKey(nodesMap) {
    if (nodesMap['0-0-0-0'] && nodesMap['0-0-0-0'].pointCount > 0) return '0-0-0-0';
    let best = '';
    let bestDepth = 99;
    const keys = Object.keys(nodesMap);
    for (let i = 0; i < keys.length; i++) {
        const key = keys[i];
        const n = nodesMap[key];
        if (!n || !(n.pointCount > 0)) continue;
        const d = nodeDepth(key);
        if (d < bestDepth) {
            bestDepth = d;
            best = key;
        }
    }
    return best;
}

function lasBoundsToSceneBox(THREE, min, max) {
    return new THREE.Box3(
        new THREE.Vector3(min[0], min[2], -max[1]),
        new THREE.Vector3(max[0], max[2], -min[1])
    );
}

/**
 * @returns {{ requestLod: Function, tick: Function, dispose: Function, adgCache: object|null }}
 */
export async function bootAdgCopcLod(opts) {
    const THREE = opts.THREE;
    let camera = opts.camera;
    const renderer = opts.renderer;
    const cloudRoot = opts.cloudRoot;
    const lazUrl = opts.lazUrl;
    const cacheUrl = opts.cacheUrl || '';
    const pointSize = Number.isFinite(opts.pointSize) ? opts.pointSize : 0.03;
    const opacity = Number.isFinite(opts.opacity) ? opts.opacity : 1;
    const wasmUrl = opts.lazPerfWasmUrl || new URL('../ADG-2.0/js/laz-perf/laz-perf.wasm', import.meta.url).href;
    const getClipPlanes = typeof opts.getClipPlanes === 'function' ? opts.getClipPlanes : () => null;
    const onChunkAdded = typeof opts.onChunkAdded === 'function' ? opts.onChunkAdded : null;
    const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;

    const resident = new Map();
    const tightBoxes = new Map();
    const failedKeys = new Set();
    const lodHiddenAt = new Map();
    const _lodFrustum = new THREE.Frustum();
    const _lodProj = new THREE.Matrix4();
    const _lodSize = new THREE.Vector3();
    const _lodCamPos = new THREE.Vector3();
    const _lodCamQuat = new THREE.Quaternion();
    let lodCamArmed = false;
    let lodIdle = false;
    let lodBusy = false;
    let lodDirty = false;
    let lodNeed = false;
    let lastLodCheckAt = 0;
    let lodRangeScale = LOD_RANGE_SCALE_DEFAULT;
    let lodRefinedKeys = new Set();
    let copcRuntime = null;
    let adgCache = null;
    let disposed = false;

    function reportChunks() {
        const chunks = [];
        resident.forEach((obj) => chunks.push(obj));
        cloudRoot.userData.allCloudChunks = chunks.slice();
        cloudRoot.userData.visibleCloudChunks = chunks.filter((c) => c.visible);
        cloudRoot.userData.chunkCount = chunks.length;
    }

    function applyAdgCacheToChunk(chunk) {
        if (!adgCache || !chunk?.geometry) return false;
        const key = chunk.userData && chunk.userData.copcKey;
        if (!key) return false;
        const entry = adgCache.nodes.get(key);
        const count = chunk.geometry.getAttribute('position')?.count || 0;
        if (!entry || !count || entry.count !== count) return false;
        const copy = new Float32Array(entry.roughness);
        chunk.geometry.setAttribute('roughness', new THREE.BufferAttribute(copy, 1));
        return true;
    }

    function nodeLasBounds(key, cube) {
        const { d, x, y, z } = parseCopcKey(key);
        const size = (cube[3] - cube[0]) / Math.pow(2, Math.max(d, 0));
        const minx = cube[0] + x * size;
        const miny = cube[1] + y * size;
        const minz = cube[2] + z * size;
        return {
            min: [minx, miny, minz],
            max: [minx + size, miny + size, minz + size],
            size
        };
    }

    function nodeSceneBox(key) {
        const cube = copcRuntime && copcRuntime.cube;
        if (!cube) return new THREE.Box3();
        const las = nodeLasBounds(key, cube);
        return lasBoundsToSceneBox(THREE, las.min, las.max);
    }

    function updateLodFrustum() {
        camera.updateMatrixWorld();
        _lodProj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
        _lodFrustum.setFromProjectionMatrix(_lodProj);
    }

    function lodDistanceBox(key) {
        const stored = tightBoxes.get(key);
        if (stored) return stored;
        const octant = nodeSceneBox(key);
        let ancestor = parentCopcKey(key);
        while (ancestor) {
            const parentTight = tightBoxes.get(ancestor);
            if (parentTight) {
                const clipped = octant.clone().intersect(parentTight);
                if (!clipped.isEmpty()) return clipped;
                break;
            }
            ancestor = parentCopcKey(ancestor);
        }
        return octant;
    }

    function lodSseThresholds() {
        const refine = LOD_SSE_REFINE * (LOD_RANGE_SCALE_DEFAULT / lodRangeScale);
        return {
            refine: Math.max(24, refine),
            collapse: Math.max(12, refine * (LOD_SSE_COLLAPSE / LOD_SSE_REFINE))
        };
    }

    function nodeScreenPixels(box) {
        if (box.containsPoint(camera.position)) return 1e9;
        const dist = Math.max(box.distanceToPoint(camera.position), 1e-3);
        box.getSize(_lodSize);
        const extent = Math.max(_lodSize.x, _lodSize.y, _lodSize.z, 1e-4);
        const tanHalf = Math.tan(THREE.MathUtils.degToRad(camera.fov || 50) * 0.5);
        const h = (renderer && renderer.domElement && renderer.domElement.clientHeight) || window.innerHeight;
        return (extent / dist) * (h / (2 * tanHalf));
    }

    function tileShouldRefine(key, box) {
        const dist = box.distanceToPoint(camera.position);
        if (dist < LOD_NEAR_FORCE_M) return true;
        const sse = nodeScreenPixels(box);
        const { refine, collapse } = lodSseThresholds();
        if (lodRefinedKeys.has(key)) return sse >= collapse;
        return sse >= refine;
    }

    function lodFrontierPopNearest(frontier) {
        let best = 0;
        for (let i = 1; i < frontier.length; i++) {
            if (frontier[i].dist < frontier[best].dist) best = i;
        }
        return frontier.splice(best, 1)[0];
    }

    function collectDesiredKeys() {
        const rt = copcRuntime;
        if (!rt || !rt.nodesMap || !rt.rootKey) return [];
        const nodesMap = rt.nodesMap;
        updateLodFrustum();
        const desired = [];
        let points = 0;
        const seen = new Set();
        const nextRefined = new Set();
        const detailFrontier = [];
        const tryPush = (frontier, key) => {
            const node = nodesMap[key];
            if (!node || !(node.pointCount > 0) || seen.has(key)) return;
            frontier.push({ key, dist: lodDistanceBox(key).distanceToPoint(camera.position) });
        };
        const baseFrontier = [{
            key: rt.rootKey,
            dist: lodDistanceBox(rt.rootKey).distanceToPoint(camera.position)
        }];
        while (baseFrontier.length) {
            const cur = lodFrontierPopNearest(baseFrontier);
            const key = cur.key;
            if (seen.has(key)) continue;
            const node = nodesMap[key];
            if (!node || !(node.pointCount > 0)) continue;
            const octant = nodeSceneBox(key);
            if (!_lodFrustum.intersectsBox(octant)) continue;
            const depth = nodeDepth(key);
            if (depth > LOD_BASE_MAX_DEPTH) {
                detailFrontier.push(cur);
                continue;
            }
            seen.add(key);
            desired.push(key);
            points += node.pointCount;
            const distBox = lodDistanceBox(key);
            const kids = childCopcKeys(key);
            if (depth < LOD_BASE_MAX_DEPTH) {
                for (let i = 0; i < kids.length; i++) tryPush(baseFrontier, kids[i]);
            }
            if (tileShouldRefine(key, distBox)) {
                nextRefined.add(key);
                if (depth >= LOD_BASE_MAX_DEPTH) {
                    for (let i = 0; i < kids.length; i++) tryPush(detailFrontier, kids[i]);
                }
            }
        }
        while (detailFrontier.length) {
            const cur = lodFrontierPopNearest(detailFrontier);
            const key = cur.key;
            if (seen.has(key)) continue;
            const node = nodesMap[key];
            if (!node || !(node.pointCount > 0)) continue;
            const octant = nodeSceneBox(key);
            if (!_lodFrustum.intersectsBox(octant)) continue;
            seen.add(key);
            if (desired.length >= LOD_MAX_NODES) continue;
            if (points + node.pointCount > LOD_MAX_POINTS && desired.length) continue;
            desired.push(key);
            points += node.pointCount;
            const distBox = lodDistanceBox(key);
            if (!tileShouldRefine(key, distBox)) continue;
            nextRefined.add(key);
            const kids = childCopcKeys(key);
            for (let i = 0; i < kids.length; i++) tryPush(detailFrontier, kids[i]);
        }
        lodRefinedKeys = nextRefined;
        if (!desired.length && rt.rootKey && nodesMap[rt.rootKey]) desired.push(rt.rootKey);
        return desired;
    }

    function disposeResidentNode(key) {
        const obj = resident.get(key);
        if (!obj) return;
        resident.delete(key);
        cloudRoot.remove(obj);
        if (obj.geometry) obj.geometry.dispose();
        if (obj.material) {
            if (Array.isArray(obj.material)) obj.material.forEach((m) => m.dispose());
            else obj.material.dispose();
        }
    }

    function evictStaleHidden(desiredSet, now) {
        const expired = [];
        resident.forEach((obj, key) => {
            if (desiredSet.has(key)) return;
            const t = lodHiddenAt.get(key);
            if (t == null) return;
            if (now - t < LOD_UNLOAD_MS) return;
            expired.push({ key, t });
        });
        expired.sort((a, b) => a.t - b.t);
        for (let i = 0; i < expired.length; i++) {
            const remain = expired.length - i;
            if (remain <= LOD_CACHE_EXTRA) break;
            disposeResidentNode(expired[i].key);
            lodHiddenAt.delete(expired[i].key);
        }
    }

    function addNodePoints(view, key) {
        if (disposed || (key && resident.has(key))) return;
        const count = view.pointCount || 0;
        if (!count) return;
        const gx = view.getter('X');
        const gy = view.getter('Y');
        const gz = view.getter('Z');
        let gr;
        let gg;
        let gb;
        try {
            gr = view.getter('Red');
            gg = view.getter('Green');
            gb = view.getter('Blue');
        } catch (_) {
            gr = gg = gb = null;
        }
        const positions = new Float32Array(count * 3);
        const colors = new Float32Array(count * 3);
        // 与 three/PLYLoader 一致：顶点色按 sRGB 写入后再转工作色域（线性）。
        // 否则 ColorManagement 会把 sRGB 当线性再编码，点云发灰、对比变弱。
        const scratchColor = new THREE.Color();
        const srgbSpace = THREE.SRGBColorSpace;
        const rgbDivisor = gr ? detectLasRgbDivisor(gr, gg, gb, count) : 255;
        for (let i = 0; i < count; i++) {
            const i3 = i * 3;
            positions[i3] = gx(i);
            positions[i3 + 1] = gy(i);
            positions[i3 + 2] = gz(i);
            if (gr) {
                scratchColor.setRGB(
                    (Number(gr(i)) || 0) / rgbDivisor,
                    (Number(gg(i)) || 0) / rgbDivisor,
                    (Number(gb(i)) || 0) / rgbDivisor,
                    srgbSpace
                );
                colors[i3] = scratchColor.r;
                colors[i3 + 1] = scratchColor.g;
                colors[i3 + 2] = scratchColor.b;
            } else {
                colors[i3] = colors[i3 + 1] = colors[i3 + 2] = 0.85;
            }
        }
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
        geometry.userData.hasOriginalColor = true;
        // iOS：不立刻 slice 一份颜色拷贝；切非 RGB 着色时再由 viewer 懒拷贝
        geometry.userData.originalColorArray = IS_IOS ? colors : colors.slice();
        geometry.computeBoundingBox();
        if (key && geometry.boundingBox && !geometry.boundingBox.isEmpty()) {
            const bb = geometry.boundingBox;
            tightBoxes.set(key, lasBoundsToSceneBox(THREE, [bb.min.x, bb.min.y, bb.min.z], [bb.max.x, bb.max.y, bb.max.z]));
        }
        const clipPlanes = getClipPlanes();
        const material = new THREE.PointsMaterial({
            size: pointSize,
            vertexColors: true,
            sizeAttenuation: true,
            transparent: opacity < 0.999,
            opacity,
            clippingPlanes: clipPlanes || null,
            clipShadows: true,
            depthWrite: true
        });
        const points = new THREE.Points(geometry, material);
        points.userData.isNormalModel = true;
        points.userData.isCloudChunk = true;
        points.userData.copcKey = key;
        points.userData.parentCloudRoot = cloudRoot;
        points.userData.name = cloudRoot.userData.name;
        points.userData.directusId = cloudRoot.userData.directusId;
        if (geometry.boundingBox) {
            const center = geometry.boundingBox.getCenter(new THREE.Vector3());
            const radius = geometry.boundingBox.getSize(new THREE.Vector3()).length() * 0.5;
            points.userData.localSphereCenter = center;
            points.userData.localSphereRadius = Math.max(radius, 1e-5);
        }
        if (key) resident.set(key, points);
        applyAdgCacheToChunk(points);
        cloudRoot.add(points);
        if (onChunkAdded) onChunkAdded(points);
        reportChunks();
    }

    async function loadCopcNode(key, workerId) {
        const rt = copcRuntime;
        if (!rt || resident.has(key) || failedKeys.has(key) || disposed) return;
        const node = rt.nodesMap[key];
        if (!node) return;
        const view = await withTimeout(
            Copc.loadPointDataView(rt.getter, rt.copc, node, { lazPerf: rt.lazPerfs[workerId] }),
            NODE_LOAD_TIMEOUT_MS,
            key
        );
        if (!view || disposed) return;
        addNodePoints(view, key);
    }

    async function syncLod() {
        if (!copcRuntime || disposed) return;
        if (lodBusy) {
            lodDirty = true;
            return;
        }
        lodBusy = true;
        lodIdle = false;
        lodNeed = false;
        try {
            do {
                lodDirty = false;
                const desired = collectDesiredKeys();
                const desiredSet = new Set(desired);
                const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
                for (let i = 0; i < desired.length; i++) {
                    const key = desired[i];
                    lodHiddenAt.delete(key);
                    const obj = resident.get(key);
                    if (obj && !obj.visible) obj.visible = true;
                }
                const toLoad = desired.filter((key) => !resident.has(key) && !failedKeys.has(key));
                toLoad.sort((a, b) => nodeDepth(a) - nodeDepth(b) || a.localeCompare(b));
                if (toLoad.length) {
                    await mapPool(toLoad, LOAD_CONCURRENCY, async (key, _idx, workerId) => {
                        try {
                            await loadCopcNode(key, workerId);
                        } catch (err) {
                            failedKeys.add(key);
                            console.warn('[COPC] node skip', key, err);
                            try {
                                copcRuntime.lazPerfs[workerId] = await window.createLazPerf({
                                    wasmBinary: copcRuntime.wasmBinary
                                });
                            } catch (recreateErr) {
                                console.warn('[COPC] laz-perf recreate failed', recreateErr);
                            }
                        }
                    });
                }
                const afterLoad = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
                const residentKeys = Array.from(resident.keys());
                for (let i = 0; i < residentKeys.length; i++) {
                    const key = residentKeys[i];
                    if (desiredSet.has(key)) continue;
                    if (!lodHiddenAt.has(key)) lodHiddenAt.set(key, now);
                    const obj = resident.get(key);
                    if (!obj) continue;
                    obj.visible = (afterLoad - lodHiddenAt.get(key)) < LOD_UNLOAD_MS;
                }
                evictStaleHidden(desiredSet, afterLoad);
                reportChunks();
            } while (lodDirty && !disposed);
        } finally {
            lodBusy = false;
            lodIdle = true;
        }
    }

    if (IS_IOS) {
        console.info('[COPC] iOS 低内存模式：concurrency=1, maxPoints=400000, maxNodes=48');
    }
    if (onProgress) onProgress(5);
    const getter = createRangeGetter(lazUrl);
    const copc = await Copc.create(getter);
    const header = copc.header || {};
    const expected = Number(header.pointCount) || 0;
    if (onProgress) onProgress(20);
    const cachePromise = cacheUrl
        ? loadAdgcFromUrl(cacheUrl, expected).catch((err) => {
            console.warn('[COPC] ADGC 读取失败', err);
            return null;
        })
        : Promise.resolve(null);
    const poolPromise = createLazPerfPool(LOAD_CONCURRENCY, wasmUrl);
    const nodesPromise = loadAllHierarchy(getter, copc.info.rootHierarchyPage);
    const [cache, pool, nodesMap] = await Promise.all([cachePromise, poolPromise, nodesPromise]);
    adgCache = cache;
    if (cache) {
        cloudRoot.userData.flatnessMeta = { min: cache.min, max: cache.max };
        cloudRoot.userData.flatnessReady = true;
        cloudRoot.userData.flatnessRadiusUsed = cache.radius;
        cloudRoot.userData.flatnessMinNeighborsUsed = cache.minNeighbors;
        cloudRoot.userData.flatnessFromCopcCache = true;
        cloudRoot.userData.pointCount = cache.sourcePointCount || cache.totalPoints || expected;
    } else {
        cloudRoot.userData.pointCount = expected;
    }
    const keys = Object.keys(nodesMap).filter((key) => nodesMap[key] && nodesMap[key].pointCount > 0);
    if (!keys.length) throw new Error('hierarchy 里没有可加载节点');
    const rootKey = findRootKey(nodesMap);
    if (!rootKey) throw new Error('hierarchy 没有根节点');
    copcRuntime = {
        getter,
        copc,
        nodesMap,
        rootKey,
        cube: resolveCopcCube(copc.info, header),
        lazPerfs: pool.lazPerfs,
        wasmBinary: pool.wasmBinary
    };
    if (onProgress) onProgress(55);
    lodNeed = true;
    await syncLod();
    if (onProgress) onProgress(100);

    function cameraMovedEnough() {
        if (!lodCamArmed) return true;
        if (_lodCamPos.distanceTo(camera.position) >= LOD_CAM_MOVE_M) return true;
        return Math.abs(_lodCamQuat.dot(camera.quaternion)) < LOD_CAM_ROT_DOT;
    }

    return {
        get adgCache() { return adgCache; },
        setCamera(next) {
            if (!next || next === camera) return;
            camera = next;
            lodCamArmed = false;
            lodNeed = true;
            lodDirty = true;
        },
        requestLod() {
            lodNeed = true;
            lodDirty = true;
        },
        onCameraMoved() {
            if (cameraMovedEnough()) {
                lodNeed = true;
                lodDirty = true;
            }
        },
        tick(now) {
            if (disposed || !copcRuntime || !lodNeed) return;
            if (now - lastLodCheckAt < LOD_THROTTLE_MS) return;
            lastLodCheckAt = now;
            _lodCamPos.copy(camera.position);
            camera.getWorldQuaternion(_lodCamQuat);
            lodCamArmed = true;
            void syncLod();
        },
        dispose() {
            disposed = true;
            resident.forEach((_obj, key) => disposeResidentNode(key));
            resident.clear();
            copcRuntime = null;
        }
    };
}
