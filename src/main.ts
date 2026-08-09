import OBR, { buildImage, isImage, type Image, type Metadata } from "@owlbear-rodeo/sdk";

const SETTINGS_KEY = "com.supercalfrag.minecart-scroll/settings";
const RUNTIME_KEY = "com.supercalfrag.minecart-scroll/runtime";
const LOCAL_CLONE_KEY = "com.supercalfrag.minecart-scroll/local-source-id";
const CONTROL_CHANNEL = "com.supercalfrag.minecart-scroll/control";
const STATUS_CHANNEL = "com.supercalfrag.minecart-scroll/status";

const TRACK_OVERLAP = 2;
const TRACK_Z_GAP = 100000;
const FOREGROUND_Z_GAP = 200000;
const LOCAL_TICK_MS = 20; // 50fps target. Absolute-time motion prevents cumulative drift.

type RunState = "stopped" | "running" | "paused";
type LayerKind = "background" | "track" | "foreground";

type SavedSettings = {
  version: 3;
  trackIds: string[];
  backgroundIds: string[];
  foregroundIds: string[];
  anchorX: number;
  anchorY: number;
  trackYOffset: number;
  foregroundYOffset: number;
  backgroundOverlap: number;
  foregroundOverlap: number;
  targetSpeed: number;
  acceleration: number;
  backgroundMultiplier: number;
  foregroundMultiplier: number;
  focusOnStart: boolean;
};

type MotionSegment = {
  segmentStartMs: number;
  distanceAtSegmentStart: number;
  speedAtSegmentStart: number;
  targetSpeed: number;
  acceleration: number;
};

type RuntimeState = {
  version: 3;
  revision: number;
  runState: RunState;
  controllerId: string;
  trackIds: string[];
  backgroundIds: string[];
  foregroundIds: string[];
  backgroundMultiplier: number;
  foregroundMultiplier: number;
  motion: MotionSegment;
};

type ControlCommand =
  | { type: "START"; settings: SavedSettings }
  | { type: "PAUSE" }
  | { type: "RESUME" }
  | { type: "STOP" }
  | { type: "SET_TARGET_SPEED"; value: number }
  | { type: "SET_ACCELERATION"; value: number };

type StatusMessage = {
  ok: boolean;
  message: string;
};

type LocalLayer = {
  kind: LayerKind;
  sourceIds: string[];
  clones: Image[];
  startX: number;
  y: number;
  spacing: number;
  baseZ: number;
  multiplier: number;
  lastOrderSignature: string;
  zQueue: Promise<void>;
};

type MotionSnapshot = {
  distance: number;
  speed: number;
};

function clampNumber(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}

function mod(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor;
}

function motionAt(segment: MotionSegment, nowMs = Date.now()): MotionSnapshot {
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
  const cruiseDistance = target * (elapsed - timeToTarget);
  return {
    distance: segment.distanceAtSegmentStart + accelDistance + cruiseDistance,
    speed: target,
  };
}

function parseSavedSettings(raw: unknown): SavedSettings | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Partial<SavedSettings>;
  return {
    version: 3,
    trackIds: Array.isArray(value.trackIds) ? value.trackIds.filter((id): id is string => typeof id === "string") : [],
    backgroundIds: Array.isArray(value.backgroundIds)
      ? value.backgroundIds.filter((id): id is string => typeof id === "string")
      : [],
    foregroundIds: Array.isArray(value.foregroundIds)
      ? value.foregroundIds.filter((id): id is string => typeof id === "string")
      : [],
    anchorX: Number.isFinite(value.anchorX) ? Number(value.anchorX) : 0,
    anchorY: Number.isFinite(value.anchorY) ? Number(value.anchorY) : 0,
    trackYOffset: clampNumber(Number(value.trackYOffset), -10000, 10000, 0),
    foregroundYOffset: clampNumber(Number(value.foregroundYOffset), -10000, 10000, 0),
    backgroundOverlap: clampNumber(Number(value.backgroundOverlap), 0, 50, 0),
    foregroundOverlap: clampNumber(Number(value.foregroundOverlap), 0, 50, 0),
    targetSpeed: clampNumber(Number(value.targetSpeed), 0, 750, 150),
    acceleration: clampNumber(Number(value.acceleration), 25, 1000, 200),
    backgroundMultiplier: clampNumber(Number(value.backgroundMultiplier), 0, 1, 0.4),
    foregroundMultiplier: clampNumber(Number(value.foregroundMultiplier), 1, 2.5, 1.4),
    focusOnStart: typeof value.focusOnStart === "boolean" ? value.focusOnStart : true,
  };
}

function parseRuntime(raw: unknown): RuntimeState | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Partial<RuntimeState>;
  if (value.version !== 3 || typeof value.revision !== "number" || typeof value.runState !== "string") return null;
  if (!value.motion || typeof value.motion !== "object") return null;
  const motion = value.motion as Partial<MotionSegment>;
  return {
    version: 3,
    revision: value.revision,
    runState: value.runState === "running" || value.runState === "paused" ? value.runState : "stopped",
    controllerId: typeof value.controllerId === "string" ? value.controllerId : "",
    trackIds: Array.isArray(value.trackIds) ? value.trackIds.filter((id): id is string => typeof id === "string") : [],
    backgroundIds: Array.isArray(value.backgroundIds)
      ? value.backgroundIds.filter((id): id is string => typeof id === "string")
      : [],
    foregroundIds: Array.isArray(value.foregroundIds)
      ? value.foregroundIds.filter((id): id is string => typeof id === "string")
      : [],
    backgroundMultiplier: clampNumber(Number(value.backgroundMultiplier), 0, 1, 0.4),
    foregroundMultiplier: clampNumber(Number(value.foregroundMultiplier), 1, 2.5, 1.4),
    motion: {
      segmentStartMs: Number.isFinite(motion.segmentStartMs) ? Number(motion.segmentStartMs) : Date.now(),
      distanceAtSegmentStart: Number.isFinite(motion.distanceAtSegmentStart) ? Number(motion.distanceAtSegmentStart) : 0,
      speedAtSegmentStart: clampNumber(Number(motion.speedAtSegmentStart), 0, 750, 0),
      targetSpeed: clampNumber(Number(motion.targetSpeed), 0, 750, 150),
      acceleration: clampNumber(Number(motion.acceleration), 25, 1000, 200),
    },
  };
}

async function readRuntime(): Promise<RuntimeState | null> {
  if (!(await OBR.scene.isReady())) return null;
  const metadata = await OBR.scene.getMetadata();
  return parseRuntime(metadata[RUNTIME_KEY]);
}

async function writeRuntime(runtime: RuntimeState): Promise<void> {
  await OBR.scene.setMetadata({ [RUNTIME_KEY]: runtime });
}

async function sendStatus(ok: boolean, message: string): Promise<void> {
  await OBR.broadcast.sendMessage(STATUS_CHANNEL, { ok, message } satisfies StatusMessage, { destination: "LOCAL" });
}

function sourceMetadata(sourceId: string): Metadata {
  return { [LOCAL_CLONE_KEY]: sourceId };
}

async function cleanupLocalClones(): Promise<void> {
  const existing = await OBR.scene.local.getItems((item) => typeof item.metadata?.[LOCAL_CLONE_KEY] === "string");
  if (existing.length > 0) {
    await OBR.scene.local.deleteItems(existing.map((item) => item.id));
  }
}

function cloneImageForLocal(source: Image): Image {
  return buildImage(source.image, source.grid)
    .name(`Minecart Scroll: ${source.name || "scenery"}`)
    .position({ ...source.position })
    .rotation(source.rotation)
    .scale({ ...source.scale })
    .layer(source.layer)
    .zIndex(source.zIndex)
    .visible(true)
    .locked(true)
    .disableHit(true)
    .disableAutoZIndex(true)
    .metadata(sourceMetadata(source.id))
    .build();
}

async function getSourceImages(ids: string[], name: string, required: boolean): Promise<Image[]> {
  if (ids.length === 0 && !required) return [];
  if (ids.length < 2) throw new Error(`${name} needs at least two assigned images.`);
  const items = await OBR.scene.items.getItems(ids);
  const images = items.filter(isImage);
  if (images.length !== ids.length) throw new Error(`One or more ${name.toLowerCase()} images are missing.`);
  return images;
}

async function arrangeSourceLayer(
  name: string,
  images: Image[],
  zBase: number,
  overlap: number,
  overridePosition?: { x: number; y: number },
): Promise<Image[]> {
  const sorted = [...images].sort((a, b) => a.position.x - b.position.x);
  const first = sorted[0];
  const firstBounds = await OBR.scene.items.getItemBounds([first.id]);
  const displayedWidth = firstBounds.width;

  for (const image of sorted) {
    const bounds = await OBR.scene.items.getItemBounds([image.id]);
    if (Math.abs(bounds.width - displayedWidth) > 1) {
      throw new Error(`${name} images must have the same displayed width.`);
    }
  }

  const spacing = displayedWidth - overlap;
  const startX = overridePosition?.x ?? first.position.x;
  const startY = overridePosition?.y ?? first.position.y;
  const order = new Map(sorted.map((image, index) => [image.id, index]));

  await OBR.scene.items.updateItems(sorted, (items) => {
    for (const item of items) {
      const index = order.get(item.id);
      if (index === undefined) continue;
      item.position.x = startX + index * spacing;
      item.position.y = startY;
      item.zIndex = zBase + index;
      item.disableAutoZIndex = true;
      item.visible = false;
    }
  });

  const refreshed = await OBR.scene.items.getItems(sorted.map((image) => image.id));
  return refreshed.filter(isImage).sort((a, b) => a.position.x - b.position.x);
}

async function prepareSources(settings: SavedSettings): Promise<void> {
  const track = await getSourceImages(settings.trackIds, "Track", true);
  const background = await getSourceImages(settings.backgroundIds, "Background", true);
  const foreground = await getSourceImages(settings.foregroundIds, "Foreground", false);
  const combined = [...track, ...background, ...foreground];
  const baseZ = Math.min(...combined.map((image) => image.zIndex));

  // Make sure source items can be measured even after a previous interrupted run.
  await OBR.scene.items.updateItems(combined, (items) => {
    for (const item of items) item.visible = true;
  });

  const sortedBackground = [...background].sort((a, b) => a.position.x - b.position.x);
  const firstBackground = sortedBackground[0];
  const backgroundBounds = await OBR.scene.items.getItemBounds([firstBackground.id]);
  const backgroundOverride = {
    x: firstBackground.position.x + (settings.anchorX - backgroundBounds.center.x),
    y: firstBackground.position.y + (settings.anchorY - backgroundBounds.center.y),
  };

  const preparedBackground = await arrangeSourceLayer(
    "Background",
    background,
    baseZ,
    settings.backgroundOverlap,
    backgroundOverride,
  );

  // Temporarily reveal the first prepared background only while measuring its actual centered bounds.
  await OBR.scene.items.updateItems([preparedBackground[0]], (items) => {
    if (items[0]) items[0].visible = true;
  });
  const currentBackgroundBounds = await OBR.scene.items.getItemBounds([preparedBackground[0].id]);
  await OBR.scene.items.updateItems([preparedBackground[0]], (items) => {
    if (items[0]) items[0].visible = false;
  });

  const sortedTrack = [...track].sort((a, b) => a.position.x - b.position.x);
  const firstTrack = sortedTrack[0];
  const trackBounds = await OBR.scene.items.getItemBounds([firstTrack.id]);
  const trackOverride = {
    x: firstTrack.position.x + (currentBackgroundBounds.center.x - trackBounds.center.x),
    y: firstTrack.position.y + (currentBackgroundBounds.center.y - trackBounds.center.y) + settings.trackYOffset,
  };
  await arrangeSourceLayer("Track", track, baseZ + TRACK_Z_GAP, TRACK_OVERLAP, trackOverride);

  if (foreground.length >= 2) {
    const sortedForeground = [...foreground].sort((a, b) => a.position.x - b.position.x);
    const firstForeground = sortedForeground[0];
    const foregroundBounds = await OBR.scene.items.getItemBounds([firstForeground.id]);
    const foregroundOverride = {
      x: firstForeground.position.x + (currentBackgroundBounds.center.x - foregroundBounds.center.x),
      y:
        firstForeground.position.y +
        (currentBackgroundBounds.center.y - foregroundBounds.center.y) +
        settings.foregroundYOffset,
    };
    await arrangeSourceLayer(
      "Foreground",
      foreground,
      baseZ + FOREGROUND_Z_GAP,
      settings.foregroundOverlap,
      foregroundOverride,
    );
  }
}

function positionForDistance(startX: number, spacing: number, count: number, index: number, distance: number): number {
  const raw = startX + index * spacing - distance;
  const minX = startX - spacing;
  const span = spacing * count;
  return minX + mod(raw - minX, span);
}

async function commitSourcesAtDistance(runtime: RuntimeState, distance: number): Promise<void> {
  const layerSpecs: Array<{ ids: string[]; multiplier: number }> = [
    { ids: runtime.backgroundIds, multiplier: runtime.backgroundMultiplier },
    { ids: runtime.trackIds, multiplier: 1 },
    { ids: runtime.foregroundIds, multiplier: runtime.foregroundMultiplier },
  ];

  for (const spec of layerSpecs) {
    if (spec.ids.length < 2) continue;
    const items = await OBR.scene.items.getItems(spec.ids);
    const images = items.filter(isImage).sort((a, b) => a.position.x - b.position.x);
    if (images.length < 2) continue;
    const bounds = await OBR.scene.items.getItemBounds([images[0].id]);
    // Recover spacing from the prepared scene positions when possible. This avoids needing overlap in runtime.
    const spacing = images.length > 1 ? Math.abs(images[1].position.x - images[0].position.x) : bounds.width;
    const startX = images[0].position.x;
    const y = images[0].position.y;
    const positions = images.map((_, index) => positionForDistance(startX, spacing, images.length, index, distance * spec.multiplier));
    const ordered = images.map((image, index) => ({ id: image.id, x: positions[index] })).sort((a, b) => a.x - b.x);
    const zById = new Map(ordered.map((entry, index) => [entry.id, images[0].zIndex + index]));

    await OBR.scene.items.updateItems(images, (draft) => {
      for (let index = 0; index < draft.length; index += 1) {
        const item = draft[index];
        const sourceIndex = images.findIndex((image) => image.id === item.id);
        if (sourceIndex < 0) continue;
        item.position.x = positions[sourceIndex];
        item.position.y = y;
        item.visible = true;
        item.disableAutoZIndex = true;
        const z = zById.get(item.id);
        if (z !== undefined) item.zIndex = z;
      }
    });
  }
}

async function runControllerBackground(): Promise<void> {
  const role = await OBR.player.getRole();
  if (role !== "GM") return;

  OBR.broadcast.onMessage(CONTROL_CHANNEL, (event) => {
    void (async () => {
      const command = event.data as ControlCommand;
      try {
        if (!(await OBR.scene.isReady())) throw new Error("Open a scene first.");
        const current = await readRuntime();

        if (command.type === "START") {
          const settings = parseSavedSettings(command.settings);
          if (!settings) throw new Error("Invalid chase settings.");
          await prepareSources(settings);
          const revision = (current?.revision ?? 0) + 1;
          const now = Date.now();
          const runtime: RuntimeState = {
            version: 3,
            revision,
            runState: "running",
            controllerId: OBR.player.id,
            trackIds: [...settings.trackIds],
            backgroundIds: [...settings.backgroundIds],
            foregroundIds: [...settings.foregroundIds],
            backgroundMultiplier: settings.backgroundMultiplier,
            foregroundMultiplier: settings.foregroundMultiplier,
            motion: {
              segmentStartMs: now,
              distanceAtSegmentStart: 0,
              speedAtSegmentStart: 0,
              targetSpeed: settings.targetSpeed,
              acceleration: settings.acceleration,
            },
          };
          await writeRuntime(runtime);
          await sendStatus(true, "Chase started in background mode.");
          return;
        }

        if (!current || current.runState === "stopped") {
          throw new Error("No active chase.");
        }

        const now = Date.now();
        const snapshot = current.runState === "running" ? motionAt(current.motion, now) : { distance: current.motion.distanceAtSegmentStart, speed: 0 };

        if (command.type === "PAUSE") {
          if (current.runState !== "running") return;
          await writeRuntime({
            ...current,
            revision: current.revision + 1,
            runState: "paused",
            motion: {
              ...current.motion,
              segmentStartMs: now,
              distanceAtSegmentStart: snapshot.distance,
              speedAtSegmentStart: 0,
            },
          });
          await sendStatus(true, "Paused — positions preserved.");
          return;
        }

        if (command.type === "RESUME") {
          if (current.runState !== "paused") return;
          await writeRuntime({
            ...current,
            revision: current.revision + 1,
            runState: "running",
            motion: {
              ...current.motion,
              segmentStartMs: now,
              distanceAtSegmentStart: current.motion.distanceAtSegmentStart,
              speedAtSegmentStart: 0,
            },
          });
          await sendStatus(true, "Resumed — accelerating back to target speed.");
          return;
        }

        if (command.type === "STOP") {
          const finalDistance = current.runState === "running" ? snapshot.distance : current.motion.distanceAtSegmentStart;
          await commitSourcesAtDistance(current, finalDistance);
          await writeRuntime({
            ...current,
            revision: current.revision + 1,
            runState: "stopped",
            motion: {
              ...current.motion,
              segmentStartMs: now,
              distanceAtSegmentStart: finalDistance,
              speedAtSegmentStart: 0,
            },
          });
          await sendStatus(true, "Chase stopped.");
          return;
        }

        if (command.type === "SET_TARGET_SPEED") {
          const targetSpeed = clampNumber(command.value, 0, 750, current.motion.targetSpeed);
          await writeRuntime({
            ...current,
            revision: current.revision + 1,
            motion: {
              ...current.motion,
              segmentStartMs: now,
              distanceAtSegmentStart: snapshot.distance,
              speedAtSegmentStart: current.runState === "running" ? snapshot.speed : 0,
              targetSpeed,
            },
          });
          return;
        }

        if (command.type === "SET_ACCELERATION") {
          const acceleration = clampNumber(command.value, 25, 1000, current.motion.acceleration);
          await writeRuntime({
            ...current,
            revision: current.revision + 1,
            motion: {
              ...current.motion,
              segmentStartMs: now,
              distanceAtSegmentStart: snapshot.distance,
              speedAtSegmentStart: current.runState === "running" ? snapshot.speed : 0,
              acceleration,
            },
          });
        }
      } catch (error) {
        await sendStatus(false, error instanceof Error ? error.message : "Minecart Scroll command failed.");
      }
    })();
  });
}

async function makeLocalLayer(kind: LayerKind, ids: string[], multiplier: number): Promise<LocalLayer | null> {
  if (ids.length < 2) return null;
  const sources = await OBR.scene.items.getItems(ids);
  const images = sources.filter(isImage).sort((a, b) => a.position.x - b.position.x);
  if (images.length !== ids.length || images.length < 2) return null;

  const spacing = Math.abs(images[1].position.x - images[0].position.x);
  const clones = images.map(cloneImageForLocal);
  await OBR.scene.local.addItems(clones);
  const localItems = await OBR.scene.local.getItems(clones.map((clone) => clone.id));
  const localById = new Map(localItems.filter(isImage).map((image) => [image.id, image]));
  const localImages = clones
    .map((clone) => localById.get(clone.id))
    .filter((image): image is Image => image !== undefined);

  return {
    kind,
    sourceIds: images.map((image) => image.id),
    clones: localImages,
    startX: images[0].position.x,
    y: images[0].position.y,
    spacing,
    baseZ: images[0].zIndex,
    multiplier,
    lastOrderSignature: "",
    zQueue: Promise.resolve(),
  };
}

async function runLocalRendererBackground(): Promise<void> {
  let runtime: RuntimeState | null = null;
  let localLayers: LocalLayer[] = [];
  let timer = 0;
  let syncing = false;
  let generation = 0;

  async function clearRenderer(): Promise<void> {
    generation += 1;
    if (timer) window.clearTimeout(timer);
    timer = 0;
    await cleanupLocalClones();
    localLayers = [];
  }

  async function rebuildRenderer(nextRuntime: RuntimeState): Promise<void> {
    syncing = true;
    const myGeneration = ++generation;
    try {
      if (timer) window.clearTimeout(timer);
      timer = 0;
      await cleanupLocalClones();
      if (myGeneration !== generation) return;

      const layers: LocalLayer[] = [];
      const background = await makeLocalLayer("background", nextRuntime.backgroundIds, nextRuntime.backgroundMultiplier);
      const track = await makeLocalLayer("track", nextRuntime.trackIds, 1);
      const foreground = await makeLocalLayer("foreground", nextRuntime.foregroundIds, nextRuntime.foregroundMultiplier);
      if (background) layers.push(background);
      if (track) layers.push(track);
      if (foreground) layers.push(foreground);
      localLayers = layers;
    } finally {
      syncing = false;
    }
  }

  function updateLayerZOrder(layer: LocalLayer, xById: Map<string, number>): void {
    const ordered = [...layer.clones]
      .sort((a, b) => (xById.get(a.id) ?? 0) - (xById.get(b.id) ?? 0))
      .map((item) => item.id);
    const signature = ordered.join("|");
    if (signature === layer.lastOrderSignature) return;
    layer.lastOrderSignature = signature;
    const zById = new Map(ordered.map((id, index) => [id, layer.baseZ + index]));
    layer.zQueue = layer.zQueue
      .then(async () => {
        await OBR.scene.local.updateItems(layer.clones, (items) => {
          for (const item of items) {
            const z = zById.get(item.id);
            if (z !== undefined) item.zIndex = z;
          }
        });
      })
      .catch((error) => console.error("Local z-index update failed:", error));
  }

  function renderTick(): void {
    if (!runtime || syncing || localLayers.length === 0) {
      timer = window.setTimeout(renderTick, LOCAL_TICK_MS);
      return;
    }

    const snapshot =
      runtime.runState === "running"
        ? motionAt(runtime.motion)
        : { distance: runtime.motion.distanceAtSegmentStart, speed: 0 };

    for (const layer of localLayers) {
      const distance = snapshot.distance * layer.multiplier;
      const xById = new Map<string, number>();
      for (let index = 0; index < layer.clones.length; index += 1) {
        const clone = layer.clones[index];
        xById.set(
          clone.id,
          positionForDistance(layer.startX, layer.spacing, layer.clones.length, index, distance),
        );
      }

      // Local fast updates use Owlbear's renderer fast path and do not generate room network traffic.
      void OBR.scene.local.updateItems(
        layer.clones,
        (items) => {
          for (const item of items) {
            const x = xById.get(item.id);
            if (x !== undefined) item.position.x = x;
            item.position.y = layer.y;
          }
        },
        true,
      );

      updateLayerZOrder(layer, xById);
    }

    timer = window.setTimeout(renderTick, LOCAL_TICK_MS);
  }

  async function syncFromMetadata(metadata: Metadata): Promise<void> {
    const next = parseRuntime(metadata[RUNTIME_KEY]);
    const previous = runtime;
    runtime = next;

    if (!next || next.runState === "stopped") {
      await clearRenderer();
      return;
    }

    const sourceChanged =
      !previous ||
      previous.trackIds.join("|") !== next.trackIds.join("|") ||
      previous.backgroundIds.join("|") !== next.backgroundIds.join("|") ||
      previous.foregroundIds.join("|") !== next.foregroundIds.join("|") ||
      previous.backgroundMultiplier !== next.backgroundMultiplier ||
      previous.foregroundMultiplier !== next.foregroundMultiplier;

    if (sourceChanged || localLayers.length === 0) {
      await rebuildRenderer(next);
    }
  }

  await cleanupLocalClones();
  if (await OBR.scene.isReady()) {
    const metadata = await OBR.scene.getMetadata();
    await syncFromMetadata(metadata);
  }

  OBR.scene.onMetadataChange((metadata) => {
    void syncFromMetadata(metadata);
  });

  OBR.scene.onReadyChange((ready) => {
    void (async () => {
      if (!ready) {
        runtime = null;
        await clearRenderer();
        return;
      }
      const metadata = await OBR.scene.getMetadata();
      await syncFromMetadata(metadata);
    })();
  });

  renderTick();
}

function renderUI(): void {
  document.querySelector<HTMLDivElement>("#app")!.innerHTML = `
    <div style="font-family: Arial, sans-serif; padding: 14px;">
      <h2 style="margin:0 0 8px; text-align:center;">Minecart Scroll</h2>
      <p id="status" style="text-align:center; margin:6px 0 12px;">Waiting for Owlbear...</p>

      <div id="playerPanel" hidden style="text-align:center; padding:18px 8px;">
        <h3>Chase View</h3>
        <p>The GM controls Minecart Scroll.</p>
        <p>The chase runs even with this panel closed.</p>
      </div>

      <div id="gmPanel" hidden style="max-height:540px; overflow-y:auto; padding-right:4px;">
        <fieldset>
          <legend><strong>Layers</strong></legend>
          <button id="setTrackButton">Set Track</button> <span id="trackStatus">Not set</span><br><br>
          <button id="setBackgroundButton">Set Background</button> <span id="backgroundStatus">Not set</span><br><br>
          <button id="setForegroundButton">Set Foreground</button> <span id="foregroundStatus">Not set (optional)</span>
        </fieldset>
        <br>
        <fieldset>
          <legend><strong>Scene Settings</strong></legend>
          <button id="saveButton">Save Settings</button>
          <button id="loadButton">Load Settings</button>
          <p style="font-size:12px; margin-bottom:0;">Assignments and controls are saved to this Owlbear scene.</p>
        </fieldset>
        <br>
        <fieldset>
          <legend><strong>Anchor</strong></legend>
          <label>Anchor X: <input id="anchorXInput" type="number" value="0" step="50" style="width:90px;"></label><br><br>
          <label>Anchor Y: <input id="anchorYInput" type="number" value="0" step="50" style="width:90px;"></label><br><br>
          <button id="goToAnchorButton">Go to Anchor Point</button>
          <label style="display:block; margin-top:10px;"><input id="focusOnStartCheckbox" type="checkbox" checked> Go to anchor when chase starts</label>
        </fieldset>
        <br>
        <fieldset>
          <legend><strong>Layout</strong></legend>
          <label>Track Y Offset: <input id="trackYOffsetInput" type="number" value="0" step="10" style="width:90px;"></label><br><br>
          <label>Foreground Y Offset: <input id="foregroundYOffsetInput" type="number" value="0" step="10" style="width:90px;"></label><br><br>
          <label>Background Seam Overlap: <input id="backgroundOverlapInput" type="number" min="0" max="50" value="0" step="1" style="width:70px;"></label><br><br>
          <label>Foreground Seam Overlap: <input id="foregroundOverlapInput" type="number" min="0" max="50" value="0" step="1" style="width:70px;"></label>
          <p style="font-size:12px; margin-bottom:0;">Layout changes apply on the next Start.</p>
        </fieldset>
        <br>
        <fieldset>
          <legend><strong>Motion</strong></legend>
          <label>Main Target Speed: <strong><span id="targetSpeedValue">150</span></strong></label>
          <input id="targetSpeedSlider" type="range" min="0" max="750" value="150" step="25" style="width:100%;">
          <p style="margin:8px 0;">Current Speed: <strong><span id="currentSpeedValue">0</span></strong></p>
          <label>Acceleration / Braking: <strong><span id="accelerationValue">200</span></strong></label>
          <input id="accelerationSlider" type="range" min="25" max="1000" value="200" step="25" style="width:100%;">
          <br><br>
          <label>Background Speed: <strong><span id="backgroundMultiplierValue">40</span>%</strong></label>
          <input id="backgroundMultiplierSlider" type="range" min="0" max="100" value="40" step="5" style="width:100%;">
          <br><br>
          <label>Foreground Speed: <strong><span id="foregroundMultiplierValue">140</span>%</strong></label>
          <input id="foregroundMultiplierSlider" type="range" min="100" max="250" value="140" step="5" style="width:100%;">
          <p style="font-size:12px; margin-bottom:0;">Parallax percentages apply on the next Start.</p>
        </fieldset>
        <br>
        <fieldset>
          <legend><strong>Chase</strong></legend>
          <button id="startButton">Start</button>
          <button id="pauseButton" disabled>Pause</button>
          <button id="resumeButton" disabled>Resume</button>
          <button id="stopButton" disabled>Stop</button>
        </fieldset>
      </div>
    </div>
  `;
}

async function runUI(): Promise<void> {
  const status = document.querySelector<HTMLParagraphElement>("#status")!;
  const gmPanel = document.querySelector<HTMLDivElement>("#gmPanel")!;
  const playerPanel = document.querySelector<HTMLDivElement>("#playerPanel")!;
  const role = await OBR.player.getRole();

  if (role !== "GM") {
    playerPanel.hidden = false;
    status.textContent = "Player view — controlled by the GM.";
    return;
  }

  gmPanel.hidden = false;
  status.textContent = "GM controls ready — chase engine runs in the background.";

  const trackStatus = document.querySelector<HTMLSpanElement>("#trackStatus")!;
  const backgroundStatus = document.querySelector<HTMLSpanElement>("#backgroundStatus")!;
  const foregroundStatus = document.querySelector<HTMLSpanElement>("#foregroundStatus")!;
  const setTrackButton = document.querySelector<HTMLButtonElement>("#setTrackButton")!;
  const setBackgroundButton = document.querySelector<HTMLButtonElement>("#setBackgroundButton")!;
  const setForegroundButton = document.querySelector<HTMLButtonElement>("#setForegroundButton")!;
  const saveButton = document.querySelector<HTMLButtonElement>("#saveButton")!;
  const loadButton = document.querySelector<HTMLButtonElement>("#loadButton")!;
  const anchorXInput = document.querySelector<HTMLInputElement>("#anchorXInput")!;
  const anchorYInput = document.querySelector<HTMLInputElement>("#anchorYInput")!;
  const goToAnchorButton = document.querySelector<HTMLButtonElement>("#goToAnchorButton")!;
  const focusOnStartCheckbox = document.querySelector<HTMLInputElement>("#focusOnStartCheckbox")!;
  const trackYOffsetInput = document.querySelector<HTMLInputElement>("#trackYOffsetInput")!;
  const foregroundYOffsetInput = document.querySelector<HTMLInputElement>("#foregroundYOffsetInput")!;
  const backgroundOverlapInput = document.querySelector<HTMLInputElement>("#backgroundOverlapInput")!;
  const foregroundOverlapInput = document.querySelector<HTMLInputElement>("#foregroundOverlapInput")!;
  const targetSpeedSlider = document.querySelector<HTMLInputElement>("#targetSpeedSlider")!;
  const targetSpeedValue = document.querySelector<HTMLSpanElement>("#targetSpeedValue")!;
  const currentSpeedValue = document.querySelector<HTMLSpanElement>("#currentSpeedValue")!;
  const accelerationSlider = document.querySelector<HTMLInputElement>("#accelerationSlider")!;
  const accelerationValue = document.querySelector<HTMLSpanElement>("#accelerationValue")!;
  const backgroundMultiplierSlider = document.querySelector<HTMLInputElement>("#backgroundMultiplierSlider")!;
  const backgroundMultiplierValue = document.querySelector<HTMLSpanElement>("#backgroundMultiplierValue")!;
  const foregroundMultiplierSlider = document.querySelector<HTMLInputElement>("#foregroundMultiplierSlider")!;
  const foregroundMultiplierValue = document.querySelector<HTMLSpanElement>("#foregroundMultiplierValue")!;
  const startButton = document.querySelector<HTMLButtonElement>("#startButton")!;
  const pauseButton = document.querySelector<HTMLButtonElement>("#pauseButton")!;
  const resumeButton = document.querySelector<HTMLButtonElement>("#resumeButton")!;
  const stopButton = document.querySelector<HTMLButtonElement>("#stopButton")!;

  let trackIds: string[] = [];
  let backgroundIds: string[] = [];
  let foregroundIds: string[] = [];
  let runtime: RuntimeState | null = await readRuntime();

  function currentState(): RunState {
    return runtime?.runState ?? "stopped";
  }

  function updateLayerLabels(): void {
    trackStatus.textContent = trackIds.length >= 2 ? `${trackIds.length} images` : "Not set";
    backgroundStatus.textContent = backgroundIds.length >= 2 ? `${backgroundIds.length} images` : "Not set";
    foregroundStatus.textContent = foregroundIds.length >= 2 ? `${foregroundIds.length} images` : "Not set (optional)";
  }

  function updateButtons(): void {
    const state = currentState();
    startButton.disabled = state !== "stopped";
    pauseButton.disabled = state !== "running";
    resumeButton.disabled = state !== "paused";
    stopButton.disabled = state === "stopped";
    setTrackButton.disabled = state !== "stopped";
    setBackgroundButton.disabled = state !== "stopped";
    setForegroundButton.disabled = state !== "stopped";
    loadButton.disabled = state !== "stopped";
    backgroundMultiplierSlider.disabled = state !== "stopped";
    foregroundMultiplierSlider.disabled = state !== "stopped";
    trackYOffsetInput.disabled = state !== "stopped";
    foregroundYOffsetInput.disabled = state !== "stopped";
    backgroundOverlapInput.disabled = state !== "stopped";
    foregroundOverlapInput.disabled = state !== "stopped";
  }

  function makeSettings(): SavedSettings {
    return {
      version: 3,
      trackIds: [...trackIds],
      backgroundIds: [...backgroundIds],
      foregroundIds: [...foregroundIds],
      anchorX: Number.isFinite(Number(anchorXInput.value)) ? Number(anchorXInput.value) : 0,
      anchorY: Number.isFinite(Number(anchorYInput.value)) ? Number(anchorYInput.value) : 0,
      trackYOffset: clampNumber(Number(trackYOffsetInput.value), -10000, 10000, 0),
      foregroundYOffset: clampNumber(Number(foregroundYOffsetInput.value), -10000, 10000, 0),
      backgroundOverlap: clampNumber(Number(backgroundOverlapInput.value), 0, 50, 0),
      foregroundOverlap: clampNumber(Number(foregroundOverlapInput.value), 0, 50, 0),
      targetSpeed: clampNumber(Number(targetSpeedSlider.value), 0, 750, 150),
      acceleration: clampNumber(Number(accelerationSlider.value), 25, 1000, 200),
      backgroundMultiplier: clampNumber(Number(backgroundMultiplierSlider.value), 0, 100, 40) / 100,
      foregroundMultiplier: clampNumber(Number(foregroundMultiplierSlider.value), 100, 250, 140) / 100,
      focusOnStart: focusOnStartCheckbox.checked,
    };
  }

  function applySettings(settings: SavedSettings): void {
    trackIds = [...settings.trackIds];
    backgroundIds = [...settings.backgroundIds];
    foregroundIds = [...settings.foregroundIds];
    anchorXInput.value = String(settings.anchorX);
    anchorYInput.value = String(settings.anchorY);
    trackYOffsetInput.value = String(settings.trackYOffset);
    foregroundYOffsetInput.value = String(settings.foregroundYOffset);
    backgroundOverlapInput.value = String(settings.backgroundOverlap);
    foregroundOverlapInput.value = String(settings.foregroundOverlap);
    targetSpeedSlider.value = String(settings.targetSpeed);
    targetSpeedValue.textContent = String(Math.round(settings.targetSpeed));
    accelerationSlider.value = String(settings.acceleration);
    accelerationValue.textContent = String(Math.round(settings.acceleration));
    backgroundMultiplierSlider.value = String(settings.backgroundMultiplier * 100);
    backgroundMultiplierValue.textContent = String(Math.round(settings.backgroundMultiplier * 100));
    foregroundMultiplierSlider.value = String(settings.foregroundMultiplier * 100);
    foregroundMultiplierValue.textContent = String(Math.round(settings.foregroundMultiplier * 100));
    focusOnStartCheckbox.checked = settings.focusOnStart;
    updateLayerLabels();
  }

  async function loadSettings(silent = false): Promise<void> {
    if (!(await OBR.scene.isReady())) return;
    const metadata = await OBR.scene.getMetadata();
    const settings = parseSavedSettings(metadata[SETTINGS_KEY]);
    if (settings) {
      applySettings(settings);
      if (!silent) status.textContent = "Saved settings loaded.";
    } else if (!silent) {
      status.textContent = "No saved Minecart Scroll settings in this scene yet.";
    }
  }

  async function saveSettings(): Promise<void> {
    if (!(await OBR.scene.isReady())) {
      status.textContent = "Open a scene first.";
      return;
    }
    await OBR.scene.setMetadata({ [SETTINGS_KEY]: makeSettings() });
    status.textContent = "Settings saved to this scene.";
  }

  async function getSelectedImages(): Promise<Image[] | null> {
    const selection = await OBR.player.getSelection();
    if (!selection || selection.length < 2) {
      status.textContent = "Select at least TWO images first.";
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

  function overlapsOtherLayers(ids: string[], kind: LayerKind): boolean {
    const otherIds = [
      ...(kind === "track" ? [] : trackIds),
      ...(kind === "background" ? [] : backgroundIds),
      ...(kind === "foreground" ? [] : foregroundIds),
    ];
    const others = new Set(otherIds);
    return ids.some((id) => others.has(id));
  }

  async function setLayer(kind: LayerKind): Promise<void> {
    if (currentState() !== "stopped") return;
    const images = await getSelectedImages();
    if (!images) return;
    const ids = images.map((image) => image.id);
    if (overlapsOtherLayers(ids, kind)) {
      status.textContent = "Each parallax layer must use different images.";
      return;
    }
    if (kind === "track") trackIds = ids;
    if (kind === "background") backgroundIds = ids;
    if (kind === "foreground") foregroundIds = ids;
    updateLayerLabels();
    await OBR.player.deselect();
    status.textContent = `${kind[0].toUpperCase()}${kind.slice(1)} layer set.`;
  }

  async function sendCommand(command: ControlCommand): Promise<void> {
    await OBR.broadcast.sendMessage(CONTROL_CHANNEL, command, { destination: "LOCAL" });
  }

  async function goToAnchor(): Promise<void> {
    const settings = makeSettings();
    const screenPoint = await OBR.viewport.transformPoint({ x: settings.anchorX, y: settings.anchorY });
    const width = await OBR.viewport.getWidth();
    const height = await OBR.viewport.getHeight();
    const currentPosition = await OBR.viewport.getPosition();
    const currentScale = await OBR.viewport.getScale();
    await OBR.viewport.animateTo({
      position: {
        x: currentPosition.x + width / 2 - screenPoint.x,
        y: currentPosition.y + height / 2 - screenPoint.y,
      },
      scale: currentScale,
    });
  }

  setTrackButton.addEventListener("click", () => void setLayer("track"));
  setBackgroundButton.addEventListener("click", () => void setLayer("background"));
  setForegroundButton.addEventListener("click", () => void setLayer("foreground"));
  saveButton.addEventListener("click", () => void saveSettings());
  loadButton.addEventListener("click", () => void loadSettings(false));
  goToAnchorButton.addEventListener("click", () => void goToAnchor());

  targetSpeedSlider.addEventListener("input", () => {
    targetSpeedValue.textContent = targetSpeedSlider.value;
    if (currentState() !== "stopped") {
      void sendCommand({ type: "SET_TARGET_SPEED", value: Number(targetSpeedSlider.value) });
    }
  });

  accelerationSlider.addEventListener("input", () => {
    accelerationValue.textContent = accelerationSlider.value;
    if (currentState() !== "stopped") {
      void sendCommand({ type: "SET_ACCELERATION", value: Number(accelerationSlider.value) });
    }
  });

  backgroundMultiplierSlider.addEventListener("input", () => {
    backgroundMultiplierValue.textContent = backgroundMultiplierSlider.value;
  });
  foregroundMultiplierSlider.addEventListener("input", () => {
    foregroundMultiplierValue.textContent = foregroundMultiplierSlider.value;
  });

  startButton.addEventListener("click", async () => {
    const settings = makeSettings();
    if (settings.trackIds.length < 2 || settings.backgroundIds.length < 2) {
      status.textContent = "Set Track and Background first.";
      return;
    }
    if (settings.focusOnStart) await goToAnchor();
    await OBR.player.deselect();
    await sendCommand({ type: "START", settings });
    status.textContent = "Starting chase...";
  });
  pauseButton.addEventListener("click", () => void sendCommand({ type: "PAUSE" }));
  resumeButton.addEventListener("click", () => void sendCommand({ type: "RESUME" }));
  stopButton.addEventListener("click", () => void sendCommand({ type: "STOP" }));

  OBR.broadcast.onMessage(STATUS_CHANNEL, (event) => {
    const message = event.data as StatusMessage;
    if (message && typeof message.message === "string") status.textContent = message.message;
  });

  OBR.scene.onMetadataChange((metadata) => {
    runtime = parseRuntime(metadata[RUNTIME_KEY]);
    updateButtons();
  });

  OBR.scene.onReadyChange((ready) => {
    void (async () => {
      if (!ready) {
        runtime = null;
        updateButtons();
        return;
      }
      runtime = await readRuntime();
      await loadSettings(true);
      updateButtons();
    })();
  });

  window.setInterval(() => {
    if (runtime?.runState === "running") {
      currentSpeedValue.textContent = String(Math.round(motionAt(runtime.motion).speed));
    } else {
      currentSpeedValue.textContent = "0";
    }
  }, 150);

  await loadSettings(true);
  runtime = await readRuntime();
  updateLayerLabels();
  updateButtons();
}

const backgroundMode = new URLSearchParams(window.location.search).get("background") === "1";

if (backgroundMode) {
  OBR.onReady(() => {
    void runLocalRendererBackground();
    void runControllerBackground();
  });
} else {
  renderUI();
  OBR.onReady(() => void runUI());
}
