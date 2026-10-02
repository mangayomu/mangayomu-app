const PANEL_DEBUG_COLORS = ["#f97316", "#a855f7", "#22c55e", "#eab308", "#f43f5e", "#3b82f6"];

/**
 * Projects cached balloon analysis geometry into a debug overlay view model.
 * @param {Array<{id:string|number,bounds:{left:number,right:number,top:number,bottom:number},textBounds?:Object,paddingBounds?:Object}>} boxes
 * @param {{naturalWidth:number,naturalHeight:number}} image
 * @param {{clientWidth:number,clientHeight:number}} stage
 * @param {Array<{x:number,y:number,w:number,h:number}>} [panels]
 * @returns {{boxes:Array<{id:string|number,style:string}>,paddingBoxes:Array<{id:string,label:string,style:string}>,panelBoxes:Array<{id:string,label:string,style:string}>,overlayStyle:string}}
 */
/**
 * Formats the Director's semantic camera plan for the browser console.
 * @param {{pageIndex:number,readingDirection:"rtl"|"ltr",panels:Array,cameraPlan:Object,schedule:Object,subjects?:Array}} input
 */
export function describeDirectorPlan(input) {
  const { pageIndex, readingDirection, panels, cameraPlan, schedule, subjects = [] } = input;
  const subjectText = new Map(subjects.map((subject) => [
    subject.id,
    String(subject.readingText || subject.text || subject.id).replace(/\s+/g, " ").trim(),
  ]));
  const subjectGeometry = new Map(subjects.map((subject) => [subject.id, subject.box]));
  const locations = schedule?.locations || [];
  const direction = readingDirection === "ltr"
    ? "LTR · da sinistra verso destra"
    : "RTL · da destra verso sinistra";
  const lines = [
    "🎬 DIRECTOR — PAGINA " + (pageIndex + 1) + " — " + direction,
    panels.length + " vignette · " + (cameraPlan?.locations?.length || 0) + " inquadrature · " + locations.length + " momenti",
    "Composizione " + (cameraPlan?.composition?.profile || "standard") + " · zoom stabile " + Number(cameraPlan?.composition?.zoom || locations[0]?.frame?.zoom || 1).toFixed(2) + "×", 
  ];

  panels.forEach((panel, panelIndex) => {
    const coverage = cameraPlan?.coverage?.find((item) => item.panelIndex === panelIndex)?.fraction || 0;
    const balloons = cameraPlan?.detectedBalloons?.find((item) => item.panelIndex === panelIndex)?.balloons || [];
    const steps = locations.filter((location) => location.sourcePanelIndex === panelIndex);
    lines.push("", "VIGNETTA " + (panelIndex + 1) + " — coverage " + Math.round(coverage * 100) + "%");
    lines.push("Balloon trovati: " + balloons.length);
    balloons.forEach((balloon, balloonIndex) => {
      lines.push(
        "Balloon " + (balloonIndex + 1) + ": " + balloon.paragraphCount
        + (balloon.paragraphCount === 1 ? " paragrafo" : " paragrafi")
        + (balloon.textDirections?.length ? " · guida " + balloon.textDirections.join("/").toUpperCase() : "")
      );
    });
    const orderedSubjects = steps.flatMap((step) => step.subjectIds).filter((id, index, ids) => ids.indexOf(id) === index);
    if (orderedSubjects.length) {
      lines.push("Ordine balloon pianificato:");
      orderedSubjects.forEach((id, index) => {
        const box = subjectGeometry.get(id);
        const previous = index ? subjectGeometry.get(orderedSubjects[index - 1]) : null;
        const reason = !previous || !box ? "primo soggetto della vignetta" : describeSubjectOrder(previous, box, readingDirection);
        lines.push("  " + (index + 1) + ". " + id + (box
          ? " · box x" + Math.round(box.left) + "–" + Math.round(box.right) + ", y" + Math.round(box.top) + "–" + Math.round(box.bottom)
          : " · box non disponibile") + " · " + reason);
      });
    }
    steps.forEach((step, stepIndex) => { 
      const subjects = step.subjectIds.map((id) => subjectText.get(id) || id).filter(Boolean).join(" / ");
      const action = describeDirectorAction(step, stepIndex, panel, readingDirection, subjects);
      const timing = [];
      if (step.transitionDurationMs > 0) timing.push("movimento " + formatSeconds(step.transitionDurationMs));
      if (step.holdDurationMs > 0) timing.push("sosta " + formatSeconds(step.holdDurationMs));
      lines.push(
        "  " + (stepIndex + 1) + ". " + action
        + " | zoom " + Number(step.frame.zoom).toFixed(2) + "×"
        + (timing.length ? " | " + timing.join(" · ") : "")
        + " | area x" + Math.round(step.frame.x) + "–" + Math.round(step.frame.x + step.frame.w)
        + ", y" + Math.round(step.frame.y) + "–" + Math.round(step.frame.y + step.frame.h)
      );
    });
  });
  return lines.join("\n");
}

export function createPanelDebugView(boxes, image, stage, panels = []) {
  if (!image || !image.naturalWidth || !stage || !Array.isArray(boxes) || !boxes.length) {
    return { boxes: [], paddingBoxes: [], panelBoxes: [], overlayStyle: "display:none" };
  }
  const scale = Math.min(stage.clientWidth / image.naturalWidth, stage.clientHeight / image.naturalHeight);
  const renderedWidth = image.naturalWidth * scale;
  const renderedHeight = image.naturalHeight * scale;
  const offsetX = (stage.clientWidth - renderedWidth) / 2;
  const offsetY = (stage.clientHeight - renderedHeight) / 2;
  const overlayStyle = [
    "display:block",
    "left:" + offsetX + "px",
    "top:" + offsetY + "px",
    "width:" + renderedWidth + "px",
    "height:" + renderedHeight + "px",
  ].join(";");
  const projectedBoxes = boxes.map((box, index) => ({
    id: box.id,
    label: "F" + (index + 1),
    style: sourceBoundsStyle(box.bounds, image),
  }));
  const panelBoxes = panels.map((panel, index) => ({
    id: "panel-" + index,
    label: "P" + (index + 1),
    style: sourceBoundsStyle({
      left: panel.x,
      top: panel.y,
      right: panel.x + panel.w,
      bottom: panel.y + panel.h,
    }, image) + ";border-color:" + PANEL_DEBUG_COLORS[index % PANEL_DEBUG_COLORS.length]
      + ";color:" + PANEL_DEBUG_COLORS[index % PANEL_DEBUG_COLORS.length]
      + ";transform:translate(" + (index * 5) + "px," + (index * 5) + "px)",
  }));
  const paddingBoxes = [];
  boxes.forEach((box) => {
    paddingBoundsForDebug(box).forEach((bounds, index) => {
      paddingBoxes.push({
        id: box.id + ":" + index,
        label: index === 0 ? String(Number(box.id) + 1) : "",
        text: box.text || "",
        style: sourceBoundsStyle(bounds, image),
      });
    });
  });
  return { boxes: projectedBoxes, paddingBoxes, panelBoxes, overlayStyle };
}

function describeSubjectOrder(previous, current, readingDirection) {
  const overlap = Math.max(0, Math.min(previous.bottom, current.bottom) - Math.max(previous.top, current.top));
  const sameRow = overlap / Math.max(1, Math.min(previous.bottom - previous.top, current.bottom - current.top)) >= .5;
  if (!sameRow) return current.top >= previous.top ? "row below previous" : "row above previous";
  return "same row · " + (readingDirection === "rtl" ? "RTL: right → left" : "LTR: left → right");
}

function describeDirectorAction(step, stepIndex, panel, readingDirection, subjects) {
  if (step.kind === "entry") return "ENTRY from the " + (readingDirection === "ltr" ? "left" : "right") + " edge";
  if (step.kind === "coverage") return "COVERAGE PAN of the remaining area";
  if (step.movement.kind === "reading-pan-lead" || step.movement.kind === "reading-pan-travel") {
    return "READING PAN " + String(step.textDirection || "").toUpperCase()
      + (step.textDirection === "rtl" ? " toward the left" : " toward the right");
  }
  if (stepIndex === 0 && sameFrameAsPanel(step.frame, panel)) return "FULL FRAME + reading: '" + subjects + "'";
  if (stepIndex === 0) {
    const direction = step.textDirection || readingDirection;
    return "COMPOSITION from the " + (direction === "ltr" ? "left" : "right") + " edge + reading: '" + subjects + "'";
  }
  return step.transitionDurationMs === 0 ? "STATIONARY CAMERA reading: '" + subjects + "'" : "PAN toward: '" + subjects + "'";
}

function sameFrameAsPanel(frame, panel) {
  return Math.abs(frame.x - panel.x) < 1
    && Math.abs(frame.y - panel.y) < 1
    && Math.abs(frame.w - panel.w) < 1
    && Math.abs(frame.h - panel.h) < 1;
}

function formatSeconds(milliseconds) {
  return (milliseconds / 1000).toFixed(milliseconds % 1000 === 0 ? 1 : 2) + "s";
}

function sourceBoundsStyle(bounds, image) {
  return [
    "left:" + (bounds.left / image.naturalWidth * 100) + "%",
    "top:" + (bounds.top / image.naturalHeight * 100) + "%",
    "width:" + ((bounds.right - bounds.left) / image.naturalWidth * 100) + "%",
    "height:" + ((bounds.bottom - bounds.top) / image.naturalHeight * 100) + "%",
  ].join(";");
}

function paddingBoundsForDebug(box) {
  if (!box.textBounds || !box.paddingBounds) return [];
  const text = box.textBounds;
  const padding = box.paddingBounds;
  return [
    { left: padding.left, right: padding.right, top: padding.top, bottom: text.top },
    { left: padding.left, right: padding.right, top: text.bottom, bottom: padding.bottom },
    { left: padding.left, right: text.left, top: text.top, bottom: text.bottom },
    { left: text.right, right: padding.right, top: text.top, bottom: text.bottom },
  ].filter((bounds) => bounds.right > bounds.left && bounds.bottom > bounds.top);
}
