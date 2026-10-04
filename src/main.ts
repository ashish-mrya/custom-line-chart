Spotfire.initialize(async (mod: Spotfire.Mod) => {
    /**
     * Custom Line Chart mod
     *
     * Y scale modes (Spotfire Line Chart / Adjusting scales on axes):
     * - Single: one shared scale for all Y expressions
     * - Dual: left + right scales; assign series via legend L/R click
     * - Separate: one scale per series (stacked panels)
     *
     * Uses Spotfire APIs where available (controls.popout, controls.tooltip,
     * styling.zoomSliders / scales / general). Native zoom slider widgets are
     * not exposed by the Mods API — only styling — so zoom thumbs are drawn
     * in-mod using context.styling.zoomSliders.
     */
    const yScaleModeProperty = mod.property<string>("yScaleMode");
    const dualAssignmentsProperty = mod.property<string>("dualScaleAssignments");
    const seriesStylesProperty = mod.property<string>("seriesStyles");
    const yFormatProperty = mod.property<string>("yFormat");
    const xFormatProperty = mod.property<string>("xFormat");
    const xZoomProperty = mod.property<string>("xZoom");
    const yZoomProperty = mod.property<string>("yZoom");
    const showZoomSlidersProperty = mod.property<boolean>("showZoomSliders");
    const showMarkersProperty = mod.property<boolean>("showMarkers");
    const markerSizeProperty = mod.property<number>("markerSize");

    const reader = mod.createReader(
        mod.visualization.data(),
        mod.windowSize(),
        yScaleModeProperty,
        dualAssignmentsProperty,
        seriesStylesProperty,
        yFormatProperty,
        xFormatProperty,
        xZoomProperty,
        yZoomProperty,
        showZoomSlidersProperty,
        showMarkersProperty,
        markerSizeProperty
    );
    const context = mod.getRenderContext();

    type AxisMode = "Single" | "Dual" | "Separate";
    type Side = "Left" | "Right";
    type SeriesStyle = "hide" | "line" | "dots" | "dash";
    type NegativeNumberStyle = "minus" | "parens" | "minusRed" | "parensRed";
    type NumberFormatConfig = {
        decimals: number;
        thousandsSeparator: boolean;
        negativeStyle: NegativeNumberStyle;
        useShort: boolean;
    };
    type SeriesPoint = {
        row: Spotfire.DataViewRow;
        xIndex: number;
        y: number;
        color: string;
        seriesKey: string;
        seriesLabel: string;
        marked: boolean;
        size: number | null;
    };

    type ZoomWindow = { start: number; end: number };
    type PlotBounds = { left: number; top: number; width: number; height: number };
    const defaultNumberFormat = (): NumberFormatConfig => ({
        decimals: 2,
        thousandsSeparator: false,
        negativeStyle: "minus",
        useShort: false
    });
    let currentYFormat: NumberFormatConfig = defaultNumberFormat();
    let currentXFormat: NumberFormatConfig = defaultNumberFormat();
    let xAxisIsDate = false;
    let xWindow: ZoomWindow = { start: 0, end: 1 };
    let yWindow: ZoomWindow = { start: 0, end: 1 };
    let showZoomSliders = true;
    let showMarkersEnabled = false;
    let markerSizeValue = 4;
    let sizeValueRange: { min: number; max: number } | null = null;
    let availableSeries: Array<{ key: string; label: string }> = [];
    let settingsPanelOpen = false;
    let hasAnyMarked = false;
    let lastStylingSignature = "";
    const seriesStylePrefix = "seriesStyle:";
    const dualSidePrefix = "dualSide:";
    const zoomTrackSize = 5;
    const zoomAxisGap = 1;
    const markerRadiusMax = 14;
    const negativeStyles = new Set<NegativeNumberStyle>(["minus", "parens", "minusRed", "parensRed"]);

    reader.subscribe(render);

    async function render(
        dataView: Spotfire.DataView,
        windowSize: Spotfire.Size,
        yScaleModeProp: Spotfire.ModProperty<string>,
        dualAssignmentsProp: Spotfire.ModProperty<string>,
        seriesStylesProp: Spotfire.ModProperty<string>,
        yFormatProp: Spotfire.ModProperty<string>,
        xFormatProp: Spotfire.ModProperty<string>,
        xZoomProp: Spotfire.ModProperty<string>,
        yZoomProp: Spotfire.ModProperty<string>,
        showZoomSlidersProp: Spotfire.ModProperty<boolean>,
        showMarkersProp: Spotfire.ModProperty<boolean>,
        markerSizeProp: Spotfire.ModProperty<number>
    ) {
        const container = document.querySelector("#mod-container") as HTMLElement | null;
        if (!container) {
            mod.controls.errorOverlay.show("Missing #mod-container element.");
            return;
        }

        try {
            const errors = await dataView.getErrors();
            if (errors.length > 0) {
                mod.controls.errorOverlay.show(errors);
                return;
            }
            mod.controls.errorOverlay.hide();
            applySpotfireStyling();

            const axisMode = normalizeAxisMode(yScaleModeProp.value());
            currentYFormat = parseNumberFormat(yFormatProp.value());
            currentXFormat = parseNumberFormat(xFormatProp.value());
            xWindow = parseZoomWindow(xZoomProp.value());
            yWindow = parseZoomWindow(yZoomProp.value());
            showZoomSliders = showZoomSlidersProp.value() !== false;
            showMarkersEnabled = showMarkersProp.value() === true;
            markerSizeValue = normalizeMarkerSize(markerSizeProp.value());
            const styleMap = parseKeyedMap(seriesStylesProp.value(), normalizeSeriesStyle) as Map<
                string,
                SeriesStyle
            >;
            const sideMap = parseKeyedMap(dualAssignmentsProp.value(), (v) =>
                v.toLowerCase() === "right" ? "Right" : "Left"
            ) as Map<string, Side>;

            const width = Math.max(windowSize.width, 1);
            const height = Math.max(windowSize.height, 1);
            container.style.width = `${width}px`;
            container.style.height = `${height}px`;

            const rows = await dataView.allRows();
            if (rows == null) {
                return;
            }

            if (rows.length === 0) {
                availableSeries = [];
                const emptyBounds = emptyPlotBounds(width, height);
                container.innerHTML = `
                    ${settingsButtonHtml()}
                    <div class="empty-state">
                        Add columns on Y (and a category/date on X).<br/>
                        Open Settings for Single / Dual / Separate Y scales and axis formatting.
                    </div>
                    ${showZoomSliders ? axisZoomHtml(emptyBounds, false) : ""}`;
                wireChrome(
                    yScaleModeProp,
                    seriesStylesProp,
                    yFormatProp,
                    xFormatProp,
                    showZoomSlidersProp,
                    dualAssignmentsProp,
                    showMarkersProp,
                    markerSizeProp,
                    xZoomProp,
                    yZoomProp
                );
                context.signalRenderComplete();
                return;
            }

            const xHierarchy = await dataView.hierarchy("X");
            if (!xHierarchy) {
                mod.controls.errorOverlay.show("X-axis must be categorical.");
                return;
            }
            const xRoot = await xHierarchy.root();
            if (!xRoot) {
                return;
            }
            const xLeaves = xRoot.leaves();
            const xCount = Math.max(xLeaves.length, 1);
            xAxisIsDate = xHierarchy.levels.some((level) => level.dataType.isDate());
            const xLabels = xLeaves.map((leaf) => formatXLabel(leaf, currentXFormat, xAxisIsDate));

            const axes = await dataView.axes();
            const hasColorAxis = axes.some((axis) => axis.name === "Color" && axis.isCategorical);
            const sizeAxis = await dataView.continuousAxis("Size");

            const points: SeriesPoint[] = [];
            let sizeMin = Number.POSITIVE_INFINITY;
            let sizeMax = Number.NEGATIVE_INFINITY;
            for (const row of rows) {
                const yRaw = row.continuous("Y").value();
                const yValue = typeof yRaw === "number" ? yRaw : Number(yRaw);
                if (yRaw == null || Number.isNaN(yValue)) {
                    continue;
                }

                const xIndex = row.categorical("X").leafIndex;
                const color = row.color().hexCode;
                let seriesLabel = "Y";
                let seriesKey = color;
                if (hasColorAxis) {
                    const colorCat = row.categorical("Color");
                    seriesLabel = colorCat.formattedValue();
                    seriesKey = colorCat
                        .value()
                        .map((part) => part.key ?? part.formattedValue())
                        .join("|");
                }

                let size: number | null = null;
                if (sizeAxis != null) {
                    const sizeRaw = row.continuous("Size").value();
                    const sizeValue = typeof sizeRaw === "number" ? sizeRaw : Number(sizeRaw);
                    if (sizeRaw != null && !Number.isNaN(sizeValue)) {
                        size = sizeValue;
                        if (sizeValue < sizeMin) {
                            sizeMin = sizeValue;
                        }
                        if (sizeValue > sizeMax) {
                            sizeMax = sizeValue;
                        }
                    }
                }

                points.push({
                    row,
                    xIndex,
                    y: yValue,
                    color,
                    seriesKey,
                    seriesLabel,
                    marked: row.isMarked(),
                    size
                });
            }

            sizeValueRange = Number.isFinite(sizeMin) ? paddedRange(sizeMin, sizeMax) : null;

            if (points.length === 0) {
                availableSeries = [];
                const emptyBounds = emptyPlotBounds(width, height);
                container.innerHTML = `${settingsButtonHtml()}<div class="empty-state">No plottable Y values.</div>${showZoomSliders ? axisZoomHtml(emptyBounds, false) : ""}`;
                wireChrome(
                    yScaleModeProp,
                    seriesStylesProp,
                    yFormatProp,
                    xFormatProp,
                    showZoomSlidersProp,
                    dualAssignmentsProp,
                    showMarkersProp,
                    markerSizeProp,
                    xZoomProp,
                    yZoomProp
                );
                context.signalRenderComplete();
                return;
            }

            const seriesMap = new Map<string, SeriesPoint[]>();
            const seriesMeta = new Map<string, { label: string; color: string }>();
            hasAnyMarked = false;
            for (const point of points) {
                if (point.marked) {
                    hasAnyMarked = true;
                }
                const series = seriesMap.get(point.seriesKey);
                if (series) {
                    series.push(point);
                } else {
                    seriesMap.set(point.seriesKey, [point]);
                }
                const existing = seriesMeta.get(point.seriesKey);
                if (!existing) {
                    // Prefer a marked point's full color so the whole series isn't washed out.
                    seriesMeta.set(point.seriesKey, { label: point.seriesLabel, color: point.color });
                } else if (point.marked) {
                    existing.color = point.color;
                }
            }
            for (const series of seriesMap.values()) {
                series.sort((a, b) => a.xIndex - b.xIndex);
            }

            const seriesKeys = [...seriesMap.keys()];
            availableSeries = seriesKeys.map((key) => ({
                key,
                label: seriesMeta.get(key)?.label ?? key
            }));
            const getStyle = (key: string): SeriesStyle => normalizeSeriesStyle(styleMap.get(key) ?? "line");
            const getSide = (key: string): Side => (sideMap.get(key) === "Right" ? "Right" : "Left");
            const visibleSeriesKeys = seriesKeys.filter((key) => getStyle(key) !== "hide");
            // Marking fade should ignore hidden series.
            hasAnyMarked = points.some(
                (point) => point.marked && getStyle(point.seriesKey) !== "hide"
            );

            let chartSvg: {
                html: string;
                pointElements: { cx: number; cy: number; point: SeriesPoint }[];
                plotBounds: PlotBounds;
                showRightYZoom: boolean;
            };

            if (axisMode === "Separate" && visibleSeriesKeys.length > 1) {
                chartSvg = renderMultipleScales(
                    width,
                    height,
                    xLabels,
                    xCount,
                    visibleSeriesKeys,
                    seriesMap,
                    seriesMeta,
                    getStyle
                );
            } else if (axisMode === "Dual" && visibleSeriesKeys.length > 1) {
                // Defaults + keep both Left/Right populated for visible series.
                ensureDefaultDualAssignments(visibleSeriesKeys, sideMap, dualAssignmentsProp);
                chartSvg = renderDualScales(
                    width,
                    height,
                    xLabels,
                    xCount,
                    visibleSeriesKeys,
                    seriesMap,
                    seriesMeta,
                    getStyle,
                    getSide
                );
            } else {
                chartSvg = renderSingleScale(
                    width,
                    height,
                    xLabels,
                    xCount,
                    visibleSeriesKeys,
                    seriesMap,
                    seriesMeta,
                    getStyle
                );
            }

            const marking = await dataView.marking();
            container.innerHTML = `${settingsButtonHtml()}${chartSvg.html}${showZoomSliders ? axisZoomHtml(chartSvg.plotBounds, chartSvg.showRightYZoom) : ""}`;
            wireChrome(
                yScaleModeProp,
                seriesStylesProp,
                yFormatProp,
                xFormatProp,
                showZoomSlidersProp,
                dualAssignmentsProp,
                showMarkersProp,
                markerSizeProp,
                xZoomProp,
                yZoomProp,
                {
                    dataView,
                    pointElements: chartSvg.pointElements,
                    markingEnabled: marking != null,
                    plotBounds: chartSvg.plotBounds
                }
            );
            context.signalRenderComplete();
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            mod.controls.errorOverlay.show(`Line chart render failed: ${message}`);
            context.signalRenderComplete();
        }
    }

    function normalizeAxisMode(value: string | null): AxisMode {
        const text = String(value || "")
            .trim()
            .toLowerCase();
        if (text === "dual" || text === "dual scales" || text === "double") {
            return "Dual";
        }
        if (text === "separate" || text === "separate scales" || text === "multiple" || text === "multiple scales") {
            return "Separate";
        }
        return "Single";
    }

    function parseKeyedMap(raw: string | null, normalize: (value: string) => string): Map<string, string> {
        const map = new Map<string, string>();
        const text = String(raw || "").trim();
        if (!text) {
            return map;
        }
        text.split("|").forEach((part) => {
            const sep = part.lastIndexOf("=");
            if (sep <= 0) {
                return;
            }
            const key = decodeURIComponent(part.slice(0, sep));
            const value = normalize(part.slice(sep + 1));
            map.set(key, value);
        });
        return map;
    }

    function serializeKeyedMap(map: Map<string, string> | Map<string, Side> | Map<string, SeriesStyle>): string {
        return [...map.entries()]
            .map(([key, value]) => `${encodeURIComponent(key)}=${value}`)
            .join("|");
    }

    function ensureDefaultDualAssignments(
        seriesKeys: string[],
        sideMap: Map<string, Side>,
        dualAssignmentsProp: Spotfire.ModProperty<string>
    ) {
        let changed = false;
        seriesKeys.forEach((key, index) => {
            if (!sideMap.has(key)) {
                sideMap.set(key, index === 0 ? "Left" : "Right");
                changed = true;
            }
        });

        // Dual needs both sides. If everything landed on one side, move one series.
        const leftKeys = seriesKeys.filter((key) => sideMap.get(key) !== "Right");
        const rightKeys = seriesKeys.filter((key) => sideMap.get(key) === "Right");
        if (rightKeys.length === 0 && leftKeys.length > 1) {
            sideMap.set(leftKeys[leftKeys.length - 1], "Right");
            changed = true;
        } else if (leftKeys.length === 0 && rightKeys.length > 1) {
            sideMap.set(rightKeys[0], "Left");
            changed = true;
        }

        if (changed) {
            dualAssignmentsProp.set(serializeKeyedMap(sideMap));
        }
    }

    function normalizeSeriesStyle(value: string | null | undefined): SeriesStyle {
        const text = String(value || "")
            .trim()
            .toLowerCase();
        if (text === "hide" || text === "off" || text === "none" || text === "hidden") {
            return "hide";
        }
        if (text === "dots" || text === "points" || text === "point") {
            return "dots";
        }
        if (text === "dash" || text === "dashed") {
            return "dash";
        }
        return "line";
    }

    function normalizeMarkerSize(value: number | null | undefined): number {
        const n = Number(value);
        if (!Number.isFinite(n)) {
            return 4;
        }
        return Math.max(1, Math.min(10, n));
    }

    function parseNumberFormat(value: string | null): NumberFormatConfig {
        const fallback = defaultNumberFormat();
        const text = String(value || "").trim();
        if (!text) {
            return fallback;
        }

        // Legacy radio values from earlier builds.
        const legacy = text.toLowerCase();
        if (legacy === "auto") {
            return fallback;
        }
        if (legacy === "dec0" || legacy === "0" || legacy === "0 decimals") {
            return { ...fallback, decimals: 0 };
        }
        if (legacy === "dec1" || legacy === "1" || legacy === "1 decimal" || legacy === "number1") {
            return { ...fallback, decimals: 1 };
        }
        if (legacy === "dec2" || legacy === "2" || legacy === "2 decimals" || legacy === "number2") {
            return { ...fallback, decimals: 2 };
        }
        if (legacy === "dec3" || legacy === "3" || legacy === "3 decimals") {
            return { ...fallback, decimals: 3 };
        }
        if (legacy === "short" || legacy === "short number") {
            return { ...fallback, useShort: true };
        }

        try {
            const parsed = JSON.parse(text) as Partial<NumberFormatConfig>;
            const decimals = Math.max(0, Math.min(6, Number(parsed.decimals)));
            const negativeStyle = negativeStyles.has(parsed.negativeStyle as NegativeNumberStyle)
                ? (parsed.negativeStyle as NegativeNumberStyle)
                : fallback.negativeStyle;
            return {
                decimals: Number.isFinite(decimals) ? decimals : fallback.decimals,
                thousandsSeparator: Boolean(parsed.thousandsSeparator),
                negativeStyle,
                useShort: Boolean(parsed.useShort)
            };
        } catch {
            return fallback;
        }
    }

    function serializeNumberFormat(config: NumberFormatConfig): string {
        return JSON.stringify(config);
    }

    function negativeNumberOptions(decimals: number): Array<{ value: NegativeNumberStyle; label: string }> {
        const sample = (1234).toFixed(decimals);
        return [
            { value: "minus", label: `-${sample}` },
            { value: "parens", label: `(${sample})` },
            { value: "minusRed", label: `-${sample} (red)` },
            { value: "parensRed", label: `(${sample}) (red)` }
        ];
    }

    function numberFormatControlsHtml(axis: "y" | "x", config: NumberFormatConfig): string {
        const decimalOptions = [0, 1, 2, 3, 4, 5, 6]
            .map((n) => `<option value="${n}" ${config.decimals === n ? "selected" : ""}>${n}</option>`)
            .join("");
        const negativeOptions = negativeNumberOptions(config.decimals)
            .map(
                (option) =>
                    `<option value="${option.value}" ${
                        config.negativeStyle === option.value ? "selected" : ""
                    }>${escapeXml(option.label)}</option>`
            )
            .join("");
        return `
            <div class="format-controls" data-format-axis="${axis}">
                <div class="format-row">
                    <span class="format-label">Decimals:</span>
                    <select class="format-select format-select-sm" name="${axis}Format.decimals">${decimalOptions}</select>
                    <label class="settings-check format-check-inline">
                        <input type="checkbox" name="${axis}Format.thousands" ${config.thousandsSeparator ? "checked" : ""} />
                        <span>Use thousands separator</span>
                    </label>
                </div>
                <div class="format-row">
                    <span class="format-label">Negative numbers:</span>
                    <select class="format-select" name="${axis}Format.negative">${negativeOptions}</select>
                </div>
                <div class="format-row">
                    <label class="settings-check">
                        <input type="checkbox" name="${axis}Format.useShort" ${config.useShort ? "checked" : ""} />
                        <span>Use short number format</span>
                    </label>
                </div>
            </div>
        `;
    }

    function readNumberFormatFromPanel(panel: HTMLElement, axis: "y" | "x"): NumberFormatConfig {
        const decimalsEl = panel.querySelector<HTMLSelectElement>(`select[name="${axis}Format.decimals"]`);
        const thousandsEl = panel.querySelector<HTMLInputElement>(`input[name="${axis}Format.thousands"]`);
        const negativeEl = panel.querySelector<HTMLSelectElement>(`select[name="${axis}Format.negative"]`);
        const useShortEl = panel.querySelector<HTMLInputElement>(`input[name="${axis}Format.useShort"]`);
        const decimals = Math.max(0, Math.min(6, Number(decimalsEl?.value ?? 2)));
        const negativeStyle = (negativeEl?.value || "minus") as NegativeNumberStyle;
        return {
            decimals: Number.isFinite(decimals) ? decimals : 2,
            thousandsSeparator: Boolean(thousandsEl?.checked),
            negativeStyle: negativeStyles.has(negativeStyle) ? negativeStyle : "minus",
            useShort: Boolean(useShortEl?.checked)
        };
    }

    function emptyPlotBounds(width: number, height: number): PlotBounds {
        return {
            left: 52,
            top: 28,
            width: Math.max(width - 80, 1),
            height: Math.max(height - 70, 1)
        };
    }

    function wireChrome(
        yScaleModeProp: Spotfire.ModProperty<string>,
        seriesStylesProp: Spotfire.ModProperty<string>,
        yFormatProp: Spotfire.ModProperty<string>,
        xFormatProp: Spotfire.ModProperty<string>,
        showZoomSlidersProp: Spotfire.ModProperty<boolean>,
        dualAssignmentsProp: Spotfire.ModProperty<string>,
        showMarkersProp: Spotfire.ModProperty<boolean>,
        markerSizeProp: Spotfire.ModProperty<number>,
        xZoomProp: Spotfire.ModProperty<string>,
        yZoomProp: Spotfire.ModProperty<string>,
        chart?: {
            dataView: Spotfire.DataView;
            pointElements: { cx: number; cy: number; point: SeriesPoint }[];
            markingEnabled: boolean;
            plotBounds: PlotBounds;
        }
    ) {
        wireSettingsButton(
            yScaleModeProp,
            seriesStylesProp,
            yFormatProp,
            xFormatProp,
            showZoomSlidersProp,
            dualAssignmentsProp,
            showMarkersProp,
            markerSizeProp,
            xZoomProp,
            yZoomProp
        );
        if (showZoomSliders) {
            wireZoomSliders(xZoomProp, yZoomProp);
        }
        if (chart) {
            wirePoints(chart.dataView, chart.pointElements, chart.markingEnabled, chart.plotBounds);
        }
        if (settingsPanelOpen) {
            openSettingsPanel(
                yScaleModeProp,
                seriesStylesProp,
                yFormatProp,
                xFormatProp,
                showZoomSlidersProp,
                dualAssignmentsProp,
                showMarkersProp,
                markerSizeProp,
                xZoomProp,
                yZoomProp
            );
        }
    }

    function wireNumberFormatControls(
        panel: HTMLElement,
        axis: "y" | "x",
        formatProp: Spotfire.ModProperty<string>
    ) {
        const persist = () => {
            const next = readNumberFormatFromPanel(panel, axis);
            formatProp.set(serializeNumberFormat(next));
        };

        const shortToggle = panel.querySelector<HTMLInputElement>(`input[name="${axis}Format.useShort"]`);
        const decimalsSelect = panel.querySelector<HTMLSelectElement>(`select[name="${axis}Format.decimals"]`);
        const negativeSelect = panel.querySelector<HTMLSelectElement>(`select[name="${axis}Format.negative"]`);

        shortToggle?.addEventListener("change", persist);
        decimalsSelect?.addEventListener("change", () => {
            if (negativeSelect) {
                const decimals = Math.max(0, Math.min(6, Number(decimalsSelect.value)));
                const current = negativeSelect.value as NegativeNumberStyle;
                negativeSelect.innerHTML = negativeNumberOptions(Number.isFinite(decimals) ? decimals : 2)
                    .map(
                        (option) =>
                            `<option value="${option.value}" ${
                                option.value === current ? "selected" : ""
                            }>${escapeXml(option.label)}</option>`
                    )
                    .join("");
            }
            persist();
        });

        panel
            .querySelectorAll<HTMLElement>(
                `input[name="${axis}Format.thousands"], select[name="${axis}Format.negative"]`
            )
            .forEach((el) => {
                el.addEventListener("change", persist);
            });
    }

    function isDarkTheme(styling: Spotfire.StylingInfo): boolean {
        const theme = styling.general.activeTheme;
        if (theme === "Dark") {
            return true;
        }
        if (theme && typeof theme === "object" && theme.baseTheme === "Dark") {
            return true;
        }
        // Fallback: luminance of background.
        const hex = String(styling.general.backgroundColor || "").replace("#", "");
        if (hex.length >= 6) {
            const r = parseInt(hex.slice(0, 2), 16);
            const g = parseInt(hex.slice(2, 4), 16);
            const b = parseInt(hex.slice(4, 6), 16);
            if ([r, g, b].every((n) => Number.isFinite(n))) {
                return (0.299 * r + 0.587 * g + 0.114 * b) < 140;
            }
        }
        return false;
    }

    function applySpotfireStyling() {
        const styling = context.styling;
        const zoomThumb = styling.zoomSliders.thumb.backgroundImage.default;
        const zoomThumbHover = styling.zoomSliders.thumb.backgroundImage.hover || zoomThumb;
        const controlBg = styling.controls?.backgroundColor || styling.general.backgroundColor;
        const controlColor = styling.controls?.color?.default || styling.general.font.color;
        const dark = isDarkTheme(styling);
        const signature = [
            styling.general.backgroundColor,
            styling.general.font.fontFamily,
            styling.general.font.fontSize,
            styling.general.font.color,
            styling.scales.font.fontFamily,
            styling.scales.font.fontSize,
            styling.scales.font.color,
            styling.scales.line.stroke,
            styling.scales.tick.stroke,
            styling.zoomSliders.innerRange.backgroundColor,
            styling.zoomSliders.outerRange.backgroundColor,
            zoomThumb,
            zoomThumbHover,
            controlBg,
            controlColor,
            dark ? "dark" : "light"
        ].join("|");
        if (signature === lastStylingSignature) {
            return;
        }
        lastStylingSignature = signature;

        const root = document.documentElement;
        root.dataset.theme = dark ? "dark" : "light";
        root.style.setProperty("--sf-bg", styling.general.backgroundColor);
        root.style.setProperty("--sf-font-family", styling.general.font.fontFamily);
        root.style.setProperty("--sf-font-size", `${styling.general.font.fontSize}px`);
        root.style.setProperty("--sf-font-color", styling.general.font.color);
        root.style.setProperty("--sf-muted", styling.scales.font.color);
        root.style.setProperty("--sf-border", styling.scales.line.stroke);
        root.style.setProperty("--sf-panel-bg", controlBg);
        root.style.setProperty("--sf-input-bg", dark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.03)");
        root.style.setProperty("--sf-input-border", dark ? "rgba(255,255,255,0.22)" : "rgba(0,0,0,0.18)");
        root.style.setProperty("--sf-divider", dark ? "rgba(255,255,255,0.12)" : "rgba(0,0,0,0.08)");
        root.style.setProperty("--sf-button-bg", dark ? "rgba(255,255,255,0.08)" : "rgba(255,255,255,0.96)");
        root.style.setProperty("--sf-button-hover", dark ? "rgba(255,255,255,0.14)" : "#f7f8f8");
        root.style.setProperty("--sf-shadow", dark ? "0 8px 24px rgba(0,0,0,0.55)" : "0 8px 24px rgba(0,0,0,0.12)");
        root.style.setProperty("--sf-accent", dark ? "#5b9fd4" : "#2f7d6d");
        root.style.setProperty("--sf-marker-stroke", styling.general.backgroundColor);
        root.style.setProperty("--sf-scale-font-family", styling.scales.font.fontFamily);
        root.style.setProperty("--sf-scale-font-size", `${styling.scales.font.fontSize}px`);
        root.style.setProperty("--sf-scale-font-color", styling.scales.font.color);
        root.style.setProperty("--sf-scale-line", styling.scales.line.stroke);
        root.style.setProperty("--sf-scale-tick", styling.scales.tick.stroke);
        root.style.setProperty("--sf-zoom-inner", styling.zoomSliders.innerRange.backgroundColor);
        root.style.setProperty("--sf-zoom-outer", styling.zoomSliders.outerRange.backgroundColor);
        root.style.setProperty("--sf-zoom-thumb", zoomThumb);
        root.style.setProperty("--sf-zoom-thumb-hover", zoomThumbHover);
        document.body.style.background = styling.general.backgroundColor;
        document.body.style.color = styling.general.font.color;
        document.body.style.fontFamily = styling.general.font.fontFamily;
        document.body.style.fontSize = `${styling.general.font.fontSize}px`;
    }

    function clamp01(value: number): number {
        return Math.max(0, Math.min(1, value));
    }

    function parseZoomWindow(value: string | null): ZoomWindow {
        const text = String(value ?? "0,1").trim();
        if (text.includes(",")) {
            const [rawStart, rawEnd] = text.split(",");
            let start = clamp01(Number(rawStart));
            let end = clamp01(Number(rawEnd));
            if (!Number.isFinite(start) || !Number.isFinite(end)) {
                return { start: 0, end: 1 };
            }
            if (end - start < 0.05) {
                end = Math.min(1, start + 0.05);
                start = Math.max(0, end - 0.05);
            }
            return { start, end };
        }

        // Backward compatible: old 0–100 zoom percent → centered window.
        const zoom = Number(text);
        if (Number.isFinite(zoom) && zoom >= 0 && zoom <= 100) {
            const z = zoom / 100;
            const span = Math.max(0.05, 1 - z * 0.95);
            const start = (1 - span) / 2;
            return { start, end: start + span };
        }
        return { start: 0, end: 1 };
    }

    function serializeZoomWindow(window: ZoomWindow): string {
        return `${window.start.toFixed(4)},${window.end.toFixed(4)}`;
    }

    function zoomedRange(full: { min: number; max: number }, window: ZoomWindow): { min: number; max: number } {
        const span = full.max - full.min;
        return { min: full.min + span * window.start, max: full.min + span * window.end };
    }

    function isFullWindow(window: ZoomWindow): boolean {
        return window.start <= 0.001 && window.end >= 0.999;
    }

    function zoomTrackHtml(
        axis: "x" | "y",
        window: ZoomWindow,
        orientation: "horizontal" | "vertical",
        side: "left" | "right" = "left"
    ): string {
        const spanPct = ((window.end - window.start) * 100).toFixed(2);
        if (orientation === "vertical") {
            // Y axis: top = high values (end), bottom = low values (start).
            const endFromTop = ((1 - window.end) * 100).toFixed(2);
            const startFromTop = ((1 - window.start) * 100).toFixed(2);
            return `
                <div class="zoom-slider axis-y side-${side}" data-zoom-axis="y" data-orientation="vertical">
                    <div class="zoom-track">
                        <div class="zoom-outer"></div>
                        <div class="zoom-inner" style="top:${endFromTop}%;height:${spanPct}%"></div>
                        <div class="zoom-thumb" data-thumb="end" style="top:${endFromTop}%"></div>
                        <div class="zoom-thumb" data-thumb="start" style="top:${startFromTop}%"></div>
                    </div>
                </div>
            `;
        }

        const startPct = (window.start * 100).toFixed(2);
        const endPct = (window.end * 100).toFixed(2);
        return `
            <div class="zoom-slider axis-x" data-zoom-axis="x" data-orientation="horizontal">
                <div class="zoom-track">
                    <div class="zoom-outer"></div>
                    <div class="zoom-inner" style="left:${startPct}%;width:${spanPct}%"></div>
                    <div class="zoom-thumb" data-thumb="start" style="left:${startPct}%"></div>
                    <div class="zoom-thumb" data-thumb="end" style="left:${endPct}%"></div>
                </div>
            </div>
        `;
    }

    function axisZoomHtml(plot: PlotBounds, showRightYZoom: boolean): string {
        const resetDisabled = isFullWindow(xWindow) && isFullWindow(yWindow) ? "disabled" : "";
        // Thin tracks sit flush against the axis lines (between labels and plot).
        const yLeft = Math.max(plot.left - zoomTrackSize - zoomAxisGap, 1);
        const yRight = plot.left + plot.width + zoomAxisGap;
        const xTop = plot.top + plot.height + zoomAxisGap;
        const leftY = zoomTrackHtml("y", yWindow, "vertical", "left");
        const rightY = showRightYZoom ? zoomTrackHtml("y", yWindow, "vertical", "right") : "";
        const xZoom = zoomTrackHtml("x", xWindow, "horizontal");
        return `
            <div class="axis-zoom-layer">
                <div class="zoom-slot y-left" style="left:${yLeft}px;top:${plot.top}px;height:${plot.height}px;width:${zoomTrackSize}px">
                    ${leftY}
                </div>
                ${
                    showRightYZoom
                        ? `<div class="zoom-slot y-right" style="left:${yRight}px;top:${plot.top}px;height:${plot.height}px;width:${zoomTrackSize}px">${rightY}</div>`
                        : ""
                }
                <div class="zoom-slot x-bottom" style="left:${plot.left}px;top:${xTop}px;width:${plot.width}px;height:${zoomTrackSize}px">
                    ${xZoom}
                </div>
                <button type="button" class="zoom-reset" data-action="reset-zoom" style="left:${plot.left + plot.width + 4}px;top:${xTop - 1}px" ${resetDisabled} title="Reset X and Y zoom">↺</button>
            </div>
        `;
    }

    function applyZoomTrackVisual(slider: HTMLElement, window: ZoomWindow) {
        const inner = slider.querySelector<HTMLElement>(".zoom-inner");
        const startThumb = slider.querySelector<HTMLElement>('.zoom-thumb[data-thumb="start"]');
        const endThumb = slider.querySelector<HTMLElement>('.zoom-thumb[data-thumb="end"]');
        const vertical = slider.dataset.orientation === "vertical";
        const spanPct = `${((window.end - window.start) * 100).toFixed(2)}%`;

        if (vertical) {
            const endFromTop = `${((1 - window.end) * 100).toFixed(2)}%`;
            const startFromTop = `${((1 - window.start) * 100).toFixed(2)}%`;
            if (inner) {
                inner.style.top = endFromTop;
                inner.style.height = spanPct;
                inner.style.left = "0";
                inner.style.width = "100%";
            }
            if (startThumb) {
                startThumb.style.top = startFromTop;
                startThumb.style.left = "50%";
            }
            if (endThumb) {
                endThumb.style.top = endFromTop;
                endThumb.style.left = "50%";
            }
            return;
        }

        const startPct = `${(window.start * 100).toFixed(2)}%`;
        const endPct = `${(window.end * 100).toFixed(2)}%`;
        if (inner) {
            inner.style.left = startPct;
            inner.style.width = spanPct;
            inner.style.top = "0";
            inner.style.height = "100%";
        }
        if (startThumb) {
            startThumb.style.left = startPct;
            startThumb.style.top = "50%";
        }
        if (endThumb) {
            endThumb.style.left = endPct;
            endThumb.style.top = "50%";
        }
    }

    function wireZoomSliders(
        xZoomProp: Spotfire.ModProperty<string>,
        yZoomProp: Spotfire.ModProperty<string>
    ) {
        document.querySelectorAll<HTMLElement>(".zoom-slider").forEach((slider) => {
            const axis = slider.dataset.zoomAxis === "y" ? "y" : "x";
            const vertical = slider.dataset.orientation === "vertical";
            const track = slider.querySelector<HTMLElement>(".zoom-track");
            if (!track) {
                return;
            }

            const readWindow = () => (axis === "x" ? xWindow : yWindow);
            const syncAllAxisSliders = (next: ZoomWindow) => {
                document.querySelectorAll<HTMLElement>(`.zoom-slider[data-zoom-axis="${axis}"]`).forEach((el) => {
                    applyZoomTrackVisual(el, next);
                });
            };
            const commitWindow = (next: ZoomWindow) => {
                if (axis === "x") {
                    xWindow = next;
                    xZoomProp.set(serializeZoomWindow(next));
                } else {
                    yWindow = next;
                    yZoomProp.set(serializeZoomWindow(next));
                }
            };
            const previewWindow = (next: ZoomWindow) => {
                if (axis === "x") {
                    xWindow = next;
                } else {
                    yWindow = next;
                }
                syncAllAxisSliders(next);
            };

            const pointerToFraction = (clientX: number, clientY: number) => {
                const rect = track.getBoundingClientRect();
                if (vertical) {
                    if (rect.height <= 0) {
                        return 0;
                    }
                    // Bottom = 0 (min), top = 1 (max).
                    return clamp01((rect.bottom - clientY) / rect.height);
                }
                if (rect.width <= 0) {
                    return 0;
                }
                return clamp01((clientX - rect.left) / rect.width);
            };

            track.querySelectorAll<HTMLElement>(".zoom-thumb").forEach((thumb) => {
                const which = thumb.dataset.thumb === "end" ? "end" : "start";
                thumb.addEventListener("pointerdown", (event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    thumb.setPointerCapture(event.pointerId);
                    const onMove = (moveEvent: PointerEvent) => {
                        const value = pointerToFraction(moveEvent.clientX, moveEvent.clientY);
                        const current = { ...readWindow() };
                        if (which === "start") {
                            current.start = Math.min(value, current.end - 0.05);
                        } else {
                            current.end = Math.max(value, current.start + 0.05);
                        }
                        // Preview only while dragging — property.set triggers full re-render and drops capture.
                        previewWindow(current);
                    };
                    const onUp = () => {
                        thumb.releasePointerCapture(event.pointerId);
                        thumb.removeEventListener("pointermove", onMove);
                        thumb.removeEventListener("pointerup", onUp);
                        commitWindow(readWindow());
                    };
                    thumb.addEventListener("pointermove", onMove);
                    thumb.addEventListener("pointerup", onUp);
                });
            });

            track.addEventListener("pointerdown", (event) => {
                const target = event.target as HTMLElement;
                if (target.classList.contains("zoom-thumb")) {
                    return;
                }
                event.preventDefault();
                const value = pointerToFraction(event.clientX, event.clientY);
                const current = readWindow();
                const distStart = Math.abs(value - current.start);
                const distEnd = Math.abs(value - current.end);
                const next = { ...current };
                if (distStart <= distEnd) {
                    next.start = Math.min(value, next.end - 0.05);
                } else {
                    next.end = Math.max(value, next.start + 0.05);
                }
                commitWindow(next);
            });
        });

        document.querySelectorAll<HTMLButtonElement>("button[data-action='reset-zoom']").forEach((button) => {
            button.addEventListener("click", (event) => {
                event.preventDefault();
                event.stopPropagation();
                xZoomProp.set("0,1");
                yZoomProp.set("0,1");
            });
        });
    }

    function settingsButtonHtml(): string {
        return `
            <button type="button" class="settings-button" data-action="open-settings" title="Settings" aria-label="Settings">
                <svg class="settings-icon" viewBox="0 0 24 24" aria-hidden="true">
                    <line x1="3" y1="8" x2="21" y2="8" />
                    <circle cx="16" cy="8" r="2.2" />
                    <line x1="3" y1="16" x2="21" y2="16" />
                    <circle cx="8" cy="16" r="2.2" />
                </svg>
            </button>
        `;
    }

    function radioRowHtml(
        name: string,
        options: Array<{ value: string; label: string }>,
        selected: string,
        layout: "stack" | "inline" = "stack"
    ): string {
        const radios = options
            .map((option) => {
                const checked = option.value === selected ? "checked" : "";
                return `<label class="settings-radio"><input type="radio" name="${name}" value="${option.value}" ${checked} /><span>${escapeXml(option.label)}</span></label>`;
            })
            .join("");
        return `<div class="settings-radio-group ${layout}">${radios}</div>`;
    }

    function settingsPanelHtml(
        yScaleModeProp: Spotfire.ModProperty<string>,
        seriesStylesProp: Spotfire.ModProperty<string>,
        yFormatProp: Spotfire.ModProperty<string>,
        xFormatProp: Spotfire.ModProperty<string>,
        showZoomSlidersProp: Spotfire.ModProperty<boolean>,
        dualAssignmentsProp: Spotfire.ModProperty<string>
    ): string {
        const axisMode = normalizeAxisMode(yScaleModeProp.value());
        const yFormat = parseNumberFormat(yFormatProp.value());
        const xFormat = parseNumberFormat(xFormatProp.value());
        const zoomChecked = showZoomSlidersProp.value() !== false ? "checked" : "";
        const styleMap = parseKeyedMap(seriesStylesProp.value(), normalizeSeriesStyle) as Map<
            string,
            SeriesStyle
        >;
        const sideMap = parseKeyedMap(dualAssignmentsProp.value(), (v) =>
            v.toLowerCase() === "right" ? "Right" : "Left"
        ) as Map<string, Side>;

        const seriesRows =
            availableSeries.length === 0
                ? `<div class="settings-hint">Add Y columns / Color to configure each series.</div>`
                : `
                    <div class="series-style-table">
                        <div class="series-style-head">
                            <span class="series-name">Series</span>
                            <span class="series-choice">Hide</span>
                            <span class="series-choice">Line</span>
                            <span class="series-choice">Points</span>
                            <span class="series-choice">Dash</span>
                        </div>
                        ${availableSeries
                            .map((series) => {
                                const current = normalizeSeriesStyle(styleMap.get(series.key));
                                const name = `${seriesStylePrefix}${encodeURIComponent(series.key)}`;
                                return `
                                    <div class="series-style-row">
                                        <span class="series-name" title="${escapeXml(series.label)}">${escapeXml(truncate(series.label, 34))}</span>
                                        <label class="series-choice">
                                            <input type="radio" name="${name}" value="Hide" ${current === "hide" ? "checked" : ""} />
                                        </label>
                                        <label class="series-choice">
                                            <input type="radio" name="${name}" value="Line" ${current === "line" ? "checked" : ""} />
                                        </label>
                                        <label class="series-choice">
                                            <input type="radio" name="${name}" value="Points" ${current === "dots" ? "checked" : ""} />
                                        </label>
                                        <label class="series-choice">
                                            <input type="radio" name="${name}" value="Dash" ${current === "dash" ? "checked" : ""} />
                                        </label>
                                    </div>
                                `;
                            })
                            .join("")}
                    </div>
                `;

        const dualSideRows =
            availableSeries.length === 0
                ? `<div class="settings-hint">Add series to assign Left / Right scales.</div>`
                : `
                    <div class="series-side-table">
                        <div class="series-side-head">
                            <span class="series-name">Series</span>
                            <span class="series-choice">Left</span>
                            <span class="series-choice">Right</span>
                        </div>
                        ${availableSeries
                            .map((series, index) => {
                                const stored = sideMap.get(series.key);
                                const side: Side = stored === "Right" || stored === "Left" ? stored : index === 0 ? "Left" : "Right";
                                const name = `${dualSidePrefix}${encodeURIComponent(series.key)}`;
                                return `
                                    <div class="series-side-row">
                                        <span class="series-name" title="${escapeXml(series.label)}">${escapeXml(truncate(series.label, 34))}</span>
                                        <label class="series-choice">
                                            <input type="radio" name="${name}" value="Left" ${side === "Left" ? "checked" : ""} />
                                        </label>
                                        <label class="series-choice">
                                            <input type="radio" name="${name}" value="Right" ${side === "Right" ? "checked" : ""} />
                                        </label>
                                    </div>
                                `;
                            })
                            .join("")}
                    </div>
                `;

        return `
            <div class="settings-panel" role="dialog" aria-label="Chart settings">
                <div class="settings-section">
                    <div class="settings-heading">Y scale mode</div>
                    ${radioRowHtml(
                        "yScaleMode",
                        [
                            { value: "Single", label: "Single" },
                            { value: "Dual", label: "Dual" },
                            { value: "Separate", label: "Separate" }
                        ],
                        axisMode
                    )}
                </div>
                ${
                    axisMode === "Dual"
                        ? `<div class="settings-section">
                    <div class="settings-heading">Dual scale side</div>
                    ${dualSideRows}
                    <div class="settings-hint">Put at least one series on Left and one on Right.</div>
                </div>`
                        : ""
                }
                <div class="settings-section">
                    <div class="settings-heading">Series display</div>
                    ${seriesRows}
                </div>
                <div class="settings-section">
                    <div class="settings-heading">Markers</div>
                    <label class="settings-check">
                        <input type="checkbox" name="showMarkers" ${showMarkersEnabled ? "checked" : ""} />
                        <span>Show markers</span>
                    </label>
                    <div class="marker-size-row">
                        <span class="format-label">Marker size:</span>
                        <input
                            type="range"
                            class="marker-size-slider"
                            name="markerSize"
                            min="1"
                            max="10"
                            step="1"
                            value="${markerSizeValue}"
                        />
                        <span class="marker-size-value">${markerSizeValue}</span>
                    </div>
                    <div class="settings-hint">Size applies whenever markers are shown (toggle, Points, Size by, or marking).</div>
                </div>
                <div class="settings-section">
                    <div class="settings-heading">Zoom sliders</div>
                    <label class="settings-check">
                        <input type="checkbox" name="showZoomSliders" ${zoomChecked} />
                        <span>Show zoom sliders</span>
                    </label>
                </div>
                <div class="settings-section">
                    <div class="settings-heading">Y format</div>
                    ${numberFormatControlsHtml("y", yFormat)}
                </div>
                <div class="settings-section">
                    <div class="settings-heading">X format</div>
                    ${
                        xAxisIsDate
                            ? `<div class="settings-hint">X is a date — Spotfire default date labels are used.</div>`
                            : `${numberFormatControlsHtml("x", xFormat)}
                    <div class="settings-hint">Applied when X values are numeric.</div>`
                    }
                </div>
            </div>
        `;
    }

    function closeSettingsPanel() {
        settingsPanelOpen = false;
        document.querySelector(".settings-panel")?.remove();
        document.querySelector(".settings-backdrop")?.remove();
    }

    function openSettingsPanel(
        yScaleModeProp: Spotfire.ModProperty<string>,
        seriesStylesProp: Spotfire.ModProperty<string>,
        yFormatProp: Spotfire.ModProperty<string>,
        xFormatProp: Spotfire.ModProperty<string>,
        showZoomSlidersProp: Spotfire.ModProperty<boolean>,
        dualAssignmentsProp: Spotfire.ModProperty<string>,
        showMarkersProp: Spotfire.ModProperty<boolean>,
        markerSizeProp: Spotfire.ModProperty<number>,
        xZoomProp: Spotfire.ModProperty<string>,
        yZoomProp: Spotfire.ModProperty<string>
    ) {
        const container = document.querySelector("#mod-container");
        if (!container) {
            settingsPanelOpen = false;
            return;
        }

        document.querySelector(".settings-panel")?.remove();
        document.querySelector(".settings-backdrop")?.remove();

        try {
            const backdrop = document.createElement("div");
            backdrop.className = "settings-backdrop";
            backdrop.addEventListener("click", () => closeSettingsPanel());

            const wrapper = document.createElement("div");
            wrapper.innerHTML = settingsPanelHtml(
                yScaleModeProp,
                seriesStylesProp,
                yFormatProp,
                xFormatProp,
                showZoomSlidersProp,
                dualAssignmentsProp
            );
            const panel = wrapper.querySelector(".settings-panel") as HTMLElement | null;
            if (!panel) {
                settingsPanelOpen = false;
                return;
            }
            panel.addEventListener("click", (panelEvent) => panelEvent.stopPropagation());

            panel.querySelectorAll<HTMLInputElement>('input[name="yScaleMode"]').forEach((input) => {
                input.addEventListener("change", () => {
                    if (input.checked) {
                        yScaleModeProp.set(input.value);
                    }
                });
            });
            wireNumberFormatControls(panel, "y", yFormatProp);
            if (!xAxisIsDate) {
                wireNumberFormatControls(panel, "x", xFormatProp);
            }
            panel.querySelectorAll<HTMLInputElement>('input[name="showZoomSliders"]').forEach((input) => {
                input.addEventListener("change", () => {
                    showZoomSlidersProp.set(input.checked);
                    if (!input.checked) {
                        // Hiding zoom sliders restores full X/Y scale.
                        xZoomProp.set("0,1");
                        yZoomProp.set("0,1");
                        xWindow = { start: 0, end: 1 };
                        yWindow = { start: 0, end: 1 };
                    }
                });
            });
            const showMarkersInput = panel.querySelector<HTMLInputElement>('input[name="showMarkers"]');
            const markerSizeInput = panel.querySelector<HTMLInputElement>('input[name="markerSize"]');
            const markerSizeLabel = panel.querySelector<HTMLElement>(".marker-size-value");
            showMarkersInput?.addEventListener("change", () => {
                showMarkersProp.set(Boolean(showMarkersInput.checked));
            });
            markerSizeInput?.addEventListener("input", () => {
                const next = normalizeMarkerSize(Number(markerSizeInput.value));
                if (markerSizeLabel) {
                    markerSizeLabel.textContent = String(next);
                }
                markerSizeProp.set(next);
            });
            panel.querySelectorAll<HTMLInputElement>(`input[name^="${seriesStylePrefix}"]`).forEach((input) => {
                input.addEventListener("change", () => {
                    if (!input.checked) {
                        return;
                    }
                    const encoded = input.name.slice(seriesStylePrefix.length);
                    let seriesKey = encoded;
                    try {
                        seriesKey = decodeURIComponent(encoded);
                    } catch {
                        // keep encoded key
                    }
                    const next = parseKeyedMap(seriesStylesProp.value(), normalizeSeriesStyle) as Map<
                        string,
                        SeriesStyle
                    >;
                    availableSeries.forEach((series) => {
                        if (!next.has(series.key)) {
                            next.set(series.key, "line");
                        }
                    });
                    next.set(seriesKey, normalizeSeriesStyle(input.value));
                    seriesStylesProp.set(serializeKeyedMap(next));
                });
            });

            panel.querySelectorAll<HTMLInputElement>(`input[name^="${dualSidePrefix}"]`).forEach((input) => {
                input.addEventListener("change", () => {
                    if (!input.checked) {
                        return;
                    }
                    // Persist every series side from the panel, then activate Dual so it takes effect.
                    const checkedSides = new Map<string, Side>();
                    panel.querySelectorAll<HTMLInputElement>(`input[name^="${dualSidePrefix}"]`).forEach((el) => {
                        if (!el.checked) {
                            return;
                        }
                        const encoded = el.name.slice(dualSidePrefix.length);
                        let key = encoded;
                        try {
                            key = decodeURIComponent(encoded);
                        } catch {
                            // keep encoded key
                        }
                        checkedSides.set(key, el.value === "Right" ? "Right" : "Left");
                    });
                    const next = new Map<string, Side>();
                    availableSeries.forEach((series, index) => {
                        next.set(
                            series.key,
                            checkedSides.get(series.key) ?? (index === 0 ? "Left" : "Right")
                        );
                    });
                    dualAssignmentsProp.set(serializeKeyedMap(next));
                    if (normalizeAxisMode(yScaleModeProp.value()) !== "Dual") {
                        yScaleModeProp.set("Dual");
                    }
                });
            });

            container.appendChild(backdrop);
            container.appendChild(panel);
            settingsPanelOpen = true;
        } catch (error) {
            settingsPanelOpen = false;
            document.querySelector(".settings-panel")?.remove();
            document.querySelector(".settings-backdrop")?.remove();
            const message = error instanceof Error ? error.message : String(error);
            mod.controls.errorOverlay.show(`Settings panel failed: ${message}`);
        }
    }

    function wireSettingsButton(
        yScaleModeProp: Spotfire.ModProperty<string>,
        seriesStylesProp: Spotfire.ModProperty<string>,
        yFormatProp: Spotfire.ModProperty<string>,
        xFormatProp: Spotfire.ModProperty<string>,
        showZoomSlidersProp: Spotfire.ModProperty<boolean>,
        dualAssignmentsProp: Spotfire.ModProperty<string>,
        showMarkersProp: Spotfire.ModProperty<boolean>,
        markerSizeProp: Spotfire.ModProperty<number>,
        xZoomProp: Spotfire.ModProperty<string>,
        yZoomProp: Spotfire.ModProperty<string>
    ) {
        document.querySelectorAll<HTMLButtonElement>("button[data-action='open-settings']").forEach((button) => {
            button.addEventListener("click", (event) => {
                event.preventDefault();
                event.stopPropagation();
                const panelVisible = Boolean(document.querySelector(".settings-panel"));
                // Recover if flag is stale after a re-render wiped the panel DOM.
                if (settingsPanelOpen && panelVisible) {
                    closeSettingsPanel();
                    return;
                }
                settingsPanelOpen = false;
                openSettingsPanel(
                    yScaleModeProp,
                    seriesStylesProp,
                    yFormatProp,
                    xFormatProp,
                    showZoomSlidersProp,
                    dualAssignmentsProp,
                    showMarkersProp,
                    markerSizeProp,
                    xZoomProp,
                    yZoomProp
                );
            });
        });
    }

    function markerRadiusFor(point: SeriesPoint, _style: SeriesStyle): number {
        const base = markerSizeValue;
        if (point.size == null || !sizeValueRange) {
            return base;
        }
        const span = sizeValueRange.max - sizeValueRange.min || 1;
        const t = (point.size - sizeValueRange.min) / span;
        const minR = Math.max(1, base * 0.45);
        const maxR = Math.max(minR + 1, Math.min(markerRadiusMax, base * 2.4));
        return minR + Math.max(0, Math.min(1, t)) * (maxR - minR);
    }

    function formatShortNumber(value: number, decimals: number): string {
        const abs = Math.abs(value);
        const trim = (n: number) => {
            const fixed = n.toFixed(Math.min(1, decimals));
            return fixed.replace(/\.0$/, "");
        };
        if (abs >= 1e9) {
            return `${trim(abs / 1e9)}B`;
        }
        if (abs >= 1e6) {
            return `${trim(abs / 1e6)}M`;
        }
        if (abs >= 1e3) {
            return `${trim(abs / 1e3)}K`;
        }
        return abs.toFixed(decimals);
    }

    function formatAbsoluteNumber(value: number, format: NumberFormatConfig): string {
        const abs = Math.abs(value);
        if (format.useShort) {
            return formatShortNumber(abs, format.decimals);
        }
        if (format.thousandsSeparator) {
            return abs.toLocaleString("en-US", {
                minimumFractionDigits: format.decimals,
                maximumFractionDigits: format.decimals
            });
        }
        return abs.toFixed(format.decimals);
    }

    function usesParenNegatives(style: NegativeNumberStyle): boolean {
        return style === "parens" || style === "parensRed";
    }

    function usesRedNegatives(style: NegativeNumberStyle): boolean {
        return style === "minusRed" || style === "parensRed";
    }

    function formatNumberValue(value: number, format: NumberFormatConfig): string {
        const body = formatAbsoluteNumber(value, format);
        if (value < 0) {
            return usesParenNegatives(format.negativeStyle) ? `(${body})` : `-${body}`;
        }
        return body;
    }

    function axisLabelHtml(value: number, format: NumberFormatConfig): string {
        const text = escapeXml(formatNumberValue(value, format));
        if (value < 0 && usesRedNegatives(format.negativeStyle)) {
            return `<tspan fill="#c62828">${text}</tspan>`;
        }
        return text;
    }

    function formatXLabel(
        leaf: Spotfire.DataViewHierarchyNode,
        xFormat: NumberFormatConfig,
        isDate: boolean
    ): string {
        // Dates always keep Spotfire default formatting.
        if (isDate) {
            return leaf.formattedValue();
        }

        const raw = leaf.value();
        const numeric =
            typeof raw === "number"
                ? raw
                : typeof raw === "string" && raw.trim() !== "" && !Number.isNaN(Number(raw))
                  ? Number(raw)
                  : null;

        if (numeric != null && Number.isFinite(numeric)) {
            return formatNumberValue(numeric, xFormat);
        }

        return leaf.formattedValue();
    }

    function markRows(
        dataView: Spotfire.DataView,
        rows: Spotfire.DataViewRow[],
        event: MouseEvent | { ctrlKey?: boolean; shiftKey?: boolean },
        markingEnabled: boolean
    ) {
        if (!markingEnabled) {
            mod.controls.errorOverlay.show(
                "Marking is not enabled. In Visualization properties → Data, set Marking to an active marking (e.g. Marking)."
            );
            return;
        }
        if (rows.length === 0) {
            return;
        }
        // Match Spotfire default: Ctrl toggles, Shift adds, plain click replaces.
        const mode = event.ctrlKey ? "Toggle" : event.shiftKey ? "Add" : "Replace";
        dataView.mark(rows, mode);
    }

    function clientToSvgPoint(svg: SVGSVGElement, clientX: number, clientY: number): { x: number; y: number } {
        const rect = svg.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) {
            return { x: 0, y: 0 };
        }
        const viewWidth = svg.viewBox.baseVal.width || rect.width;
        const viewHeight = svg.viewBox.baseVal.height || rect.height;
        return {
            x: ((clientX - rect.left) / rect.width) * viewWidth,
            y: ((clientY - rect.top) / rect.height) * viewHeight
        };
    }

    function wirePoints(
        dataView: Spotfire.DataView,
        pointElements: { cx: number; cy: number; point: SeriesPoint }[],
        markingEnabled: boolean,
        plotBounds: PlotBounds
    ) {
        const svg = document.querySelector<SVGSVGElement>("#mod-container svg.chart");
        if (!svg) {
            return;
        }

        let suppressClickClear = false;
        let tooltipIndex = -1;
        svg.style.pointerEvents = "auto";
        svg.style.touchAction = "none";
        svg.style.cursor = markingEnabled ? "crosshair" : "default";

        const markPointIndex = (index: number, event: MouseEvent) => {
            const item = pointElements[index];
            if (!item) {
                return;
            }
            markRows(dataView, [item.point.row], event, markingEnabled);
        };

        // Drag a rectangle on empty plot area to mark all points inside.
        let drag:
            | {
                  pointerId: number;
                  startX: number;
                  startY: number;
                  currentX: number;
                  currentY: number;
                  active: boolean;
              }
            | null = null;

        let marquee = svg.querySelector<SVGRectElement>("rect.mark-marquee");
        const ensureMarquee = () => {
            if (!marquee) {
                marquee = document.createElementNS("http://www.w3.org/2000/svg", "rect");
                marquee.setAttribute("class", "mark-marquee");
                svg.appendChild(marquee);
            }
            return marquee;
        };

        const updateMarquee = (startX: number, startY: number, endX: number, endY: number) => {
            const el = ensureMarquee();
            const x1 = Math.max(plotBounds.left, Math.min(startX, endX));
            const y1 = Math.max(plotBounds.top, Math.min(startY, endY));
            const x2 = Math.min(plotBounds.left + plotBounds.width, Math.max(startX, endX));
            const y2 = Math.min(plotBounds.top + plotBounds.height, Math.max(startY, endY));
            el.setAttribute("x", `${x1}`);
            el.setAttribute("y", `${y1}`);
            el.setAttribute("width", `${Math.max(0, x2 - x1)}`);
            el.setAttribute("height", `${Math.max(0, y2 - y1)}`);
            el.style.display = "block";
        };

        const hideMarquee = () => {
            if (marquee) {
                marquee.style.display = "none";
            }
        };

        const isInteractiveTarget = (target: Element | null) =>
            Boolean(
                target &&
                    (target.closest(".series-point") ||
                        target.closest(".series-line-hit") ||
                        target.closest(".settings-button") ||
                        target.closest(".settings-panel") ||
                        target.closest(".zoom-slot") ||
                        target.closest(".zoom-reset"))
            );

        svg.addEventListener("pointerdown", (event) => {
            if (!markingEnabled || event.button !== 0) {
                return;
            }
            if (isInteractiveTarget(event.target as Element | null)) {
                return;
            }
            const pt = clientToSvgPoint(svg, event.clientX, event.clientY);
            if (
                pt.x < plotBounds.left ||
                pt.x > plotBounds.left + plotBounds.width ||
                pt.y < plotBounds.top ||
                pt.y > plotBounds.top + plotBounds.height
            ) {
                return;
            }
            drag = {
                pointerId: event.pointerId,
                startX: pt.x,
                startY: pt.y,
                currentX: pt.x,
                currentY: pt.y,
                active: false
            };
            svg.setPointerCapture(event.pointerId);
            event.preventDefault();
        });

        svg.addEventListener("pointermove", (event) => {
            if (!drag || drag.pointerId !== event.pointerId) {
                return;
            }
            const pt = clientToSvgPoint(svg, event.clientX, event.clientY);
            drag.currentX = pt.x;
            drag.currentY = pt.y;
            if (!drag.active && (Math.abs(drag.currentX - drag.startX) > 3 || Math.abs(drag.currentY - drag.startY) > 3)) {
                drag.active = true;
                suppressClickClear = true;
            }
            if (drag.active) {
                updateMarquee(drag.startX, drag.startY, drag.currentX, drag.currentY);
            }
        });

        const endDrag = (event: PointerEvent) => {
            if (!drag || drag.pointerId !== event.pointerId) {
                return;
            }
            const current = drag;
            drag = null;
            try {
                svg.releasePointerCapture(event.pointerId);
            } catch {
                // ignore if capture already released
            }
            hideMarquee();

            if (!current.active) {
                if (markingEnabled && !event.ctrlKey && !event.shiftKey) {
                    dataView.clearMarking();
                }
                return;
            }

            const x1 = Math.min(current.startX, current.currentX);
            const x2 = Math.max(current.startX, current.currentX);
            const y1 = Math.min(current.startY, current.currentY);
            const y2 = Math.max(current.startY, current.currentY);

            const xIndexesInSpan = new Set<number>();
            const xIndexesInBand = new Set<number>();
            for (let i = 0; i < pointElements.length; i++) {
                const item = pointElements[i];
                if (item.cx < x1 || item.cx > x2) {
                    continue;
                }
                xIndexesInSpan.add(item.point.xIndex);
                if (item.cy >= y1 && item.cy <= y2) {
                    xIndexesInBand.add(item.point.xIndex);
                }
            }
            const selectedXIndexes = xIndexesInBand.size > 0 ? xIndexesInBand : xIndexesInSpan;

            const uniqueRows: Spotfire.DataViewRow[] = [];
            const seen = new Set<Spotfire.DataViewRow>();
            for (let i = 0; i < pointElements.length; i++) {
                const item = pointElements[i];
                if (!selectedXIndexes.has(item.point.xIndex)) {
                    continue;
                }
                const row = item.point.row;
                if (!seen.has(row)) {
                    seen.add(row);
                    uniqueRows.push(row);
                }
            }

            if (uniqueRows.length > 0) {
                markRows(dataView, uniqueRows, event, markingEnabled);
            } else if (!event.ctrlKey && !event.shiftKey) {
                dataView.clearMarking();
            }

            window.setTimeout(() => {
                suppressClickClear = false;
            }, 0);
        };

        svg.addEventListener("pointerup", endDrag);
        svg.addEventListener("pointercancel", endDrag);

        // One delegated click handler for points, line hits, and empty clear.
        svg.addEventListener("click", (event) => {
            if (suppressClickClear) {
                event.preventDefault();
                event.stopPropagation();
                return;
            }

            const target = event.target as Element | null;
            if (!target) {
                return;
            }

            const pointEl = target.closest("circle.series-point") as SVGCircleElement | null;
            if (pointEl && svg.contains(pointEl)) {
                event.preventDefault();
                event.stopPropagation();
                markPointIndex(Number(pointEl.dataset.index), event);
                return;
            }

            const lineHit = target.closest("path.series-line-hit") as SVGPathElement | null;
            if (lineHit && svg.contains(lineHit)) {
                event.preventDefault();
                event.stopPropagation();
                const { x, y } = clientToSvgPoint(svg, event.clientX, event.clientY);
                let seriesKey = lineHit.dataset.seriesKey || "";
                try {
                    seriesKey = decodeURIComponent(seriesKey);
                } catch {
                    // keep encoded key
                }
                let bestIndex = -1;
                let bestDist = Number.POSITIVE_INFINITY;
                for (let index = 0; index < pointElements.length; index++) {
                    const item = pointElements[index];
                    if (seriesKey && item.point.seriesKey !== seriesKey) {
                        continue;
                    }
                    const dist = (item.cx - x) * (item.cx - x) + (item.cy - y) * (item.cy - y);
                    if (dist < bestDist) {
                        bestDist = dist;
                        bestIndex = index;
                    }
                }
                if (bestIndex >= 0) {
                    markPointIndex(bestIndex, event);
                }
                return;
            }

            if (target.closest(".mark-marquee")) {
                return;
            }
            if (markingEnabled) {
                dataView.clearMarking();
            }
        });

        const nearestPointIndex = (clientX: number, clientY: number, seriesKeyFilter?: string) => {
            const { x, y } = clientToSvgPoint(svg, clientX, clientY);
            let bestIndex = -1;
            let bestDist = Number.POSITIVE_INFINITY;
            for (let index = 0; index < pointElements.length; index++) {
                const item = pointElements[index];
                if (seriesKeyFilter && item.point.seriesKey !== seriesKeyFilter) {
                    continue;
                }
                const dist = (item.cx - x) * (item.cx - x) + (item.cy - y) * (item.cy - y);
                if (dist < bestDist) {
                    bestDist = dist;
                    bestIndex = index;
                }
            }
            return bestIndex;
        };

        const showTooltipAt = (index: number) => {
            if (!Number.isFinite(index) || index < 0 || index === tooltipIndex) {
                return;
            }
            const item = pointElements[index];
            if (!item) {
                return;
            }
            tooltipIndex = index;
            // Uses Spotfire's configurable tooltip (dataViewDefinition.tooltip.enabled).
            mod.controls.tooltip.show(item.point.row);
        };

        // Delegated tooltips — points and line hits; avoids thousands of per-circle listeners.
        svg.addEventListener("mouseover", (event) => {
            const target = event.target as Element | null;
            if (!target) {
                return;
            }

            const pointEl = target.closest?.("circle.series-point") as SVGCircleElement | null;
            if (pointEl && svg.contains(pointEl)) {
                showTooltipAt(Number(pointEl.dataset.index));
                return;
            }

            const lineHit = target.closest?.("path.series-line-hit") as SVGPathElement | null;
            if (lineHit && svg.contains(lineHit)) {
                let seriesKey = lineHit.dataset.seriesKey || "";
                try {
                    seriesKey = decodeURIComponent(seriesKey);
                } catch {
                    // keep encoded key
                }
                showTooltipAt(nearestPointIndex(event.clientX, event.clientY, seriesKey || undefined));
            }
        });

        svg.addEventListener("mousemove", (event) => {
            const lineHit = (event.target as Element | null)?.closest?.(
                "path.series-line-hit"
            ) as SVGPathElement | null;
            if (!lineHit || !svg.contains(lineHit)) {
                return;
            }
            let seriesKey = lineHit.dataset.seriesKey || "";
            try {
                seriesKey = decodeURIComponent(seriesKey);
            } catch {
                // keep encoded key
            }
            showTooltipAt(nearestPointIndex(event.clientX, event.clientY, seriesKey || undefined));
        });

        svg.addEventListener("mouseout", (event) => {
            const target = event.target as Element | null;
            if (!target) {
                return;
            }
            const leavingPoint = target.closest?.("circle.series-point");
            const leavingLine = target.closest?.("path.series-line-hit");
            if (!leavingPoint && !leavingLine) {
                return;
            }
            const related = event.relatedTarget as Element | null;
            if (
                related &&
                svg.contains(related) &&
                (related.closest?.("circle.series-point") || related.closest?.("path.series-line-hit"))
            ) {
                return;
            }
            tooltipIndex = -1;
            mod.controls.tooltip.hide();
        });
    }

    function paddedRange(min: number, max: number): { min: number; max: number } {
        let lo = min;
        let hi = max;
        if (lo === hi) {
            lo -= 1;
            hi += 1;
        }
        const pad = (hi - lo) * 0.05;
        return { min: lo - pad, max: hi + pad };
    }

    function rangeOf(values: number[]): { min: number; max: number } {
        let min = Number.POSITIVE_INFINITY;
        let max = Number.NEGATIVE_INFINITY;
        for (let i = 0; i < values.length; i++) {
            const value = values[i];
            if (value < min) {
                min = value;
            }
            if (value > max) {
                max = value;
            }
        }
        return paddedRange(min, max);
    }

    function rangeOfPoints(points: SeriesPoint[]): { min: number; max: number } {
        let min = Number.POSITIVE_INFINITY;
        let max = Number.NEGATIVE_INFINITY;
        for (let i = 0; i < points.length; i++) {
            const value = points[i].y;
            if (value < min) {
                min = value;
            }
            if (value > max) {
                max = value;
            }
        }
        return paddedRange(min, max);
    }

    function appendXAxisLabels(
        content: string[],
        xLabels: string[],
        xCount: number,
        xScale: (index: number) => number,
        plotWidth: number,
        labelY: number
    ) {
        const xIndexMin = xWindow.start * Math.max(xCount - 1, 0);
        const xIndexMax = xWindow.end * Math.max(xCount - 1, 0);
        const first = Math.max(0, Math.ceil(xIndexMin - 0.5));
        const last = Math.min(xLabels.length - 1, Math.floor(xIndexMax + 0.5));
        if (last < first) {
            return;
        }
        const visibleCount = last - first + 1;
        const xLabelStep = Math.max(1, Math.ceil(visibleCount / Math.max(Math.floor(plotWidth / 55), 1)));
        for (let index = first, stepIndex = 0; index <= last; index++, stepIndex++) {
            if (stepIndex % xLabelStep !== 0 && index !== last) {
                continue;
            }
            content.push(
                `<text class="axis-label" text-anchor="middle" x="${xScale(index)}" y="${labelY}">${escapeXml(truncate(xLabels[index], 12))}</text>`
            );
        }
    }

    function createXScale(
        categoryCount: number,
        left: number,
        plotWidth: number,
        zoomStart = 0,
        zoomEnd = 1
    ) {
        return (index: number) => {
            if (categoryCount <= 1) {
                return left + plotWidth / 2;
            }
            const i0 = zoomStart * (categoryCount - 1);
            const i1 = Math.max(i0 + 1e-6, zoomEnd * (categoryCount - 1));
            return left + ((index - i0) / (i1 - i0)) * plotWidth;
        };
    }

    function formatNumber(value: number): string {
        return axisLabelHtml(value, currentYFormat);
    }

    function yValuesForSeriesKeys(
        keys: string[],
        seriesMap: Map<string, SeriesPoint[]>
    ): number[] {
        const values: number[] = [];
        for (let i = 0; i < keys.length; i++) {
            const series = seriesMap.get(keys[i]);
            if (!series) {
                continue;
            }
            for (let j = 0; j < series.length; j++) {
                values.push(series[j].y);
            }
        }
        return values;
    }

    function drawSeries(
        content: string[],
        pointElements: { cx: number; cy: number; point: SeriesPoint }[],
        series: SeriesPoint[],
        color: string,
        style: SeriesStyle,
        xScale: (index: number) => number,
        yScale: (value: number) => number,
        hasAnyMarked = false
    ) {
        if (style === "hide" || series.length === 0) {
            return;
        }

        const seriesKeyAttr = encodeURIComponent(series[0]?.seriesKey ?? "");
        let seriesHasMarked = false;
        const coords = new Array<{ cx: number; cy: number; point: SeriesPoint }>(series.length);
        for (let i = 0; i < series.length; i++) {
            const point = series[i];
            if (point.marked) {
                seriesHasMarked = true;
            }
            coords[i] = { cx: xScale(point.xIndex), cy: yScale(point.y), point };
        }

        // When anything is marked: fade unmarked series more; keep series-with-marks readable.
        const lineOpacity = !hasAnyMarked ? "1" : seriesHasMarked ? "0.55" : "0.22";
        if (style === "line" || style === "dash") {
            let path = "";
            for (let i = 0; i < coords.length; i++) {
                const { cx, cy } = coords[i];
                path += `${i === 0 ? "M" : "L"}${cx.toFixed(2)},${cy.toFixed(2)}`;
                if (i < coords.length - 1) {
                    path += " ";
                }
            }
            const dashAttr = style === "dash" ? ' stroke-dasharray="6 4"' : "";
            content.push(`<path class="series-line-hit" data-series-key="${seriesKeyAttr}" d="${path}" />`);
            content.push(
                `<path class="series-line" stroke="${color}" opacity="${lineOpacity}"${dashAttr} d="${path}" />`
            );
        }

        // Every data point gets a clickable hit target so marking always works.
        const sizeByActive = sizeValueRange != null;
        // Markers: Settings toggle, Points style, Size by, or active marking.
        const showMarkers = showMarkersEnabled || style === "dots" || sizeByActive || hasAnyMarked;

        for (let index = 0; index < coords.length; index++) {
            const { cx, cy, point } = coords[index];
            const idx = pointElements.length;
            pointElements.push({ cx, cy, point });
            const markedClass = point.marked ? " is-marked" : "";
            const visibleRadius = markerRadiusFor(point, style);
            const hitRadius = Math.max(10, visibleRadius + 4);
            // Marked stays full strength; non-selected fades. Use series color + opacity
            // so Spotfire's washed unmarked hex codes don't double-dim.
            const pointOpacity = point.marked ? "1" : hasAnyMarked ? "0.28" : "1";
            content.push(
                `<circle class="series-point hit-target${markedClass}" data-index="${idx}" cx="${cx.toFixed(2)}" cy="${cy.toFixed(2)}" r="${hitRadius.toFixed(2)}" />`
            );
            if (showMarkers || point.marked) {
                content.push(
                    `<circle class="series-point marker${markedClass}" data-index="${idx}" cx="${cx.toFixed(2)}" cy="${cy.toFixed(2)}" r="${visibleRadius.toFixed(2)}" fill="${color}" opacity="${pointOpacity}" />`
                );
            }
        }
    }

    function renderSingleScale(
        width: number,
        height: number,
        xLabels: string[],
        xCount: number,
        seriesKeys: string[],
        seriesMap: Map<string, SeriesPoint[]>,
        seriesMeta: Map<string, { label: string; color: string }>,
        getStyle: (key: string) => SeriesStyle
    ) {
        // Scale from visible series only (caller already excludes Hide).
        const visibleValues = yValuesForSeriesKeys(seriesKeys, seriesMap);
        const fullY = visibleValues.length ? rangeOf(visibleValues) : paddedRange(0, 1);
        const { min: yMin, max: yMax } = zoomedRange(fullY, yWindow);
        const margin = {
            top: 28,
            right: 16,
            bottom: 36 + (showZoomSliders ? zoomTrackSize : 0),
            left: 52
        };
        const plotWidth = Math.max(width - margin.left - margin.right, 1);
        const plotHeight = Math.max(height - margin.top - margin.bottom, 1);
        const xScale = createXScale(xCount, margin.left, plotWidth, xWindow.start, xWindow.end);
        const yScale = (value: number) => margin.top + ((yMax - value) / (yMax - yMin)) * plotHeight;

        const content: string[] = [];
        const pointElements: { cx: number; cy: number; point: SeriesPoint }[] = [];

        content.push(
            `<defs><clipPath id="plot-clip"><rect x="${margin.left}" y="${margin.top}" width="${plotWidth}" height="${plotHeight}" /></clipPath></defs>`
        );

        for (let i = 0; i <= 5; i++) {
            const value = yMin + ((yMax - yMin) * i) / 5;
            const y = yScale(value);
            content.push(
                `<line class="grid-line" x1="${margin.left}" y1="${y}" x2="${margin.left + plotWidth}" y2="${y}" />`
            );
            content.push(
                `<text class="axis-label" text-anchor="end" x="${margin.left - 8}" y="${y + 3}">${formatNumber(value)}</text>`
            );
        }

        content.push(
            `<line class="axis-line" x1="${margin.left}" y1="${margin.top}" x2="${margin.left}" y2="${margin.top + plotHeight}" />`
        );
        content.push(
            `<line class="axis-line" x1="${margin.left}" y1="${margin.top + plotHeight}" x2="${margin.left + plotWidth}" y2="${margin.top + plotHeight}" />`
        );

        appendXAxisLabels(content, xLabels, xCount, xScale, plotWidth, height - 14);

        content.push(`<g clip-path="url(#plot-clip)">`);
        for (let s = 0; s < seriesKeys.length; s++) {
            const seriesKey = seriesKeys[s];
            const series = seriesMap.get(seriesKey)!;
            const meta = seriesMeta.get(seriesKey)!;
            drawSeries(content, pointElements, series, meta.color, getStyle(seriesKey), xScale, yScale, hasAnyMarked);
        }
        content.push(`</g>`);

        return {
            html: `<svg class="chart" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${content.join("")}</svg>`,
            pointElements,
            plotBounds: { left: margin.left, top: margin.top, width: plotWidth, height: plotHeight },
            showRightYZoom: false
        };
    }

    function renderDualScales(
        width: number,
        height: number,
        xLabels: string[],
        xCount: number,
        seriesKeys: string[],
        seriesMap: Map<string, SeriesPoint[]>,
        seriesMeta: Map<string, { label: string; color: string }>,
        getStyle: (key: string) => SeriesStyle,
        getSide: (key: string) => Side
    ) {
        // seriesKeys are already visible-only from the caller.
        const leftKeys = seriesKeys.filter((key) => getSide(key) !== "Right");
        const rightKeys = seriesKeys.filter((key) => getSide(key) === "Right");
        // Keep both sides populated so dual axes remain meaningful (draw + scale).
        if (leftKeys.length === 0 && rightKeys.length > 0) {
            leftKeys.push(rightKeys.shift()!);
        }
        if (rightKeys.length === 0 && leftKeys.length > 1) {
            rightKeys.push(leftKeys.pop()!);
        }
        const rightSet = new Set(rightKeys);
        const effectiveSide = (key: string): Side => (rightSet.has(key) ? "Right" : "Left");

        const leftValues = yValuesForSeriesKeys(leftKeys, seriesMap);
        const rightValues = yValuesForSeriesKeys(rightKeys, seriesMap);
        const leftRange = zoomedRange(
            leftValues.length ? rangeOf(leftValues) : paddedRange(0, 1),
            yWindow
        );
        const rightRange = zoomedRange(
            rightValues.length ? rangeOf(rightValues) : paddedRange(0, 1),
            yWindow
        );

        const margin = {
            top: 28,
            right: 56,
            bottom: 36 + (showZoomSliders ? zoomTrackSize : 0),
            left: 52
        };
        const plotWidth = Math.max(width - margin.left - margin.right, 1);
        const plotHeight = Math.max(height - margin.top - margin.bottom, 1);
        const xScale = createXScale(xCount, margin.left, plotWidth, xWindow.start, xWindow.end);
        const yScaleLeft = (value: number) =>
            margin.top + ((leftRange.max - value) / (leftRange.max - leftRange.min || 1)) * plotHeight;
        const yScaleRight = (value: number) =>
            margin.top + ((rightRange.max - value) / (rightRange.max - rightRange.min || 1)) * plotHeight;

        const content: string[] = [];
        const pointElements: { cx: number; cy: number; point: SeriesPoint }[] = [];

        content.push(
            `<defs><clipPath id="plot-clip"><rect x="${margin.left}" y="${margin.top}" width="${plotWidth}" height="${plotHeight}" /></clipPath></defs>`
        );

        for (let i = 0; i <= 5; i++) {
            const leftValue = leftRange.min + ((leftRange.max - leftRange.min) * i) / 5;
            const rightValue = rightRange.min + ((rightRange.max - rightRange.min) * i) / 5;
            const yL = yScaleLeft(leftValue);
            const yR = yScaleRight(rightValue);
            content.push(
                `<line class="grid-line" x1="${margin.left}" y1="${yL}" x2="${margin.left + plotWidth}" y2="${yL}" />`
            );
            content.push(
                `<text class="axis-label" text-anchor="end" x="${margin.left - 8}" y="${yL + 3}">${formatNumber(leftValue)}</text>`
            );
            content.push(
                `<text class="axis-label axis-label-right" text-anchor="start" x="${margin.left + plotWidth + 8}" y="${yR + 3}">${formatNumber(rightValue)}</text>`
            );
        }

        content.push(
            `<line class="axis-line" x1="${margin.left}" y1="${margin.top}" x2="${margin.left}" y2="${margin.top + plotHeight}" />`
        );
        content.push(
            `<line class="axis-line" x1="${margin.left + plotWidth}" y1="${margin.top}" x2="${margin.left + plotWidth}" y2="${margin.top + plotHeight}" />`
        );
        content.push(
            `<line class="axis-line" x1="${margin.left}" y1="${margin.top + plotHeight}" x2="${margin.left + plotWidth}" y2="${margin.top + plotHeight}" />`
        );

        appendXAxisLabels(content, xLabels, xCount, xScale, plotWidth, height - 14);

        content.push(`<g clip-path="url(#plot-clip)">`);
        for (let s = 0; s < seriesKeys.length; s++) {
            const seriesKey = seriesKeys[s];
            const series = seriesMap.get(seriesKey)!;
            const meta = seriesMeta.get(seriesKey)!;
            const yScale = effectiveSide(seriesKey) === "Right" ? yScaleRight : yScaleLeft;
            drawSeries(content, pointElements, series, meta.color, getStyle(seriesKey), xScale, yScale, hasAnyMarked);
        }
        content.push(`</g>`);

        return {
            html: `<svg class="chart" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${content.join("")}</svg>`,
            pointElements,
            plotBounds: { left: margin.left, top: margin.top, width: plotWidth, height: plotHeight },
            showRightYZoom: true
        };
    }

    function renderMultipleScales(
        width: number,
        height: number,
        xLabels: string[],
        xCount: number,
        seriesKeys: string[],
        seriesMap: Map<string, SeriesPoint[]>,
        seriesMeta: Map<string, { label: string; color: string }>,
        getStyle: (key: string) => SeriesStyle
    ) {
        const panelGap = 12;
        const topPad = 28;
        const bottomPad = 28 + (showZoomSliders ? zoomTrackSize : 0);
        const left = 52;
        const right = 12;
        const plotWidth = Math.max(width - left - right, 1);
        const usableHeight = Math.max(height - topPad - bottomPad - panelGap * (seriesKeys.length - 1), 1);
        const panelHeight = usableHeight / seriesKeys.length;
        const xScale = createXScale(xCount, left, plotWidth, xWindow.start, xWindow.end);

        const content: string[] = [];
        const pointElements: { cx: number; cy: number; point: SeriesPoint }[] = [];

        content.push(`<defs>`);
        for (let index = 0; index < seriesKeys.length; index++) {
            const plotTop = topPad + index * (panelHeight + panelGap) + 14;
            const plotHeight = Math.max(panelHeight - 18, 1);
            content.push(
                `<clipPath id="plot-clip-${index}"><rect x="${left}" y="${plotTop}" width="${plotWidth}" height="${plotHeight}" /></clipPath>`
            );
        }
        content.push(`</defs>`);

        for (let index = 0; index < seriesKeys.length; index++) {
            const seriesKey = seriesKeys[index];
            const series = seriesMap.get(seriesKey)!;
            const meta = seriesMeta.get(seriesKey)!;
            const style = getStyle(seriesKey);
            const { min: yMin, max: yMax } = zoomedRange(rangeOfPoints(series), yWindow);
            const plotTop = topPad + index * (panelHeight + panelGap) + 14;
            const plotHeight = Math.max(panelHeight - 18, 1);
            const yScale = (value: number) => plotTop + ((yMax - value) / (yMax - yMin)) * plotHeight;
            const isLast = index === seriesKeys.length - 1;

            // Panel label only (Spotfire legend already shows series names).
            content.push(
                `<text class="series-title" fill="${meta.color}" x="${left}" y="${plotTop - 4}">${escapeXml(truncate(meta.label, 40))}</text>`
            );

            for (let i = 0; i <= 3; i++) {
                const value = yMin + ((yMax - yMin) * i) / 3;
                const y = yScale(value);
                content.push(
                    `<line class="grid-line" x1="${left}" y1="${y}" x2="${left + plotWidth}" y2="${y}" />`
                );
                content.push(
                    `<text class="axis-label" text-anchor="end" x="${left - 8}" y="${y + 3}">${formatNumber(value)}</text>`
                );
            }

            content.push(
                `<line class="axis-line" x1="${left}" y1="${plotTop}" x2="${left}" y2="${plotTop + plotHeight}" />`
            );
            content.push(
                `<line class="axis-line" x1="${left}" y1="${plotTop + plotHeight}" x2="${left + plotWidth}" y2="${plotTop + plotHeight}" />`
            );

            content.push(`<g clip-path="url(#plot-clip-${index})">`);
            drawSeries(content, pointElements, series, meta.color, style, xScale, yScale, hasAnyMarked);
            content.push(`</g>`);

            if (isLast) {
                appendXAxisLabels(content, xLabels, xCount, xScale, plotWidth, height - 10);
            } else {
                const dividerY = plotTop + plotHeight + panelGap / 2;
                content.push(
                    `<line class="panel-divider" x1="${left}" y1="${dividerY}" x2="${left + plotWidth}" y2="${dividerY}" />`
                );
            }
        }

        const firstPlotTop = topPad + 14;
        const lastPlotHeight = Math.max(panelHeight - 18, 1);
        const fullPlotHeight = Math.max(
            topPad + seriesKeys.length * (panelHeight + panelGap) - panelGap + 14 + lastPlotHeight - firstPlotTop,
            1
        );
        return {
            html: `<svg class="chart" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${content.join("")}</svg>`,
            pointElements,
            plotBounds: {
                left,
                top: firstPlotTop,
                width: plotWidth,
                height: fullPlotHeight
            },
            showRightYZoom: false
        };
    }

    function truncate(text: string, max: number): string {
        return text.length > max ? `${text.slice(0, max - 1)}…` : text;
    }

    function escapeXml(text: string): string {
        return text
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&apos;");
    }
});
