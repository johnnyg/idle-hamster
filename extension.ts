/* extension.ts
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 2 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import Gio from "gi://Gio";
import GLib from "gi://GLib";

import {
  Extension,
  gettext as _,
} from "resource:///org/gnome/shell/extensions/extension.js";
import * as Signal from "./signals.js";

Gio._promisify(Gio.DBusProxy, "new_for_bus");
Gio._promisify(Gio.DBusProxy.prototype, "call");

const IDLE_DELAY_OFFSET_SEC = 12; // 10s to blank

// Alias `Gio.DBusProxy.new_for_bus` because `Gio._promisify` confuses typescript
type GioDBusProxyNewForBus = (
  bus_type: Gio.BusType,
  flags: Gio.DBusProxyFlags,
  info: Gio.DBusInterfaceInfo | null,
  name: string,
  object_path: string,
  interface_name: string,
  cancellable?: Gio.Cancellable | null
) => Promise<Gio.DBusProxy>;

function toTimeString(sec: number): string {
  return `${Math.floor(sec / 60)} min ${Math.floor(sec % 60)} sec`;
}

export default class IdleHamsterExtension extends Extension {
  _hamsterProxy?: Gio.DBusProxy;
  _idleMonitorProxy?: Gio.DBusProxy;
  _screensaverProxy?: Gio.DBusProxy;
  _settings?: Gio.Settings;
  _signals?: Map<string, Signal.Connection>;

  async enable(): Promise<void> {
    const logger = this.getLogger();
    logger.debug("enabled");
    this._hamsterProxy = await (
      Gio.DBusProxy.new_for_bus as GioDBusProxyNewForBus
    )(
      Gio.BusType.SESSION,
      Gio.DBusProxyFlags.NONE,
      null,
      "org.gnome.Hamster",
      "/org/gnome/Hamster",
      "org.gnome.Hamster",
      null
    );
    let hamsterVersion: string | undefined = undefined;
    try {
      hamsterVersion = (
        await this._hamsterProxy!.call(
          "Version",
          null,
          Gio.DBusCallFlags.NONE,
          -1,
          null
        )
      ).recursiveUnpack();
    } catch (err) {
      if (
        err instanceof Gio.DBusError &&
        err.code == Gio.DBusError.SERVICE_UNKNOWN
      ) {
        err = new Error(
          _("Unable to detect hamster, please make sure it is installed"),
          {
            cause: err,
          }
        );
      }
      throw err;
    }
    logger.info(`detected hamster version ${hamsterVersion}`);
    this._idleMonitorProxy = await (
      Gio.DBusProxy.new_for_bus as GioDBusProxyNewForBus
    )(
      Gio.BusType.SESSION,
      Gio.DBusProxyFlags.NONE,
      null,
      "org.gnome.Mutter.IdleMonitor",
      "/org/gnome/Mutter/IdleMonitor/Core",
      "org.gnome.Mutter.IdleMonitor",
      null
    );
    this._screensaverProxy = await (
      Gio.DBusProxy.new_for_bus as GioDBusProxyNewForBus
    )(
      Gio.BusType.SESSION,
      Gio.DBusProxyFlags.NONE,
      null,
      "org.gnome.ScreenSaver",
      "/org/gnome/ScreenSaver",
      "org.gnome.ScreenSaver",
      null
    );
    this._settings = this.getSettings();
    await this.addSignals(
      Signal.forProxySignal(
        logger,
        this._idleMonitorProxy!,
        "WatchFired",
        this.stopTracking.bind(this)
      ),
      Signal.forSettingsKeyChange(
        logger,
        this._settings,
        "use-session-idle-delay",
        this.updateSessionIdleSync.bind(this)
      ),
      Signal.forSettingsKeyChange(
        logger,
        this._settings,
        "idle-delay",
        this.updateIdleWatchSignal.bind(this)
      ),
      Signal.forSettingsKeyChange(
        logger,
        this._settings,
        "stop-on-lock",
        this.updateStopOnLock.bind(this)
      )
    );
  }

  async disable(): Promise<void> {
    const logger = this.getLogger();
    for (let [_signalId, signal] of this._signals ?? []) {
      await signal?.disconnect();
    }
    this._signals?.clear();
    this._settings = undefined;
    this._idleMonitorProxy = undefined;
    this._screensaverProxy = undefined;
    this._hamsterProxy = undefined;
    logger.debug("disabled");
  }

  async addSignals(...signals: Signal.Connector[]): Promise<void> {
    if (this._signals === undefined) {
      this._signals = new Map();
    }
    for (let signal of signals) {
      await this._signals?.get(signal.id)?.disconnect();
      this._signals.set(signal.id, await signal.connect());
    }
  }

  async removeSignals(...signals: Signal.Connector[]): Promise<void> {
    for (let signal of signals) {
      await this._signals?.get(signal.id)?.disconnect();
      this._signals?.delete(signal.id);
    }
  }

  async stopTracking(): Promise<void> {
    const logger = this.getLogger();
    const [idleTime] = (
      await this._idleMonitorProxy!.call(
        "GetIdletime",
        null,
        Gio.DBusCallFlags.NONE,
        -1,
        null
      )
    ).recursiveUnpack();
    const lastActiveTimeMillis = Date.now() - idleTime;
    const lastActiveTimeSecs = Math.floor(lastActiveTimeMillis / 1000);
    const lastActiveTimeString = new Date(
      lastActiveTimeMillis
    ).toLocaleTimeString();
    logger.info(`idle time: ${toTimeString(idleTime / 1000)}`);
    logger.log(
      `stopping hamster activity tracking; user last active at ${lastActiveTimeString}`
    );
    // Workaround for https://github.com/projecthamster/hamster/issues/775
    const endTime = lastActiveTimeSecs - new Date().getTimezoneOffset() * 60;
    try {
      await this._hamsterProxy!.call(
        "StopTracking",
        new GLib.Variant("(i)", [endTime]),
        Gio.DBusCallFlags.NONE,
        -1,
        null
      );
    } catch (e) {
      logger.error(`failed to stop tracking hamster activity: ${e}`);
    }
  }

  async updateSessionIdleDelay(idleDelaySec: number): Promise<void> {
    if (idleDelaySec == 0) {
      // Idle delay of 0 means it's been disabled
      // so disable the sync ourselves
      this._settings!.set_value(
        "use-session-idle-delay",
        GLib.Variant.new_boolean(false)
      );
    } else {
      this._settings!.set_value(
        "idle-delay",
        GLib.Variant.new_uint16(idleDelaySec + IDLE_DELAY_OFFSET_SEC)
      );
    }
  }

  async updateSessionIdleSync(useSessionIdleDelay: boolean): Promise<void> {
    const signal = Signal.forSettingsKeyChange(
      this.getLogger(),
      this.getSettings("org.gnome.desktop.session"),
      "idle-delay",
      this.updateSessionIdleDelay.bind(this)
    );
    if (useSessionIdleDelay) {
      await this.addSignals(signal);
    } else {
      await this.removeSignals(signal);
    }
  }

  async updateIdleWatchSignal(idleTimeSec: number): Promise<void> {
    await this.addSignals(
      Signal.forProxyCall(
        this.getLogger(),
        this._idleMonitorProxy!,
        "AddIdleWatch",
        "RemoveWatch",
        new GLib.Variant("(t)", [idleTimeSec * 1000])
      )
    );
  }

  async updateStopOnLock(stopOnLock: boolean): Promise<void> {
    const signal = Signal.forProxySignal(
      this.getLogger(),
      this._screensaverProxy!,
      "ActiveChanged",
      async (active: boolean): Promise<void> => {
        if (active) {
          await this.stopTracking();
        }
      }
    );
    if (stopOnLock) {
      await this.addSignals(signal);
    } else {
      await this.removeSignals(signal);
    }
  }
}
