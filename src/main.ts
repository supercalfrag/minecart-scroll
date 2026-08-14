import OBR, { isImage, type Image, type Metadata } from "@owlbear-rodeo/sdk";
const SETTINGS_KEY = "com.supercalfrag.minecart-scroll/settings";
const TRACK_OVERLAP = 2;
const FLOOR_Z_GAP = 100000;
const TRACK_Z_GAP = 100000;
const FOREGROUND_Z_GAP = 200000;
const LAYER_RENEW_REPEAT_MS = 24000;
const MINECART_RENEW_FIRST_MS = 28000;
const MINECART_RENEW_REPEAT_MS = 24000;
const LAYER_RENEW_FIRST_DELAY_MS: Record<string, number> = {
  Floor: 16000,
  Background: 19000,
  Track: 22000,
  Foreground: 25000,
};
const MINECART_DROP_SETTLE_MS = 250;
const MINECART_RATTLE_TICK_MS = 33; // ~30 updates/sec for smooth visible motion while staying below every-frame writes.

const RUNTIME_KEY = "com.supercalfrag.minecart-scroll/runtime-v41";
const RENDERER_DIAG_KEY = "com.supercalfrag.minecart-scroll/renderer-diag-v41";
const BACKGROUND_HEALTH_KEY = "com.supercalfrag.minecart-scroll/background-health-v41";
const LOCAL_TICK_MS = 20; // 50fps target for the background shared-item interaction renderer.
const MAX_INTERNAL_SPEED = 1500; // 50 ft/s on a 5 ft / 150 DPI scene.
const MAX_INTERNAL_ACCELERATION = 1000;
const SUBTLE_GM_INTERACTION_COLOR = "#64748B"; // muted slate
const SUBTLE_CAST_INTERACTION_COLOR = "#6B7280"; // muted charcoal
const CRASH_STATE_KEY = "com.supercalfrag.minecart-scroll/crash-state-v2";
const CRASH_CHANNEL = "com.supercalfrag.minecart-scroll/crash-control-v1";
const CRASH_POPOVER_ID = "com.supercalfrag.minecart-scroll/crash-warning";
const CRASH_IMPACT_MS = 900;

type RuntimeLayerName = "Floor" | "Background" | "Track" | "Foreground";
type RuntimeLayerSpec = {
  name: RuntimeLayerName;
  ids: string[];
  startX: number;
  y: number;
  spacing: number;
  baseZ: number;
  multiplier: number;
  distanceOffset: number;
};

type MotionSegment = {
  segmentStartMs: number;
  distanceAtSegmentStart: number;
  speedAtSegmentStart: number;
  targetSpeed: number;
  acceleration: number;
};

type RuntimeState = {
  version: 31;
  revision: number;
  runState: RunState;
  layers: RuntimeLayerSpec[];
  motion: MotionSegment;
};
type RendererDiagnosticStage = "boot" | "runtime" | "items" | "moving" | "error";

type RendererDiagnostic = {
  version: 1;
  revision: number;
  stage: RendererDiagnosticStage;
  itemCount: number;
  atMs: number;
  message: string;
};

type BackgroundHealth = {
  version: 1;
  atMs: number;
  sceneReady: boolean;
  message: string;
};

function motionAt(segment: MotionSegment, nowMs = Date.now()): { distance: number; speed: number } {
  const elapsed = Math.max(0, (nowMs - segment.segmentStartMs) / 1000);
  const startSpeed = Math.max(0, segment.speedAtSegmentStart);
  const target = Math.max(0, segment.targetSpeed);
  const accel = Math.max(0.0001, segment.acceleration);
  const difference = target - startSpeed;
  if (Math.abs(difference) < 0.0001) {
    return {
      distance: segment.distanceAtSegmentStart + target * elapsed,
      speed: target,
    };
  }

  const direction = Math.sign(difference);
  const timeToTarget = Math.abs(difference) / accel;
  if (elapsed <= timeToTarget) {
    const speed = Math.max(0, startSpeed + direction * accel * elapsed);
    const travelled = startSpeed * elapsed + 0.5 * direction * accel * elapsed * elapsed;
    return {
      distance: segment.distanceAtSegmentStart + travelled,
      speed,
    };
  }

  const accelDistance = ((startSpeed + target) / 2) * timeToTarget;
  return {
    distance: segment.distanceAtSegmentStart + accelDistance + target * (elapsed - timeToTarget),
    speed: target,
  };
}
function positionForDistance(
  startX: number,
  spacing: number,
  count: number,
  index: number,
  distance: number,
): number {
  if (count <= 0 || spacing <= 0) return startX;
  const total = spacing * count;
  const maxOffset = spacing * (count - 1);
  const raw = index * spacing - distance;
  // Match the original loop exactly: a tile stays left of startX until it
  // reaches startX-spacing, then it wraps to the far right.
  const cycles = Math.ceil((raw - maxOffset) / total);
  const wrapped = raw - cycles * total;
  return startX + wrapped;
}
function parseRuntime(raw: unknown): RuntimeState | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Partial<RuntimeState>;
  if (value.version !== 31 || typeof value.revision !== "number") return null;
  if (value.runState !== "running" && value.runState !== "paused" && value.runState !== "stopped") return null;
  if (!Array.isArray(value.layers) || !value.motion || typeof value.motion !== "object") return null;
  const layers: RuntimeLayerSpec[] = [];
  for (const rawLayer of value.layers) {
    if (!rawLayer || typeof rawLayer !== "object") continue;
    const layer = rawLayer as Partial<RuntimeLayerSpec>;
    if (
      (layer.name !== "Floor" && layer.name !== "Background" && layer.name !== "Track" && layer.name !== "Foreground") ||
      !Array.isArray(layer.ids) ||
      layer.ids.length < 2
    ) {
      continue;
    }
    layers.push({
      name: layer.name,
      ids: layer.ids.filter((id): id is string => typeof id === "string"),
      startX: Number(layer.startX) || 0,
      y: Number(layer.y) || 0,
      spacing: Math.max(1, Number(layer.spacing) || 1),
      baseZ: Number(layer.baseZ) || 0,
      multiplier: Math.max(0, Number(layer.multiplier) || 0),
      distanceOffset: Number.isFinite(Number(layer.distanceOffset)) ? Number(layer.distanceOffset) : 0,
    });
  }
  const motion = value.motion as Partial<MotionSegment>;
  return {
    version: 31,
    revision: value.revision,
    runState: value.runState,
    layers,
    motion: {
      segmentStartMs: Number.isFinite(motion.segmentStartMs) ? Number(motion.segmentStartMs) : Date.now(),
      distanceAtSegmentStart: Number.isFinite(motion.distanceAtSegmentStart) ? Number(motion.distanceAtSegmentStart) : 0,
      speedAtSegmentStart: Math.max(0, Number(motion.speedAtSegmentStart) || 0),
      targetSpeed: Math.max(0, Number(motion.targetSpeed) || 0),
      acceleration: Math.max(0.0001, Number(motion.acceleration) || 200),
    },
  };
}
async function readRuntimeState(): Promise<RuntimeState | null> {
  if (!(await OBR.scene.isReady())) return null;
  const metadata = await OBR.scene.getMetadata();
  return parseRuntime(metadata[RUNTIME_KEY]);
}

async function writeRuntimeState(runtime: RuntimeState): Promise<void> {
  await OBR.scene.setMetadata({ [RUNTIME_KEY]: runtime });
}
function parseRendererDiagnostic(raw: unknown): RendererDiagnostic | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Partial<RendererDiagnostic>;
  if (value.version !== 1 || typeof value.revision !== "number" || typeof value.stage !== "string") return null;
  if (value.stage !== "boot" && value.stage !== "runtime" && value.stage !== "items" && value.stage !== "moving" && value.stage !== "error") return null;
  return {
    version: 1,
    revision: value.revision,
    stage: value.stage,
    itemCount: Math.max(0, Number(value.itemCount) || 0),
    atMs: Number(value.atMs) || 0,
    message: typeof value.message === "string" ? value.message : "",
  };
}
async function readRendererDiagnostic(): Promise<RendererDiagnostic | null> {
  const metadata = await OBR.player.getMetadata();
  return parseRendererDiagnostic(metadata[RENDERER_DIAG_KEY]);
}
function parseBackgroundHealth(raw: unknown): BackgroundHealth | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Partial<BackgroundHealth>;
  if (value.version !== 1 || typeof value.atMs !== "number") return null;
  return {
    version: 1,
    atMs: value.atMs,
    sceneReady: value.sceneReady === true,
    message: typeof value.message === "string" ? value.message : "",
  };
}
async function readBackgroundHealth(): Promise<BackgroundHealth | null> {
  const metadata = await OBR.player.getMetadata();
  return parseBackgroundHealth(metadata[BACKGROUND_HEALTH_KEY]);
}


type CrashHome = {
  id: string;
  x: number;
  y: number;
  rotation: number;
  visible: boolean;
};

type CrashRuntimeState = {
  version: 2;
  chaseRevision: number;
  brokenCartId: string;
  minecartIds: string[];
  track1Y: number;
  track2Y: number;
  status: "armed" | "running" | "complete";
  brokenHome: CrashHome;
  cartHomes: CrashHome[];
  crashedHomes: CrashHome[];
  crashedTrack: 1 | 2 | null;
};

function parseCrashRuntime(raw: unknown): CrashRuntimeState | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Partial<CrashRuntimeState>;
  if (
    value.version !== 2 ||
    typeof value.chaseRevision !== "number" ||
    typeof value.brokenCartId !== "string" ||
    !Array.isArray(value.minecartIds) ||
    !Number.isFinite(value.track1Y) ||
    !Number.isFinite(value.track2Y) ||
    (value.status !== "armed" && value.status !== "running" && value.status !== "complete") ||
    !value.brokenHome ||
    typeof value.brokenHome !== "object" ||
    !Array.isArray(value.cartHomes)
  ) {
    return null;
  }

  const broken = value.brokenHome as Partial<CrashHome>;
  if (
    typeof broken.id !== "string" ||
    !Number.isFinite(broken.x) ||
    !Number.isFinite(broken.y) ||
    !Number.isFinite(broken.rotation) ||
    typeof broken.visible !== "boolean"
  ) {
    return null;
  }

  const parseHomes = (rawHomes: unknown): CrashHome[] => {
    if (!Array.isArray(rawHomes)) return [];
    const homes: CrashHome[] = [];
    for (const rawHome of rawHomes) {
      if (!rawHome || typeof rawHome !== "object") continue;
      const home = rawHome as Partial<CrashHome>;
      if (
        typeof home.id !== "string" ||
        !Number.isFinite(home.x) ||
        !Number.isFinite(home.y) ||
        !Number.isFinite(home.rotation) ||
        typeof home.visible !== "boolean"
      ) {
        continue;
      }
      homes.push({
        id: home.id,
        x: Number(home.x),
        y: Number(home.y),
        rotation: Number(home.rotation),
        visible: home.visible,
      });
    }
    return homes;
  };

  const cartHomes = parseHomes(value.cartHomes);
  const crashedHomes = parseHomes((value as Partial<CrashRuntimeState>).crashedHomes);
  const crashedTrack =
    value.crashedTrack === 1 || value.crashedTrack === 2 ? value.crashedTrack : null;

  return {
    version: 2,
    chaseRevision: value.chaseRevision,
    brokenCartId: value.brokenCartId,
    minecartIds: value.minecartIds.filter((id): id is string => typeof id === "string"),
    track1Y: Number(value.track1Y),
    track2Y: Number(value.track2Y),
    status: value.status,
    brokenHome: {
      id: broken.id,
      x: Number(broken.x),
      y: Number(broken.y),
      rotation: Number(broken.rotation),
      visible: broken.visible,
    },
    cartHomes,
    crashedHomes,
    crashedTrack,
  };
}

async function readCrashRuntime(): Promise<CrashRuntimeState | null> {
  if (!(await OBR.scene.isReady())) return null;
  const metadata = await OBR.scene.getMetadata();
  return parseCrashRuntime(metadata[CRASH_STATE_KEY]);
}

async function writeCrashRuntime(state: CrashRuntimeState): Promise<void> {
  await OBR.scene.setMetadata({ [CRASH_STATE_KEY]: state });
}

function crashSeed(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 4294967295;
}

function crashEaseOut(value: number): number {
  const t = Math.max(0, Math.min(1, value));
  return 1 - Math.pow(1 - t, 3);
}

async function waitMs(ms: number): Promise<void> {
  await new Promise<void>((resolve) => window.setTimeout(resolve, ms));
}

function crashTrackForY(y: number, track1Y: number, track2Y: number): 1 | 2 {
  return Math.abs(y - track1Y) <= Math.abs(y - track2Y) ? 1 : 2;
}

type CrashExecutionResult = {
  crashedHomes: CrashHome[];
  targetTrack: 1 | 2;
};

async function executeBrokenCartCrash(state: CrashRuntimeState): Promise<CrashExecutionResult> {
  const shared = await OBR.scene.items.getItems([state.brokenCartId, ...state.minecartIds]);
  const byId = new Map(shared.filter(isImage).map((image) => [image.id, image] as const));
  const broken = byId.get(state.brokenCartId);
  const allCarts = state.minecartIds.map((id) => byId.get(id)).filter((image): image is Image => Boolean(image));
  if (!broken) throw new Error("The designated Broken Cart could not be found.");
  if (allCarts.length === 0) throw new Error("No player minecarts are available for the crash.");

  const targetTrack = crashTrackForY(state.brokenHome.y, state.track1Y, state.track2Y);
  const targetY = targetTrack === 1 ? state.track1Y : state.track2Y;
  // Classify carts from their CURRENT scene position when the warning is clicked.
  // This lets carts switch rails during play without needing to be reassigned.
  const carts = allCarts.filter(
    (cart) => crashTrackForY(cart.position.y, state.track1Y, state.track2Y) === targetTrack,
  );
  if (carts.length === 0) {
    throw new Error(`No player minecarts are currently on Track ${targetTrack}.`);
  }

  const crashedHomes: CrashHome[] = carts.map((cart) => ({
    id: cart.id,
    x: cart.position.x,
    y: targetY,
    rotation: cart.rotation,
    visible: cart.visible,
  }));

  const sortedCarts = [...carts].sort((a, b) => b.position.x - a.position.x);
  const frontCart = sortedCarts[0];
  const [frontBounds, brokenBounds, viewportWidth] = await Promise.all([
    OBR.scene.items.getItemBounds([frontCart.id]),
    OBR.scene.items.getItemBounds([broken.id]),
    OBR.viewport.getWidth(),
  ]);
  const frontScreen = await OBR.viewport.transformPoint({ x: frontCart.position.x, y: targetY });
  const spawnPoint = await OBR.viewport.inverseTransformPoint({
    x: viewportWidth + Math.max(100, brokenBounds.width * 0.75),
    y: frontScreen.y,
  });

  const impactX = frontCart.position.x + Math.max(24, (frontBounds.width + brokenBounds.width) * 0.38);
  const impactY = targetY;
  const baseBrokenRotation = broken.rotation;

  const chaseRuntime = await readRuntimeState();
  if (!chaseRuntime || chaseRuntime.runState !== "running") {
    throw new Error("Start the chase before launching the Broken Cart.");
  }
  const chaseAtLaunch = motionAt(chaseRuntime.motion, Date.now());
  if (chaseAtLaunch.speed <= 0.001 && chaseRuntime.motion.targetSpeed <= 0.001) {
    throw new Error("The chase speed must be above zero before launching the Broken Cart.");
  }
  const approachDistance = Math.max(1, spawnPoint.x - impactX);
  const chaseDistanceAtLaunch = chaseAtLaunch.distance;

  await OBR.scene.items.updateItems([broken.id], (items) => {
    for (const item of items) {
      item.visible = true;
      item.position.x = spawnPoint.x;
      item.position.y = impactY;
      item.rotation = baseBrokenRotation;
    }
  });

  const refreshed = await OBR.scene.items.getItems([broken.id, ...carts.map((cart) => cart.id)]);
  const interactionImages = refreshed.filter(isImage);
  const [update, stop] = await OBR.interaction.startItemInteraction(interactionImages);

  try {
    await new Promise<void>((resolve) => {
      const tick = () => {
        // Treat the Broken Cart as a wreck sitting farther down the tunnel.
        // The party catches it at exactly the same rate the Track layer scrolls:
        // every scene-unit of chase distance advances the wreck one scene-unit
        // toward the player carts on screen.
        const chaseNow = motionAt(chaseRuntime.motion, Date.now());
        const travelled = Math.max(0, chaseNow.distance - chaseDistanceAtLaunch);
        const raw = Math.min(1, travelled / approachDistance);
        const x = Math.max(impactX, spawnPoint.x - travelled);

        // Cosmetic damage wobble only; it does not change horizontal approach speed.
        const wobble = Math.sin(travelled * 0.045) * (2 + raw * 6);
        const bounce = Math.sin(travelled * 0.032) * (2 + raw * 4);

        update((draft) => {
          const items = Array.isArray(draft) ? draft : [draft];
          for (const item of items) {
            if (item.id !== broken.id) continue;
            item.position.x = x;
            item.position.y = impactY + bounce;
            item.rotation = baseBrokenRotation + wobble;
          }
        });

        if (raw >= 1) resolve();
        else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });

    const starts = new Map(
      carts.map((cart) => [cart.id, { x: cart.position.x, y: cart.position.y, rotation: cart.rotation }] as const),
    );
    const finals = new Map<string, { x: number; y: number; rotation: number }>();
    sortedCarts.forEach((cart, index) => {
      const seed = crashSeed(cart.id);
      const direction = index % 2 === 0 ? 1 : -1;
      const start = starts.get(cart.id)!;
      finals.set(cart.id, {
        x: start.x - (45 + seed * 35 + index * 18),
        y: start.y + direction * (95 + seed * 75 + Math.max(0, 2 - index) * 18),
        rotation: start.rotation + direction * (22 + seed * 34),
      });
    });

    const brokenFinal = {
      x: impactX - Math.max(55, brokenBounds.width * 0.35),
      y: impactY - Math.max(70, brokenBounds.height * 0.45),
      rotation: baseBrokenRotation - 48,
    };

    await new Promise<void>((resolve) => {
      const startedAt = performance.now();
      const tick = (now: number) => {
        const raw = Math.min(1, (now - startedAt) / CRASH_IMPACT_MS);
        const eased = crashEaseOut(raw);
        update((draft) => {
          const items = Array.isArray(draft) ? draft : [draft];
          for (const item of items) {
            if (item.id === broken.id) {
              item.position.x = impactX + (brokenFinal.x - impactX) * eased;
              item.position.y = impactY + (brokenFinal.y - impactY) * eased;
              item.rotation = baseBrokenRotation + (brokenFinal.rotation - baseBrokenRotation) * eased;
              continue;
            }
            const start = starts.get(item.id);
            const final = finals.get(item.id);
            if (!start || !final) continue;
            item.position.x = start.x + (final.x - start.x) * eased;
            item.position.y = start.y + (final.y - start.y) * eased;
            item.rotation = start.rotation + (final.rotation - start.rotation) * eased;
          }
        });
        if (raw >= 1) resolve();
        else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });

    stop();
    await OBR.scene.items.updateItems([broken.id, ...carts.map((cart) => cart.id)], (items) => {
      for (const item of items) {
        if (item.id === broken.id) {
          item.visible = true;
          item.position.x = brokenFinal.x;
          item.position.y = brokenFinal.y;
          item.rotation = brokenFinal.rotation;
          continue;
        }
        const final = finals.get(item.id);
        if (!final) continue;
        item.position.x = final.x;
        item.position.y = final.y;
        item.rotation = final.rotation;
      }
    });

    return { crashedHomes, targetTrack };
  } catch (error) {
    try {
      stop();
    } catch {}
    throw error;
  }
}

async function runCrashWarningPopover(): Promise<void> {
  const app = document.querySelector<HTMLDivElement>("#app")!;
  app.innerHTML = `
    <style>
      html, body { margin: 0; padding: 0; background: transparent; overflow: hidden; }
      #crashWarningButton {
        width: 58px; height: 58px; margin: 3px; border-radius: 50%;
        border: 2px solid rgba(255,214,102,0.9);
        background: rgba(93,35,24,0.86); color: #ffd666;
        font-size: 34px; line-height: 48px; cursor: pointer;
        box-shadow: 0 2px 10px rgba(0,0,0,0.4);
        animation: minecartWarningPulse 1.25s ease-in-out infinite;
      }
      #crashWarningButton:hover { transform: scale(1.06); }
      #crashWarningButton:disabled { cursor: default; opacity: 0.72; animation: none; }
      #crashWarningButton.firing { animation: minecartWarningFastPulse 0.3s ease-in-out infinite; }
      @keyframes minecartWarningPulse { 0%,100% { transform: scale(0.96); } 50% { transform: scale(1.04); } }
      @keyframes minecartWarningFastPulse { 0%,100% { transform: scale(0.96); } 50% { transform: scale(1.09); } }
    </style>
    <button id="crashWarningButton" title="Send broken minecart">⚠</button>
  `;
  const button = document.querySelector<HTMLButtonElement>("#crashWarningButton")!;
  if ((await OBR.player.getRole()) !== "GM") {
    button.hidden = true;
    return;
  }

  async function refresh(): Promise<void> {
    const state = await readCrashRuntime();
    button.disabled = state?.status !== "armed";
  }

  button.addEventListener("click", () => {
    void (async () => {
      const state = await readCrashRuntime();
      if (!state || state.status !== "armed") return;

      button.disabled = true;
      button.classList.add("firing");
      await writeCrashRuntime({ ...state, status: "running" });
      await OBR.broadcast.sendMessage(
        CRASH_CHANNEL,
        { type: "release-rattle", chaseRevision: state.chaseRevision },
        { destination: "LOCAL" },
      );

      try {
        await waitMs(450);
        const result = await executeBrokenCartCrash({ ...state, status: "running" });
        await writeCrashRuntime({
          ...state,
          status: "complete",
          crashedHomes: result.crashedHomes,
          crashedTrack: result.targetTrack,
        });
        button.classList.remove("firing");
        button.textContent = "💥";
        await waitMs(700);
        await OBR.popover.close(CRASH_POPOVER_ID);
      } catch (error) {
        console.error("Minecart Scroll crash event failed:", error);
        await writeCrashRuntime({
          ...state,
          status: "armed",
          crashedHomes: [],
          crashedTrack: null,
        });
        button.classList.remove("firing");
        button.textContent = "⚠";
        button.disabled = false;
      }
    })();
  });

  OBR.scene.onMetadataChange(() => void refresh());
  await refresh();
}

type SharedRenderEntry = {
  image: Image;
  spec: RuntimeLayerSpec;
  index: number;
};

type SharedInteractionManager = {
  update: (recipe: (draft: Image | Image[]) => void) => void;
  stop: () => void;
};
async function runSharedInteractionRenderer(): Promise<void> {
  let runtime: RuntimeState | null = null;
  let entries: SharedRenderEntry[] = [];
  let manager: SharedInteractionManager | null = null;
  let timer = 0;
  let healthTimer = 0;
  let runtimePollTimer = 0;
  let lastRuntimePollSignature = "";
  let reportedMovingRevision = -1;
  let reportedErrorRevision = -1;
  let originalPlayerColor: string | null = null;
  let interactionColorApplied = false;

  async function applySubtleInteractionColor(): Promise<void> {
    if (interactionColorApplied) return;
    try {
      const [role, name, currentColor] = await Promise.all([
        OBR.player.getRole(),
        OBR.player.getName(),
        OBR.player.getColor(),
      ]);
      const normalizedName = name.trim().toLowerCase();
      const targetColor =
        role === "GM"
          ? SUBTLE_GM_INTERACTION_COLOR
          : normalizedName === "cast"
            ? SUBTLE_CAST_INTERACTION_COLOR
            : null;
      if (!targetColor) return;
      originalPlayerColor = currentColor;
      interactionColorApplied = true;
      if (currentColor.toLowerCase() !== targetColor.toLowerCase()) {
        await OBR.player.setColor(targetColor);
      }
    } catch (error) {
      console.error("Minecart Scroll could not apply subtle interaction color:", error);
    }
  }

  async function restorePlayerColor(): Promise<void> {
    if (!interactionColorApplied) return;
    const restoreColor = originalPlayerColor;
    originalPlayerColor = null;
    interactionColorApplied = false;
    if (!restoreColor) return;
    try {
      await OBR.player.setColor(restoreColor);
    } catch (error) {
      console.error("Minecart Scroll could not restore player color:", error);
    }
  }
  async function reportDiagnostic(
    revision: number,
    stage: RendererDiagnosticStage,
    message: string,
    itemCount = entries.length,
  ): Promise<void> {
    const diagnostic: RendererDiagnostic = {
      version: 1,
      revision,
      stage,
      itemCount,
      atMs: Date.now(),
      message,
    };
    await OBR.player.setMetadata({ [RENDERER_DIAG_KEY]: diagnostic });
  }
  async function writeBackgroundHeartbeat(): Promise<void> {
    try {
      const health: BackgroundHealth = {
        version: 1,
        atMs: Date.now(),
        sceneReady: await OBR.scene.isReady(),
        message: "Background shared-item interaction renderer is alive.",
      };
      await OBR.player.setMetadata({ [BACKGROUND_HEALTH_KEY]: health });
    } catch (error) {
      console.error("Minecart Scroll background heartbeat failed:", error);
    } finally {
      healthTimer = window.setTimeout(() => void writeBackgroundHeartbeat(), 1000);
    }
  }
  function stopInteraction(): void {
    if (manager) {
      try {
        manager.stop();
      } catch (error) {
        console.error("Minecart Scroll could not stop scenery interaction:", error);
      }
      manager = null;
    }
    entries = [];
  }

  async function rebuild(next: RuntimeState): Promise<void> {
    stopInteraction();
    try {
      await reportDiagnostic(next.revision, "runtime", "Background renderer received the chase state.", 0);
      const nextEntries: SharedRenderEntry[] = [];
      const interactionImages: Image[] = [];
      for (const spec of next.layers) {
        const shared = await OBR.scene.items.getItems(spec.ids);
        const byId = new Map(shared.filter(isImage).map((image) => [image.id, image] as const));
        for (let index = 0; index < spec.ids.length; index += 1) {
          const image = byId.get(spec.ids[index]);
          if (!image) throw new Error(`Could not load shared ${spec.name} scenery item ${index + 1}.`);
          interactionImages.push(image);
          nextEntries.push({ image, spec, index });
        }
      }
      if (interactionImages.length === 0) throw new Error("No shared scenery items were available for the renderer.");
      await applySubtleInteractionColor();
      const [update, stop] = await OBR.interaction.startItemInteraction(interactionImages);
      manager = {
        update: update as SharedInteractionManager["update"],
        stop,
      };
      entries = nextEntries;
      reportedMovingRevision = -1;
      reportedErrorRevision = -1;
      await reportDiagnostic(
        next.revision,
        "items",
        `Opened one shared-item interaction for ${entries.length} scenery images.`,
        entries.length,
      );
    } catch (error) {
      stopInteraction();
      await restorePlayerColor();
      const message = error instanceof Error ? error.message : "Could not open the shared scenery interaction.";
      console.error("Minecart Scroll shared interaction renderer rebuild failed:", error);
      try {
        await reportDiagnostic(next.revision, "error", message, 0);
      } catch {}
    }
  }
  function renderTick(): void {
    try {
      if (!runtime || runtime.runState === "stopped" || !manager || entries.length === 0) return;

      const snapshot =
        runtime.runState === "running"
          ? motionAt(runtime.motion)
          : { distance: runtime.motion.distanceAtSegmentStart, speed: 0 };
      const xById = new Map<string, number>();
      const yById = new Map<string, number>();
      for (const entry of entries) {
        xById.set(
          entry.image.id,
          positionForDistance(
            entry.spec.startX,
            entry.spec.spacing,
            entry.spec.ids.length,
            entry.index,
            snapshot.distance * entry.spec.multiplier + entry.spec.distanceOffset,
          ),
        );
        yById.set(entry.image.id, entry.spec.y);
      }
      manager.update((draft) => {
        const items = Array.isArray(draft) ? draft : [draft];
        for (const item of items) {
          const x = xById.get(item.id);
          const y = yById.get(item.id);
          if (x !== undefined) item.position.x = x;
          if (y !== undefined) item.position.y = y;
        }
      });
      if (runtime.runState === "running" && reportedMovingRevision !== runtime.revision) {
        reportedMovingRevision = runtime.revision;
        void reportDiagnostic(
          runtime.revision,
          "moving",
          "Background shared-item interaction completed its first moving frame.",
          entries.length,
        );
      }
    } catch (error) {
      console.error("Minecart Scroll shared interaction render tick failed:", error);
      if (runtime && reportedErrorRevision !== runtime.revision) {
        reportedErrorRevision = runtime.revision;
        const message = error instanceof Error ? error.message : "Shared interaction render tick failed.";
        void reportDiagnostic(runtime.revision, "error", message, entries.length);
      }
    } finally {
      timer = window.setTimeout(renderTick, LOCAL_TICK_MS);
    }
  }
  async function sync(metadata: Metadata): Promise<void> {
    const next = parseRuntime(metadata[RUNTIME_KEY]);
    const previous = runtime;
    runtime = next;

    if (!next || next.runState === "stopped") {
      stopInteraction();
      await restorePlayerColor();
      return;
    }
    const previousLayerSignature =
      previous?.layers
        .map((layer) => `${layer.name}:${layer.ids.join(",")}:${layer.startX}:${layer.y}:${layer.spacing}`)
        .join("|") ?? "";
    const nextLayerSignature = next.layers
      .map((layer) => `${layer.name}:${layer.ids.join(",")}:${layer.startX}:${layer.y}:${layer.spacing}`)
      .join("|");
    if (!manager || entries.length === 0 || previousLayerSignature !== nextLayerSignature) {
      await rebuild(next);
    } else {
      const nextSpecs = new Map(next.layers.map((layer) => [layer.name, layer] as const));
      for (const entry of entries) {
        const nextSpec = nextSpecs.get(entry.spec.name);
        if (nextSpec) entry.spec = nextSpec;
      }
    }
  }

  if (await OBR.scene.isReady()) {
    try {
      await reportDiagnostic(-1, "boot", "Background shared-item interaction renderer is loaded.", 0);
    } catch {}
    await sync(await OBR.scene.getMetadata());
  }
  async function pollRuntimeState(): Promise<void> {
    try {
      if (await OBR.scene.isReady()) {
        const metadata = await OBR.scene.getMetadata();
        const next = parseRuntime(metadata[RUNTIME_KEY]);
        const signature = next ? `${next.revision}:${next.runState}` : "none";
        if (signature !== lastRuntimePollSignature) {
          lastRuntimePollSignature = signature;
          await sync(metadata);
        }
      }
    } catch (error) {
      console.error("Minecart Scroll runtime poll failed:", error);
    } finally {
      runtimePollTimer = window.setTimeout(() => void pollRuntimeState(), 250);
    }
  }
  OBR.scene.onReadyChange((ready) => {
    void (async () => {
      if (!ready) {
        runtime = null;
        lastRuntimePollSignature = "";
        stopInteraction();
        await restorePlayerColor();
        return;
      }
      const metadata = await OBR.scene.getMetadata();
      const next = parseRuntime(metadata[RUNTIME_KEY]);
      lastRuntimePollSignature = next ? `${next.revision}:${next.runState}` : "none";
      await sync(metadata);
    })();
  });
  void timer;
  void healthTimer;
  void runtimePollTimer;
  window.addEventListener("beforeunload", () => {
    if (interactionColorApplied && originalPlayerColor) {
      void OBR.player.setColor(originalPlayerColor);
    }
  });
  void writeBackgroundHeartbeat();
  void pollRuntimeState();
  renderTick();
}

const pageParams = new URLSearchParams(window.location.search);
const backgroundMode = pageParams.get("background") === "1";
const crashWarningMode = pageParams.get("crashWarning") === "1";

type RunState = "stopped" | "running" | "paused";

type LoopLayer = {
  name: string;
  images: Image[];
  positions: Map<string, number>;
  startX: number;
  y: number;
  spacing: number;
  highestZ: number;
  zQueue: Promise<void>;
};
type MinecartRattleState = {
  baseX: number;
  baseY: number;
  phaseA: number;
  phaseB: number;
  frequencyA: number;
  frequencyB: number;
  amplitudeScale: number;
  offsetY: number;
};

type MinecartRattleGroup = {
  images: Image[];
  states: Map<string, MinecartRattleState>;
};
type SavedSettings = {
  version: 5;
  floorIds: string[];
  trackIds: string[];
  backgroundIds: string[];
  foregroundIds: string[];
  minecartIds: string[];
  brokenCartId: string | null;
  crashTrack1Y: number | null;
  crashTrack2Y: number | null;
  anchorX: number;
  anchorY: number;
  floorYOffset: number;
  trackYOffset: number;
  foregroundYOffset: number;
  floorOverlap: number;
  backgroundOverlap: number;
  foregroundOverlap: number;
  targetSpeed: number;
  acceleration: number;
  floorMultiplier: number;
  backgroundMultiplier: number;
  foregroundMultiplier: number;
  rattleEnabled: boolean;
  rattleStrength: number;
  rattleStartSpeed: number;
  focusOnStart: boolean;
};
if (backgroundMode) {
  OBR.onReady(() => void runSharedInteractionRenderer());
} else if (crashWarningMode) {
  OBR.onReady(() => void runCrashWarningPopover());
} else {
document.querySelector<HTMLDivElement>("#app")!.innerHTML = `
  <div style="font-family: Arial, sans-serif; padding: 14px;">
    <h2 style="margin: 0 0 8px; text-align: center;">Minecart Scroll</h2>
    <p id="status" style="text-align:center; margin: 6px 0 6px;">Waiting for Owlbear...</p>
    <p id="rendererHealth" style="text-align:center; margin:0 0 12px; font-size:12px; font-weight:bold;">Background renderer: checking...</p>
    <div id="playerPanel" hidden style="text-align:center; padding: 18px 8px;">
      <h3>Chase View</h3>
      <p>The GM controls Minecart Scroll.</p>
      <p>You do not need this panel open to see the chase.</p>
    </div>

    <div id="gmPanel" hidden style="max-height: 540px; overflow-y: auto; padding-right: 4px;">
      <fieldset>
        <legend><strong>Layers</strong></legend>
        <button id="setFloorButton">Set Floor</button>
        <span id="floorStatus">Not set (optional)</span><br><br>
        <button id="setBackgroundButton">Set Background</button>
        <span id="backgroundStatus">Not set</span><br><br>

        <button id="setTrackButton">Set Track</button>
        <span id="trackStatus">Not set</span><br><br>

        <button id="setForegroundButton">Set Foreground</button>
        <span id="foregroundStatus">Not set (optional)</span><br><br>
        <button id="setMinecartsButton">Set Minecarts</button>
        <span id="minecartsStatus">Not set (optional)</span><br><br>

        <button id="setBrokenCartButton">Set Broken Cart</button>
        <span id="brokenCartStatus">Not set (optional)</span>
        <p style="font-size:12px; margin:6px 0 10px;">
          Select one separate broken/wrecked cart. During a chase a GM-only ⚠ trigger hovers on the right side.
        </p>

        <hr style="border:0; border-top:1px solid #7775; margin:10px 0;">
        <strong>Crash Tracks</strong><br><br>
        <button id="setCrashTrack1Button">Set Track 1 Position</button>
        <span id="crashTrack1Status">Not set</span><br><br>
        <button id="setCrashTrack2Button">Set Track 2 Position</button>
        <span id="crashTrack2Status">Not set</span>
        <p style="font-size:12px;">
          Select one cart or image centered on each rail, then set its track position.
          When ⚠ is clicked, only minecarts currently closest to the broken cart's rail will crash.
        </p>
        <button id="resetCrashedMinecartsButton">Reset Last Crash</button>
        <span id="resetCrashStatus">No crash to reset</span>
        <p style="font-size:12px; margin-bottom:0;">
          Restores only the carts hit by the last crash to their pre-impact X positions,
          centers them back on their crash rail, resets their rotation, and re-arms the broken cart for testing.
        </p>
      </fieldset>

      <br>

      <fieldset>
        <legend><strong>Scene Settings</strong></legend>
        <button id="saveButton">Save Settings</button>
        <button id="loadButton">Load Settings</button>
        <p style="font-size: 12px; margin-bottom: 0;">
          Saves layer assignments and chase controls to this Owlbear scene.
        </p>
      </fieldset>
      <br>
      <fieldset>
        <legend><strong>Anchor</strong></legend>
        <label>Anchor X:
          <input id="anchorXInput" type="number" value="0" step="50" style="width:90px;">
        </label>
        <br><br>
        <label>Anchor Y:
          <input id="anchorYInput" type="number" value="0" step="50" style="width:90px;">
        </label>
        <br><br>
        <button id="goToAnchorButton">Go to Anchor Point</button>
        <label style="display:block; margin-top:10px;">
          <input id="focusOnStartCheckbox" type="checkbox" checked>
          Go to anchor when chase starts
        </label>
      </fieldset>
      <br>
      <fieldset>
        <legend><strong>Layout</strong></legend>
        <label>Floor Y Offset:
          <input id="floorYOffsetInput" type="number" value="0" step="10" style="width:90px;">
        </label>
        <br><br>
        <label>Track Y Offset:
          <input id="trackYOffsetInput" type="number" value="0" step="10" style="width:90px;">
        </label>
        <br><br>
        <label>Foreground Y Offset:
          <input id="foregroundYOffsetInput" type="number" value="0" step="10" style="width:90px;">
        </label>
        <br><br>
        <label>Floor Seam Overlap:
          <input id="floorOverlapInput" type="number" min="0" max="50" value="0" step="1" style="width:70px;">
        </label>
        <br><br>
        <label>Background Seam Overlap:
          <input id="backgroundOverlapInput" type="number" min="0" max="50" value="0" step="1" style="width:70px;">
        </label>
        <br><br>
        <label>Foreground Seam Overlap:
          <input id="foregroundOverlapInput" type="number" min="0" max="50" value="0" step="1" style="width:70px;">
        </label>
      </fieldset>
      <br>

      <fieldset>
        <legend><strong>Motion</strong></legend>
        <label>Main Target Speed: <strong><span id="targetSpeedValue">—</span> ft/s</strong></label>
        <input id="targetSpeedSlider" type="range" min="0" max="100" value="0" step="0.5" style="width:100%;">

        <p style="margin:8px 0;">Current Speed: <strong><span id="currentSpeedValue">0.0</span> ft/s</strong></p>
        <label>Acceleration / Braking: <strong><span id="accelerationValue">—</span> ft/s²</strong></label>
        <input id="accelerationSlider" type="range" min="0" max="100" value="0" step="0.5" style="width:100%;">
        <p id="speedScaleValue" style="font-size:12px; margin:6px 0 0;">Reading Owlbear grid scale...</p>
        <br><br>
        <label>Floor Speed: <strong><span id="floorMultiplierValue">10</span>%</strong></label>
        <input id="floorMultiplierSlider" type="range" min="0" max="100" value="10" step="5" style="width:100%;">

        <br><br>
        <label>Background Speed: <strong><span id="backgroundMultiplierValue">10</span>%</strong></label>
        <input id="backgroundMultiplierSlider" type="range" min="0" max="100" value="10" step="5" style="width:100%;">
        <br><br>
        <label>Foreground Speed: <strong><span id="foregroundMultiplierValue">140</span>%</strong></label>
        <input id="foregroundMultiplierSlider" type="range" min="100" max="250" value="140" step="5" style="width:100%;">
      </fieldset>

      <br>
      <fieldset>
        <legend><strong>Minecart Rattle</strong></legend>
        <label>
          <input id="rattleEnabledCheckbox" type="checkbox" checked>
          Enable minecart rattle (turn OFF for free movement)
        </label>
        <br><br>
        <label>Rattle Strength: <strong><span id="rattleStrengthValue">30</span>%</strong></label>
        <input id="rattleStrengthSlider" type="range" min="0" max="200" value="30" step="10" style="width:100%;">
        <br><br>
        <label>Rattle Starts At:
          <input id="rattleStartSpeedInput" type="number" min="0" max="100" value="0" step="0.5" style="width:80px;"> ft/s
        </label>
      </fieldset>
      <br>
      <fieldset>
        <legend><strong>Chase</strong></legend>
        <button id="startButton">Start</button>
        <button id="pauseButton" disabled>Pause</button>
        <button id="resumeButton" disabled>Resume</button>
        <button id="stopButton" disabled>Stop</button>
        <br><br>
        <button id="emergencyResetButton" style="width:100%;">Emergency Reset</button>
        <p style="font-size: 12px; margin-bottom: 0;">
          Stops this extension's active animation/interaction without changing saved layer assignments.
        </p>
      </fieldset>
    </div>
  </div>
`;
OBR.onReady(async () => {
  const status = document.querySelector<HTMLParagraphElement>("#status")!;
  const rendererHealth = document.querySelector<HTMLParagraphElement>("#rendererHealth")!;
  const gmPanel = document.querySelector<HTMLDivElement>("#gmPanel")!;
  const playerPanel = document.querySelector<HTMLDivElement>("#playerPanel")!;
  const role = await OBR.player.getRole();
  if (role !== "GM") {
    playerPanel.hidden = false;
    status.textContent = "Player view — controlled by the GM.";
    return;
  }

  gmPanel.hidden = false;
  status.textContent = "GM controls ready.";
  const floorStatus = document.querySelector<HTMLSpanElement>("#floorStatus")!;
  const trackStatus = document.querySelector<HTMLSpanElement>("#trackStatus")!;
  const backgroundStatus = document.querySelector<HTMLSpanElement>("#backgroundStatus")!;
  const foregroundStatus = document.querySelector<HTMLSpanElement>("#foregroundStatus")!;
  const minecartsStatus = document.querySelector<HTMLSpanElement>("#minecartsStatus")!;
  const brokenCartStatus = document.querySelector<HTMLSpanElement>("#brokenCartStatus")!;
  const crashTrack1Status = document.querySelector<HTMLSpanElement>("#crashTrack1Status")!;
  const crashTrack2Status = document.querySelector<HTMLSpanElement>("#crashTrack2Status")!;
  const resetCrashStatus = document.querySelector<HTMLSpanElement>("#resetCrashStatus")!;
  const setFloorButton = document.querySelector<HTMLButtonElement>("#setFloorButton")!;
  const setTrackButton = document.querySelector<HTMLButtonElement>("#setTrackButton")!;
  const setBackgroundButton = document.querySelector<HTMLButtonElement>("#setBackgroundButton")!;
  const setForegroundButton = document.querySelector<HTMLButtonElement>("#setForegroundButton")!;
  const setMinecartsButton = document.querySelector<HTMLButtonElement>("#setMinecartsButton")!;
  const setBrokenCartButton = document.querySelector<HTMLButtonElement>("#setBrokenCartButton")!;
  const setCrashTrack1Button = document.querySelector<HTMLButtonElement>("#setCrashTrack1Button")!;
  const setCrashTrack2Button = document.querySelector<HTMLButtonElement>("#setCrashTrack2Button")!;
  const resetCrashedMinecartsButton =
    document.querySelector<HTMLButtonElement>("#resetCrashedMinecartsButton")!;
  const saveButton = document.querySelector<HTMLButtonElement>("#saveButton")!;
  const loadButton = document.querySelector<HTMLButtonElement>("#loadButton")!;
  const anchorXInput = document.querySelector<HTMLInputElement>("#anchorXInput")!;
  const anchorYInput = document.querySelector<HTMLInputElement>("#anchorYInput")!;
  const goToAnchorButton = document.querySelector<HTMLButtonElement>("#goToAnchorButton")!;
  const focusOnStartCheckbox = document.querySelector<HTMLInputElement>("#focusOnStartCheckbox")!;
  const floorYOffsetInput = document.querySelector<HTMLInputElement>("#floorYOffsetInput")!;
  const trackYOffsetInput = document.querySelector<HTMLInputElement>("#trackYOffsetInput")!;
  const foregroundYOffsetInput = document.querySelector<HTMLInputElement>("#foregroundYOffsetInput")!;
  const floorOverlapInput = document.querySelector<HTMLInputElement>("#floorOverlapInput")!;
  const backgroundOverlapInput = document.querySelector<HTMLInputElement>("#backgroundOverlapInput")!;
  const foregroundOverlapInput = document.querySelector<HTMLInputElement>("#foregroundOverlapInput")!;
  const targetSpeedSlider = document.querySelector<HTMLInputElement>("#targetSpeedSlider")!;
  const targetSpeedValue = document.querySelector<HTMLSpanElement>("#targetSpeedValue")!;
  const currentSpeedValue = document.querySelector<HTMLSpanElement>("#currentSpeedValue")!;
  const accelerationSlider = document.querySelector<HTMLInputElement>("#accelerationSlider")!;
  const accelerationValue = document.querySelector<HTMLSpanElement>("#accelerationValue")!;
  const speedScaleValue = document.querySelector<HTMLParagraphElement>("#speedScaleValue")!;
  const floorMultiplierSlider = document.querySelector<HTMLInputElement>("#floorMultiplierSlider")!;
  const floorMultiplierValue = document.querySelector<HTMLSpanElement>("#floorMultiplierValue")!;
  const backgroundMultiplierSlider = document.querySelector<HTMLInputElement>("#backgroundMultiplierSlider")!;
  const backgroundMultiplierValue = document.querySelector<HTMLSpanElement>("#backgroundMultiplierValue")!;
  const foregroundMultiplierSlider = document.querySelector<HTMLInputElement>("#foregroundMultiplierSlider")!;
  const foregroundMultiplierValue = document.querySelector<HTMLSpanElement>("#foregroundMultiplierValue")!;
  const rattleEnabledCheckbox = document.querySelector<HTMLInputElement>("#rattleEnabledCheckbox")!;
  const rattleStrengthSlider = document.querySelector<HTMLInputElement>("#rattleStrengthSlider")!;
  const rattleStrengthValue = document.querySelector<HTMLSpanElement>("#rattleStrengthValue")!;
  const rattleStartSpeedInput = document.querySelector<HTMLInputElement>("#rattleStartSpeedInput")!;
  const startButton = document.querySelector<HTMLButtonElement>("#startButton")!;
  async function refreshRendererHealth(): Promise<void> {
    try {
      const [health, diagnostic] = await Promise.all([readBackgroundHealth(), readRendererDiagnostic()]);
      const age = health ? Date.now() - health.atMs : Number.POSITIVE_INFINITY;
      const online = age < 2500;
      const healthText = online
        ? `ONLINE${health?.sceneReady ? " / scene ready" : " / waiting for scene"}`
        : "OFFLINE";
      const diagText = diagnostic
        ? ` | stage: ${diagnostic.stage}${diagnostic.itemCount ? ` (${diagnostic.itemCount} items)` : ""}`
        : " | stage: none";
      rendererHealth.textContent = `Background renderer: ${healthText}${diagText}`;
    } catch (error) {
      rendererHealth.textContent = "Background renderer: health check failed";
      console.error("Could not read background renderer health:", error);
    }
  }
  window.setInterval(() => void refreshRendererHealth(), 500);
  void refreshRendererHealth();
  const pauseButton = document.querySelector<HTMLButtonElement>("#pauseButton")!;
  const resumeButton = document.querySelector<HTMLButtonElement>("#resumeButton")!;
  const stopButton = document.querySelector<HTMLButtonElement>("#stopButton")!;
  const emergencyResetButton = document.querySelector<HTMLButtonElement>("#emergencyResetButton")!;
  let floorIds: string[] = [];
  let trackIds: string[] = [];
  let backgroundIds: string[] = [];
  let foregroundIds: string[] = [];
  let minecartIds: string[] = [];
  let brokenCartId: string | null = null;
  let crashTrack1Y: number | null = null;
  let crashTrack2Y: number | null = null;

  let anchorX = 0;
  let anchorY = 0;
  let floorYOffset = 0;
  let trackYOffset = 0;
  let foregroundYOffset = 0;
  let floorOverlap = 0;
  let backgroundOverlap = 0;
  let foregroundOverlap = 0;
  let targetSpeed = 150;
  let currentSpeed = 0;
  let acceleration = 200;
  let floorMultiplier = 0.1;
  let backgroundMultiplier = 0.1;
  let foregroundMultiplier = 1.4;
  let rattleEnabled = true;
  let rattleStrength = 0.3;
  let rattleStartSpeed = 100;

  // The scrolling engine continues to use Owlbear scene units/second internally.
  // The UI converts those values to real feet/second using the current scene grid.
  let sceneGridDpi = 150;
  let feetPerGridCell = 5;
  let speedScaleReady = false;
  let runState: RunState = "stopped";
  let runtimeState: RuntimeState | null = null;
  let activeFloor: LoopLayer | null = null;
  let activeTrack: LoopLayer | null = null;
  let activeBackground: LoopLayer | null = null;
  let activeForeground: LoopLayer | null = null;
  let activeMinecarts: MinecartRattleGroup | null = null;
  type InteractionManager = Awaited<ReturnType<typeof OBR.interaction.startItemInteraction>>;
  const layerInteractions = new Map<string, InteractionManager>();
  const layerRenewTimers = new Map<string, number>();
  let minecartInteractionUpdate: InteractionManager[0] | null = null;
  let minecartInteractionStop: InteractionManager[1] | null = null;
  let minecartRenewTimer = 0;
  let selectedItemIds = new Set<string>();
  let draggedMinecartId: string | null = null;
  let minecartRattleSuspended = false;
  let minecartDropTimer = 0;
  let lastObservedMinecartX = 0;
  let lastObservedMinecartY = 0;
  let lastMinecartRattleUpdateMs = 0;

  let animationFrame = 0;
  let renewing = false;
  let lastTime = 0;

  function clampNumber(value: number, min: number, max: number, fallback: number): number {
    if (!Number.isFinite(value)) return fallback;
    return Math.max(min, Math.min(max, value));
  }
  function gridUnitToFeet(unit: string): number | null {
    const normalized = unit.trim().toLowerCase();
    if (["ft", "foot", "feet"].includes(normalized)) return 1;
    if (["in", "inch", "inches"].includes(normalized)) return 1 / 12;
    if (["yd", "yard", "yards"].includes(normalized)) return 3;
    if (["mi", "mile", "miles"].includes(normalized)) return 5280;
    if (["m", "meter", "meters", "metre", "metres"].includes(normalized)) return 3.280839895;
    if (["cm", "centimeter", "centimeters", "centimetre", "centimetres"].includes(normalized)) return 0.03280839895;
    if (["mm", "millimeter", "millimeters", "millimetre", "millimetres"].includes(normalized)) return 0.003280839895;
    if (["km", "kilometer", "kilometers", "kilometre", "kilometres"].includes(normalized)) return 3280.839895;
    return null;
  }
  function internalSpeedToFeetPerSecond(value: number): number {
    if (!speedScaleReady || sceneGridDpi <= 0) return 0;
    return (value * feetPerGridCell) / sceneGridDpi;
  }

  function feetPerSecondToInternalSpeed(value: number): number {
    if (!speedScaleReady || feetPerGridCell <= 0) return 0;
    return (value * sceneGridDpi) / feetPerGridCell;
  }

  function formatFeetPerSecondFromInternal(value: number): string {
    return internalSpeedToFeetPerSecond(value).toFixed(1);
  }
  function speedUiStep(maxFeetPerSecond: number): number {
    if (maxFeetPerSecond <= 10) return 0.1;
    if (maxFeetPerSecond <= 50) return 0.5;
    return 1;
  }

  function configureSpeedControlRanges(): void {
    if (!speedScaleReady) return;

    const maxFeetPerSecond = internalSpeedToFeetPerSecond(MAX_INTERNAL_SPEED);
    const maxAccelerationFeetPerSecondSquared = internalSpeedToFeetPerSecond(MAX_INTERNAL_ACCELERATION);
    const minAccelerationFeetPerSecondSquared = internalSpeedToFeetPerSecond(25);
    const step = speedUiStep(maxFeetPerSecond);
    targetSpeedSlider.min = "0";
    targetSpeedSlider.max = String(maxFeetPerSecond);
    targetSpeedSlider.step = String(step);

    accelerationSlider.min = String(minAccelerationFeetPerSecondSquared);
    accelerationSlider.max = String(maxAccelerationFeetPerSecondSquared);
    accelerationSlider.step = String(step);

    rattleStartSpeedInput.min = "0";
    rattleStartSpeedInput.max = String(maxFeetPerSecond);
    rattleStartSpeedInput.step = String(step);
  }
  function renderSpeedControls(): void {
    if (!speedScaleReady) return;
    configureSpeedControlRanges();
    targetSpeedSlider.value = String(internalSpeedToFeetPerSecond(targetSpeed));
    targetSpeedValue.textContent = formatFeetPerSecondFromInternal(targetSpeed);
    currentSpeedValue.textContent = formatFeetPerSecondFromInternal(currentSpeed);
    accelerationSlider.value = String(internalSpeedToFeetPerSecond(acceleration));
    accelerationValue.textContent = formatFeetPerSecondFromInternal(acceleration);
    rattleStartSpeedInput.value = String(internalSpeedToFeetPerSecond(rattleStartSpeed));
  }
  async function refreshSceneSpeedScale(): Promise<void> {
    if (!(await OBR.scene.isReady())) {
      speedScaleReady = false;
      speedScaleValue.textContent = "Open a scene to calculate ft/s from the grid scale.";
      return;
    }

    const [dpi, scale] = await Promise.all([OBR.scene.grid.getDpi(), OBR.scene.grid.getScale()]);
    const unitFeet = gridUnitToFeet(scale.parsed.unit);
    if (!Number.isFinite(dpi) || dpi <= 0 || !Number.isFinite(scale.parsed.multiplier) || scale.parsed.multiplier <= 0 || unitFeet === null) {
      speedScaleReady = false;
      speedScaleValue.textContent = `Cannot convert grid scale "${scale.raw}" to feet. Use a distance unit such as ft, in, yd, mi, m, cm, mm, or km.`;
      return;
    }
    sceneGridDpi = dpi;
    feetPerGridCell = scale.parsed.multiplier * unitFeet;
    speedScaleReady = true;
    speedScaleValue.textContent = `Scene scale: ${feetPerGridCell.toFixed(2).replace(/\.?0+$/, "")} ft/grid @ ${Math.round(sceneGridDpi)} units/grid`;
    renderSpeedControls();
  }
  function readControls(): void {
    anchorX = Number.isFinite(Number(anchorXInput.value)) ? Number(anchorXInput.value) : 0;
    anchorY = Number.isFinite(Number(anchorYInput.value)) ? Number(anchorYInput.value) : 0;
    floorYOffset = clampNumber(Number(floorYOffsetInput.value), -10000, 10000, 0);
    trackYOffset = clampNumber(Number(trackYOffsetInput.value), -10000, 10000, 0);
    foregroundYOffset = clampNumber(Number(foregroundYOffsetInput.value), -10000, 10000, 0);
    floorOverlap = clampNumber(Number(floorOverlapInput.value), 0, 50, 0);
    backgroundOverlap = clampNumber(Number(backgroundOverlapInput.value), 0, 50, 0);
    foregroundOverlap = clampNumber(Number(foregroundOverlapInput.value), 0, 50, 0);
    rattleEnabled = rattleEnabledCheckbox.checked;
    rattleStrength = clampNumber(Number(rattleStrengthSlider.value), 0, 200, 30) / 100;
    rattleStartSpeed = clampNumber(feetPerSecondToInternalSpeed(Number(rattleStartSpeedInput.value)), 0, MAX_INTERNAL_SPEED, 100);
  }
  function updateLayerLabels(): void {
    floorStatus.textContent = floorIds.length >= 2 ? `${floorIds.length} images` : "Not set (optional)";
    trackStatus.textContent = trackIds.length >= 2 ? `${trackIds.length} images` : "Not set";
    backgroundStatus.textContent = backgroundIds.length >= 2 ? `${backgroundIds.length} images` : "Not set";
    foregroundStatus.textContent = foregroundIds.length >= 2 ? `${foregroundIds.length} images` : "Not set (optional)";
    minecartsStatus.textContent = minecartIds.length >= 1 ? `${minecartIds.length} images` : "Not set (optional)";
    brokenCartStatus.textContent = brokenCartId ? "1 image" : "Not set (optional)";
    crashTrack1Status.textContent = crashTrack1Y === null ? "Not set" : `Y ${Math.round(crashTrack1Y)}`;
    crashTrack2Status.textContent = crashTrack2Y === null ? "Not set" : `Y ${Math.round(crashTrack2Y)}`;
  }
  function updateRunButtons(): void {
    startButton.disabled = runState !== "stopped" || renewing;
    pauseButton.disabled = runState !== "running" || renewing;
    resumeButton.disabled = runState !== "paused" || renewing;
    stopButton.disabled = runState === "stopped" || renewing;
    setFloorButton.disabled = runState !== "stopped";
    setTrackButton.disabled = runState !== "stopped";
    setBackgroundButton.disabled = runState !== "stopped";
    setForegroundButton.disabled = runState !== "stopped";
    setMinecartsButton.disabled = runState !== "stopped";
    setBrokenCartButton.disabled = runState !== "stopped";
    setCrashTrack1Button.disabled = runState !== "stopped";
    setCrashTrack2Button.disabled = runState !== "stopped";
    loadButton.disabled = runState !== "stopped";
  }
  function applyTargetSpeed(value: number): void {
    targetSpeed = clampNumber(value, 0, MAX_INTERNAL_SPEED, 150);
    if (speedScaleReady) {
      targetSpeedSlider.value = String(internalSpeedToFeetPerSecond(targetSpeed));
      targetSpeedValue.textContent = formatFeetPerSecondFromInternal(targetSpeed);
    }
  }

  function applyTargetSpeedFeetPerSecond(value: number): void {
    applyTargetSpeed(feetPerSecondToInternalSpeed(value));
  }
  function applyAcceleration(value: number): void {
    acceleration = clampNumber(value, 25, MAX_INTERNAL_ACCELERATION, 200);
    if (speedScaleReady) {
      accelerationSlider.value = String(internalSpeedToFeetPerSecond(acceleration));
      accelerationValue.textContent = formatFeetPerSecondFromInternal(acceleration);
    }
  }

  function applyAccelerationFeetPerSecondSquared(value: number): void {
    applyAcceleration(feetPerSecondToInternalSpeed(value));
  }
  function applyFloorMultiplier(percent: number): void {
    const value = clampNumber(percent, 0, 100, 10);
    floorMultiplier = value / 100;
    floorMultiplierSlider.value = String(value);
    floorMultiplierValue.textContent = String(Math.round(value));
  }
  function applyBackgroundMultiplier(percent: number): void {
    const value = clampNumber(percent, 0, 100, 10);
    backgroundMultiplier = value / 100;
    backgroundMultiplierSlider.value = String(value);
    backgroundMultiplierValue.textContent = String(Math.round(value));
  }
  function applyForegroundMultiplier(percent: number): void {
    const value = clampNumber(percent, 100, 250, 140);
    foregroundMultiplier = value / 100;
    foregroundMultiplierSlider.value = String(value);
    foregroundMultiplierValue.textContent = String(Math.round(value));
  }
  targetSpeedSlider.addEventListener("input", () => {
    applyTargetSpeedFeetPerSecond(Number(targetSpeedSlider.value));
    if (runState !== "stopped") void updateRuntimeMotionControls();
  });
  accelerationSlider.addEventListener("input", () => {
    applyAccelerationFeetPerSecondSquared(Number(accelerationSlider.value));
    if (runState !== "stopped") void updateRuntimeMotionControls();
  });
  floorMultiplierSlider.addEventListener("input", () => applyFloorMultiplier(Number(floorMultiplierSlider.value)));
  backgroundMultiplierSlider.addEventListener("input", () => applyBackgroundMultiplier(Number(backgroundMultiplierSlider.value)));
  foregroundMultiplierSlider.addEventListener("input", () => applyForegroundMultiplier(Number(foregroundMultiplierSlider.value)));

  floorMultiplierSlider.addEventListener("change", () => {
    applyFloorMultiplier(Number(floorMultiplierSlider.value));
    if (runState !== "stopped") void updateRuntimeLayerMultipliers();
  });
  backgroundMultiplierSlider.addEventListener("change", () => {
    applyBackgroundMultiplier(Number(backgroundMultiplierSlider.value));
    if (runState !== "stopped") void updateRuntimeLayerMultipliers();
  });
  foregroundMultiplierSlider.addEventListener("change", () => {
    applyForegroundMultiplier(Number(foregroundMultiplierSlider.value));
    if (runState !== "stopped") void updateRuntimeLayerMultipliers();
  });
  rattleEnabledCheckbox.addEventListener("change", () => {
    void handleRattleToggle().catch((error) => {
      console.error("Could not change minecart rattle mode:", error);
      status.textContent = error instanceof Error ? error.message : "Could not change minecart rattle mode.";
    });
  });
  OBR.broadcast.onMessage(CRASH_CHANNEL, (event) => {
    const data = event.data as { type?: string };
    if (data?.type !== "release-rattle") return;
    void (async () => {
      if (rattleEnabled) {
        rattleEnabledCheckbox.checked = false;
        await handleRattleToggle();
      } else {
        closeMinecartInteraction();
      }
      status.textContent = "Crash hazard triggered — minecart rattle released.";
    })().catch((error) => console.error("Could not release minecart rattle for crash:", error));
  });
  rattleStrengthSlider.addEventListener("input", () => {
    rattleStrengthValue.textContent = rattleStrengthSlider.value;
    readControls();
  });
  rattleStartSpeedInput.addEventListener("change", readControls);
  floorYOffsetInput.addEventListener("change", () => {
    const oldValue = floorYOffset;
    readControls();
    if (activeFloor) activeFloor.y += floorYOffset - oldValue;
  });

  trackYOffsetInput.addEventListener("change", () => {
    const oldValue = trackYOffset;
    readControls();
    if (activeTrack) activeTrack.y += trackYOffset - oldValue;
  });
  foregroundYOffsetInput.addEventListener("change", () => {
    const oldValue = foregroundYOffset;
    readControls();
    if (activeForeground) activeForeground.y += foregroundYOffset - oldValue;
  });
  async function getSelectedImages(minimum: number): Promise<Image[] | null> {
    const selection = await OBR.player.getSelection();
    if (!selection || selection.length < minimum) {
      status.textContent = minimum === 1 ? "Select at least ONE image first." : "Select at least TWO images first.";
      return null;
    }
    const items = await OBR.scene.items.getItems(selection);
    const images = items.filter(isImage);
    if (images.length !== selection.length) {
      status.textContent = "Every selected item must be an image.";
      return null;
    }

    return images;
  }

  type AssignableKind = "floor" | "track" | "background" | "foreground" | "minecarts" | "brokenCart";
  function overlapsOtherLayers(ids: string[], excluded: AssignableKind): boolean {
    const otherIds = [
      ...(excluded === "floor" ? [] : floorIds),
      ...(excluded === "track" ? [] : trackIds),
      ...(excluded === "background" ? [] : backgroundIds),
      ...(excluded === "foreground" ? [] : foregroundIds),
      ...(excluded === "minecarts" ? [] : minecartIds),
      ...(excluded === "brokenCart" || !brokenCartId ? [] : [brokenCartId]),
    ];
    const others = new Set(otherIds);
    return ids.some((id) => others.has(id));
  }
  async function setLayer(kind: AssignableKind): Promise<void> {
    if (runState !== "stopped") {
      status.textContent = "Stop the chase before changing layers.";
      return;
    }

    const images = await getSelectedImages(kind === "minecarts" || kind === "brokenCart" ? 1 : 2);
    if (!images) return;
    if (kind === "brokenCart" && images.length !== 1) {
      status.textContent = "Select exactly ONE image to use as the Broken Cart.";
      return;
    }

    const ids = images.map((image) => image.id);
    if (overlapsOtherLayers(ids, kind)) {
      status.textContent = "Floor, scenery layers, and minecarts must use different images.";
      return;
    }
    if (kind === "floor") floorIds = ids;
    if (kind === "track") trackIds = ids;
    if (kind === "background") backgroundIds = ids;
    if (kind === "foreground") foregroundIds = ids;
    if (kind === "minecarts") minecartIds = ids;
    if (kind === "brokenCart") brokenCartId = ids[0] ?? null;

    updateLayerLabels();
    await OBR.player.deselect();
    status.textContent = `${kind[0].toUpperCase()}${kind.slice(1)} layer set.`;
  }
  setFloorButton.addEventListener("click", () => void setLayer("floor"));
  setTrackButton.addEventListener("click", () => void setLayer("track"));
  setBackgroundButton.addEventListener("click", () => void setLayer("background"));
  setForegroundButton.addEventListener("click", () => void setLayer("foreground"));
  setMinecartsButton.addEventListener("click", () => void setLayer("minecarts"));
  setBrokenCartButton.addEventListener("click", () => void setLayer("brokenCart"));

  async function setCrashTrackPosition(trackNumber: 1 | 2): Promise<void> {
    if (runState !== "stopped") {
      status.textContent = "Stop the chase before changing crash track positions.";
      return;
    }
    const images = await getSelectedImages(1);
    if (!images) return;
    if (images.length !== 1) {
      status.textContent = "Select exactly ONE cart or image centered on the track.";
      return;
    }

    const y = images[0].position.y;
    const otherY = trackNumber === 1 ? crashTrack2Y : crashTrack1Y;
    if (otherY !== null && Math.abs(y - otherY) < 1) {
      status.textContent = "Track 1 and Track 2 must use different vertical positions.";
      return;
    }

    if (trackNumber === 1) crashTrack1Y = y;
    else crashTrack2Y = y;
    updateLayerLabels();
    await OBR.player.deselect();
    status.textContent = `Crash Track ${trackNumber} position set at Y ${Math.round(y)}.`;
  }
  setCrashTrack1Button.addEventListener("click", () => void setCrashTrackPosition(1));
  setCrashTrack2Button.addEventListener("click", () => void setCrashTrackPosition(2));

  async function closeCrashWarningPopover(): Promise<void> {
    try {
      await OBR.popover.close(CRASH_POPOVER_ID);
    } catch {}
  }

  async function openCrashWarningPopover(): Promise<void> {
    if (!brokenCartId || minecartIds.length === 0 || runState !== "running") return;
    const [width, height] = await Promise.all([OBR.viewport.getWidth(), OBR.viewport.getHeight()]);
    await closeCrashWarningPopover();
    await OBR.popover.open({
      id: CRASH_POPOVER_ID,
      url: `${window.location.pathname}?crashWarning=1&v=0.5.3`,
      width: 64,
      height: 64,
      anchorReference: "POSITION",
      anchorPosition: { left: Math.max(72, width - 10), top: Math.max(82, height * 0.5) },
      anchorOrigin: { horizontal: "RIGHT", vertical: "CENTER" },
      transformOrigin: { horizontal: "RIGHT", vertical: "CENTER" },
      hidePaper: true,
      disableClickAway: true,
    });
  }

  async function armCrashHazard(): Promise<boolean> {
    if (
      !brokenCartId ||
      minecartIds.length === 0 ||
      !runtimeState ||
      crashTrack1Y === null ||
      crashTrack2Y === null ||
      Math.abs(crashTrack1Y - crashTrack2Y) < 1
    ) {
      await closeCrashWarningPopover();
      return false;
    }
    const shared = await OBR.scene.items.getItems([brokenCartId, ...minecartIds]);
    const byId = new Map(shared.filter(isImage).map((image) => [image.id, image] as const));
    const broken = byId.get(brokenCartId);
    const carts = minecartIds.map((id) => byId.get(id)).filter((image): image is Image => Boolean(image));
    if (!broken || carts.length === 0) return false;

    const state: CrashRuntimeState = {
      version: 2,
      chaseRevision: runtimeState.revision,
      brokenCartId,
      minecartIds: carts.map((cart) => cart.id),
      track1Y: crashTrack1Y,
      track2Y: crashTrack2Y,
      status: "armed",
      brokenHome: {
        id: broken.id,
        x: broken.position.x,
        y: broken.position.y,
        rotation: broken.rotation,
        visible: broken.visible,
      },
      cartHomes: carts.map((cart) => ({
        id: cart.id,
        x: cart.position.x,
        y: cart.position.y,
        rotation: cart.rotation,
        visible: cart.visible,
      })),
      crashedHomes: [],
      crashedTrack: null,
    };
    await OBR.scene.items.updateItems([broken.id], (items) => {
      for (const item of items) item.visible = false;
    });
    await writeCrashRuntime(state);
    await openCrashWarningPopover();
    return true;
  }

  async function restoreCrashHazard(restoreCarts: boolean): Promise<void> {
    await closeCrashWarningPopover();
    const crash = await readCrashRuntime();
    if (!crash) return;
    const homes = restoreCarts ? [crash.brokenHome, ...crash.cartHomes] : [crash.brokenHome];
    await OBR.scene.items.updateItems(homes.map((home) => home.id), (items) => {
      const homesById = new Map(homes.map((home) => [home.id, home] as const));
      for (const item of items) {
        const home = homesById.get(item.id);
        if (!home) continue;
        item.position.x = home.x;
        item.position.y = home.y;
        item.rotation = home.rotation;
        item.visible = home.visible;
      }
    });
    await writeCrashRuntime({
      ...crash,
      status: "complete",
      crashedHomes: [],
      crashedTrack: null,
    });
  }

  async function resetLastCrash(): Promise<void> {
    const crash = await readCrashRuntime();
    if (!crash || crash.crashedHomes.length === 0 || crash.crashedTrack === null) {
      resetCrashStatus.textContent = "No crashed carts to reset.";
      return;
    }
    if (crash.status === "running") {
      resetCrashStatus.textContent = "Crash is still running.";
      return;
    }

    await closeCrashWarningPopover();

    const trackY = crash.crashedTrack === 1 ? crash.track1Y : crash.track2Y;
    const resetHomes = crash.crashedHomes.map((home) => ({ ...home, y: trackY }));
    const resetIds = [...resetHomes.map((home) => home.id), crash.brokenHome.id];

    await OBR.scene.items.updateItems(resetIds, (items) => {
      const homesById = new Map(resetHomes.map((home) => [home.id, home] as const));
      for (const item of items) {
        if (item.id === crash.brokenHome.id) {
          item.position.x = crash.brokenHome.x;
          item.position.y = crash.brokenHome.y;
          item.rotation = crash.brokenHome.rotation;
          item.visible = runState === "running" ? false : crash.brokenHome.visible;
          continue;
        }
        const home = homesById.get(item.id);
        if (!home) continue;
        item.position.x = home.x;
        item.position.y = trackY;
        item.rotation = home.rotation;
        item.visible = home.visible;
      }
    });

    const nextStatus: CrashRuntimeState["status"] = runState === "running" ? "armed" : "complete";
    await writeCrashRuntime({
      ...crash,
      status: nextStatus,
      crashedHomes: [],
      crashedTrack: null,
    });

    if (runState === "running") {
      await openCrashWarningPopover();
      resetCrashStatus.textContent =
        `Reset ${resetHomes.length} cart${resetHomes.length === 1 ? "" : "s"} to Track ${crash.crashedTrack}. Hazard re-armed.`;
    } else {
      resetCrashStatus.textContent =
        `Reset ${resetHomes.length} cart${resetHomes.length === 1 ? "" : "s"} to Track ${crash.crashedTrack}.`;
    }
  }

  resetCrashedMinecartsButton.addEventListener("click", () => {
    void resetLastCrash().catch((error) => {
      console.error("Could not reset the last crash:", error);
      resetCrashStatus.textContent =
        error instanceof Error ? error.message : "Could not reset the last crash.";
    });
  });

  function makeSavedSettings(): SavedSettings {
    readControls();
    return {
      version: 5,
      floorIds: [...floorIds],
      trackIds: [...trackIds],
      backgroundIds: [...backgroundIds],
      foregroundIds: [...foregroundIds],
      minecartIds: [...minecartIds],
      brokenCartId,
      crashTrack1Y,
      crashTrack2Y,
      anchorX,
      anchorY,
      floorYOffset,
      trackYOffset,
      foregroundYOffset,
      floorOverlap,
      backgroundOverlap,
      foregroundOverlap,
      targetSpeed,
      acceleration,
      floorMultiplier,
      backgroundMultiplier,
      foregroundMultiplier,
      rattleEnabled,
      rattleStrength,
      rattleStartSpeed,
      focusOnStart: focusOnStartCheckbox.checked,
    };
  }
  function parseSavedSettings(raw: unknown): SavedSettings | null {
    if (!raw || typeof raw !== "object") return null;
    const value = raw as Partial<SavedSettings>;
    return {
      version: 5,
      floorIds: Array.isArray(value.floorIds) ? value.floorIds.filter((id): id is string => typeof id === "string") : [],
      trackIds: Array.isArray(value.trackIds) ? value.trackIds.filter((id): id is string => typeof id === "string") : [],
      backgroundIds: Array.isArray(value.backgroundIds) ? value.backgroundIds.filter((id): id is string => typeof id === "string") : [],
      foregroundIds: Array.isArray(value.foregroundIds) ? value.foregroundIds.filter((id): id is string => typeof id === "string") : [],
      minecartIds: Array.isArray(value.minecartIds) ? value.minecartIds.filter((id): id is string => typeof id === "string") : [],
      brokenCartId: typeof value.brokenCartId === "string" ? value.brokenCartId : null,
      crashTrack1Y: Number.isFinite(value.crashTrack1Y) ? Number(value.crashTrack1Y) : null,
      crashTrack2Y: Number.isFinite(value.crashTrack2Y) ? Number(value.crashTrack2Y) : null,
      anchorX: Number.isFinite(value.anchorX) ? Number(value.anchorX) : 0,
      anchorY: Number.isFinite(value.anchorY) ? Number(value.anchorY) : 0,
      floorYOffset: clampNumber(Number(value.floorYOffset), -10000, 10000, 0),
      trackYOffset: clampNumber(Number(value.trackYOffset), -10000, 10000, 0),
      foregroundYOffset: clampNumber(Number(value.foregroundYOffset), -10000, 10000, 0),
      floorOverlap: clampNumber(Number(value.floorOverlap), 0, 50, 0),
      backgroundOverlap: clampNumber(Number(value.backgroundOverlap), 0, 50, 0),
      foregroundOverlap: clampNumber(Number(value.foregroundOverlap), 0, 50, 0),
      targetSpeed: clampNumber(Number(value.targetSpeed), 0, MAX_INTERNAL_SPEED, 150),
      acceleration: clampNumber(Number(value.acceleration), 25, MAX_INTERNAL_ACCELERATION, 200),
      floorMultiplier: clampNumber(Number(value.floorMultiplier), 0, 1, 0.1),
      backgroundMultiplier: clampNumber(Number(value.backgroundMultiplier), 0, 1, 0.1),
      foregroundMultiplier: clampNumber(Number(value.foregroundMultiplier), 1, 2.5, 1.4),
      rattleEnabled: typeof value.rattleEnabled === "boolean" ? value.rattleEnabled : true,
      rattleStrength: clampNumber(Number(value.rattleStrength), 0, 2, 0.3),
      rattleStartSpeed: clampNumber(Number(value.rattleStartSpeed), 0, MAX_INTERNAL_SPEED, 100),
      focusOnStart: typeof value.focusOnStart === "boolean" ? value.focusOnStart : true,
    };
  }
  function applySavedSettings(saved: SavedSettings): void {
    floorIds = [...saved.floorIds];
    trackIds = [...saved.trackIds];
    backgroundIds = [...saved.backgroundIds];
    foregroundIds = [...saved.foregroundIds];
    minecartIds = [...saved.minecartIds];
    brokenCartId = saved.brokenCartId;
    crashTrack1Y = saved.crashTrack1Y;
    crashTrack2Y = saved.crashTrack2Y;
    anchorXInput.value = String(saved.anchorX);
    anchorYInput.value = String(saved.anchorY);
    floorYOffsetInput.value = String(saved.floorYOffset);
    trackYOffsetInput.value = String(saved.trackYOffset);
    foregroundYOffsetInput.value = String(saved.foregroundYOffset);
    floorOverlapInput.value = String(saved.floorOverlap);
    backgroundOverlapInput.value = String(saved.backgroundOverlap);
    foregroundOverlapInput.value = String(saved.foregroundOverlap);
    rattleEnabledCheckbox.checked = saved.rattleEnabled;
    rattleStrengthSlider.value = String(Math.round(saved.rattleStrength * 100));
    rattleStrengthValue.textContent = String(Math.round(saved.rattleStrength * 100));
    focusOnStartCheckbox.checked = saved.focusOnStart;
    applyTargetSpeed(saved.targetSpeed);
    applyAcceleration(saved.acceleration);
    rattleStartSpeed = saved.rattleStartSpeed;
    if (speedScaleReady) rattleStartSpeedInput.value = String(internalSpeedToFeetPerSecond(rattleStartSpeed));
    applyFloorMultiplier(saved.floorMultiplier * 100);
    applyBackgroundMultiplier(saved.backgroundMultiplier * 100);
    applyForegroundMultiplier(saved.foregroundMultiplier * 100);
    readControls();
    updateLayerLabels();
  }
  async function saveSettings(): Promise<void> {
    if (!(await OBR.scene.isReady())) {
      status.textContent = "Open a scene before saving settings.";
      return;
    }
    await OBR.scene.setMetadata({ [SETTINGS_KEY]: makeSavedSettings() });
    status.textContent = "Settings saved to this scene.";
  }
  async function loadSettings(silent = false): Promise<boolean> {
    if (!(await OBR.scene.isReady())) {
      if (!silent) status.textContent = "Open a scene before loading settings.";
      return false;
    }
    const metadata = await OBR.scene.getMetadata();
    const saved = parseSavedSettings(metadata[SETTINGS_KEY]);
    if (!saved) {
      if (!silent) status.textContent = "No saved Minecart Scroll settings in this scene yet.";
      return false;
    }
    applySavedSettings(saved);
    if (!silent) status.textContent = "Saved settings loaded.";
    return true;
  }
  saveButton.addEventListener("click", () => void saveSettings());
  loadButton.addEventListener("click", () => void loadSettings(false));
  async function goToAnchor(): Promise<void> {
    readControls();
    const screenPoint = await OBR.viewport.transformPoint({ x: anchorX, y: anchorY });
    const viewportWidth = await OBR.viewport.getWidth();
    const viewportHeight = await OBR.viewport.getHeight();
    const currentPosition = await OBR.viewport.getPosition();
    const currentScale = await OBR.viewport.getScale();
    await OBR.viewport.animateTo({
      position: {
        x: currentPosition.x + viewportWidth / 2 - screenPoint.x,
        y: currentPosition.y + viewportHeight / 2 - screenPoint.y,
      },
      scale: currentScale,
    });
  }

  goToAnchorButton.addEventListener("click", async () => {
    await goToAnchor();
    status.textContent = `Focused on anchor ${anchorX}, ${anchorY}.`;
  });
  async function getLayerImages(ids: string[], name: string, required: boolean): Promise<Image[]> {
    if (ids.length === 0 && !required) return [];
    if (ids.length < 2) throw new Error(`${name} needs at least two assigned images.`);

    const items = await OBR.scene.items.getItems(ids);
    const images = items.filter(isImage);
    if (images.length !== ids.length) throw new Error(`One or more ${name.toLowerCase()} images are missing.`);
    return images;
  }
  async function getMinecartImages(ids: string[]): Promise<Image[]> {
    if (ids.length === 0) return [];
    const items = await OBR.scene.items.getItems(ids);
    const images = items.filter(isImage);
    if (images.length !== ids.length) throw new Error("One or more minecart images are missing.");
    return images;
  }
  function seededUnit(value: string): number {
    let hash = 2166136261;
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0) / 4294967295;
  }
  function prepareMinecarts(images: Image[]): MinecartRattleGroup | null {
    if (images.length === 0) return null;
    const states = new Map<string, MinecartRattleState>();
    for (const image of images) {
      states.set(image.id, {
        baseX: image.position.x,
        baseY: image.position.y,
        phaseA: seededUnit(`${image.id}:phaseA`) * Math.PI * 2,
        phaseB: seededUnit(`${image.id}:phaseB`) * Math.PI * 2,
        frequencyA: 1.35 + seededUnit(`${image.id}:freqA`) * 0.8,
        frequencyB: 2.2 + seededUnit(`${image.id}:freqB`) * 0.9,
        amplitudeScale: 0.75 + seededUnit(`${image.id}:amp`) * 0.5,
        offsetY: 0,
      });
    }
    return { images, states };
  }
  async function prepareLayer(
    name: string,
    images: Image[],
    zBase: number,
    overlap: number,
    overridePosition?: { x: number; y: number },
  ): Promise<LoopLayer> {
    images.sort((a, b) => a.position.x - b.position.x);
    const first = images[0];
    const firstBounds = await OBR.scene.items.getItemBounds([first.id]);
    const displayedWidth = firstBounds.width;
    for (const image of images) {
      const bounds = await OBR.scene.items.getItemBounds([image.id]);
      if (Math.abs(bounds.width - displayedWidth) > 1) {
        throw new Error(`${name} images must have the same displayed width.`);
      }
    }
    const spacing = displayedWidth - overlap;
    const startX = overridePosition?.x ?? first.position.x;
    const startY = overridePosition?.y ?? first.position.y;
    const positions = new Map<string, number>();
    const order = new Map<string, number>();
    images.forEach((image, index) => order.set(image.id, index));
    await OBR.scene.items.updateItems(images, (items) => {
      for (const item of items) {
        const index = order.get(item.id);
        if (index === undefined) continue;
        const x = startX + index * spacing;
        item.position.x = x;
        item.position.y = startY;
        item.zIndex = zBase + index;
        item.disableAutoZIndex = true;
        positions.set(item.id, x);
      }
    });
    const refreshed = await OBR.scene.items.getItems(images.map((image) => image.id));
    const refreshedImages = refreshed.filter(isImage).sort((a, b) => a.position.x - b.position.x);
    positions.clear();
    refreshedImages.forEach((image, index) => positions.set(image.id, startX + index * spacing));
    return {
      name,
      images: refreshedImages,
      positions,
      startX,
      y: startY,
      spacing,
      highestZ: zBase + refreshedImages.length - 1,
      zQueue: Promise.resolve(),
    };
  }

  function moveLayer(layer: LoopLayer, deltaTime: number, multiplier: number): void {
    const layerSpeed = currentSpeed * multiplier;
    for (const image of layer.images) {
      const oldX = layer.positions.get(image.id) ?? layer.startX;
      layer.positions.set(image.id, oldX - layerSpeed * deltaTime);
    }

    let keepChecking = true;
    while (keepChecking) {
      keepChecking = false;
      let leftImage: Image | null = null;
      let leftX = Infinity;
      let rightX = -Infinity;
      for (const image of layer.images) {
        const x = layer.positions.get(image.id) ?? 0;
        if (x < leftX) {
          leftX = x;
          leftImage = image;
        }
        if (x > rightX) rightX = x;
      }

      if (leftImage && leftX <= layer.startX - layer.spacing) {
        layer.positions.set(leftImage.id, rightX + layer.spacing);
        layer.highestZ += 1;
        const recycledImage = leftImage;
        const newZ = layer.highestZ;
        layer.zQueue = layer.zQueue
          .then(async () => {
            await OBR.scene.items.updateItems([recycledImage], (items) => {
              if (items.length > 0) {
                items[0].zIndex = newZ;
                items[0].disableAutoZIndex = true;
              }
            });
          })
          .catch((error) => console.error(`${layer.name} z-index error:`, error));

        keepChecking = true;
      }
    }
  }
  function getActiveLayers(): LoopLayer[] {
    return [activeFloor, activeBackground, activeTrack, activeForeground].filter((layer): layer is LoopLayer => layer !== null);
  }

  function getActiveImages(): Image[] {
    return getActiveLayers().flatMap((layer) => layer.images);
  }
  function runtimeSpecForLayer(layer: LoopLayer, multiplier: number): RuntimeLayerSpec {
    return {
      name: layer.name as RuntimeLayerName,
      ids: layer.images.map((image) => image.id),
      startX: layer.startX,
      y: layer.y,
      spacing: layer.spacing,
      baseZ: Math.min(...layer.images.map((image) => image.zIndex)),
      multiplier,
      distanceOffset: 0,
    };
  }
  function buildRuntimeState(revision: number, motion: MotionSegment, state: RunState): RuntimeState {
    const layers: RuntimeLayerSpec[] = [];
    if (activeFloor) layers.push(runtimeSpecForLayer(activeFloor, floorMultiplier));
    if (activeBackground) layers.push(runtimeSpecForLayer(activeBackground, backgroundMultiplier));
    if (activeTrack) layers.push(runtimeSpecForLayer(activeTrack, 1));
    if (activeForeground) layers.push(runtimeSpecForLayer(activeForeground, foregroundMultiplier));
    return {
      version: 31,
      revision,
      runState: state,
      layers,
      motion,
    };
  }
  async function setSourceVisibility(visible: boolean): Promise<void> {
    const images = getActiveImages();
    if (images.length === 0) return;
    await OBR.scene.items.updateItems(images, (items) => {
      for (const item of items) item.visible = visible;
    });
  }
  async function commitRuntimeSources(
    runtime: RuntimeState,
    distance: number,
    visible: boolean,
    includeDistanceOffset = true,
  ): Promise<void> {
    for (const spec of runtime.layers) {
      const shared = await OBR.scene.items.getItems(spec.ids);
      const images = shared.filter(isImage);
      if (images.length !== spec.ids.length) continue;
      const indexById = new Map(spec.ids.map((id, index) => [id, index]));
      const xById = new Map<string, number>();
      for (let index = 0; index < spec.ids.length; index += 1) {
        xById.set(
          spec.ids[index],
          positionForDistance(
            spec.startX,
            spec.spacing,
            spec.ids.length,
            index,
            distance * spec.multiplier + (includeDistanceOffset ? spec.distanceOffset : 0),
          ),
        );
      }
      const ordered = [...spec.ids].sort((a, b) => (xById.get(a) ?? 0) - (xById.get(b) ?? 0));
      const zById = new Map(ordered.map((id, index) => [id, spec.baseZ + index]));
      await OBR.scene.items.updateItems(images, (items) => {
        for (const item of items) {
          const sourceIndex = indexById.get(item.id);
          if (sourceIndex === undefined) continue;
          item.position.x = xById.get(item.id) ?? item.position.x;
          item.position.y = spec.y;
          item.visible = visible;
          item.disableAutoZIndex = true;
          const z = zById.get(item.id);
          if (z !== undefined) item.zIndex = z;
        }
      });
    }
  }
  async function updateRuntimeMotionControls(): Promise<void> {
    if (!runtimeState || runtimeState.runState === "stopped") return;
    const now = Date.now();
    const snapshot =
      runtimeState.runState === "running"
        ? motionAt(runtimeState.motion, now)
        : { distance: runtimeState.motion.distanceAtSegmentStart, speed: 0 };
    runtimeState = {
      ...runtimeState,
      revision: runtimeState.revision + 1,
      motion: {
        segmentStartMs: now,
        distanceAtSegmentStart: snapshot.distance,
        speedAtSegmentStart: runtimeState.runState === "running" ? snapshot.speed : 0,
        targetSpeed,
        acceleration,
      },
    };
    await writeRuntimeState(runtimeState);
  }

  async function updateRuntimeLayerMultipliers(): Promise<void> {
    if (!runtimeState || runtimeState.runState === "stopped") return;

    const snapshot =
      runtimeState.runState === "running"
        ? motionAt(runtimeState.motion, Date.now())
        : { distance: runtimeState.motion.distanceAtSegmentStart, speed: 0 };

    const nextMultiplier: Record<RuntimeLayerName, number> = {
      Floor: floorMultiplier,
      Background: backgroundMultiplier,
      Track: 1,
      Foreground: foregroundMultiplier,
    };

    let changed = false;
    const nextLayers = runtimeState.layers.map((layer) => {
      const multiplier = nextMultiplier[layer.name];
      if (Math.abs(multiplier - layer.multiplier) < 0.000001) return layer;

      changed = true;
      const currentLayerDistance =
        snapshot.distance * layer.multiplier + layer.distanceOffset;

      return {
        ...layer,
        multiplier,
        distanceOffset: currentLayerDistance - snapshot.distance * multiplier,
      };
    });

    if (!changed) return;

    runtimeState = {
      ...runtimeState,
      revision: runtimeState.revision + 1,
      layers: nextLayers,
    };
    await writeRuntimeState(runtimeState);
  }
  function layerForItem(id: string): LoopLayer | null {
    for (const layer of getActiveLayers()) {
      if (layer.positions.has(id)) return layer;
    }
    return null;
  }

  async function commitPositions(): Promise<void> {
    const layers = getActiveLayers();
    if (layers.length === 0) return;
    await Promise.all(layers.map((layer) => layer.zQueue));
    const images = getActiveImages();
    await OBR.scene.items.updateItems(images, (items) => {
      for (const item of items) {
        const layer = layerForItem(item.id);
        if (layer) {
          const x = layer.positions.get(item.id);
          if (x !== undefined) item.position.x = x;
          item.position.y = layer.y;
          continue;
        }

      }
    });
  }
  async function resetMinecarts(): Promise<void> {
    if (!activeMinecarts) return;
    const images = activeMinecarts.images;
    const states = activeMinecarts.states;
    await OBR.scene.items.updateItems(images, (items) => {
      for (const item of items) {
        const cart = states.get(item.id);
        if (!cart) continue;
        cart.offsetY = 0;
        item.position.x = cart.baseX;
        item.position.y = cart.baseY;
      }
    });
  }
  async function rebaseMinecartsFromScene(): Promise<void> {
    if (!activeMinecarts) return;
    const ids = activeMinecarts.images.map((image) => image.id);
    const refreshed = await OBR.scene.items.getItems(ids);
    const refreshedImages = refreshed.filter(isImage);
    if (refreshedImages.length !== ids.length) {
      throw new Error("One or more minecart images disappeared from the scene.");
    }

    for (const image of refreshedImages) {
      const cart = activeMinecarts.states.get(image.id);
      if (!cart) continue;
      cart.baseX = image.position.x;
      cart.baseY = image.position.y;
      cart.offsetY = 0;
    }
    activeMinecarts.images = refreshedImages;
  }

  async function handleRattleToggle(): Promise<void> {
    const wasEnabled = rattleEnabled;
    readControls();
    if (wasEnabled === rattleEnabled || !activeMinecarts) return;

    clearMinecartDropTimer();
    draggedMinecartId = null;
    minecartRattleSuspended = false;
    lastMinecartRattleUpdateMs = 0;

    if (!rattleEnabled) {
      // If the chase is active, do one final settle write and then completely
      // release the minecart items. While OFF there are no position writes.
      closeMinecartInteraction();
      if (runState === "running") await resetMinecarts();
      status.textContent = "Rattle OFF — minecarts released for normal Owlbear movement.";
      return;
    }

    // Whatever positions the GM moved the carts to while OFF become the new
    // stable centers. This also works while paused, so Resume cannot snap carts
    // back to pre-move coordinates.
    await rebaseMinecartsFromScene();
    draggedMinecartId = [...selectedItemIds].find((id) => activeMinecarts?.states.has(id)) ?? null;
    minecartRattleSuspended = draggedMinecartId !== null;
    if (runState === "running") await openMinecartInteraction();
    status.textContent = draggedMinecartId
      ? "Rattle ON — current cart positions captured; selected cart remains released until deselected."
      : runState === "paused"
        ? "Rattle ON — current cart positions captured; rattle will resume from here when the chase resumes."
        : "Rattle ON — current cart positions captured as the new rattle centers.";
  }
  function clearMinecartDropTimer(): void {
    if (minecartDropTimer) window.clearTimeout(minecartDropTimer);
    minecartDropTimer = 0;
  }

  function clearMinecartRenewTimer(): void {
    if (minecartRenewTimer) window.clearTimeout(minecartRenewTimer);
    minecartRenewTimer = 0;
  }

  function closeMinecartInteraction(): void {
    clearMinecartRenewTimer();
    const stop = minecartInteractionStop;
    minecartInteractionUpdate = null;
    minecartInteractionStop = null;
    if (stop) {
      try {
        stop();
      } catch (error) {
        console.error("Could not stop minecart rattle interaction:", error);
      }
    }
  }

  async function createMinecartInteraction(): Promise<InteractionManager | null> {
    if (!activeMinecarts || runState !== "running" || !rattleEnabled) return null;

    const ids = activeMinecarts.images
      .map((image) => image.id)
      .filter((id) => id !== draggedMinecartId);
    if (ids.length === 0) return null;
    const refreshed = await OBR.scene.items.getItems(ids);
    const refreshedImages = refreshed.filter(isImage);
    if (refreshedImages.length !== ids.length) throw new Error("One or more minecart images disappeared from the scene.");

    for (const image of refreshedImages) {
      const cart = activeMinecarts.states.get(image.id);
      if (!cart) continue;
      image.position.x = cart.baseX;
      image.position.y = cart.baseY + cart.offsetY;
    }
    return OBR.interaction.startItemInteraction(refreshedImages);
  }

  function scheduleMinecartRenewal(delayMs: number): void {
    clearMinecartRenewTimer();
    if (runState !== "running" || !minecartInteractionUpdate) return;
    minecartRenewTimer = window.setTimeout(() => void renewMinecartInteraction(), delayMs);
  }
  async function renewMinecartInteraction(): Promise<void> {
    if (runState !== "running" || !minecartInteractionStop) return;
    const oldStop = minecartInteractionStop;
    let next: InteractionManager | null = null;
    try {
      next = await createMinecartInteraction();
      if (!next || runState !== "running") {
        next?.[1]();
        return;
      }
      minecartInteractionUpdate = next[0];
      minecartInteractionStop = next[1];
      try { oldStop(); } catch (error) {
        console.error("Could not retire previous minecart rattle interaction:", error);
      }
      scheduleMinecartRenewal(MINECART_RENEW_REPEAT_MS);
    } catch (error) {
      console.error("Minecart rattle renewal failed:", error);
      try { next?.[1](); } catch {}
      if (runState === "running") scheduleMinecartRenewal(3000);
    }
  }
  async function openMinecartInteraction(): Promise<void> {
    closeMinecartInteraction();
    const interaction = await createMinecartInteraction();
    if (!interaction) return;
    minecartInteractionUpdate = interaction[0];
    minecartInteractionStop = interaction[1];
    scheduleMinecartRenewal(MINECART_RENEW_FIRST_MS);
  }

  async function captureDroppedMinecart(id: string): Promise<void> {
    clearMinecartDropTimer();
    if (!activeMinecarts || draggedMinecartId !== id) return;
    try {
      const items = await OBR.scene.items.getItems([id]);
      const item = items.find((candidate) => candidate.id === id);
      const cart = activeMinecarts.states.get(id);
      if (!item || !cart || !isImage(item)) return;

      cart.baseX = item.position.x;
      cart.baseY = item.position.y;
      cart.offsetY = 0;
      lastObservedMinecartX = item.position.x;
      lastObservedMinecartY = item.position.y;
      draggedMinecartId = null;
      minecartRattleSuspended = false;
      if (runState === "running" && !renewing && rattleEnabled) await openMinecartInteraction();
    } catch (error) {
      console.error("Could not capture dropped minecart:", error);
    }
  }

  function scheduleMinecartDropCapture(id: string): void {
    clearMinecartDropTimer();
    minecartDropTimer = window.setTimeout(() => {
      void captureDroppedMinecart(id);
    }, MINECART_DROP_SETTLE_MS);
  }

  selectedItemIds = new Set((await OBR.player.getSelection()) ?? []);
  OBR.player.onChange((player) => {
    const nextSelection = new Set<string>(player.selection ?? []);
    if (activeMinecarts && runState === "running" && rattleEnabled) {
      for (const id of nextSelection) {
        if (!selectedItemIds.has(id) && activeMinecarts.states.has(id)) {
          draggedMinecartId = id;
          minecartRattleSuspended = true;
          clearMinecartDropTimer();
          closeMinecartInteraction();
          void openMinecartInteraction().catch((error) =>
            console.error("Could not keep other minecarts rattling:", error),
          );
          const cart = activeMinecarts.states.get(id)!;
          lastObservedMinecartX = cart.baseX;
          lastObservedMinecartY = cart.baseY;
          break;
        }
      }

      if (draggedMinecartId && selectedItemIds.has(draggedMinecartId) && !nextSelection.has(draggedMinecartId)) {
        scheduleMinecartDropCapture(draggedMinecartId);
      }
    }

    selectedItemIds = nextSelection;
  });
  OBR.scene.items.onChange((items) => {
    if (!activeMinecarts || !rattleEnabled || !minecartRattleSuspended || !draggedMinecartId) return;

    const item = items.find((candidate) => candidate.id === draggedMinecartId);
    if (!item || !isImage(item)) return;

    const moved =
      Math.abs(item.position.x - lastObservedMinecartX) >= 0.01 ||
      Math.abs(item.position.y - lastObservedMinecartY) >= 0.01;
    if (!moved) return;

    const cart = activeMinecarts.states.get(draggedMinecartId);
    if (!cart) return;
    // The rattle interaction is fully stopped while dragging, so any movement
    // here belongs to Owlbear's normal pointer drag. Keep the newest resting
    // point and wait briefly for movement to stop before restarting rattle.
    cart.baseX = item.position.x;
    cart.baseY = item.position.y;
    cart.offsetY = 0;
    lastObservedMinecartX = item.position.x;
    lastObservedMinecartY = item.position.y;
    scheduleMinecartDropCapture(draggedMinecartId);
  });
  function clearLayerRenewTimers(): void {
    for (const timer of layerRenewTimers.values()) window.clearTimeout(timer);
    layerRenewTimers.clear();
  }

  function closeLayerInteractions(): void {
    clearLayerRenewTimers();
    for (const interaction of layerInteractions.values()) {
      try {
        interaction[1]();
      } catch (error) {
        console.error("Could not stop a Minecart Scroll layer interaction:", error);
      }
    }
    layerInteractions.clear();
  }
  async function createLayerInteraction(layer: LoopLayer): Promise<InteractionManager> {
    const ids = layer.images.map((image) => image.id);
    const refreshed = await OBR.scene.items.getItems(ids);
    const refreshedImages = refreshed.filter(isImage);
    if (refreshedImages.length !== ids.length) throw new Error(`${layer.name} images disappeared from the scene.`);
    for (const image of refreshedImages) {
      const x = layer.positions.get(image.id);
      if (x !== undefined) image.position.x = x;
      image.position.y = layer.y;
    }

    return OBR.interaction.startItemInteraction(refreshedImages);
  }

  function scheduleLayerRenewal(layerName: string, delayMs: number): void {
    const existing = layerRenewTimers.get(layerName);
    if (existing !== undefined) window.clearTimeout(existing);
    if (runState !== "running") return;
    const timer = window.setTimeout(() => {
      layerRenewTimers.delete(layerName);
      void renewLayerInteraction(layerName);
    }, delayMs);
    layerRenewTimers.set(layerName, timer);
  }

  async function renewLayerInteraction(layerName: string): Promise<void> {
    if (runState !== "running") return;
    const layer = getActiveLayers().find((candidate) => candidate.name === layerName);
    const old = layerInteractions.get(layerName);
    if (!layer || !old) return;
    let next: InteractionManager | null = null;
    try {
      // Renew the whole layer as one synchronized unit. Tiles within a layer
      // always share the same interpolation clock, so recycling cannot create
      // gaps or overlaps during the network handoff.
      next = await createLayerInteraction(layer);
      if (runState !== "running") {
        next[1]();
        return;
      }
      layerInteractions.set(layerName, next);
      try { old[1](); } catch (error) {
        console.error(`Could not retire previous ${layerName} interaction:`, error);
      }
      scheduleLayerRenewal(layerName, LAYER_RENEW_REPEAT_MS);
    } catch (error) {
      console.error(`${layerName} interaction renewal failed:`, error);
      try { next?.[1](); } catch {}
      if (runState === "running") scheduleLayerRenewal(layerName, 3000);
    }
  }
  async function openLayerInteractions(): Promise<void> {
    closeLayerInteractions();
    for (const layer of getActiveLayers()) {
      const interaction = await createLayerInteraction(layer);
      layerInteractions.set(layer.name, interaction);
    }

    for (const layer of getActiveLayers()) {
      scheduleLayerRenewal(layer.name, LAYER_RENEW_FIRST_DELAY_MS[layer.name] ?? 22000);
    }
  }
  function cleanupInteractionForPageExit(): void {
    if (animationFrame) cancelAnimationFrame(animationFrame);
    animationFrame = 0;
    closeLayerInteractions();
    closeMinecartInteraction();
    clearMinecartDropTimer();
  }
  async function handlePanelVisibility(): Promise<void> {
    if (document.visibilityState === "hidden") {
      if (animationFrame) cancelAnimationFrame(animationFrame);
      animationFrame = 0;
      closeMinecartInteraction();
      if (rattleEnabled) await resetMinecarts();
      return;
    }
    if (runState === "running") {
      try {
        if (activeMinecarts && rattleEnabled) await openMinecartInteraction();
        lastTime = performance.now();
        lastMinecartRattleUpdateMs = 0;
        if (!animationFrame) animationFrame = requestAnimationFrame(animate);
      } catch (error) {
        console.error("Could not resume minecart rattle after reopening panel:", error);
      }
    }
  }
  window.addEventListener("pagehide", cleanupInteractionForPageExit);
  window.addEventListener("beforeunload", cleanupInteractionForPageExit);
  document.addEventListener("visibilitychange", () => void handlePanelVisibility());

  function approach(current: number, target: number, maxDelta: number): number {
    const difference = target - current;
    if (Math.abs(difference) <= maxDelta) return target;
    return current + Math.sign(difference) * maxDelta;
  }
  function updateMinecartRattle(timeSeconds: number): void {
    if (!activeMinecarts) return;
    if (!rattleEnabled || currentSpeed <= rattleStartSpeed || rattleStrength <= 0) {
      for (const cart of activeMinecarts.states.values()) cart.offsetY = 0;
      return;
    }
    const range = Math.max(1, MAX_INTERNAL_SPEED - rattleStartSpeed);
    const raw = clampNumber((currentSpeed - rattleStartSpeed) / range, 0, 1, 0);
    const intensity = raw * raw * (3 - 2 * raw);
    const amplitude = 8 * intensity * rattleStrength;
    const frequencyScale = 0.8 + raw * 1.1;
    for (const cart of activeMinecarts.states.values()) {
      const waveA = Math.sin(timeSeconds * cart.frequencyA * frequencyScale * Math.PI * 2 + cart.phaseA);
      const waveB = Math.sin(timeSeconds * cart.frequencyB * frequencyScale * Math.PI * 2 + cart.phaseB);
      cart.offsetY = amplitude * cart.amplitudeScale * (waveA * 0.78 + waveB * 0.22);
    }
  }

  function animate(time: number): void {
    if (runState !== "running") return;
    const snapshot = runtimeState
      ? motionAt(runtimeState.motion)
      : { distance: 0, speed: 0 };
    currentSpeed = snapshot.speed;
    currentSpeedValue.textContent = speedScaleReady ? formatFeetPerSecondFromInternal(currentSpeed) : "0.0";

    if (
      rattleEnabled &&
      minecartInteractionUpdate &&
      activeMinecarts &&
      (lastMinecartRattleUpdateMs === 0 || time - lastMinecartRattleUpdateMs >= MINECART_RATTLE_TICK_MS)
    ) {
      lastMinecartRattleUpdateMs = time;
      updateMinecartRattle(time / 1000);
      minecartInteractionUpdate((draft) => {
        const items = Array.isArray(draft) ? draft : [draft];
        for (const item of items) {
          if (item.id === draggedMinecartId) continue;
          const cart = activeMinecarts?.states.get(item.id);
          if (!cart) continue;
          item.position.x = cart.baseX;
          item.position.y = cart.baseY + cart.offsetY;
        }
      });
    }
    animationFrame = requestAnimationFrame(animate);
  }

  async function prepareChase(): Promise<void> {
    readControls();
    const floorImages = await getLayerImages(floorIds, "Floor", false);
    const trackImages = await getLayerImages(trackIds, "Track", true);
    const backgroundImages = await getLayerImages(backgroundIds, "Background", true);
    const foregroundImages = await getLayerImages(foregroundIds, "Foreground", false);
    const minecartImages = await getMinecartImages(minecartIds);
    const combined = [...floorImages, ...trackImages, ...backgroundImages, ...foregroundImages];
    const baseZ = Math.min(...combined.map((image) => image.zIndex));
    const sortedBackground = [...backgroundImages].sort((a, b) => a.position.x - b.position.x);
    const firstBackground = sortedBackground[0];
    const backgroundBounds = await OBR.scene.items.getItemBounds([firstBackground.id]);
    const backgroundOverride = {
      x: firstBackground.position.x + (anchorX - backgroundBounds.center.x),
      y: firstBackground.position.y + (anchorY - backgroundBounds.center.y),
    };
    activeBackground = await prepareLayer("Background", backgroundImages, baseZ, backgroundOverlap, backgroundOverride);

    const currentBackgroundBounds = await OBR.scene.items.getItemBounds([activeBackground.images[0].id]);
    activeFloor = null;
    if (floorImages.length >= 2) {
      const sortedFloor = [...floorImages].sort((a, b) => a.position.x - b.position.x);
      const firstFloor = sortedFloor[0];
      const floorBounds = await OBR.scene.items.getItemBounds([firstFloor.id]);
      const floorOverride = {
        x: firstFloor.position.x + (currentBackgroundBounds.center.x - floorBounds.center.x),
        y: firstFloor.position.y + (currentBackgroundBounds.center.y - floorBounds.center.y) + floorYOffset,
      };
      activeFloor = await prepareLayer("Floor", floorImages, baseZ - FLOOR_Z_GAP, floorOverlap, floorOverride);
    }
    const sortedTrack = [...trackImages].sort((a, b) => a.position.x - b.position.x);
    const firstTrack = sortedTrack[0];
    const trackBounds = await OBR.scene.items.getItemBounds([firstTrack.id]);
    const trackOverride = {
      x: firstTrack.position.x + (currentBackgroundBounds.center.x - trackBounds.center.x),
      y: firstTrack.position.y + (currentBackgroundBounds.center.y - trackBounds.center.y) + trackYOffset,
    };
    activeTrack = await prepareLayer("Track", trackImages, baseZ + TRACK_Z_GAP, TRACK_OVERLAP, trackOverride);
    activeForeground = null;
    if (foregroundImages.length >= 2) {
      const sortedForeground = [...foregroundImages].sort((a, b) => a.position.x - b.position.x);
      const firstForeground = sortedForeground[0];
      const foregroundBounds = await OBR.scene.items.getItemBounds([firstForeground.id]);
      const foregroundOverride = {
        x: firstForeground.position.x + (currentBackgroundBounds.center.x - foregroundBounds.center.x),
        y: firstForeground.position.y + (currentBackgroundBounds.center.y - foregroundBounds.center.y) + foregroundYOffset,
      };
      activeForeground = await prepareLayer(
        "Foreground",
        foregroundImages,
        baseZ + FOREGROUND_Z_GAP,
        foregroundOverlap,
        foregroundOverride,
      );
    }

    activeMinecarts = prepareMinecarts(minecartImages);
  }

  startButton.addEventListener("click", async () => {
    if (runState !== "stopped" || renewing) return;
    if (!(await OBR.scene.isReady())) {
      status.textContent = "Open a scene first.";
      return;
    }
    const rendererHealthState = await readBackgroundHealth();
    if (!rendererHealthState || Date.now() - rendererHealthState.atMs >= 2500) {
      status.textContent = "Background renderer is OFFLINE. The hidden background page is not running, so Start was cancelled safely.";
      return;
    }

    try {
      status.textContent = "Preparing background interaction chase...";
      await prepareChase();
      await OBR.player.deselect();
      if (focusOnStartCheckbox.checked) await goToAnchor();
      const previous = await readRuntimeState();
      const now = Date.now();
      runtimeState = buildRuntimeState(
        (previous?.revision ?? 0) + 1,
        {
          segmentStartMs: now,
          distanceAtSegmentStart: 0,
          speedAtSegmentStart: 0,
          targetSpeed,
          acceleration,
        },
        "running",
      );
      // Publish the chase clock first while the shared scenery remains visible.
      // The background renderer must explicitly report a successful moving frame
      // before we hide the originals. This makes startup failure non-destructive.
      await writeRuntimeState(runtimeState);
      const expectedRevision = runtimeState.revision;
      const deadline = Date.now() + 3500;
      let diagnostic: RendererDiagnostic | null = null;
      while (Date.now() < deadline) {
        diagnostic = await readRendererDiagnostic();
        if (diagnostic?.revision === expectedRevision) {
          if (diagnostic.stage === "error") {
            throw new Error(`Background interaction renderer error: ${diagnostic.message}`);
          }
          if (diagnostic.stage === "moving") break;
          status.textContent = `Starting renderer: ${diagnostic.stage} (${diagnostic.itemCount} items)...`;
        }
        await new Promise<void>((resolve) => window.setTimeout(resolve, 100));
      }
      if (diagnostic?.revision !== expectedRevision || diagnostic.stage !== "moving") {
        const stage = diagnostic?.revision === expectedRevision ? diagnostic.stage : "no response";
        throw new Error(
          `Background interaction renderer did not reach moving state (last stage: ${stage}). Shared scenery was left visible.`,
        );
      }

      // The renderer is interacting with the real shared scene items, so they remain visible.
      currentSpeed = 0;
      currentSpeedValue.textContent = "0.0";
      runState = "running";
      if (rattleEnabled) await openMinecartInteraction();
      lastTime = performance.now();
      lastMinecartRattleUpdateMs = 0;
      animationFrame = requestAnimationFrame(animate);
      updateRunButtons();
      let crashArmed = false;
      try {
        crashArmed = await armCrashHazard();
      } catch (error) {
        console.error("Could not arm the broken-cart crash hazard:", error);
        await closeCrashWarningPopover();
      }
      const extras = [
        activeFloor ? "floor" : "",
        activeForeground ? "foreground" : "",
        activeMinecarts && rattleEnabled ? "minecart rattle" : "",
        crashArmed ? "broken-cart hazard" : "",
      ].filter(Boolean);
      status.textContent =
        extras.length > 0
          ? `Background interaction chase running with ${extras.join(", ")}.`
          : "Background interaction parallax chase running!";
      if (brokenCartId && (!crashArmed) && (crashTrack1Y === null || crashTrack2Y === null)) {
        status.textContent += " Broken-cart hazard needs Track 1 and Track 2 positions before it can arm.";
      }
    } catch (error) {
      if (runtimeState) {
        try {
          runtimeState = {
            ...runtimeState,
            revision: runtimeState.revision + 1,
            runState: "stopped",
            motion: {
              ...runtimeState.motion,
              segmentStartMs: Date.now(),
              speedAtSegmentStart: 0,
            },
          };
          await writeRuntimeState(runtimeState);
        } catch {}
      }
      try {
        // Shared scenery should remain visible in this architecture; force visibility as a safety net.
        await setSourceVisibility(true);
      } catch (restoreError) {
        console.error("Could not restore shared scenery after startup failure:", restoreError);
      }
      status.textContent = error instanceof Error ? error.message : "Could not start the chase.";
      closeMinecartInteraction();
      clearMinecartDropTimer();
      draggedMinecartId = null;
      minecartRattleSuspended = false;
      activeFloor = null;
      activeTrack = null;
      activeBackground = null;
      activeForeground = null;
      activeMinecarts = null;
      runtimeState = null;
      runState = "stopped";
      updateRunButtons();
    }
  });
  pauseButton.addEventListener("click", async () => {
    if (runState !== "running" || renewing || !runtimeState) return;
    if (animationFrame) cancelAnimationFrame(animationFrame);
    animationFrame = 0;
    await closeCrashWarningPopover();
    const now = Date.now();
    const snapshot = motionAt(runtimeState.motion, now);
    runtimeState = {
      ...runtimeState,
      revision: runtimeState.revision + 1,
      runState: "paused",
      motion: {
        ...runtimeState.motion,
        segmentStartMs: now,
        distanceAtSegmentStart: snapshot.distance,
        speedAtSegmentStart: 0,
      },
    };
    await writeRuntimeState(runtimeState);
    closeMinecartInteraction();
    if (rattleEnabled) await resetMinecarts();
    currentSpeed = 0;
    currentSpeedValue.textContent = "0.0";
    runState = "paused";
    updateRunButtons();
    status.textContent = "Paused — local scenery positions preserved.";
  });
  resumeButton.addEventListener("click", async () => {
    if (runState !== "paused" || renewing || !runtimeState) return;
    try {
      const now = Date.now();
      runtimeState = {
        ...runtimeState,
        revision: runtimeState.revision + 1,
        runState: "running",
        motion: {
          ...runtimeState.motion,
          segmentStartMs: now,
          speedAtSegmentStart: 0,
          targetSpeed,
          acceleration,
        },
      };
      await writeRuntimeState(runtimeState);
      currentSpeed = 0;
      currentSpeedValue.textContent = "0.0";
      runState = "running";
      if (rattleEnabled) await openMinecartInteraction();
      lastTime = performance.now();
      lastMinecartRattleUpdateMs = 0;
      animationFrame = requestAnimationFrame(animate);
      updateRunButtons();
      const crash = await readCrashRuntime();
      if (crash?.status === "armed") await openCrashWarningPopover();
      status.textContent = "Resumed — local renderer accelerating back to target speed.";
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : "Could not resume the chase.";
    }
  });
  stopButton.addEventListener("click", async () => {
    if (runState === "stopped" || renewing || !runtimeState) return;
    if (animationFrame) cancelAnimationFrame(animationFrame);
    animationFrame = 0;
    await closeCrashWarningPopover();
    const crashBeforeStop = await readCrashRuntime();
    if (crashBeforeStop?.status === "armed") await restoreCrashHazard(false);

    const now = Date.now();
    const snapshot =
      runtimeState.runState === "running"
        ? motionAt(runtimeState.motion, now)
        : { distance: runtimeState.motion.distanceAtSegmentStart, speed: 0 };
    closeMinecartInteraction();
    clearMinecartDropTimer();
    draggedMinecartId = null;
    minecartRattleSuspended = false;
    if (rattleEnabled) await resetMinecarts();
    // Restore the shared scenery exactly where the local renderer finished.
    await commitRuntimeSources(runtimeState, snapshot.distance, true);
    runtimeState = {
      ...runtimeState,
      revision: runtimeState.revision + 1,
      runState: "stopped",
      motion: {
        ...runtimeState.motion,
        segmentStartMs: now,
        distanceAtSegmentStart: snapshot.distance,
        speedAtSegmentStart: 0,
      },
    };
    await writeRuntimeState(runtimeState);
    currentSpeed = 0;
    currentSpeedValue.textContent = "0.0";
    activeFloor = null;
    activeTrack = null;
    activeBackground = null;
    activeForeground = null;
    activeMinecarts = null;
    runState = "stopped";
    updateRunButtons();
    status.textContent = "Stopped. Shared scenery restored at the final chase position.";
  });
  emergencyResetButton.addEventListener("click", async () => {
    if (animationFrame) cancelAnimationFrame(animationFrame);
    animationFrame = 0;
    await restoreCrashHazard(true);
    closeLayerInteractions();
    closeMinecartInteraction();
    clearMinecartDropTimer();
    draggedMinecartId = null;
    minecartRattleSuspended = false;
    if (rattleEnabled) await resetMinecarts();
    const runtime = runtimeState ?? (await readRuntimeState());
    if (runtime) {
      await commitRuntimeSources(runtime, 0, true, false);
      runtimeState = {
        ...runtime,
        revision: runtime.revision + 1,
        runState: "stopped",
        motion: {
          ...runtime.motion,
          segmentStartMs: Date.now(),
          distanceAtSegmentStart: 0,
          speedAtSegmentStart: 0,
        },
      };
      await writeRuntimeState(runtimeState);
    } else {
      try {
        await setSourceVisibility(true);
      } catch {}
    }
    renewing = false;
    currentSpeed = 0;
    currentSpeedValue.textContent = "0.0";
    activeFloor = null;
    activeTrack = null;
    activeBackground = null;
    activeForeground = null;
    activeMinecarts = null;
    runState = "stopped";
    updateRunButtons();
    status.textContent = "Emergency reset complete. Shared scenery restored to chase start.";
  });
  updateLayerLabels();
  updateRunButtons();
  await refreshSceneSpeedScale();
  OBR.scene.grid.onChange(() => void refreshSceneSpeedScale());
  await loadSettings(true);
  renderSpeedControls();
  runtimeState = await readRuntimeState();
  if (runtimeState && runtimeState.runState !== "stopped") {
    runState = runtimeState.runState;
    try {
      const minecartImages = await getMinecartImages(minecartIds);
      activeMinecarts = prepareMinecarts(minecartImages);
      if (runState === "running") {
        if (activeMinecarts && rattleEnabled) await openMinecartInteraction();
        const crash = await readCrashRuntime();
        if (crash?.status === "armed") await openCrashWarningPopover();
        lastTime = performance.now();
        lastMinecartRattleUpdateMs = 0;
        animationFrame = requestAnimationFrame(animate);
      }
    } catch (error) {
      console.error("Could not restore minecart rattle state:", error);
    }
  }
  OBR.scene.onMetadataChange((metadata) => {
    const next = parseRuntime(metadata[RUNTIME_KEY]);
    if (!next) return;
    runtimeState = next;
    runState = next.runState;
    updateRunButtons();
  });
  // These legacy helpers are intentionally retained for the frozen 0.2.x rollback
  // path, but v0.3.x scenery rendering no longer calls them directly. Keep an
  // explicit reference so projects with TypeScript noUnusedLocals enabled compile.
  void lastTime;
  void moveLayer;
  void commitPositions;
  void openLayerInteractions;
  void approach;

  updateRunButtons();
});
}
