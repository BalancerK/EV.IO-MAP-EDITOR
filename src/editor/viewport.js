// The 3D view: renders the document, picks, places and transforms things. It never edits the
// document directly — every change goes through the callbacks the app passes in, so undo/redo and
// autosave see all of them.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { buildBlockTriangles } from '../model/geometry.js';
import { lightDirection, cameraForward, hexToRgb, shadowSettingsFor } from '../model/compile.js';
import { COLLISION } from '../model/document.js';

const COLORS = { spawn: 0x4fd47a, team1: 0x4f8fff, team2: 0xff8a3d, weapon: 0xb07cff, teleport: 0xff5d5d, nav: 0xffd84a, camera: 0x4cc9f0, select: 0xf0a830, br: 0xff5d5d, kill: 0xff3b30 };
const KILL_Y = -30;
const deg = THREE.MathUtils.degToRad;
const rad = THREE.MathUtils.radToDeg;

// ---------------------------------------------------------------- render like the game
// ev.io 1-7-1 renders with an older three.js: no colour management, no tone mapping, linear output,
// legacy light units, VSM shadows, and toon materials through three.js's threeTone gradient. It
// also patches two shader chunks. All of that is reproduced here so the editor (and the Upload
// images renders) look like the game.
THREE.ColorManagement.enabled = false;

// Game fog (its "HackFogExpSmooth"): the stronger of exp2 fog at the map's density and a linear
// fade over the last 30% of the view distance. Used through THREE.Fog(color, density, farPlane).
THREE.ShaderChunk.fog_fragment = `
#ifdef USE_FOG
	#ifdef FOG_EXP2
		float fogFactor = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );
	#else
		float fogLastMile = ( clamp( vFogDepth / fogFar, 0.7, 1.0 ) - 0.7 ) / 0.3;
		float fogExp2 = 1.0 - exp( - fogNear * fogNear * vFogDepth * vFogDepth );
		float fogFactor = max( fogLastMile, fogExp2 );
	#endif
	gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor, fogFactor );
#endif
`;

// Game shadow patch: a shadow darkens direct light only down to (1 - shadowStrength), and with
// EV_USE_SHADOW_HACK a face turned away from the sun counts as fully shadowed.
{
    const from = 'directLight.color *= ( directLight.visible && receiveShadow ) ? getShadow( directionalShadowMap[ i ], directionalLightShadow.shadowMapSize, directionalLightShadow.shadowBias, directionalLightShadow.shadowRadius, vDirectionalShadowCoord[ i ] ) : 1.0;';
    const to = `float evShadow = ( directLight.visible && receiveShadow ) ? getShadow( directionalShadowMap[ i ], directionalLightShadow.shadowMapSize, directionalLightShadow.shadowBias, directionalLightShadow.shadowRadius, vDirectionalShadowCoord[ i ] ) : 1.0;
		#if defined( EV_USE_SHADOW_HACK )
			evShadow *= dot( directLight.direction, geometryNormal ) > 0.0 ? 1.0 : 0.0;
		#endif
		#if defined( SHADOW_INV_STRENGTH )
			directLight.color *= max( SHADOW_INV_STRENGTH, evShadow );
		#else
			directLight.color *= evShadow;
		#endif`;
    if (THREE.ShaderChunk.lights_fragment_begin.includes(from)) {
        THREE.ShaderChunk.lights_fragment_begin = THREE.ShaderChunk.lights_fragment_begin.replace(from, to);
    } else {
        console.warn('[map-editor] three.js shadow chunk changed: game shadow strength not applied');
    }
}

// The game loads this exact gradient (three.js's examples/textures/gradientMaps/threeTone.jpg) with
// default filtering. Until it arrives, an equivalent three-step ramp stands in.
const TOON_GRADIENT_URL = 'https://cdn.jsdelivr.net/gh/mrdoob/three.js@r160/examples/textures/gradientMaps/threeTone.jpg';
const toonGradient = new THREE.DataTexture(new Uint8Array([90, 90, 90, 255, 170, 170, 170, 255, 255, 255, 255, 255]), 3, 1);
toonGradient.needsUpdate = true;
new THREE.TextureLoader().load(TOON_GRADIENT_URL, (tex) => {
    toonGradient.image = tex.image;
    toonGradient.needsUpdate = true;
}, undefined, () => { /* offline: keep the built-in ramp */ });

export class Viewport {
    constructor(container, callbacks) {
        this.container = container;
        this.cb = callbacks;   // { onSelect(sel), onPlace(point, normal, hitBlockId), onTransform(sel, {position, rotation, size}), onHover(point) }
        this.doc = null;
        this.selection = null;
        this.tool = 'select';
        this.grid = 1;
        this.placing = null;   // { kind: 'block'|'object', shape|type }
        this.blockMeshes = new Map();
        this.objectGroups = new Map();
        this.materialCache = new Map();

        const renderer = this.renderer = new THREE.WebGLRenderer({ antialias: true });
        renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        renderer.shadowMap.enabled = true;
        renderer.shadowMap.type = THREE.VSMShadowMap;           // the game's shadow type
        renderer.outputColorSpace = THREE.LinearSRGBColorSpace; // the game writes colours as-is
        renderer.useLegacyLights = true;                        // the game's light units
        container.appendChild(renderer.domElement);

        const scene = this.scene = new THREE.Scene();
        this.camera = new THREE.PerspectiveCamera(70, 1, 0.1, 2000);
        this.camera.position.set(38, 30, 38);

        this.orbit = new OrbitControls(this.camera, renderer.domElement);
        this.orbit.target.set(0, 0, 0);
        this.orbit.enableDamping = true;
        this.orbit.dampingFactor = 0.12;
        this.orbit.mouseButtons = { LEFT: null, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.ROTATE };
        this.orbit.screenSpacePanning = true;

        this.gizmo = new TransformControls(this.camera, renderer.domElement);
        this.gizmo.setTranslationSnap(this.grid);
        this.gizmo.setRotationSnap(deg(15));
        this.gizmo.addEventListener('dragging-changed', (e) => {
            this.orbit.enabled = !e.value;
            if (!e.value) this.commitGizmo();
        });
        scene.add(this.gizmo);

        // World furniture.
        this.sky = makeSkyDome();
        scene.add(this.sky);
        this.gridHelper = new THREE.GridHelper(400, 400, 0x4a5866, 0x26313b);
        this.gridHelper.material.transparent = true;
        this.gridHelper.material.opacity = 0.55;
        this.gridHelper.position.y = 0.002;
        scene.add(this.gridHelper);
        const kill = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), new THREE.MeshBasicMaterial({ color: COLORS.kill, transparent: true, opacity: 0.08, side: THREE.DoubleSide, depthWrite: false }));
        kill.rotation.x = -Math.PI / 2;
        kill.position.y = KILL_Y;
        scene.add(kill);
        this.killPlane = kill;
        this.groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

        this.hemi = new THREE.HemisphereLight(0xabd4ff, 0xbb9e8c, 0.3);
        scene.add(this.hemi);
        // Editor-only work light (off by default, so the view matches the game): lifts dark faces
        // when building inside unlit areas. Never part of exported maps or rendered images.
        this.ambient = new THREE.AmbientLight(0xffffff, 0);
        scene.add(this.ambient);
        this.framing = null;
        this.lights = [];

        this.contentRoot = new THREE.Group();
        scene.add(this.contentRoot);
        this.objectRoot = new THREE.Group();
        scene.add(this.objectRoot);

        this.ghost = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({ color: COLORS.select, transparent: true, opacity: 0.35, depthWrite: false }));
        this.ghost.visible = false;
        scene.add(this.ghost);
        this.ghostEdges = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: COLORS.select }));
        this.ghost.add(this.ghostEdges);

        this.selectionBox = new THREE.BoxHelper(undefined, COLORS.select);
        this.selectionBox.visible = false;
        scene.add(this.selectionBox);
        // Multi-selection: one outline per selected item, and a pivot the gizmo moves the group by.
        this.selected = [];
        this.extraBoxes = [];
        this.pivot = new THREE.Object3D();
        scene.add(this.pivot);
        this.groupDrag = null;
        this.gizmo.addEventListener('objectChange', () => this.applyGroupDrag());
        this.marqueeEl = document.createElement('div');
        this.marqueeEl.className = 'marquee';
        this.marqueeEl.hidden = true;
        container.appendChild(this.marqueeEl);
        this.navKeys = new Set();

        this.raycaster = new THREE.Raycaster();
        this.pointer = new THREE.Vector2();
        this.bindPointer();
        this.bindFramingInput();
        this.bindArrowKeys();
        this.resizeObserver = new ResizeObserver(() => this.resize());
        this.resizeObserver.observe(container);
        this.resize();
        this.flyover = null;
        const loop = () => { requestAnimationFrame(loop); this.frame(); };
        loop();
    }

    resize() {
        const w = this.container.clientWidth || 1, h = this.container.clientHeight || 1;
        this.renderer.setSize(w, h);
        this.camera.aspect = w / h;
        this.camera.updateProjectionMatrix();
    }

    frame() {
        const now = performance.now();
        const dt = Math.min(0.1, (now - (this._lastFrame || now)) / 1000);
        this._lastFrame = now;
        if (this.framing) this.stepFraming(dt);
        else if (this.flyover) this.stepFlyover();
        else this.orbit.update();
        if (!this.framing && !this.flyover) this.stepArrowKeys(dt);
        if (this.selectionBox.visible && this.selectedObject3D()) this.selectionBox.update();
        for (const b of this.extraBoxes) if (b.visible && b.userData.obj) b.update();
        this.sky.position.copy(this.camera.position);
        this.renderer.render(this.scene, this.camera);
    }

    setGrid(size) { this.grid = size; this.gizmo.setTranslationSnap(size); }
    setWorkLight(on) { this.ambient.intensity = on ? 0.45 : 0; }
    setTool(tool, placing = null) {
        this.tool = tool;
        this.placing = placing;
        this.ghost.visible = false;
        if (tool === 'place') this.gizmo.detach();
        else this.attachGizmo();
    }
    setGizmoMode(mode) { this.gizmo.setMode(mode); this.attachGizmo(); }

    // ------------------------------------------------------------------ document -> scene
    sync(doc) {
        this.doc = doc;
        this.syncEnvironment(doc);
        this.syncBlocks(doc);
        this.syncObjects(doc);
        this.attachGizmo();
    }

    materialFor(block) {
        if (block.collision === COLLISION.INVISIBLE) {
            return this.cachedMaterial('invisible', () => new THREE.MeshBasicMaterial({ color: 0xff5d5d, transparent: true, opacity: 0.18, depthWrite: false }));
        }
        // The game's map material (bundle: buildEVMaterial): toon shading through the threeTone
        // gradient, dithered, front faces drawn, both sides casting shadows, plus the shadow-strength
        // and away-from-sun defines its patched shader reads.
        const m = this.doc.materials.find((x) => x.id === block.materialId) || this.doc.materials[0];
        const inv = (1 - (this.doc.environment.shadowStrength ?? 0.75)).toFixed(4);
        const key = `${m?.id}|${m?.color}|${m?.opacity ?? 1}|${m?.emissive || ''}|${inv}`;
        return this.cachedMaterial(key, () => new THREE.MeshToonMaterial({
            color: new THREE.Color(m?.color || '#9aa1a8'),
            emissive: new THREE.Color(m?.emissive || '#000000'),
            opacity: m?.opacity ?? 1,
            transparent: (m?.opacity ?? 1) < 0.99,
            gradientMap: toonGradient,
            dithering: true,
            side: THREE.FrontSide,
            shadowSide: THREE.DoubleSide,
            defines: { TOON: '', SHADOW_INV_STRENGTH: inv, EV_USE_SHADOW_HACK: '' },
        }));
    }
    cachedMaterial(key, make) {
        if (!this.materialCache.has(key)) this.materialCache.set(key, make());
        return this.materialCache.get(key);
    }

    syncBlocks(doc) {
        const seen = new Set();
        for (const block of doc.blocks) {
            seen.add(block.id);
            const sig = JSON.stringify([block.shape, block.size, block.steps, block.segments]);
            let mesh = this.blockMeshes.get(block.id);
            if (!mesh || mesh.userData.sig !== sig) {
                if (mesh) { this.contentRoot.remove(mesh); mesh.geometry.dispose(); }
                mesh = new THREE.Mesh(localBlockGeometry(block), this.materialFor(block));
                mesh.userData = { sig, kind: 'block', id: block.id };
                this.contentRoot.add(mesh);
                this.blockMeshes.set(block.id, mesh);
            }
            mesh.material = this.materialFor(block);
            mesh.userData.invisible = block.collision === COLLISION.INVISIBLE;   // hidden in rendered images
            mesh.position.set(block.position.x, block.position.y, block.position.z);
            mesh.rotation.set(deg(block.rotation.x), deg(block.rotation.y), deg(block.rotation.z), 'XYZ');
            mesh.scale.set(1, 1, 1);
            mesh.visible = !block.hidden;
            mesh.userData.locked = !!block.locked;
            mesh.castShadow = block.collision !== COLLISION.INVISIBLE && block.shadows !== false;
            mesh.receiveShadow = block.collision !== COLLISION.INVISIBLE;
        }
        for (const [id, mesh] of this.blockMeshes) {
            if (!seen.has(id)) { this.contentRoot.remove(mesh); mesh.geometry.dispose(); this.blockMeshes.delete(id); }
        }
    }

    syncObjects(doc) {
        for (const g of this.objectGroups.values()) this.objectRoot.remove(g);
        this.objectGroups.clear();
        const add = (kind, item, obj) => {
            obj.userData = { kind, id: item.id };
            // Parents are visited before children, so a camera marker's start/end part flows down.
            obj.traverse((c) => {
                const part = c.userData.part || (c.parent && c.parent.userData.part);
                c.userData = part ? { kind, id: item.id, part } : { kind, id: item.id };
            });
            obj.visible = !item.hidden;
            if (item.locked) obj.traverse((c) => { c.userData.locked = true; });
            this.objectRoot.add(obj);
            this.objectGroups.set(item.id, obj);
        };
        for (const s of doc.playerSpawns) add('playerSpawns', s, markerSpawn(s));
        for (const w of doc.weaponSpawns) add('weaponSpawns', w, markerSphere(w.position, COLORS.weapon, 0.45));
        for (const t of doc.teleporters) add('teleporters', t, markerTeleporter(t));
        for (const n of doc.navNodes) add('navNodes', n, markerSphere(n.position, COLORS.nav, 0.35));
        for (const c of doc.cameraPaths) add('cameraPaths', c, markerCameraPath(c));
        if (doc.brCircle) add('brCircle', { id: 'brCircle', ...doc.brCircle }, markerCircle(doc.brCircle));

        // Links: nav graph and teleporter destinations (not pickable).
        const linkPts = [];
        const navById = new Map(doc.navNodes.map((n) => [n.id, n]));
        for (const n of doc.navNodes) for (const id of n.links || []) {
            const m = navById.get(id);
            if (m) linkPts.push(n.position.x, n.position.y + 0.35, n.position.z, m.position.x, m.position.y + 0.35, m.position.z);
        }
        const navLines = new THREE.LineSegments(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(linkPts, 3)), new THREE.LineBasicMaterial({ color: COLORS.nav }));
        navLines.userData = { kind: 'decor' };
        this.objectRoot.add(navLines);
        this.objectGroups.set('__navlines', navLines);
        const telePts = [];
        const teleById = new Map(doc.teleporters.map((t) => [t.id, t]));
        for (const t of doc.teleporters) for (const id of t.destinations || []) {
            const d = teleById.get(id);
            if (d) telePts.push(t.position.x, t.position.y + 1, t.position.z, d.position.x, d.position.y + 1, d.position.z);
        }
        const teleLines = new THREE.LineSegments(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(telePts, 3)), new THREE.LineDashedMaterial({ color: COLORS.teleport, dashSize: 1, gapSize: 0.6 }));
        teleLines.computeLineDistances();
        teleLines.userData = { kind: 'decor' };
        this.objectRoot.add(teleLines);
        this.objectGroups.set('__telelines', teleLines);
    }

    syncEnvironment(doc) {
        const env = doc.environment;
        this.sky.material.uniforms.top.value.set(env.skyTop);
        this.sky.material.uniforms.horizon.value.set(env.skyHorizon);
        this.sky.material.uniforms.bottom.value.set(env.skyBottom);
        // THREE.Fog's near carries the density into the game's fog formula (see fog_fragment above).
        this.scene.fog = env.fogDensity > 1e-9 ? new THREE.Fog(new THREE.Color(env.fogColor), env.fogDensity, Math.max(100, env.farPlane || 1000)) : null;
        this.hemi.color.set(env.hemiSky);
        this.hemi.groundColor.set(env.hemiGround);
        this.hemi.intensity = env.hemiIntensity;
        this.camera.far = Math.max(200, env.farPlane || 1000);
        this.camera.updateProjectionMatrix();
        for (const l of this.lights) { this.scene.remove(l); this.scene.remove(l.target); }
        this.lights = [];
        // Placed as the game places them: the shadow caster at the exported shadow position aiming
        // along its direction, with the same box, bias and blur; the others shine from -direction.
        let shadowUsed = false;
        const shadow = shadowSettingsFor(doc);
        for (const l of doc.lights) {
            const light = new THREE.DirectionalLight(new THREE.Color(l.color), l.intensity);
            const d = lightDirection(l);
            light.position.set(-d.x, -d.y, -d.z);
            light.target.position.set(0, 0, 0);
            if (l.castsShadow && !shadowUsed) {
                shadowUsed = true;
                light.position.set(shadow.position.x, shadow.position.y, shadow.position.z);
                light.target.position.set(shadow.position.x + d.x, shadow.position.y + d.y, shadow.position.z + d.z);
                light.castShadow = true;
                light.shadow.mapSize.set(2048, 2048);
                const s = light.shadow.camera;
                s.left = -shadow.halfWidth; s.right = shadow.halfWidth; s.top = shadow.halfHeight; s.bottom = -shadow.halfHeight;
                s.near = 0.5; s.far = shadow.far;
                light.shadow.bias = -3e-4;
                light.shadow.radius = 5;
            }
            this.scene.add(light);
            this.scene.add(light.target);
            this.lights.push(light);
        }
    }

    // ------------------------------------------------------------------ selection & gizmo
    select(sel) { this.selectMany(sel ? [sel] : [], sel); }
    // Several items: the gizmo moves (or turns about the vertical) all of them around their centre.
    selectMany(list, primary = list[list.length - 1] || null) {
        this.selected = list.slice();
        this.selection = primary;
        this.attachGizmo();
    }
    objectFor(sel) {
        if (!sel) return null;
        if (sel.kind === 'block') return this.blockMeshes.get(sel.id) || null;
        const group = this.objectGroups.get(sel.id) || null;
        if (group && sel.kind === 'cameraPaths' && sel.part) return group.children.find((c) => c.userData.part === sel.part) || group;
        return group;
    }
    selectedObject3D() {
        if (!this.selection) return null;
        if (this.selection.kind === 'block') return this.blockMeshes.get(this.selection.id) || null;
        const group = this.objectGroups.get(this.selection.id) || null;
        if (group && this.selection.kind === 'cameraPaths' && this.selection.part) {
            return group.children.find((c) => c.userData.part === this.selection.part) || group;
        }
        return group;
    }
    attachGizmo() {
        for (const b of this.extraBoxes) { b.visible = false; b.userData.obj = null; }
        if (this.tool === 'select' && this.selected.length > 1) return this.attachGroupGizmo();
        const obj = this.tool === 'select' ? this.selectedObject3D() : null;
        if (!obj) { this.gizmo.detach(); this.selectionBox.visible = false; return; }
        const kind = this.selection.kind;
        // Only blocks rotate on all axes and resize; markers just move (yaw is edited as a number).
        const mode = this.gizmo.getMode();
        if (kind !== 'block' && mode !== 'translate') this.gizmo.setMode('translate');
        this.gizmo.showX = true; this.gizmo.showY = true; this.gizmo.showZ = true;
        if (kind === 'cameraPaths' && !this.selection.part) { this.gizmo.detach(); }
        else this.gizmo.attach(obj);
        this.selectionBox.setFromObject(obj);
        this.selectionBox.visible = true;
    }
    attachGroupGizmo() {
        const objs = this.selected.map((s) => this.objectFor(s)).filter(Boolean);
        this.selectionBox.visible = false;
        objs.forEach((obj, i) => {
            if (!this.extraBoxes[i]) { const b = new THREE.BoxHelper(undefined, COLORS.select); this.scene.add(b); this.extraBoxes[i] = b; }
            const b = this.extraBoxes[i];
            b.setFromObject(obj); b.userData.obj = obj; b.visible = true;
        });
        if (!objs.length) { this.gizmo.detach(); return; }
        const centre = new THREE.Vector3();
        for (const o of objs) centre.add(o.getWorldPosition(new THREE.Vector3()));
        centre.divideScalar(objs.length);
        this.pivot.position.copy(centre);
        this.pivot.rotation.set(0, 0, 0);
        // A group moves, or turns about the vertical; it is not resized.
        if (this.gizmo.getMode() === 'scale') this.gizmo.setMode('translate');
        const turning = this.gizmo.getMode() === 'rotate';
        this.gizmo.showX = !turning; this.gizmo.showY = true; this.gizmo.showZ = !turning;
        this.gizmo.attach(this.pivot);
        this.groupDrag = { objs, start: objs.map((o) => ({ pos: o.position.clone(), quat: o.quaternion.clone() })), pivot: centre.clone() };
    }
    applyGroupDrag() {
        const g = this.groupDrag;
        if (!g || this.gizmo.object !== this.pivot) return;
        const delta = this.pivot.position.clone().sub(g.pivot);
        const turn = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), this.pivot.rotation.y);
        g.objs.forEach((o, i) => {
            const st = g.start[i];
            const rel = st.pos.clone().sub(g.pivot).applyQuaternion(turn);
            o.position.copy(g.pivot).add(rel).add(delta);
            o.quaternion.copy(turn).multiply(st.quat);
        });
    }
    commitGizmo() {
        const obj = this.gizmo.object;
        if (obj === this.pivot && this.groupDrag) {
            const g = this.groupDrag;
            const delta = this.pivot.position.clone().sub(g.pivot);
            this.cb.onGroupTransform?.(this.selected, {
                delta: { x: round(delta.x), y: round(delta.y), z: round(delta.z) },
                turn: round(rad(this.pivot.rotation.y)),
                pivot: { x: g.pivot.x, y: g.pivot.y, z: g.pivot.z },
            });
            return;
        }
        if (!obj || !this.selection) return;
        const sel = this.selection;
        if (sel.kind === 'block') {
            const block = this.doc.blocks.find((b) => b.id === sel.id);
            if (!block) return;
            const size = { x: round(block.size.x * Math.abs(obj.scale.x)), y: round(block.size.y * Math.abs(obj.scale.y)), z: round(block.size.z * Math.abs(obj.scale.z)) };
            const snapSize = (v) => Math.max(0.05, this.gizmo.getMode() === 'scale' ? Math.round(v / (this.grid / 2)) * (this.grid / 2) || this.grid / 2 : v);
            this.cb.onTransform(sel, {
                position: { x: round(obj.position.x), y: round(obj.position.y), z: round(obj.position.z) },
                rotation: { x: round(rad(obj.rotation.x)), y: round(rad(obj.rotation.y)), z: round(rad(obj.rotation.z)) },
                size: { x: snapSize(size.x), y: snapSize(size.y), z: snapSize(size.z) },
            });
        } else {
            // Camera markers sit in a group at the origin, so their local position is world position.
            this.cb.onTransform(sel, { delta: { x: round(obj.position.x), y: round(obj.position.y), z: round(obj.position.z) }, part: sel.part });
        }
    }

    // ------------------------------------------------------------------ picking & placing
    bindPointer() {
        const el = this.renderer.domElement;
        let down = null;
        el.addEventListener('pointerdown', (e) => {
            if (e.button !== 0) return;
            // A left-drag that does not start on the gizmo draws a selection box (select tool).
            down = { x: e.clientX, y: e.clientY, onGizmo: !!this.gizmo.axis, additive: e.shiftKey || e.ctrlKey || e.metaKey };
        });
        el.addEventListener('pointerup', (e) => {
            if (e.button !== 0 || !down) return;
            const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4;
            const d = down;
            down = null;
            if (this.marqueeActive) { this.finishMarquee(d, e); return; }
            if (moved || this.gizmo.dragging || this.gizmoHovered || this.framing) return;
            this.updatePointer(e);
            if (this.tool === 'place') this.placeAtPointer();
            else this.pickAtPointer(e.shiftKey || e.ctrlKey || e.metaKey);
        });
        el.addEventListener('pointermove', (e) => {
            if (down && !down.onGizmo && this.tool === 'select' && !this.framing && !this.gizmo.dragging
                && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4) this.drawMarquee(down, e);
            this.updatePointer(e);
            this.gizmoHovered = !!this.gizmo.axis;
            const hit = this.surfaceHit();
            if (hit) this.cb.onHover?.(hit.point);
            if (this.tool === 'place') this.updateGhost(hit);
        });
        el.addEventListener('pointerleave', () => { this.ghost.visible = false; });
        el.addEventListener('contextmenu', (e) => e.preventDefault());
    }
    updatePointer(e) {
        const r = this.renderer.domElement.getBoundingClientRect();
        this.pointer.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
        this.raycaster.setFromCamera(this.pointer, this.camera);
    }
    pickAtPointer(additive = false) {
        const targets = [...this.objectRoot.children.filter((o) => o.userData.kind !== 'decor'), ...this.contentRoot.children];
        const hits = this.raycaster.intersectObjects(targets, true);
        // The raycaster also hits hidden objects; skip those and anything locked.
        const hit = hits.find((h) => h.object.userData && h.object.userData.id && !h.object.userData.locked && visibleChain(h.object));
        const u = hit && hit.object.userData;
        const sel = u ? (u.part ? { kind: u.kind, id: u.id, part: u.part } : { kind: u.kind, id: u.id }) : null;
        this.cb.onSelect(sel, { additive });
    }
    drawMarquee(down, e) {
        const r = this.container.getBoundingClientRect();
        const x0 = Math.min(down.x, e.clientX) - r.left, y0 = Math.min(down.y, e.clientY) - r.top;
        Object.assign(this.marqueeEl.style, { left: x0 + 'px', top: y0 + 'px', width: Math.abs(e.clientX - down.x) + 'px', height: Math.abs(e.clientY - down.y) + 'px' });
        this.marqueeEl.hidden = false;
        this.marqueeActive = true;
    }
    // Everything visible and unlocked whose centre falls inside the box.
    finishMarquee(down, e) {
        this.marqueeEl.hidden = true;
        this.marqueeActive = false;
        const r = this.renderer.domElement.getBoundingClientRect();
        const minX = Math.min(down.x, e.clientX) - r.left, maxX = Math.max(down.x, e.clientX) - r.left;
        const minY = Math.min(down.y, e.clientY) - r.top, maxY = Math.max(down.y, e.clientY) - r.top;
        const inside = (obj) => {
            const c = new THREE.Box3().setFromObject(obj).getCenter(new THREE.Vector3()).project(this.camera);
            if (c.z < -1 || c.z > 1) return false;
            const sx = (c.x + 1) / 2 * r.width, sy = (1 - c.y) / 2 * r.height;
            return sx >= minX && sx <= maxX && sy >= minY && sy <= maxY;
        };
        const found = [];
        for (const [id, mesh] of this.blockMeshes) if (mesh.visible && !mesh.userData.locked && inside(mesh)) found.push({ kind: 'block', id });
        for (const [id, obj] of this.objectGroups) {
            const k = obj.userData.kind;
            if (!k || k === 'decor' || k === 'cameraPaths' || k === 'brCircle' || !obj.visible || obj.userData.locked) continue;
            if (inside(obj)) found.push({ kind: k, id });
        }
        this.cb.onMarquee?.(found, { additive: down.additive });
    }

    // ------------------------------------------------------------------ arrow keys move the view
    // Arrow keys slide the editor camera (and what it orbits) across the ground; PageUp/PageDown
    // raise and lower it; Shift is faster. Speed scales with how far out the camera is.
    bindArrowKeys() {
        const keys = { arrowup: 'f', arrowdown: 'b', arrowleft: 'l', arrowright: 'r', pageup: 'u', pagedown: 'd' };
        window.addEventListener('keydown', (e) => {
            if (/^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement?.tagName) || e.ctrlKey || e.metaKey || e.altKey) return;
            const k = keys[e.key.toLowerCase()];
            if (k) { this.navKeys.add(k); e.preventDefault(); }
            if (e.key === 'Shift') this.navKeys.add('fast');
        });
        window.addEventListener('keyup', (e) => {
            const k = keys[e.key.toLowerCase()];
            if (k) this.navKeys.delete(k);
            if (e.key === 'Shift') this.navKeys.delete('fast');
        });
        window.addEventListener('blur', () => this.navKeys.clear());
    }
    stepArrowKeys(dt) {
        const k = this.navKeys;
        if (!k.size || (k.size === 1 && k.has('fast'))) return;
        const fwd = new THREE.Vector3();
        this.camera.getWorldDirection(fwd);
        fwd.y = 0;
        if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, -1);
        fwd.normalize();
        const right = new THREE.Vector3(-fwd.z, 0, fwd.x);
        const move = new THREE.Vector3();
        if (k.has('f')) move.add(fwd);
        if (k.has('b')) move.sub(fwd);
        if (k.has('r')) move.add(right);
        if (k.has('l')) move.sub(right);
        if (k.has('u')) move.y += 1;
        if (k.has('d')) move.y -= 1;
        if (!move.lengthSq()) return;
        const dist = this.camera.position.distanceTo(this.orbit.target);
        const speed = Math.max(6, dist * 0.9) * (k.has('fast') ? 3 : 1);
        move.normalize().multiplyScalar(speed * dt);
        this.camera.position.add(move);
        this.orbit.target.add(move);
    }
    // First surface under the pointer: a block face, else the ground plane (y = 0).
    surfaceHit() {
        const hits = this.raycaster.intersectObjects(this.contentRoot.children, false);
        if (hits.length) {
            const h = hits[0];
            const normal = h.face.normal.clone().transformDirection(h.object.matrixWorld);
            return { point: h.point.clone(), normal, blockId: h.object.userData.id };
        }
        const p = new THREE.Vector3();
        if (this.raycaster.ray.intersectPlane(this.groundPlane, p)) return { point: p, normal: new THREE.Vector3(0, 1, 0), blockId: null };
        return null;
    }
    // Where a new piece would go for a surface hit, snapped to the grid.
    placementFor(hit) {
        if (!hit || !this.placing) return null;
        const g = this.grid;
        const snap = (v) => Math.round(v / g) * g;
        if (this.placing.kind === 'block') {
            const size = this.placing.size;
            const n = hit.normal;
            const ax = Math.abs(n.x), ay = Math.abs(n.y), az = Math.abs(n.z);
            const p = hit.point.clone();
            // Sit the block against the face it was dropped on.
            if (ay >= ax && ay >= az) { p.x = snap(p.x); p.z = snap(p.z); p.y = hit.point.y + Math.sign(n.y || 1) * size.y / 2; }
            else if (ax >= az) { p.y = snap(p.y - size.y / 2) + size.y / 2; p.z = snap(p.z); p.x = hit.point.x + Math.sign(n.x) * size.x / 2; }
            else { p.y = snap(p.y - size.y / 2) + size.y / 2; p.x = snap(p.x); p.z = hit.point.z + Math.sign(n.z) * size.z / 2; }
            return { x: round(p.x), y: round(p.y), z: round(p.z) };
        }
        const lift = this.placing.type === 'weaponSpawns' ? 0.5 : 0.1;
        return { x: round(snap(hit.point.x)), y: round(hit.point.y + lift), z: round(snap(hit.point.z)) };
    }
    updateGhost(hit) {
        const pos = this.placementFor(hit);
        if (!pos) { this.ghost.visible = false; return; }
        if (this.placing.kind === 'block') {
            const sig = JSON.stringify(this.placing);
            if (this.ghost.userData.sig !== sig) {
                this.ghost.geometry.dispose();
                this.ghost.geometry = localBlockGeometry({ shape: this.placing.shape, size: this.placing.size, steps: 6, segments: 16, rotation: { x: 0, y: 0, z: 0 } });
                this.ghostEdges.geometry.dispose();
                this.ghostEdges.geometry = new THREE.EdgesGeometry(this.ghost.geometry, 20);
                this.ghost.userData.sig = sig;
            }
        } else if (this.ghost.userData.sig !== 'marker') {
            this.ghost.geometry.dispose();
            this.ghost.geometry = new THREE.SphereGeometry(0.4, 16, 12).translate(0, 0.4, 0);
            this.ghostEdges.geometry.dispose();
            this.ghostEdges.geometry = new THREE.BufferGeometry();
            this.ghost.userData.sig = 'marker';
        }
        this.ghost.position.set(pos.x, pos.y, pos.z);
        this.ghost.visible = true;
    }
    placeAtPointer() {
        const hit = this.surfaceHit();
        const pos = this.placementFor(hit);
        if (pos) this.cb.onPlace(pos, hit);
    }

    // ------------------------------------------------------------------ framing a camera shot
    // Look through a camera and fly it: right-drag to look, WASD to move, Q/E down/up, Shift for
    // speed, scroll to change speed. Enter saves (onSave gets the new pose), Esc cancels. The
    // editor's own shortcuts are suspended meanwhile (keys are taken in the capture phase).
    startFraming(pose, { onSave, onCancel, label } = {}) {
        this.stopFlyover();
        if (this.framing) this.endFraming(false);
        const start = pose || this.viewPose();
        this.framing = {
            yaw: start.yaw || 0, pitch: start.pitch || 0,
            keys: new Set(), speed: 15, dragging: false,
            onSave, onCancel, label,
            restore: { position: this.camera.position.clone(), target: this.orbit.target.clone() },
        };
        this.camera.position.set(start.position.x, start.position.y, start.position.z);
        this.orbit.enabled = false;
        this.gizmo.detach();
        this.selectionBox.visible = false;
        this.ghost.visible = false;
        this.renderer.domElement.focus?.();
        this.cb.onFramingChange?.(this.framing);
    }
    endFraming(save) {
        const f = this.framing;
        if (!f) return;
        const pose = this.viewPose();
        this.framing = null;
        // Keep looking where the shot looks; orbit around a point a little ahead.
        const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion);
        this.orbit.target.copy(this.camera.position).addScaledVector(fwd, 15);
        this.orbit.enabled = true;
        this.attachGizmo();
        this.cb.onFramingChange?.(null);
        if (save) f.onSave?.(pose); else f.onCancel?.();
    }
    stepFraming(dt) {
        const f = this.framing;
        this.camera.rotation.set(deg(f.pitch), deg(f.yaw), 0, 'YXZ');
        const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion);
        const right = new THREE.Vector3(1, 0, 0).applyQuaternion(this.camera.quaternion);
        const move = new THREE.Vector3();
        if (f.keys.has('w')) move.add(fwd);
        if (f.keys.has('s')) move.sub(fwd);
        if (f.keys.has('d')) move.add(right);
        if (f.keys.has('a')) move.sub(right);
        if (f.keys.has('e')) move.y += 1;
        if (f.keys.has('q')) move.y -= 1;
        if (move.lengthSq() > 0) {
            const speed = f.speed * (f.keys.has('shift') ? 3 : 1);
            this.camera.position.addScaledVector(move.normalize(), speed * dt);
        }
    }
    bindFramingInput() {
        const el = this.renderer.domElement;
        window.addEventListener('keydown', (e) => {
            const f = this.framing;
            if (!f || /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement?.tagName)) return;
            const k = e.key.toLowerCase();
            e.stopImmediatePropagation();
            if (k === 'enter') { e.preventDefault(); this.endFraming(true); return; }
            if (k === 'escape') { e.preventDefault(); this.endFraming(false); return; }
            const arrow = { arrowup: 'w', arrowdown: 's', arrowleft: 'a', arrowright: 'd', pageup: 'e', pagedown: 'q' }[k];
            if (arrow) { e.preventDefault(); f.keys.add(arrow); }
            if ('wasdqe'.includes(k) && k.length === 1) { e.preventDefault(); f.keys.add(k); }
            if (k === 'shift') f.keys.add('shift');
        }, true);
        window.addEventListener('keyup', (e) => {
            if (!this.framing) return;
            const k = e.key.toLowerCase();
            const arrow = { arrowup: 'w', arrowdown: 's', arrowleft: 'a', arrowright: 'd', pageup: 'e', pagedown: 'q' }[k];
            this.framing.keys.delete(arrow || k);
        }, true);
        window.addEventListener('blur', () => { if (this.framing) this.framing.keys.clear(); });
        el.addEventListener('pointerdown', (e) => {
            if (!this.framing || (e.button !== 2 && e.button !== 0)) return;
            this.framing.dragging = true;
            el.setPointerCapture(e.pointerId);
        });
        el.addEventListener('pointermove', (e) => {
            const f = this.framing;
            if (!f || !f.dragging) return;
            f.yaw = (f.yaw - e.movementX * 0.15 + 360) % 360;
            f.pitch = Math.max(-89, Math.min(89, f.pitch - e.movementY * 0.15));
        });
        el.addEventListener('pointerup', (e) => {
            if (!this.framing) return;
            this.framing.dragging = false;
            try { el.releasePointerCapture(e.pointerId); } catch { /* not captured */ }
        });
        el.addEventListener('wheel', (e) => {
            if (!this.framing) return;
            e.preventDefault();
            this.framing.speed = Math.max(2, Math.min(120, this.framing.speed * (e.deltaY > 0 ? 0.85 : 1.18)));
            this.cb.onFramingChange?.(this.framing);
        }, { passive: false });
    }

    // ------------------------------------------------------------------ still images
    // Render the map (without editor-only helpers) to a canvas of the given size, from `pose`
    // ({ position, yaw, pitch }, the camera-path convention) or, when omitted, the current view.
    // `supersample` renders larger and scales down, which keeps small images crisp.
    renderStill(width, height, pose = null, supersample = 1) {
        const w = Math.round(width * supersample), h = Math.round(height * supersample);
        const cam = new THREE.PerspectiveCamera(this.camera.fov, w / h, 0.1, this.camera.far);
        if (pose) {
            cam.position.set(pose.position.x, pose.position.y, pose.position.z);
            cam.rotation.set(deg(pose.pitch || 0), deg(pose.yaw || 0), 0, 'YXZ');
        } else {
            cam.position.copy(this.camera.position);
            cam.quaternion.copy(this.camera.quaternion);
        }
        cam.updateMatrixWorld();

        const invisibleWalls = this.contentRoot.children.filter((m) => m.userData.invisible);
        const helpers = [this.gridHelper, this.killPlane, this.gizmo, this.selectionBox, ...this.extraBoxes, this.ghost, this.objectRoot, ...invisibleWalls];
        const workLight = this.ambient.intensity;
        this.ambient.intensity = 0;
        const wasVisible = helpers.map((o) => o.visible);
        helpers.forEach((o) => { o.visible = false; });
        const skyPos = this.sky.position.clone();
        this.sky.position.copy(cam.position);
        const target = new THREE.WebGLRenderTarget(w, h, { samples: 4, colorSpace: THREE.SRGBColorSpace });
        const pixels = new Uint8Array(w * h * 4);
        try {
            this.renderer.setRenderTarget(target);
            this.renderer.render(this.scene, cam);
            this.renderer.readRenderTargetPixels(target, 0, 0, w, h, pixels);
        } finally {
            this.renderer.setRenderTarget(null);
            target.dispose();
            helpers.forEach((o, i) => { o.visible = wasVisible[i]; });
            this.ambient.intensity = workLight;
            this.sky.position.copy(skyPos);
        }

        // WebGL rows run bottom-up; canvas rows top-down.
        const full = document.createElement('canvas');
        full.width = w; full.height = h;
        const fctx = full.getContext('2d');
        const img = fctx.createImageData(w, h);
        const row = w * 4;
        for (let y = 0; y < h; y++) img.data.set(pixels.subarray((h - 1 - y) * row, (h - y) * row), y * row);
        fctx.putImageData(img, 0, 0);
        if (supersample === 1) return full;
        const out = document.createElement('canvas');
        out.width = width; out.height = height;
        const octx = out.getContext('2d');
        octx.imageSmoothingEnabled = true;
        octx.imageSmoothingQuality = 'high';
        octx.drawImage(full, 0, 0, width, height);
        return out;
    }

    // ------------------------------------------------------------------ camera helpers
    viewPose() {
        const e = new THREE.Euler().setFromQuaternion(this.camera.quaternion, 'YXZ');
        return { position: { x: round(this.camera.position.x), y: round(this.camera.position.y), z: round(this.camera.position.z) }, yaw: round(((rad(e.y) % 360) + 360) % 360), pitch: round(rad(e.x)) };
    }
    frameSelection() {
        const obj = this.selectedObject3D();
        if (!obj) return;
        const box = new THREE.Box3().setFromObject(obj);
        const c = box.getCenter(new THREE.Vector3());
        const r = Math.max(3, box.getSize(new THREE.Vector3()).length());
        const dir = this.camera.position.clone().sub(this.orbit.target).normalize();
        this.orbit.target.copy(c);
        this.camera.position.copy(c).addScaledVector(dir, r * 1.4);
    }
    // Play one camera path, or several in a row (the menu loop: each path once, in order).
    playFlyover(paths) {
        const list = (Array.isArray(paths) ? paths : [paths]).filter(Boolean);
        if (!list.length) return;
        this.flyover = { paths: list, index: 0, path: list[0], t: 0, last: performance.now() };
        this.orbit.enabled = false;
        this.cb.onFlyover?.(0, list.length);
    }
    stopFlyover() {
        if (!this.flyover) return;
        this.flyover = null;
        this.orbit.enabled = true;
    }
    stepFlyover() {
        const f = this.flyover, now = performance.now();
        f.t += (now - f.last) / 1000; f.last = now;
        const k = Math.min(1, f.t / Math.max(1, f.path.seconds || 20));
        const a = f.path.start, b = f.path.end;
        this.camera.position.set(lerp(a.position.x, b.position.x, k), lerp(a.position.y, b.position.y, k), lerp(a.position.z, b.position.z, k));
        const qa = new THREE.Quaternion().setFromEuler(new THREE.Euler(deg(a.pitch), deg(a.yaw), 0, 'YXZ'));
        const qb = new THREE.Quaternion().setFromEuler(new THREE.Euler(deg(b.pitch), deg(b.yaw), 0, 'YXZ'));
        this.camera.quaternion.copy(qa.slerp(qb, k));
        if (k >= 1) {
            if (f.index + 1 < f.paths.length) {
                f.index += 1; f.path = f.paths[f.index]; f.t = 0;
                this.cb.onFlyover?.(f.index, f.paths.length);
            } else { this.stopFlyover(); this.cb.onFlyoverEnd?.(); }
        }
    }
}

// ------------------------------------------------------------------ helpers
const round = (v) => Math.round(v * 1000) / 1000;
const visibleChain = (o) => { for (let x = o; x; x = x.parent) if (!x.visible) return false; return true; };
const lerp = (a, b, k) => a + (b - a) * k;

function localBlockGeometry(block) {
    const local = { ...block, position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 } };
    const { positions, normals } = buildBlockTriangles(local);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
    g.computeBoundingSphere();
    return g;
}

function makeSkyDome() {
    const mat = new THREE.ShaderMaterial({
        uniforms: { top: { value: new THREE.Color('#4db4ff') }, horizon: { value: new THREE.Color('#bfd1ff') }, bottom: { value: new THREE.Color('#bce1ff') } },
        vertexShader: 'varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
        fragmentShader: 'uniform vec3 top; uniform vec3 horizon; uniform vec3 bottom; varying vec3 vDir; void main(){ float t = normalize(vDir).y; vec3 c = t < 0.0 ? mix(horizon, bottom, -t) : mix(horizon, top, t); gl_FragColor = vec4(c, 1.0); }',
        side: THREE.BackSide,
        depthWrite: false,
        fog: false,
    });
    const m = new THREE.Mesh(new THREE.SphereGeometry(900, 32, 16), mat);
    m.renderOrder = -1;
    m.frustumCulled = false;
    return m;
}

function arrow(color, length = 1.6) {
    const g = new THREE.Group();
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, length, 8), new THREE.MeshBasicMaterial({ color }));
    shaft.rotation.x = Math.PI / 2; shaft.position.z = -length / 2;
    const head = new THREE.Mesh(new THREE.ConeGeometry(0.2, 0.45, 12), new THREE.MeshBasicMaterial({ color }));
    head.rotation.x = -Math.PI / 2; head.position.z = -length;
    g.add(shaft, head);
    return g;   // points along -z: the direction a player faces at yaw 0
}

function markerSpawn(s) {
    const color = s.team === 'team1' ? COLORS.team1 : s.team === 'team2' ? COLORS.team2 : COLORS.spawn;
    const g = new THREE.Group();
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.4, 1.0, 4, 12), new THREE.MeshLambertMaterial({ color, emissive: color, emissiveIntensity: 0.35 }));
    body.position.y = 0.9;
    const dir = arrow(color);
    dir.position.y = 0.9;
    dir.rotation.y = deg(s.yaw || 0);
    g.add(body, dir);
    g.position.set(s.position.x, s.position.y, s.position.z);
    return g;
}

function markerSphere(p, color, r) {
    const g = new THREE.Group();
    const m = new THREE.Mesh(new THREE.SphereGeometry(r, 16, 12), new THREE.MeshLambertMaterial({ color, emissive: color, emissiveIntensity: 0.4 }));
    m.position.y = r;
    g.add(m);
    g.position.set(p.x, p.y, p.z);
    return g;
}

function markerTeleporter(t) {
    const g = new THREE.Group();
    const ring = new THREE.Mesh(new THREE.TorusGeometry(t.radius || 1.5, 0.08, 8, 40), new THREE.MeshBasicMaterial({ color: COLORS.teleport }));
    ring.rotation.x = Math.PI / 2;
    ring.position.y = 0.05;
    const pad = new THREE.Mesh(new THREE.CylinderGeometry(t.radius || 1.5, t.radius || 1.5, 0.08, 32), new THREE.MeshBasicMaterial({ color: COLORS.teleport, transparent: true, opacity: 0.25 }));
    const dir = arrow(COLORS.teleport, 1.4);
    dir.position.y = 0.6;
    dir.rotation.y = deg(t.yaw || 0);
    g.add(ring, pad, dir);
    g.position.set(t.position.x, t.position.y, t.position.z);
    return g;
}

function markerCameraPath(c) {
    const g = new THREE.Group();
    const mk = (pose, color) => {
        const cam = new THREE.Group();
        const box = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.6, 1.0), new THREE.MeshBasicMaterial({ color }));
        const lens = new THREE.Mesh(new THREE.ConeGeometry(0.45, 0.8, 4, 1, true), new THREE.MeshBasicMaterial({ color, wireframe: true }));
        lens.rotation.x = Math.PI / 2; lens.position.z = -0.8;
        cam.add(box, lens);
        cam.position.set(pose.position.x, pose.position.y, pose.position.z);
        cam.rotation.set(deg(pose.pitch), deg(pose.yaw), 0, 'YXZ');
        return cam;
    };
    const startCam = mk(c.start, COLORS.camera), endCam = mk(c.end, 0x2a7f99);
    startCam.userData.part = 'start';
    endCam.userData.part = 'end';
    g.add(startCam, endCam);
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(c.start.position.x, c.start.position.y, c.start.position.z), new THREE.Vector3(c.end.position.x, c.end.position.y, c.end.position.z)]), new THREE.LineBasicMaterial({ color: COLORS.camera }));
    g.add(line);
    return g;
}

function markerCircle(c) {
    const g = new THREE.Group();
    const pts = [];
    for (let i = 0; i <= 96; i++) { const a = (i / 96) * Math.PI * 2; pts.push(new THREE.Vector3(Math.cos(a) * c.radius, 0, Math.sin(a) * c.radius)); }
    g.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: COLORS.br })));
    g.add(new THREE.Mesh(new THREE.SphereGeometry(0.6, 12, 8), new THREE.MeshBasicMaterial({ color: COLORS.br })));
    g.position.set(c.position.x, c.position.y, c.position.z);
    return g;
}

export { hexToRgb, cameraForward };
