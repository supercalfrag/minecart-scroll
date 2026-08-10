import OBR, { buildImage, isImage, type Image, type Metadata } from "@owlbear-rodeo/sdk";

const SETTINGS_KEY = "com.supercalfrag.minecart-scroll/settings";
const RUNTIME_KEY = "com.supercalfrag.minecart-scroll/runtime";
const LOCAL_CLONE_KEY = "com.supercalfrag.minecart-scroll/local-source-id";
const CONTROL_CHANNEL = "com.supercalfrag.minecart-scroll/control";
const STATUS_CHANNEL = "com.supercalfrag.minecart-scroll/status";

const TRACK_OVERLAP = 2;
const Z_GAP = 100000;
const LOCAL_TICK_MS = 20; // 50fps target. Absolute-time motion prevents cumulative drift.
const MAX_CHASE_SPEED = 1000;
const DEFAULT_FLOOR_MULTIPLIER = 0.45;
const DEFAULT_BACKGROUND_MULTIPLIER = 0.4;
const DEFAULT_FOREGROUND_MULTIPLIER = 1.4;
const DEFAULT_RATTLE_START_SPEED = 100;
const DEFAULT_RATTLE_STRENGTH = 1;
const MAX_RATTLE_OFFSET = 8;

type RunState = "stopped" | "running" | "paused";
type LayerKind = "floor" | "background" | "track" | "foreground";

type SavedSettings = {
  version: 4;
  floorIds: string[];
  trackIds: string[];
  backgroundIds: string[];
  foregroundIds: string[];
  minecartIds: string[];
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

type MotionSegment = {
  segmentStartMs: number;
  distanceAtSegmentStart: number;
  speedAtSegmentStart: number;
  targetSpeed: number;
  acceleration: number;
};

type RuntimeState = {
  version: 4;
  revision: number;
  runState: RunState;
  controllerId: string;
  floorIds: string[];
  trackIds: string[];
  backgroundIds: string[];
  foregroundIds: string[];
  minecartIds: string[];
  floorMultiplier: number;
  backgroundMultiplier: number;
  foregroundMultiplier: number;
  rattleEnabled: boolean;
  rattleStrength: number;
  rattleStartSpeed: number;
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

type LocalMinecart = {
  sourceId: string;
  clone: Image;
  baseY: number;
  seed: number;
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
  const value = raw as Partial<SavedSettings> & { version?: number };
  return {
    version: 4,
    floorIds: Array.isArray(value.floorIds) ? value.floorIds.filter((id): id is string => typeof id === "string") : [],
    trackIds: Array.isArray(value.trackIds) ? value.trackIds.filter((id): id is string => typeof id === "string") : [],
    backgroundIds: Array.isArray(value.backgroundIds)
      ? value.backgroundIds.filter((id): id is string => typeof id === "string")
      : [],
    foregroundIds: Array.isArray(value.foregroundIds)
      ? value.foregroundIds.filter((id): id is string => typeof id === "string")
      : [],
    minecartIds: Array.isArray(value.minecartIds)
      ? value.minecartIds.filter((id): id is string => typeof id === "string")
      : [],
    anchorX: Number.isFinite(value.anchorX) ? Number(value.anchorX) : 0,
    anchorY: Number.isFinite(value.anchorY) ? Number(value.anchorY) : 0,
    floorYOffset: clampNumber(Number(value.floorYOffset), -10000, 10000, 0),
    trackYOffset: clampNumber(Number(value.trackYOffset), -10000, 10000, 0),
    foregroundYOffset: clampNumber(Number(value.foregroundYOffset), -10000, 10000, 0),
    floorOverlap: clampNumber(Number(value.floorOverlap), 0, 50, 0),
    backgroundOverlap: clampNumber(Number(value.backgroundOverlap), 0, 50, 0),
    foregroundOverlap: clampNumber(Number(value.foregroundOverlap), 0, 50, 0),
    targetSpeed: clampNumber(Number(value.targetSpeed), 0, MAX_CHASE_SPEED, 150),
    acceleration: clampNumber(Number(value.acceleration), 25, 1000, 200),
    floorMultiplier: clampNumber(Number(value.floorMultiplier), 0, 1, DEFAULT_FLOOR_MULTIPLIER),
    backgroundMultiplier: clampNumber(Number(value.backgroundMultiplier), 0, 1, DEFAULT_BACKGROUND_MULTIPLIER),
    foregroundMultiplier: clampNumber(Number(value.foregroundMultiplier), 1, 2.5, DEFAULT_FOREGROUND_MULTIPLIER),
    rattleEnabled: typeof value.rattleEnabled === "boolean" ? value.rattleEnabled : true,
    rattleStrength: clampNumber(Number(value.rattleStrength), 0, 2, DEFAULT_RATTLE_STRENGTH),
    rattleStartSpeed: clampNumber(Number(value.rattleStartSpeed), 0, 500, DEFAULT_RATTLE_START_SPEED),
    focusOnStart: typeof value.focusOnStart === "boolean" ? value.focusOnStart : true,
  };
}

function parseRuntime(raw: unknown): RuntimeState | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Omit<Partial<RuntimeState>, "version"> & { version?: number };
  if ((value.version !== 3 && value.version !== 4) || typeof value.revision !== "number" || typeof value.runState !== "string") return null;
  if (!value.motion || typeof value.motion !== "object") return null;
  const motion = value.motion as Partial<MotionSegment>;
  return {
    version: 4,
    revision: value.revision,
    runState: value.runState === "running" || value.runState === "paused" ? value.runState : "stopped",
    controllerId: typeof value.controllerId === "string" ? value.controllerId : "",
    floorIds: Array.isArray(value.floorIds) ? value.floorIds.filter((id): id is string => typeof id === "string") : [],
    trackIds: Array.isArray(value.trackIds) ? value.trackIds.filter((id): id is string => typeof id === "string") : [],
    backgroundIds: Array.isArray(value.backgroundIds)
      ? value.backgroundIds.filter((id): id is string => typeof id === "string")
      : [],
    foregroundIds: Array.isArray(value.foregroundIds)
      ? value.foregroundIds.filter((id): id is string => typeof id === "string")
      : [],
    minecartIds: Array.isArray(value.minecartIds)
      ? value.minecartIds.filter((id): id is string => typeof id === "string")
      : [],
    floorMultiplier: clampNumber(Number(value.floorMultiplier), 0, 1, DEFAULT_FLOOR_MULTIPLIER),
    backgroundMultiplier: clampNumber(Number(value.backgroundMultiplier), 0, 1, DEFAULT_BACKGROUND_MULTIPLIER),
    foregroundMultiplier: clampNumber(Number(value.foregroundMultiplier), 1, 2.5, DEFAULT_FOREGROUND_MULTIPLIER),
    rattleEnabled: typeof value.rattleEnabled === "boolean" ? value.rattleEnabled : true,
    rattleStrength: clampNumber(Number(value.rattleStrength), 0, 2, DEFAULT_RATTLE_STRENGTH),
    rattleStartSpeed: clampNumber(Number(value.rattleStartSpeed), 0, 500, DEFAULT_RATTLE_START_SPEED),
    motion: {
      segmentStartMs: Number.isFinite(motion.segmentStartMs) ? Number(motion.segmentStartMs) : Date.now(),
      distanceAtSegmentStart: Number.isFinite(motion.distanceAtSegmentStart) ? Number(motion.distanceAtSegmentStart) : 0,
      speedAtSegmentStart: clampNumber(Number(motion.speedAtSegmentStart), 0, MAX_CHASE_SPEED, 0),
      targetSpeed: clampNumber(Number(motion.targetSpeed), 0, MAX_CHASE_SPEED, 150),
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

function cloneImageForLocal(
  source: Image,
  layer: Image["layer"] = source.layer,
  zIndex = source.zIndex,
): Image {
  return buildImage(source.image, source.grid)
    .name(`Minecart Scroll: ${source.name || "scenery"}`)
    .position({ ...source.position })
    .rotation(source.rotation)
    .scale({ ...source.scale })
    .layer(layer)
    .zIndex(zIndex)
    .visible(true)
    .locked(true)
    .disableHit(true)
    .disableAutoZIndex(true)
    .metadata(sourceMetadata(source.id))
    .build();
}

async function getSourceImages(
  ids: string[],
  name: string,
  required: boolean,
  minimumCount = 2,
): Promise<Image[]> {
  if (ids.length === 0 && !required) return [];
  if (ids.length < minimumCount) {
    const countText = minimumCount === 1 ? "one assigned image" : `${minimumCount} assigned images`;
    throw new Error(`${name} needs at least ${countText}.`);
  }
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
    }
  });

  const refreshed = await OBR.scene.items.getItems(sorted.map((image) => image.id));
  return refreshed.filter(isImage).sort((a, b) => a.position.x - b.position.x);
}

async function prepareSources(settings: SavedSettings): Promise<void> {
  const floor = await getSourceImages(settings.floorIds, "Floor", false);
  const track = await getSourceImages(settings.trackIds, "Track", true);
  const background = await getSourceImages(settings.backgroundIds, "Background", true);
  const foreground = await getSourceImages(settings.foregroundIds, "Foreground", false);
  const minecarts = await getSourceImages(settings.minecartIds, "Minecarts", false, 1);
  const scenery = [...floor, ...track, ...background, ...foreground];
  const combined = [...scenery, ...minecarts];
  const baseZ = scenery.length > 0 ? Math.min(...scenery.map((image) => image.zIndex)) : 0;

  // Keep the real scene items visible until every measurement and layout step has succeeded.
  // If anything throws, the catch block restores them so a failed Start can never strand the scene hidden.
  await OBR.scene.items.updateItems(combined, (items) => {
    for (const item of items) item.visible = true;
  });

  try {
    const sortedBackground = [...background].sort((a, b) => a.position.x - b.position.x);
    const firstBackground = sortedBackground[0];
    const backgroundBounds = await OBR.scene.items.getItemBounds([firstBackground.id]);
    const backgroundOverride = {
      x: firstBackground.position.x + (settings.anchorX - backgroundBounds.center.x),
      y: firstBackground.position.y + (settings.anchorY - backgroundBounds.center.y),
    };

    await arrangeSourceLayer(
      "Background",
      background,
      baseZ + Z_GAP,
      settings.backgroundOverlap,
      backgroundOverride,
    );

    // Background is centered directly on the anchor, so all other layer centers can use the
    // same anchor without temporarily showing/hiding one background strip just to re-measure it.
    if (floor.length >= 2) {
      const sortedFloor = [...floor].sort((a, b) => a.position.x - b.position.x);
      const firstFloor = sortedFloor[0];
      const floorBounds = await OBR.scene.items.getItemBounds([firstFloor.id]);
      const floorOverride = {
        x: firstFloor.position.x + (settings.anchorX - floorBounds.center.x),
        y: firstFloor.position.y + (settings.anchorY - floorBounds.center.y) + settings.floorYOffset,
      };
      await arrangeSourceLayer("Floor", floor, baseZ, settings.floorOverlap, floorOverride);
    }

    const sortedTrack = [...track].sort((a, b) => a.position.x - b.position.x);
    const firstTrack = sortedTrack[0];
    const trackBounds = await OBR.scene.items.getItemBounds([firstTrack.id]);
    const trackOverride = {
      x: firstTrack.position.x + (settings.anchorX - trackBounds.center.x),
      y: firstTrack.position.y + (settings.anchorY - trackBounds.center.y) + settings.trackYOffset,
    };
    await arrangeSourceLayer("Track", track, baseZ + Z_GAP * 2, TRACK_OVERLAP, trackOverride);

    if (foreground.length >= 2) {
      const sortedForeground = [...foreground].sort((a, b) => a.position.x - b.position.x);
      const firstForeground = sortedForeground[0];
      const foregroundBounds = await OBR.scene.items.getItemBounds([firstForeground.id]);
      const foregroundOverride = {
        x: firstForeground.position.x + (settings.anchorX - foregroundBounds.center.x),
        y:
          firstForeground.position.y +
          (settings.anchorY - foregroundBounds.center.y) +
          settings.foregroundYOffset,
      };
      await arrangeSourceLayer(
        "Foreground",
        foreground,
        baseZ + Z_GAP * 4,
        settings.foregroundOverlap,
        foregroundOverride,
      );
    }

    // Only hide the real scene items after all layout work has succeeded. Local renderers
    // replace these with temporary copies while the chase is active.
    await OBR.scene.items.updateItems(combined, (items) => {
      for (const item of items) item.visible = false;
    });
  } catch (error) {
    await OBR.scene.items.updateItems(combined, (items) => {
      for (const item of items) item.visible = true;
    });
    throw error;
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
    { ids: runtime.floorIds, multiplier: runtime.floorMultiplier },
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

  if (runtime.minecartIds.length > 0) {
    const carts = await OBR.scene.items.getItems(runtime.minecartIds);
    await OBR.scene.items.updateItems(carts, (items) => {
      for (const item of items) item.visible = true;
    });
  }
}

async function restoreAssignedSourcesWhenStopped(): Promise<void> {
  if (!(await OBR.scene.isReady())) return;
  const metadata = await OBR.scene.getMetadata();
  const runtime = parseRuntime(metadata[RUNTIME_KEY]);
  if (runtime && runtime.runState !== "stopped") return;
  const settings = parseSavedSettings(metadata[SETTINGS_KEY]);
  if (!settings) return;

  const ids = Array.from(
    new Set([
      ...settings.floorIds,
      ...settings.backgroundIds,
      ...settings.trackIds,
      ...settings.minecartIds,
      ...settings.foregroundIds,
    ]),
  );
  if (ids.length === 0) return;
  const items = await OBR.scene.items.getItems(ids);
  if (items.length > 0) {
    await OBR.scene.items.updateItems(items, (draft) => {
      for (const item of draft) item.visible = true;
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
            version: 4,
            revision,
            runState: "running",
            controllerId: OBR.player.id,
            floorIds: [...settings.floorIds],
            trackIds: [...settings.trackIds],
            backgroundIds: [...settings.backgroundIds],
            foregroundIds: [...settings.foregroundIds],
            minecartIds: [...settings.minecartIds],
            floorMultiplier: settings.floorMultiplier,
            backgroundMultiplier: settings.backgroundMultiplier,
            foregroundMultiplier: settings.foregroundMultiplier,
            rattleEnabled: settings.rattleEnabled,
            rattleStrength: settings.rattleStrength,
            rattleStartSpeed: settings.rattleStartSpeed,
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
              speedAtSegmentStart: snapshot.speed,
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
          const targetSpeed = clampNumber(command.value, 0, MAX_CHASE_SPEED, current.motion.targetSpeed);
          await writeRuntime({
            ...current,
            revision: current.revision + 1,
            motion: {
              ...current.motion,
              segmentStartMs: now,
              distanceAtSegmentStart: snapshot.distance,
              speedAtSegmentStart:
                current.runState === "running" ? snapshot.speed : current.motion.speedAtSegmentStart,
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
              speedAtSegmentStart:
                current.runState === "running" ? snapshot.speed : current.motion.speedAtSegmentStart,
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

function hashString(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function randomSigned(seed: number, step: number): number {
  let value = (seed ^ Math.imul(step + 1, 0x45d9f3b)) >>> 0;
  value ^= value >>> 16;
  value = Math.imul(value, 0x45d9f3b) >>> 0;
  value ^= value >>> 16;
  return (value / 0xffffffff) * 2 - 1;
}

function smoothStep(value: number): number {
  const t = clampNumber(value, 0, 1, 0);
  return t * t * (3 - 2 * t);
}

function cartRattleOffset(
  seed: number,
  distance: number,
  speed: number,
  strength: number,
  startSpeed: number,
): number {
  if (strength <= 0 || speed <= startSpeed) return 0;
  const range = Math.max(1, MAX_CHASE_SPEED - startSpeed);
  const intensity = clampNumber((speed - startSpeed) / range, 0, 1, 0);
  const amplitude = MAX_RATTLE_OFFSET * strength * Math.pow(intensity, 0.8);

  // Distance-driven noise means every cart rattles independently, speeds up naturally with the chase,
  // and freezes perfectly in place while paused because chase distance stops advancing.
  const interval = 24 - intensity * 10;
  const phaseOffset = (seed % 10000) / 97;
  const position = distance / interval + phaseOffset;
  const step = Math.floor(position);
  const mix = smoothStep(position - step);
  const low = randomSigned(seed, step);
  const high = randomSigned(seed, step + 1);
  const primary = low + (high - low) * mix;

  // Add a smaller second rail-chatter signal so the motion feels irregular instead of sinusoidal.
  const chatterPosition = distance / Math.max(6, interval * 0.43) + phaseOffset * 1.73;
  const chatterStep = Math.floor(chatterPosition);
  const chatterMix = smoothStep(chatterPosition - chatterStep);
  const chatterLow = randomSigned(seed ^ 0x9e3779b9, chatterStep);
  const chatterHigh = randomSigned(seed ^ 0x9e3779b9, chatterStep + 1);
  const chatter = chatterLow + (chatterHigh - chatterLow) * chatterMix;

  return clampNumber((primary * 0.72 + chatter * 0.28) * amplitude, -MAX_RATTLE_OFFSET * strength, MAX_RATTLE_OFFSET * strength, 0);
}

async function makeLocalLayer(kind: LayerKind, ids: string[], multiplier: number): Promise<LocalLayer | null> {
  if (ids.length < 2) return null;
  const sources = await OBR.scene.items.getItems(ids);
  const images = sources.filter(isImage).sort((a, b) => a.position.x - b.position.x);
  if (images.length !== ids.length || images.length < 2) return null;

  const spacing = Math.abs(images[1].position.x - images[0].position.x);
  const clones = images.map((source) => cloneImageForLocal(source));
  await OBR.scene.local.addItems(clones);
  const localItems = await OBR.scene.local.getItems(clones.map((clone) => clone.id));
  const localById = new Map<string, Image>(localItems.filter(isImage).map((image) => [image.id, image] as const));
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

async function makeLocalMinecarts(ids: string[]): Promise<LocalMinecart[]> {
  if (ids.length === 0) return [];
  const sources = await OBR.scene.items.getItems(ids);
  const images = sources.filter(isImage);
  if (images.length !== ids.length) return [];

  // Preserve each cart's original Owlbear layer. This avoids triggering special Mount/Attachment
  // semantics while still allowing the cart to rattle locally.
  const clones = images.map((source) => cloneImageForLocal(source));
  await OBR.scene.local.addItems(clones);
  const localItems = await OBR.scene.local.getItems(clones.map((clone) => clone.id));
  const localById = new Map<string, Image>(localItems.filter(isImage).map((image) => [image.id, image] as const));

  const minecarts: LocalMinecart[] = [];
  for (let index = 0; index < images.length; index += 1) {
    const source = images[index];
    const clone = localById.get(clones[index].id);
    if (!clone) continue;
    minecarts.push({
      sourceId: source.id,
      clone,
      baseY: source.position.y,
      seed: hashString(source.id),
    });
  }
  return minecarts;
}

async function runLocalRendererBackground(): Promise<void> {
  let runtime: RuntimeState | null = null;
  let localLayers: LocalLayer[] = [];
  let localMinecarts: LocalMinecart[] = [];
  let timer = 0;
  let syncing = false;
  let generation = 0;

  async function clearRenderer(): Promise<void> {
    generation += 1;
    if (timer) window.clearTimeout(timer);
    timer = 0;
    await cleanupLocalClones();
    localLayers = [];
    localMinecarts = [];
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
      const floor = await makeLocalLayer("floor", nextRuntime.floorIds, nextRuntime.floorMultiplier);
      const background = await makeLocalLayer("background", nextRuntime.backgroundIds, nextRuntime.backgroundMultiplier);
      const track = await makeLocalLayer("track", nextRuntime.trackIds, 1);
      const foreground = await makeLocalLayer("foreground", nextRuntime.foregroundIds, nextRuntime.foregroundMultiplier);
      const minecarts = await makeLocalMinecarts(nextRuntime.minecartIds);
      if (floor) layers.push(floor);
      if (background) layers.push(background);
      if (track) layers.push(track);
      if (foreground) layers.push(foreground);
      localLayers = layers;
      localMinecarts = minecarts;
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
    if (!runtime || syncing || (localLayers.length === 0 && localMinecarts.length === 0)) {
      timer = window.setTimeout(renderTick, LOCAL_TICK_MS);
      return;
    }

    const snapshot =
      runtime.runState === "running"
        ? motionAt(runtime.motion)
        : { distance: runtime.motion.distanceAtSegmentStart, speed: runtime.motion.speedAtSegmentStart };

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

    if (localMinecarts.length > 0) {
      const offsetById = new Map<string, number>();
      for (const cart of localMinecarts) {
        const offset = runtime.rattleEnabled
          ? cartRattleOffset(
              cart.seed,
              snapshot.distance,
              snapshot.speed,
              runtime.rattleStrength,
              runtime.rattleStartSpeed,
            )
          : 0;
        offsetById.set(cart.clone.id, offset);
      }

      void OBR.scene.local.updateItems(
        localMinecarts.map((cart) => cart.clone),
        (items) => {
          for (const item of items) {
            const cart = localMinecarts.find((entry) => entry.clone.id === item.id);
            if (!cart) continue;
            item.position.y = cart.baseY + (offsetById.get(item.id) ?? 0);
          }
        },
        true,
      );
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
      previous.floorIds.join("|") !== next.floorIds.join("|") ||
      previous.trackIds.join("|") !== next.trackIds.join("|") ||
      previous.backgroundIds.join("|") !== next.backgroundIds.join("|") ||
      previous.foregroundIds.join("|") !== next.foregroundIds.join("|") ||
      previous.minecartIds.join("|") !== next.minecartIds.join("|") ||
      previous.floorMultiplier !== next.floorMultiplier ||
      previous.backgroundMultiplier !== next.backgroundMultiplier ||
      previous.foregroundMultiplier !== next.foregroundMultiplier;

    if (sourceChanged || (localLayers.length === 0 && localMinecarts.length === 0)) {
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
    <style>
      * { box-sizing: border-box; }
      body { margin: 0; font-family: Arial, sans-serif; font-size: 12px; }
      .app { padding: 8px; max-height: 480px; overflow-y: auto; }
      h2 { margin: 0; text-align: center; font-size: 17px; }
      #status { margin: 4px 0 7px; text-align: center; font-size: 11px; min-height: 14px; }
      button, input { font: inherit; }
      button { padding: 4px 6px; cursor: pointer; }
      button:disabled { cursor: default; opacity: .55; }
      .chase-controls { display: grid; grid-template-columns: repeat(4, 1fr); gap: 4px; margin-bottom: 6px; }
      details { border: 1px solid rgba(128,128,128,.45); border-radius: 5px; margin: 5px 0; }
      summary { cursor: pointer; font-weight: 700; padding: 5px 7px; user-select: none; }
      .section { padding: 2px 7px 7px; }
      .layer-row { display: grid; grid-template-columns: 92px 1fr; align-items: center; gap: 6px; margin: 4px 0; }
      .layer-row span { font-size: 11px; opacity: .85; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .row { display: flex; align-items: center; justify-content: space-between; gap: 7px; margin: 5px 0; }
      .row label { flex: 1; }
      .number { width: 70px; }
      .range-row { margin: 5px 0 7px; }
      .range-head { display: flex; justify-content: space-between; margin-bottom: 2px; }
      input[type=range] { width: 100%; margin: 0; }
      .two-col { display: grid; grid-template-columns: 1fr 1fr; gap: 5px; }
      .two-col button { width: 100%; }
      .hint { font-size: 10px; opacity: .75; margin: 5px 0 0; }
      .player { text-align: center; padding: 16px 8px; }
    </style>
    <div class="app">
      <h2>Minecart Scroll</h2>
      <p id="status">Waiting for Owlbear...</p>

      <div id="playerPanel" hidden class="player">
        <strong>Chase View</strong>
        <p>The GM controls Minecart Scroll.</p>
        <p>The chase runs with this panel closed.</p>
      </div>

      <div id="gmPanel" hidden>
        <div class="chase-controls">
          <button id="startButton">Start</button>
          <button id="pauseButton" disabled>Pause</button>
          <button id="resumeButton" disabled>Resume</button>
          <button id="stopButton" disabled>Stop</button>
        </div>

        <details open>
          <summary>Layers</summary>
          <div class="section">
            <div class="layer-row"><button id="setFloorButton">Set Floor</button><span id="floorStatus">Not set (optional)</span></div>
            <div class="layer-row"><button id="setBackgroundButton">Set Background</button><span id="backgroundStatus">Not set</span></div>
            <div class="layer-row"><button id="setTrackButton">Set Track</button><span id="trackStatus">Not set</span></div>
            <div class="layer-row"><button id="setMinecartsButton">Set Minecarts</button><span id="minecartsStatus">Not set (optional)</span></div>
            <div class="layer-row"><button id="setForegroundButton">Set Foreground</button><span id="foregroundStatus">Not set (optional)</span></div>
          </div>
        </details>

        <details open>
          <summary>Motion</summary>
          <div class="section">
            <div class="range-row">
              <div class="range-head"><span>Chase Speed</span><strong><span id="targetSpeedValue">150</span> / 1000</strong></div>
              <input id="targetSpeedSlider" type="range" min="0" max="1000" value="150" step="25">
            </div>
            <div class="row"><span>Current Speed</span><strong id="currentSpeedValue">0</strong></div>
            <div class="range-row">
              <div class="range-head"><span>Acceleration / Braking</span><strong id="accelerationValue">200</strong></div>
              <input id="accelerationSlider" type="range" min="25" max="1000" value="200" step="25">
            </div>
            <div class="range-row">
              <div class="range-head"><span>Floor Speed</span><strong><span id="floorMultiplierValue">45</span>%</strong></div>
              <input id="floorMultiplierSlider" type="range" min="0" max="100" value="45" step="5">
            </div>
            <div class="range-row">
              <div class="range-head"><span>Background Speed</span><strong><span id="backgroundMultiplierValue">40</span>%</strong></div>
              <input id="backgroundMultiplierSlider" type="range" min="0" max="100" value="40" step="5">
            </div>
            <div class="range-row">
              <div class="range-head"><span>Foreground Speed</span><strong><span id="foregroundMultiplierValue">140</span>%</strong></div>
              <input id="foregroundMultiplierSlider" type="range" min="100" max="250" value="140" step="5">
            </div>
            <p class="hint">Parallax speeds apply on the next Start.</p>
          </div>
        </details>

        <details>
          <summary>Minecart Rattle</summary>
          <div class="section">
            <div class="row">
              <label><input id="rattleEnabledCheckbox" type="checkbox" checked> Enable independent rattle</label>
            </div>
            <div class="range-row">
              <div class="range-head"><span>Rattle Strength</span><strong><span id="rattleStrengthValue">100</span>%</strong></div>
              <input id="rattleStrengthSlider" type="range" min="0" max="200" value="100" step="10">
            </div>
            <div class="row">
              <label for="rattleStartSpeedInput">Rattle Starts At</label>
              <input id="rattleStartSpeedInput" class="number" type="number" min="0" max="500" value="100" step="25">
            </div>
            <p class="hint">Each selected cart gets its own vertical rail-chatter pattern. Rattle grows with chase speed.</p>
          </div>
        </details>

        <details>
          <summary>Layout & Anchor</summary>
          <div class="section">
            <div class="row"><label>Anchor X</label><input id="anchorXInput" class="number" type="number" value="0" step="50"></div>
            <div class="row"><label>Anchor Y</label><input id="anchorYInput" class="number" type="number" value="0" step="50"></div>
            <div class="two-col">
              <button id="goToAnchorButton">Go to Anchor</button>
              <label style="display:flex;align-items:center;gap:4px;"><input id="focusOnStartCheckbox" type="checkbox" checked> Focus on Start</label>
            </div>
            <hr style="border:0;border-top:1px solid rgba(128,128,128,.35);margin:7px 0;">
            <div class="row"><label>Floor Y Offset</label><input id="floorYOffsetInput" class="number" type="number" value="0" step="10"></div>
            <div class="row"><label>Track Y Offset</label><input id="trackYOffsetInput" class="number" type="number" value="0" step="10"></div>
            <div class="row"><label>Foreground Y Offset</label><input id="foregroundYOffsetInput" class="number" type="number" value="0" step="10"></div>
            <div class="row"><label>Floor Seam Overlap</label><input id="floorOverlapInput" class="number" type="number" min="0" max="50" value="0" step="1"></div>
            <div class="row"><label>Background Seam Overlap</label><input id="backgroundOverlapInput" class="number" type="number" min="0" max="50" value="0" step="1"></div>
            <div class="row"><label>Foreground Seam Overlap</label><input id="foregroundOverlapInput" class="number" type="number" min="0" max="50" value="0" step="1"></div>
            <p class="hint">Layout changes apply on the next Start. Track overlap remains 2 px.</p>
          </div>
        </details>

        <details>
          <summary>Scene Settings</summary>
          <div class="section">
            <div class="two-col">
              <button id="saveButton">Save Settings</button>
              <button id="loadButton">Load Settings</button>
            </div>
            <p class="hint">Assignments and controls are saved to this Owlbear scene.</p>
          </div>
        </details>
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
  status.textContent = "GM controls ready — background chase engine active.";

  const floorStatus = document.querySelector<HTMLSpanElement>("#floorStatus")!;
  const trackStatus = document.querySelector<HTMLSpanElement>("#trackStatus")!;
  const backgroundStatus = document.querySelector<HTMLSpanElement>("#backgroundStatus")!;
  const foregroundStatus = document.querySelector<HTMLSpanElement>("#foregroundStatus")!;
  const minecartsStatus = document.querySelector<HTMLSpanElement>("#minecartsStatus")!;
  const setFloorButton = document.querySelector<HTMLButtonElement>("#setFloorButton")!;
  const setTrackButton = document.querySelector<HTMLButtonElement>("#setTrackButton")!;
  const setBackgroundButton = document.querySelector<HTMLButtonElement>("#setBackgroundButton")!;
  const setForegroundButton = document.querySelector<HTMLButtonElement>("#setForegroundButton")!;
  const setMinecartsButton = document.querySelector<HTMLButtonElement>("#setMinecartsButton")!;
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
  const currentSpeedValue = document.querySelector<HTMLElement>("#currentSpeedValue")!;
  const accelerationSlider = document.querySelector<HTMLInputElement>("#accelerationSlider")!;
  const accelerationValue = document.querySelector<HTMLElement>("#accelerationValue")!;
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
  const pauseButton = document.querySelector<HTMLButtonElement>("#pauseButton")!;
  const resumeButton = document.querySelector<HTMLButtonElement>("#resumeButton")!;
  const stopButton = document.querySelector<HTMLButtonElement>("#stopButton")!;

  let floorIds: string[] = [];
  let trackIds: string[] = [];
  let backgroundIds: string[] = [];
  let foregroundIds: string[] = [];
  let minecartIds: string[] = [];
  let runtime: RuntimeState | null = await readRuntime();

  function currentState(): RunState {
    return runtime?.runState ?? "stopped";
  }

  function updateLayerLabels(): void {
    floorStatus.textContent = floorIds.length >= 2 ? `${floorIds.length} images` : "Not set (optional)";
    trackStatus.textContent = trackIds.length >= 2 ? `${trackIds.length} images` : "Not set";
    backgroundStatus.textContent = backgroundIds.length >= 2 ? `${backgroundIds.length} images` : "Not set";
    foregroundStatus.textContent = foregroundIds.length >= 2 ? `${foregroundIds.length} images` : "Not set (optional)";
    minecartsStatus.textContent = minecartIds.length >= 1 ? `${minecartIds.length} cart${minecartIds.length === 1 ? "" : "s"}` : "Not set (optional)";
  }

  function updateButtons(): void {
    const state = currentState();
    const locked = state !== "stopped";
    startButton.disabled = locked;
    pauseButton.disabled = state !== "running";
    resumeButton.disabled = state !== "paused";
    stopButton.disabled = state === "stopped";
    setFloorButton.disabled = locked;
    setTrackButton.disabled = locked;
    setBackgroundButton.disabled = locked;
    setForegroundButton.disabled = locked;
    setMinecartsButton.disabled = locked;
    loadButton.disabled = locked;
    floorMultiplierSlider.disabled = locked;
    backgroundMultiplierSlider.disabled = locked;
    foregroundMultiplierSlider.disabled = locked;
    floorYOffsetInput.disabled = locked;
    trackYOffsetInput.disabled = locked;
    foregroundYOffsetInput.disabled = locked;
    floorOverlapInput.disabled = locked;
    backgroundOverlapInput.disabled = locked;
    foregroundOverlapInput.disabled = locked;
    rattleEnabledCheckbox.disabled = locked;
    rattleStrengthSlider.disabled = locked;
    rattleStartSpeedInput.disabled = locked;
  }

  function makeSettings(): SavedSettings {
    return {
      version: 4,
      floorIds: [...floorIds],
      trackIds: [...trackIds],
      backgroundIds: [...backgroundIds],
      foregroundIds: [...foregroundIds],
      minecartIds: [...minecartIds],
      anchorX: Number.isFinite(Number(anchorXInput.value)) ? Number(anchorXInput.value) : 0,
      anchorY: Number.isFinite(Number(anchorYInput.value)) ? Number(anchorYInput.value) : 0,
      floorYOffset: clampNumber(Number(floorYOffsetInput.value), -10000, 10000, 0),
      trackYOffset: clampNumber(Number(trackYOffsetInput.value), -10000, 10000, 0),
      foregroundYOffset: clampNumber(Number(foregroundYOffsetInput.value), -10000, 10000, 0),
      floorOverlap: clampNumber(Number(floorOverlapInput.value), 0, 50, 0),
      backgroundOverlap: clampNumber(Number(backgroundOverlapInput.value), 0, 50, 0),
      foregroundOverlap: clampNumber(Number(foregroundOverlapInput.value), 0, 50, 0),
      targetSpeed: clampNumber(Number(targetSpeedSlider.value), 0, MAX_CHASE_SPEED, 150),
      acceleration: clampNumber(Number(accelerationSlider.value), 25, 1000, 200),
      floorMultiplier: clampNumber(Number(floorMultiplierSlider.value), 0, 100, 45) / 100,
      backgroundMultiplier: clampNumber(Number(backgroundMultiplierSlider.value), 0, 100, 40) / 100,
      foregroundMultiplier: clampNumber(Number(foregroundMultiplierSlider.value), 100, 250, 140) / 100,
      rattleEnabled: rattleEnabledCheckbox.checked,
      rattleStrength: clampNumber(Number(rattleStrengthSlider.value), 0, 200, 100) / 100,
      rattleStartSpeed: clampNumber(Number(rattleStartSpeedInput.value), 0, 500, DEFAULT_RATTLE_START_SPEED),
      focusOnStart: focusOnStartCheckbox.checked,
    };
  }

  function applySettings(settings: SavedSettings): void {
    floorIds = [...settings.floorIds];
    trackIds = [...settings.trackIds];
    backgroundIds = [...settings.backgroundIds];
    foregroundIds = [...settings.foregroundIds];
    minecartIds = [...settings.minecartIds];
    anchorXInput.value = String(settings.anchorX);
    anchorYInput.value = String(settings.anchorY);
    floorYOffsetInput.value = String(settings.floorYOffset);
    trackYOffsetInput.value = String(settings.trackYOffset);
    foregroundYOffsetInput.value = String(settings.foregroundYOffset);
    floorOverlapInput.value = String(settings.floorOverlap);
    backgroundOverlapInput.value = String(settings.backgroundOverlap);
    foregroundOverlapInput.value = String(settings.foregroundOverlap);
    targetSpeedSlider.value = String(settings.targetSpeed);
    targetSpeedValue.textContent = String(Math.round(settings.targetSpeed));
    accelerationSlider.value = String(settings.acceleration);
    accelerationValue.textContent = String(Math.round(settings.acceleration));
    floorMultiplierSlider.value = String(settings.floorMultiplier * 100);
    floorMultiplierValue.textContent = String(Math.round(settings.floorMultiplier * 100));
    backgroundMultiplierSlider.value = String(settings.backgroundMultiplier * 100);
    backgroundMultiplierValue.textContent = String(Math.round(settings.backgroundMultiplier * 100));
    foregroundMultiplierSlider.value = String(settings.foregroundMultiplier * 100);
    foregroundMultiplierValue.textContent = String(Math.round(settings.foregroundMultiplier * 100));
    rattleEnabledCheckbox.checked = settings.rattleEnabled;
    rattleStrengthSlider.value = String(settings.rattleStrength * 100);
    rattleStrengthValue.textContent = String(Math.round(settings.rattleStrength * 100));
    rattleStartSpeedInput.value = String(settings.rattleStartSpeed);
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

  async function getSelectedImages(minimumCount: number): Promise<Image[] | null> {
    const selection = await OBR.player.getSelection();
    if (!selection || selection.length < minimumCount) {
      status.textContent = minimumCount === 1 ? "Select at least ONE image first." : "Select at least TWO images first.";
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

  function overlapsOtherAssignments(ids: string[], kind: LayerKind | "minecarts"): boolean {
    const otherIds = [
      ...(kind === "floor" ? [] : floorIds),
      ...(kind === "track" ? [] : trackIds),
      ...(kind === "background" ? [] : backgroundIds),
      ...(kind === "foreground" ? [] : foregroundIds),
      ...(kind === "minecarts" ? [] : minecartIds),
    ];
    const others = new Set(otherIds);
    return ids.some((id) => others.has(id));
  }

  async function setLayer(kind: LayerKind): Promise<void> {
    if (currentState() !== "stopped") return;
    const images = await getSelectedImages(2);
    if (!images) return;
    const ids = images.map((image) => image.id);
    if (overlapsOtherAssignments(ids, kind)) {
      status.textContent = "Each Minecart Scroll assignment must use different images.";
      return;
    }
    if (kind === "floor") floorIds = ids;
    if (kind === "track") trackIds = ids;
    if (kind === "background") backgroundIds = ids;
    if (kind === "foreground") foregroundIds = ids;
    updateLayerLabels();
    await OBR.player.deselect();
    status.textContent = `${kind[0].toUpperCase()}${kind.slice(1)} layer set.`;
  }

  async function setMinecarts(): Promise<void> {
    if (currentState() !== "stopped") return;
    const images = await getSelectedImages(1);
    if (!images) return;
    const ids = images.map((image) => image.id);
    if (overlapsOtherAssignments(ids, "minecarts")) {
      status.textContent = "Minecarts cannot also be assigned to a scrolling layer.";
      return;
    }
    minecartIds = ids;
    updateLayerLabels();
    await OBR.player.deselect();
    status.textContent = `${ids.length} minecart${ids.length === 1 ? "" : "s"} set for independent rattle.`;
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

  setFloorButton.addEventListener("click", () => void setLayer("floor"));
  setTrackButton.addEventListener("click", () => void setLayer("track"));
  setBackgroundButton.addEventListener("click", () => void setLayer("background"));
  setForegroundButton.addEventListener("click", () => void setLayer("foreground"));
  setMinecartsButton.addEventListener("click", () => void setMinecarts());
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

  floorMultiplierSlider.addEventListener("input", () => {
    floorMultiplierValue.textContent = floorMultiplierSlider.value;
  });
  backgroundMultiplierSlider.addEventListener("input", () => {
    backgroundMultiplierValue.textContent = backgroundMultiplierSlider.value;
  });
  foregroundMultiplierSlider.addEventListener("input", () => {
    foregroundMultiplierValue.textContent = foregroundMultiplierSlider.value;
  });
  rattleStrengthSlider.addEventListener("input", () => {
    rattleStrengthValue.textContent = rattleStrengthSlider.value;
  });

  startButton.addEventListener("click", async () => {
    const settings = makeSettings();
    if (settings.trackIds.length < 2 || settings.backgroundIds.length < 2) {
      status.textContent = "Set Track and Background first.";
      return;
    }
    if (settings.floorIds.length === 1 || settings.foregroundIds.length === 1) {
      status.textContent = "Floor and Foreground need at least two images when assigned.";
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
    void (async () => {
      await restoreAssignedSourcesWhenStopped();
      await runLocalRendererBackground();
    })();
    void runControllerBackground();
  });
} else {
  renderUI();
  OBR.onReady(() => void runUI());
}
