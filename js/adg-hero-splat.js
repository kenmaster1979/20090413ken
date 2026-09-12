const SPLAT_URL = './assets/demo-hero.spz';
const AUTO_ROTATE_RESUME_MS = 500;
/** 交互/阻尼结束后继续绘制的帧数，避免松手瞬间卡住 */
const IDLE_SETTLE_FRAMES = 45;
/** 用户标定的初始机位（相对居中后的模型原点） */
const INITIAL_CAM_POS = Object.freeze({ x: -10.2138, y: 1.8895, z: 2.2354 });
const INITIAL_TARGET = Object.freeze({ x: 0, y: 0, z: 0 });
const INITIAL_DISTANCE = 10.6249;
const ZOOM_MIN_FACTOR = 0.45;
const ZOOM_MAX_FACTOR = 2.8;
/** 有效可见：比例与可见像素都达标才算在屏（否则 IDLE 停转） */
const MIN_VISIBLE_RATIO = 0.25;
const MIN_VISIBLE_PX = 160;

let THREE = null;
let OrbitControls = null;
let SplatMesh = null;
let threeModulesPromise = null;

function loadThreeModules() {
  if (!threeModulesPromise) {
    threeModulesPromise = Promise.all([
      import('three'),
      import('three/addons/controls/OrbitControls.js'),
      import('@sparkjsdev/spark')
    ]).then(([threeMod, orbitMod, sparkMod]) => {
      THREE = threeMod;
      OrbitControls = orbitMod.OrbitControls;
      SplatMesh = sparkMod.SplatMesh;
    });
  }
  return threeModulesPromise;
}

function whenIdle(cb) {
  if (typeof window.requestIdleCallback === 'function') {
    window.requestIdleCallback(cb, { timeout: 2000 });
  } else {
    setTimeout(cb, 200);
  }
}

function prefersReducedMotion() {
  return document.body.dataset.reducedMotion === 'true'
    || window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function initHeroSplat() {
  const viewport = document.getElementById('hero-splat-viewport');
  if (!viewport) return;

  const loadingEl = viewport.querySelector('.v2-hero-splat-loading');
  const fallbackEl = viewport.querySelector('.v2-hero-splat-fallback');

  let scene;
  let camera;
  let renderer;
  let controls;
  let splat;
  let animationId = null;
  let framesLeft = 0;
  let isInteracting = false;
  let insideRender = false;
  let isVisible = false;
  let isInitialized = false;
  let initStarted = false;
  let hasActivatedOnce = false;
  let autoRotateResumeTimer = null;
  let allowAutoRotate = !prefersReducedMotion();
  /** 介绍影片等遮罩打开时强制 IDLE，关闭前不允许恢复 */
  let overlayForceIdle = false;

  function showFallback() {
    viewport.classList.add('is-fallback');
    if (loadingEl) loadingEl.hidden = true;
    if (fallbackEl) {
      fallbackEl.hidden = false;
      fallbackEl.setAttribute('aria-hidden', 'false');
    }
  }

  function canRunLoop() {
    return isVisible
      && !!renderer
      && document.visibilityState !== 'hidden'
      && !overlayForceIdle;
  }

  function setOverlayForceIdle(force) {
    if (overlayForceIdle === force) return;
    overlayForceIdle = force;
    if (force) {
      enterIdle();
      return;
    }
    if (isVisible && isInitialized && document.visibilityState !== 'hidden') {
      leaveIdle();
    }
  }

  function isEntryActivelyVisible(entry) {
    if (!entry || !entry.isIntersecting) return false;
    const rect = entry.boundingClientRect;
    const visiblePx = Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0);
    return entry.intersectionRatio >= MIN_VISIBLE_RATIO && visiblePx >= MIN_VISIBLE_PX;
  }

  function shouldKeepRendering() {
    return isInteracting
      || !!(controls && controls.autoRotate)
      || framesLeft > 0;
  }

  function poke(count = IDLE_SETTLE_FRAMES) {
    if (!canRunLoop()) return;
    framesLeft = Math.max(framesLeft, Math.max(1, count | 0));
    startRender();
  }

  function renderFrame() {
    // 帧执行期间保留 animationId，避免 update→change→poke 嵌套再排一帧
    if (!canRunLoop()) {
      animationId = null;
      return;
    }

    insideRender = true;
    controls.update();
    insideRender = false;
    renderer.render(scene, camera);

    if (framesLeft > 0) framesLeft -= 1;

    if (shouldKeepRendering()) {
      animationId = requestAnimationFrame(renderFrame);
    } else {
      animationId = null;
    }
  }

  function startRender() {
    if (animationId != null || !canRunLoop()) return;
    animationId = requestAnimationFrame(renderFrame);
  }

  function stopRender() {
    if (animationId == null) return;
    cancelAnimationFrame(animationId);
    animationId = null;
  }

  function clearAutoRotateResumeTimer() {
    if (!autoRotateResumeTimer) return;
    clearTimeout(autoRotateResumeTimer);
    autoRotateResumeTimer = null;
  }

  /** 离开面板 / 标签页隐藏：彻底 IDLE */
  function enterIdle() {
    stopRender();
    framesLeft = 0;
    isInteracting = false;
    clearAutoRotateResumeTimer();
    if (controls) controls.autoRotate = false;

    // 挂起 GPU：隐藏 canvas 让合成器释放该层
    if (renderer) {
      const c = renderer.domElement;
      c.style.visibility = 'hidden';
      c.style.pointerEvents = 'none';
    }
    // 禁用 controls 防止 wheel 事件阻止 passive scroll
    if (controls) controls.enabled = false;
    // 暂停 CSS 粒子动画（animation: none 移除 GPU 合成层）
    document.body.dataset.heroOffscreen = 'true';
  }

  /** 回到视野：先停在当前机位；首次立即转，再次看到则 0.5 秒后再转 */
  function leaveIdle() {
    if (!isInitialized || !canRunLoop()) return;

    // 恢复 canvas 可见 + 指针
    if (renderer) {
      const c = renderer.domElement;
      c.style.visibility = '';
      c.style.pointerEvents = '';
    }
    // 恢复 controls
    if (controls) controls.enabled = true;
    // 恢复粒子动画
    document.body.dataset.heroOffscreen = 'false';

    if (controls) controls.autoRotate = false;
    clearAutoRotateResumeTimer();
    poke(2);
    if (!allowAutoRotate || !controls) return;
    if (!hasActivatedOnce) {
      hasActivatedOnce = true;
      controls.autoRotate = true;
      startRender();
      return;
    }
    scheduleAutoRotateResume();
  }

  function scheduleAutoRotateResume() {
    if (!allowAutoRotate || !controls || !isVisible) return;
    clearAutoRotateResumeTimer();
    autoRotateResumeTimer = setTimeout(() => {
      autoRotateResumeTimer = null;
      if (!isVisible || !controls || !allowAutoRotate || !canRunLoop()) return;
      controls.autoRotate = true;
      startRender();
    }, AUTO_ROTATE_RESUME_MS);
  }

  function applyMotionPreference() {
    allowAutoRotate = !prefersReducedMotion();
    if (!controls) return;
    if (!allowAutoRotate) {
      controls.autoRotate = false;
      clearAutoRotateResumeTimer();
      if (canRunLoop()) poke(1);
      return;
    }
    if (!autoRotateResumeTimer && isVisible) {
      controls.autoRotate = true;
      startRender();
    }
  }

  function resize() {
    if (!renderer || !camera) return;
    const { width, height } = viewport.getBoundingClientRect();
    if (width <= 0 || height <= 0) return;
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    renderer.setSize(Math.floor(width), Math.floor(height), false);
    if (canRunLoop()) poke(2);
  }

  function frameModel() {
    const box = splat.getBoundingBox(false);
    const center = box.getCenter(new THREE.Vector3());
    splat.position.sub(center);

    camera.position.set(INITIAL_CAM_POS.x, INITIAL_CAM_POS.y, INITIAL_CAM_POS.z);
    controls.target.set(INITIAL_TARGET.x, INITIAL_TARGET.y, INITIAL_TARGET.z);
    controls.minDistance = INITIAL_DISTANCE * ZOOM_MIN_FACTOR;
    controls.maxDistance = INITIAL_DISTANCE * ZOOM_MAX_FACTOR;
    controls.update();
  }

  async function setup() {
    if (initStarted) return;
    initStarted = true;

    try {
      await loadThreeModules();

      scene = new THREE.Scene();

      camera = new THREE.PerspectiveCamera(50, 1, 0.01, 1000);

      renderer = new THREE.WebGLRenderer({
        alpha: true,
        antialias: false,
        powerPreference: 'high-performance'
      });
      renderer.setClearColor(0x000000, 0);
      const isAppleMobile = /iPhone|iPad|iPod/i.test(navigator.userAgent)
        || (/Macintosh/i.test(navigator.userAgent) && (navigator.maxTouchPoints || 0) > 1);
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, isAppleMobile ? 1 : 1.5));

      const canvas = renderer.domElement;
      canvas.className = 'v2-hero-splat-canvas';
      viewport.appendChild(canvas);

      controls = new OrbitControls(camera, canvas);
      controls.enablePan = false;
      controls.enableRotate = true;
      controls.enableZoom = true;
      controls.enableDamping = true;
      controls.dampingFactor = 0.08;
      controls.autoRotate = allowAutoRotate;
      controls.autoRotateSpeed = 1.0;

      controls.addEventListener('start', () => {
        isInteracting = true;
        controls.autoRotate = false;
        clearAutoRotateResumeTimer();
        poke();
      });
      controls.addEventListener('change', () => {
        if (!isInteracting && !insideRender) poke();
      });
      controls.addEventListener('end', () => {
        isInteracting = false;
        poke();
        scheduleAutoRotateResume();
      });

      splat = new SplatMesh({ url: SPLAT_URL });
      splat.frustumCulled = false;
      splat.rotation.x = -Math.PI;
      scene.add(splat);

      await splat.initialized;
      frameModel();
      resize();

      isInitialized = true;
      viewport.classList.add('is-ready');
      if (loadingEl) loadingEl.hidden = true;

      if (isVisible) leaveIdle();
      else enterIdle();
    } catch (err) {
      console.error('[adg-hero-splat]', err);
      showFallback();
    }
  }

  const visibilityObserver = new IntersectionObserver((entries) => {
    const entry = entries[0];
    const wasVisible = isVisible;
    const nextVisible = isEntryActivelyVisible(entry);
    isVisible = nextVisible;

    if (nextVisible === wasVisible) return;

    if (nextVisible) {
      if (!initStarted) whenIdle(setup);
      else if (isInitialized) leaveIdle();
      return;
    }

    enterIdle();
  }, { rootMargin: '0px', threshold: [0, 0.05, 0.1, 0.2, 0.25, 0.5, 1] });

  visibilityObserver.observe(viewport);

  const motionObserver = new MutationObserver(applyMotionPreference);
  motionObserver.observe(document.body, { attributes: true, attributeFilter: ['data-reduced-motion'] });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      enterIdle();
      return;
    }
    if (isVisible && isInitialized) leaveIdle();
  });

  window.addEventListener('adg-hero-splat:idle', () => setOverlayForceIdle(true));
  window.addEventListener('adg-hero-splat:resume', () => setOverlayForceIdle(false));

  window.addEventListener('resize', resize);

  if (typeof ResizeObserver !== 'undefined') {
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(viewport);
  }

  const particleZone = document.querySelector('.v2-particle-zone');
  if (particleZone && 'IntersectionObserver' in window) {
    const particleObserver = new IntersectionObserver((entries) => {
      const offscreen = !entries[0].isIntersecting;
      document.body.dataset.heroOffscreen = offscreen ? 'true' : 'false';
    }, { threshold: 0 });
    particleObserver.observe(particleZone);
  }

  function dispose() {
    enterIdle();
    if (controls) {
      controls.dispose();
      controls = null;
    }
    if (splat) {
      if (typeof splat.dispose === 'function') splat.dispose();
      if (scene) scene.remove(splat);
      splat = null;
    }
    if (renderer) {
      renderer.dispose();
      if (renderer.forceContextLoss) renderer.forceContextLoss();
      renderer = null;
    }
    scene = null;
    camera = null;
  }

  window.addEventListener('pagehide', dispose, { once: true });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initHeroSplat);
} else {
  initHeroSplat();
}
