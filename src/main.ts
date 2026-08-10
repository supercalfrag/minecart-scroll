import OBR, { isImage, type Image } from "@owlbear-rodeo/sdk";

const SETTINGS_KEY = "com.supercalfrag.minecart-scroll/settings";
const TRACK_OVERLAP = 2;
const TRACK_Z_GAP = 100000;
const FOREGROUND_Z_GAP = 200000;
const INTERACTION_RENEW_MS = 20000;

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

type SavedSettings = {
  version: 2;
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

document.querySelector<HTMLDivElement>("#app")!.innerHTML = `
  <div style="font-family: Arial, sans-serif; padding: 14px;">
    <h2 style="margin: 0 0 8px; text-align: center;">Minecart Scroll</h2>
    <p id="status" style="text-align:center; margin: 6px 0 12px;">Waiting for Owlbear...</p>

    <div id="playerPanel" hidden style="text-align:center; padding: 18px 8px;">
      <h3>Chase View</h3>
      <p>The GM controls Minecart Scroll.</p>
      <p>You do not need this panel open to see the chase.</p>
    </div>

    <div id="gmPanel" hidden style="max-height: 540px; overflow-y: auto; padding-right: 4px;">
      <fieldset>
        <legend><strong>Layers</strong></legend>
        <button id="setTrackButton">Set Track</button>
        <span id="trackStatus">Not set</span><br><br>

        <button id="setBackgroundButton">Set Background</button>
        <span id="backgroundStatus">Not set</span><br><br>

        <button id="setForegroundButton">Set Foreground</button>
        <span id="foregroundStatus">Not set (optional)</span>
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
        <label>Track Y Offset:
          <input id="trackYOffsetInput" type="number" value="0" step="10" style="width:90px;">
        </label>
        <br><br>
        <label>Foreground Y Offset:
          <input id="foregroundYOffsetInput" type="number" value="0" step="10" style="width:90px;">
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
        <label>Main Target Speed: <strong><span id="targetSpeedValue">150</span></strong></label>
        <input id="targetSpeedSlider" type="range" min="0" max="1000" value="150" step="25" style="width:100%;">

        <p style="margin:8px 0;">Current Speed: <strong><span id="currentSpeedValue">0</span></strong></p>

        <label>Acceleration / Braking: <strong><span id="accelerationValue">200</span></strong></label>
        <input id="accelerationSlider" type="range" min="25" max="1000" value="200" step="25" style="width:100%;">

        <br><br>
        <label>Background Speed: <strong><span id="backgroundMultiplierValue">40</span>%</strong></label>
        <input id="backgroundMultiplierSlider" type="range" min="0" max="100" value="40" step="5" style="width:100%;">

        <br><br>
        <label>Foreground Speed: <strong><span id="foregroundMultiplierValue">140</span>%</strong></label>
        <input id="foregroundMultiplierSlider" type="range" min="100" max="250" value="140" step="5" style="width:100%;">
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
  const emergencyResetButton = document.querySelector<HTMLButtonElement>("#emergencyResetButton")!;

  let trackIds: string[] = [];
  let backgroundIds: string[] = [];
  let foregroundIds: string[] = [];

  let anchorX = 0;
  let anchorY = 0;
  let trackYOffset = 0;
  let foregroundYOffset = 0;
  let backgroundOverlap = 0;
  let foregroundOverlap = 0;

  let targetSpeed = 150;
  let currentSpeed = 0;
  let acceleration = 200;
  let backgroundMultiplier = 0.4;
  let foregroundMultiplier = 1.4;

  let runState: RunState = "stopped";
  let activeTrack: LoopLayer | null = null;
  let activeBackground: LoopLayer | null = null;
  let activeForeground: LoopLayer | null = null;

  type InteractionManager = Awaited<ReturnType<typeof OBR.interaction.startItemInteraction>>;
  let interactionUpdate: InteractionManager[0] | null = null;
  let interactionStop: InteractionManager[1] | null = null;

  let animationFrame = 0;
  let renewTimer = 0;
  let renewing = false;
  let lastTime = 0;

  function clampNumber(value: number, min: number, max: number, fallback: number): number {
    if (!Number.isFinite(value)) return fallback;
    return Math.max(min, Math.min(max, value));
  }

  function readControls(): void {
    anchorX = Number.isFinite(Number(anchorXInput.value)) ? Number(anchorXInput.value) : 0;
    anchorY = Number.isFinite(Number(anchorYInput.value)) ? Number(anchorYInput.value) : 0;
    trackYOffset = clampNumber(Number(trackYOffsetInput.value), -10000, 10000, 0);
    foregroundYOffset = clampNumber(Number(foregroundYOffsetInput.value), -10000, 10000, 0);
    backgroundOverlap = clampNumber(Number(backgroundOverlapInput.value), 0, 50, 0);
    foregroundOverlap = clampNumber(Number(foregroundOverlapInput.value), 0, 50, 0);
  }

  function updateLayerLabels(): void {
    trackStatus.textContent = trackIds.length >= 2 ? `${trackIds.length} images` : "Not set";
    backgroundStatus.textContent = backgroundIds.length >= 2 ? `${backgroundIds.length} images` : "Not set";
    foregroundStatus.textContent = foregroundIds.length >= 2 ? `${foregroundIds.length} images` : "Not set (optional)";
  }

  function updateRunButtons(): void {
    startButton.disabled = runState !== "stopped" || renewing;
    pauseButton.disabled = runState !== "running" || renewing;
    resumeButton.disabled = runState !== "paused" || renewing;
    stopButton.disabled = runState === "stopped" || renewing;
    setTrackButton.disabled = runState !== "stopped";
    setBackgroundButton.disabled = runState !== "stopped";
    setForegroundButton.disabled = runState !== "stopped";
    loadButton.disabled = runState !== "stopped";
  }

  function applyTargetSpeed(value: number): void {
    targetSpeed = clampNumber(value, 0, 750, 150);
    targetSpeedSlider.value = String(targetSpeed);
    targetSpeedValue.textContent = String(Math.round(targetSpeed));
  }

  function applyAcceleration(value: number): void {
    acceleration = clampNumber(value, 25, 1000, 200);
    accelerationSlider.value = String(acceleration);
    accelerationValue.textContent = String(Math.round(acceleration));
  }

  function applyBackgroundMultiplier(percent: number): void {
    const value = clampNumber(percent, 0, 100, 40);
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

  targetSpeedSlider.addEventListener("input", () => applyTargetSpeed(Number(targetSpeedSlider.value)));
  accelerationSlider.addEventListener("input", () => applyAcceleration(Number(accelerationSlider.value)));
  backgroundMultiplierSlider.addEventListener("input", () => applyBackgroundMultiplier(Number(backgroundMultiplierSlider.value)));
  foregroundMultiplierSlider.addEventListener("input", () => applyForegroundMultiplier(Number(foregroundMultiplierSlider.value)));

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

  function overlapsOtherLayers(ids: string[], excluded: "track" | "background" | "foreground"): boolean {
    const otherIds = [
      ...(excluded === "track" ? [] : trackIds),
      ...(excluded === "background" ? [] : backgroundIds),
      ...(excluded === "foreground" ? [] : foregroundIds),
    ];
    const others = new Set(otherIds);
    return ids.some((id) => others.has(id));
  }

  async function setLayer(kind: "track" | "background" | "foreground"): Promise<void> {
    if (runState !== "stopped") {
      status.textContent = "Stop the chase before changing layers.";
      return;
    }

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

  setTrackButton.addEventListener("click", () => void setLayer("track"));
  setBackgroundButton.addEventListener("click", () => void setLayer("background"));
  setForegroundButton.addEventListener("click", () => void setLayer("foreground"));

  function makeSavedSettings(): SavedSettings {
    readControls();
    return {
      version: 2,
      trackIds: [...trackIds],
      backgroundIds: [...backgroundIds],
      foregroundIds: [...foregroundIds],
      anchorX,
      anchorY,
      trackYOffset,
      foregroundYOffset,
      backgroundOverlap,
      foregroundOverlap,
      targetSpeed,
      acceleration,
      backgroundMultiplier,
      foregroundMultiplier,
      focusOnStart: focusOnStartCheckbox.checked,
    };
  }

  function parseSavedSettings(raw: unknown): SavedSettings | null {
    if (!raw || typeof raw !== "object") return null;
    const value = raw as Partial<SavedSettings>;
    return {
      version: 2,
      trackIds: Array.isArray(value.trackIds) ? value.trackIds.filter((id): id is string => typeof id === "string") : [],
      backgroundIds: Array.isArray(value.backgroundIds) ? value.backgroundIds.filter((id): id is string => typeof id === "string") : [],
      foregroundIds: Array.isArray(value.foregroundIds) ? value.foregroundIds.filter((id): id is string => typeof id === "string") : [],
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

  function applySavedSettings(saved: SavedSettings): void {
    trackIds = [...saved.trackIds];
    backgroundIds = [...saved.backgroundIds];
    foregroundIds = [...saved.foregroundIds];

    anchorXInput.value = String(saved.anchorX);
    anchorYInput.value = String(saved.anchorY);
    trackYOffsetInput.value = String(saved.trackYOffset);
    foregroundYOffsetInput.value = String(saved.foregroundYOffset);
    backgroundOverlapInput.value = String(saved.backgroundOverlap);
    foregroundOverlapInput.value = String(saved.foregroundOverlap);
    focusOnStartCheckbox.checked = saved.focusOnStart;

    applyTargetSpeed(saved.targetSpeed);
    applyAcceleration(saved.acceleration);
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
    return [activeBackground, activeTrack, activeForeground].filter((layer): layer is LoopLayer => layer !== null);
  }

  function getActiveImages(): Image[] {
    return getActiveLayers().flatMap((layer) => layer.images);
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
        if (!layer) continue;
        const x = layer.positions.get(item.id);
        if (x !== undefined) item.position.x = x;
        item.position.y = layer.y;
      }
    });
  }

  function closeInteraction(): void {
    const stop = interactionStop;
    interactionUpdate = null;
    interactionStop = null;

    if (stop) {
      try {
        stop();
      } catch (error) {
        console.error("Could not stop Minecart Scroll interaction:", error);
      }
    }
  }

  async function openInteraction(): Promise<void> {
    // Defensive cleanup: this instance must never own two interactions at once.
    closeInteraction();

    const activeImages = getActiveImages();
    const ids = activeImages.map((image) => image.id);
    const refreshed = await OBR.scene.items.getItems(ids);
    const refreshedImages = refreshed.filter(isImage);
    if (refreshedImages.length !== ids.length) throw new Error("One or more scrolling images disappeared from the scene.");

    const interaction = await OBR.interaction.startItemInteraction(refreshedImages);
    interactionUpdate = interaction[0];
    interactionStop = interaction[1];
  }

  function clearRenewTimer(): void {
    if (renewTimer) window.clearTimeout(renewTimer);
    renewTimer = 0;
  }

  function cleanupInteractionForPageExit(): void {
    clearRenewTimer();
    if (animationFrame) cancelAnimationFrame(animationFrame);
    animationFrame = 0;
    closeInteraction();
  }

  async function pauseForHiddenPanel(): Promise<void> {
    if (document.visibilityState !== "hidden" || runState !== "running" || renewing) return;

    clearRenewTimer();
    if (animationFrame) cancelAnimationFrame(animationFrame);
    animationFrame = 0;

    try {
      await commitPositions();
    } catch (error) {
      console.error("Could not commit positions while panel was hidden:", error);
    } finally {
      closeInteraction();
      currentSpeed = 0;
      currentSpeedValue.textContent = "0";
      runState = "paused";
      updateRunButtons();
      status.textContent = "Paused because the Minecart Scroll panel was hidden. Press Resume to continue.";
    }
  }

  window.addEventListener("pagehide", cleanupInteractionForPageExit);
  window.addEventListener("beforeunload", cleanupInteractionForPageExit);
  document.addEventListener("visibilitychange", () => void pauseForHiddenPanel());

  function scheduleRenewal(): void {
    clearRenewTimer();
    renewTimer = window.setTimeout(() => void renewInteraction(), INTERACTION_RENEW_MS);
  }

  async function renewInteraction(): Promise<void> {
    if (runState !== "running" || renewing) return;
    renewing = true;
    updateRunButtons();
    try {
      cancelAnimationFrame(animationFrame);
      await commitPositions();
      closeInteraction();
      if (runState === "running") {
        await openInteraction();
        lastTime = performance.now();
        animationFrame = requestAnimationFrame(animate);
        scheduleRenewal();
      }
    } catch (error) {
      console.error("Interaction renewal failed:", error);
      closeInteraction();
      currentSpeed = 0;
      currentSpeedValue.textContent = "0";
      runState = "paused";
      status.textContent = "Network sync renewal failed; chase paused safely. Press Resume to retry.";
    } finally {
      renewing = false;
      updateRunButtons();
    }
  }

  function approach(current: number, target: number, maxDelta: number): number {
    const difference = target - current;
    if (Math.abs(difference) <= maxDelta) return target;
    return current + Math.sign(difference) * maxDelta;
  }

  function animate(time: number): void {
    if (runState !== "running") return;

    const deltaTime = Math.min((time - lastTime) / 1000, 0.1);
    lastTime = time;
    currentSpeed = approach(currentSpeed, targetSpeed, acceleration * deltaTime);
    currentSpeedValue.textContent = String(Math.round(currentSpeed));

    if (activeTrack) moveLayer(activeTrack, deltaTime, 1);
    if (activeBackground) moveLayer(activeBackground, deltaTime, backgroundMultiplier);
    if (activeForeground) moveLayer(activeForeground, deltaTime, foregroundMultiplier);

    if (interactionUpdate) {
      interactionUpdate((draft) => {
        const items = Array.isArray(draft) ? draft : [draft];

        for (const item of items) {
          const layer = layerForItem(item.id);
          if (!layer) continue;
          const x = layer.positions.get(item.id);
          if (x !== undefined) item.position.x = x;
          item.position.y = layer.y;
        }
      });
    }

    animationFrame = requestAnimationFrame(animate);
  }

  async function prepareChase(): Promise<void> {
    readControls();
    const trackImages = await getLayerImages(trackIds, "Track", true);
    const backgroundImages = await getLayerImages(backgroundIds, "Background", true);
    const foregroundImages = await getLayerImages(foregroundIds, "Foreground", false);

    const combined = [...trackImages, ...backgroundImages, ...foregroundImages];
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
  }

  startButton.addEventListener("click", async () => {
    if (runState !== "stopped" || renewing) return;
    if (!(await OBR.scene.isReady())) {
      status.textContent = "Open a scene first.";
      return;
    }

    try {
      await prepareChase();
      await OBR.player.deselect();
      if (focusOnStartCheckbox.checked) await goToAnchor();
      currentSpeed = 0;
      currentSpeedValue.textContent = "0";
      await openInteraction();
      runState = "running";
      lastTime = performance.now();
      animationFrame = requestAnimationFrame(animate);
      scheduleRenewal();
      updateRunButtons();
      status.textContent = activeForeground ? "Three-layer parallax chase running!" : "Parallax chase running!";
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : "Could not start the chase.";
      activeTrack = null;
      activeBackground = null;
      activeForeground = null;
      runState = "stopped";
      updateRunButtons();
    }
  });

  pauseButton.addEventListener("click", async () => {
    if (runState !== "running" || renewing) return;
    clearRenewTimer();
    cancelAnimationFrame(animationFrame);
    await commitPositions();
    closeInteraction();
    currentSpeed = 0;
    currentSpeedValue.textContent = "0";
    runState = "paused";
    updateRunButtons();
    status.textContent = "Paused — positions preserved.";
  });

  resumeButton.addEventListener("click", async () => {
    if (runState !== "paused" || renewing) return;
    try {
      currentSpeed = 0;
      currentSpeedValue.textContent = "0";
      await openInteraction();
      runState = "running";
      lastTime = performance.now();
      animationFrame = requestAnimationFrame(animate);
      scheduleRenewal();
      updateRunButtons();
      status.textContent = "Resumed — accelerating back to target speed.";
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : "Could not resume the chase.";
    }
  });

  stopButton.addEventListener("click", async () => {
    if (runState === "stopped" || renewing) return;
    clearRenewTimer();
    cancelAnimationFrame(animationFrame);
    animationFrame = 0;

    if (runState === "running") await commitPositions();
    closeInteraction();

    currentSpeed = 0;
    currentSpeedValue.textContent = "0";
    activeTrack = null;
    activeBackground = null;
    activeForeground = null;
    runState = "stopped";
    updateRunButtons();
    status.textContent = "Stopped. Start will rebuild the chase at the anchor.";
  });

  emergencyResetButton.addEventListener("click", () => {
    clearRenewTimer();
    if (animationFrame) cancelAnimationFrame(animationFrame);
    animationFrame = 0;
    closeInteraction();
    renewing = false;
    currentSpeed = 0;
    currentSpeedValue.textContent = "0";
    activeTrack = null;
    activeBackground = null;
    activeForeground = null;
    runState = "stopped";
    updateRunButtons();
    status.textContent = "Emergency reset complete. Current interaction stopped; saved settings were kept.";
  });

  updateLayerLabels();
  updateRunButtons();
  await loadSettings(true);
  updateRunButtons();
});
