import { Capacitor, registerPlugin } from "@capacitor/core";

const NativeScreenAwake = registerPlugin("ScreenAwake");

/** Keeps the display awake only while autoplay is active. */
export class ScreenAwakeController {
  constructor({
    documentRef = globalThis.document,
    navigatorRef = globalThis.navigator,
    nativePlugin = Capacitor.isNativePlatform() ? NativeScreenAwake : null,
  } = {}) {
    this._document = documentRef;
    this._navigator = navigatorRef;
    this._nativePlugin = nativePlugin;
    this._active = false;
    this._nativeActive = false;
    this._sentinel = null;
    this._generation = 0;
    this._onVisibilityChange = () => {
      if (this._active && this._document?.visibilityState === "visible") void this._acquire();
    };
    this._document?.addEventListener?.("visibilitychange", this._onVisibilityChange);
  }

  setActive(active) {
    const next = Boolean(active);
    if (next === this._active) {
      if (next) void this._acquire();
      return;
    }
    this._active = next;
    this._generation++;
    if (next) void this._acquire();
    else void this._release();
  }

  destroy() {
    this._active = false;
    this._generation++;
    this._document?.removeEventListener?.("visibilitychange", this._onVisibilityChange);
    void this._release();
  }

  async _acquire() {
    if (!this._active || this._document?.visibilityState === "hidden") return;
    const generation = this._generation;

    if (this._nativePlugin) {
      if (this._nativeActive) return;
      try {
        await this._nativePlugin.keepAwake();
        if (!this._active || generation !== this._generation) {
          await this._nativePlugin.allowSleep();
          return;
        }
        this._nativeActive = true;
        return;
      } catch (error) {
        console.warn("[Reader] native screen wake lock failed; trying the web API:", error);
      }
    }

    if (this._sentinel || !this._navigator?.wakeLock?.request) return;
    try {
      const sentinel = await this._navigator.wakeLock.request("screen");
      if (!this._active || generation !== this._generation) {
        await sentinel.release();
        return;
      }
      this._sentinel = sentinel;
      sentinel.addEventListener?.("release", () => {
        if (this._sentinel === sentinel) this._sentinel = null;
      });
    } catch (error) {
      console.warn("[Reader] screen wake lock failed:", error);
    }
  }

  async _release() {
    const sentinel = this._sentinel;
    this._sentinel = null;
    if (sentinel) {
      try { await sentinel.release(); } catch {}
    }
    if (this._nativeActive && this._nativePlugin) {
      this._nativeActive = false;
      try { await this._nativePlugin.allowSleep(); } catch {}
    }
  }
}
