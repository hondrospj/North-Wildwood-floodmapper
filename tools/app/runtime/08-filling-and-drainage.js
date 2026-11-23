    function isDisconnectedRasterPixel(values, offset) {
      return values[offset + 3] > 0 &&
        Math.abs(values[offset] - 99) <= 4 &&
        Math.abs(values[offset + 1] - 212) <= 4 &&
        Math.abs(values[offset + 2] - 113) <= 4;
    }

    function isWetRasterPixel(values, offset) {
      return values[offset + 3] > 0 && !isDisconnectedRasterPixel(values, offset);
    }

    function getDrainageDepthColor(depthFt) {
      for (let index = 0; index < DRAINAGE_DEPTH_BREAKS_FT.length; index += 1) {
        if (depthFt < DRAINAGE_DEPTH_BREAKS_FT[index]) return DRAINAGE_DEPTH_COLORS[index];
      }
      return DRAINAGE_DEPTH_COLORS[DRAINAGE_DEPTH_COLORS.length - 1];
    }

    function getDrainageStageColor(stageFt) {
      if (stageFt >= MAJOR_FLOOD_FT) return DRAINAGE_STAGE_COLORS[2];
      if (stageFt >= MODERATE_FLOOD_FT) return DRAINAGE_STAGE_COLORS[1];
      return DRAINAGE_STAGE_COLORS[0];
    }

    function getFillingStageFraction(rawStageFt, lowerStageFt) {
      const raw = Number(rawStageFt);
      const lower = Number(lowerStageFt);
      if (!Number.isFinite(raw) || !Number.isFinite(lower)) return 0;
      return Math.max(0, Math.min(1, (raw - lower) / STAGE_STEP));
    }

    function getFillingTransitionBlend(stageFraction) {
      const fraction = Math.max(0, Math.min(1, Number(stageFraction) || 0));
      // Ease the whole newly connected surface in together. A spatial wipe
      // exposes the one-pixel routing skeleton first, which reads as long
      // lines and leaves large pure-green gaps between catalog stages. Treat
      // each catalog tenth as representing values that round to that tenth,
      // so the upper frame is fully established at the half-tenth boundary.
      const nearestFrameProgress = Math.min(1, fraction * 2);
      return nearestFrameProgress * nearestFrameProgress * (3 - 2 * nearestFrameProgress);
    }

    function isDevelopedRasterPixel(developedPixels, offset) {
      return Boolean(developedPixels && developedPixels[offset + 2] >= 128);
    }

    function isFillingTransitionCandidate(lowerPixels, upperPixels, developedPixels, pixel) {
      const offset = pixel * 4;
      return upperPixels[offset + 3] > 0 &&
        !isWetRasterPixel(lowerPixels, offset) &&
        !isDisconnectedRasterPixel(upperPixels, offset) &&
        isDevelopedRasterPixel(developedPixels, offset);
    }

    function getFillingTransitionPixelDepth(queryPixels, developedPixels, pixel, rawStageFt, adjustedStageFt = null) {
      if (!queryPixels || !developedPixels || queryPixels.length !== developedPixels.length) return null;
      const offset = pixel * 4;
      const encodedGround = queryPixels[offset] * 256 + queryPixels[offset + 1];
      if (!encodedGround) return null;
      const groundFt = (encodedGround - 32768) / 10;
      const connectionCode = queryPixels[offset + 2];
      const stageFt = Number(rawStageFt);
      // The upper catalog raster already limits this interpolation to cells
      // that connect during the current tenth-foot interval. Do not compare
      // its quantized connection code to the in-between gauge value or the
      // whole surface remains green until the next catalog frame.
      if (!Number.isFinite(stageFt) || connectionCode === 255) return null;
      const surfaceFt = adjustedStageFt ?? (stageFt - (isDevelopedRasterPixel(developedPixels, offset)
        ? getVerticalBathtubPenalty(stageFt) : 0));
      if (groundFt > surfaceFt + 1e-9) return null;
      // Use the same local water surface as the query and catalog depth model.
      return Math.max(0.005, surfaceFt - groundFt);
    }

    function applyFillingTransitionPixels(
      lowerPixels,
      upperPixels,
      developedPixels,
      width,
      height,
      rawStageFt,
      lowerStageFt,
      mode,
      queryPixels = null
    ) {
      if (!lowerPixels || !upperPixels || lowerPixels.length !== upperPixels.length ||
          !developedPixels || developedPixels.length !== lowerPixels.length ||
          !queryPixels || queryPixels.length !== lowerPixels.length ||
          width * height * 4 !== lowerPixels.length) return 0;
      const fraction = getFillingStageFraction(rawStageFt, lowerStageFt);
      if (!(fraction > 0)) return 0;
      const blend = getFillingTransitionBlend(fraction);
      const transitionStageRgb = getDrainageStageColor(rawStageFt);
      // Transition candidates already passed the developed-land mask, so
      // every cell in this frame uses the same adjusted water surface.
      const adjustedStageFt = Number(rawStageFt) - getVerticalBathtubPenalty(rawStageFt);
      let added = 0;
      const pixelCount = width * height;
      for (let pixel = 0; pixel < pixelCount; pixel += 1) {
        if (!isFillingTransitionCandidate(lowerPixels, upperPixels, developedPixels, pixel)) continue;
        const depthFt = getFillingTransitionPixelDepth(
          queryPixels,
          developedPixels,
          pixel,
          rawStageFt,
          adjustedStageFt
        );
        if (!Number.isFinite(depthFt)) continue;
        const offset = pixel * 4;
        const color = mode === "depth"
          ? getDrainageDepthColor(depthFt)
          : transitionStageRgb;
        const sourceAlpha = lowerPixels[offset + 3];
        if (sourceAlpha > 0) {
          lowerPixels[offset] = Math.round(lowerPixels[offset] * (1 - blend) + color[0] * blend);
          lowerPixels[offset + 1] = Math.round(lowerPixels[offset + 1] * (1 - blend) + color[1] * blend);
          lowerPixels[offset + 2] = Math.round(lowerPixels[offset + 2] * (1 - blend) + color[2] * blend);
          lowerPixels[offset + 3] = Math.round(sourceAlpha * (1 - blend) + 225 * blend);
        } else {
          lowerPixels[offset] = color[0];
          lowerPixels[offset + 1] = color[1];
          lowerPixels[offset + 2] = color[2];
          lowerPixels[offset + 3] = Math.round(225 * blend);
        }
        added += 1;
      }
      return added;
    }

    function applyDrainageRetentionPixels(currentPixels, historicalPixelSets, queryPixels, stageFt, mode) {
      const pixelCount = Math.floor(currentPixels.length / 4);
      if (!pixelCount || !queryPixels || queryPixels.length !== currentPixels.length) return 0;
      const history = (historicalPixelSets || []).filter(
        values => values && values.length === currentPixels.length
      );
      if (!history.length) return 0;
      // The first history raster is the crest footprint. A falling limb may
      // retain water from that footprint, but it must never admit a pixel that
      // was not present at crest merely because a phase penalty was released.
      // A confirmed blue pixel over the full crest footprint stays blue; it
      // may become shallower or disappear, but it never downgrades to green.
      const crestPixels = history[0];
      const retainedStageRgb = getDrainageStageColor(stageFt);
      const stage = Number(stageFt);
      let modified = 0;
      for (let offset = 0; offset < pixelCount * 4; offset += 4) {
        const currentlyWet = isWetRasterPixel(currentPixels, offset);
        if (!crestPixels[offset + 3]) {
          if (currentlyWet) {
            currentPixels[offset] = 0;
            currentPixels[offset + 1] = 0;
            currentPixels[offset + 2] = 0;
            currentPixels[offset + 3] = 0;
            modified += 1;
          }
          continue;
        }
        if (currentlyWet) continue;
        const encodedGround = queryPixels[offset] * 256 + queryPixels[offset + 1];
        if (!encodedGround) continue;
        const groundFt = (encodedGround - 32768) / 10;
        const depthFt = stage - groundFt;
        if (!(depthFt > 0.005)) continue;
        let wasWet = false;
        for (const historyPixels of history) {
          if (!isWetRasterPixel(historyPixels, offset)) continue;
          wasWet = true;
          break;
        }
        if (!wasWet) continue;
        const color = mode === "depth" ? getDrainageDepthColor(depthFt) : retainedStageRgb;
        currentPixels[offset] = color[0];
        currentPixels[offset + 1] = color[1];
        currentPixels[offset + 2] = color[2];
        currentPixels[offset + 3] = 225;
        modified += 1;
      }
      return modified;
    }

    function getDrainageRetentionMilestones(entry, series = currentRawSeriesHours) {
      const phase = getHydraulicPhaseForEntry(entry, null, series);
      const crestStage = Number(entry?.hydraulicCrestStageFt);
      const currentTime = entryTimeMs(entry);
      const crestTime = Date.parse(entry?.hydraulicCrestTimeUtc || "");
      if (!phase.startsWith("draining") || !Number.isFinite(crestStage) ||
          crestStage < MINOR_FLOOD_FT || !Number.isFinite(currentTime) || !Number.isFinite(crestTime)) return [];

      const visible = Array.isArray(series) ? series : [];
      const antecedents = entry?.hydraulicAntecedents ||
        visible.find(row => Array.isArray(row.hydraulicAntecedents))?.hydraulicAntecedents || [];
      const rows = antecedents.concat(visible)
        .filter(row => {
          const time = entryTimeMs(row);
          return Number.isFinite(time) && time >= crestTime && time < currentTime && Number.isFinite(getStageValue(row));
        });
      const selected = new Map();
      for (const row of rows) {
        const rowPhase = getHydraulicPhaseForEntry(row, null, series);
        if (rowPhase === "filling") continue;
        const existing = selected.get(rowPhase);
        if (!existing || getStageValue(row) > getStageValue(existing)) selected.set(rowPhase, row);
      }
      return Array.from(selected.values()).sort((a, b) => entryTimeMs(a) - entryTimeMs(b));
    }

