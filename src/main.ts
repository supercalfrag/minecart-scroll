import OBR, { isImage, type Image } from "@owlbear-rodeo/sdk";

document.querySelector<HTMLDivElement>("#app")!.innerHTML = `
  <div style="
    font-family: Arial, sans-serif;
    padding: 18px;
    text-align: center;
  ">
    <h2 style="margin-top: 0;">Minecart Scroll</h2>

    <p id="status">Waiting for Owlbear...</p>

    <hr>

    <h3>1. Set Layers</h3>

    <button id="setTrackButton">
      Set Track Layer
    </button>

    <p id="trackStatus">
      Track: not set
    </p>

    <button id="setBackgroundButton">
      Set Background Layer
    </button>

    <p id="backgroundStatus">
      Background: not set
    </p>

    <hr>

    <h3>2. Chase Anchor</h3>

    <label>
      Anchor X:
      <input
        id="anchorXInput"
        type="number"
        value="0"
        step="50"
        style="width: 90px;"
      />
    </label>

    <br><br>

    <label>
      Anchor Y:
      <input
        id="anchorYInput"
        type="number"
        value="0"
        step="50"
        style="width: 90px;"
      />
    </label>

    <br><br>

    <button id="goToAnchorButton">
      Go to Anchor Point
    </button>

    <p id="anchorStatus">
      Anchor: 0, 0
    </p>

    <label>
      <input
        id="focusOnStartCheckbox"
        type="checkbox"
        checked
      />
      Go to anchor when chase starts
    </label>

    <hr>

    <h3>3. Layout</h3>

    <label>
      <input
        id="centerTrackCheckbox"
        type="checkbox"
        checked
      />
      Center track on background
    </label>

    <br><br>

    <label for="trackYOffsetSlider">
      Track Vertical Offset:
      <strong>
        <span id="trackYOffsetValue">0</span>
      </strong>
    </label>

    <br><br>

    <input
      id="trackYOffsetSlider"
      type="range"
      min="-5000"
      max="5000"
      value="0"
      step="10"
      style="width: 100%;"
    />

    <br><br>

    <label>
      Exact Offset:
      <input
        id="trackYOffsetNumber"
        type="number"
        min="-10000"
        max="10000"
        value="0"
        step="10"
        style="width: 100px;"
      />
    </label>

    <p style="font-size: 12px;">
      Negative = up &nbsp; | &nbsp; Positive = down
    </p>

    <label for="backgroundOverlapSlider">
      Background Seam Overlap:
      <strong>
        <span id="backgroundOverlapValue">0</span>
      </strong>
    </label>

    <br><br>

    <input
      id="backgroundOverlapSlider"
      type="range"
      min="0"
      max="20"
      value="0"
      step="1"
      style="width: 100%;"
    />

    <hr>

    <h3>4. Chase Speed</h3>

    <label for="speedSlider">
      Main Speed:
      <strong>
        <span id="speedValue">150</span>
      </strong>
    </label>

    <br><br>

    <input
      id="speedSlider"
      type="range"
      min="25"
      max="500"
      value="150"
      step="25"
      style="width: 100%;"
    />

    <br><br>

    <label for="backgroundSlider">
      Background Speed:
      <strong>
        <span id="backgroundValue">40</span>%
      </strong>
    </label>

    <br><br>

    <input
      id="backgroundSlider"
      type="range"
      min="0"
      max="100"
      value="40"
      step="5"
      style="width: 100%;"
    />

    <hr>

    <h3>5. Run Chase</h3>

    <button id="startButton">
      Start Parallax
    </button>

    <button id="stopButton">
      Stop
    </button>
  </div>
`;

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

OBR.onReady(() => {
  const status =
    document.querySelector<HTMLParagraphElement>(
      "#status"
    )!;

  const trackStatus =
    document.querySelector<HTMLParagraphElement>(
      "#trackStatus"
    )!;

  const backgroundStatus =
    document.querySelector<HTMLParagraphElement>(
      "#backgroundStatus"
    )!;

  const anchorStatus =
    document.querySelector<HTMLParagraphElement>(
      "#anchorStatus"
    )!;

  const setTrackButton =
    document.querySelector<HTMLButtonElement>(
      "#setTrackButton"
    )!;

  const setBackgroundButton =
    document.querySelector<HTMLButtonElement>(
      "#setBackgroundButton"
    )!;

  const goToAnchorButton =
    document.querySelector<HTMLButtonElement>(
      "#goToAnchorButton"
    )!;

  const anchorXInput =
    document.querySelector<HTMLInputElement>(
      "#anchorXInput"
    )!;

  const anchorYInput =
    document.querySelector<HTMLInputElement>(
      "#anchorYInput"
    )!;

  const focusOnStartCheckbox =
    document.querySelector<HTMLInputElement>(
      "#focusOnStartCheckbox"
    )!;

  const centerTrackCheckbox =
    document.querySelector<HTMLInputElement>(
      "#centerTrackCheckbox"
    )!;

  const trackYOffsetSlider =
    document.querySelector<HTMLInputElement>(
      "#trackYOffsetSlider"
    )!;

  const trackYOffsetNumber =
    document.querySelector<HTMLInputElement>(
      "#trackYOffsetNumber"
    )!;

  const trackYOffsetValue =
    document.querySelector<HTMLSpanElement>(
      "#trackYOffsetValue"
    )!;

  const backgroundOverlapSlider =
    document.querySelector<HTMLInputElement>(
      "#backgroundOverlapSlider"
    )!;

  const backgroundOverlapValue =
    document.querySelector<HTMLSpanElement>(
      "#backgroundOverlapValue"
    )!;

  const speedSlider =
    document.querySelector<HTMLInputElement>(
      "#speedSlider"
    )!;

  const speedValue =
    document.querySelector<HTMLSpanElement>(
      "#speedValue"
    )!;

  const backgroundSlider =
    document.querySelector<HTMLInputElement>(
      "#backgroundSlider"
    )!;

  const backgroundValue =
    document.querySelector<HTMLSpanElement>(
      "#backgroundValue"
    )!;

  const startButton =
    document.querySelector<HTMLButtonElement>(
      "#startButton"
    )!;

  const stopButton =
    document.querySelector<HTMLButtonElement>(
      "#stopButton"
    )!;

  let speed =
    Number(speedSlider.value);

  let backgroundSpeed =
    Number(backgroundSlider.value) / 100;

  let trackYOffset =
    Number(trackYOffsetSlider.value);

  let backgroundOverlap =
    Number(backgroundOverlapSlider.value);

  let anchorX =
    Number(anchorXInput.value);

  let anchorY =
    Number(anchorYInput.value);

  let trackIds: string[] = [];

  let backgroundIds: string[] = [];

  let activeTrack:
    LoopLayer | null = null;

  let activeBackground:
    LoopLayer | null = null;

  let animationFrame = 0;

  let interactionStop:
    (() => void) | null = null;

  let lastTime = 0;

  /*
   * Tiny track overlap has already
   * proven reliable.
   */
  const TRACK_OVERLAP = 2;

  /*
   * Keep track safely above background.
   */
  const TRACK_Z_GAP = 100000;

  status.textContent =
    "Owlbear connected!";

  /*
   * ----------------------
   * ANCHOR
   * ----------------------
   */

  function updateAnchor() {
    anchorX =
      Number(anchorXInput.value);

    anchorY =
      Number(anchorYInput.value);

    if (!Number.isFinite(anchorX)) {
      anchorX = 0;
      anchorXInput.value = "0";
    }

    if (!Number.isFinite(anchorY)) {
      anchorY = 0;
      anchorYInput.value = "0";
    }

    anchorStatus.textContent =
      `Anchor: ${anchorX}, ${anchorY}`;
  }

  anchorXInput.addEventListener(
    "change",
    updateAnchor
  );

  anchorYInput.addEventListener(
    "change",
    updateAnchor
  );

  /*
   * Correctly center the viewport
   * on a SCENE coordinate.
   */
  async function goToAnchor() {
    updateAnchor();

    /*
     * Ask Owlbear where our scene point
     * currently appears on the screen.
     */
    const screenPoint =
      await OBR.viewport.transformPoint({
        x: anchorX,
        y: anchorY
      });

    /*
     * Get the size of the actual
     * Owlbear scene viewport.
     */
    const viewportWidth =
      await OBR.viewport.getWidth();

    const viewportHeight =
      await OBR.viewport.getHeight();

    const currentPosition =
      await OBR.viewport.getPosition();

    const currentScale =
      await OBR.viewport.getScale();

    /*
     * We want the anchor to appear
     * exactly in the middle of the screen.
     */
    const desiredScreenX =
      viewportWidth / 2;

    const desiredScreenY =
      viewportHeight / 2;

    /*
     * Difference between where the anchor
     * is now and where we want it.
     */
    const moveX =
      desiredScreenX -
      screenPoint.x;

    const moveY =
      desiredScreenY -
      screenPoint.y;

    /*
     * Move the viewport by that difference
     * while preserving zoom.
     */
    await OBR.viewport.animateTo({
      position: {
        x:
          currentPosition.x +
          moveX,

        y:
          currentPosition.y +
          moveY
      },

      scale:
        currentScale
    });
  }

  goToAnchorButton.addEventListener(
    "click",
    async () => {
      await goToAnchor();

      status.textContent =
        `Focused on ${anchorX}, ${anchorY}`;
    }
  );

  /*
   * ----------------------
   * SPEED CONTROLS
   * ----------------------
   */

  speedSlider.addEventListener(
    "input",
    () => {
      speed =
        Number(speedSlider.value);

      speedValue.textContent =
        speedSlider.value;
    }
  );

  backgroundSlider.addEventListener(
    "input",
    () => {
      backgroundSpeed =
        Number(
          backgroundSlider.value
        ) / 100;

      backgroundValue.textContent =
        backgroundSlider.value;
    }
  );

  /*
   * ----------------------
   * BACKGROUND OVERLAP
   * ----------------------
   */

  backgroundOverlapSlider.addEventListener(
    "input",
    () => {
      backgroundOverlap =
        Number(
          backgroundOverlapSlider.value
        );

      backgroundOverlapValue.textContent =
        backgroundOverlapSlider.value;

      if (interactionStop) {
        status.textContent =
          "Background overlap applies next time you Start.";
      }
    }
  );

  /*
   * ----------------------
   * TRACK OFFSET
   * ----------------------
   */

  function setTrackYOffset(
    value: number
  ) {
    /*
     * Number box gets more range
     * than the slider.
     */
    value =
      Math.max(
        -10000,
        Math.min(
          10000,
          value
        )
      );

    const difference =
      value -
      trackYOffset;

    trackYOffset =
      value;

    trackYOffsetNumber.value =
      String(value);

    /*
     * Slider can only visually represent
     * -5000 to +5000.
     */
    trackYOffsetSlider.value =
      String(
        Math.max(
          -5000,
          Math.min(
            5000,
            value
          )
        )
      );

    trackYOffsetValue.textContent =
      String(value);

    /*
     * Apply the offset live while running.
     */
    if (activeTrack) {
      activeTrack.y +=
        difference;
    }
  }

  trackYOffsetSlider.addEventListener(
    "input",
    () => {
      setTrackYOffset(
        Number(
          trackYOffsetSlider.value
        )
      );
    }
  );

  trackYOffsetNumber.addEventListener(
    "change",
    () => {
      setTrackYOffset(
        Number(
          trackYOffsetNumber.value
        )
      );
    }
  );

  /*
   * ----------------------
   * GET SELECTED IMAGES
   * ----------------------
   */

  async function getSelectedImages():
    Promise<Image[] | null> {

    const selection =
      await OBR.player.getSelection();

    if (
      !selection ||
      selection.length < 2
    ) {
      status.textContent =
        "Select at least TWO images first.";

      return null;
    }

    const items =
      await OBR.scene.items.getItems(
        selection
      );

    const images =
      items.filter(isImage);

    if (
      images.length !==
      selection.length
    ) {
      status.textContent =
        "Every selected item must be an image.";

      return null;
    }

    return images;
  }

  /*
   * ----------------------
   * SET TRACK
   * ----------------------
   */

  setTrackButton.addEventListener(
    "click",
    async () => {
      if (interactionStop) {
        status.textContent =
          "Stop the chase before changing layers.";

        return;
      }

      const images =
        await getSelectedImages();

      if (!images) {
        return;
      }

      const newIds =
        images.map(
          image =>
            image.id
        );

      const backgroundSet =
        new Set(
          backgroundIds
        );

      if (
        newIds.some(
          id =>
            backgroundSet.has(id)
        )
      ) {
        status.textContent =
          "Track and background must use different images.";

        return;
      }

      trackIds =
        newIds;

      trackStatus.textContent =
        `Track: ${trackIds.length} images`;

      /*
       * Remove the blue selection outline.
       */
      await OBR.player.deselect();

      status.textContent =
        "Track layer set!";
    }
  );

  /*
   * ----------------------
   * SET BACKGROUND
   * ----------------------
   */

  setBackgroundButton.addEventListener(
    "click",
    async () => {
      if (interactionStop) {
        status.textContent =
          "Stop the chase before changing layers.";

        return;
      }

      const images =
        await getSelectedImages();

      if (!images) {
        return;
      }

      const newIds =
        images.map(
          image =>
            image.id
        );

      const trackSet =
        new Set(
          trackIds
        );

      if (
        newIds.some(
          id =>
            trackSet.has(id)
        )
      ) {
        status.textContent =
          "Track and background must use different images.";

        return;
      }

      backgroundIds =
        newIds;

      backgroundStatus.textContent =
        `Background: ${backgroundIds.length} images`;

      /*
       * Remove the blue selection outline.
       */
      await OBR.player.deselect();

      status.textContent =
        "Background layer set!";
    }
  );

  /*
   * ----------------------
   * PREPARE LOOP
   * ----------------------
   */

  async function prepareLayer(
    name: string,
    images: Image[],
    zBase: number,
    overlap: number,
    overridePosition?: {
      x: number;
      y: number;
    }
  ): Promise<LoopLayer> {

    images.sort(
      (a, b) =>
        a.position.x -
        b.position.x
    );

    const first =
      images[0];

    /*
     * Use Owlbear's actual rendered bounds.
     */
    const firstBounds =
      await OBR.scene.items.getItemBounds(
        [first.id]
      );

    const displayedWidth =
      firstBounds.width;

    /*
     * Make sure every strip in this layer
     * is actually the same width.
     */
    for (
      const image of images
    ) {
      const bounds =
        await OBR.scene.items.getItemBounds(
          [image.id]
        );

      if (
        Math.abs(
          bounds.width -
          displayedWidth
        ) > 1
      ) {
        throw new Error(
          `${name} images must have the same displayed width.`
        );
      }
    }

    const spacing =
      displayedWidth -
      overlap;

    const startX =
      overridePosition?.x ??
      first.position.x;

    const startY =
      overridePosition?.y ??
      first.position.y;

    const positions =
      new Map<
        string,
        number
      >();

    const order =
      new Map<
        string,
        number
      >();

    images.forEach(
      (image, index) => {
        order.set(
          image.id,
          index
        );
      }
    );

    await OBR.scene.items.updateItems(
      images,
      items => {
        for (
          const item of items
        ) {
          const index =
            order.get(
              item.id
            );

          if (
            index === undefined
          ) {
            continue;
          }

          const x =
            startX +
            index *
              spacing;

          item.position.x =
            x;

          item.position.y =
            startY;

          item.zIndex =
            zBase +
            index;

          item.disableAutoZIndex =
            true;

          positions.set(
            item.id,
            x
          );
        }
      }
    );

    const refreshed =
      await OBR.scene.items.getItems(
        images.map(
          image =>
            image.id
        )
      );

    const refreshedImages =
      refreshed
        .filter(isImage)
        .sort(
          (a, b) =>
            a.position.x -
            b.position.x
        );

    positions.clear();

    refreshedImages.forEach(
      (image, index) => {
        positions.set(
          image.id,

          startX +
            index *
              spacing
        );
      }
    );

    return {
      name,

      images:
        refreshedImages,

      positions,

      startX,

      y:
        startY,

      spacing,

      highestZ:
        zBase +
        refreshedImages.length -
        1,

      zQueue:
        Promise.resolve()
    };
  }

  /*
   * ----------------------
   * MOVE LOOP
   * ----------------------
   */

  function moveLayer(
    layer: LoopLayer,
    deltaTime: number,
    multiplier: number
  ) {
    const layerSpeed =
      speed *
      multiplier;

    for (
      const image of
        layer.images
    ) {
      const oldX =
        layer.positions.get(
          image.id
        ) ??
        layer.startX;

      layer.positions.set(
        image.id,

        oldX -
          layerSpeed *
          deltaTime
      );
    }

    let keepChecking =
      true;

    while (
      keepChecking
    ) {
      keepChecking =
        false;

      let leftImage:
        Image | null =
        null;

      let leftX =
        Infinity;

      let rightX =
        -Infinity;

      for (
        const image of
          layer.images
      ) {
        const x =
          layer.positions.get(
            image.id
          ) ?? 0;

        if (
          x <
          leftX
        ) {
          leftX =
            x;

          leftImage =
            image;
        }

        if (
          x >
          rightX
        ) {
          rightX =
            x;
        }
      }

      if (
        leftImage &&
        leftX <=
          layer.startX -
          layer.spacing
      ) {
        layer.positions.set(
          leftImage.id,

          rightX +
            layer.spacing
        );

        layer.highestZ++;

        const recycledImage =
          leftImage;

        const newZ =
          layer.highestZ;

        layer.zQueue =
          layer.zQueue
            .then(
              async () => {
                await OBR.scene.items.updateItems(
                  [recycledImage],

                  items => {
                    if (
                      items.length >
                      0
                    ) {
                      items[0].zIndex =
                        newZ;

                      items[0].disableAutoZIndex =
                        true;
                    }
                  }
                );
              }
            )
            .catch(
              error => {
                console.error(
                  `${layer.name} z-index error:`,

                  error
                );
              }
            );

        keepChecking =
          true;
      }
    }
  }

  /*
   * ----------------------
   * START
   * ----------------------
   */

  startButton.addEventListener(
    "click",
    async () => {
      if (
        interactionStop
      ) {
        status.textContent =
          "Already running!";

        return;
      }

      updateAnchor();

      if (
        trackIds.length <
        2
      ) {
        status.textContent =
          "Set the Track layer first.";

        return;
      }

      if (
        backgroundIds.length <
        2
      ) {
        status.textContent =
          "Set the Background layer first.";

        return;
      }

      const trackItems =
        await OBR.scene.items.getItems(
          trackIds
        );

      const backgroundItems =
        await OBR.scene.items.getItems(
          backgroundIds
        );

      const trackImages =
        trackItems.filter(
          isImage
        );

      const backgroundImages =
        backgroundItems.filter(
          isImage
        );

      if (
        trackImages.length !==
        trackIds.length
      ) {
        status.textContent =
          "One or more track images are missing.";

        return;
      }

      if (
        backgroundImages.length !==
        backgroundIds.length
      ) {
        status.textContent =
          "One or more background images are missing.";

        return;
      }

      try {
        const combined = [
          ...trackImages,
          ...backgroundImages
        ];

        const baseZ =
          Math.min(
            ...combined.map(
              image =>
                image.zIndex
            )
          );

        /*
         * ----------------------
         * BACKGROUND TO ANCHOR
         * ----------------------
         */

        const sortedBackground =
          [...backgroundImages]
            .sort(
              (a, b) =>
                a.position.x -
                b.position.x
            );

        const firstBackground =
          sortedBackground[0];

        const backgroundBounds =
          await OBR.scene.items.getItemBounds(
            [
              firstBackground.id
            ]
          );

        /*
         * Shift the FIRST background strip
         * so its rendered center lands
         * exactly on our fixed anchor.
         */
        const backgroundOverride = {
          x:
            firstBackground.position.x +
            (
              anchorX -
              backgroundBounds.center.x
            ),

          y:
            firstBackground.position.y +
            (
              anchorY -
              backgroundBounds.center.y
            )
        };

        activeBackground =
          await prepareLayer(
            "Background",

            backgroundImages,

            baseZ,

            backgroundOverlap,

            backgroundOverride
          );

        /*
         * ----------------------
         * TRACK
         * ----------------------
         */

        const sortedTrack =
          [...trackImages]
            .sort(
              (a, b) =>
                a.position.x -
                b.position.x
            );

        const firstTrack =
          sortedTrack[0];

        let trackOverride:
          {
            x: number;
            y: number;
          };

        if (
          centerTrackCheckbox.checked
        ) {
          /*
           * Get the NOW-CENTERED background
           * and align the track to it.
           */
          const currentBackgroundBounds =
            await OBR.scene.items.getItemBounds(
              [
                activeBackground
                  .images[0].id
              ]
            );

          const trackBounds =
            await OBR.scene.items.getItemBounds(
              [
                firstTrack.id
              ]
            );

          const moveX =
            currentBackgroundBounds.center.x -
            trackBounds.center.x;

          const moveY =
            currentBackgroundBounds.center.y -
            trackBounds.center.y;

          trackOverride = {
            x:
              firstTrack.position.x +
              moveX,

            y:
              firstTrack.position.y +
              moveY +
              trackYOffset
          };

        } else {
          trackOverride = {
            x:
              firstTrack.position.x,

            y:
              firstTrack.position.y +
              trackYOffset
          };
        }

        activeTrack =
          await prepareLayer(
            "Track",

            trackImages,

            baseZ +
              TRACK_Z_GAP,

            TRACK_OVERLAP,

            trackOverride
          );

      } catch (error) {
        status.textContent =
          error instanceof Error
            ? error.message
            : "Could not prepare layers.";

        return;
      }

      /*
       * Remove any remaining selection outlines.
       */
      await OBR.player.deselect();

      /*
       * Put camera on the fixed chase point.
       */
      if (
        focusOnStartCheckbox.checked
      ) {
        await goToAnchor();
      }

      const allImages = [
        ...activeBackground.images,
        ...activeTrack.images
      ];

      const interaction =
        await OBR.interaction.startItemInteraction(
          allImages
        );

      const updateInteraction =
        interaction[0];

      interactionStop =
        interaction[1];

      lastTime =
        performance.now();

      function animate(
        time: number
      ) {
        if (
          !activeTrack ||
          !activeBackground
        ) {
          return;
        }

        const deltaTime =
          Math.min(
            (
              time -
              lastTime
            ) /
              1000,

            0.1
          );

        lastTime =
          time;

        moveLayer(
          activeTrack,

          deltaTime,

          1
        );

        moveLayer(
          activeBackground,

          deltaTime,

          backgroundSpeed
        );

        updateInteraction(
          items => {
            for (
              const item of
                items
            ) {
              const trackX =
                activeTrack!
                  .positions
                  .get(
                    item.id
                  );

              if (
                trackX !==
                undefined
              ) {
                item.position.x =
                  trackX;

                item.position.y =
                  activeTrack!.y;

                continue;
              }

              const backgroundX =
                activeBackground!
                  .positions
                  .get(
                    item.id
                  );

              if (
                backgroundX !==
                undefined
              ) {
                item.position.x =
                  backgroundX;

                item.position.y =
                  activeBackground!.y;
              }
            }
          }
        );

        animationFrame =
          requestAnimationFrame(
            animate
          );
      }

      animationFrame =
        requestAnimationFrame(
          animate
        );

      status.textContent =
        "PARALLAX CHASE RUNNING!";
    }
  );

  /*
   * ----------------------
   * STOP
   * ----------------------
   */

  stopButton.addEventListener(
    "click",
    async () => {
      if (
        !interactionStop ||
        !activeTrack ||
        !activeBackground
      ) {
        status.textContent =
          "Nothing is running.";

        return;
      }

      cancelAnimationFrame(
        animationFrame
      );

      await Promise.all([
        activeTrack.zQueue,
        activeBackground.zQueue
      ]);

      const allImages = [
        ...activeBackground.images,
        ...activeTrack.images
      ];

      await OBR.scene.items.updateItems(
        allImages,

        items => {
          for (
            const item of
              items
          ) {
            const trackX =
              activeTrack!
                .positions
                .get(
                  item.id
                );

            if (
              trackX !==
              undefined
            ) {
              item.position.x =
                trackX;

              item.position.y =
                activeTrack!.y;

              continue;
            }

            const backgroundX =
              activeBackground!
                .positions
                .get(
                  item.id
                );

            if (
              backgroundX !==
              undefined
            ) {
              item.position.x =
                backgroundX;

              item.position.y =
                activeBackground!.y;
            }
          }
        }
      );

      interactionStop();

      interactionStop =
        null;

      activeTrack =
        null;

      activeBackground =
        null;

      status.textContent =
        "Stopped!";
    }
  );
});