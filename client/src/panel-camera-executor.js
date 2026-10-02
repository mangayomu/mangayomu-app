/** Owns imperative panel camera movement and spotlight projection. */
export class PanelCameraExecutor {
  /**
   * @param {{requestFrame?:(callback:FrameRequestCallback)=>number,cancelFrame?:(id:number)=>void,now?:()=>number}} [dependencies]
   */
  constructor(dependencies = {}) {
    this._requestFrame = dependencies.requestFrame || ((callback) => globalThis.requestAnimationFrame(callback));
    this._cancelFrame = dependencies.cancelFrame || ((id) => globalThis.cancelAnimationFrame(id));
    this._now = dependencies.now || (() => performance.now());
    this._frameRequest = null;
  }

  /**
   * @param {{
   *   surface:HTMLElement,
   *   image:HTMLImageElement,
   *   location:{frame:{x:number,y:number,w:number,h:number,zoom:number},transitionEasing?:string},
   *   sourcePanel:{x:number,y:number,w:number,h:number},
   *   currentZoom:number,
   *   duration:number,
   *   instant:boolean,
   *   setZoom:(zoom:number)=>void,
   *   publish?:(state:{location:Object,spotlightBox:Object,spotlightStyle:string})=>void,
   *   complete?:()=>void
   * }} input
   */
  execute(input) {
    this.cancel();
    const frame = input.location.frame;
    const targetZoom = frame.zoom;
    const targetScroll = this.scrollTarget(input.surface, input.image, frame, targetZoom);
    const publish = input.publish || (() => {});
    const complete = input.complete || (() => {});
    publish({
      location: input.location,
      spotlightBox: input.sourcePanel,
      spotlightStyle: this.projectSpotlight(input.surface, input.image, input.sourcePanel),
    });

    if (input.instant || input.duration === 0) {
      input.setZoom(targetZoom);
      input.surface.scrollLeft = targetScroll.left;
      input.surface.scrollTop = targetScroll.top;
      complete();
      return;
    }

    const startZoom = input.currentZoom;
    const startLeft = input.surface.scrollLeft;
    const startTop = input.surface.scrollTop;
    const startedAt = this._now();
    const step = (now) => {
      const progress = Math.min(1, (now - startedAt) / input.duration);
      const eased = transitionProgress(progress, input.location.transitionEasing);
      input.setZoom(startZoom + (targetZoom - startZoom) * eased);
      input.surface.scrollLeft = startLeft + (targetScroll.left - startLeft) * eased;
      input.surface.scrollTop = startTop + (targetScroll.top - startTop) * eased;
      if (progress < 1) {
        this._frameRequest = this._requestFrame(step);
      } else {
        this._frameRequest = null;
        complete();
      }
    };
    this._frameRequest = this._requestFrame(step);
  }

  cancel() {
    if (this._frameRequest !== null) this._cancelFrame(this._frameRequest);
    this._frameRequest = null;
  }

  destroy() {
    this.cancel();
  }

  /**
   * @param {HTMLElement} surface
   * @param {HTMLImageElement} image
   * @param {{x:number,y:number,w:number,h:number}} frame
   * @param {number} zoom
   */
  scrollTarget(surface, image, frame, zoom) {
    const scale = Math.min(surface.clientWidth / image.naturalWidth, surface.clientHeight / image.naturalHeight);
    const imageWidth = image.naturalWidth * scale * zoom;
    const imageHeight = image.naturalHeight * scale * zoom;
    const originX = (surface.clientWidth * zoom - imageWidth) / 2;
    const originY = (surface.clientHeight * zoom - imageHeight) / 2;
    const centerX = originX + (frame.x + frame.w / 2) * scale * zoom;
    const centerY = originY + (frame.y + frame.h / 2) * scale * zoom;
    return {
      left: Math.max(0, Math.min(centerX - surface.clientWidth / 2, surface.clientWidth * zoom - surface.clientWidth)),
      top: Math.max(0, Math.min(centerY - surface.clientHeight / 2, surface.clientHeight * zoom - surface.clientHeight)),
    };
  }

  /**
   * @param {HTMLElement} surface
   * @param {HTMLImageElement} image
   * @param {{x:number,y:number,w:number,h:number}} sourcePanel
   */
  projectSpotlight(surface, image, sourcePanel) {
    const scale = Math.min(surface.clientWidth / image.naturalWidth, surface.clientHeight / image.naturalHeight);
    const imageWidth = image.naturalWidth * scale;
    const imageHeight = image.naturalHeight * scale;
    const left = ((surface.clientWidth - imageWidth) / 2 + sourcePanel.x * scale) / surface.clientWidth * 100;
    const top = ((surface.clientHeight - imageHeight) / 2 + sourcePanel.y * scale) / surface.clientHeight * 100;
    const width = sourcePanel.w * scale / surface.clientWidth * 100;
    const height = sourcePanel.h * scale / surface.clientHeight * 100;
    return "left:" + left + "%;top:" + top + "%;width:" + width + "%;height:" + height + "%;box-shadow:0 0 0 9999px rgba(0,0,0,.62)";
  }
}

function transitionProgress(progress, easing) {
  if (easing === "easeInOutCubic") {
    return progress < .5
      ? 4 * progress * progress * progress
      : 1 - Math.pow(-2 * progress + 2, 3) / 2;
  }
  return 1 - Math.pow(1 - progress, 3);
}
