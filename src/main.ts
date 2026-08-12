import OBR, { isImage, type Image } from "@owlbear-rodeo/sdk";

const SETTINGS_KEY = "com.supercalfrag.minecart-scroll/settings";
const TRACK_OVERLAP = 2;
const FLOOR_Z_GAP = 100000;
const TRACK_Z_GAP = 100000;
const FOREGROUND_Z_GAP = 200000;
const INTERACTION_RENEW_MS = 20000;
const MINECART_DROP_SETTLE_MS = 250;

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
  version: 3;
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
        <button id="setFloorButton">Set Floor</button>
        <span id="floorStatus">Not set (optional)</span><br><br>

        <button id="setBackgroundButton">Set Background</button>
        <span id="backgroundStatus">Not set</span><br><br>

        <button id="setTrackButton">Set Track</button>
        <span id="trackStatus">Not set</span><br><br>

        <button id="setForegroundButton">Set Foreground</button>
        <span id="foregroundStatus">Not set (optional)</span><br><br>

        <button id="setMinecartsButton">Set Minecarts</button>
        <span id="minecartsStatus">Not set (optional)</span>
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
        <label>Floor Speed: <strong><span id="floorMultiplierValue">45</span>%</strong></label>
        <input id="floorMultiplierSlider" type="range" min="0" max="100" value="45" step="5" style="width:100%;">

        <br><br>
        <label>Background Speed: <strong><span id="backgroundMultiplierValue">40</span>%</strong></label>
        <input id="backgroundMultiplierSlider" type="range" min="0" max="100" value="40" step="5" style="width:100%;">

        <br><br>
        <label>Foreground Speed: <strong><span id="foregroundMultiplierValue">140</span>%</strong></label>
        <input id="foregroundMultiplierSlider" type="range" min="100" max="250" value="140" step="5" style="width:100%;">
      </fieldset>

      <br>

      <fieldset>
        <legend><strong>Minecart Rattle</strong></legend>
        <label>
          <input id="rattleEnabledCheckbox" type="checkbox" checked>
          Enable independent vertical rattle
        </label>
        <br><br>
        <label>Rattle Strength: <strong><span id="rattleStrengthValue">100</span>%</strong></label>
        <input id="rattleStrengthSlider" type="range" min="0" max="200" value="100" step="10" style="width:100%;">
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
  const pauseButton = document.querySelector<HTMLButtonElement>("#pauseButton")!;
  const resumeButton = document.querySelector<HTMLButtonElement>("#resumeButton")!;
  const stopButton = document.querySelector<HTMLButtonElement>("#stopButton")!;
  const emergencyResetButton = document.querySelector<HTMLButtonElement>("#emergencyResetButton")!;

  let floorIds: string[] = [];
  let trackIds: string[] = [];
  let backgroundIds: string[] = [];
  let foregroundIds: string[] = [];
  let minecartIds: string[] = [];

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
  let floorMultiplier = 0.45;
  let backgroundMultiplier = 0.4;
  let foregroundMultiplier = 1.4;
  let rattleEnabled = true;
  let rattleStrength = 1;
  let rattleStartSpeed = 100;

  // The scrolling engine continues to use Owlbear scene units/second internally.
  // The UI converts those values to real feet/second using the current scene grid.
  let sceneGridDpi = 150;
  let feetPerGridCell = 5;
  let speedScaleReady = false;

  let runState: RunState = "stopped";
  let activeFloor: LoopLayer | null = null;
  let activeTrack: LoopLayer | null = null;
  let activeBackground: LoopLayer | null = null;
  let activeForeground: LoopLayer | null = null;
  let activeMinecarts: MinecartRattleGroup | null = null;

  type InteractionManager = Awaited<ReturnType<typeof OBR.interaction.startItemInteraction>>;
  let interactionUpdate: InteractionManager[0] | null = null;
  let interactionStop: InteractionManager[1] | null = null;
  let minecartInteractionUpdate: InteractionManager[0] | null = null;
  let minecartInteractionStop: InteractionManager[1] | null = null;

  let selectedItemIds = new Set<string>();
  let draggedMinecartId: string | null = null;
  let minecartRattleSuspended = false;
  let minecartDropTimer = 0;
  let lastObservedMinecartX = 0;
  let lastObservedMinecartY = 0;

  let animationFrame = 0;
  let renewTimer = 0;
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

    const maxFeetPerSecond = internalSpeedToFeetPerSecond(1000);
    const minAccelerationFeetPerSecondSquared = internalSpeedToFeetPerSecond(25);
    const step = speedUiStep(maxFeetPerSecond);

    targetSpeedSlider.min = "0";
    targetSpeedSlider.max = String(maxFeetPerSecond);
    targetSpeedSlider.step = String(step);

    accelerationSlider.min = String(minAccelerationFeetPerSecondSquared);
    accelerationSlider.max = String(maxFeetPerSecond);
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
    rattleStrength = clampNumber(Number(rattleStrengthSlider.value), 0, 200, 100) / 100;
    rattleStartSpeed = clampNumber(feetPerSecondToInternalSpeed(Number(rattleStartSpeedInput.value)), 0, 1000, 100);
  }

  function updateLayerLabels(): void {
    floorStatus.textContent = floorIds.length >= 2 ? `${floorIds.length} images` : "Not set (optional)";
    trackStatus.textContent = trackIds.length >= 2 ? `${trackIds.length} images` : "Not set";
    backgroundStatus.textContent = backgroundIds.length >= 2 ? `${backgroundIds.length} images` : "Not set";
    foregroundStatus.textContent = foregroundIds.length >= 2 ? `${foregroundIds.length} images` : "Not set (optional)";
    minecartsStatus.textContent = minecartIds.length >= 1 ? `${minecartIds.length} images` : "Not set (optional)";
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
    loadButton.disabled = runState !== "stopped";
  }

  function applyTargetSpeed(value: number): void {
    targetSpeed = clampNumber(value, 0, 1000, 150);
    if (speedScaleReady) {
      targetSpeedSlider.value = String(internalSpeedToFeetPerSecond(targetSpeed));
      targetSpeedValue.textContent = formatFeetPerSecondFromInternal(targetSpeed);
    }
  }

  function applyTargetSpeedFeetPerSecond(value: number): void {
    applyTargetSpeed(feetPerSecondToInternalSpeed(value));
  }

  function applyAcceleration(value: number): void {
    acceleration = clampNumber(value, 25, 1000, 200);
    if (speedScaleReady) {
      accelerationSlider.value = String(internalSpeedToFeetPerSecond(acceleration));
      accelerationValue.textContent = formatFeetPerSecondFromInternal(acceleration);
    }
  }

  function applyAccelerationFeetPerSecondSquared(value: number): void {
    applyAcceleration(feetPerSecondToInternalSpeed(value));
  }

  function applyFloorMultiplier(percent: number): void {
    const value = clampNumber(percent, 0, 100, 45);
    floorMultiplier = value / 100;
    floorMultiplierSlider.value = String(value);
    floorMultiplierValue.textContent = String(Math.round(value));
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

  targetSpeedSlider.addEventListener("input", () => applyTargetSpeedFeetPerSecond(Number(targetSpeedSlider.value)));
  accelerationSlider.addEventListener("input", () => applyAccelerationFeetPerSecondSquared(Number(accelerationSlider.value)));
  floorMultiplierSlider.addEventListener("input", () => applyFloorMultiplier(Number(floorMultiplierSlider.value)));
  backgroundMultiplierSlider.addEventListener("input", () => applyBackgroundMultiplier(Number(backgroundMultiplierSlider.value)));
  foregroundMultiplierSlider.addEventListener("input", () => applyForegroundMultiplier(Number(foregroundMultiplierSlider.value)));
  rattleEnabledCheckbox.addEventListener("change", readControls);
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

  type AssignableKind = "floor" | "track" | "background" | "foreground" | "minecarts";

  function overlapsOtherLayers(ids: string[], excluded: AssignableKind): boolean {
    const otherIds = [
      ...(excluded === "floor" ? [] : floorIds),
      ...(excluded === "track" ? [] : trackIds),
      ...(excluded === "background" ? [] : backgroundIds),
      ...(excluded === "foreground" ? [] : foregroundIds),
      ...(excluded === "minecarts" ? [] : minecartIds),
    ];
    const others = new Set(otherIds);
    return ids.some((id) => others.has(id));
  }

  async function setLayer(kind: AssignableKind): Promise<void> {
    if (runState !== "stopped") {
      status.textContent = "Stop the chase before changing layers.";
      return;
    }

    const images = await getSelectedImages(kind === "minecarts" ? 1 : 2);
    if (!images) return;

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

    updateLayerLabels();
    await OBR.player.deselect();
    status.textContent = `${kind[0].toUpperCase()}${kind.slice(1)} layer set.`;
  }

  setFloorButton.addEventListener("click", () => void setLayer("floor"));
  setTrackButton.addEventListener("click", () => void setLayer("track"));
  setBackgroundButton.addEventListener("click", () => void setLayer("background"));
  setForegroundButton.addEventListener("click", () => void setLayer("foreground"));
  setMinecartsButton.addEventListener("click", () => void setLayer("minecarts"));

  function makeSavedSettings(): SavedSettings {
    readControls();
    return {
      version: 3,
      floorIds: [...floorIds],
      trackIds: [...trackIds],
      backgroundIds: [...backgroundIds],
      foregroundIds: [...foregroundIds],
      minecartIds: [...minecartIds],
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
      version: 3,
      floorIds: Array.isArray(value.floorIds) ? value.floorIds.filter((id): id is string => typeof id === "string") : [],
      trackIds: Array.isArray(value.trackIds) ? value.trackIds.filter((id): id is string => typeof id === "string") : [],
      backgroundIds: Array.isArray(value.backgroundIds) ? value.backgroundIds.filter((id): id is string => typeof id === "string") : [],
      foregroundIds: Array.isArray(value.foregroundIds) ? value.foregroundIds.filter((id): id is string => typeof id === "string") : [],
      minecartIds: Array.isArray(value.minecartIds) ? value.minecartIds.filter((id): id is string => typeof id === "string") : [],
      anchorX: Number.isFinite(value.anchorX) ? Number(value.anchorX) : 0,
      anchorY: Number.isFinite(value.anchorY) ? Number(value.anchorY) : 0,
      floorYOffset: clampNumber(Number(value.floorYOffset), -10000, 10000, 0),
      trackYOffset: clampNumber(Number(value.trackYOffset), -10000, 10000, 0),
      foregroundYOffset: clampNumber(Number(value.foregroundYOffset), -10000, 10000, 0),
      floorOverlap: clampNumber(Number(value.floorOverlap), 0, 50, 0),
      backgroundOverlap: clampNumber(Number(value.backgroundOverlap), 0, 50, 0),
      foregroundOverlap: clampNumber(Number(value.foregroundOverlap), 0, 50, 0),
      targetSpeed: clampNumber(Number(value.targetSpeed), 0, 1000, 150),
      acceleration: clampNumber(Number(value.acceleration), 25, 1000, 200),
      floorMultiplier: clampNumber(Number(value.floorMultiplier), 0, 1, 0.45),
      backgroundMultiplier: clampNumber(Number(value.backgroundMultiplier), 0, 1, 0.4),
      foregroundMultiplier: clampNumber(Number(value.foregroundMultiplier), 1, 2.5, 1.4),
      rattleEnabled: typeof value.rattleEnabled === "boolean" ? value.rattleEnabled : true,
      rattleStrength: clampNumber(Number(value.rattleStrength), 0, 2, 1),
      rattleStartSpeed: clampNumber(Number(value.rattleStartSpeed), 0, 1000, 100),
      focusOnStart: typeof value.focusOnStart === "boolean" ? value.focusOnStart : true,
    };
  }

  function applySavedSettings(saved: SavedSettings): void {
    floorIds = [...saved.floorIds];
    trackIds = [...saved.trackIds];
    backgroundIds = [...saved.backgroundIds];
    foregroundIds = [...saved.foregroundIds];
    minecartIds = [...saved.minecartIds];

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
        frequencyA: 3.5 + seededUnit(`${image.id}:freqA`) * 2.5,
        frequencyB: 7 + seededUnit(`${image.id}:freqB`) * 4,
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

  function clearMinecartDropTimer(): void {
    if (minecartDropTimer) window.clearTimeout(minecartDropTimer);
    minecartDropTimer = 0;
  }

  function closeMinecartInteraction(): void {
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
    if (!activeMinecarts || runState !== "running") return null;

    // Keep every unselected cart rattling. The cart currently being moved is
    // deliberately excluded so Owlbear's normal drag/keyboard controls own it.
    const ids = activeMinecarts.images
      .map((image) => image.id)
      .filter((id) => id !== draggedMinecartId);
    if (ids.length === 0) return null;

    const refreshed = await OBR.scene.items.getItems(ids);
    const refreshedImages = refreshed.filter(isImage);
    if (refreshedImages.length !== ids.length) throw new Error("One or more minecart images disappeared from the scene.");

    // Start replacement interactions from the exact current visual position,
    // not the older committed scene position. This keeps cast-device handoffs
    // from jumping backwards when an interaction is renewed.
    for (const image of refreshedImages) {
      const cart = activeMinecarts.states.get(image.id);
      if (!cart) continue;
      image.position.x = cart.baseX;
      image.position.y = cart.baseY + cart.offsetY;
    }

    return OBR.interaction.startItemInteraction(refreshedImages);
  }

  async function openMinecartInteraction(): Promise<void> {
    closeMinecartInteraction();
    const interaction = await createMinecartInteraction();
    if (!interaction) return;
    minecartInteractionUpdate = interaction[0];
    minecartInteractionStop = interaction[1];
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

      if (runState === "running" && !renewing) await openMinecartInteraction();
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

    if (activeMinecarts && runState === "running") {
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
    if (!activeMinecarts || !minecartRattleSuspended || !draggedMinecartId) return;

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

  async function createScrollInteraction(): Promise<InteractionManager> {
    const activeImages = getActiveImages();
    const ids = activeImages.map((image) => image.id);
    const refreshed = await OBR.scene.items.getItems(ids);
    const refreshedImages = refreshed.filter(isImage);
    if (refreshedImages.length !== ids.length) throw new Error("One or more scrolling images disappeared from the scene.");

    // Seed the interaction with the engine's current in-memory positions.
    // The scene's committed positions can be older while a chase is running.
    for (const image of refreshedImages) {
      const layer = layerForItem(image.id);
      if (!layer) continue;
      const x = layer.positions.get(image.id);
      if (x !== undefined) image.position.x = x;
      image.position.y = layer.y;
    }

    return OBR.interaction.startItemInteraction(refreshedImages);
  }

  async function openInteraction(): Promise<void> {
    // Defensive cleanup: this instance must never own two interactions at once.
    closeInteraction();
    const interaction = await createScrollInteraction();
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
    closeMinecartInteraction();
    clearMinecartDropTimer();
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
      closeMinecartInteraction();
      await resetMinecarts();
      currentSpeed = 0;
      currentSpeedValue.textContent = "0.0";
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

    // Keep the current interactions alive while their replacements are created.
    // Owlbear interactions expire for network traffic after 30 seconds, but
    // stopping animation and committing the whole scene during renewal caused
    // visible gaps on cast/remote clients. The new interaction is started first
    // from the current in-memory positions, then the old one is retired.
    const oldScrollStop = interactionStop;
    const oldMinecartStop = minecartInteractionStop;
    let nextScroll: InteractionManager | null = null;
    let nextMinecart: InteractionManager | null = null;

    try {
      nextScroll = await createScrollInteraction();
      nextMinecart = await createMinecartInteraction();

      if (runState !== "running") {
        nextScroll[1]();
        nextMinecart?.[1]();
        return;
      }

      interactionUpdate = nextScroll[0];
      interactionStop = nextScroll[1];

      if (nextMinecart) {
        minecartInteractionUpdate = nextMinecart[0];
        minecartInteractionStop = nextMinecart[1];
      } else {
        minecartInteractionUpdate = null;
        minecartInteractionStop = null;
      }

      // Only after the replacement streams are live do we stop the old streams.
      // This avoids an interpolation gap for cast devices.
      try {
        oldScrollStop?.();
      } catch (error) {
        console.error("Could not retire previous scrolling interaction:", error);
      }
      try {
        oldMinecartStop?.();
      } catch (error) {
        console.error("Could not retire previous minecart interaction:", error);
      }

      scheduleRenewal();
    } catch (error) {
      console.error("Seamless interaction renewal failed:", error);

      // A partially-created replacement must not compete with the still-live
      // old interaction. Keep the old stream running and retry shortly.
      try {
        nextScroll?.[1]();
      } catch {}
      try {
        nextMinecart?.[1]();
      } catch {}

      if (runState === "running") {
        clearRenewTimer();
        renewTimer = window.setTimeout(() => void renewInteraction(), 3000);
        status.textContent = "Cast sync renewal delayed; chase is still running and will retry automatically.";
      }
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

  function updateMinecartRattle(timeSeconds: number): void {
    if (!activeMinecarts) return;
    if (!rattleEnabled || currentSpeed <= rattleStartSpeed || rattleStrength <= 0) {
      for (const cart of activeMinecarts.states.values()) cart.offsetY = 0;
      return;
    }

    const range = Math.max(1, 1000 - rattleStartSpeed);
    const raw = clampNumber((currentSpeed - rattleStartSpeed) / range, 0, 1, 0);
    const intensity = raw * raw * (3 - 2 * raw);
    const amplitude = 8 * intensity * rattleStrength;
    const frequencyScale = 0.65 + raw * 1.6;

    for (const cart of activeMinecarts.states.values()) {
      const waveA = Math.sin(timeSeconds * cart.frequencyA * frequencyScale * Math.PI * 2 + cart.phaseA);
      const waveB = Math.sin(timeSeconds * cart.frequencyB * frequencyScale * Math.PI * 2 + cart.phaseB);
      cart.offsetY = amplitude * cart.amplitudeScale * (waveA * 0.65 + waveB * 0.35);
    }
  }

  function animate(time: number): void {
    if (runState !== "running") return;

    const deltaTime = Math.min((time - lastTime) / 1000, 0.1);
    lastTime = time;
    currentSpeed = approach(currentSpeed, targetSpeed, acceleration * deltaTime);
    currentSpeedValue.textContent = speedScaleReady ? formatFeetPerSecondFromInternal(currentSpeed) : "0.0";

    if (activeFloor) moveLayer(activeFloor, deltaTime, floorMultiplier);
    if (activeTrack) moveLayer(activeTrack, deltaTime, 1);
    if (activeBackground) moveLayer(activeBackground, deltaTime, backgroundMultiplier);
    if (activeForeground) moveLayer(activeForeground, deltaTime, foregroundMultiplier);
    updateMinecartRattle(time / 1000);

    if (interactionUpdate) {
      interactionUpdate((draft) => {
        const items = Array.isArray(draft) ? draft : [draft];

        for (const item of items) {
          const layer = layerForItem(item.id);
          if (layer) {
            const x = layer.positions.get(item.id);
            if (x !== undefined) item.position.x = x;
            item.position.y = layer.y;
          }
        }
      });
    }

    if (minecartInteractionUpdate && activeMinecarts) {
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

    try {
      await prepareChase();
      await OBR.player.deselect();
      if (focusOnStartCheckbox.checked) await goToAnchor();
      currentSpeed = 0;
      currentSpeedValue.textContent = "0.0";
      runState = "running";
      await openInteraction();
      await openMinecartInteraction();
      lastTime = performance.now();
      animationFrame = requestAnimationFrame(animate);
      scheduleRenewal();
      updateRunButtons();
      const extras = [activeFloor ? "floor" : "", activeForeground ? "foreground" : "", activeMinecarts ? "minecart rattle" : ""].filter(Boolean);
      status.textContent = extras.length > 0 ? `Chase running with ${extras.join(", ")}.` : "Parallax chase running!";
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : "Could not start the chase.";
      activeFloor = null;
      activeTrack = null;
      activeBackground = null;
      activeForeground = null;
      closeMinecartInteraction();
      clearMinecartDropTimer();
      draggedMinecartId = null;
      minecartRattleSuspended = false;
      activeMinecarts = null;
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
    closeMinecartInteraction();
    await resetMinecarts();
    currentSpeed = 0;
    currentSpeedValue.textContent = "0.0";
    runState = "paused";
    updateRunButtons();
    status.textContent = "Paused — positions preserved.";
  });

  resumeButton.addEventListener("click", async () => {
    if (runState !== "paused" || renewing) return;
    try {
      currentSpeed = 0;
      currentSpeedValue.textContent = "0.0";
      runState = "running";
      await openInteraction();
      await openMinecartInteraction();
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
    closeMinecartInteraction();
    clearMinecartDropTimer();
    draggedMinecartId = null;
    minecartRattleSuspended = false;
    await resetMinecarts();

    currentSpeed = 0;
    currentSpeedValue.textContent = "0.0";
    activeFloor = null;
    activeTrack = null;
    activeBackground = null;
    activeForeground = null;
    activeMinecarts = null;
    runState = "stopped";
    updateRunButtons();
    status.textContent = "Stopped. Start will rebuild the chase at the anchor.";
  });

  emergencyResetButton.addEventListener("click", async () => {
    clearRenewTimer();
    if (animationFrame) cancelAnimationFrame(animationFrame);
    animationFrame = 0;
    closeInteraction();
    closeMinecartInteraction();
    clearMinecartDropTimer();
    draggedMinecartId = null;
    minecartRattleSuspended = false;
    await resetMinecarts();
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
    status.textContent = "Emergency reset complete. Current interaction stopped; minecarts restored; saved settings were kept.";
  });

  updateLayerLabels();
  updateRunButtons();
  await refreshSceneSpeedScale();
  OBR.scene.grid.onChange(() => void refreshSceneSpeedScale());
  await loadSettings(true);
  renderSpeedControls();
  updateRunButtons();
});
