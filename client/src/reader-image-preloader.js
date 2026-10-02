/** Owns a small, deduplicated image look-ahead queue for the Reader. */
export class ReaderImagePreloader {
  /**
   * @param {{createImage?:()=>HTMLImageElement,setTimer?:(callback:()=>void,delay:number)=>number,clearTimer?:(timer:number)=>void,onLoad?:(pageIndex:number,image:HTMLImageElement)=>void}} [dependencies]
   */
  constructor(dependencies = {}) {
    this._createImage = dependencies.createImage || (() => new Image());
    this._setTimer = dependencies.setTimer || ((callback, delay) => globalThis.setTimeout(callback, delay));
    this._clearTimer = dependencies.clearTimer || ((timer) => globalThis.clearTimeout(timer));
    this._onLoad = dependencies.onLoad || (() => {});
    this._requests = new Map();
    this._timer = null;
  }

  preload(urls, currentIndex) {
    this.clear();
    if (!Array.isArray(urls) || !urls.length) return;
    const nextIndex = currentIndex + 1;
    const afterNextIndex = currentIndex + 2;
    this._prune([urls[currentIndex], urls[nextIndex], urls[afterNextIndex]]);
    if (nextIndex < urls.length) this._load(nextIndex, urls[nextIndex]);
    if (afterNextIndex < urls.length) {
      this._timer = this._setTimer(() => {
        this._timer = null;
        this._load(afterNextIndex, urls[afterNextIndex]);
      }, 2000);
    }
  }

  clear(releaseImages = false) {
    if (this._timer !== null) {
      this._clearTimer(this._timer);
      this._timer = null;
    }
    if (releaseImages) {
      this._requests.forEach((request) => {
        const image = request.image;
        if (image) {
          image.onload = null;
          image.onerror = null;
          image.src = "";
        }
      });
      this._requests.clear();
    }
  }

  _load(pageIndex, url) {
    if (!url || this._requests.has(url)) return;
    const image = this._createImage();
    const request = { image, pageIndex };
    this._requests.set(url, request);
    image.crossOrigin = "anonymous";
    image.onload = () => {
      if (this._requests.get(url) !== request) return;
      request.image = null;
      this._onLoad(pageIndex, image);
    };
    image.onerror = () => {
      if (this._requests.get(url) === request) this._requests.delete(url);
    };
    image.src = url;
  }

  _prune(retainedUrls) {
    const retained = new Set(retainedUrls.filter(Boolean));
    this._requests.forEach((request, url) => {
      if (!retained.has(url) && request.image === null) this._requests.delete(url);
    });
  }
}
